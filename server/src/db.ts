import Database from "better-sqlite3";
import { config, defaultSettings, type Settings } from "./config.js";

export const db = new Database(config.dbPath);
db.pragma("journal_mode = WAL");
db.pragma("synchronous = NORMAL");
db.pragma("foreign_keys = ON");

db.exec(`
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS models (
  id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'chat',          -- chat | embedding | systemone
  backend TEXT NOT NULL,                      -- llamacpp | mlx | external | laya | jev
  path TEXT, mmproj TEXT,
  base_url TEXT, api_key TEXT, upstream_model TEXT,
  catalog_id TEXT, size_bytes INTEGER DEFAULT 0,
  ctx INTEGER DEFAULT 32768, parallel INTEGER DEFAULT 2,
  extra_args TEXT DEFAULT '[]', reasoning TEXT DEFAULT 'off',
  caps TEXT DEFAULT '{}',
  keep_alive_min INTEGER, pinned INTEGER DEFAULT 0, enabled INTEGER DEFAULT 1,
  notes TEXT DEFAULT '', created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS routes (
  name TEXT PRIMARY KEY,
  description TEXT DEFAULT '',
  kind TEXT NOT NULL DEFAULT 'chat',
  strategy TEXT NOT NULL DEFAULT 'priority', -- priority | auto | fastest | quality
  candidates TEXT NOT NULL DEFAULT '[]',
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS tenants (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT DEFAULT '',
  color TEXT DEFAULT '#6366f1',
  status TEXT NOT NULL DEFAULT 'active',
  rpm_limit INTEGER DEFAULT 0, tpm_limit INTEGER DEFAULT 0, monthly_token_budget INTEGER DEFAULT 0,
  default_route TEXT DEFAULT 'auto',
  allowed TEXT DEFAULT '[]',
  aliases TEXT DEFAULT '{}',
  log_bodies INTEGER DEFAULT 0, max_parallel INTEGER DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS api_keys (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name TEXT NOT NULL, prefix TEXT NOT NULL, hash TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL, last_used_at INTEGER, revoked_at INTEGER,
  expires_at INTEGER, rpm_limit INTEGER DEFAULT 0, monthly_token_budget INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS requests (
  id TEXT PRIMARY KEY,
  ts INTEGER NOT NULL,
  tenant_id TEXT, key_id TEXT,
  endpoint TEXT NOT NULL,           -- openai.chat | anthropic.messages | openai.embeddings | systemone
  requested_model TEXT, route TEXT, model_id TEXT, route_reason TEXT,
  stream INTEGER DEFAULT 0, tools INTEGER DEFAULT 0, forced_tool INTEGER DEFAULT 0,
  status INTEGER NOT NULL, error_type TEXT, error TEXT,
  prompt_tokens INTEGER DEFAULT 0, completion_tokens INTEGER DEFAULT 0, cached_tokens INTEGER DEFAULT 0,
  latency_ms INTEGER, ttft_ms INTEGER, queue_ms INTEGER DEFAULT 0, tps REAL,
  overhead_ms REAL,                 -- mux's own time: total minus the time spent waiting on the model and its load
  tags TEXT, trace_id TEXT, agent TEXT, end_user TEXT,
  cold_start INTEGER DEFAULT 0, fallbacks INTEGER DEFAULT 0, finish_reason TEXT,
  ip TEXT, user_agent TEXT,
  body_req TEXT, body_res TEXT
);
CREATE INDEX IF NOT EXISTS requests_ts ON requests(ts);
CREATE INDEX IF NOT EXISTS requests_tenant_ts ON requests(tenant_id, ts);
CREATE INDEX IF NOT EXISTS requests_model_ts ON requests(model_id, ts);
CREATE INDEX IF NOT EXISTS requests_trace ON requests(trace_id);

-- Lens: an investigation reads a slice of traffic with a local model and writes findings with their evidence.
CREATE TABLE IF NOT EXISTS lens_runs (
  id TEXT PRIMARY KEY, ts INTEGER NOT NULL, status TEXT NOT NULL, title TEXT,
  filters TEXT NOT NULL, criteria TEXT, model_id TEXT, coverage TEXT, findings TEXT DEFAULT '[]',
  duration_ms INTEGER, error TEXT
);

CREATE TABLE IF NOT EXISTS downloads (
  id TEXT PRIMARY KEY,
  catalog_id TEXT, repo TEXT NOT NULL, files TEXT NOT NULL, quant TEXT,
  model_id TEXT, total_bytes INTEGER DEFAULT 0, done_bytes INTEGER DEFAULT 0,
  status TEXT NOT NULL, error TEXT, bps REAL DEFAULT 0,
  started_at INTEGER NOT NULL, finished_at INTEGER
);

CREATE TABLE IF NOT EXISTS benchmarks (
  id TEXT PRIMARY KEY,
  model_id TEXT NOT NULL, ts INTEGER NOT NULL, status TEXT NOT NULL,
  results TEXT DEFAULT '[]', score REAL, tps REAL, prompt_tps REAL, ttft_ms REAL, load_ms INTEGER, error TEXT
);

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL, level TEXT NOT NULL, source TEXT NOT NULL, message TEXT NOT NULL, data TEXT
);
CREATE INDEX IF NOT EXISTS events_ts ON events(ts);

-- Where compute comes from: mux nodes (a Mac running mux, reached over HTTPS) and cloud APIs (OpenAI-compatible).
CREATE TABLE IF NOT EXISTS providers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,                 -- mux | openai | anthropic | openrouter | groq | together | gemini | mistral | deepseek | fireworks | cerebras | custom
  base_url TEXT NOT NULL,
  api_key TEXT,                       -- cloud: the provider's key; mux: the key this gateway holds as a tenant on the node
  admin_token TEXT,                   -- mux: the node's admin token, for syncing and managing its models
  enabled INTEGER DEFAULT 1,
  status TEXT DEFAULT 'unknown',      -- online | offline | error | unknown
  last_seen INTEGER, error TEXT, info TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS system_samples (
  ts INTEGER PRIMARY KEY,
  mem_total_gb REAL, mem_used_gb REAL, mem_free_gb REAL, swap_gb REAL, pressure INTEGER,
  mux_gb REAL, loaded TEXT, cpu REAL, disk_free_gb REAL
);
-- Every 30 s, per model with an instance (here, or on a node as the gateway last saw it).
CREATE TABLE IF NOT EXISTS model_samples (
  ts INTEGER NOT NULL, model_id TEXT NOT NULL, state TEXT, estimate_gb REAL, rss_gb REAL, inflight INTEGER,
  processing INTEGER, deferred INTEGER, prompt_tps REAL, gen_tps REAL, PRIMARY KEY (model_id, ts)
);
-- Every sync, per mux node: reachable or not, how fast, and its memory.
CREATE TABLE IF NOT EXISTS provider_samples (
  ts INTEGER NOT NULL, provider_id TEXT NOT NULL, status TEXT, latency_ms INTEGER, mem_total_gb REAL, mem_free_gb REAL,
  swap_gb REAL, pressure INTEGER, used_gb REAL, budget_gb REAL, loaded INTEGER, PRIMARY KEY (provider_id, ts)
);
-- What the healer saw and did: one row per problem, open until it is fixed.
CREATE TABLE IF NOT EXISTS incidents (
  id TEXT PRIMARY KEY, ts INTEGER NOT NULL, updated_at INTEGER NOT NULL, kind TEXT NOT NULL, subject TEXT NOT NULL,
  severity TEXT NOT NULL, status TEXT NOT NULL, title TEXT NOT NULL, detail TEXT, actions TEXT NOT NULL DEFAULT '[]',
  attempts INTEGER NOT NULL DEFAULT 0, diagnosis TEXT, resolved_at INTEGER
);
CREATE INDEX IF NOT EXISTS incidents_open ON incidents(status, kind, subject);
-- Lens watches: investigations that repeat on a schedule. Mutes: findings someone has seen and does not want again.
CREATE TABLE IF NOT EXISTS lens_watches (
  id TEXT PRIMARY KEY, title TEXT NOT NULL, filters TEXT NOT NULL DEFAULT '{}', criteria TEXT DEFAULT '', every_hours REAL NOT NULL DEFAULT 6,
  use_model INTEGER DEFAULT 1, model_id TEXT, enabled INTEGER DEFAULT 1, last_run INTEGER, last_run_id TEXT, created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS lens_mutes (key TEXT PRIMARY KEY, title TEXT NOT NULL, until INTEGER, created_at INTEGER NOT NULL);
-- The brain: what the assistant and the doctor remember across conversations, one page per thing worth knowing.
CREATE TABLE IF NOT EXISTS brain_pages (
  id TEXT PRIMARY KEY, title TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'note',  -- fact | runbook | decision | preference | incident | note
  subject TEXT DEFAULT '',            -- what it is about: a model, tenant, provider or route id
  body TEXT NOT NULL DEFAULT '', tags TEXT DEFAULT '[]',
  source TEXT DEFAULT 'assistant',    -- assistant | doctor | user
  embedding BLOB, embed_model TEXT,   -- through mux's own embed route, normalised
  recalls INTEGER DEFAULT 0, recalled_at INTEGER,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
-- The assistant's conversations, kept on the server so every device sees them.
CREATE TABLE IF NOT EXISTS assistant_conversations (
  id TEXT PRIMARY KEY, title TEXT NOT NULL, messages TEXT NOT NULL, page TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
`);

/** Columns added after a table first shipped: created on databases that predate them. */
function addColumns(table: string, cols: Record<string, string>) {
  const have = new Set((db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name));
  for (const [name, type] of Object.entries(cols)) if (!have.has(name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${type}`);
}
addColumns("models", { provider_id: "TEXT", cost_in: "REAL DEFAULT 0", cost_out: "REAL DEFAULT 0" });
addColumns("requests", { provider_id: "TEXT", cost_usd: "REAL DEFAULT 0" });
addColumns("tenants", { monthly_usd_budget: "REAL DEFAULT 0" });
addColumns("lens_runs", { scope: "TEXT", watch_id: "TEXT", baseline: "TEXT", resolved: "TEXT DEFAULT '[]'", muted: "INTEGER DEFAULT 0" });

export const now = () => Date.now();
export const json = <T>(s: string | null | undefined, fallback: T): T => {
  if (!s) return fallback;
  try { return JSON.parse(s) as T; } catch { return fallback; }
};

let cache: Settings | null = null;
export function settings(): Settings {
  if (cache) return cache;
  const out = { ...defaultSettings } as Record<string, unknown>;
  for (const row of db.prepare("SELECT key, value FROM settings").all() as { key: string; value: string }[]) {
    if (row.key in out) out[row.key] = json(row.value, out[row.key]);
  }
  return (cache = out as Settings);
}
export function saveSettings(patch: Partial<Settings>) {
  const put = db.prepare("INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value");
  for (const [k, v] of Object.entries(patch)) if (k in defaultSettings) put.run(k, JSON.stringify(v));
  cache = null;
  return settings();
}

export function event(level: "info" | "warn" | "error", source: string, message: string, data?: unknown) {
  db.prepare("INSERT INTO events(ts, level, source, message, data) VALUES(?, ?, ?, ?, ?)").run(now(), level, source, message, data === undefined ? null : JSON.stringify(data));
  const line = `${new Date().toISOString()} ${level.toUpperCase()} [${source}] ${message}`;
  (level === "error" ? console.error : console.log)(line);
}
