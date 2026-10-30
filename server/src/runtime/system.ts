import { execFile } from "node:child_process";
import { statfs } from "node:fs/promises";
import { cpus, loadavg, totalmem } from "node:os";
import { promisify } from "node:util";
import { config } from "../config.js";

const run = promisify(execFile);
const GB = 1024 ** 3;

export interface SystemStats {
  memTotalGb: number; memUsedGb: number; memFreeGb: number; swapGb: number;
  /** macOS's own reading: 1 normal, 2 warn, 4 critical. */
  pressure: number; diskFreeGb: number; diskTotalGb: number; load1: number; cores: number; chip: string;
}

let chip = "";
export async function systemStats(): Promise<SystemStats> {
  const [vm, swap, pressure, disk] = await Promise.all([
    run("vm_stat").then((r) => r.stdout).catch(() => ""),
    run("sysctl", ["-n", "vm.swapusage"]).then((r) => r.stdout).catch(() => ""),
    run("sysctl", ["-n", "kern.memorystatus_vm_pressure_level"]).then((r) => Number(r.stdout.trim()) || 1).catch(() => 1),
    statfs(config.modelsDir).catch(() => null),
  ]);
  // macOS's own reading of what is available (it counts what the compressor and purging can give back), which is
  // what a new model process really gets; free + inactive pages alone undercount it on a busy Mac.
  const freePct = await run("memory_pressure", ["-Q"]).then((r) => Number(/free percentage: (\d+)%/.exec(r.stdout)?.[1])).catch(() => NaN);
  if (!chip) chip = await run("sysctl", ["-n", "machdep.cpu.brand_string"]).then((r) => r.stdout.trim()).catch(() => cpus()[0]?.model ?? "");
  const page = Number(/page size of (\d+)/.exec(vm)?.[1] ?? 16384);
  const pages = (name: string) => Number(new RegExp(`${name}:\\s+(\\d+)`).exec(vm)?.[1] ?? 0);
  // What a new process can have without paging anything out: free, plus what macOS drops at once (inactive, speculative, purgeable).
  const total = totalmem();
  const pagesFree = (pages("Pages free") + pages("Pages inactive") + pages("Pages speculative") + pages("Pages purgeable")) * page;
  const free = Number.isFinite(freePct) ? Math.max(pagesFree, (total * freePct) / 100) : pagesFree;
  const swapUsed = /used = ([\d.]+)M/.exec(swap)?.[1];
  return {
    memTotalGb: total / GB, memFreeGb: free / GB, memUsedGb: (total - free) / GB,
    swapGb: swapUsed ? Number(swapUsed) / 1024 : 0, pressure,
    diskFreeGb: disk ? (disk.bavail * disk.bsize) / GB : 0, diskTotalGb: disk ? (disk.blocks * disk.bsize) / GB : 0,
    load1: loadavg()[0], cores: cpus().length, chip,
  };
}

/** Resident memory of processes by pid, in GB (`ps` RSS; Metal buffers of mmapped weights count when touched). */
export async function rssGb(pids: number[]): Promise<Record<number, number>> {
  if (!pids.length) return {};
  const out = await run("ps", ["-o", "pid=,rss=", "-p", pids.join(",")]).then((r) => r.stdout).catch(() => "");
  const res: Record<number, number> = {};
  for (const line of out.trim().split("\n")) {
    const [pid, rss] = line.trim().split(/\s+/).map(Number);
    if (pid) res[pid] = (rss * 1024) / GB;
  }
  return res;
}
