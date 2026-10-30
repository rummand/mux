/** The admin API client: every call carries the admin token; a 401 sends you back to the login screen. */
const TOKEN_KEY = "mux.adminToken";

export const getToken = () => { try { return localStorage.getItem(TOKEN_KEY) ?? ""; } catch { return ""; } };
export const setToken = (t: string) => { try { t ? localStorage.setItem(TOKEN_KEY, t) : localStorage.removeItem(TOKEN_KEY); } catch { /* private mode */ } };

export class ApiError extends Error { constructor(public status: number, message: string) { super(message); } }

let onUnauthorized: () => void = () => undefined;
export const setUnauthorizedHandler = (fn: () => void) => { onUnauthorized = fn; };

/**
 * Which machine the node-scoped pages (Models, Advisor, Benchmarks, System) are looking at: null is this mux; a node id
 * sends the call through the gateway to that node's own admin API (/providers/<id>/proxy/...).
 */
let pageScope: string | null = null;
export const setPageScope = (s: string | null) => { pageScope = s; };

export async function api<T = unknown>(path: string, opts: { method?: string; body?: unknown; query?: Record<string, string | number | boolean | undefined | null>; scope?: string | null } = {}): Promise<T> {
  const scope = opts.scope === undefined ? pageScope : opts.scope;
  if (scope) path = `/providers/${encodeURIComponent(scope)}/proxy${path}`;
  const q = opts.query ? Object.entries(opts.query).filter(([, v]) => v !== undefined && v !== null && v !== "").map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`).join("&") : "";
  const res = await fetch(`/api/admin${path}${q ? `?${q}` : ""}`, {
    method: opts.method ?? (opts.body !== undefined ? "POST" : "GET"),
    headers: { authorization: `Bearer ${getToken()}`, ...(opts.body !== undefined ? { "content-type": "application/json" } : {}) },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  if (res.status === 401) { onUnauthorized(); throw new ApiError(401, "admin token required"); }
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) throw new ApiError(res.status, (data && (data.error?.message ?? data.error)) || res.statusText);
  return data as T;
}

/* ── Shapes (mirroring server/src) ─────────────────────────────────────────────────────────────────────────── */
export interface Summary {
  requests: number; errors: number; errorRate: number; promptTokens: number; completionTokens: number; cachedTokens: number;
  latencyP50: number | null; latencyP95: number | null; latencyP99: number | null; latencyAvg: number | null;
  ttftP50: number | null; ttftP95: number | null; tpsAvg: number | null; tpsP50: number | null;
  overheadP50: number | null; overheadP99: number | null; coldStarts: number; fallbacks: number; streamShare: number; toolShare: number; costUsd?: number;
}
export type Group = Summary & { key: string };
export interface Overview {
  range: string; bucketMs: number; since: number; totals: Summary; series: Record<string, number | null>[];
  latencyHistogram: { bucket: string; count: number }[]; tenants: string[]; models: string[];
  byTenant: Group[]; byProvider?: Group[]; byModel: Group[]; byRoute: Group[]; byEndpoint: Group[]; byAgent: Group[]; byUser: Group[]; byError: Group[];
}
export interface Caps { quality?: number; speed?: number; tools?: number; code?: number; reasoning?: number; multilingual?: number; vision?: number; context?: number }
export interface Instance {
  id: string; backend: string; state: "loading" | "ready" | "unloading" | "failed"; port: number; pid: number; estimateGb: number; rssGb: number | null;
  startedAt: number; readyAt: number | null; lastUsed: number; inflight: number; requests: number; idleMin: number; metrics: Record<string, number> | null;
}
export interface Bench { id: string; model_id: string; ts: number; status: string; results: { name: string; pass: boolean; ms: number; detail: string }[] | string; score: number | null; tps: number | null; prompt_tps: number | null; ttft_ms: number | null; load_ms: number | null; error: string | null }
export interface Model {
  id: string; display_name: string; kind: "chat" | "embedding" | "rerank" | "systemone" | "transcription" | "speech"; backend: "llamacpp" | "mlx" | "external" | "laya" | "jev" | "node";
  path: string | null; mmproj: string | null; base_url: string | null; api_key: string | null; upstream_model: string | null; catalog_id: string | null;
  size_bytes: number; ctx: number; parallel: number; extra_args: string[]; reasoning: "off" | "on" | "auto"; caps: Caps;
  keep_alive_min: number | null; pinned: boolean; enabled: boolean; notes: string; created_at: number; estimateGb: number;
  instance?: Instance | null; bench?: Bench | null; provider_id?: string | null; provider?: string | null; cost_in?: number; cost_out?: number; usage24h?: { n: number; errors: number; tokens: number; tps: number | null } | null; onDisk?: boolean | null;
}
export interface Route { name: string; description: string; kind: Model["kind"]; strategy: "priority" | "auto" | "fastest" | "quality"; candidates: string[]; created_at: number }
export interface Tenant {
  id: string; name: string; description: string; color: string; status: "active" | "paused"; rpm_limit: number; tpm_limit: number; monthly_token_budget: number; monthly_usd_budget?: number;
  default_route: string; allowed: string[]; aliases: Record<string, string>; log_bodies: boolean; max_parallel: number; created_at: number;
  keys?: ApiKey[] | number; usage24h?: { n: number; errors: number; tokens: number; last: number } | null; monthTokens?: number;
}
export interface ApiKey { id: string; tenant_id: string; name: string; prefix: string; created_at: number; last_used_at: number | null; revoked_at: number | null; expires_at: number | null; rpm_limit: number; monthly_token_budget: number }
export interface CatalogEntry {
  id: string; name: string; family: string; kind: Model["kind"]; repo: string; file: string; mmproj?: string; sizeGb: number; params: string; activeParams?: string;
  arch: string; ctx: number; license: string; routes: string[]; caps: Caps; defaultCtx: number; notes: string; released: string; minLlama?: string; installed?: string | null;
}
export interface Download { id: string; catalog_id: string | null; repo: string; files: string; quant: string | null; model_id: string | null; total_bytes: number; done_bytes: number; status: string; error: string | null; bps: number; started_at: number; finished_at: number | null }
export interface LocalFile { path: string; real: string; name: string; sizeGb: number; repo: string | null; registeredAs: string | null; mmproj: string | null }
export interface Advice {
  id: string; name: string; family: string; kind: string; sizeGb: number; needGb: number; params: string; activeParams?: string; license: string;
  installed: boolean; modelId: string | null; fit: "fits" | "tight" | "too-big"; diskOk: boolean; score: number; caps: Caps;
  measured: { score: number; tps: number; ttftMs: number } | null; reasons: string[]; notes: string; routes: string[]; repo: string; file: string; released: string;
}
export interface RequestRow {
  id: string; ts: number; tenant_id: string; key_id: string; endpoint: string; requested_model: string | null; route: string | null; model_id: string | null;
  stream: number; tools: number; forced_tool: number; status: number; error_type: string | null; error: string | null; prompt_tokens: number; completion_tokens: number; cached_tokens: number;
  latency_ms: number; ttft_ms: number | null; queue_ms: number; tps: number | null; overhead_ms: number | null; cold_start: number; fallbacks: number; finish_reason: string | null;
  agent: string | null; trace_id: string | null; end_user: string | null; tags: string | null; route_reason?: string | null; body_req?: string | null; body_res?: string | null; ip?: string; user_agent?: string;
  tenant_name?: string; tenant_color?: string;
}
export interface SystemInfo {
  system: { memTotalGb: number; memUsedGb: number; memFreeGb: number; swapGb: number; pressure: number; diskFreeGb: number; diskTotalGb: number; load1: number; cores: number; chip: string };
  instances: Instance[]; health: Record<string, { fails: number[]; cooldown: boolean; ttftMs: number | null; tps: number | null; ok: number; err: number }>;
  failures: Record<string, { at: number; error: string }>; inflight: Record<string, number>;
  budget: { budgetGb: number; usedGb: number; headroomGb: number; maxLoaded: number };
  series: { ts: number; mem_total_gb: number; mem_used_gb: number; mem_free_gb: number; swap_gb: number; pressure: number; mux_gb: number; loaded: string; cpu: number; disk_free_gb: number }[];
  version: string; uptimeS: number; role?: "all" | "gateway" | "node"; name?: string;
}
export interface Settings { memoryBudgetGb: number; memoryHeadroomGb: number; diskReserveGb: number; keepAliveMin: number; maxLoaded: number; retentionDays: number; pressureGuard: boolean; logBodies: boolean }
export interface MuxEvent { id: number; ts: number; level: "info" | "warn" | "error"; source: string; message: string; data: string | null }
export interface Finding { title: string; kind: "needs-attention" | "pattern"; priority: "high" | "medium" | "low"; description: string; suggestion: string; evidence: { request_id: string; quote: string }[]; source: "rules" | "model" }
export interface LensRun { id: string; ts: number; status: string; title: string; filters: Record<string, unknown>; criteria: string; model_id: string | null; coverage: { eligible: number; screened: number; errors: number } | null; findings: Finding[]; duration_ms: number | null; error: string | null }
export interface TraceRow { trace_id: string; tenant_id: string; agent: string | null; calls: number; started: number; ended: number; prompt_tokens: number; completion_tokens: number; errors: number; tool_calls: number; models: string | null; total_ms: number }

export interface NodeInfo {
  system?: { memTotalGb: number; memFreeGb: number; swapGb: number; pressure: number; diskFreeGb: number; chip: string; cores: number };
  instances?: { id: string; state: string; estimateGb: number; inflight: number; rssGb: number | null }[];
  budget?: { budgetGb: number; usedGb: number }; models?: number; latencyMs?: number; version?: string;
}
export interface Provider {
  id: string; name: string; kind: string; base_url: string; api_key: string | null; admin_token: string | null; enabled: boolean;
  status: "online" | "offline" | "error" | "unknown"; last_seen: number | null; error: string | null; info: NodeInfo | null; created_at: number;
  models: string[]; usage24h: { n: number; errors: number; tokens: number; usd: number } | null;
}
export type Presets = Record<string, { name: string; base_url: string; keyUrl: string }>;
