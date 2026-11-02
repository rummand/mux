import type { FastifyInstance } from "fastify";
import { config } from "./config.js";
import { db, now } from "./db.js";
import { RANGES } from "./admin/stats.js";
import type { Ctx } from "./router/metering.js";
import { runRead, runSearch, type EngineReport } from "./router/web.js";

/**
 * mux's shared services — not models, but things every product calls through mux with its key: web search (the
 * SearXNG beside mux) and the page reader (router/web.ts). Their calls are metered in `requests` like any model's
 * (model "searxng" / "reader", route "web.search" / "web.read"); this adds what only a service knows — how many
 * results, which search engines answered and which did not, which site a page came from — and watches SearXNG
 * itself: is it up, how fast, which engines it runs, and which are failing. The Services page shows all of it.
 * The words of a query are never kept here.
 */
db.exec(`
CREATE TABLE IF NOT EXISTS service_calls (
  request_id TEXT PRIMARY KEY, ts INTEGER NOT NULL, service TEXT NOT NULL,
  results INTEGER, engines TEXT, missing TEXT, host TEXT, chars INTEGER
);
CREATE INDEX IF NOT EXISTS service_calls_ts ON service_calls(ts);
CREATE TABLE IF NOT EXISTS service_checks (ts INTEGER NOT NULL, service TEXT NOT NULL, ok INTEGER NOT NULL, latency_ms INTEGER, error TEXT, PRIMARY KEY (service, ts));
`);

export const SERVICES = [
  { id: "web.search", name: "Web search", engine: "SearXNG", model: "searxng", endpoint: "POST /v1/search", about: "Searches the web through the SearXNG beside mux: titles, links and extracts from many engines at once. No vendor, no key, free." },
  { id: "web.read", name: "Page reader", engine: "built into mux", model: "reader", endpoint: "POST /v1/read", about: "Fetches one public web page and gives back its words as plain, AI-readable text: headings, paragraphs and lists, without scripts, menus or ads." },
] as const;

const put = db.prepare("INSERT OR REPLACE INTO service_calls(request_id, ts, service, results, engines, missing, host, chars) VALUES(?, ?, ?, ?, ?, ?, ?, ?)");
/** What a call found, written by router/web.ts. */
export function noteCall(ctx: Pick<Ctx, "id">, c: { service: string; results?: number; engines?: EngineReport; host?: string; chars?: number }) {
  if (ctx.id.startsWith("test_")) return; // the owner trying it from the dashboard
  try { put.run(ctx.id, now(), c.service, c.results ?? null, c.engines ? JSON.stringify(c.engines.answered) : null, c.engines?.failed.length ? JSON.stringify(c.engines.failed) : null, c.host ?? null, c.chars ?? null); } catch { /* metering never fails a call */ }
}

// ── SearXNG itself ────────────────────────────────────────────────────────────────────────────────────────────────
interface Searx { up: boolean | null; latencyMs: number | null; checked: number | null; error: string | null; version: string | null; engines: { name: string; categories: string[]; enabled: boolean }[]; errors: Record<string, { message: string; percentage: number }[]>; read: number | null }
const searx: Searx = { up: null, latencyMs: null, checked: null, error: null, version: null, engines: [], errors: {}, read: null };
const base = () => config.searxngUrl.replace(/\/$/, "");

async function check() {
  if (!config.searxngUrl) return;
  const t0 = Date.now();
  try {
    const r = await fetch(`${base()}/healthz`, { signal: AbortSignal.timeout(8_000) });
    Object.assign(searx, { up: r.ok, latencyMs: Date.now() - t0, checked: now(), error: r.ok ? null : `answered ${r.status}` });
  } catch (e) {
    Object.assign(searx, { up: false, latencyMs: null, checked: now(), error: (e as Error).name === "TimeoutError" ? "no answer in 8 s" : (e as Error).message });
  }
  db.prepare("INSERT OR REPLACE INTO service_checks(ts, service, ok, latency_ms, error) VALUES(?, 'web.search', ?, ?, ?)").run(now(), searx.up ? 1 : 0, searx.latencyMs, searx.error);
  if (searx.up && !searx.engines.length) void readEngines(); // it was not up yet when mux started
}

async function readEngines() {
  if (!config.searxngUrl) return;
  const get = (p: string) => fetch(`${base()}${p}`, { signal: AbortSignal.timeout(10_000) }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
  const [cfg, errs] = await Promise.all([get("/config"), get("/stats/errors")]) as [{ engines?: { name: string; categories?: string[]; enabled?: boolean }[]; version?: string } | null, Record<string, { log_parameters?: string[]; exception_classname?: string; percentage?: number }[]> | null];
  if (cfg?.engines) searx.engines = cfg.engines.map((e) => ({ name: e.name, categories: e.categories ?? [], enabled: e.enabled !== false }));
  if (cfg?.version) searx.version = cfg.version;
  if (errs) searx.errors = Object.fromEntries(Object.entries(errs).map(([k, v]) => [k, v.map((x) => ({ message: (x.log_parameters?.join(" ") || x.exception_classname?.split(".").pop() || "error").slice(0, 200), percentage: x.percentage ?? 0 }))]));
  searx.read = now();
}

export function startServices() {
  if (!config.searxngUrl) return;
  void check(); void readEngines();
  setInterval(() => void check(), 60_000).unref();
  setInterval(() => void readEngines(), 5 * 60_000).unref();
  setInterval(() => db.prepare("DELETE FROM service_checks WHERE ts < ?").run(now() - 30 * 86400_000), 3600_000).unref();
}

// ── Stats ────────────────────────────────────────────────────────────────────────────────────────────────────────
const pct = (sorted: number[], p: number) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] : null);
const parse = <T>(s: string | null): T[] => { try { return s ? (JSON.parse(s) as T[]) : []; } catch { return []; } };
type Answered = { name: string; s: number | null };
type Failed = { name: string; reason: string };

function stats(service: (typeof SERVICES)[number], range: string) {
  const r = RANGES[range] ?? RANGES["24h"];
  const since = now() - r.ms;
  const rows = db.prepare(`SELECT r.id, r.ts, r.tenant_id, r.status, r.latency_ms, r.error, c.results, c.engines, c.missing, c.host, c.chars
    FROM requests r LEFT JOIN service_calls c ON c.request_id = r.id WHERE r.route = ? AND r.ts >= ? ORDER BY r.ts DESC`).all(service.id, since) as
    { id: string; ts: number; tenant_id: string; status: number; latency_ms: number; error: string | null; results: number | null; engines: string | null; missing: string | null; host: string | null; chars: number | null }[];
  const ok = rows.filter((x) => x.status < 400);
  const lat = ok.map((x) => x.latency_ms).sort((a, b) => a - b);
  const buckets = new Map<number, { t: number; calls: number; errors: number; lat: number[] }>();
  for (let t = Math.floor(since / r.bucket) * r.bucket; t <= now(); t += r.bucket) buckets.set(t, { t, calls: 0, errors: 0, lat: [] });
  for (const x of rows) {
    const b = buckets.get(Math.floor(x.ts / r.bucket) * r.bucket);
    if (!b) continue;
    b.calls++; if (x.status >= 400) b.errors++; else b.lat.push(x.latency_ms);
  }
  const count = <T extends string>(xs: T[]) => [...xs.reduce((m, k) => m.set(k, (m.get(k) ?? 0) + 1), new Map<T, number>())].sort((a, b) => b[1] - a[1]);
  const tenants = count(rows.map((x) => x.tenant_id)).map(([id, n]) => ({ id, name: (db.prepare("SELECT name FROM tenants WHERE id = ?").get(id) as { name: string } | undefined)?.name ?? id, calls: n, errors: rows.filter((x) => x.tenant_id === id && x.status >= 400).length }));
  const withResults = ok.filter((x) => x.results != null);
  return {
    calls: rows.length, errors: rows.length - ok.length, errorRate: rows.length ? (rows.length - ok.length) / rows.length : 0,
    p50: pct(lat, 50), p95: pct(lat, 95),
    avgResults: withResults.length ? withResults.reduce((a, x) => a + (x.results ?? 0), 0) / withResults.length : null,
    empty: withResults.filter((x) => x.results === 0).length,
    avgChars: ok.some((x) => x.chars != null) ? ok.reduce((a, x) => a + (x.chars ?? 0), 0) / ok.filter((x) => x.chars != null).length : null,
    series: [...buckets.values()].map((b) => ({ t: b.t, calls: b.calls, errors: b.errors, p50: pct(b.lat.sort((a, c) => a - c), 50) })),
    tenants,
    // Per engine, over the searches in range: how often it answered and how fast, how often it failed and why
    engines: (() => {
      const m = new Map<string, { name: string; answered: number; times: number[]; failed: number; reasons: Map<string, number> }>();
      const get = (name: string) => m.get(name) ?? m.set(name, { name, answered: 0, times: [], failed: 0, reasons: new Map() }).get(name)!;
      for (const x of ok) {
        for (const a of parse<Answered | string>(x.engines)) { const e = get(typeof a === "string" ? a : a.name); e.answered++; if (typeof a !== "string" && a.s != null) e.times.push(a.s); }
        for (const f of parse<Failed | string>(x.missing)) { const e = get(typeof f === "string" ? f : f.name); e.failed++; const r = typeof f === "string" ? "no answer" : f.reason; e.reasons.set(r, (e.reasons.get(r) ?? 0) + 1); }
      }
      return [...m.values()].map((e) => ({ name: e.name, answered: e.answered, failed: e.failed, avgS: e.times.length ? e.times.reduce((a, b) => a + b, 0) / e.times.length : null, reasons: [...e.reasons].sort((a, b) => b[1] - a[1]).map(([reason, n]) => ({ reason, n })) }))
        .sort((a, b) => b.answered + b.failed - (a.answered + a.failed));
    })(),
    hosts: count(ok.map((x) => x.host).filter((h): h is string => !!h)).slice(0, 15).map(([name, n]) => ({ name, n })),
    errorKinds: count(rows.filter((x) => x.status >= 400).map((x) => (x.error ?? `status ${x.status}`).replace(/\d{3,}/g, "…").slice(0, 120))).slice(0, 8).map(([name, n]) => ({ name, n })),
    recent: rows.slice(0, 25).map((x) => ({ id: x.id, ts: x.ts, tenant: x.tenant_id, status: x.status, latencyMs: x.latency_ms, error: x.error, results: x.results,
      engines: parse<Answered | string>(x.engines).map((a) => (typeof a === "string" ? a : a.name)), missing: parse<Failed | string>(x.missing).map((f) => (typeof f === "string" ? f : `${f.name} (${f.reason})`)), host: x.host, chars: x.chars })),
  };
}

export function registerServices(api: FastifyInstance) {
  api.get("/services", async (req) => {
    const range = (req.query as { range?: string }).range ?? "24h";
    const checks = db.prepare("SELECT ts, ok, latency_ms FROM service_checks WHERE service = 'web.search' AND ts >= ? ORDER BY ts").all(now() - 24 * 3600_000) as { ts: number; ok: number; latency_ms: number | null }[];
    return {
      range,
      services: SERVICES.map((s) => ({
        ...s,
        configured: s.id === "web.search" ? !!config.searxngUrl : true,
        health: s.id === "web.search" ? { ...searx, uptime24h: checks.length ? checks.filter((c) => c.ok).length / checks.length : null, checks: checks.map((c) => ({ t: c.ts, ok: !!c.ok, ms: c.latency_ms })) } : null,
        stats: stats(s, range),
      })),
    };
  });
  // Try a service from the dashboard (the owner's own call: not metered for a tenant).
  api.post("/services/:id/test", async (req, reply) => {
    const { id } = req.params as { id: string };
    const b = (req.body ?? {}) as Record<string, unknown>;
    const ctx = { id: `test_${Date.now()}` } as Ctx;
    const t0 = Date.now();
    try {
      const out = id === "web.search" ? await runSearch(ctx, b, AbortSignal.timeout(20_000)) : id === "web.read" ? await runRead(ctx, b, AbortSignal.timeout(20_000)) : null;
      if (!out) return reply.code(404).send({ error: "no such service" });
      return { ms: Date.now() - t0, out };
    } catch (e) {
      return reply.code((e as { status?: number }).status ?? 500).send({ error: (e as Error).message, ms: Date.now() - t0 });
    }
  });
}
