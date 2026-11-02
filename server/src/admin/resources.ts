import { db, now } from "../db.js";
import { getModel, listModels } from "../models.js";
import { getProvider, listProviders } from "../providers.js";
import { snapshot } from "../router/health.js";
import { status } from "../runtime/manager.js";
import { getTenant, listKeys } from "../tenants.js";
import { RANGES } from "./stats.js";

/**
 * Resource data behind the tenant, provider and model pages: what each model held and did every 30 s, how each node
 * answered every sync, and how close each tenant runs to its limits and budgets.
 */
const putModel = db.prepare("INSERT OR REPLACE INTO model_samples(ts, model_id, state, estimate_gb, rss_gb, inflight, processing, deferred, prompt_tps, gen_tps) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
const putProvider = db.prepare("INSERT OR REPLACE INTO provider_samples(ts, provider_id, status, latency_ms, mem_total_gb, mem_free_gb, swap_gb, pressure, used_gb, budget_gb, loaded) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");

export async function sampleModels() {
  const t = now();
  for (const i of await status().catch(() => [])) {
    const m = i.metrics ?? {};
    putModel.run(t, i.id, i.state, i.estimateGb, i.rssGb, i.inflight, m.requests_processing ?? null, m.requests_deferred ?? null, m.prompt_tokens_seconds ?? null, m.predicted_tokens_seconds ?? null);
  }
  // A node's instances, as the last sync saw them.
  for (const p of listProviders().filter((x) => x.kind === "mux" && x.status === "online")) {
    for (const i of p.info?.instances ?? []) putModel.run(t, `${p.id}/${i.id}`, i.state, i.estimateGb, i.rssGb, i.inflight, null, null, null, null);
  }
}

export function sampleProvider(id: string, ok: boolean, info: { latencyMs?: number; system?: { memTotalGb: number; memFreeGb: number; swapGb: number; pressure: number }; budget?: { usedGb: number; budgetGb: number }; instances?: { state: string }[] } | null) {
  putProvider.run(now(), id, ok ? "online" : "offline", info?.latencyMs ?? null, info?.system?.memTotalGb ?? null, info?.system?.memFreeGb ?? null, info?.system?.swapGb ?? null,
    info?.system?.pressure ?? null, info?.budget?.usedGb ?? null, info?.budget?.budgetGb ?? null, info?.instances?.filter((i) => i.state === "ready").length ?? null);
}

export function pruneSamples() {
  const cut = now() - 14 * 86400_000;
  db.prepare("DELETE FROM model_samples WHERE ts < ?").run(cut);
  db.prepare("DELETE FROM provider_samples WHERE ts < ?").run(cut);
}

const range = (r?: string) => RANGES[r ?? "24h"] ?? RANGES["24h"];
const pct = (xs: number[], p: number) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor((p / 100) * xs.length))] : null);
const r1 = (x: number | null | undefined, d = 1) => (x == null ? null : Math.round(x * 10 ** d) / 10 ** d);

/** Samples into the range's buckets: averages, with the peak of the fields named in `peaks`. */
function bucketed<T extends { ts: number }>(rows: T[], bucket: number, since: number, fields: (keyof T)[], peaks: (keyof T)[] = []) {
  const m = new Map<number, T[]>();
  for (let t = Math.floor(since / bucket) * bucket; t <= now(); t += bucket) m.set(t, []);
  for (const x of rows) m.get(Math.floor(x.ts / bucket) * bucket)?.push(x);
  return [...m].map(([t, xs]) => {
    const p: Record<string, number | null> = { t, samples: xs.length };
    for (const f of fields) { const v = xs.map((x) => x[f] as unknown as number).filter((v) => v != null); p[f as string] = v.length ? r1(v.reduce((a, b) => a + b, 0) / v.length, 2) : null; }
    for (const f of peaks) { const v = xs.map((x) => x[f] as unknown as number).filter((v) => v != null); p[`${String(f)}Max`] = v.length ? Math.max(...v) : null; }
    return p;
  });
}

const SAMPLE_MS = 30_000;

export function modelResources(id: string, rangeKey?: string) {
  const m = getModel(id);
  if (!m) return null;
  const r = range(rangeKey);
  const since = now() - r.ms;
  type S = { ts: number; state: string; estimate_gb: number; rss_gb: number | null; inflight: number; processing: number | null; deferred: number | null; prompt_tps: number | null; gen_tps: number | null; ready: number };
  const rows = (db.prepare("SELECT * FROM model_samples WHERE model_id = ? AND ts >= ? ORDER BY ts").all(id, since) as S[]).map((x) => ({ ...x, ready: x.state === "ready" ? 1 : 0 }));
  const readyMs = rows.filter((x) => x.ready).length * SAMPLE_MS;
  const usage = db.prepare(`SELECT COUNT(*) n, SUM(prompt_tokens) pin, SUM(completion_tokens) pout, SUM(CASE WHEN status >= 400 THEN 1 ELSE 0 END) errors, SUM(cold_start) cold, SUM(cost_usd) usd, COUNT(DISTINCT tenant_id) tenants
    FROM requests WHERE model_id = ? AND ts >= ?`).get(id, since) as { n: number; pin: number | null; pout: number | null; errors: number | null; cold: number | null; usd: number | null; tenants: number };
  // Its lifecycle, from the runtime's events: loads, how long they took, unloads and failures.
  const evs = db.prepare(`SELECT ts, level, message FROM events WHERE source IN ('runtime', 'healer') AND ts >= ? AND (message LIKE ? OR message LIKE ? OR message LIKE ?) ORDER BY ts DESC LIMIT 300`)
    .all(since, `${id} %`, `% ${id} %`, `% ${id}`) as { ts: number; level: string; message: string }[];
  const loadSecs = evs.map((e) => /ready in ([\d.]+) s/.exec(e.message)?.[1]).filter(Boolean).map(Number);
  const benches = db.prepare("SELECT ts, score, tps, prompt_tps, ttft_ms, load_ms, status FROM benchmarks WHERE model_id = ? ORDER BY ts DESC LIMIT 30").all(id);
  const gbHours = rows.reduce((a, x) => a + (x.ready ? x.estimate_gb : 0), 0) * SAMPLE_MS / 3600_000;
  const tokens = (usage.pin ?? 0) + (usage.pout ?? 0);
  return {
    id, range: rangeKey ?? "24h", bucketMs: r.bucket, provider: m.provider_id, backend: m.backend,
    series: bucketed(rows, r.bucket, since, ["ready", "estimate_gb", "rss_gb", "inflight", "processing", "deferred", "gen_tps", "prompt_tps"], ["inflight", "deferred"]),
    loadedShare: rows.length ? Math.min(1, readyMs / r.ms) : null, sampled: rows.length > 0,
    loadedHours: r1(readyMs / 3600_000, 2), gbHours: r1(gbHours, 1), tokensPerLoadedHour: readyMs ? Math.round(tokens / (readyMs / 3600_000)) : null,
    peakInflight: rows.length ? Math.max(...rows.map((x) => x.inflight ?? 0)) : null, peakDeferred: rows.length ? Math.max(...rows.map((x) => x.deferred ?? 0)) : null,
    loads: evs.filter((e) => e.message.startsWith("loading ")).length, unloads: evs.filter((e) => e.message.startsWith("unloaded ")).length,
    failures: evs.filter((e) => e.level !== "info").length, loadSecondsP50: r1(pct(loadSecs, 50)), loadSecondsMax: loadSecs.length ? Math.max(...loadSecs) : null,
    usage: { requests: usage.n, tokens, promptTokens: usage.pin ?? 0, completionTokens: usage.pout ?? 0, errors: usage.errors ?? 0, coldStarts: usage.cold ?? 0, costUsd: r1(usage.usd ?? 0, 4), tenants: usage.tenants },
    health: snapshot()[id] ?? null, events: evs.slice(0, 40), benchmarks: benches,
  };
}

export function providerResources(id: string, rangeKey?: string) {
  const p = getProvider(id);
  if (!p) return null;
  const r = range(rangeKey);
  const since = now() - r.ms;
  type S = { ts: number; status: string; latency_ms: number | null; mem_total_gb: number | null; mem_free_gb: number | null; swap_gb: number | null; pressure: number | null; used_gb: number | null; budget_gb: number | null; loaded: number | null; online: number };
  const rows = (db.prepare("SELECT * FROM provider_samples WHERE provider_id = ? AND ts >= ? ORDER BY ts").all(id, since) as S[]).map((x) => ({ ...x, online: x.status === "online" ? 1 : 0 }));
  const lat = rows.map((x) => x.latency_ms).filter((x): x is number => x != null);
  // Outages: runs of offline samples.
  const outages: { from: number; to: number }[] = [];
  for (const x of rows) {
    const last = outages[outages.length - 1];
    if (!x.online) { if (last && last.to === -1) continue; outages.push({ from: x.ts, to: -1 }); }
    else if (last && last.to === -1) last.to = x.ts;
  }
  const models = listModels().filter((m) => m.provider_id === id);
  const byModel = db.prepare(`SELECT model_id, COUNT(*) n, SUM(prompt_tokens) pin, SUM(completion_tokens) pout, SUM(CASE WHEN status >= 400 THEN 1 ELSE 0 END) errors, SUM(cost_usd) usd, AVG(tps) tps, AVG(latency_ms) lat
    FROM requests WHERE provider_id = ? AND ts >= ? GROUP BY model_id ORDER BY n DESC`).all(id, since);
  const daily = db.prepare(`SELECT (ts / 86400000) * 86400000 day, COUNT(*) n, SUM(cost_usd) usd, SUM(prompt_tokens + completion_tokens) tokens FROM requests WHERE provider_id = ? AND ts >= ? GROUP BY day ORDER BY day`).all(id, now() - 30 * 86400_000);
  const incidents = db.prepare("SELECT id, ts, kind, severity, status, title, resolved_at FROM incidents WHERE subject = ? OR subject LIKE ? ORDER BY ts DESC LIMIT 20").all(id, `${id}/%`);
  return {
    id, kind: p.kind, range: rangeKey ?? "24h", bucketMs: r.bucket, sampled: rows.length > 0,
    series: bucketed(rows, r.bucket, since, ["online", "latency_ms", "mem_free_gb", "mem_total_gb", "swap_gb", "pressure", "used_gb", "budget_gb", "loaded"], ["latency_ms", "pressure"]),
    uptime: rows.length ? rows.filter((x) => x.online).length / rows.length : null, latencyP50: pct(lat, 50), latencyP95: pct(lat, 95),
    outages: outages.slice(-20).map((o) => ({ ...o, to: o.to === -1 ? null : o.to })), models: models.length, byModel, daily, incidents,
  };
}

export function tenantResources(id: string, rangeKey?: string) {
  const t = getTenant(id);
  if (!t) return null;
  const r = range(rangeKey);
  const since = now() - r.ms;
  // Peaks per minute, to set limits by: what the tenant actually does at its busiest.
  const perMin = db.prepare(`SELECT ts / 60000 m, COUNT(*) n, SUM(prompt_tokens + completion_tokens) tokens FROM requests WHERE tenant_id = ? AND ts >= ? GROUP BY m`).all(id, since) as { m: number; n: number; tokens: number }[];
  const month = new Date(); month.setDate(1); month.setHours(0, 0, 0, 0);
  const days = new Date(month.getFullYear(), month.getMonth() + 1, 0).getDate();
  const elapsed = Math.max((now() - month.getTime()) / 86400_000, 1 / 24);
  const mtd = db.prepare("SELECT SUM(prompt_tokens + completion_tokens) tokens, SUM(cost_usd) usd, COUNT(*) n FROM requests WHERE tenant_id = ? AND ts >= ?").get(id, month.getTime()) as { tokens: number | null; usd: number | null; n: number };
  const daily = db.prepare(`SELECT (ts / 86400000) * 86400000 day, COUNT(*) n, SUM(prompt_tokens + completion_tokens) tokens, SUM(cost_usd) usd, SUM(CASE WHEN status >= 400 THEN 1 ELSE 0 END) errors
    FROM requests WHERE tenant_id = ? AND ts >= ? GROUP BY day ORDER BY day`).all(id, now() - 30 * 86400_000);
  const limited = db.prepare(`SELECT COALESCE(error_type, 'rate_limited') type, COUNT(*) n FROM requests WHERE tenant_id = ? AND ts >= ? AND status = 429 GROUP BY type`).all(id, since);
  const keyUse = db.prepare(`SELECT key_id, COUNT(*) n, SUM(prompt_tokens + completion_tokens) tokens, SUM(CASE WHEN status >= 400 THEN 1 ELSE 0 END) errors, MAX(ts) last FROM requests WHERE tenant_id = ? AND ts >= ? GROUP BY key_id`).all(id, since) as { key_id: string }[];
  const keys = listKeys(id).map((k) => ({ id: k.id, name: k.name, prefix: k.prefix, revoked: !!k.revoked_at, expires_at: k.expires_at, rpm_limit: k.rpm_limit, usage: keyUse.find((u) => u.key_id === k.id) ?? null }));
  const tokens = mtd.tokens ?? 0, usd = mtd.usd ?? 0;
  return {
    id, range: rangeKey ?? "24h",
    limits: {
      rpmPeak: perMin.length ? Math.max(...perMin.map((x) => x.n)) : 0, rpmLimit: t.rpm_limit,
      tpmPeak: perMin.length ? Math.max(...perMin.map((x) => x.tokens ?? 0)) : 0, tpmLimit: t.tpm_limit,
      activeMinutes: perMin.length, maxParallel: t.max_parallel,
    },
    month: {
      tokens, usd: r1(usd, 4), requests: mtd.n, tokenBudget: t.monthly_token_budget, usdBudget: t.monthly_usd_budget ?? 0,
      projectedTokens: Math.round((tokens / elapsed) * days), projectedUsd: r1((usd / elapsed) * days, 2), daysInMonth: days, dayOfMonth: Math.ceil(elapsed),
    },
    daily, rateLimited: limited, keys,
  };
}
