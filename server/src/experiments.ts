import { randomBytes } from "node:crypto";
import { unit } from "./router/affinity.js";
import type { FastifyInstance } from "fastify";
import { advise, ROUTE_CASES, usageOf } from "./advisor.js";
import { runBenchmark } from "./bench.js";
import { writePage } from "./brain.js";
import { config } from "./config.js";
import { startDownload } from "./hf.js";
import { db, event, json, now, saveSettings, settings } from "./db.js";
import { getModel, getRoute, listModels, listRoutes, upsertRoute, type Model } from "./models.js";
import { getProvider } from "./providers.js";
import { freePlan, quotaBlock } from "./quota.js";
import { estimateGb } from "./runtime/manager.js";
import { asActor, journal } from "./journal.js";

/**
 * Experiments: a change to a route tried on live traffic, A/B, with production always served. A share of the route's
 * requests (arm B) goes to the challenger first; the rest (arm A) to the champion — the model the route tried first when
 * the experiment began. Each arm keeps the other model behind it, so a failure in either arm is answered by the other,
 * and an arm's failure rate is how often its first choice did not answer.
 *
 * Every 30 s the guardrails are checked: a challenger that fails clearly more often than the champion, or is far
 * slower, stops the experiment at once and the route is as it was. When both arms have enough requests (or the time is
 * up), the experiment ends with a verdict: the challenger is promoted — first on the route — only when it was at least
 * as reliable, not much slower, and no worse on its benchmark. Every verdict, either way, goes into mux's brain.
 *
 * Experiments run on routes, never on embedding routes (another model's vectors would break the tenants' indexes), and
 * only when both models fit in memory together: an experiment never makes the champion unload.
 */
db.exec(`
CREATE TABLE IF NOT EXISTS experiments (
  id TEXT PRIMARY KEY, route TEXT NOT NULL, champion TEXT NOT NULL, challenger TEXT NOT NULL, share REAL NOT NULL,
  status TEXT NOT NULL, reason TEXT, min_requests INTEGER NOT NULL, max_hours REAL NOT NULL, auto_promote INTEGER NOT NULL,
  started_by TEXT, started_at INTEGER NOT NULL, ended_at INTEGER, verdict TEXT, stats TEXT
);
CREATE INDEX IF NOT EXISTS experiments_route ON experiments(route, status);
`);

export interface Experiment {
  id: string; route: string; champion: string; challenger: string; share: number; status: "running" | "promoted" | "kept" | "rolled_back" | "stopped";
  reason: string | null; min_requests: number; max_hours: number; auto_promote: boolean; started_by: string | null; started_at: number; ended_at: number | null;
  verdict: string | null; stats: Stats | null;
}
interface Row extends Omit<Experiment, "auto_promote" | "stats"> { auto_promote: number; stats: string | null }
const fromRow = (r: Row): Experiment => ({ ...r, auto_promote: !!r.auto_promote, stats: json<Stats | null>(r.stats, null) });

export const getExperiment = (id: string) => { const r = db.prepare("SELECT * FROM experiments WHERE id = ?").get(id) as Row | undefined; return r ? fromRow(r) : undefined; };
export const listExperiments = (limit = 50) => (db.prepare("SELECT * FROM experiments ORDER BY started_at DESC LIMIT ?").all(limit) as Row[]).map(fromRow);

let running = new Map<string, Experiment>();
const reload = () => { running = new Map((db.prepare("SELECT * FROM experiments WHERE status = 'running'").all() as Row[]).map((r) => [r.route, fromRow(r)])); };
reload();

/* ── The split, for the router ──────────────────────────────────────────────────────────────────────────────── */

/**
 * The route's candidates for one request, if an experiment runs on it: arm B tries the challenger first, arm A the
 * champion; the other model always stays behind. Null when no experiment runs here.
 */
export function split(route: string, ordered: Model[], affinity?: string | null): { candidates: Model[]; experiment: { id: string; arm: "A" | "B" } } | null {
  const ex = running.get(route);
  if (!ex) return null;
  const champ = ordered.find((m) => m.id === ex.champion);
  const chall = ordered.find((m) => m.id === ex.challenger);
  if (!champ || !chall) return null; // one of them cannot take this request (cooling down, too small a context…): no split
  const rest = ordered.filter((m) => m !== champ && m !== chall);
  // One run, one arm: the run's affinity key decides it (affinity.ts); a request without one is a coin toss.
  const arm = (affinity ? unit(affinity, ex.id) : Math.random()) < ex.share ? "B" : "A";
  return { candidates: arm === "B" ? [chall, champ, ...rest] : [champ, ...rest, chall], experiment: { id: ex.id, arm } };
}

/* ── Measuring the arms ─────────────────────────────────────────────────────────────────────────────────────── */

export interface Arm { requests: number; firstChoiceFailed: number; failRate: number; userErrors: number; p50: number | null; p95: number | null; ttft: number | null; tps: number | null; bench: number | null }
export interface Stats { A: Arm; B: Arm; at: number }

const pct = (xs: number[], p: number) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
const latestBench = (id: string) => (db.prepare("SELECT score FROM benchmarks WHERE model_id = ? AND status = 'done' ORDER BY ts DESC LIMIT 1").get(id) as { score: number } | undefined)?.score ?? null;

export function measure(ex: Experiment): Stats {
  const rows = db.prepare("SELECT arm, model_id, status, latency_ms, ttft_ms, tps FROM requests WHERE experiment_id = ?").all(ex.id) as { arm: string; model_id: string | null; status: number; latency_ms: number; ttft_ms: number | null; tps: number | null }[];
  const arm = (a: "A" | "B"): Arm => {
    const rs = rows.filter((r) => r.arm === a);
    const first = a === "A" ? ex.champion : ex.challenger;
    const answeredByFirst = rs.filter((r) => r.model_id === first && r.status < 400);
    const failed = rs.length - answeredByFirst.length;
    const lat = answeredByFirst.map((r) => r.latency_ms);
    const avg = (xs: (number | null)[]) => { const v = xs.filter((x): x is number => x != null); return v.length ? v.reduce((s, x) => s + x, 0) / v.length : null; };
    return { requests: rs.length, firstChoiceFailed: failed, failRate: rs.length ? failed / rs.length : 0, userErrors: rs.filter((r) => r.status >= 400).length,
      p50: pct(lat, 0.5), p95: pct(lat, 0.95), ttft: avg(answeredByFirst.map((r) => r.ttft_ms)), tps: avg(answeredByFirst.map((r) => r.tps)), bench: latestBench(first) };
  };
  return { A: arm("A"), B: arm("B"), at: now() };
}

/** Why to stop now, or null: the guardrails that keep production as good as it was. */
export function tripped(s: Stats): string | null {
  const { A, B } = s;
  if (B.requests >= 5 && B.failRate > Math.max(A.failRate + 0.05, 0.1)) return `the challenger failed ${(B.failRate * 100).toFixed(0)}% of its first tries against the champion's ${(A.failRate * 100).toFixed(0)}%`;
  if (B.requests >= 10 && B.userErrors / B.requests > A.userErrors / Math.max(A.requests, 1) + 0.03) return `arm B returned errors to callers ${(B.userErrors / B.requests * 100).toFixed(1)}% of the time`;
  if (B.requests >= 10 && A.p50 && B.p50 && B.p50 > A.p50 * 2) return `the challenger answered in ${Math.round(B.p50)} ms (median) against ${Math.round(A.p50)} ms: more than twice as slow`;
  return null;
}

/** The verdict once there is enough: promote only when at least as reliable, not much slower, and no worse benchmarked. */
export function verdict(s: Stats): { promote: boolean; why: string } {
  const { A, B } = s;
  const reliable = B.failRate <= A.failRate + 0.01;
  const fast = !A.p50 || !B.p50 || B.p50 <= A.p50 * 1.15;
  const benched = A.bench == null || B.bench == null || B.bench >= A.bench - 0.05;
  const facts = `first-try failures ${(B.failRate * 100).toFixed(1)}% vs ${(A.failRate * 100).toFixed(1)}%, median ${B.p50 ? Math.round(B.p50) : "?"} vs ${A.p50 ? Math.round(A.p50) : "?"} ms${A.bench != null && B.bench != null ? `, benchmark ${(B.bench * 100).toFixed(0)}% vs ${(A.bench * 100).toFixed(0)}%` : ""} (challenger vs champion, ${B.requests} vs ${A.requests} requests)`;
  if (reliable && fast && benched) return { promote: true, why: `the challenger held up: ${facts}` };
  return { promote: false, why: `the champion stays: ${[!reliable && "the challenger failed more", !fast && "it was slower", !benched && "it benchmarked worse"].filter(Boolean).join(", ")} — ${facts}` };
}

/* ── Starting, ending ───────────────────────────────────────────────────────────────────────────────────────── */

/** Memory both models would need together on one machine; null when they do not share one (a node and a cloud). */
function fitsTogether(a: Model, b: Model): string | null {
  const local = (m: Model) => ["llamacpp", "mlx", "laya"].includes(m.backend);
  if (local(a) && local(b)) {
    const need = estimateGb(a) + estimateGb(b), budget = settings().memoryBudgetGb;
    return need > budget ? `${a.id} and ${b.id} need ~${need.toFixed(1)} GB together, over mux's ${budget} GB memory budget: the experiment would make the champion unload between requests. Raise the budget (Settings) to at least ${Math.ceil(need)} GB, or run the challenger on another node.` : null;
  }
  if (a.backend === "node" && b.backend === "node" && a.provider_id === b.provider_id) {
    const p = getProvider(a.provider_id!);
    const budget = p?.info?.budget?.budgetGb ?? 0;
    const gb = (m: Model) => (m.size_bytes ? (m.size_bytes / 1024 ** 3) * 1.1 + 2 : 0);
    const need = gb(a) + gb(b);
    return budget && need > budget ? `${a.id} and ${b.id} need ~${need.toFixed(0)} GB together on ${p!.name}, over its ${budget} GB budget.` : null;
  }
  return null;
}

export function startExperiment(o: { route: string; challenger: string; share?: number; minRequests?: number; maxHours?: number; autoPromote?: boolean; by?: string }): Experiment {
  const r = getRoute(o.route);
  if (!r) throw new Error(`no route ${o.route}`);
  if (r.kind === "embedding") throw new Error(`${o.route} is an embedding route: another model's vectors would not match the tenants' stored ones, so it cannot be split`);
  if (running.has(r.name)) throw new Error(`an experiment already runs on ${r.name}`);
  if (running.size >= 3) throw new Error("three experiments already run; stop one first");
  const champion = r.candidates[0];
  if (!champion) throw new Error(`${r.name} has no candidates to compare against`);
  const ch = getModel(o.challenger);
  if (!ch || !ch.enabled) throw new Error(`no enabled model ${o.challenger}`);
  if (ch.kind !== r.kind) throw new Error(`${ch.id} is a ${ch.kind} model; ${r.name} routes ${r.kind}`);
  if (ch.id === champion) throw new Error(`${ch.id} is already first on ${r.name}`);
  const memory = fitsTogether(getModel(champion)!, ch);
  if (memory) throw new Error(memory);
  // The challenger must be on the route for the router to consider it; it goes last, so nothing changes outside arm B.
  if (!r.candidates.includes(ch.id)) upsertRoute({ ...r, candidates: [...r.candidates, ch.id] });
  const ex: Experiment = {
    id: `exp_${randomBytes(5).toString("hex")}`, route: r.name, champion, challenger: ch.id, share: Math.min(Math.max(o.share ?? 0.1, 0.01), 0.5),
    status: "running", reason: null, min_requests: Math.max(o.minRequests ?? 50, 10), max_hours: Math.min(Math.max(o.maxHours ?? 72, 1), 24 * 14),
    auto_promote: o.autoPromote ?? true, started_by: o.by ?? "owner", started_at: now(), ended_at: null, verdict: null, stats: null,
  };
  db.prepare("INSERT INTO experiments(id, route, champion, challenger, share, status, min_requests, max_hours, auto_promote, started_by, started_at) VALUES(?, ?, ?, ?, ?, 'running', ?, ?, ?, ?, ?)")
    .run(ex.id, ex.route, ex.champion, ex.challenger, ex.share, ex.min_requests, ex.max_hours, ex.auto_promote ? 1 : 0, ex.started_by, ex.started_at);
  reload();
  journal({ kind: "experiment", ref: ex.id, who: ex.started_by === "autopilot" ? "autopilot" : undefined, title: `Started an A/B test on ${ex.route}: ${ex.challenger} vs ${ex.champion}`, detail: `${Math.round(ex.share * 100)}% of ${ex.route}'s requests to ${ex.challenger}; each arm keeps the other model behind it.` });
  event("info", "experiments", `started ${ex.id} on ${ex.route}: ${ex.challenger} gets ${Math.round(ex.share * 100)}% against ${ex.champion}`);
  return ex;
}

async function end(ex: Experiment, status: Experiment["status"], why: string, stats: Stats) { return asActor("experiments", () => endAs(ex, status, why, stats)); }
async function endAs(ex: Experiment, status: Experiment["status"], why: string, stats: Stats) {
  journal({ kind: "experiment", ref: ex.id, title: `A/B test on ${ex.route}: ${status.replace("_", " ")} (${ex.challenger} vs ${ex.champion})`, detail: why });
  db.prepare("UPDATE experiments SET status = ?, reason = ?, verdict = ?, stats = ?, ended_at = ? WHERE id = ?").run(status, why, why, JSON.stringify(stats), now(), ex.id);
  reload();
  const r = getRoute(ex.route);
  if (status === "promoted" && r) upsertRoute({ ...r, candidates: [ex.challenger, ...r.candidates.filter((c) => c !== ex.challenger)] });
  event(status === "rolled_back" ? "warn" : "info", "experiments", `${ex.id} on ${ex.route}: ${status.replace("_", " ")} — ${why}`, { experiment: ex.id });
  // Every verdict is something mux learned: into its brain, so the next experiment starts from it.
  await writePage({
    title: `Experiment on ${ex.route}: ${ex.challenger} vs ${ex.champion}`, kind: "decision", subject: ex.route, tags: ["experiment", status], source: "experiments",
    body: `${new Date(ex.started_at).toISOString().slice(0, 10)} → ${new Date().toISOString().slice(0, 10)}, ${Math.round(ex.share * 100)}% of ${ex.route}'s requests to ${ex.challenger}.\n\n**Outcome: ${status.replace("_", " ")}.** ${why}.\n\n| | ${ex.champion} (A) | ${ex.challenger} (B) |\n|---|---|---|\n| requests | ${stats.A.requests} | ${stats.B.requests} |\n| first-try failures | ${(stats.A.failRate * 100).toFixed(1)}% | ${(stats.B.failRate * 100).toFixed(1)}% |\n| median latency | ${stats.A.p50 ? Math.round(stats.A.p50) : "—"} ms | ${stats.B.p50 ? Math.round(stats.B.p50) : "—"} ms |\n| tokens/s | ${stats.A.tps?.toFixed(0) ?? "—"} | ${stats.B.tps?.toFixed(0) ?? "—"} |`,
  }).catch((e) => event("warn", "experiments", `could not write the verdict to the brain: ${(e as Error).message}`));
}

export async function stopExperiment(id: string, why = "stopped by the owner") {
  const ex = getExperiment(id);
  if (!ex || ex.status !== "running") throw new Error("no running experiment with that id");
  await end(ex, "stopped", why, measure(ex));
}

/** Every 30 s: guardrails first; then, with enough requests or out of time, the verdict. */
export async function tickExperiments() {
  for (const ex of [...running.values()]) {
    const s = measure(ex);
    db.prepare("UPDATE experiments SET stats = ? WHERE id = ?").run(JSON.stringify(s), ex.id);
    const bad = tripped(s);
    if (bad) { await end(ex, "rolled_back", bad, s); continue; }
    const enough = s.B.requests >= ex.min_requests && s.A.requests >= ex.min_requests;
    const late = now() - ex.started_at > ex.max_hours * 3600_000;
    if (!enough && !late) continue;
    if (!enough) { await end(ex, "kept", `out of time with too few requests to judge (${s.B.requests} on the challenger)`, s); continue; }
    const v = verdict(s);
    await end(ex, v.promote ? (ex.auto_promote ? "promoted" : "kept") : "kept", v.promote && !ex.auto_promote ? `${v.why}; promote it on Routes (auto-promotion was off)` : v.why, s);
  }
}

/* ── The autopilot: mux choosing what to try ────────────────────────────────────────────────────────────────── */

export interface Pilot { at: number; actions: string[]; blocked: string[] }
// The last run, kept across restarts (the Agents page shows it)
db.exec("CREATE TABLE IF NOT EXISTS autopilot_runs (ts INTEGER PRIMARY KEY, actions TEXT NOT NULL, blocked TEXT NOT NULL)");
let pilot: Pilot = (() => {
  const r = db.prepare("SELECT * FROM autopilot_runs ORDER BY ts DESC LIMIT 1").get() as { ts: number; actions: string; blocked: string } | undefined;
  return r ? { at: r.ts, actions: json<string[]>(r.actions, []), blocked: json<string[]>(r.blocked, []) } : { at: 0, actions: [], blocked: [] };
})();
export const lastPilot = () => pilot;

/** The same pair was judged in the last week: let it be. */
const recentlyJudged = (route: string, challenger: string) =>
  !!db.prepare("SELECT 1 FROM experiments WHERE route = ? AND challenger = ? AND status != 'running' AND ended_at > ?").get(route, challenger, now() - 7 * 86400_000);
const benchRunning = () => !!db.prepare("SELECT 1 FROM benchmarks WHERE status = 'running' AND ts > ?").get(now() - 3600_000);
const downloading = () => !!db.prepare("SELECT 1 FROM downloads WHERE status IN ('queued', 'running')").get();

/**
 * Once an hour, with autoExperiments on: mux decides what to try, as its owner asked — it never waits to be told.
 *   1. Reliability: a route whose first model fails 10%+ of its requests gets an experiment with the most reliable
 *      model of the same kind (half the traffic: the champion stays behind it in both arms).
 *   2. Better models it has: one the advisor ranks clearly above a route's champion is benchmarked if it never was,
 *      then tried on 10% of the route.
 *   3. Better models it has not: downloaded when it fits the disk and fits in memory beside the champion (on a node, not
 *      on a gateway); the next hours benchmark it and try it.
 * What it cannot do — most often, two models that do not fit in memory together — it records, with what would allow it.
 */
export async function autopilot(): Promise<Pilot> { return asActor("autopilot", autopilotAs); }
async function autopilotAs(): Promise<Pilot> {
  const out: Pilot = { at: now(), actions: [], blocked: [] };
  if (!settings().autoExperiments) { pilot = out; return out; }
  const tryStart = (route: string, challenger: string, share: number, why: string) => {
    if (running.has(route) || recentlyJudged(route, challenger) || running.size >= 3) return;
    try { startExperiment({ route, challenger, share, by: "autopilot" }); out.actions.push(`started an experiment on ${route}: ${challenger} (${Math.round(share * 100)}%) — ${why}`); }
    catch (e) { out.blocked.push(`${route}: ${challenger} — ${(e as Error).message}`); }
  };

  // 1. Reliability.
  for (const r of listRoutes().filter((x) => x.kind !== "embedding" && x.candidates.length)) {
    const u = usageOf([r.candidates[0]], 7);
    if (!u || u.requests < 10 || u.errorRate < 0.1) continue;
    const kind = getModel(r.candidates[0])?.kind;
    const fam = (id: string) => id.split("/").pop()!.split(/[-_.]/)[0].toLowerCase();
    const alt = listModels().filter((m) => m.enabled && m.kind === kind && m.id !== r.candidates[0])
      .map((m) => ({ m, u: usageOf([m.id], 30) })).filter((x) => x.u && x.u.requests >= 10 && x.u.errorRate < u.errorRate / 2)
      .sort((a, b) => (a.u!.errorRate - (fam(a.m.id) === fam(r.candidates[0]) ? 0.05 : 0)) - (b.u!.errorRate - (fam(b.m.id) === fam(r.candidates[0]) ? 0.05 : 0)))[0];
    if (alt) tryStart(r.name, alt.m.id, 0.5, `${r.candidates[0]} failed ${(u.errorRate * 100).toFixed(0)}% of ${u.requests} requests this week; ${alt.m.id} ${(alt.u!.errorRate * 100).toFixed(1)}%`);
  }

  // 2 and 3. Better models, per route, judged by the job the route does.
  for (const r of listRoutes()) {
    const judge = ROUTE_CASES[r.name];
    if (!judge || r.kind === "embedding" || !r.candidates.length || running.has(r.name)) continue;
    const champ = getModel(r.candidates[0]);
    if (!champ) continue;
    const ranked = (await advise(...judge)).ranked;
    const champAdvice = ranked.find((a) => a.modelId === champ.id || a.id === champ.catalog_id);
    const base = champAdvice?.score ?? 0;
    const have = ranked.find((a) => a.installed && a.modelId && a.modelId !== champ.id && getModel(a.modelId)?.enabled && a.fit !== "too-big" && a.score >= base + 0.3 && !recentlyJudged(r.name, a.modelId));
    if (have) {
      const m = getModel(have.modelId!)!;
      const mem = fitsTogether(champ, m);
      if (mem) out.blocked.push(`${r.name}: ${m.id} — ${mem}`);
      else if (!have.measured) { if (!benchRunning()) { void runBenchmark(m.id).catch(() => undefined); out.actions.push(`benchmarking ${m.id}: it ranks ${have.score.toFixed(1)} for ${r.name} against ${base.toFixed(1)}, unmeasured`); } }
      else tryStart(r.name, m.id, 0.1, `it ranks ${have.score.toFixed(1)} for ${r.name}, measured, against ${champ.id}'s ${base.toFixed(1)}`);
      continue;
    }
    if (config.role === "gateway") continue; // a gateway downloads nothing: its models are its nodes'
    const fresh = ranked.find((a) => !a.installed && a.fit === "fits" && a.diskOk && !a.experimental && a.score >= base + 0.7);
    if (!fresh) continue;
    const together = fresh.needGb + estimateGb(champ);
    if (together > settings().memoryBudgetGb) {
      // It cannot run beside the champion here — but a free tier may have it: test it there first, so the case for
      // more memory rests on a measurement, not an estimate.
      const inCloud = listModels().find((m) => m.catalog_id === fresh.id && m.enabled && freePlan(m) && !quotaBlock(m));
      const tested = inCloud && db.prepare("SELECT 1 FROM benchmarks WHERE model_id = ? AND ts > ? AND status IN ('done', 'running')").get(inCloud.id, now() - 14 * 86400_000);
      if (inCloud && !tested && !benchRunning()) { void runBenchmark(inCloud.id).catch(() => undefined); out.actions.push(`testing ${fresh.name} in the cloud on ${inCloud.provider_id} (free tier) — it cannot run beside ${champ.id} here yet`); }
      out.blocked.push(`${r.name}: ${fresh.name} would rank ${fresh.score.toFixed(1)} against ${champ.id}'s ${base.toFixed(1)}, but the two need ~${together.toFixed(0)} GB together, over the ${settings().memoryBudgetGb} GB memory budget — raise it to ${Math.ceil(together)} GB to let mux try it`); continue; }
    if (downloading()) continue;
    try { await startDownload({ catalogId: fresh.id }); out.actions.push(`downloading ${fresh.name} (${fresh.sizeGb.toFixed(1)} GB) to try on ${r.name}: it would rank ${fresh.score.toFixed(1)} against ${base.toFixed(1)}`); }
    catch (e) { out.blocked.push(`${r.name}: download ${fresh.name} — ${(e as Error).message}`); }
  }
  for (const a of out.actions) event("info", "experiments", `autopilot: ${a}`);
  pilot = out;
  db.prepare("INSERT OR REPLACE INTO autopilot_runs(ts, actions, blocked) VALUES(?, ?, ?)").run(out.at, JSON.stringify(out.actions), JSON.stringify(out.blocked));
  db.prepare("DELETE FROM autopilot_runs WHERE ts < ?").run(now() - 30 * 86400_000);
  return out;
}

export function startExperiments() {
  setInterval(() => void tickExperiments().catch((e) => event("warn", "experiments", (e as Error).message)), 30_000).unref();
  setTimeout(() => void autopilot().catch((e) => event("warn", "experiments", `autopilot: ${(e as Error).message}`)), 3 * 60_000).unref();
  setInterval(() => void autopilot().catch((e) => event("warn", "experiments", `autopilot: ${(e as Error).message}`)), 3600_000).unref();
}

/* ── Admin API ──────────────────────────────────────────────────────────────────────────────────────────────── */

export function registerExperiments(api: FastifyInstance) {
  api.get("/experiments", async () => listExperiments().map((e) => (e.status === "running" ? { ...e, stats: measure(e) } : e)));
  api.get("/experiments/:id", async (req, reply) => { const e = getExperiment((req.params as { id: string }).id); return e ? (e.status === "running" ? { ...e, stats: measure(e) } : e) : reply.code(404).send({ error: "no such experiment" }); });
  api.post("/experiments", async (req, reply) => {
    try { return startExperiment({ ...(req.body as Parameters<typeof startExperiment>[0]), by: (req.body as { by?: string })?.by ?? "owner" }); }
    catch (e) { return reply.code(400).send({ error: (e as Error).message }); }
  });
  api.post("/experiments/:id/stop", async (req, reply) => {
    try { await stopExperiment((req.params as { id: string }).id); return getExperiment((req.params as { id: string }).id); } catch (e) { return reply.code(400).send({ error: (e as Error).message }); }
  });
  api.get("/experiments/autopilot", async () => ({ on: settings().autoExperiments, ...lastPilot() }));
  api.post("/experiments/autopilot/run", async () => autopilot());
  // Whether mux starts experiments itself from what the advisor finds (installed, measured challengers; 10% share).
  api.put("/experiments/auto", async (req) => { saveSettings({ autoExperiments: !!(req.body as { on?: boolean })?.on }); return { autoExperiments: settings().autoExperiments }; });
}

export const routesWithExperiments = () => listRoutes().filter((r) => running.has(r.name)).map((r) => r.name);
