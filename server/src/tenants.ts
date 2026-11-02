import { createHash, randomBytes } from "node:crypto";
import { db, json, now } from "./db.js";

export interface Tenant {
  id: string; name: string; description: string; color: string; status: "active" | "paused";
  rpm_limit: number; tpm_limit: number; monthly_token_budget: number; monthly_usd_budget: number;
  default_route: string; allowed: string[]; aliases: Record<string, string>; log_bodies: boolean; max_parallel: number; created_at: number;
  /** Which machines its requests may run on: any, own (never a cloud API) or servers (router/border.ts). */
  data_border: "any" | "own" | "servers";
}
type Row = Omit<Tenant, "allowed" | "aliases" | "log_bodies"> & { allowed: string; aliases: string; log_bodies: number };
const fromRow = (r: Row): Tenant => ({ ...r, allowed: json(r.allowed, []), aliases: json(r.aliases, {}), log_bodies: !!r.log_bodies });

export const listTenants = (): Tenant[] => (db.prepare("SELECT * FROM tenants ORDER BY name").all() as Row[]).map(fromRow);
export const getTenant = (id: string): Tenant | undefined => {
  const r = db.prepare("SELECT * FROM tenants WHERE id = ?").get(id) as Row | undefined;
  return r && fromRow(r);
};

export function upsertTenant(t: Partial<Tenant> & { id: string }): Tenant {
  const prev = getTenant(t.id);
  const next = {
    name: t.id, description: "", color: "#6366f1", status: "active", rpm_limit: 0, tpm_limit: 0, monthly_token_budget: 0, monthly_usd_budget: 0,
    default_route: "auto", allowed: [], aliases: {}, log_bodies: false, max_parallel: 0, data_border: "any", created_at: now(), ...prev, ...t,
  } as Tenant;
  db.prepare(`INSERT INTO tenants(id, name, description, color, status, rpm_limit, tpm_limit, monthly_token_budget, monthly_usd_budget, default_route, allowed, aliases, log_bodies, max_parallel, data_border, created_at)
    VALUES(@id, @name, @description, @color, @status, @rpm_limit, @tpm_limit, @monthly_token_budget, @monthly_usd_budget, @default_route, @allowed, @aliases, @log_bodies, @max_parallel, @data_border, @created_at)
    ON CONFLICT(id) DO UPDATE SET name=excluded.name, description=excluded.description, color=excluded.color, status=excluded.status,
      rpm_limit=excluded.rpm_limit, tpm_limit=excluded.tpm_limit, monthly_token_budget=excluded.monthly_token_budget, monthly_usd_budget=excluded.monthly_usd_budget,
      default_route=excluded.default_route, allowed=excluded.allowed, aliases=excluded.aliases, log_bodies=excluded.log_bodies, max_parallel=excluded.max_parallel, data_border=excluded.data_border`)
    .run({ ...next, allowed: JSON.stringify(next.allowed), aliases: JSON.stringify(next.aliases), log_bodies: next.log_bodies ? 1 : 0 });
  return next;
}
export const deleteTenant = (id: string) => db.prepare("DELETE FROM tenants WHERE id = ?").run(id);

export interface ApiKey {
  id: string; tenant_id: string; name: string; prefix: string; created_at: number; last_used_at: number | null; revoked_at: number | null;
  expires_at: number | null; rpm_limit: number; monthly_token_budget: number;
}
export interface KeyOptions { value?: string; expiresAt?: number | null; rpmLimit?: number; monthlyTokenBudget?: number }

const hash = (key: string) => createHash("sha256").update(key).digest("hex");

/** A new key for a tenant. The whole key is returned this once; only its hash is kept. `value` imports a key that already exists. */
export function createKey(tenantId: string, name: string, opts: KeyOptions = {}): { key: string; record: ApiKey } {
  const key = opts.value ?? `mux-sk-${randomBytes(24).toString("base64url")}`;
  const record: ApiKey = {
    id: randomBytes(8).toString("hex"), tenant_id: tenantId, name, prefix: `${key.slice(0, 7)}…${key.slice(-4)}`, created_at: now(), last_used_at: null, revoked_at: null,
    expires_at: opts.expiresAt ?? null, rpm_limit: opts.rpmLimit ?? 0, monthly_token_budget: opts.monthlyTokenBudget ?? 0,
  };
  db.prepare("INSERT INTO api_keys(id, tenant_id, name, prefix, hash, created_at, expires_at, rpm_limit, monthly_token_budget) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run(record.id, tenantId, name, record.prefix, hash(key), record.created_at, record.expires_at, record.rpm_limit, record.monthly_token_budget);
  return { key, record };
}
const KEY_COLS = "id, tenant_id, name, prefix, created_at, last_used_at, revoked_at, expires_at, rpm_limit, monthly_token_budget";
export const listKeys = (tenantId: string): ApiKey[] =>
  db.prepare(`SELECT ${KEY_COLS} FROM api_keys WHERE tenant_id = ? ORDER BY created_at DESC`).all(tenantId) as ApiKey[];
export const revokeKey = (id: string) => db.prepare("UPDATE api_keys SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL").run(now(), id);

const touched = new Map<string, number>();
/** The tenant and key a bearer key belongs to, or null. last_used_at is written at most once a minute per key. */
export function authenticate(key: string): { tenant: Tenant; keyId: string; key: ApiKey } | null {
  const row = db.prepare(`SELECT ${KEY_COLS} FROM api_keys WHERE hash = ? AND revoked_at IS NULL`).get(hash(key)) as ApiKey | undefined;
  if (!row || (row.expires_at && row.expires_at < now())) return null;
  const tenant = getTenant(row.tenant_id);
  if (!tenant) return null;
  const t = now();
  if ((touched.get(row.id) ?? 0) < t - 60_000) {
    touched.set(row.id, t);
    db.prepare("UPDATE api_keys SET last_used_at = ? WHERE id = ?").run(t, row.id);
  }
  return { tenant, keyId: row.id, key: row };
}
