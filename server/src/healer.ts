import { execFile } from "node:child_process";
import { readdirSync, statSync, truncateSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { Worker } from "node:worker_threads";
import type { FastifyInstance } from "fastify";
import { API_REFERENCE, converse, isChange, parse, runTool, snapshot, type Call, type Msg } from "./assistant.js";
import { config } from "./config.js";
import { db, event, json, now, settings } from "./db.js";
import { getModel, listModels, listRoutes, upsertRoute } from "./models.js";
import { joinNode, listProviders, syncNode } from "./providers.js";
import { clearFailure, isLocal, probeTargets, runtimeBus, status, trackedPids, unload, warm } from "./runtime/manager.js";
import { systemStats } from "./runtime/system.js";

/**
 * Self-healing. A watchdog looks at mux every 20 s and repairs what it can on its own: model servers that crash, hang
 * or stop making progress are restarted (with backoff, and not forever); pinned models are kept loaded; orphaned
 * servers are stopped; memory and disk are freed; dangling route entries are pruned; a node whose key stopped working
 * is joined again; the database is checkpointed and checked. Each problem is an incident, open until it is fixed, with
 * every action taken. What the rules cannot fix goes to the doctor: the assistant, run headless with the incident, who
 * reads the logs and state, applies safe fixes itself (load, unload, sync, a smaller context…) and leaves anything
 * bigger as a proposal for a person to approve.
 */

type Severity = "low" | "medium" | "high";
interface Action { ts: number; by: "healer" | "doctor" | "user"; action: string; ok: boolean; detail?: string; proposal?: Call }
export interface Incident {
  id: string; ts: number; updated_at: number; kind: string; subject: string; severity: Severity; status: "open" | "escalated" | "resolved";
  title: string; detail: string | null; actions: Action[]; attempts: number; diagnosis: string | null; resolved_at: number | null;
}
type Row = Omit<Incident, "actions"> & { actions: string };
const fromRow = (r: Row): Incident => ({ ...r, actions: json(r.actions, []) });

const findOpen = (kind: string, subject: string) => {
  const r = db.prepare("SELECT * FROM incidents WHERE kind = ? AND subject = ? AND status != 'resolved' ORDER BY ts DESC LIMIT 1").get(kind, subject) as Row | undefined;
  return r && fromRow(r);
};
export const getIncident = (id: string) => { const r = db.prepare("SELECT * FROM incidents WHERE id = ?").get(id) as Row | undefined; return r && fromRow(r); };
const save = (i: Incident) => db.prepare(`UPDATE incidents SET updated_at = ?, severity = ?, status = ?, title = ?, detail = ?, actions = ?, attempts = ?, diagnosis = ?, resolved_at = ? WHERE id = ?`)
  .run(now(), i.severity, i.status, i.title, i.detail, JSON.stringify(i.actions.slice(-60)), i.attempts, i.diagnosis, i.resolved_at, i.id);

/** Open an incident, or bring the open one for the same problem up to date. */
function raise(kind: string, subject: string, severity: Severity, title: string, detail?: string): Incident {
  const open = findOpen(kind, subject);
  if (open) {
    const worse = severity === "high" || (severity === "medium" && open.severity === "low");
    const next = { ...open, title, detail: detail ?? open.detail, severity: worse ? severity : open.severity };
    save(next);
    return next;
  }
  const i: Incident = { id: `inc_${randomBytes(6).toString("hex")}`, ts: now(), updated_at: now(), kind, subject, severity, status: "open", title, detail: detail ?? null, actions: [], attempts: 0, diagnosis: null, resolved_at: null };
  db.prepare("INSERT INTO incidents(id, ts, updated_at, kind, subject, severity, status, title, detail, actions, attempts) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, '[]', 0)")
    .run(i.id, i.ts, i.ts, kind, subject, severity, "open", title, i.detail);
  event(severity === "high" ? "error" : "warn", "healer", `${title}`, { incident: i.id, kind, subject });
  return i;
}

function act(i: Incident, by: Action["by"], action: string, ok: boolean, detail?: string, extra: Partial<Action> = {}) {
  const fresh = getIncident(i.id) ?? i;
  fresh.actions.push({ ts: now(), by, action, ok, ...(detail ? { detail: detail.slice(0, 2000) } : {}), ...extra });
  if (by !== "user") fresh.attempts++;
  save(fresh);
  event(ok ? "info" : "warn", "healer", `${action}${ok ? "" : " — failed"}${detail ? `: ${detail.split("\n")[0].slice(0, 200)}` : ""}`, { incident: i.id });
  return fresh;
}

function resolve(kind: string, subject: string, note: string) {
  const open = findOpen(kind, subject);
  if (!open) return;
  open.status = "resolved"; open.resolved_at = now();
  open.actions.push({ ts: now(), by: "healer", action: note, ok: true });
  save(open);
  event("info", "healer", `resolved: ${open.title} — ${note}`, { incident: open.id });
}

function escalate(i: Incident, why: string) {
  const fresh = getIncident(i.id) ?? i;
  if (fresh.status === "escalated") return;
  fresh.status = "escalated"; fresh.severity = "high";
  fresh.actions.push({ ts: now(), by: "healer", action: `escalated: ${why}`, ok: false });
  save(fresh);
  event("error", "healer", `${fresh.title}: ${why}`, { incident: fresh.id });
  void doctor(fresh.id).catch(() => undefined);
}

/* ── The checks ─────────────────────────────────────────────────────────────────────────────────────────────── */

interface Check { id: string; label: string; ok: boolean; detail: string; at: number | null; fixes: number }
const checks = new Map<string, Check>();
function report(id: string, label: string, ok: boolean, detail: string, fixed = 0) {
  const prev = checks.get(id);
  checks.set(id, { id, label, ok, detail, at: now(), fixes: (prev?.fixes ?? 0) + fixed });
}

const backoff = (attempts: number) => Math.min(5_000 * 3 ** attempts, 10 * 60_000);
const notBefore = new Map<string, number>();
const due = (key: string) => (notBefore.get(key) ?? 0) <= Date.now();
const later = (key: string, ms: number) => notBefore.set(key, Date.now() + ms);

const recentlyUsed = (id: string, ms = 15 * 60_000) => !!db.prepare("SELECT 1 FROM requests WHERE model_id = ? AND ts >= ? LIMIT 1").get(id, now() - ms);
const wanted = (id: string) => { const m = getModel(id); return !!m && m.enabled && (m.pinned || recentlyUsed(id)); };

async function restart(id: string, i: Incident, why: string) {
  try {
    await unload(id);
    clearFailure(id);
    await warm(id);
    act(i, "healer", `restarted ${id} (${why})`, true);
    return true;
  } catch (e) {
    act(i, "healer", `restart of ${id} (${why})`, false, (e as Error).message);
    return false;
  }
}

/** Crashes, as they happen: restart what is wanted, with backoff; four in 15 minutes is a crash loop for the doctor. */
const crashes = new Map<string, number[]>();
function onCrash({ id, code, tail }: { id: string; code: unknown; tail: string }) {
  if (!settings().selfHeal) return;
  const list = (crashes.get(id) ?? []).filter((t) => t > Date.now() - 15 * 60_000);
  list.push(Date.now());
  crashes.set(id, list);
  const i = raise("crash", id, list.length >= 3 ? "high" : "medium", `${id} crashed (${code})${list.length > 1 ? ` — ${list.length}× in 15 min` : ""}`, tail);
  if (list.length >= 4) return escalate(i, "crash loop: 4 crashes in 15 minutes; automatic restarts stopped");
  if (!wanted(id)) return act(i, "healer", `not restarting ${id}: not pinned and not used in 15 min (it loads on the next request)`, true);
  const wait = backoff(list.length - 1);
  setTimeout(() => void restart(id, i, `after a crash, waited ${Math.round(wait / 1000)} s`).then((ok) => ok && resolve("crash", id, "running again")), wait).unref();
}

function onLoadFailed({ id, error, tail }: { id: string; error: string; tail: string }) {
  if (!settings().selfHeal) return;
  const m = getModel(id);
  if (!m?.pinned) return; // A request's load failure is the request's; a pinned model must be up.
  const i = raise("load", id, "medium", `${id} (pinned) failed to load`, `${error}\n${tail}`);
  if (i.attempts >= 4) escalate(i, "four loads in a row failed");
}

const probeFails = new Map<string, number>();
const progress = new Map<string, { total: number; since: number }>();

/** Every ready model server answers its health check, and one that is busy makes progress. */
async function probeModels() {
  const targets = probeTargets().filter((t) => t.state === "ready");
  const stats = await status();
  let fixed = 0; const bad: string[] = [];
  for (const t of targets) {
    let ok = false;
    try { ok = (await fetch(`http://127.0.0.1:${t.port}${t.healthPath}`, { signal: AbortSignal.timeout(5000) })).ok; } catch { /* no answer */ }
    const n = ok ? 0 : (probeFails.get(t.id) ?? 0) + 1;
    probeFails.set(t.id, n);
    if (ok) resolve("hung", t.id, "answers its health check again");
    if (n >= 3) {
      bad.push(t.id);
      const i = raise("hung", t.id, "medium", `${t.id} does not answer its health check`, `${n} checks in a row failed (port ${t.port}, pid ${t.pid})`);
      if (t.inflight === 0 || n >= 6) {
        probeFails.set(t.id, 0);
        if (i.attempts >= 3) { escalate(i, "restarts did not help"); continue; }
        if (await restart(t.id, i, "not answering")) { fixed++; resolve("hung", t.id, "restarted"); }
      }
      continue;
    }
    // Busy but stuck: requests processing, and no token counted for 3 minutes.
    const m = stats.find((s) => s.id === t.id)?.metrics;
    if (!m) continue;
    const total = (m.tokens_predicted_total ?? 0) + (m.prompt_tokens_total ?? 0);
    const p = progress.get(t.id);
    if (!p || p.total !== total || !(m.requests_processing > 0)) { progress.set(t.id, { total, since: Date.now() }); resolve("stuck", t.id, "making progress"); continue; }
    if (Date.now() - p.since > 3 * 60_000) {
      bad.push(t.id);
      const i = raise("stuck", t.id, "medium", `${t.id} is stuck: ${m.requests_processing} requests and no tokens for ${Math.round((Date.now() - p.since) / 60_000)} min`);
      progress.delete(t.id);
      if (i.attempts >= 3) { escalate(i, "restarts did not help"); continue; }
      if (await restart(t.id, i, "stuck")) { fixed++; resolve("stuck", t.id, "restarted"); }
    }
  }
  report("models", "Model servers answer and make progress", !bad.length, bad.length ? `not healthy: ${bad.join(", ")}` : `${targets.length} ready, all healthy`, fixed);
}

/** Pinned models are loaded. */
async function keepPinned() {
  const loaded = new Set(probeTargets().map((t) => t.id));
  const down = listModels().filter((m) => m.pinned && m.enabled && isLocal(m) && !loaded.has(m.id));
  let fixed = 0;
  for (const m of down) {
    const key = `pin:${m.id}`;
    if (!due(key)) continue;
    const i = raise("pinned", m.id, "medium", `pinned ${m.id} is not loaded`);
    if (i.attempts >= 5) { escalate(i, "five loads did not keep it up"); later(key, 30 * 60_000); continue; }
    later(key, backoff(i.attempts));
    try { clearFailure(m.id); await warm(m.id); act(i, "healer", `loaded ${m.id}`, true); resolve("pinned", m.id, "loaded"); fixed++; }
    catch (e) { act(i, "healer", `load ${m.id}`, false, (e as Error).message); }
  }
  for (const m of listModels().filter((x) => x.pinned && loaded.has(x.id))) resolve("pinned", m.id, "loaded");
  report("pinned", "Pinned models are loaded", !down.length, down.length ? `not loaded: ${down.map((m) => m.id).join(", ")}` : "all pinned models loaded", fixed);
}

/** A burst of 5xx answers from one model: restart it if it is ours; tell the doctor if it goes on. */
async function errorSpikes() {
  const rows = db.prepare(`SELECT model_id, COUNT(*) n, SUM(CASE WHEN status >= 500 THEN 1 ELSE 0 END) e, MAX(error) err FROM requests WHERE ts >= ? AND model_id IS NOT NULL GROUP BY model_id`)
    .all(now() - 5 * 60_000) as { model_id: string; n: number; e: number; err: string | null }[];
  const bad = rows.filter((r) => r.n >= 5 && r.e / r.n >= 0.5);
  let fixed = 0;
  for (const r of bad) {
    const i = raise("errors", r.model_id, "medium", `${r.model_id}: ${r.e} of ${r.n} requests failed in 5 min`, r.err ?? undefined);
    const m = getModel(r.model_id);
    const local = m && isLocal(m) && probeTargets().some((t) => t.id === m.id);
    if (local && due(`err:${m.id}`)) { later(`err:${m.id}`, 10 * 60_000); if (await restart(m.id, i, "failing requests")) fixed++; }
    if (now() - i.ts > 15 * 60_000) escalate(i, "the errors have gone on for 15 minutes");
  }
  for (const r of rows.filter((x) => !bad.includes(x) && x.n >= 3 && x.e / x.n < 0.2)) resolve("errors", r.model_id, "requests succeed again");
  report("errors", "No model is failing most of its requests", !bad.length, bad.length ? bad.map((r) => `${r.model_id} ${r.e}/${r.n}`).join(", ") : "error rates normal", fixed);
}

/** llama-server processes on mux's ports that mux does not know: left by a crash of mux itself. */
async function reapOrphans() {
  const out = await new Promise<string>((res) => execFile("ps", ["-axo", "pid=,command="], (e, so) => res(e ? "" : so)));
  const mine = trackedPids();
  const [lo, hi] = config.portRange;
  const orphans = out.split("\n").map((l) => /^\s*(\d+)\s+(.*)$/.exec(l)).filter((m): m is RegExpExecArray => !!m)
    .filter(([, pid, cmd]) => /llama-server|mlx_lm|laya\/worker/.test(cmd) && !mine.has(Number(pid)))
    .filter(([, , cmd]) => { const port = Number(/--port[ =](\d+)/.exec(cmd)?.[1]); return port >= lo && port <= hi; });
  for (const [, pid, cmd] of orphans) {
    try {
      process.kill(Number(pid), "SIGTERM");
      const i = raise("orphan", pid, "low", `stopped an orphaned model server (pid ${pid})`, cmd.slice(0, 300));
      act(i, "healer", `sent SIGTERM to ${pid}`, true);
      resolve("orphan", pid, "stopped");
    } catch { /* gone */ }
  }
  report("orphans", "No orphaned model servers", true, orphans.length ? `stopped ${orphans.length}` : "none found", orphans.length);
}

/** Memory: under critical pressure, idle models go (the runtime does it at warn); with nothing to unload, the doctor. */
let critical = 0;
async function memory() {
  const sys = await systemStats();
  const s = settings();
  critical = sys.pressure >= 4 ? critical + 1 : 0;
  let fixed = 0;
  if (critical >= 3) {
    const idle = probeTargets().filter((t) => t.state === "ready" && t.inflight === 0 && !getModel(t.id)?.pinned);
    const i = raise("memory", "system", "high", `memory pressure critical (${sys.memFreeGb.toFixed(1)} GB free, ${sys.swapGb.toFixed(1)} GB swap)`);
    if (idle[0]) { await unload(idle[0].id); act(i, "healer", `unloaded idle ${idle[0].id}`, true); fixed++; }
    else escalate(i, "nothing idle left to unload");
    critical = 0;
  } else if (sys.pressure < 2 && sys.memFreeGb > s.memoryHeadroomGb) resolve("memory", "system", "pressure is back to normal");
  report("memory", "Memory is not under critical pressure", sys.pressure < 4, `${sys.memFreeGb.toFixed(1)} GB free · ${sys.swapGb.toFixed(1)} GB swap · pressure ${sys.pressure === 1 ? "normal" : sys.pressure === 2 ? "warn" : "critical"}`, fixed);
}

/** Disk: below the reserve, model logs over 20 MB are emptied. */
async function disk() {
  const sys = await systemStats();
  const low = sys.diskFreeGb < settings().diskReserveGb;
  let freed = 0;
  if (low) {
    const i = raise("disk", "system", "medium", `disk below the reserve: ${sys.diskFreeGb.toFixed(1)} GB free`);
    const dir = join(config.logsDir, "models");
    for (const f of readdirSync(dir)) {
      const p = join(dir, f);
      try { const sz = statSync(p).size; if (sz > 20 * 1024 * 1024) { truncateSync(p, 0); freed += sz; } } catch { /* gone */ }
    }
    if (freed) act(i, "healer", `emptied model logs (${(freed / 1024 ** 3).toFixed(2)} GB)`, true);
    if (!freed && i.attempts === 0) escalate(i, "nothing mux can delete on its own; downloaded models take the space");
  } else resolve("disk", "system", "space is back above the reserve");
  report("disk", "Disk is above the reserve", !low, `${sys.diskFreeGb.toFixed(1)} GB free (reserve ${settings().diskReserveGb} GB)`, freed ? 1 : 0);
}

/** Routes only list models that exist. */
function routes() {
  const ids = new Set(listModels().map((m) => m.id));
  let fixed = 0;
  for (const r of listRoutes()) {
    const gone = r.candidates.filter((c) => !ids.has(c));
    if (!gone.length) continue;
    upsertRoute({ ...r, candidates: r.candidates.filter((c) => ids.has(c)) });
    const i = raise("route", r.name, "low", `route ${r.name} listed models that no longer exist`);
    act(i, "healer", `removed ${gone.join(", ")} from ${r.name}`, true);
    resolve("route", r.name, "pruned");
    fixed++;
  }
  report("routes", "Routes list existing models", true, fixed ? `pruned ${fixed} routes` : "all candidates exist", fixed);
}

/** Nodes: offline ones are synced again (with backoff); one that rejects the gateway's key is joined again. */
async function nodes() {
  const list = listProviders().filter((p) => p.kind === "mux" && p.enabled);
  if (!list.length) return;
  const down: string[] = [];
  let fixed = 0;
  for (const p of list) {
    if (p.status !== "online") {
      down.push(p.id);
      const offlineFor = now() - (p.last_seen ?? 0);
      if (offlineFor < 60_000) continue;
      const i = raise("node", p.id, offlineFor > 15 * 60_000 ? "high" : "medium", `node ${p.name} is unreachable`, p.error ?? undefined);
      if (due(`node:${p.id}`)) { later(`node:${p.id}`, backoff(Math.min(i.attempts, 4))); await syncNode(p); act(i, "healer", `tried to reach ${p.name} again`, false, p.error ?? undefined); }
      if (offlineFor > 15 * 60_000) escalate(i, "unreachable for 15 minutes; the node itself, its tunnel or its network is down");
      continue;
    }
    resolve("node", p.id, "reachable again");
    if (!p.api_key || !due(`key:${p.id}`)) continue;
    later(`key:${p.id}`, 2 * 60_000);
    try {
      const r = await fetch(`${p.base_url}/v1/models`, { headers: { authorization: `Bearer ${p.api_key}` }, signal: AbortSignal.timeout(10_000) });
      if (r.status === 401 || r.status === 403) {
        const i = raise("node-key", p.id, "high", `node ${p.name} rejects the gateway's key`);
        try { await joinNode(p, config.name); act(i, "healer", `joined ${p.name} again with a new key`, true); resolve("node-key", p.id, "joined again"); fixed++; }
        catch (e) { act(i, "healer", `join ${p.name} again`, false, (e as Error).message); escalate(i, "joining again failed: check the node's admin token"); }
      }
    } catch { /* reachability is the sync's job */ }
  }
  report("nodes", "Nodes are reachable and accept the gateway", !down.length, down.length ? `unreachable: ${down.join(", ")}` : `${list.length} online`, fixed);
}

/** The database: WAL checkpointed, statistics fresh, and a quick integrity check at start. */
function database(first = false) {
  try {
    if (first) {
      const r = db.prepare("PRAGMA quick_check").get() as Record<string, string>;
      const ok = Object.values(r)[0] === "ok";
      if (!ok) raise("database", "mux.db", "high", "the database failed its integrity check", JSON.stringify(r));
      report("database", "Database is sound", ok, ok ? "integrity ok" : "integrity check failed");
      return;
    }
    db.pragma("wal_checkpoint(TRUNCATE)");
    db.pragma("optimize");
    report("database", "Database is sound", true, "checkpointed and optimized");
  } catch (e) { report("database", "Database is sound", false, (e as Error).message); }
}

/** The event loop: a wedged mux answers nothing. Measured as how late a 1 s timer fires. */
let lagMs = 0;
function watchLag() {
  let last = performance.now();
  setInterval(() => { const t = performance.now(); lagMs = Math.max(0, t - last - 1000); last = t; if (lagMs > 2000) event("warn", "healer", `event loop was blocked for ${Math.round(lagMs)} ms`); }, 1000).unref();
}

/**
 * A dead man's switch on its own thread: the main thread beats every 5 s; if it stops for 90 s (a wedged event loop
 * answers nothing, and no timer of its own can notice), the thread kills the process and the supervisor restarts it.
 */
function deadman() {
  const w = new Worker(`
    const { parentPort } = require("node:worker_threads");
    let last = Date.now();
    parentPort.on("message", () => { last = Date.now(); });
    setInterval(() => {
      if (Date.now() - last > 90000) { console.error("mux watchdog: the main thread has not answered for 90 s; restarting"); process.kill(${process.pid}, "SIGKILL"); }
    }, 5000);
  `, { eval: true });
  w.unref();
  setInterval(() => w.postMessage(1), 5000).unref();
}

/* ── The loop ───────────────────────────────────────────────────────────────────────────────────────────────── */

let ticks = 0, lastTick = 0, running = false;
export async function tick() {
  if (running || !settings().selfHeal) return;
  running = true;
  const n = ticks++;
  const node = config.role !== "gateway";
  const safely = async (id: string, fn: () => unknown) => { try { await fn(); } catch (e) { report(id, id, false, `check failed: ${(e as Error).message}`); } };
  try {
    if (node) {
      await safely("models", probeModels);
      await safely("pinned", keepPinned);
      await safely("memory", memory);
      if (n % 6 === 0) await safely("orphans", reapOrphans);
      if (n % 15 === 0) await safely("disk", disk);
    }
    await safely("errors", errorSpikes);
    await safely("nodes", nodes);
    if (n % 15 === 0) await safely("routes", routes);
    if (n % 30 === 0 && n) await safely("database", () => database());
    report("loop", "mux responds (event loop)", lagMs < 2000, `last timer ${Math.round(lagMs)} ms late`);
  } finally { running = false; lastTick = now(); }
}

export function startHealer(app: FastifyInstance) {
  doctorApp = app;
  runtimeBus.on("crash", onCrash);
  runtimeBus.on("loadFailed", onLoadFailed);
  watchLag();
  database(true);
  // The first tick waits for pinned models to start loading on their own.
  setTimeout(() => { void tick(); setInterval(() => void tick(), 20_000).unref(); }, 30_000).unref();
  // Last resort: a crash of mux itself is recorded, and the supervisor (launchd, Railway) starts it again.
  process.on("uncaughtException", (e) => {
    try { raise("process", "mux", "high", `mux crashed: ${e.message}`, e.stack); } catch { /* the database may be what failed */ }
    console.error(e);
    process.exit(1);
  });
  deadman();
  process.on("unhandledRejection", (e) => { event("warn", "healer", `unhandled rejection: ${(e as Error)?.message ?? String(e)}`); });
}

/* ── The doctor ─────────────────────────────────────────────────────────────────────────────────────────────── */

let doctorApp: FastifyInstance | null = null;
let doctorBusy = false, doctorLast = 0;

/**
 * Changes the doctor may make on its own: they are undone by the next load, unload or edit, and none of them can cut
 * what callers rely on — a smaller context must still hold the largest request the model served in 30 days, and server
 * flags change only when the server failed to start.
 */
function safeChange(c: Call, inc: Incident): true | string {
  const a = parse(c.function.arguments);
  if (!isChange(c.function.name, a)) return true;
  const method = String(a.method).toUpperCase();
  const path = String(a.path ?? "").replace(/^\/providers\/[^/]+\/proxy/, "");
  if (method === "POST" && /^\/models\/.+\/(load|unload)$/.test(path)) return true;
  if (method === "POST" && /^\/providers\/[^/]+\/sync$/.test(path)) return true;
  if (method === "POST" && path === "/benchmarks") return true;
  if (method !== "PATCH" || !/^\/models\//.test(path)) return "not one of the changes the doctor makes alone";
  const body = (a.body ?? {}) as Record<string, unknown>;
  const keys = Object.keys(body);
  if (!keys.length || !keys.every((k) => ["ctx", "parallel", "reasoning", "keep_alive_min", "extra_args"].includes(k))) return "changes to other model fields need a person";
  const m = getModel(decodeURIComponent(path.replace(/^\/models\//, "")));
  if (!m) return "no such model here";
  if ("ctx" in body) {
    const next = Number(body.ctx);
    const used = (db.prepare("SELECT MAX(prompt_tokens + completion_tokens) n FROM requests WHERE model_id = ? AND ts >= ?").get(m.id, now() - 30 * 86400_000) as { n: number | null }).n ?? 0;
    if (!(next > 0) || (next < m.ctx && next < Math.ceil(used * 1.25))) return `a context of ${next} would not hold the largest request ${m.id} served in 30 days (${used} tokens)`;
  }
  if ("extra_args" in body && !["load", "crash"].includes(inc.kind)) return "server flags change only when the server failed to start or crashed";
  return true;
}

export async function doctor(id: string, force = false): Promise<Incident | undefined> {
  const s = settings();
  const inc = getIncident(id);
  if (!inc || !doctorApp) return inc;
  if (!force && (!s.selfHealAi || doctorBusy || Date.now() - doctorLast < 5 * 60_000)) return inc;
  if (!force && inc.actions.some((a) => a.by === "doctor" && a.ts > now() - 30 * 60_000)) return inc;
  doctorBusy = true; doctorLast = Date.now();
  const proposals: Call[] = [];
  try {
    act(inc, "doctor", "started a diagnosis", true);
    const sys = `You are mux's doctor: the self-healing part of mux, a model router and control plane (local models on mux nodes, cloud APIs, tenants, routes). mux's rule-based healer could not fix an incident on its own and hands it to you. Find the root cause with your tools — the events, the logs (read_log, also for model servers), the system state, the model's settings and recent failed requests — then fix it.

You may make these changes yourself, and they run at once: load or unload a model, sync a provider, run a benchmark, and PATCH a model's ctx, parallel, reasoning, keep_alive_min or extra_args (e.g. a smaller context when memory is short, or removing a flag the server rejects). Any other change (settings, routes, tenants, deleting, disabling) is recorded as a proposal for a person to approve — call it anyway if it is the right fix, with a clear "why". Evidence first: change something only when the logs, events or requests show it is the cause, and quote that evidence. A single crash or kill (e.g. SIGKILL, SIGTERM) with no matching error in the model's log (out of memory, a Metal/GGML error, an assert) is not evidence of a cause — it may have been stopped from outside; if the incident is resolved and the model is healthy again, change nothing and say so. Never shrink a model's context or slots to "be safe": callers rely on them. Do not ask questions: nobody is reading until you are done. Verify your fix (the model loads, a test_request succeeds). Finish with a short report in Markdown: **Cause**, **What I did**, **What a person should do** (if anything).

${API_REFERENCE}

Now: ${new Date().toISOString()}. This mux: role ${config.role}, name "${config.name}".
${await snapshot()}`;
    const user = `Incident ${inc.id} (${inc.kind} · ${inc.subject} · ${inc.severity} · ${inc.status}${inc.status === "resolved" ? ": the healer already fixed it — find out why it happened; change nothing unless the cause is clear and will recur" : ""}): ${inc.title}\n\nDetail:\n${(inc.detail ?? "").slice(0, 3000)}\n\nWhat the healer did:\n${inc.actions.map((a) => `- ${new Date(a.ts).toISOString()} ${a.by}: ${a.action}${a.ok ? "" : " (failed)"}${a.detail ? ` — ${a.detail.split("\n")[0].slice(0, 200)}` : ""}`).join("\n") || "- nothing yet"}`;
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 8 * 60_000);
    let msgs: Msg[] = [{ role: "user", content: user }];
    try {
      msgs = await converse(doctorApp, {
        msgs, sys, model: s.assistantModel || "auto", convo: `doctor_${inc.id}`, signal: ac.signal, agent: "doctor",
        emit: () => undefined,
        decide: (c) => {
          const safe = safeChange(c, inc);
          if (safe === true) {
            if (isChange(c.function.name, parse(c.function.arguments))) {
              const a = parse(c.function.arguments);
              act(inc, "doctor", `${String(a.method).toUpperCase()} ${a.path}${a.why ? ` — ${a.why}` : ""}`, true, a.body ? JSON.stringify(a.body) : undefined);
            }
            return "run";
          }
          proposals.push(c);
          return { skip: `recorded as a proposal for a person to approve (${safe}); not run. Go on as if it is pending.` };
        },
      });
    } finally { clearTimeout(timer); }
    const report = [...msgs].reverse().find((m) => m.role === "assistant" && m.content)?.content ?? "(the doctor gave no report)";
    const fresh = getIncident(inc.id)!;
    fresh.diagnosis = report;
    for (const p of proposals) {
      const a = parse(p.function.arguments);
      fresh.actions.push({ ts: now(), by: "doctor", action: `proposes ${String(a.method).toUpperCase()} ${a.path}${a.why ? ` — ${a.why}` : ""}`, ok: true, proposal: p });
    }
    save(fresh);
    event("info", "healer", `doctor finished ${inc.id}${proposals.length ? ` with ${proposals.length} proposals` : ""}`, { incident: inc.id });
    return getIncident(inc.id);
  } catch (e) {
    act(inc, "doctor", "diagnosis", false, (e as Error).message);
    return getIncident(inc.id);
  } finally { doctorBusy = false; }
}

/* ── Admin API ──────────────────────────────────────────────────────────────────────────────────────────────── */

export function registerHealer(api: FastifyInstance) {
  api.get("/healer", async () => {
    const s = settings();
    const counts = db.prepare("SELECT status, COUNT(*) n FROM incidents GROUP BY status").all();
    const fixes24h = db.prepare("SELECT COUNT(*) n FROM events WHERE source = 'healer' AND level = 'info' AND ts >= ?").get(now() - 86400_000) as { n: number };
    return { enabled: s.selfHeal, ai: s.selfHealAi, lastTick, ticks, doctorBusy, checks: [...checks.values()], counts, actions24h: fixes24h.n };
  });
  api.post("/healer/run", async () => { await tick(); return { ok: true, checks: [...checks.values()] }; });
  api.get("/incidents", async (req) => {
    const q = req.query as { status?: string; limit?: string; subject?: string };
    const where: string[] = []; const args: unknown[] = [];
    if (q.status === "open") where.push("status != 'resolved'"); else if (q.status) { where.push("status = ?"); args.push(q.status); }
    if (q.subject) { where.push("(subject = ? OR subject LIKE ?)"); args.push(q.subject, `${q.subject}/%`); }
    const rows = db.prepare(`SELECT * FROM incidents ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY updated_at DESC LIMIT ?`).all(...args, Math.min(Number(q.limit) || 100, 500)) as Row[];
    return rows.map(fromRow);
  });
  api.get("/incidents/:id", async (req, reply) => getIncident((req.params as { id: string }).id) ?? reply.code(404).send({ error: "no such incident" }));
  api.post("/incidents/:id/resolve", async (req, reply) => {
    const i = getIncident((req.params as { id: string }).id);
    if (!i) return reply.code(404).send({ error: "no such incident" });
    i.status = "resolved"; i.resolved_at = now();
    i.actions.push({ ts: now(), by: "user", action: "marked resolved", ok: true });
    save(i);
    return getIncident(i.id);
  });
  api.post("/incidents/:id/doctor", async (req, reply) => {
    const i = getIncident((req.params as { id: string }).id);
    if (!i) return reply.code(404).send({ error: "no such incident" });
    if (doctorBusy) return reply.code(409).send({ error: "the doctor is busy with another incident" });
    void doctor(i.id, true);
    return { ok: true };
  });
  // A doctor's proposal, approved by a person: run it.
  api.post("/incidents/:id/apply", async (req, reply) => {
    const i = getIncident((req.params as { id: string }).id);
    const idx = Number((req.body as { index?: number })?.index);
    const a = i?.actions[idx];
    if (!i || !a?.proposal || !doctorApp) return reply.code(404).send({ error: "no such proposal" });
    const out = await runTool(doctorApp, a.proposal, () => undefined);
    const ok = !/"error"|"status":[45]\d\d/.test(out);
    const fresh = getIncident(i.id)!;
    fresh.actions[idx] = { ...a, proposal: undefined, action: `${a.action.replace(/^proposes/, "approved:")}`, ok, detail: out.slice(0, 1000) };
    fresh.actions.push({ ts: now(), by: "user", action: `approved and ran: ${a.action.replace(/^proposes /, "")}`, ok, detail: out.slice(0, 1000) });
    save(fresh);
    return getIncident(i.id);
  });
}
