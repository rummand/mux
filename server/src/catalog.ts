import type { Caps, Kind } from "./models.js";
import { RESEARCH } from "./catalog-research.js";
import { NEW_MODELS, PATCHES } from "./catalog-research-2026-11.js";

/**
 * Models mux knows how to fetch and what they are good for. Repos, files and sizes were read off the Hugging Face API
 * on 2026-10-30; caps are estimates (0–10) from each family's published results and size, until a benchmark on this Mac
 * replaces speed and quality with measurements. The advisor can also search Hugging Face live for anything not here.
 */
export interface CatalogEntry {
  id: string; name: string; family: string; kind: Kind;
  repo: string; file: string; mmproj?: string; sizeGb: number;
  params: string; activeParams?: string; arch: string; ctx: number; license: string;
  /** The routes this model suits, in mux's route names. */
  routes: string[];
  caps: Caps;
  /** Context mux gives it by default (KV cache costs memory); the model may support far more. */
  defaultCtx: number;
  extraArgs?: string[];
  notes: string;
  released: string;
  /** The llama.cpp release that first runs this architecture. */
  minLlama?: string;
  /** Published results, with where they come from (mostly the makers' own). */
  benchmarks?: { name: string; value: string | number; url?: string }[];
  /** A newer model that does this one's job better, by the research. */
  supersededBy?: string;
  /** Why to try it carefully: unverified in llama.cpp, or only its maker's numbers. */
  experimental?: string;
  /** What the latest research found about it. */
  research?: string;
}

export const CATALOG: CatalogEntry[] = [
  // ── Tiny / fast: routing, classification, short answers ─────────────────────────────────────────────────────
  { id: "qwen3.5-0.8b", name: "Qwen3.5 0.8B", family: "Qwen3.5", kind: "chat", repo: "unsloth/Qwen3.5-0.8B-GGUF", file: "Qwen3.5-0.8B-Q8_0.gguf", sizeGb: 0.81,
    params: "0.8B", arch: "qwen35", ctx: 262144, license: "apache-2.0", routes: ["fast", "classifier"], defaultCtx: 16384, released: "2026-03",
    caps: { quality: 2.5, speed: 10, tools: 4, code: 2.5, reasoning: 2, multilingual: 4, context: 8 },
    notes: "Smallest useful model: request classification for the auto router, intent detection, yes/no gates. Q8 because tiny models lose most from quantisation." },
  { id: "qwen3.5-2b", name: "Qwen3.5 2B", family: "Qwen3.5", kind: "chat", repo: "unsloth/Qwen3.5-2B-GGUF", file: "Qwen3.5-2B-Q8_0.gguf", sizeGb: 2.01,
    params: "2B", arch: "qwen35", ctx: 262144, license: "apache-2.0", routes: ["fast", "classifier"], defaultCtx: 16384, released: "2026-02",
    caps: { quality: 4, speed: 9.5, tools: 5, code: 4, reasoning: 3.5, multilingual: 5, context: 8 },
    notes: "Fast extraction, tagging, summaries of short text; a better classifier than 0.8B at a little more cost." },
  { id: "qwen3.5-4b", name: "Qwen3.5 4B", family: "Qwen3.5", kind: "chat", repo: "unsloth/Qwen3.5-4B-GGUF", file: "Qwen3.5-4B-Q4_K_M.gguf", mmproj: "mmproj-F16.gguf", sizeGb: 2.74,
    params: "4B", arch: "qwen35", ctx: 262144, license: "apache-2.0", routes: ["fast"], defaultCtx: 32768, released: "2026-03",
    caps: { quality: 5.5, speed: 9, tools: 6.5, code: 5, reasoning: 5, multilingual: 6, vision: 5, context: 8 },
    notes: "The fast lane's default: snappy support replies, JSON extraction, simple tool calls." },
  { id: "gemma-4-e4b", name: "Gemma 4 E4B", family: "Gemma 4", kind: "chat", repo: "unsloth/gemma-4-E4B-it-GGUF", file: "gemma-4-E4B-it-Q4_K_M.gguf", mmproj: "mmproj-F16.gguf", sizeGb: 4.98,
    params: "8B (4B effective)", arch: "gemma4", ctx: 131072, license: "apache-2.0", routes: ["fast", "multilingual"], defaultCtx: 32768, released: "2026-04",
    caps: { quality: 5.5, speed: 8.5, tools: 5.5, code: 5, reasoning: 5, multilingual: 8, vision: 6, context: 7 },
    notes: "Gemma's languages are its strength: a fast model for Danish and other European languages." },
  // ── Mid: the everyday agents ────────────────────────────────────────────────────────────────────────────────
  { id: "qwen3.5-9b", name: "Qwen3.5 9B", family: "Qwen3.5", kind: "chat", repo: "unsloth/Qwen3.5-9B-GGUF", file: "Qwen3.5-9B-Q4_K_M.gguf", mmproj: "mmproj-F16.gguf", sizeGb: 5.68,
    params: "9B", arch: "qwen35", ctx: 262144, license: "apache-2.0", routes: ["fast", "agent"], defaultCtx: 32768, released: "2026-02",
    caps: { quality: 6.5, speed: 8, tools: 7, code: 6.5, reasoning: 6.5, multilingual: 6.5, vision: 6, context: 8 },
    notes: "Small enough to keep loaded all day; good tool calling for its size." },
  { id: "gemma-4-12b", name: "Gemma 4 12B", family: "Gemma 4", kind: "chat", repo: "unsloth/gemma-4-12b-it-GGUF", file: "gemma-4-12b-it-Q4_K_M.gguf", mmproj: "mmproj-F16.gguf", sizeGb: 7.12,
    params: "12B", arch: "gemma4", ctx: 262144, license: "apache-2.0", routes: ["multilingual", "vision"], defaultCtx: 32768, released: "2026-05",
    caps: { quality: 7, speed: 7, tools: 6.5, code: 6, reasoning: 6.5, multilingual: 8.5, vision: 7.5, context: 8 },
    notes: "Customer-facing chat in Danish/English, document and screenshot understanding." },
  { id: "gpt-oss-20b", name: "gpt-oss 20B", family: "gpt-oss", kind: "chat", repo: "unsloth/gpt-oss-20b-GGUF", file: "gpt-oss-20b-Q4_K_M.gguf", sizeGb: 11.62,
    params: "21B", activeParams: "3.6B", arch: "gpt-oss", ctx: 131072, license: "apache-2.0", routes: ["agent", "reasoning", "fast"], defaultCtx: 32768, released: "2025-08",
    caps: { quality: 7, speed: 9, tools: 8, code: 7, reasoning: 8, multilingual: 6, context: 7 },
    notes: "MoE with 3.6B active: very fast for its quality, strong tool use and reasoning, weaker in Danish." },
  { id: "qwen3-vl-8b", name: "Qwen3-VL 8B", family: "Qwen3-VL", kind: "chat", repo: "unsloth/Qwen3-VL-8B-Instruct-GGUF", file: "Qwen3-VL-8B-Instruct-Q4_K_M.gguf", mmproj: "mmproj-F16.gguf", sizeGb: 5.03,
    params: "8B", arch: "qwen3vl", ctx: 262144, license: "apache-2.0", routes: ["vision"], defaultCtx: 32768, released: "2025-10",
    caps: { quality: 6.5, speed: 8, tools: 6, code: 5.5, reasoning: 6, multilingual: 6.5, vision: 8.5, context: 8 },
    notes: "Screenshots, invoices, forms, charts: OCR-grade vision at 8B." },
  // ── Large: quality lanes ────────────────────────────────────────────────────────────────────────────────────
  { id: "qwen3.6-35b-a3b", name: "Qwen3.6 35B-A3B", family: "Qwen3.6", kind: "chat", repo: "unsloth/Qwen3.6-35B-A3B-GGUF", file: "Qwen3.6-35B-A3B-UD-Q4_K_M.gguf", mmproj: "mmproj-F16.gguf", sizeGb: 22.13,
    params: "35B", activeParams: "3B", arch: "qwen35moe", ctx: 262144, license: "apache-2.0", routes: ["agent", "smart", "code"], defaultCtx: 65536, released: "2026-04",
    caps: { quality: 8.3, speed: 8.5, tools: 8.5, code: 8, reasoning: 8, multilingual: 7, vision: 7, context: 9 },
    notes: "Nexus's Atlas model (≈80 tok/s measured here). The best all-round agent per GB on this Mac: MoE speed, big-model quality." },
  { id: "qwen-agentworld-35b-a3b", name: "Qwen AgentWorld 35B-A3B", family: "Qwen3.6", kind: "chat", repo: "unsloth/Qwen-AgentWorld-35B-A3B-GGUF", file: "Qwen-AgentWorld-35B-A3B-UD-Q4_K_M.gguf", sizeGb: 22.13,
    params: "35B", activeParams: "3B", arch: "qwen35moe", ctx: 262144, license: "apache-2.0", routes: ["agent"], defaultCtx: 65536, released: "2026-06",
    caps: { quality: 8.3, speed: 8.5, tools: 9, code: 7.5, reasoning: 8, multilingual: 6.5, context: 9 },
    notes: "Qwen3.6-35B-A3B tuned for multi-step agent work; a challenger for the agent route." },
  { id: "qwen3.8-27b", name: "Qwen3.8 27B", family: "Qwen3.8", kind: "chat", repo: "unsloth/Qwen3.8-27B-GGUF", file: "Qwen3.8-27B-UD-Q4_K_M.gguf", mmproj: "mmproj-F16.gguf", sizeGb: 16.46,
    params: "27B", arch: "qwen35", ctx: 262144, license: "apache-2.0", routes: ["smart", "reasoning", "agent"], defaultCtx: 65536, released: "2026-08",
    caps: { quality: 9, speed: 5, tools: 9, code: 8.5, reasoning: 9, multilingual: 7.5, vision: 7, context: 9 },
    notes: "The newest dense Qwen: the highest quality that fits comfortably, at dense-model speed (expect ~20–25 tok/s)." },
  { id: "gemma-4-26b-a4b", name: "Gemma 4 26B-A4B", family: "Gemma 4", kind: "chat", repo: "unsloth/gemma-4-26B-A4B-it-GGUF", file: "gemma-4-26B-A4B-it-UD-Q4_K_M.gguf", mmproj: "mmproj-F16.gguf", sizeGb: 16.95,
    params: "26B", activeParams: "4B", arch: "gemma4", ctx: 262144, license: "apache-2.0", routes: ["multilingual", "smart", "vision"], defaultCtx: 65536, released: "2026-04",
    caps: { quality: 8, speed: 8, tools: 7.5, code: 7, reasoning: 7.5, multilingual: 9, vision: 8, context: 9 },
    notes: "Best multilingual quality at MoE speed: the Danish customer-facing lane." },
  { id: "gemma-4-31b", name: "Gemma 4 31B", family: "Gemma 4", kind: "chat", repo: "unsloth/gemma-4-31B-it-GGUF", file: "gemma-4-31B-it-Q4_K_M.gguf", mmproj: "mmproj-F16.gguf", sizeGb: 18.32,
    params: "31B", arch: "gemma4", ctx: 262144, license: "apache-2.0", routes: ["multilingual", "smart"], defaultCtx: 32768, released: "2026-04",
    caps: { quality: 8.5, speed: 4.5, tools: 7.5, code: 7.5, reasoning: 8, multilingual: 9, vision: 8, context: 9 },
    notes: "Dense Gemma: slower than the 26B MoE for a little more quality." },
  { id: "qwen3.6-27b", name: "Qwen3.6 27B", family: "Qwen3.6", kind: "chat", repo: "unsloth/Qwen3.6-27B-GGUF", file: "Qwen3.6-27B-Q4_K_M.gguf", mmproj: "mmproj-F16.gguf", sizeGb: 16.82,
    params: "27B", arch: "qwen35", ctx: 262144, license: "apache-2.0", routes: ["smart"], defaultCtx: 65536, released: "2026-04",
    caps: { quality: 8.5, speed: 5, tools: 8.5, code: 8, reasoning: 8.5, multilingual: 7, vision: 7, context: 9 },
    notes: "Superseded by Qwen3.8 27B at the same size; kept for comparison." },
  { id: "glm-4.7-flash", name: "GLM-4.7 Flash", family: "GLM", kind: "chat", repo: "unsloth/GLM-4.7-Flash-GGUF", file: "GLM-4.7-Flash-Q4_K_M.gguf", sizeGb: 18.31,
    params: "30B", activeParams: "3B", arch: "deepseek2", ctx: 202752, license: "mit", routes: ["agent", "code"], defaultCtx: 65536, released: "2026-01",
    caps: { quality: 8, speed: 8, tools: 8.5, code: 8, reasoning: 7.5, multilingual: 6.5, context: 9 },
    notes: "Z.ai's MoE: strong agentic coding and tool use; MIT licence." },
  // ── Code ────────────────────────────────────────────────────────────────────────────────────────────────────
  { id: "qwen3-coder-30b-a3b", name: "Qwen3 Coder 30B-A3B", family: "Qwen3-Coder", kind: "chat", repo: "unsloth/Qwen3-Coder-30B-A3B-Instruct-GGUF", file: "Qwen3-Coder-30B-A3B-Instruct-Q4_K_M.gguf", sizeGb: 18.56,
    params: "30B", activeParams: "3B", arch: "qwen3moe", ctx: 262144, license: "apache-2.0", routes: ["code"], defaultCtx: 65536, released: "2025-07",
    caps: { quality: 7.5, speed: 8.5, tools: 8, code: 8.5, reasoning: 7, multilingual: 5, context: 9 },
    notes: "Fast coding agent; proven tool-call format with coding harnesses (opencode, cline, aider)." },
  { id: "north-mini-code-1.0", name: "North Mini Code 1.0", family: "Cohere North", kind: "chat", repo: "unsloth/North-Mini-Code-1.0-GGUF", file: "North-Mini-Code-1.0-UD-Q4_K_M.gguf", sizeGb: 19.2,
    params: "30B", arch: "cohere2moe", ctx: 500000, license: "apache-2.0", routes: ["code"], defaultCtx: 65536, released: "2026-06",
    caps: { quality: 8, speed: 8, tools: 8, code: 8.5, reasoning: 7.5, multilingual: 6.5, context: 10 },
    notes: "Cohere's coding MoE with a 500k context; a challenger for the code route." },
  { id: "qwen3-coder-next", name: "Qwen3 Coder Next", family: "Qwen3-Coder", kind: "chat", repo: "unsloth/Qwen3-Coder-Next-GGUF", file: "Qwen3-Coder-Next-Q4_K_M.gguf", sizeGb: 48.53,
    params: "80B", activeParams: "3B", arch: "qwen3next", ctx: 262144, license: "apache-2.0", routes: ["code"], defaultCtx: 32768, released: "2026-02",
    caps: { quality: 8.8, speed: 7.5, tools: 8.5, code: 9.3, reasoning: 8, multilingual: 5.5, context: 9 },
    notes: "The strongest local coder, but ~50 GB: it needs mux's whole budget and nothing else loaded." },
  { id: "gpt-oss-120b", name: "gpt-oss 120B", family: "gpt-oss", kind: "chat", repo: "unsloth/gpt-oss-120b-GGUF", file: "Q4_K_M/gpt-oss-120b-Q4_K_M-00001-of-00002.gguf", sizeGb: 62.77,
    params: "117B", activeParams: "5.1B", arch: "gpt-oss", ctx: 131072, license: "apache-2.0", routes: ["reasoning"], defaultCtx: 32768, released: "2025-08",
    caps: { quality: 8.8, speed: 7, tools: 8.5, code: 8.5, reasoning: 9, multilingual: 6.5, context: 7 },
    notes: "Frontier-class open reasoning, but 63 GB: only with the budget raised and the Mac otherwise quiet. Two files." },
  // ── Embeddings ──────────────────────────────────────────────────────────────────────────────────────────────
  { id: "bge-m3", name: "BGE-M3", family: "BGE", kind: "embedding", repo: "gpustack/bge-m3-GGUF", file: "bge-m3-Q8_0.gguf", sizeGb: 0.63,
    params: "568M", arch: "bert", ctx: 8192, license: "mit", routes: ["embed"], defaultCtx: 8192, extraArgs: ["--pooling", "cls"], released: "2024-02",
    caps: { quality: 7.5, speed: 9, multilingual: 9, context: 6 },
    notes: "Multilingual embeddings (Danish included), 1024 dimensions; what Nexus's Finding by meaning uses." },
  { id: "qwen3-embedding-0.6b", name: "Qwen3 Embedding 0.6B", family: "Qwen3-Embedding", kind: "embedding", repo: "Qwen/Qwen3-Embedding-0.6B-GGUF", file: "Qwen3-Embedding-0.6B-Q8_0.gguf", sizeGb: 0.64,
    params: "0.6B", arch: "qwen3", ctx: 32768, license: "apache-2.0", routes: ["embed"], defaultCtx: 8192, extraArgs: ["--pooling", "last"], released: "2025-06",
    caps: { quality: 8, speed: 9, multilingual: 8.5, context: 8 },
    notes: "Higher retrieval scores than BGE-M3 on MTEB, longer inputs, instruction-aware queries." },
];

CATALOG.push(...RESEARCH, ...NEW_MODELS);

// What the 2026-11 research changed about models already here: benchmarks, successors, better uploads, routes.
for (const c of CATALOG) {
  const p = PATCHES[c.id];
  if (!p) continue;
  if (p.benchmarks?.length) c.benchmarks = p.benchmarks;
  if (p.supersededBy) c.supersededBy = p.supersededBy;
  if (p.research) c.research = p.research;
  if (p.repo) { c.repo = p.repo; c.file = p.file ?? c.file; c.sizeGb = p.sizeGb ?? c.sizeGb; }
  if (p.routesRemove) c.routes = c.routes.filter((r) => !p.routesRemove!.includes(r));
  if (p.toolsCap != null) c.caps = { ...c.caps, tools: Math.min(c.caps.tools ?? 10, p.toolsCap) };
}

export const catalogEntry = (id: string) => CATALOG.find((c) => c.id === id);
