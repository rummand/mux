import { execFile } from "node:child_process";
import { cpus, loadavg, totalmem, uptime } from "node:os";
import { promisify } from "node:util";

const run = promisify(execFile);
const GB = 1024 ** 3;
const TICK = 2_000;
const KEEP = 150; // 5 minutes of 2-second samples

/**
 * The machine, live: every core's load every 2 s (Node's own per-core counters), and on a Mac what macOS tells anyone
 * without sudo — the GPU's utilisation and memory (the accelerator's PerformanceStatistics), memory as Activity Monitor
 * splits it (vm_stat), network and disk throughput, thermal warnings, and the processes using the most. The owner loves
 * data; the System page shows all of it. Power draw and temperatures need `sudo powermetrics`, so they are not here.
 *
 * The cheap reading (cores) runs always; the commands run every 2 s while someone is looking (GET /system/live in the
 * last minute), and every 30 s otherwise so the long-range samples have them.
 */
export interface Core { id: number; kind: "P" | "E" | null; cluster: number; pct: number }
export interface Gpu { pct: number; renderer: number; tiler: number; memGb: number }
export interface MemSplit { wired: number; apps: number; compressed: number; cached: number; free: number }
export interface Point { ts: number; cores: number[]; cpu: number; gpu: number | null; netIn: number; netOut: number; diskR: number; diskW: number }
export interface Proc { pid: number; name: string; cpu: number; rssGb: number }

let layout: { kind: "P" | "E" | null; cluster: number }[] = [];
let prev: { idle: number; total: number }[] = [];
let prevIo: { ts: number; netIn: number; netOut: number; diskR: number; diskW: number } | null = null;
let rates = { netIn: 0, netOut: 0, diskR: 0, diskW: 0 };
let gpu: Gpu | null = null;
let mem: MemSplit | null = null;
let thermal: string | null = null;
let current: number[] = [];
const history: Point[] = [];
let lastAsk = 0;
let ticks = 0;
let started = false;

/** Which logical CPU is a performance or an efficiency core, and its cluster (macOS's device tree). */
async function readLayout() {
  const n = cpus().length;
  layout = Array.from({ length: n }, () => ({ kind: null, cluster: 0 }));
  if (process.platform !== "darwin") return;
  const out = await run("ioreg", ["-p", "IODeviceTree", "-r", "-n", "cpus", "-d", "2", "-l"]).then((r) => r.stdout).catch(() => "");
  const per = async (lvl: number) => Number((await run("sysctl", ["-n", `hw.perflevel${lvl}.cpusperl2`]).catch(() => ({ stdout: "" }))).stdout.trim()) || 0;
  const size = { P: (await per(0)) || 6, E: (await per(1)) || 4 };
  let cluster = -1, last: string | null = null;
  for (const block of out.split(/\+-o /).slice(1)) {
    const id = Number(/"logical-cpu-id" = (\d+)/.exec(block)?.[1] ?? NaN);
    const kind = /"cluster-type" = <"([PE])">/.exec(block)?.[1] as "P" | "E" | undefined;
    if (!Number.isFinite(id) || !kind || id >= n) continue;
    // A new cluster begins where the kind changes, or where one is full (cores sharing an L2).
    const inCluster = layout.filter((c) => c.cluster === cluster && c.kind === kind).length;
    if (kind !== last || inCluster >= size[kind]) cluster++;
    layout[id] = { kind, cluster };
    last = kind;
  }
}

function sampleCores() {
  const now = cpus().map((c) => {
    const t = c.times;
    return { idle: t.idle, total: t.user + t.nice + t.sys + t.irq + t.idle };
  });
  current = now.map((c, i) => {
    const p = prev[i];
    const dt = p ? c.total - p.total : 0;
    return dt > 0 ? Math.max(0, Math.min(100, (100 * (dt - (c.idle - p.idle))) / dt)) : 0;
  });
  prev = now;
}

const num = (re: RegExp, s: string) => Number(re.exec(s)?.[1] ?? NaN);

async function sampleMac() {
  const [acc, vm, net, disk, therm] = await Promise.all([
    run("ioreg", ["-r", "-d", "1", "-c", "IOAccelerator"]).then((r) => r.stdout).catch(() => ""),
    run("vm_stat").then((r) => r.stdout).catch(() => ""),
    run("netstat", ["-ibn"]).then((r) => r.stdout).catch(() => ""),
    run("ioreg", ["-r", "-c", "IOBlockStorageDriver", "-k", "Statistics", "-d", "1"]).then((r) => r.stdout).catch(() => ""),
    ticks % 15 === 0 || thermal === null ? run("pmset", ["-g", "therm"]).then((r) => r.stdout).catch(() => "") : Promise.resolve(null),
  ]);
  const perf = /"PerformanceStatistics" = \{([^}]*)\}/.exec(acc)?.[1] ?? "";
  gpu = perf ? {
    pct: num(/"Device Utilization %"=(\d+)/, perf) || 0, renderer: num(/"Renderer Utilization %"=(\d+)/, perf) || 0,
    tiler: num(/"Tiler Utilization %"=(\d+)/, perf) || 0, memGb: (num(/"In use system memory"=(\d+)/, perf) || 0) / GB,
  } : null;
  if (vm) {
    const page = num(/page size of (\d+)/, vm) || 16384;
    const p = (name: string) => (num(new RegExp(`${name}:\\s+(\\d+)`), vm) || 0) * page / GB;
    const wired = p("Pages wired down"), apps = Math.max(0, p("Anonymous pages") - p("Pages purgeable"));
    const compressed = p("Pages occupied by compressor"), cached = p("File-backed pages") + p("Pages purgeable");
    mem = { wired, apps, compressed, cached, free: Math.max(0, totalmem() / GB - wired - apps - compressed - cached) };
  }
  // Network: bytes in and out on every interface but loopback (the link rows carry the counters).
  let netIn = 0, netOut = 0;
  for (const line of net.split("\n")) {
    const f = line.trim().split(/\s+/);
    if (f.length < 10 || !f[2]?.startsWith("<Link#") || f[0].startsWith("lo")) continue;
    // Name Mtu Network [Address] Ipkts Ierrs Ibytes Opkts Oerrs Obytes Coll — Address may be empty.
    const tail = f.slice(-7);
    netIn += Number(tail[2]) || 0; netOut += Number(tail[5]) || 0;
  }
  let diskR = 0, diskW = 0;
  for (const m of disk.matchAll(/"Bytes \(Read\)"=(\d+)/g)) diskR += Number(m[1]);
  for (const m of disk.matchAll(/"Bytes \(Write\)"=(\d+)/g)) diskW += Number(m[1]);
  const ts = Date.now();
  if (prevIo) {
    const s = (ts - prevIo.ts) / 1000;
    const r = (a: number, b: number) => (s > 0 && a >= b ? (a - b) / s : 0);
    rates = { netIn: r(netIn, prevIo.netIn), netOut: r(netOut, prevIo.netOut), diskR: r(diskR, prevIo.diskR), diskW: r(diskW, prevIo.diskW) };
  }
  prevIo = { ts, netIn, netOut, diskR, diskW };
  if (therm != null) {
    const level = /CPU_Speed_Limit\s*=\s*(\d+)/.exec(therm)?.[1];
    thermal = /No thermal warning level has been recorded/.test(therm) ? "nominal" : level ? `CPU limited to ${level}%` : /thermal warning level/i.test(therm) ? therm.split("\n").find((l) => /warning level/i.test(l))?.trim() ?? "warning" : "nominal";
  }
}

async function tick() {
  sampleCores();
  const watched = Date.now() - lastAsk < 60_000;
  if (process.platform === "darwin" && (watched || ticks % 15 === 0)) await sampleMac().catch(() => undefined);
  ticks++;
  history.push({ ts: Date.now(), cores: current.map((v) => Math.round(v)), cpu: avg(current), gpu: gpu?.pct ?? null, ...rates });
  if (history.length > KEEP) history.splice(0, history.length - KEEP);
}

const avg = (a: number[]) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);

export function startLive() {
  if (started) return;
  started = true;
  void readLayout();
  sampleCores();
  setInterval(() => void tick(), TICK).unref();
}

/** Averages over the last `ms`, for the 30-second samples kept for the long-range charts. */
export function liveAverages(ms = 30_000) {
  const since = Date.now() - ms;
  const pts = history.filter((p) => p.ts >= since);
  if (!pts.length) return null;
  const gpus = pts.map((p) => p.gpu).filter((g): g is number => g != null);
  return {
    cpu: avg(pts.map((p) => p.cpu)), gpu: gpus.length ? avg(gpus) : null,
    netIn: avg(pts.map((p) => p.netIn)), netOut: avg(pts.map((p) => p.netOut)), diskR: avg(pts.map((p) => p.diskR)), diskW: avg(pts.map((p) => p.diskW)),
  };
}

let procs: { ts: number; list: Proc[] } = { ts: 0, list: [] };
/** The processes using the most CPU and the most memory (`ps`), and those in `keep` (mux's model servers), at most every 2 s. */
async function topProcesses(keep: number[]): Promise<Proc[]> {
  if (Date.now() - procs.ts < TICK) return procs.list;
  const out = await run("ps", ["-Aceo", "pid=,pcpu=,rss=,comm="], { maxBuffer: 8 * 1024 * 1024 }).then((r) => r.stdout).catch(() => "");
  const all = out.split("\n").map((l) => /^\s*(\d+)\s+([\d.]+)\s+(\d+)\s+(.*)$/.exec(l)).filter((m): m is RegExpExecArray => !!m)
    .map((m) => ({ pid: Number(m[1]), cpu: Number(m[2]), rssGb: (Number(m[3]) * 1024) / GB, name: m[4].trim() }));
  const byCpu = [...all].sort((a, b) => b.cpu - a.cpu).slice(0, 12);
  const byMem = [...all].sort((a, b) => b.rssGb - a.rssGb).slice(0, 12);
  const list = [...new Map([...byCpu, ...byMem, ...all.filter((p) => keep.includes(p.pid))].map((p) => [p.pid, p])).values()];
  procs = { ts: Date.now(), list };
  return list;
}

export async function live(keep: number[] = []) {
  lastAsk = Date.now();
  if (!started) startLive();
  const cores: Core[] = current.map((pct, id) => ({ id, kind: layout[id]?.kind ?? null, cluster: layout[id]?.cluster ?? 0, pct }));
  const [l1, l5, l15] = loadavg();
  return {
    ts: Date.now(), cores, cpu: avg(current), gpu, memory: mem, net: { in: rates.netIn, out: rates.netOut }, disk: { read: rates.diskR, write: rates.diskW },
    thermal, load: [l1, l5, l15], uptimeS: Math.round(uptime()), processes: await topProcesses([process.pid, ...keep]).catch(() => []), pid: process.pid,
    history,
  };
}
