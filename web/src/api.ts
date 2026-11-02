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
export const getPageScope = () => pageScope;

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
export type Group = Summary & SummaryExtra & { key: string };
export interface Overview extends OverviewExtra {
  range: string; bucketMs: number; since: number; totals: Summary & SummaryExtra; series: Record<string, number | null>[];
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
  /** Which machines its requests may run on (server/src/router/border.ts). */
  data_border?: "any" | "own" | "servers";
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
  usage?: ModelUsage | null; web?: WebSignal | null; onRoutes?: { route: string; position: number }[];
  cloudTest?: { score: number; modelId: string; ts: number } | null;
  benchmarks?: { name: string; value: string | number; url?: string }[]; supersededBy?: string | null; experimental?: string | null; research?: string | null;
}
/** A model's own traffic over 30 days (server/src/advisor.ts usageOf). */
export interface ModelUsage { requests: number; errors: number; errorRate: number; tenants: number; tps: number | null; latencyMs: number | null; ttftMs: number | null; costUsd: number; toolShare: number; lastTs: number | null }
/** What Hugging Face says (server/src/signals.ts). */
export interface WebSignal { repo: string; baseRepo: string | null; downloads: number | null; likes: number | null; trending: number | null; baseDownloads: number | null; baseLikes: number | null; fetchedAt: number; error: string | null; popularity: number | null }
export interface Insight { kind: "promote" | "try" | "measure" | "retire" | "watch"; title: string; detail: string; priority: "high" | "medium" | "low"; action: { method: "POST" | "PUT" | "PATCH"; path: string; body: unknown; label: string } | null }
export interface Trending { repo: string; downloads: number; likes: number; trending: number; created_at: string | null; pipeline: string | null; uploads: number }
export interface UsageRow { id: string; kind: string | null; backend: string | null; enabled: boolean; requests: number; errors: number; errorRate: number; tenants: number; latencyMs: number | null; ttftMs: number | null; tps: number | null; tokens: number; costUsd: number; lastTs: number | null; bench: { score: number; tps: number; ts: number } | null; routes: string[] }
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
  series: { ts: number; mem_total_gb: number; mem_used_gb: number; mem_free_gb: number; swap_gb: number; pressure: number; mux_gb: number; loaded: string; cpu: number; disk_free_gb: number; cpu_pct: number | null; gpu_pct: number | null; net_in: number | null; net_out: number | null; disk_r: number | null; disk_w: number | null }[];
  version: string; uptimeS: number; role?: "all" | "gateway" | "node"; name?: string;
}
/** GET /system/live: the machine every 2 s (server/src/runtime/live.ts). */
export interface SystemLive {
  ts: number; cores: { id: number; kind: "P" | "E" | null; cluster: number; pct: number }[]; cpu: number;
  gpu: { pct: number; renderer: number; tiler: number; memGb: number } | null;
  memory: { wired: number; apps: number; compressed: number; cached: number; free: number } | null;
  net: { in: number; out: number }; disk: { read: number; write: number }; thermal: string | null; load: number[]; uptimeS: number; pid: number;
  processes: { pid: number; name: string; cpu: number; rssGb: number }[];
  history: { ts: number; cores: number[]; cpu: number; gpu: number | null; netIn: number; netOut: number; diskR: number; diskW: number }[];
}
export interface Settings { memoryBudgetGb: number; memoryHeadroomGb: number; diskReserveGb: number; keepAliveMin: number; maxLoaded: number; retentionDays: number; pressureGuard: boolean; logBodies: boolean; assistantModel?: string; selfHeal?: boolean; selfHealAi?: boolean }
export interface MuxEvent { id: number; ts: number; level: "info" | "warn" | "error"; source: string; message: string; data: string | null }
export interface Finding { key: string; title: string; kind: "needs-attention" | "pattern"; priority: "high" | "medium" | "low"; description: string; suggestion: string; evidence: { request_id: string; quote: string }[]; source: "rules" | "model"; status?: "new" | "ongoing" }
export interface LensMetrics { requests: number; errorRate: number; latencyP95: number | null; ttftP50: number | null; tokensPerRequest: number; costUsd: number }
export interface LensFilters { tenantId?: string; agent?: string; model?: string; hours?: number; sample?: number }
export interface LensRun {
  id: string; ts: number; status: string; title: string; filters: LensFilters; criteria: string; model_id: string | null; coverage: { eligible: number; screened: number; errors: number } | null;
  findings: Finding[]; duration_ms: number | null; error: string | null; watch_id: string | null; resolved: { key: string; title: string }[]; baseline: { now: LensMetrics; before: LensMetrics } | null; muted: number | null;
}
export interface LensWatch { id: string; title: string; filters: LensFilters; criteria: string; every_hours: number; use_model: boolean; model_id: string | null; enabled: boolean; last_run: number | null; last_run_id: string | null; next_run: number | null }
export interface LensMute { key: string; title: string; until: number | null; created_at: number }
export interface TraceRow { trace_id: string; tenant_id: string; agent: string | null; calls: number; started: number; ended: number; prompt_tokens: number; completion_tokens: number; errors: number; tool_calls: number; models: string | null; total_ms: number }

export interface NodeInfo {
  system?: { memTotalGb: number; memFreeGb: number; swapGb: number; pressure: number; diskFreeGb: number; chip: string; cores: number };
  instances?: { id: string; state: string; estimateGb: number; inflight: number; rssGb: number | null }[];
  budget?: { budgetGb: number; usedGb: number }; models?: number; latencyMs?: number; version?: string;
  presence?: NodePresence | null;
}
/** Whether a node takes work now, what its owner set, and why (server/src/presence.ts). */
export interface NodePresence { state: "free" | "polite" | "busy" | "away"; mode: "available" | "away-only" | "off"; using: boolean; class: "always-on" | "desktop" | "laptop"; reasons: string[]; since: number }
export interface Provider {
  id: string; name: string; kind: string; base_url: string; api_key: string | null; admin_token: string | null; enabled: boolean;
  status: "online" | "offline" | "error" | "unknown"; last_seen: number | null; error: string | null; info: NodeInfo | null; created_at: number;
  models: string[]; usage24h: { n: number; errors: number; tokens: number; usd: number } | null;
  /** A cloud API's plan; a free tier's limits (JSON) and whether it trains on free-tier prompts (1/0/null unknown). */
  plan?: "free" | "paid"; limits?: string; trains_on_data?: number | null;
}
export interface FreeTier {
  id: string; name: string; base_url: string; endpoints: string[]; signup: string | null; cardRequired: boolean; keyless: boolean; needsAccountId: boolean;
  trainsOnData: boolean | null; eu: boolean; policy: string; policyUrl: string | null; notes: string; added: boolean;
  limits: { default?: Record<string, number> }; models: { id: string; kind: string; name: string; catalog: string | null; goodFor: string[] }[];
}
export interface QuotaRow { id: string; provider: string; limits: { rpm?: number; rpd?: number; tpm?: number; tpd?: number }; minute: number; day: number; tokensToday: number; blocked: string | null; trainsOnData: boolean | null }
export type Presets = Record<string, { name: string; base_url: string; keyUrl: string }>;

/* ── Richer stats (overview extras and /stats/<kind>/<id>) ─────────────────────────────────────────────────── */
export interface SummaryExtra { queueP50?: number | null; queueP95?: number | null; cacheHitRate?: number; tokensPerRequest?: number; rateLimited?: number; peakConcurrency?: number }
export interface OverviewExtra { heatmap?: number[][]; tokenHistogram?: { bucket: string; count: number }[]; byKey?: Group[]; byFinish?: Group[]; byStatus?: Group[] }
export type Point = Record<string, number | null>;
export interface MuxEventLite { ts: number; level: "info" | "warn" | "error"; message: string }
export interface ModelStats {
  id: string; range: string; bucketMs: number; provider: string | null; backend: string; series: Point[];
  loadedShare: number | null; sampled: boolean; loadedHours: number | null; gbHours: number | null; tokensPerLoadedHour: number | null;
  peakInflight: number | null; peakDeferred: number | null; loads: number; unloads: number; failures: number; loadSecondsP50: number | null; loadSecondsMax: number | null;
  usage: { requests: number; tokens: number; promptTokens: number; completionTokens: number; errors: number; coldStarts: number; costUsd: number | null; tenants: number };
  health: { fails: number[]; cooldown: boolean; ttftMs: number | null; tps: number | null; ok: number; err: number } | null;
  events: MuxEventLite[]; benchmarks: { ts: number; score: number | null; tps: number | null; prompt_tps: number | null; ttft_ms: number | null; load_ms: number | null; status: string }[];
}
export interface Incident { id: string; ts: number; kind: string; severity: string; status: string; title: string; resolved_at: number | null }
export interface ProviderStats {
  id: string; kind: string; range: string; bucketMs: number; sampled: boolean; series: Point[]; uptime: number | null; latencyP50: number | null; latencyP95: number | null;
  outages: { from: number; to: number | null }[]; models: number;
  byModel: { model_id: string; n: number; pin: number | null; pout: number | null; errors: number | null; usd: number | null; tps: number | null; lat: number | null }[];
  daily: { day: number; n: number; usd: number | null; tokens: number | null }[]; incidents: Incident[];
}
export interface TenantStats {
  id: string; range: string;
  limits: { rpmPeak: number; rpmLimit: number; tpmPeak: number; tpmLimit: number; activeMinutes: number; maxParallel: number };
  month: { tokens: number; usd: number | null; requests: number; tokenBudget: number; usdBudget: number; projectedTokens: number; projectedUsd: number | null; daysInMonth: number; dayOfMonth: number };
  daily: { day: number; n: number; tokens: number | null; usd: number | null; errors: number | null }[];
  rateLimited: { type: string; n: number }[];
  keys: { id: string; name: string; prefix: string; revoked: boolean; expires_at: number | null; rpm_limit: number; usage: { n: number; tokens: number; errors: number; last: number } | null }[];
}

/* ── The assistant's brain and conversations ──────────────────────────────────────────────────────────────── */
export type BrainKind = "fact" | "runbook" | "decision" | "preference" | "incident" | "note";
export interface BrainPage {
  id: string; title: string; kind: BrainKind; subject: string; body: string; tags: string[]; source: string;
  recalls: number; recalled_at: number | null; created_at: number; updated_at: number; embedded: boolean; score?: number;
}
export interface BrainStats {
  /** sqlite: mux's own brain; gbrain: GBrain (garrytan/gbrain), run by mux on loopback. */
  backend?: "sqlite" | "gbrain"; gbrain?: { ok: boolean; version: string | null; managed: boolean; error: string | null; url: string }; morePages?: boolean;
  pages: number; embedded: number; updated: number | null; kinds: Record<string, number>; models: { model: string; n: number }[]; embedding: boolean }
export interface Conversation { id: string; title: string; page: string | null; created_at: number; updated_at: number; messages: number }
