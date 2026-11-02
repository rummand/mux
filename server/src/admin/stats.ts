import { db, now } from "../db.js";

/** The numbers behind the dashboard, for a time range and optionally one tenant, model or agent. */
export const RANGES: Record<string, { ms: number; bucket: number }> = {
  "15m": { ms: 15 * 60_000, bucket: 30_000 },
  "1h": { ms: 3600_000, bucket: 60_000 },
  "6h": { ms: 6 * 3600_000, bucket: 5 * 60_000 },
  "24h": { ms: 24 * 3600_000, bucket: 15 * 60_000 },
  "7d": { ms: 7 * 86400_000, bucket: 2 * 3600_000 },
  "30d": { ms: 30 * 86400_000, bucket: 12 * 3600_000 },
};

interface R { ts: number; tenant_id: string; model_id: string | null; route: string | null; endpoint: string; status: number; error_type: string | null; latency_ms: number; ttft_ms: number | null; tps: number | null; prompt_tokens: number; completion_tokens: number; cached_tokens: number; overhead_ms: number | null; cold_start: number; fallbacks: number; agent: string | null; end_user: string | null; stream: number; tools: number; provider_id: string | null; cost_usd: number; queue_ms: number | null; key_id: string | null; finish_reason: string | null }

const pct = (xs: number[], p: number) => {
  if (!xs.length) return null;
  const s = Float64Array.from(xs).sort();
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
};
const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const round = (x: number | null, d = 0) => (x === null ? null : Math.round(x * 10 ** d) / 10 ** d);

function summarise(rows: R[]) {
  const ok = rows.filter((r) => r.status < 400);
  const lat = ok.map((r) => r.latency_ms);
  const ttft = ok.map((r) => r.ttft_ms).filter((x): x is number => x != null);
  const tps = ok.map((r) => r.tps).filter((x): x is number => x != null && x > 0);
  const over = rows.map((r) => r.overhead_ms).filter((x): x is number => x != null);
  const queue = rows.map((r) => r.queue_ms ?? 0);
  const prompt = rows.reduce((a, r) => a + r.prompt_tokens, 0);
  const cached = rows.reduce((a, r) => a + r.cached_tokens, 0);
  return {
    requests: rows.length, errors: rows.length - ok.length, errorRate: rows.length ? (rows.length - ok.length) / rows.length : 0,
    promptTokens: rows.reduce((a, r) => a + r.prompt_tokens, 0), completionTokens: rows.reduce((a, r) => a + r.completion_tokens, 0),
    cachedTokens: rows.reduce((a, r) => a + r.cached_tokens, 0), costUsd: Math.round(rows.reduce((a, r) => a + (r.cost_usd ?? 0), 0) * 10000) / 10000,
    latencyP50: round(pct(lat, 50)), latencyP95: round(pct(lat, 95)), latencyP99: round(pct(lat, 99)), latencyAvg: round(avg(lat)),
    ttftP50: round(pct(ttft, 50)), ttftP95: round(pct(ttft, 95)), tpsAvg: round(avg(tps), 1), tpsP50: round(pct(tps, 50), 1),
    overheadP50: round(pct(over, 50), 2), overheadP99: round(pct(over, 99), 2),
    coldStarts: rows.filter((r) => r.cold_start).length, fallbacks: rows.filter((r) => r.fallbacks > 0).length,
    queueP50: round(pct(queue, 50)), queueP95: round(pct(queue, 95)), cacheHitRate: prompt ? cached / prompt : 0,
    tokensPerRequest: rows.length ? Math.round((prompt + rows.reduce((a, r) => a + r.completion_tokens, 0)) / rows.length) : 0,
    rateLimited: rows.filter((r) => r.status === 429).length,
    streamShare: rows.length ? rows.filter((r) => r.stream).length / rows.length : 0, toolShare: rows.length ? rows.filter((r) => r.tools).length / rows.length : 0,
  };
}

function groupBy(rows: R[], key: (r: R) => string | null) {
  const m = new Map<string, R[]>();
  for (const r of rows) {
    const k = key(r) ?? "—";
    const list = m.get(k);
    if (list) list.push(r); else m.set(k, [r]);
  }
  return [...m].map(([k, rs]) => ({ key: k, ...summarise(rs) })).sort((a, b) => b.requests - a.requests);
}

/** The most requests in flight at once in [from, to): a request ran from ts − latency to ts. */
function peakConcurrency(rows: R[], from: number, to: number) {
  const ev: [number, number][] = [];
  for (const r of rows) { const a = r.ts - r.latency_ms; if (r.ts >= from && a < to) { ev.push([Math.max(a, from), 1], [Math.min(r.ts, to), -1]); } }
  ev.sort((x, y) => x[0] - y[0] || x[1] - y[1]);
  let cur = 0, peak = 0;
  for (const [, d] of ev) { cur += d; if (cur > peak) peak = cur; }
  return peak;
}

export function overview(range = "24h", f: { tenant?: string; model?: string; agent?: string; provider?: string; route?: string; tz?: string } = {}) {
  const r = RANGES[range] ?? RANGES["24h"];
  const since = now() - r.ms;
  const where = ["ts >= ?"]; const args: unknown[] = [since];
  if (f.tenant) { where.push("tenant_id = ?"); args.push(f.tenant); }
  if (f.model) { where.push("model_id = ?"); args.push(f.model); }
  if (f.agent) { where.push("agent = ?"); args.push(f.agent); }
  if (f.provider) { if (f.provider === "local") where.push("provider_id IS NULL"); else { where.push("provider_id = ?"); args.push(f.provider); } }
  if (f.route) { where.push("route = ?"); args.push(f.route); }
  const rows = db.prepare(`SELECT ts, tenant_id, model_id, route, endpoint, status, error_type, latency_ms, ttft_ms, tps, prompt_tokens, completion_tokens, cached_tokens, overhead_ms, cold_start, fallbacks, agent, end_user, stream, tools, queue_ms, key_id, finish_reason, provider_id, cost_usd
    FROM requests WHERE ${where.join(" AND ")} ORDER BY ts LIMIT 500000`).all(...args) as R[];

  const buckets = new Map<number, R[]>();
  for (let t = Math.floor(since / r.bucket) * r.bucket; t <= now(); t += r.bucket) buckets.set(t, []);
  for (const row of rows) buckets.get(Math.floor(row.ts / r.bucket) * r.bucket)?.push(row);
  const tenants = [...new Set(rows.map((x) => x.tenant_id))];
  const models = [...new Set(rows.map((x) => x.model_id ?? "—"))];
  const series = [...buckets].map(([t, rs]) => {
    const s = summarise(rs);
    const point: Record<string, number | null> = {
      t, requests: s.requests, errors: s.errors, promptTokens: s.promptTokens, completionTokens: s.completionTokens,
      latencyP50: s.latencyP50, latencyP95: s.latencyP95, ttftP50: s.ttftP50, tps: s.tpsAvg, overheadP99: s.overheadP99,
      rpm: s.requests / (r.bucket / 60_000), costUsd: s.costUsd, cachedTokens: s.cachedTokens, coldStarts: s.coldStarts, fallbacks: s.fallbacks,
      errorRate: s.requests ? s.errors / s.requests : null, queueP95: s.queueP95, concurrency: peakConcurrency(rows, t, t + r.bucket),
      tpm: (s.promptTokens + s.completionTokens) / (r.bucket / 60_000),
    };
    for (const tn of tenants) point[`tenant:${tn}`] = rs.filter((x) => x.tenant_id === tn).length;
    for (const m of models) point[`model:${m}`] = rs.filter((x) => (x.model_id ?? "—") === m).length;
    return point;
  });
  const latencyHistogram = [100, 250, 500, 1000, 2000, 5000, 10000, 30000, 60000, Infinity].map((edge, i, edges) => {
    const lo = i ? edges[i - 1] : 0;
    return { bucket: edge === Infinity ? `>${lo / 1000}s` : edge < 1000 ? `<${edge}ms` : `<${edge / 1000}s`, count: rows.filter((x) => x.status < 400 && x.latency_ms >= lo && x.latency_ms < edge).length };
  });
  // When the traffic comes: weekday × hour in the viewer's time zone (tz = minutes east of UTC).
  const tz = Number(f.tz) || 0;
  const heatmap = Array.from({ length: 7 }, () => Array(24).fill(0) as number[]);
  for (const x of rows) { const d = new Date(x.ts + tz * 60_000); heatmap[(d.getUTCDay() + 6) % 7][d.getUTCHours()]++; }
  const tokenHistogram = [256, 1024, 4096, 16384, 32768, 65536, 131072, Infinity].map((edge, i, edges) => {
    const lo = i ? edges[i - 1] : 0;
    const k = (n: number) => (n >= 1024 ? `${n / 1024}k` : `${n}`);
    return { bucket: edge === Infinity ? `>${k(lo)}` : `<${k(edge)}`, count: rows.filter((x) => x.prompt_tokens >= lo && x.prompt_tokens < edge).length };
  });
  const keyNames = new Map((db.prepare("SELECT id, name, prefix FROM api_keys").all() as { id: string; name: string; prefix: string }[]).map((k) => [k.id, `${k.name} (${k.prefix})`]));
  const peak = peakConcurrency(rows, since, now() + 1);
  return {
    range, bucketMs: r.bucket, since, totals: { ...summarise(rows), peakConcurrency: peak }, heatmap, tokenHistogram,
    byKey: groupBy(rows, (x) => (x.key_id ? keyNames.get(x.key_id) ?? x.key_id : null)), byFinish: groupBy(rows, (x) => x.finish_reason ?? (x.status >= 400 ? "error" : null)),
    byStatus: groupBy(rows, (x) => String(x.status)), series, latencyHistogram, tenants, models,
    byTenant: groupBy(rows, (x) => x.tenant_id), byProvider: groupBy(rows, (x) => x.provider_id ?? "local"), byModel: groupBy(rows, (x) => x.model_id), byRoute: groupBy(rows, (x) => x.route),
    byEndpoint: groupBy(rows, (x) => x.endpoint), byAgent: groupBy(rows, (x) => x.agent).slice(0, 20), byUser: groupBy(rows, (x) => x.end_user).slice(0, 20),
    byError: groupBy(rows.filter((x) => x.status >= 400), (x) => `${x.status} ${x.error_type ?? ""}`.trim()),
  };
}

export function requestLog(q: { tenant?: string; model?: string; status?: string; agent?: string; trace?: string; q?: string; before?: number; limit?: number }) {
  const where: string[] = []; const args: unknown[] = [];
  if (q.tenant) { where.push("tenant_id = ?"); args.push(q.tenant); }
  if (q.model) { where.push("model_id = ?"); args.push(q.model); }
  if (q.agent) { where.push("agent = ?"); args.push(q.agent); }
  if (q.trace) { where.push("trace_id = ?"); args.push(q.trace); }
  if (q.status === "error") where.push("status >= 400");
  else if (q.status === "ok") where.push("status < 400");
  if (q.q) { where.push("(id LIKE ? OR error LIKE ? OR route_reason LIKE ? OR requested_model LIKE ?)"); args.push(...Array(4).fill(`%${q.q}%`)); }
  if (q.before) { where.push("ts < ?"); args.push(q.before); }
  return db.prepare(`SELECT id, ts, tenant_id, key_id, endpoint, requested_model, route, model_id, stream, tools, forced_tool, status, error_type, error, prompt_tokens, completion_tokens, cached_tokens,
    latency_ms, ttft_ms, queue_ms, tps, overhead_ms, cold_start, fallbacks, finish_reason, agent, trace_id, end_user, tags FROM requests ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY ts DESC LIMIT ?`).all(...args, Math.min(q.limit ?? 100, 500));
}

export const requestDetail = (id: string) => db.prepare("SELECT * FROM requests WHERE id = ?").get(id);

export function traces(range = "24h", tenant?: string) {
  const since = now() - (RANGES[range] ?? RANGES["24h"]).ms;
  return db.prepare(`SELECT trace_id, tenant_id, MAX(agent) agent, COUNT(*) calls, MIN(ts) started, MAX(ts) ended, SUM(prompt_tokens) prompt_tokens, SUM(completion_tokens) completion_tokens,
      SUM(CASE WHEN status >= 400 THEN 1 ELSE 0 END) errors, SUM(tools) tool_calls, GROUP_CONCAT(DISTINCT model_id) models, SUM(latency_ms) total_ms
    FROM requests WHERE trace_id IS NOT NULL AND ts >= ? ${tenant ? "AND tenant_id = ?" : ""} GROUP BY trace_id ORDER BY started DESC LIMIT 200`).all(...(tenant ? [since, tenant] : [since]));
}

export function systemSeries(range = "6h") {
  const since = now() - (RANGES[range] ?? RANGES["6h"]).ms;
  return db.prepare("SELECT * FROM system_samples WHERE ts >= ? ORDER BY ts").all(since);
}
