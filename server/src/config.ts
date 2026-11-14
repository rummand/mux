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
  /**
   * A token that may only report presence (POST /api/admin/presence/signals): the session helper on a Windows PC runs
   * as the person at it, who should not hold the node's admin token. Unset: only the admin token reports.
   */
  presenceToken: env.MUX_PRESENCE_TOKEN ?? "",
  /** GBrain as mux's brain (gbrain.ts): its token turns it on; mux runs `gbrain serve --http` on this port. */
  gbrainToken: env.MUX_GBRAIN_TOKEN ?? "",
  gbrainBin: env.MUX_GBRAIN_BIN ?? join(homedir(), ".bun/bin/gbrain"),
  gbrainPort: Number(env.MUX_GBRAIN_PORT ?? 3131),
  /** KEY=value lines for GBrain's processes: where mux is, and GBrain's mux key (embed, rerank and chat through mux). */
  gbrainEnvFile: env.MUX_GBRAIN_ENV ?? join(homedir(), ".gbrain/mux.env"),
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
  /** The SearXNG beside mux (Railway's private network): /v1/search asks it; unset, search answers 503. */
  searxngUrl: env.MUX_SEARXNG_URL ?? "",
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
  /** The healer repairs what it finds: restarts, reloads, unloads, prunes, re-joins. */
  selfHeal: true,
  /** What the healer cannot fix goes to the doctor (the assistant, headless), who may make safe changes itself. */
  selfHealAi: true,
  /**
   * When this machine takes work (see presence.ts): "available" — always, as a server does; "away-only" — only while
   * nobody is at it (someone there: only what is already loaded, one at a time); "off" — out of the cluster.
   */
  presenceMode: (env.MUX_PRESENCE_MODE ?? "available") as "available" | "away-only" | "off",
  /** "I'm using this Mac": polite until turned off, or until nobody has been at the machine for 30 minutes. */
  presenceUsing: false,
  /** always-on | desktop | laptop, or auto: a laptop if it has a battery, else always-on when available, else a desktop. */
  nodeClass: "auto" as "auto" | "always-on" | "desktop" | "laptop",
  /** On a gateway: the node whose brain mux uses (its GBrain), so mux has one brain wherever it is asked. "" = the first online node. */
  brainNode: "",
  /** mux runs experiments itself: picks challengers from what it measures and the catalog, splits live traffic, promotes winners (experiments.ts). */
  autoExperiments: true,
  /**
   * Free tiers as a rescue: when every model of a route fails or is out (a node down, all busy), free cloud models of
   * the same kind answer, last — inside the tenant's data border, within their quotas, and only from providers that do
   * not train on free-tier prompts unless freeRescueTraining allows those too.
   */
  freeRescue: true,
  freeRescueTraining: false,
  /**
   * Intent routing on "auto" routes: the model that reads a conversation and picks the route for it (Arch-Router):
   * "arch-router" on the Mac, "mac-studio/arch-router" on a gateway; "" leaves it to the auto route's own scoring.
   */
  intentRouterModel: "",
  /** The page reader (/v1/read): how many reads one tenant may have in flight at once, beside its max_parallel. */
  readerParallel: 8,
  /** The page reader's render mode (/v1/read {render: true}): pages one tenant may render at once, and this machine's browser takes at once. */
  renderParallel: 2,
};
export type Settings = typeof defaultSettings;

for (const d of [home, config.modelsDir, config.logsDir, join(config.logsDir, "models")]) mkdirSync(d, { recursive: true });
