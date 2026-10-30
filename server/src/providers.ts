import { db, event, json, now } from "./db.js";
import { deleteModel, getModel, listModels, listRoutes, upsertModel, upsertRoute, type Caps, type Kind } from "./models.js";

/**
 * Where compute comes from. A gateway (mux on Railway) holds no models of its own: it routes to providers.
 * - **mux** nodes: a machine running mux (the Mac Studio). The gateway is a tenant on the node, syncs the node's models
 *   as its own (`<node>/<model>`), sees its memory and what is loaded, and manages it through its admin API.
 * - **cloud** APIs: OpenAI-compatible endpoints with a key; their models are added with a price per million tokens.
 */
export interface Provider {
  id: string; name: string; kind: string; base_url: string; api_key: string | null; admin_token: string | null;
  enabled: boolean; status: "online" | "offline" | "error" | "unknown"; last_seen: number | null; error: string | null;
  info: NodeInfo | null; created_at: number;
}
export interface NodeInfo {
  system?: { memTotalGb: number; memFreeGb: number; swapGb: number; pressure: number; diskFreeGb: number; chip: string; cores: number };
  instances?: { id: string; state: string; estimateGb: number; inflight: number; rssGb: number | null }[];
  budget?: { budgetGb: number; usedGb: number };
  models?: number; latencyMs?: number; version?: string;
}

/** Cloud presets: an OpenAI-compatible base URL each (Anthropic and Gemini included, through their compatibility endpoints). */
export const PRESETS: Record<string, { name: string; base_url: string; keyUrl: string; examples: { id: string; cost_in: number; cost_out: number; caps: Caps; ctx: number }[] }> = {
  openai: { name: "OpenAI", base_url: "https://api.openai.com/v1", keyUrl: "https://platform.openai.com/api-keys", examples: [] },
  anthropic: { name: "Anthropic", base_url: "https://api.anthropic.com/v1", keyUrl: "https://console.anthropic.com/settings/keys", examples: [] },
  openrouter: { name: "OpenRouter", base_url: "https://openrouter.ai/api/v1", keyUrl: "https://openrouter.ai/keys", examples: [] },
  groq: { name: "Groq", base_url: "https://api.groq.com/openai/v1", keyUrl: "https://console.groq.com/keys", examples: [] },
  together: { name: "Together AI", base_url: "https://api.together.xyz/v1", keyUrl: "https://api.together.ai/settings/api-keys", examples: [] },
  fireworks: { name: "Fireworks", base_url: "https://api.fireworks.ai/inference/v1", keyUrl: "https://fireworks.ai/account/api-keys", examples: [] },
  cerebras: { name: "Cerebras", base_url: "https://api.cerebras.ai/v1", keyUrl: "https://cloud.cerebras.ai", examples: [] },
  gemini: { name: "Google Gemini", base_url: "https://generativelanguage.googleapis.com/v1beta/openai", keyUrl: "https://aistudio.google.com/apikey", examples: [] },
  mistral: { name: "Mistral", base_url: "https://api.mistral.ai/v1", keyUrl: "https://console.mistral.ai/api-keys", examples: [] },
  deepseek: { name: "DeepSeek", base_url: "https://api.deepseek.com/v1", keyUrl: "https://platform.deepseek.com/api_keys", examples: [] },
  custom: { name: "Custom (OpenAI-compatible)", base_url: "", keyUrl: "", examples: [] },
};

type Row = Omit<Provider, "enabled" | "info"> & { enabled: number; info: string | null };
const fromRow = (r: Row): Provider => ({ ...r, enabled: !!r.enabled, info: json(r.info, null) });
export const listProviders = (): Provider[] => (db.prepare("SELECT * FROM providers ORDER BY kind = 'mux' DESC, name").all() as Row[]).map(fromRow);
export const getProvider = (id: string): Provider | undefined => { const r = db.prepare("SELECT * FROM providers WHERE id = ?").get(id) as Row | undefined; return r && fromRow(r); };

export function saveProvider(p: Partial<Provider> & { id: string }): Provider {
  const prev = getProvider(p.id);
  const next = { name: p.id, kind: "custom", base_url: "", api_key: null, admin_token: null, enabled: true, status: "unknown", last_seen: null, error: null, info: null, created_at: now(), ...prev, ...p } as Provider;
  next.base_url = next.base_url.replace(/\/+$/, "");
  db.prepare(`INSERT INTO providers(id, name, kind, base_url, api_key, admin_token, enabled, status, last_seen, error, info, created_at)
    VALUES(@id, @name, @kind, @base_url, @api_key, @admin_token, @enabled, @status, @last_seen, @error, @info, @created_at)
    ON CONFLICT(id) DO UPDATE SET name=excluded.name, kind=excluded.kind, base_url=excluded.base_url, api_key=excluded.api_key,
      admin_token=excluded.admin_token, enabled=excluded.enabled, status=excluded.status, last_seen=excluded.last_seen, error=excluded.error, info=excluded.info`)
    .run({ ...next, enabled: next.enabled ? 1 : 0, info: next.info ? JSON.stringify(next.info) : null });
  return next;
}

export function removeProvider(id: string) {
  for (const m of listModels().filter((x) => x.provider_id === id)) dropModel(m.id);
  db.prepare("DELETE FROM providers WHERE id = ?").run(id);
}

function dropModel(id: string) {
  deleteModel(id);
  for (const r of listRoutes()) if (r.candidates.includes(id)) upsertRoute({ ...r, candidates: r.candidates.filter((c) => c !== id) });
}

/** Call a mux node's admin API. */
export async function nodeApi<T = unknown>(p: Provider, method: string, path: string, body?: unknown, timeoutMs = 15_000): Promise<T> {
  const r = await fetch(`${p.base_url}/api/admin${path}`, {
    method, signal: AbortSignal.timeout(timeoutMs),
    headers: { authorization: `Bearer ${p.admin_token}`, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`${p.name}: ${method} ${path} → ${r.status} ${text.slice(0, 200)}`);
  return (text ? JSON.parse(text) : null) as T;
}

/**
 * Join a mux node: check its admin token, and become a tenant on it ("gateway") with a key of its own, so the node
 * meters and limits what the gateway sends like any other caller's.
 */
export async function joinNode(p: Provider, gatewayName: string): Promise<Provider> {
  await nodeApi(p, "GET", "/system");
  const tenantId = `gateway-${gatewayName}`.toLowerCase().replace(/[^a-z0-9-]+/g, "-").slice(0, 40);
  await nodeApi(p, "PUT", `/tenants/${tenantId}`, { name: `Gateway ${gatewayName}`, description: "A mux gateway routing to this node", color: "#0ea5e9", default_route: "auto" });
  const { key } = await nodeApi<{ key: string }>(p, "POST", `/tenants/${tenantId}/keys`, { name: `gateway ${gatewayName}` });
  const joined = saveProvider({ ...p, api_key: key });
  await syncNode(joined);
  return getProvider(p.id)!;
}

interface NodeModel { id: string; display_name: string; kind: Kind; backend: string; enabled: boolean; ctx: number; size_bytes: number; caps: Caps; notes: string; catalog_id: string | null }

/** Read a node's state and models; its models become the gateway's, as `<node>/<model>`. */
export async function syncNode(p: Provider) {
  const t0 = Date.now();
  try {
    const [sys, models] = await Promise.all([nodeApi<NodeInfo & { system: NodeInfo["system"] }>(p, "GET", "/system?range=15m"), nodeApi<NodeModel[]>(p, "GET", "/models")]);
    const info: NodeInfo = { system: sys.system, instances: sys.instances, budget: sys.budget, models: models.length, latencyMs: Date.now() - t0, version: sys.version };
    const wasDown = p.status !== "online";
    saveProvider({ ...p, status: "online", last_seen: now(), error: null, info });
    if (wasDown) event("info", "providers", `${p.name} is online (${info.latencyMs} ms, ${models.length} models)`);
    const seen = new Set<string>();
    for (const nm of models.filter((m) => m.enabled)) {
      const id = `${p.id}/${nm.id}`;
      seen.add(id);
      const mine = getModel(id);
      upsertModel({
        ...(mine ?? {}), id, display_name: `${nm.display_name} · ${p.name}`, kind: nm.kind, backend: "node", provider_id: p.id,
        upstream_model: nm.id, base_url: `${p.base_url}/v1`, ctx: nm.ctx, size_bytes: nm.size_bytes, caps: nm.caps, catalog_id: nm.catalog_id,
        notes: nm.notes, enabled: mine?.enabled ?? true, cost_in: mine?.cost_in ?? 0, cost_out: mine?.cost_out ?? 0,
      });
    }
    for (const m of listModels().filter((x) => x.provider_id === p.id && !seen.has(x.id))) dropModel(m.id);
  } catch (e) {
    const msg = (e as Error).message;
    if (p.status === "online") event("warn", "providers", `${p.name} is unreachable: ${msg}`);
    saveProvider({ ...p, status: "offline", error: msg });
  }
}

/** The models a cloud provider lists (GET /models), to add from with one click. */
export async function remoteModels(p: Provider): Promise<{ id: string; owned_by?: string; context_length?: number }[]> {
  const r = await fetch(`${p.base_url}/models`, { headers: p.api_key ? { authorization: `Bearer ${p.api_key}`, "x-api-key": p.api_key, "anthropic-version": "2023-06-01" } : {}, signal: AbortSignal.timeout(15_000) });
  if (!r.ok) throw new Error(`${p.name}: GET /models → ${r.status} ${(await r.text()).slice(0, 200)}`);
  const j = (await r.json()) as { data?: { id: string; owned_by?: string; context_length?: number }[] };
  return (j.data ?? []).sort((a, b) => a.id.localeCompare(b.id));
}

/** A cloud model, reachable as `<provider>/<model>`. */
export function addCloudModel(p: Provider, m: { model: string; kind?: Kind; cost_in?: number; cost_out?: number; ctx?: number; caps?: Caps; display_name?: string }) {
  return upsertModel({
    id: `${p.id}/${m.model}`, display_name: m.display_name ?? `${m.model} · ${p.name}`, backend: "external", kind: m.kind ?? "chat", provider_id: p.id,
    upstream_model: m.model, base_url: p.base_url, ctx: m.ctx ?? 128000, cost_in: m.cost_in ?? 0, cost_out: m.cost_out ?? 0,
    caps: m.caps ?? { quality: 9, speed: 7, tools: 9, code: 9, reasoning: 9, multilingual: 9, context: 9 },
    notes: `${p.name} (cloud). Paid per token.`,
  });
}

/** Whether a model's provider can be reached now; a model of this machine always can. */
export function providerUp(providerId: string | null): boolean {
  if (!providerId) return true;
  const p = getProvider(providerId);
  return !!p && p.enabled && (p.kind !== "mux" || p.status === "online");
}

/** Whether a node model is loaded on its node, as of the last sync. */
export function loadedOnNode(providerId: string, upstream: string): boolean {
  const p = getProvider(providerId);
  return !!p?.info?.instances?.some((i) => i.id === upstream && i.state === "ready");
}

export function startProviderSync() {
  const tick = () => { for (const p of listProviders().filter((x) => x.kind === "mux" && x.enabled)) void syncNode(p); };
  setInterval(tick, 15_000).unref();
  setTimeout(tick, 1000);
}
