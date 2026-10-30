import { db } from "../db.js";
import type { ApiKey, Tenant } from "../tenants.js";

/** Rate limits and budgets, checked before a request reaches a model. A breach is a 429 with the reason. */
export class LimitError extends Error {
  constructor(message: string, public retryAfterS: number, public type = "rate_limit_exceeded") { super(message); }
}

const windows = new Map<string, number[]>();
const tokens = new Map<string, { t: number; n: number }[]>();
const prune = <T extends number | { t: number }>(xs: T[], since: number) => xs.filter((x) => (typeof x === "number" ? x : x.t) > since);

function hit(key: string, limit: number, what: string) {
  if (!limit) return;
  const t = Date.now();
  const xs = prune(windows.get(key) ?? [], t - 60_000);
  if (xs.length >= limit) throw new LimitError(`${what} is limited to ${limit} requests a minute`, Math.ceil((xs[0] + 60_000 - t) / 1000));
  xs.push(t);
  windows.set(key, xs);
}

const monthStart = () => { const d = new Date(); return new Date(d.getFullYear(), d.getMonth(), 1).getTime(); };
const spentCache = new Map<string, { at: number; n: number }>();
function spent(col: "tenant_id" | "key_id", id: string): number {
  const k = `${col}:${id}`;
  const c = spentCache.get(k);
  if (c && Date.now() - c.at < 30_000) return c.n;
  const row = db.prepare(`SELECT COALESCE(SUM(prompt_tokens + completion_tokens), 0) n FROM requests WHERE ${col} = ? AND ts >= ?`).get(id, monthStart()) as { n: number };
  spentCache.set(k, { at: Date.now(), n: row.n });
  return row.n;
}

let usdCache: { at: number; byTenant: Map<string, number> } | null = null;
function spentUsd(tenantId: string): number {
  if (!usdCache || Date.now() - usdCache.at > 30_000) {
    const rows = db.prepare("SELECT tenant_id, COALESCE(SUM(cost_usd), 0) usd FROM requests WHERE ts >= ? GROUP BY tenant_id").all(monthStart()) as { tenant_id: string; usd: number }[];
    usdCache = { at: Date.now(), byTenant: new Map(rows.map((r) => [r.tenant_id, r.usd])) };
  }
  return usdCache.byTenant.get(tenantId) ?? 0;
}

export function check(tenant: Tenant, key: ApiKey) {
  if (tenant.status !== "active") throw new LimitError(`${tenant.name} is paused in mux`, 3600, "tenant_paused");
  hit(`t:${tenant.id}`, tenant.rpm_limit, tenant.name);
  hit(`k:${key.id}`, key.rpm_limit, `the key ${key.name}`);
  if (tenant.tpm_limit) {
    const used = prune(tokens.get(tenant.id) ?? [], Date.now() - 60_000).reduce((a, x) => a + x.n, 0);
    if (used >= tenant.tpm_limit) throw new LimitError(`${tenant.name} is limited to ${tenant.tpm_limit} tokens a minute (${used} used)`, 30);
  }
  if (tenant.monthly_token_budget && spent("tenant_id", tenant.id) >= tenant.monthly_token_budget)
    throw new LimitError(`${tenant.name} has used its ${tenant.monthly_token_budget.toLocaleString()} tokens for this month`, 86400, "budget_exceeded");
  if (tenant.monthly_usd_budget && spentUsd(tenant.id) >= tenant.monthly_usd_budget)
    throw new LimitError(`${tenant.name} has spent its $${tenant.monthly_usd_budget} on paid models this month`, 86400, "budget_exceeded");
  if (key.monthly_token_budget && spent("key_id", key.id) >= key.monthly_token_budget)
    throw new LimitError(`the key ${key.name} has used its ${key.monthly_token_budget.toLocaleString()} tokens for this month`, 86400, "budget_exceeded");
}

export function addTokens(tenantId: string, n: number) {
  if (!n) return;
  const xs = prune(tokens.get(tenantId) ?? [], Date.now() - 60_000);
  xs.push({ t: Date.now(), n });
  tokens.set(tenantId, xs);
}

/** Requests a tenant has in flight; over `max_parallel` is refused rather than queued behind the others. */
const inflight = new Map<string, number>();
export function enter(tenant: Tenant) {
  const n = inflight.get(tenant.id) ?? 0;
  if (tenant.max_parallel && n >= tenant.max_parallel) throw new LimitError(`${tenant.name} may have ${tenant.max_parallel} requests in flight at once`, 1, "too_many_parallel");
  inflight.set(tenant.id, n + 1);
}
export const leave = (tenant: Tenant) => inflight.set(tenant.id, Math.max(0, (inflight.get(tenant.id) ?? 1) - 1));
export const inflightNow = () => Object.fromEntries(inflight);
