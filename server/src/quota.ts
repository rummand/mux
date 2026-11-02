import { db, now } from "./db.js";
import { getModel, type Model } from "./models.js";
import { getProvider, type Provider } from "./providers.js";

/**
 * Free tiers: a cloud provider on its free plan has limits — requests and tokens a minute and a day, per model or for
 * all — and says how close a caller is in its answers (x-ratelimit-* headers, 429 + retry-after). mux counts what it
 * sends to each free model, reads those headers, and takes a model out of the choice just before a limit, until the
 * window resets: a free tier is never run into the ground, and it is there when mux needs it most.
 */
export interface Limits { rpm?: number; rpd?: number; tpm?: number; tpd?: number }
export interface Plan { plan: "free" | "paid"; limits: { default?: Limits; per_model?: Record<string, Limits> }; trainsOnData: boolean | null }

export const planOf = (p: Provider | undefined): Plan => ({
  plan: (p as Provider & { plan?: string })?.plan === "free" ? "free" : "paid",
  limits: JSON.parse((p as Provider & { limits?: string })?.limits || "{}"),
  trainsOnData: (p as Provider & { trains_on_data?: number | null })?.trains_on_data == null ? null : !!(p as Provider & { trains_on_data?: number }).trains_on_data,
});

/** The free plan of a model's provider, or null when it is not on one. */
export function freePlan(m: Model): (Plan & { provider: Provider }) | null {
  if (!m.provider_id || m.backend !== "external") return null;
  const p = getProvider(m.provider_id);
  const plan = planOf(p);
  return plan.plan === "free" && p ? { ...plan, provider: p } : null;
}

const limitsFor = (m: Model, plan: Plan): Limits => ({ ...plan.limits.default, ...plan.limits.per_model?.[m.upstream_model ?? ""] });

/* ── Counting ───────────────────────────────────────────────────────────────────────────────────────────────── */

interface Use { minute: { ts: number; tokens: number }[]; day: { ts: number; tokens: number }[]; blockedUntil: number; why: string | null }
const use = new Map<string, Use>();
const get = (id: string) => { let u = use.get(id); if (!u) use.set(id, (u = { minute: [], day: [], blockedUntil: 0, why: null })); return u; };
const trim = (u: Use, t = now()) => { u.minute = u.minute.filter((x) => x.ts > t - 60_000); u.day = u.day.filter((x) => x.ts > t - 86400_000); };

/** One request sent to a model (counted for free ones), with its tokens once known. */
export function countRequest(modelId: string, tokens: number) {
  const m = getModel(modelId);
  if (!m || !freePlan(m)) return;
  const u = get(modelId);
  const e = { ts: now(), tokens };
  u.minute.push(e); u.day.push(e);
  trim(u);
}

/** The last day of requests to free models, from the request log: counts survive a restart. */
export function loadCounts() {
  const rows = db.prepare("SELECT r.model_id, r.ts, r.prompt_tokens + r.completion_tokens tok FROM requests r JOIN models m ON m.id = r.model_id JOIN providers p ON p.id = m.provider_id WHERE p.plan = 'free' AND r.ts > ?").all(now() - 86400_000) as { model_id: string; ts: number; tok: number }[];
  for (const r of rows) { const u = get(r.model_id); const e = { ts: r.ts, tokens: r.tok ?? 0 }; u.day.push(e); if (r.ts > now() - 60_000) u.minute.push(e); }
}

/** "2m59.56s", "7.66s", "120ms", "30" (seconds) → milliseconds. */
export function parseReset(v: string | null): number | null {
  if (!v) return null;
  if (/^\d+(\.\d+)?$/.test(v.trim())) return Number(v) * 1000;
  let ms = 0, any = false;
  for (const [, n, unit] of v.matchAll(/(\d+(?:\.\d+)?)(ms|h|m|s)/g)) { any = true; ms += Number(n) * (unit === "h" ? 3600_000 : unit === "m" ? 60_000 : unit === "s" ? 1000 : 1); }
  return any ? ms : null;
}

/**
 * What a free provider said about its limits in an answer's headers: no requests (or tokens) left in a window, or a
 * 429 with retry-after, takes the model out until the reset.
 */
export function noteHeaders(modelId: string, status: number, h: Headers) {
  const m = getModel(modelId);
  if (!m || !freePlan(m)) return;
  const u = get(modelId);
  const block = (ms: number | null, why: string) => { if (ms != null && ms > 0) { u.blockedUntil = Math.max(u.blockedUntil, now() + Math.min(ms, 86400_000)); u.why = why; } };
  if (status === 429) block(parseReset(h.get("retry-after")) ?? 60_000, "the provider answered 429 (rate limited)");
  for (const unit of ["requests", "tokens"]) {
    const left = h.get(`x-ratelimit-remaining-${unit}`) ?? h.get(`x-ratelimit-remaining-${unit}-day`);
    if (left != null && Number(left) <= 0) block(parseReset(h.get(`x-ratelimit-reset-${unit}`) ?? h.get(`x-ratelimit-reset-${unit}-day`)) ?? 60_000, `no ${unit} left on the free tier`);
  }
}

/**
 * Why a free model cannot take another request now, or null. A margin is kept under each limit (90% a minute, 95% a
 * day), so a burst of parallel requests does not overrun it.
 */
export function quotaBlock(m: Model, at = now()): string | null {
  const plan = freePlan(m);
  if (!plan) return null;
  const u = get(m.id);
  if (u.blockedUntil > at) return `free tier: ${u.why ?? "rate limited"}, until ${new Date(u.blockedUntil).toISOString().slice(11, 19)} UTC`;
  trim(u, at);
  const l = limitsFor(m, plan);
  const toks = (xs: { tokens: number }[]) => xs.reduce((a, x) => a + x.tokens, 0);
  if (l.rpm && u.minute.length >= Math.max(1, Math.floor(l.rpm * 0.9))) return `free tier: ${u.minute.length} of ${l.rpm} requests this minute`;
  if (l.rpd && u.day.length >= Math.max(1, Math.floor(l.rpd * 0.95))) return `free tier: ${u.day.length} of ${l.rpd} requests today`;
  if (l.tpm && toks(u.minute) >= l.tpm * 0.9) return `free tier: ${toks(u.minute)} of ${l.tpm} tokens this minute`;
  if (l.tpd && toks(u.day) >= l.tpd * 0.95) return `free tier: ${toks(u.day)} of ${l.tpd} tokens today`;
  return null;
}

/** For the dashboard: each free model's use against its limits. */
export function quotaReport() {
  return db.prepare("SELECT m.id FROM models m JOIN providers p ON p.id = m.provider_id WHERE p.plan = 'free' AND m.enabled = 1").all().map((r) => {
    const m = getModel((r as { id: string }).id)!;
    const plan = freePlan(m)!;
    const u = get(m.id); trim(u);
    return { id: m.id, provider: plan.provider.id, limits: limitsFor(m, plan), minute: u.minute.length, day: u.day.length, tokensToday: u.day.reduce((a, x) => a + x.tokens, 0), blocked: quotaBlock(m), trainsOnData: plan.trainsOnData };
  });
}
