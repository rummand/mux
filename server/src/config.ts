import { homedir } from "node:os";
import { join } from "node:path";
import { mkdirSync } from "node:fs";

const env = process.env;
const home = env.MUX_HOME ?? join(homedir(), ".mux");

export const config = {
  home,
  /** all: gateway and models on this machine; gateway: routes only (Railway), no model processes; node: a provider for gateways. */
  role: (env.MUX_ROLE ?? "all") as "all" | "gateway" | "node",
  /** How this mux names itself to the nodes it joins. */
  name: env.MUX_NAME ?? env.RAILWAY_SERVICE_NAME ?? "local",
  port: Number(env.MUX_PORT ?? env.PORT ?? 7070),
  host: env.MUX_HOST ?? "0.0.0.0",
  /** The dashboard's bearer token. install.sh writes one into ~/.mux/mux.env; dev falls back to "dev". */
  adminToken: env.MUX_ADMIN_TOKEN ?? "dev",
  dbPath: env.MUX_DB ?? join(home, "mux.db"),
  modelsDir: env.MUX_MODELS_DIR ?? join(home, "models"),
  logsDir: join(home, "logs"),
  webDir: env.MUX_WEB_DIR ?? new URL("../../web/dist", import.meta.url).pathname,
  llamaServer: env.MUX_LLAMA_SERVER ?? "/opt/homebrew/bin/llama-server",
  /** A python with mlx-lm installed; MLX models are offered only when it exists. */
  mlxPython: env.MUX_MLX_PYTHON ?? join(home, "mlx-venv/bin/python"),
  /** Ports mux hands its own model servers; all bound to 127.0.0.1. */
  portRange: [Number(env.MUX_PORT_MIN ?? 8200), Number(env.MUX_PORT_MAX ?? 8299)] as const,
  /** Where already-downloaded GGUFs may be found and imported (symlinked, never copied). */
  scanDirs: (env.MUX_SCAN_DIRS ?? [join(homedir(), ".nexus/models/hf/hub"), join(homedir(), ".cache/huggingface/hub"), join(homedir(), ".cache/llama.cpp"), join(homedir(), ".lmstudio/models")].join(":")).split(":"),
  hfToken: env.HF_TOKEN ?? "",
};

/** Defaults for settings the dashboard can change; stored rows in `settings` win. */
export const defaultSettings = {
  memoryBudgetGb: Number(env.MUX_MEMORY_BUDGET_GB ?? 48),
  /** Free memory the Mac keeps for everything else; a load that would go below it is refused. */
  memoryHeadroomGb: 10,
  diskReserveGb: 25,
  keepAliveMin: 20,
  maxLoaded: 4,
  retentionDays: 90,
  /** Unload idle models when macOS reports memory pressure (warn or critical). */
  pressureGuard: true,
  /** Keep request/response bodies (truncated) for every request, not only failed ones. */
  logBodies: false,
  /** The route or model the dashboard's assistant thinks with. */
  assistantModel: "auto",
};
export type Settings = typeof defaultSettings;

for (const d of [home, config.modelsDir, config.logsDir, join(config.logsDir, "models")]) mkdirSync(d, { recursive: true });
