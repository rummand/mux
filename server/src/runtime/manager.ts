import { spawn, type ChildProcess } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, readFileSync, statSync, truncateSync, unlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { config } from "../config.js";
import { event, settings } from "../db.js";
import { getModel, listModels, type Model } from "../models.js";
import { getProvider } from "../providers.js";
import { rssGb, systemStats } from "./system.js";

const GB = 1024 ** 3;
const RUN_DIR = join(config.home, "run");
mkdirSync(RUN_DIR, { recursive: true });
const LAYA_WORKER = new URL("../../laya/worker.mjs", import.meta.url).pathname;

export type State = "loading" | "ready" | "unloading" | "failed";
interface Instance {
  id: string; backend: Model["backend"]; port: number; pid: number; proc: ChildProcess;
  state: State; startedAt: number; readyAt: number | null; lastUsed: number; inflight: number;
  estimateGb: number; ready: Promise<void>; error: string | null; requests: number;
}

/** Where to send a request for a model, once it is ready. */
export interface Upstream { baseUrl: string; model: string; headers: Record<string, string>; coldStartMs: number }

export class ModelUnavailable extends Error {
  constructor(message: string, public status = 503, public type = "model_unavailable") { super(message); }
}

const instances = new Map<string, Instance>();
const lastFailure = new Map<string, { at: number; error: string }>();

/** What a model will take in memory: its weights, plus a KV cache estimate for its context. */
export function estimateGb(m: Model): number {
  if (m.backend === "external" || m.backend === "jev") return 0;
  if (m.backend === "laya") return 2;
  const weights = m.size_bytes / GB;
  // llama-server's prompt cache lives in RAM beside the weights: 4 GiB unless the model's flags say otherwise.
  const at = m.extra_args.findIndex((a) => a === "--cache-ram" || a === "-cram");
  const cacheGb = m.kind !== "chat" ? 0 : at >= 0 ? Math.max(0, Number(m.extra_args[at + 1]) || 0) / 1024 : m.backend === "llamacpp" ? 4 : 0;
  // The cache is a ceiling it fills over time, not a reservation: half of it is counted.
  if (m.kind === "chat") return Math.round((weights * 1.04 + (m.ctx / 1024) * 0.06 + cacheGb * 0.5 + 0.5) * 10) / 10;
  const kv = m.kind === "embedding" || m.kind === "rerank" ? 0.2 : m.kind === "systemone" ? 0.5 : (m.ctx / 1024) * 0.06;
  return Math.round((weights * 1.04 + kv + 0.5) * 10) / 10;
}

const isLocal = (m: Model) => m.backend === "llamacpp" || m.backend === "mlx" || m.backend === "laya";

async function freePort(): Promise<number> {
  const used = new Set([...instances.values()].map((i) => i.port));
  for (let p = config.portRange[0]; p <= config.portRange[1]; p++) {
    if (used.has(p)) continue;
    const ok = await new Promise<boolean>((res) => {
      const s = createServer().once("error", () => res(false)).once("listening", () => s.close(() => res(true)));
      s.listen(p, "127.0.0.1");
    });
    if (ok) return p;
  }
  throw new ModelUnavailable("no free port in mux's model port range");
}

function command(m: Model, port: number): { cmd: string; args: string[]; env?: Record<string, string> } {
  if (m.backend === "llamacpp") {
    if (!m.path || !existsSync(m.path)) throw new ModelUnavailable(`the weights for ${m.id} are not on disk (${m.path ?? "no path"})`, 500, "model_missing");
    const args = ["-m", m.path, "--alias", m.id, "--host", "127.0.0.1", "--port", String(port), "-ngl", "99", "--metrics", "--no-webui", "-c", String(m.ctx)];
    if (m.kind === "embedding") args.push("--embedding", "-ub", String(m.ctx), "-b", String(m.ctx), "--parallel", String(m.parallel));
    else if (m.kind === "rerank") args.push("--rerank", "-ub", String(m.ctx), "-b", String(m.ctx), "--parallel", String(m.parallel));
    else if (m.kind === "systemone") {
      // A decision model answers /v1/systemone in one forward pass, so the whole prompt must fit one micro-batch.
      args.push("-ub", String(m.ctx), "-b", String(m.ctx), "--parallel", String(m.parallel), "--cache-ram", "0");
      if (m.mmproj && existsSync(m.mmproj)) args.push("--mmproj", m.mmproj);
    } else {
      args.push("--jinja", "--parallel", String(m.parallel), "--reasoning", m.reasoning);
      if (!m.extra_args.some((a) => a === "--cache-ram" || a === "-cram")) args.push("--cache-ram", "4096");
      if (m.mmproj && existsSync(m.mmproj)) args.push("--mmproj", m.mmproj);
    }
    return { cmd: config.llamaServer, args: [...args, ...m.extra_args] };
  }
  if (m.backend === "mlx") {
    if (!existsSync(config.mlxPython)) throw new ModelUnavailable("MLX is not installed (no python with mlx-lm at " + config.mlxPython + ")", 500, "backend_missing");
    return { cmd: config.mlxPython, args: ["-m", "mlx_lm", "server", "--model", m.path ?? m.id, "--host", "127.0.0.1", "--port", String(port), ...m.extra_args] };
  }
  if (m.backend === "laya") {
    return {
      cmd: process.execPath, args: [LAYA_WORKER],
      env: { PORT: String(port), HOST: "127.0.0.1", LAYA_MODEL: m.id, LAYA_CACHE: join(config.modelsDir, "laya"), ...(m.path ? { LAYA_MODEL_DIR: m.path } : {}), ...(m.upstream_model ? { LAYA_REVISION: m.upstream_model } : {}) },
    };
  }
  throw new ModelUnavailable(`backend ${m.backend} is not run by mux`);
}

const healthPath = (m: Model) => (m.backend === "mlx" ? "/v1/models" : "/health");

function logTail(id: string, lines = 15): string {
  try { return readFileSync(join(config.logsDir, "models", `${id}.log`), "utf8").trim().split("\n").slice(-lines).join("\n"); } catch { return ""; }
}

async function waitHealthy(inst: Instance, m: Model, timeoutMs: number) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (inst.proc.exitCode !== null || inst.proc.signalCode) {
      const tail = logTail(m.id, 8);
      throw new Error(`the server exited while loading (code ${inst.proc.exitCode ?? inst.proc.signalCode})${tail ? ":\n" + tail : ""}`);
    }
    try {
      const r = await fetch(`http://127.0.0.1:${inst.port}${healthPath(m)}`, { signal: AbortSignal.timeout(2000) });
      if (r.ok) return;
    } catch { /* not listening yet */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`not healthy after ${Math.round(timeoutMs / 1000)} s`);
}

/** Make room for `needGb`: unload idle models, least recently used first. Returns whether it fits. */
async function makeRoom(needGb: number, except: string): Promise<{ ok: boolean; why: string }> {
  const s = settings();
  for (;;) {
    const loaded = [...instances.values()].filter((i) => i.id !== except && i.state !== "failed");
    const used = loaded.reduce((a, i) => a + i.estimateGb, 0);
    const sys = await systemStats();
    const overBudget = used + needGb > s.memoryBudgetGb;
    const overCount = loaded.length + 1 > s.maxLoaded;
    // Free memory already counts the loaded models, so only the newcomer is compared with it.
    const overFree = sys.memFreeGb - needGb < s.memoryHeadroomGb;
    if (!overBudget && !overCount && !overFree) return { ok: true, why: "" };
    const victim = loaded
      .filter((i) => i.inflight === 0 && i.state === "ready" && !getModel(i.id)?.pinned)
      .sort((a, b) => a.lastUsed - b.lastUsed)[0];
    const why = overBudget ? `mux's memory budget (${used.toFixed(1)} + ${needGb.toFixed(1)} of ${s.memoryBudgetGb} GB)`
      : overCount ? `the most models loaded at once (${s.maxLoaded})`
      : `the Mac's free memory (${sys.memFreeGb.toFixed(1)} GB free, ${needGb.toFixed(1)} GB needed, ${s.memoryHeadroomGb} GB kept for everything else)`;
    if (!victim) return { ok: false, why };
    event("info", "runtime", `unloading ${victim.id} to make room: ${why}`);
    await unload(victim.id);
  }
}

async function load(m: Model): Promise<Instance> {
  const need = estimateGb(m);
  if (need > settings().memoryBudgetGb) throw new ModelUnavailable(`${m.id} needs ~${need} GB, more than mux's whole memory budget (${settings().memoryBudgetGb} GB)`, 507, "memory_budget");
  const room = await makeRoom(need, m.id);
  if (!room.ok) throw new ModelUnavailable(`cannot load ${m.id} (~${need} GB): it would exceed ${room.why}, and every loaded model is busy or pinned`, 503, "memory_budget");
  const port = await freePort();
  const { cmd, args, env } = command(m, port);
  const logPath = join(config.logsDir, "models", `${m.id}.log`);
  try { if (statSync(logPath).size > 50 * 1024 * 1024) truncateSync(logPath, 0); } catch { /* new */ }
  const log = createWriteStream(logPath, { flags: "a" });
  log.write(`\n===== ${new Date().toISOString()} mux starts ${m.id}: ${cmd} ${args.join(" ")}\n`);
  const proc = spawn(cmd, args, { env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
  proc.stdout?.pipe(log);
  proc.stderr?.pipe(log);
  const inst: Instance = {
    id: m.id, backend: m.backend, port, pid: proc.pid ?? 0, proc, state: "loading", startedAt: Date.now(), readyAt: null,
    lastUsed: Date.now(), inflight: 0, estimateGb: need, error: null, requests: 0, ready: Promise.resolve(),
  };
  writeFileSync(join(RUN_DIR, `${m.id}.pid`), String(inst.pid));
  instances.set(m.id, inst);
  event("info", "runtime", `loading ${m.id} on :${port} (~${need} GB)`, { backend: m.backend, port });
  proc.on("exit", (code, signal) => {
    try { unlinkSync(join(RUN_DIR, `${m.id}.pid`)); } catch { /* gone */ }
    if (instances.get(m.id) !== inst) return;
    instances.delete(m.id);
    if (inst.state === "ready") {
      lastFailure.set(m.id, { at: Date.now(), error: `exited (${code ?? signal})` });
      event("error", "runtime", `${m.id} exited unexpectedly (${code ?? signal})`, { tail: logTail(m.id) });
    }
  });
  inst.ready = waitHealthy(inst, m, m.backend === "laya" ? 15 * 60_000 : 10 * 60_000).then(
    () => {
      inst.state = "ready"; inst.readyAt = Date.now();
      lastFailure.delete(m.id);
      event("info", "runtime", `${m.id} ready in ${((inst.readyAt - inst.startedAt) / 1000).toFixed(1)} s`, { ms: inst.readyAt - inst.startedAt });
    },
    (e: Error) => {
      inst.state = "failed"; inst.error = e.message;
      lastFailure.set(m.id, { at: Date.now(), error: e.message });
      event("error", "runtime", `${m.id} failed to load: ${e.message}`);
      instances.delete(m.id);
      proc.kill("SIGKILL");
      throw new ModelUnavailable(`${m.id} failed to load: ${e.message.split("\n")[0]}`, 503, "load_failed");
    },
  );
  return inst;
}

/** Load a model if it is not, and say where to reach it. Pair every call with `release`. */
export async function acquire(m: Model): Promise<Upstream> {
  if (!m.enabled) throw new ModelUnavailable(`${m.id} is disabled`, 403, "model_disabled");
  if (m.backend === "external" || m.backend === "jev" || m.backend === "node") {
    const p = m.provider_id ? getProvider(m.provider_id) : undefined;
    if (p && !p.enabled) throw new ModelUnavailable(`provider ${p.name} is disabled`, 403, "provider_disabled");
    if (p?.kind === "mux" && p.status !== "online") throw new ModelUnavailable(`node ${p.name} is offline${p.error ? `: ${p.error}` : ""}`, 503, "node_offline");
    const key = m.api_key || p?.api_key;
    const headers: Record<string, string> = key ? { authorization: `Bearer ${key}` } : {};
    // A node is asked for exactly this model: the gateway does the falling back, across nodes and clouds.
    if (m.backend === "node") headers["x-mux-no-fallback"] = "1";
    const base = m.backend === "node" ? `${p?.base_url ?? ""}/v1` : m.base_url || p?.base_url || "";
    return { baseUrl: base.replace(/\/$/, ""), model: m.upstream_model || m.id, headers, coldStartMs: 0 };
  }
  const t0 = Date.now();
  let inst = instances.get(m.id);
  if (!inst) {
    const failed = lastFailure.get(m.id);
    if (failed && Date.now() - failed.at < 30_000) throw new ModelUnavailable(`${m.id} failed to load ${Math.round((Date.now() - failed.at) / 1000)} s ago: ${failed.error.split("\n")[0]}`, 503, "load_failed");
    inst = await load(m);
  }
  inst.inflight++;
  inst.lastUsed = Date.now();
  try { await inst.ready; } catch (e) { inst.inflight--; throw e; }
  inst.requests++;
  const cold = inst.readyAt && inst.readyAt > t0 ? Date.now() - t0 : 0;
  return { baseUrl: `http://127.0.0.1:${inst.port}${m.backend === "laya" ? "" : "/v1"}`, model: m.backend === "mlx" ? (m.path ?? m.id) : m.id, headers: {}, coldStartMs: cold };
}

export function release(id: string) {
  const inst = instances.get(id);
  if (inst) { inst.inflight = Math.max(0, inst.inflight - 1); inst.lastUsed = Date.now(); }
}

export async function unload(id: string) {
  const inst = instances.get(id);
  if (!inst) return false;
  inst.state = "unloading";
  instances.delete(id);
  inst.proc.kill("SIGTERM");
  await new Promise<void>((res) => {
    const t = setTimeout(() => { inst.proc.kill("SIGKILL"); res(); }, 15_000);
    inst.proc.once("exit", () => { clearTimeout(t); res(); });
  });
  event("info", "runtime", `unloaded ${id}`);
  return true;
}

export async function warm(id: string) {
  const m = getModel(id);
  if (!m) throw new ModelUnavailable(`no model ${id}`, 404, "not_found");
  if (!isLocal(m)) return;
  await acquire(m);
  release(id);
}

export const isLoaded = (id: string) => instances.get(id)?.state === "ready";
export const instanceState = (id: string) => instances.get(id)?.state ?? null;
export const loadedIds = () => [...instances.keys()];

export interface InstanceStatus {
  id: string; backend: string; state: State; port: number; pid: number; estimateGb: number; rssGb: number | null;
  startedAt: number; readyAt: number | null; lastUsed: number; inflight: number; requests: number; idleMin: number;
  metrics: Record<string, number> | null;
}

async function scrape(inst: Instance): Promise<Record<string, number> | null> {
  if (inst.backend !== "llamacpp" || inst.state !== "ready") return null;
  try {
    const text = await (await fetch(`http://127.0.0.1:${inst.port}/metrics`, { signal: AbortSignal.timeout(1500) })).text();
    const out: Record<string, number> = {};
    for (const line of text.split("\n")) {
      const m = /^llamacpp:(\w+)\s+([\d.eE+-]+)/.exec(line);
      if (m) out[m[1]] = Number(m[2]);
    }
    return out;
  } catch { return null; }
}

export async function status(): Promise<InstanceStatus[]> {
  const list = [...instances.values()];
  const rss = await rssGb(list.map((i) => i.pid));
  return Promise.all(list.map(async (i) => ({
    id: i.id, backend: i.backend, state: i.state, port: i.port, pid: i.pid, estimateGb: i.estimateGb, rssGb: rss[i.pid] ?? null,
    startedAt: i.startedAt, readyAt: i.readyAt, lastUsed: i.lastUsed, inflight: i.inflight, requests: i.requests,
    idleMin: (Date.now() - i.lastUsed) / 60_000, metrics: await scrape(i),
  })));
}

export const failures = () => Object.fromEntries(lastFailure);

/** Unload what has been idle past its keep-alive, and, under memory pressure, the idle ones LRU first. */
async function sweep() {
  const s = settings();
  for (const inst of [...instances.values()]) {
    const m = getModel(inst.id);
    if (!m) { await unload(inst.id); continue; }
    const keep = (m.keep_alive_min ?? s.keepAliveMin) * 60_000;
    if (!m.pinned && inst.state === "ready" && inst.inflight === 0 && keep > 0 && Date.now() - inst.lastUsed > keep) {
      event("info", "runtime", `${inst.id} idle for ${Math.round((Date.now() - inst.lastUsed) / 60_000)} min; unloading`);
      await unload(inst.id);
    }
  }
  if (s.pressureGuard) {
    const sys = await systemStats();
    if (sys.pressure >= 2) {
      const victim = [...instances.values()].filter((i) => i.inflight === 0 && i.state === "ready" && !getModel(i.id)?.pinned).sort((a, b) => a.lastUsed - b.lastUsed)[0];
      if (victim) {
        event("warn", "runtime", `macOS reports memory pressure (${sys.pressure === 4 ? "critical" : "warn"}); unloading idle ${victim.id}`);
        await unload(victim.id);
      }
    }
  }
}

/** Processes a previous mux left behind (it was killed, not stopped): stop them before starting anew. */
function reapOrphans() {
  for (const m of listModels()) {
    const file = join(RUN_DIR, `${m.id}.pid`);
    if (!existsSync(file)) continue;
    const pid = Number(readFileSync(file, "utf8"));
    try { process.kill(pid, "SIGTERM"); event("info", "runtime", `stopped ${m.id} (pid ${pid}) left by an earlier mux`); } catch { /* already gone */ }
    try { unlinkSync(file); } catch { /* gone */ }
  }
}

export function startRuntime() {
  reapOrphans();
  setInterval(() => void sweep().catch((e) => event("error", "runtime", `sweep: ${e.message}`)), 30_000).unref();
  // Pinned models are wanted warm: load them once mux is up.
  setTimeout(() => {
    for (const m of listModels().filter((x) => x.pinned && x.enabled && isLocal(x))) void warm(m.id).catch(() => undefined);
  }, 2000);
}

export async function stopAll() {
  await Promise.all([...instances.keys()].map((id) => unload(id)));
}
