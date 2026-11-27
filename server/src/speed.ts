import { createHash } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { config } from "./config.js";
import { db, json, settings } from "./db.js";
import { inflightNow } from "./router/limits.js";
import { gate, hotness, loadedIds } from "./runtime/manager.js";
import { keeperSeen, PRIORITIES, voiceOpen, type Priority } from "./priority.js";
import type { Ctx } from "./router/metering.js";

/**
 * Turn stats (owner, 27 November 2026: "do that on mux, so we have some stats and data direct in mux we can use and
 * performance tune from"). One row per chat, messages or voice turn, on the Mac and on the Railway gateway alike, with
 * where its time went: the wait to be admitted (presence, a cold load, the wait for a slot and why), the prompt read
 * (tokens, those from the prompt cache, prefill ms), the first token, generation (tokens, tokens/s), the total; who
 * asked (tenant, the person hashed, route, model, class); what else was going on at admission; the caller's own trace
 * and stages (`x-mux-trace`, `x-mux-stage`), so Bloom's numbers join mux's; for a voice turn, the session's own
 * marks. No prompt or answer is kept. Rows are kept settings.speedRetentionDays (30).
 */
db.exec(`
CREATE TABLE IF NOT EXISTS turn_stats (
  id TEXT PRIMARY KEY, ts INTEGER NOT NULL, started INTEGER NOT NULL, node TEXT, role TEXT,
  tenant_id TEXT, user_hash TEXT, endpoint TEXT NOT NULL, route TEXT, model_id TEXT, priority TEXT NOT NULL, priority_why TEXT,
  trace TEXT, status INTEGER, error_type TEXT, stream INTEGER DEFAULT 0, cold INTEGER DEFAULT 0, fallbacks INTEGER DEFAULT 0,
  queue_ms REAL, admit_ms REAL, load_ms REAL, slot_wait_ms REAL, queue_reasons TEXT, concurrent INTEGER, ahead INTEGER,
  prompt_tokens INTEGER, cached_tokens INTEGER, prefill_ms REAL, reasoning_ms REAL, ttft_ms REAL, gen_tokens INTEGER, tps REAL, total_ms REAL, upstream_ms REAL,
  loaded INTEGER, running INTEGER, waiting INTEGER, voice INTEGER, ci_running INTEGER, ci_paused INTEGER, record_busy INTEGER, tenants_inflight INTEGER,
  stages TEXT, realtime TEXT
);
CREATE INDEX IF NOT EXISTS turn_stats_ts ON turn_stats(ts);
CREATE INDEX IF NOT EXISTS turn_stats_trace ON turn_stats(trace);
`);

/** The endpoints whose calls are turns: a person (or an agent) waiting for words. */
export const TURN_ENDPOINTS = new Set(["openai.chat", "anthropic.messages", "realtime.chat", "realtime.turn"]);

export interface Competing {
  loaded: number; running: number; waiting: number; voice: number; ciRunning: number | null; ciPaused: number; recordBusy: boolean; tenantsInflight: number;
}

let ciCache: { at: number; n: number | null } = { at: 0, n: null };
/** CI jobs running on this Mac's runners, as build.ts last read GitHub (each minute); null where there is no build server. */
function ciRunning(): number | null {
  const k = keeperSeen().ciRunning;
  if (k != null) return k;
  if (Date.now() - ciCache.at < 15_000) return ciCache.n;
  let n: number | null = null;
  try { n = (db.prepare("SELECT COUNT(*) n FROM build_jobs WHERE status = 'in_progress' AND started_at > ?").get(Date.now() - 6 * 3600_000) as { n: number }).n; } catch { n = null; }
  ciCache = { at: Date.now(), n };
  return n;
}

/** What else was going on, now: taken when a turn gets its model. */
export function competing(): Competing {
  const t = gate.totals();
  const k = keeperSeen();
  return {
    loaded: loadedIds().length, running: t.running, waiting: t.waiting, voice: voiceOpen(), ciRunning: ciRunning(), ciPaused: k.ciPaused, recordBusy: k.recordBusy,
    tenantsInflight: Object.values(inflightNow()).reduce((a, n) => a + n, 0),
  };
}

export const hashUser = (tenant: string, user: string | null | undefined) => (user ? createHash("sha256").update(`mux-speed:${tenant}:${user}`).digest("hex").slice(0, 16) : null);

const put = db.prepare(`INSERT OR REPLACE INTO turn_stats(id, ts, started, node, role, tenant_id, user_hash, endpoint, route, model_id, priority, priority_why, trace, status, error_type,
  stream, cold, fallbacks, queue_ms, admit_ms, load_ms, slot_wait_ms, queue_reasons, concurrent, ahead, prompt_tokens, cached_tokens, prefill_ms, reasoning_ms, ttft_ms, gen_tokens, tps, total_ms, upstream_ms,
  loaded, running, waiting, voice, ci_running, ci_paused, record_busy, tenants_inflight, stages, realtime)
  VALUES(@id, @ts, @started, @node, @role, @tenant_id, @user_hash, @endpoint, @route, @model_id, @priority, @priority_why, @trace, @status, @error_type,
  @stream, @cold, @fallbacks, @queue_ms, @admit_ms, @load_ms, @slot_wait_ms, @queue_reasons, @concurrent, @ahead, @prompt_tokens, @cached_tokens, @prefill_ms, @reasoning_ms, @ttft_ms, @gen_tokens, @tps, @total_ms, @upstream_ms,
  @loaded, @running, @waiting, @voice, @ci_running, @ci_paused, @record_busy, @tenants_inflight, @stages, @realtime)`);

export type TurnRow = Record<string, string | number | null>;
const r1 = (n: number | null | undefined) => (n == null || !Number.isFinite(n) ? null : Math.round(n * 10) / 10);

function write(row: TurnRow) {
  try { put.run(row); } catch (e) { console.error("speed:", (e as Error).message); }
}

function base(c: Competing | null | undefined) {
  const k = c ?? competing();
  return {
    loaded: k.loaded, running: k.running, waiting: k.waiting, voice: k.voice, ci_running: k.ciRunning, ci_paused: k.ciPaused, record_busy: k.recordBusy ? 1 : 0, tenants_inflight: k.tenantsInflight,
  };
}

/** From metering.finish: one row for a turn endpoint. `row` is the request's own record (its ids and totals). */
export function recordTurn(ctx: Ctx, row: { id: string; ts: number; latency_ms: number; status: number; error_type: string | null; prompt_tokens: number; completion_tokens: number; cached_tokens: number; ttft_ms: number | null; tps: number | null }) {
  if (!TURN_ENDPOINTS.has(ctx.endpoint) || ctx.endpoint === "realtime.turn") return;
  const a = ctx.acq;
  write({
    id: row.id, ts: row.ts, started: row.ts - row.latency_ms, node: config.name, role: config.role, tenant_id: ctx.tenant.id, user_hash: hashUser(ctx.tenant.id, ctx.endUser),
    endpoint: ctx.endpoint, route: ctx.route ?? null, model_id: ctx.modelId ?? null, priority: ctx.priority ?? "normal", priority_why: ctx.priorityWhy ?? null,
    trace: ctx.trace ?? ctx.traceId ?? null, status: row.status, error_type: row.error_type, stream: ctx.stream ? 1 : 0, cold: ctx.coldStart ? 1 : 0, fallbacks: ctx.fallbacks ?? 0,
    queue_ms: r1(ctx.queueMs), admit_ms: r1(a?.admitMs), load_ms: r1(a?.loadMs), slot_wait_ms: r1(a?.slotWaitMs),
    queue_reasons: a?.reasons.length ? JSON.stringify([...new Set(a.reasons)]) : null, concurrent: a ? a.concurrent : null, ahead: a ? a.ahead : null,
    prompt_tokens: row.prompt_tokens, cached_tokens: row.cached_tokens, prefill_ms: r1(ctx.prefillMs), reasoning_ms: r1(ctx.firstReasoningMs), ttft_ms: row.ttft_ms, gen_tokens: row.completion_tokens, tps: row.tps,
    total_ms: row.latency_ms, upstream_ms: r1(ctx.upstreamMs), ...base(ctx.competing), stages: ctx.stages ? JSON.stringify(ctx.stages) : null, realtime: null,
  });
}

/** A voice turn's own marks (the session's `metrics` event), on the node that ran it or the gateway that relayed it. */
export interface RealtimeMetrics {
  response_id?: string; turn?: number; engine?: string; hearing?: string; cold_start?: boolean; status?: string;
  speech_end_to_turn_ms?: number | null; speech_end_to_transcript_ms?: number | null; speech_end_to_first_token_ms?: number | null;
  speech_end_to_first_audio_ms?: number | null; first_token_to_first_audio_ms?: number | null;
}
export function recordRealtimeTurn(t: { tenant: string; user: string | null; session: string; llm: string | null; via: "node" | "gateway"; metrics: RealtimeMetrics }) {
  const m = t.metrics;
  const total = m.speech_end_to_first_audio_ms ?? null;
  const ts = Date.now();
  write({
    id: `${t.session}:${m.response_id ?? m.turn ?? ts}`, ts, started: ts - (total ?? 0), node: config.name, role: config.role, tenant_id: t.tenant, user_hash: hashUser(t.tenant, t.user),
    endpoint: "realtime.turn", route: "realtime", model_id: t.llm, priority: "interactive", priority_why: "voice", trace: t.session, status: m.status === "failed" ? 500 : 200,
    error_type: m.status && m.status !== "completed" ? m.status : null, stream: 1, cold: m.cold_start ? 1 : 0, fallbacks: 0,
    queue_ms: null, admit_ms: null, load_ms: null, slot_wait_ms: null, queue_reasons: null, concurrent: null, ahead: null,
    prompt_tokens: null, cached_tokens: null, prefill_ms: null, reasoning_ms: null, ttft_ms: m.speech_end_to_first_token_ms ?? null, gen_tokens: null, tps: null, total_ms: total, upstream_ms: null,
    ...base(null), stages: null, realtime: JSON.stringify({ via: t.via, ...m }),
  });
}

export function pruneTurns(days = settings().speedRetentionDays, at = Date.now()): number {
  return db.prepare("DELETE FROM turn_stats WHERE ts < ?").run(at - days * 86400_000).changes;
}
let pruner: NodeJS.Timeout | null = null;
export function startSpeed() {
  if (pruner) return;
  pruneTurns();
  pruner = setInterval(() => { try { pruneTurns(); } catch { /* next hour */ } }, 3600_000);
  pruner.unref();
}

/* ── Reading ───────────────────────────────────────────────────────────────────────────────────────────────── */

export const WINDOWS: Record<string, number> = { "15m": 15 * 60_000, hour: 3600_000, day: 86400_000, week: 7 * 86400_000 };

export function pct(xs: number[], p: number): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return Math.round(s[Math.min(s.length - 1, Math.max(0, Math.ceil(p * s.length) - 1))] * 10) / 10;
}
const dist = (xs: (number | null)[]) => { const v = xs.filter((x): x is number => typeof x === "number" && Number.isFinite(x)); return { p50: pct(v, 0.5), p90: pct(v, 0.9), p99: pct(v, 0.99), n: v.length }; };

export interface SpeedFilter { window?: string; tenant?: string; route?: string; model?: string; priority?: string; endpoint?: string; since?: number }
function where(f: SpeedFilter): { sql: string; args: (string | number)[]; since: number } {
  const since = f.since ?? Date.now() - (WINDOWS[f.window ?? "day"] ?? WINDOWS.day);
  const w = ["ts >= ?"], args: (string | number)[] = [since];
  for (const [col, v] of [["tenant_id", f.tenant], ["route", f.route], ["model_id", f.model], ["priority", f.priority], ["endpoint", f.endpoint]] as const) if (v) { w.push(`${col} = ?`); args.push(v); }
  return { sql: w.join(" AND "), args, since };
}

const decode = (r: TurnRow) => ({ ...r, queue_reasons: json<string[]>(r.queue_reasons as string, []), stages: json<Record<string, number> | null>(r.stages as string, null), realtime: json<Record<string, unknown> | null>(r.realtime as string, null) });

/** p50/p90/p99 of queue wait, TTFT, tokens/s and total, per tenant/route/model/class; the totals per class; a series; the slowest. */
export function speedSummary(f: SpeedFilter = {}) {
  const { sql, args, since } = where(f);
  const rows = db.prepare(`SELECT * FROM turn_stats WHERE ${sql} ORDER BY ts DESC LIMIT 200000`).all(...args) as TurnRow[];
  const stat = (rs: TurnRow[]) => ({
    n: rs.length, errors: rs.filter((r) => Number(r.status) >= 400).length, cold: rs.filter((r) => r.cold).length,
    queue: dist(rs.map((r) => r.queue_ms as number)), slotWait: dist(rs.map((r) => r.slot_wait_ms as number)), ttft: dist(rs.map((r) => r.ttft_ms as number)),
    reasoning: dist(rs.map((r) => r.reasoning_ms as number)), tps: dist(rs.map((r) => r.tps as number)), total: dist(rs.map((r) => r.total_ms as number)), prefill: dist(rs.map((r) => r.prefill_ms as number)),
    cacheShare: (() => { const p = rs.reduce((a, r) => a + Number(r.prompt_tokens ?? 0), 0); return p ? Math.round((rs.reduce((a, r) => a + Number(r.cached_tokens ?? 0), 0) / p) * 1000) / 1000 : null; })(),
  });
  const groups = new Map<string, TurnRow[]>();
  for (const r of rows) { const k = [r.tenant_id, r.route, r.model_id, r.priority, r.endpoint].join("\u0001"); groups.set(k, [...(groups.get(k) ?? []), r]); }
  const span = Date.now() - since, buckets = 48, bucketMs = Math.max(60_000, Math.ceil(span / buckets / 60_000) * 60_000);
  const series: Record<string, number | null>[] = [];
  for (let t = since - (since % bucketMs); t <= Date.now(); t += bucketMs) {
    const point: Record<string, number | null> = { ts: t };
    for (const p of PRIORITIES) {
      const rs = rows.filter((r) => r.priority === p && Number(r.ts) >= t && Number(r.ts) < t + bucketMs);
      point[`${p}_ttft_p50`] = pct(rs.map((r) => r.ttft_ms as number).filter((x) => x != null), 0.5);
      point[`${p}_ttft_p90`] = pct(rs.map((r) => r.ttft_ms as number).filter((x) => x != null), 0.9);
      point[`${p}_queue_p90`] = pct(rs.map((r) => r.queue_ms as number).filter((x) => x != null), 0.9);
      point[`${p}_n`] = rs.length;
    }
    series.push(point);
  }
  const slowest = [...rows].filter((r) => r.total_ms != null).sort((a, b) => Number(b.ttft_ms ?? b.total_ms) - Number(a.ttft_ms ?? a.total_ms)).slice(0, 25).map(decode);
  return {
    window: f.window ?? "day", since, node: config.name, role: config.role, bucketMs,
    priority: { enabled: settings().priorityEnabled, reserveSlots: settings().priorityReserveSlots, backgroundMaxWaitMs: settings().priorityBackgroundMaxWaitMs },
    totals: stat(rows),
    byPriority: Object.fromEntries(PRIORITIES.map((p) => [p, stat(rows.filter((r) => r.priority === p))])) as Record<Priority, ReturnType<typeof stat>>,
    groups: [...groups.entries()].map(([k, rs]) => { const [tenant, route, model, priority, endpoint] = k.split("\u0001"); return { tenant, route: route || null, model: model || null, priority, endpoint, ...stat(rs) }; }).sort((a, b) => b.n - a.n),
    series, slowest,
  };
}

export function speedTurns(f: SpeedFilter & { limit?: number; trace?: string; slow?: boolean } = {}) {
  const { sql, args } = where(f);
  const extra = f.trace ? " AND trace = ?" : "";
  const order = f.slow ? "COALESCE(ttft_ms, total_ms) DESC" : "ts DESC";
  return (db.prepare(`SELECT * FROM turn_stats WHERE ${sql}${extra} ORDER BY ${order} LIMIT ?`).all(...args, ...(f.trace ? [f.trace] : []), Math.min(Math.max(f.limit ?? 100, 1), 1000)) as TurnRow[]).map(decode);
}

/** One turn and what competed with it: other calls in flight (every tenant), CI jobs running, the machine's samples. */
export function speedTurn(id: string) {
  const t = db.prepare("SELECT * FROM turn_stats WHERE id = ?").get(id) as TurnRow | undefined;
  if (!t) return null;
  const start = Number(t.started), end = Number(t.ts);
  const others = db.prepare(`SELECT r.id, r.ts - r.latency_ms started, r.ts ended, r.tenant_id, r.endpoint, r.model_id, r.status, r.latency_ms, r.ttft_ms, r.agent, s.priority
    FROM requests r LEFT JOIN turn_stats s ON s.id = r.id WHERE r.ts > ? AND r.ts - r.latency_ms < ? AND r.id != ? ORDER BY started LIMIT 300`).all(start, end, id);
  let ci: unknown[] = [];
  try {
    ci = db.prepare(`SELECT id, repo, name, workflow, runner, started_at, completed_at, conclusion FROM build_jobs WHERE started_at IS NOT NULL AND started_at < ? AND (completed_at IS NULL OR completed_at > ?) ORDER BY started_at LIMIT 100`).all(end, start);
  } catch { /* no build server here (the gateway) */ }
  const samples = db.prepare("SELECT ts, cpu_pct, gpu_pct, mem_free_gb, pressure, loaded FROM system_samples WHERE ts BETWEEN ? AND ? ORDER BY ts").all(start - 90_000, end + 90_000);
  const sameTrace = t.trace ? speedTurns({ since: 0, trace: String(t.trace), limit: 200 }) : [];
  return { turn: decode(t), window: { start, end }, others, ci, samples, trace: sameTrace };
}

export function registerSpeed(api: FastifyInstance) {
  api.get("/speed", async (req) => speedSummary(req.query as SpeedFilter));
  api.get("/speed/turns", async (req) => {
    const q = req.query as SpeedFilter & { limit?: string; trace?: string; slow?: string };
    return speedTurns({ ...q, limit: Number(q.limit) || 100, slow: q.slow === "1" || q.slow === "true", ...(q.trace ? { since: 0 } : {}) });
  });
  api.get("/speed/turns/:id", async (req, reply) => speedTurn((req.params as { id: string }).id) ?? reply.code(404).send({ error: "no such turn" }));
  api.get("/speed/trace/:trace", async (req) => speedTurns({ since: 0, trace: (req.params as { trace: string }).trace, limit: 500 }));
  // Now: each model's slots by class and its queue, whether the models stayed hot, voice sessions, CI paused.
  api.get("/speed/live", async () => ({
    node: config.name, role: config.role, slots: gate.snapshot(), hot: hotness(), voice: voiceOpen(), keeper: keeperSeen(), competing: competing(),
    priority: { enabled: settings().priorityEnabled, reserveSlots: settings().priorityReserveSlots, backgroundMaxWaitMs: settings().priorityBackgroundMaxWaitMs, rules: settings().priorityRules },
  }));
}
