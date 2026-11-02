import type { CatalogEntry } from "./catalog.js";

/**
 * The model research of 2026-11-02: what the world uses and rates, verified against the Hugging Face API (every
 * repo, file and size below was read off it). New models, then what changed about the ones already in the catalog —
 * published benchmarks with their sources, what superseded them, better GGUF uploads — and usage rankings beyond
 * Hugging Face (OpenRouter tokens, Ollama pulls). Most benchmark numbers are the makers' own; the advisor weighs them
 * as estimates until a benchmark on this Mac measures the model. Sources: Hugging Face model API (downloads = last 30 days), OpenRouter rankings, Artificial Analysis open-weights models, Artificial Analysis leaderboard, Artificial Analysis Qwen3.8 27B, Artificial Analysis Gemma 4 26B vs Qwen3.5 9B, Artificial Analysis Qwen3.6 35B vs Gemma 4 31B, Ollama library (popular), DFM Mimir v1.5 card (Danish comparison table), Berget.ai Gemma 4 / EuroEval Nordic (secondary), EuroEval leaderboards (not machine-readable; not verified), Nanbeige 4.3 coverage (secondary) ….
 */
export const RESEARCHED = "2026-11-02";

export const NEW_MODELS: CatalogEntry[] = [
 {
  "id": "ornith-1.5-9b",
  "name": "Ornith 1.5 9B",
  "family": "Ornith",
  "kind": "chat",
  "repo": "ornith-ai/Ornith-1.5-9B-GGUF",
  "file": "Ornith-1.5-9B-Q4_K_M.gguf",
  "mmproj": "mmproj-Ornith-1.5-9B-BF16.gguf",
  "sizeGb": 5.78,
  "params": "9.65B",
  "arch": "qwen35",
  "ctx": 262144,
  "license": "mit",
  "released": "2026-08",
  "routes": [
   "agent",
   "code",
   "fast"
  ],
  "caps": {
   "quality": 7,
   "speed": 8,
   "tools": 7.5,
   "code": 8,
   "reasoning": 7.5,
   "multilingual": 6,
   "vision": 5,
   "context": 8
  },
  "defaultCtx": 65536,
  "notes": "Agentic-coding post-train in Qwen3.5-9B shape. Card: SWE-bench Verified 70.6 vs 53.2 for Qwen3.5-9B; Terminal-Bench 2.1 46.2 vs 21.3; MCP-Atlas 54.2. Vendor numbers only. GGUF is no. 5 on HF by 30-day downloads. Card says the Qwen chat template needs a modification for some harnesses. Caps: tools 7.5/code 8: SWE-V 70.6 and MCP-Atlas 54.2 put it near Qwen3.6-35B-A3B (73.4/62.8) at 9B; quality 7 because vendor-only and coding-focused.",
  "benchmarks": [
   {
    "name": "SWE-bench Verified (vendor, OpenHands)",
    "value": "70.6",
    "url": "https://huggingface.co/ornith-ai/Ornith-1.5-9B"
   },
   {
    "name": "Terminal-Bench 2.1 Terminus-2 (vendor)",
    "value": "46.2",
    "url": "https://huggingface.co/ornith-ai/Ornith-1.5-9B"
   },
   {
    "name": "GPQA Diamond (vendor)",
    "value": "86.4",
    "url": "https://huggingface.co/ornith-ai/Ornith-1.5-9B"
   }
  ]
 },
 {
  "id": "nanbeige4.3-33b",
  "name": "Nanbeige4.3 33B",
  "family": "Nanbeige",
  "kind": "chat",
  "repo": "bartowski/Nanbeige_Nanbeige4.3-33B-GGUF",
  "file": "Nanbeige_Nanbeige4.3-33B-Q4_K_M.gguf",
  "sizeGb": 20.79,
  "params": "33.1B",
  "arch": "llama",
  "ctx": 524288,
  "license": "apache-2.0",
  "released": "2026-10",
  "routes": [
   "smart",
   "agent",
   "code"
  ],
  "caps": {
   "quality": 9,
   "speed": 4,
   "tools": 8.5,
   "code": 9,
   "reasoning": 9,
   "multilingual": 5,
   "context": 10
  },
  "defaultCtx": 65536,
  "notes": "Dense 33B on plain llama arch (no special llama.cpp build). Card vs Qwen3.8-27B at max thinking: Terminal-Bench 2.1 80.9 vs 73.0, SWE-Bench Pro 60.3 vs 61.7, Tau3 48.8 vs 48.5, GPQA-D 89.5 vs 89.2. AA v5.0 index 20 (equal to Qwen3.8 27B). Languages en/zh only – not for Danish. Dense 33B will be slower than Qwen3.8 27B. Caps: Ties Qwen3.8 27B on AA v5.0 (20) and beats it on most vendor agent benchmarks; speed 4 for dense 33B; multilingual 5 (en/zh only).",
  "benchmarks": [
   {
    "name": "AA Intelligence Index v5.0",
    "value": "20",
    "url": "https://artificialanalysis.ai/leaderboards/models"
   },
   {
    "name": "Terminal-Bench 2.1 Terminus 2 (vendor)",
    "value": "80.9",
    "url": "https://huggingface.co/Nanbeige/Nanbeige4.3-33B"
   },
   {
    "name": "SWE-Bench Pro (vendor)",
    "value": "60.3",
    "url": "https://huggingface.co/Nanbeige/Nanbeige4.3-33B"
   },
   {
    "name": "Tau3-Bench (vendor)",
    "value": "48.8",
    "url": "https://huggingface.co/Nanbeige/Nanbeige4.3-33B"
   }
  ]
 },
 {
  "id": "granite-4.2-8b",
  "name": "Granite 4.2 8B",
  "family": "Granite",
  "kind": "chat",
  "repo": "ibm-granite/granite-4.2-8b-GGUF",
  "file": "granite-4.2-8b-Q4_K_M.gguf",
  "sizeGb": 5.35,
  "params": "8.8B",
  "arch": "granite",
  "ctx": 131072,
  "license": "apache-2.0",
  "released": "2026-08",
  "routes": [
   "fast",
   "agent"
  ],
  "caps": {
   "quality": 6,
   "speed": 8,
   "tools": 6.5,
   "code": 6,
   "reasoning": 6,
   "multilingual": 5.5,
   "context": 8
  },
  "defaultCtx": 32768,
  "notes": "Replaces granite-4.1-8b (same size, first-party GGUF). Adds native thinking; 128K native, 512K extended. Card columns read as 3B|8B|30B (unlabelled in the scrape): 8B BFCL v4 52.39, τ³ avg 58.06, SWE-V 47.67. AA v5.0 index 5. Danish not in tested languages. Caps: BFCL v4 52 is below Qwen3.5-9B (66.1); keep for enterprise/RAG tone and Apache licence, not as a top agent.",
  "benchmarks": [
   {
    "name": "BFCL v4 (vendor; column inferred)",
    "value": "52.39",
    "url": "https://huggingface.co/ibm-granite/granite-4.2-8b"
   },
   {
    "name": "τ³-bench avg (vendor; column inferred)",
    "value": "58.06",
    "url": "https://huggingface.co/ibm-granite/granite-4.2-8b"
   },
   {
    "name": "AA Intelligence Index v5.0",
    "value": "5",
    "url": "https://artificialanalysis.ai/leaderboards/models"
   }
  ]
 },
 {
  "id": "lfm2.5-24b-a2b",
  "name": "LFM2.5 24B-A2B",
  "family": "LFM2.5",
  "kind": "chat",
  "repo": "LiquidAI/LFM2.5-24B-A2B-GGUF",
  "file": "LFM2.5-24B-A2B-Q4_K_M.gguf",
  "sizeGb": 14.53,
  "params": "24B",
  "activeParams": "2.45B",
  "arch": "lfm2moe",
  "ctx": 131072,
  "license": "lfm1.0",
  "released": "2026-10",
  "routes": [
   "agent",
   "fast"
  ],
  "caps": {
   "quality": 7.5,
   "speed": 9.5,
   "tools": 8,
   "code": 6.5,
   "reasoning": 7.5,
   "multilingual": 6,
   "context": 8
  },
  "defaultCtx": 65536,
  "notes": "Always-thinking MoE with 2.45B active. Vendor: 184 tok/s decode on M5 Max; ~47–50 tok/s on a 32 GB M4 (secondary). Card: BFCLv4 65.01 vs 65.00 for Qwen3.6-35B-A3B, IFEval 96.75, but SWE-V 51.0 vs 66.2. Default tool format is Pythonic calls – ask for JSON in the system prompt or mux's parser must handle it. LFM licence has commercial limits. Danish not in its 16-language list. Caps: Speed 9.5 from 2.45B active at 14.5 GB; tools 8 from BFCLv4 parity with Qwen3.6-35B-A3B; code 6.5 from SWE-V 51.",
  "benchmarks": [
   {
    "name": "BFCLv4 (vendor)",
    "value": "65.01",
    "url": "https://huggingface.co/LiquidAI/LFM2.5-24B-A2B"
   },
   {
    "name": "IFEval (vendor)",
    "value": "96.75",
    "url": "https://huggingface.co/LiquidAI/LFM2.5-24B-A2B"
   },
   {
    "name": "SWE-Bench Verified OpenCode (vendor)",
    "value": "51.00",
    "url": "https://huggingface.co/LiquidAI/LFM2.5-24B-A2B"
   },
   {
    "name": "GPQA Diamond (vendor)",
    "value": "74.42",
    "url": "https://huggingface.co/LiquidAI/LFM2.5-24B-A2B"
   }
  ]
 },
 {
  "id": "minicpm-v-4.7-35b-a3b",
  "name": "MiniCPM-V 4.7 35B-A3B",
  "family": "MiniCPM-V",
  "kind": "chat",
  "repo": "openbmb/MiniCPM-V-4.7-35B-A3B-gguf",
  "file": "MiniCPM-V-4_7-35B-A3B-Q4_K_M.gguf",
  "mmproj": "mmproj-model-f16.gguf",
  "sizeGb": 21.17,
  "params": "34.7B",
  "activeParams": "~3B",
  "arch": "qwen35moe",
  "ctx": 262144,
  "license": "apache-2.0",
  "released": "2026-10",
  "routes": [
   "vision"
  ],
  "caps": {
   "quality": 8,
   "speed": 8,
   "tools": 7,
   "code": 6.5,
   "reasoning": 7.5,
   "multilingual": 6.5,
   "vision": 9,
   "context": 9
  },
  "defaultCtx": 32768,
  "notes": "Vision specialist on the Qwen3.5-MoE backbone (standard qwen35moe arch). OCRBench 91.2 reported by secondary aggregators (UNVERIFIED against the official card, which has few tables). A separate thinking GGUF exists under thinking/. First-party GGUF 324k dl/30d. Caps: Vision 9 on OCRBench ~91 (vs Qwen3.6 27B 89.4 on its card); MoE speed like Qwen3.6-35B-A3B.",
  "benchmarks": [
   {
    "name": "OCRBench (secondary, DataLearner)",
    "value": "91.2 – UNVERIFIED",
    "url": "https://www.datalearner.com/en/ai-models/pretrained-models/minicpm-v-4-7-35b-a3b/analysis"
   },
   {
    "name": "MMMU (secondary)",
    "value": "80.22 – UNVERIFIED",
    "url": "https://ai-bot.cn/minicpm-v-4-7/"
   }
  ]
 },
 {
  "id": "minicpm-ocr-1.0",
  "name": "MiniCPM-OCR 1.0",
  "family": "MiniCPM-V",
  "kind": "chat",
  "repo": "openbmb/MiniCPM-OCR-1.0-gguf",
  "file": "MiniCPM-OCR-1_0-Q8_0.gguf",
  "mmproj": "mmproj-model-f16-4x.gguf",
  "sizeGb": 0.81,
  "params": "1.3B",
  "arch": "qwen35",
  "ctx": 262144,
  "license": "apache-2.0",
  "released": "2026-10",
  "routes": [
   "vision"
  ],
  "caps": {
   "quality": 4,
   "speed": 9.5,
   "tools": 2,
   "code": 2,
   "reasoning": 2.5,
   "multilingual": 4,
   "vision": 8.5,
   "context": 6
  },
  "defaultCtx": 16384,
  "notes": "Document parsing / OCR only (invoices, forms → markdown). Card: 93.68 Real5-OmniDocBench, 54.7 OCRBench v2; llama.cpp and Ollama from day one. Primary languages zh/en – check Danish characters (æøå) on real documents. mmproj file is 0.9 GB on top of the model. Caps: Vision 8.5 for documents (SOTA OmniDocBench claim at 1.3B); not a chat model.",
  "benchmarks": [
   {
    "name": "Real5-OmniDocBench (vendor)",
    "value": "93.68",
    "url": "https://huggingface.co/openbmb/MiniCPM-OCR-1.0"
   },
   {
    "name": "OCRBench v2 (vendor)",
    "value": "54.7",
    "url": "https://huggingface.co/openbmb/MiniCPM-OCR-1.0"
   }
  ]
 },
 {
  "id": "lfm3-vl-2b",
  "name": "LFM3-VL 2B",
  "family": "LFM3",
  "kind": "chat",
  "repo": "LiquidAI/LFM3-VL-2B-GGUF",
  "file": "LFM3-VL-2B-Q8_0.gguf",
  "mmproj": "mmproj-LFM3-VL-2B-F16.gguf",
  "sizeGb": 1.85,
  "params": "1.9B",
  "arch": "lfm3",
  "ctx": 128000,
  "license": "lfm1.0",
  "released": "2026-10",
  "minLlama": "0.8.0 (same lfm3 arch as LFM3-1.7B; unverified)",
  "routes": [
   "vision",
   "fast"
  ],
  "caps": {
   "quality": 4.5,
   "speed": 9.5,
   "tools": 4.5,
   "code": 3,
   "reasoning": 4,
   "multilingual": 5.5,
   "vision": 6.5,
   "context": 7
  },
  "defaultCtx": 16384,
  "notes": "Tiny fast vision lane (screenshots, simple images). No benchmark extracted this pass – caps are estimates from LFM3-1.7B plus size. Trending (score 206 base). LFM licence has commercial limits. Caps: Estimate only; no verified benchmark.",
  "benchmarks": []
 },
 {
  "id": "ternary-bonsai-2-27b",
  "name": "Ternary Bonsai 2 27B",
  "family": "Qwen3.8",
  "kind": "chat",
  "repo": "prism-ml/Ternary-Bonsai-2-27B-gguf",
  "file": "Ternary-Bonsai-2-27B-Q2_0.gguf",
  "mmproj": "Ternary-Bonsai-2-27B-mmproj-Q8_0.gguf",
  "sizeGb": 7.63,
  "params": "27.36B",
  "arch": "qwen35",
  "ctx": 262144,
  "license": "apache-2.0",
  "released": "2026-09",
  "minLlama": "b11556 (Q2_0 on stock llama.cpp; PTQ1_0/PQ2_0 need the PrismML fork)",
  "routes": [
   "smart",
   "agent"
  ],
  "caps": {
   "quality": 7.5,
   "speed": 6,
   "tools": 7.5,
   "code": 7.5,
   "reasoning": 8,
   "multilingual": 6.5,
   "vision": 6.5,
   "context": 9
  },
  "defaultCtx": 65536,
  "notes": "Qwen3.8-27B in ternary weights: 7.63 GB, so a Qwen3.8-class model can stay resident next to others. 1.82M dl/30d, 2,894 likes. Quality loss vs full Qwen3.8 not verified independently. Alternative with tool-calling checks: ConwayResearch/Underdog-Saluki-27B-1.0, Underdog-Saluki-27B-1.0-IQ2-mix.gguf 7.9 GB (card: BFCL v4 parallel 42 vs 35 full size; AIME 2025 79.2 vs 96.7). Caps: Qwen3.8 27B minus ~1–1.5 per cap for 2-bit loss (Saluki shows reasoning drops, tool calls hold); speed 6 because dense 27B, though memory-bound decode is faster at 7.6 GB.",
  "benchmarks": [
   {
    "name": "Underdog Saluki (sibling 2-bit Qwen3.8-27B) BFCL v4 parallel, 100 tasks",
    "value": "42 (full size 35)",
    "url": "https://huggingface.co/ConwayResearch/Underdog-Saluki-27B-1.0"
   },
   {
    "name": "Underdog Saluki AIME 2025",
    "value": "79.2 (full size 96.7)",
    "url": "https://huggingface.co/ConwayResearch/Underdog-Saluki-27B-1.0"
   }
  ]
 },
 {
  "id": "groot-19b-a3b",
  "name": "Groot 19B-A3B (261023)",
  "family": "Qwen3.6",
  "kind": "chat",
  "repo": "bartowski/GrootTeam_Groot-19B-A3B-261023-GGUF",
  "file": "GrootTeam_Groot-19B-A3B-261023-Q4_K_M.gguf",
  "sizeGb": 12.48,
  "params": "19B",
  "activeParams": "~3B",
  "arch": "qwen35moe",
  "ctx": 262144,
  "license": "apache-2.0",
  "released": "2026-10",
  "routes": [
   "agent",
   "code"
  ],
  "caps": {
   "quality": 7.5,
   "speed": 9,
   "tools": 8,
   "code": 8,
   "reasoning": 7.5,
   "multilingual": 6,
   "context": 9
  },
  "defaultCtx": 65536,
  "notes": "Expert-pruned Qwen3.6-35B-A3B (19B total): 12.5 GB instead of 22 GB. Card: Terminal-Bench 2.1 52.10 vs 43.82 (Qwen3.6-35B-A3B) and 26.52 (Gemma-4-26B-A4B); shorter answers. Vendor-only; very new (trending 53), low usage so far. First-party GGUF: GrootTeam/Groot-19B-A3B-261023-GGUF. Caps: Claims ≥ Qwen3.6-35B-A3B on 12/16 benches at ~57% of the memory; discounted for vendor-only, unproven results.",
  "benchmarks": [
   {
    "name": "Terminal-Bench 2.1 Claude Code (vendor)",
    "value": "52.10",
    "url": "https://huggingface.co/GrootTeam/Groot-19B-A3B-261023-GGUF"
   },
   {
    "name": "LongBench v2 (vendor)",
    "value": "62.03",
    "url": "https://huggingface.co/GrootTeam/Groot-19B-A3B-261023-GGUF"
   }
  ],
  "experimental": "vendor numbers only"
 },
 {
  "id": "sage-a1.5",
  "name": "Sage-A1.5",
  "family": "Qwen3.5",
  "kind": "chat",
  "repo": "InternScience/Sage-A1.5-Q4_K_M-GGUF",
  "file": "Sage-A1.5-Q4_K_M.gguf",
  "mmproj": "Sage-A1.5-mmproj.gguf",
  "sizeGb": 21.71,
  "params": "36B",
  "activeParams": "~3B",
  "arch": "qwen35moe",
  "ctx": 262144,
  "license": "apache-2.0",
  "released": "2026-10",
  "routes": [
   "agent",
   "smart"
  ],
  "caps": {
   "quality": 8.3,
   "speed": 8.5,
   "tools": 8.5,
   "code": 8,
   "reasoning": 8,
   "multilingual": 6.5,
   "vision": 7,
   "context": 9
  },
  "defaultCtx": 65536,
  "notes": "Research/orchestration agent (sub-agent delegation) on Qwen3.5-MoE. Card: GAIA 95.1, BrowseComp 81.7, SWE-bench Pro 61.2, OmniDocBench 91.5 – vendor claims. GGUF 387k dl/30d in its first 2 weeks. Caps: SWE-bench Pro 61.2 equals Qwen3.8 27B (61.7) at MoE speed; vendor-only, so held at Qwen3.6-35B-A3B level.",
  "benchmarks": [
   {
    "name": "SWE-bench Pro (vendor)",
    "value": "61.2",
    "url": "https://huggingface.co/InternScience/Sage-A1.5"
   },
   {
    "name": "BrowseComp (vendor)",
    "value": "81.7",
    "url": "https://huggingface.co/InternScience/Sage-A1.5"
   },
   {
    "name": "GAIA (vendor)",
    "value": "95.1",
    "url": "https://huggingface.co/InternScience/Sage-A1.5"
   }
  ],
  "experimental": "vendor numbers only"
 },
 {
  "id": "qwen3-embedding-8b",
  "name": "Qwen3 Embedding 8B",
  "family": "Qwen3-Embedding",
  "kind": "embedding",
  "repo": "Qwen/Qwen3-Embedding-8B-GGUF",
  "file": "Qwen3-Embedding-8B-Q4_K_M.gguf",
  "sizeGb": 4.68,
  "params": "8B",
  "arch": "qwen3",
  "ctx": 32768,
  "license": "apache-2.0",
  "released": "2025-06",
  "routes": [
   "embed"
  ],
  "caps": {
   "quality": 9,
   "speed": 6,
   "multilingual": 9,
   "context": 8
  },
  "defaultCtx": 8192,
  "extraArgs": [
   "--pooling",
   "last"
  ],
  "notes": "Top-quality embed tier; 4096-d. Card table (same as 0.6B card): MTEB Multilingual ~70.6 (UNVERIFIED this pass – only 0.6B/4B rows were extracted). 2.13M base dl/30d. Older release, but no newer open embedding beats it at ≤8B on the evidence gathered except harrier-oss-v1-27b (too big). Caps: 4B already scores 69.45 MMTEB; 8B is the family top.",
  "benchmarks": [
   {
    "name": "MTEB Multilingual mean (vendor)",
    "value": "~70.58 – UNVERIFIED this pass",
    "url": "https://huggingface.co/Qwen/Qwen3-Embedding-8B"
   }
  ]
 },
 {
  "id": "harrier-oss-v1-0.6b",
  "name": "Harrier OSS v1 0.6B",
  "family": "Harrier",
  "kind": "embedding",
  "repo": "mradermacher/harrier-oss-v1-0.6b-GGUF",
  "file": "harrier-oss-v1-0.6b.Q8_0.gguf",
  "sizeGb": 0.64,
  "params": "0.6B",
  "arch": "qwen3",
  "ctx": 32768,
  "license": "mit",
  "released": "2026-03",
  "routes": [
   "embed"
  ],
  "caps": {
   "quality": 8.5,
   "speed": 9,
   "multilingual": 9,
   "context": 8
  },
  "defaultCtx": 8192,
  "extraArgs": [
   "--pooling",
   "last"
  ],
  "notes": "Microsoft multilingual embedding, Danish explicitly listed. Card: MTEB v2 69.0 (vs 64.33 MMTEB for Qwen3-Embedding-0.6B – check same benchmark version). Same Qwen3 arch as qwen3-embedding-0.6b, so drop-in for llama.cpp; pooling assumed 'last' (UNVERIFIED – check card's sentence-transformers config). Only community GGUFs (low usage). 270M sibling scores 66.5. Caps: Highest multilingual MTEB claim at 0.6B among verified entries (69.0 vs 64.3 Qwen3-Emb-0.6B, 61.4 EmbeddingGemma 2, 59.6 BGE-M3).",
  "benchmarks": [
   {
    "name": "MTEB v2 (multilingual) score (vendor)",
    "value": "69.0",
    "url": "https://huggingface.co/microsoft/harrier-oss-v1-0.6b"
   }
  ],
  "experimental": "pooling assumed \"last\"; check its embeddings before using it"
 },
 {
  "id": "granite-embedding-311m-multilingual-r2",
  "name": "Granite Embedding 311M Multilingual R2",
  "family": "Granite",
  "kind": "embedding",
  "repo": "mykor/granite-embedding-311m-multilingual-r2-GGUF",
  "file": "granite-embedding-311M-multilingual-r2-Q8_0.gguf",
  "sizeGb": 0.35,
  "params": "311M",
  "arch": "modern-bert",
  "ctx": 32768,
  "license": "apache-2.0",
  "released": "2026-04",
  "routes": [
   "embed"
  ],
  "caps": {
   "quality": 7.5,
   "speed": 10,
   "multilingual": 8.5,
   "context": 8
  },
  "defaultCtx": 8192,
  "extraArgs": [
   "--pooling",
   "cls"
  ],
  "notes": "ModernBERT, CLS pooling (card), Danish among the 52 enhanced languages, commercial-clean training data. Card: 65.2 MTEB Multilingual Retrieval, ~1,800 docs/s on H100. GGUF here is community (GGUF metadata says ctx 8192). Needs llama.cpp with modern-bert arch (version UNVERIFIED). Caps: Fastest credible multilingual embedder (311M) with retrieval score above BGE-M3.",
  "benchmarks": [
   {
    "name": "MTEB Multilingual Retrieval (18) (vendor)",
    "value": "65.2",
    "url": "https://huggingface.co/ibm-granite/granite-embedding-311m-multilingual-r2"
   }
  ]
 },
 {
  "id": "qwen3-reranker-4b",
  "name": "Qwen3 Reranker 4B",
  "family": "Qwen3-Reranker",
  "kind": "rerank",
  "repo": "gorse-io/Qwen3-Reranker-4B-GGUF",
  "file": "Qwen3-Reranker-4B-Q4_K_M.gguf",
  "sizeGb": 2.5,
  "params": "4B",
  "arch": "qwen3",
  "ctx": 32768,
  "license": "apache-2.0",
  "released": "2025-06",
  "routes": [
   "rerank"
  ],
  "caps": {
   "quality": 9,
   "speed": 7,
   "multilingual": 9,
   "context": 8
  },
  "defaultCtx": 8192,
  "extraArgs": [
   "--rerank"
  ],
  "notes": "Vendor card: MMTEB-R 72.74 vs 66.36 for the 0.6B already in catalog; MTEB-Code 81.20. 2.45M base dl/30d. Community GGUF – confirm it was converted with the reranker head for llama.cpp --rerank (alternative: Voodisss/Qwen3-Reranker-4B-GGUF-llama_cpp, same file name/size, 13.6k dl). Caps: +6 points over the 0.6B reranker on multilingual retrieval at 2.5 GB.",
  "benchmarks": [
   {
    "name": "MMTEB-R (vendor)",
    "value": "72.74",
    "url": "https://huggingface.co/Qwen/Qwen3-Reranker-0.6B"
   },
   {
    "name": "MTEB-R (vendor)",
    "value": "69.76",
    "url": "https://huggingface.co/Qwen/Qwen3-Reranker-0.6B"
   }
  ]
 },
 {
  "id": "nemotron-3.5-rerank-8b",
  "name": "Nemotron 3.5 Rerank 8B",
  "family": "Nemotron",
  "kind": "rerank",
  "repo": "netprojects/Nemotron-3.5-Rerank-8B-GGUF",
  "file": "Nemotron-3.5-Rerank-8B-rank-Q4_K_M.gguf",
  "sizeGb": 4.9,
  "params": "8.38B",
  "arch": "mistral3",
  "ctx": 32768,
  "license": "openmdw-1.1",
  "released": "2026-10",
  "routes": [
   "rerank"
  ],
  "caps": {
   "quality": 9,
   "speed": 6,
   "multilingual": 9,
   "context": 8
  },
  "defaultCtx": 8192,
  "extraArgs": [
   "--rerank"
  ],
  "notes": "Multimodal (text+image) reranker on Ministral-3-8B; Danish listed. Card: SOTA on ViDoRe v3.1 reranking (2026-10-20). EXPERIMENTAL for mux: only a 1-day-old community GGUF (335 dl); whether llama.cpp --rerank handles this seq-cls head correctly is UNVERIFIED. Watch for an official GGUF. Caps: Newest SOTA reranker claim; capped by GGUF/llama.cpp uncertainty.",
  "benchmarks": [
   {
    "name": "ViDoRe v3.1 Reranking",
    "value": "#1 as of 2026-10-20 (vendor)",
    "url": "https://huggingface.co/nvidia/Nemotron-3.5-Rerank-8B-BF16"
   }
  ],
  "experimental": "only a day-old community GGUF; check it ranks with mux's rerank route before trusting it"
 },
 {
  "id": "dfm-mimir-v1.5",
  "name": "DFM Mimir v1.5",
  "family": "DFM",
  "kind": "chat",
  "repo": "danish-foundation-models/DFM-Mimir-v1.5-GGUF",
  "file": "dfm-mimir-v1.5-q8_0.gguf",
  "sizeGb": 1.91,
  "params": "1.79B (0.98B non-embedding)",
  "arch": "hrm_text",
  "ctx": 4096,
  "license": "apache-2.0",
  "released": "2026-09",
  "minLlama": "UNVERIFIED – hrm_text arch; test before use",
  "routes": [
   "danish",
   "fast",
   "classifier"
  ],
  "caps": {
   "quality": 4.5,
   "speed": 9.5,
   "tools": 3,
   "code": 2.5,
   "reasoning": 3.5,
   "multilingual": 6,
   "context": 3
  },
  "defaultCtx": 4096,
  "notes": "Danish Foundation Models' own Danish/English model. Its card's 10-task Danish mean: 62.97 vs Gemma 4 E4B 53.58, Qwen3.5 9B 53.05, Qwen3.5 4B 49.82 – the best small Danish score on the evidence found, but self-reported, 4K context, and low usage (4.7k dl). Good for Danish classification/short replies, not agents. Caps: Multilingual 6 (excellent Danish, English only otherwise); context 3 for 4K.",
  "benchmarks": [
   {
    "name": "Danish mean, 10 tasks (vendor; AngryTweets, DaLA, ScaLA-style)",
    "value": "62.97",
    "url": "https://huggingface.co/danish-foundation-models/DFM-Mimir-v1.5"
   }
  ],
  "experimental": "unusual architecture and a 4K context; check llama.cpp loads it"
 }
];

export interface CatalogPatch {
  benchmarks?: { name: string; value: string | number; url?: string }[]; supersededBy?: string; research?: string;
  hf?: Record<string, number | string | null>; repo?: string; file?: string; sizeGb?: number; routesRemove?: string[]; toolsCap?: number;
}

export const PATCHES: Record<string, CatalogPatch> = {
 "qwen3.5-0.8b": {
  "benchmarks": [
   {
    "name": "BFCL-V4 (vendor)",
    "value": "25.3",
    "url": "https://huggingface.co/Qwen/Qwen3.5-2B"
   },
   {
    "name": "TAU2-Bench (vendor)",
    "value": "11.6",
    "url": "https://huggingface.co/Qwen/Qwen3.5-2B"
   },
   {
    "name": "MMLU-Pro non-thinking (vendor)",
    "value": "29.7",
    "url": "https://huggingface.co/Qwen/Qwen3.5-2B"
   },
   {
    "name": "Danish mean, 10 EuroEval-style tasks (DFM Mimir card)",
    "value": "30.89",
    "url": "https://huggingface.co/danish-foundation-models/DFM-Mimir-v1.5"
   }
  ],
  "research": "Weak tool caller; fine as a classifier. No Qwen3.8 small sizes exist on HF (checked Qwen org listing 2026-11-02).",
  "hf": {
   "downloads30d": 3693505,
   "likes": 793,
   "ggufRepo": "unsloth/Qwen3.5-0.8B-GGUF",
   "ggufDownloads30d": 302763,
   "ggufLikes": 246
  }
 },
 "qwen3.5-2b": {
  "benchmarks": [
   {
    "name": "BFCL-V4 (vendor)",
    "value": "43.6",
    "url": "https://huggingface.co/Qwen/Qwen3.5-2B"
   },
   {
    "name": "TAU2-Bench (vendor)",
    "value": "48.8",
    "url": "https://huggingface.co/Qwen/Qwen3.5-2B"
   },
   {
    "name": "MMLU-Pro non-thinking (vendor)",
    "value": "55.3",
    "url": "https://huggingface.co/Qwen/Qwen3.5-2B"
   },
   {
    "name": "Danish mean (DFM Mimir card)",
    "value": "32.73",
    "url": "https://huggingface.co/danish-foundation-models/DFM-Mimir-v1.5"
   },
   {
    "name": "BFCL v4 per MiniCPM5 card",
    "value": "43.6",
    "url": "https://huggingface.co/openbmb/MiniCPM5-2B"
   }
  ],
  "research": "MiniCPM5-2B (already in catalog) reports BFCL v4 66.6 vs 43.6 for this model on its own card; LFM3-1.7B also claims to beat it.",
  "hf": {
   "downloads30d": 3402183,
   "likes": 465,
   "ggufRepo": "unsloth/Qwen3.5-2B-GGUF",
   "ggufDownloads30d": 428437,
   "ggufLikes": 168
  }
 },
 "qwen3.5-4b": {
  "benchmarks": [
   {
    "name": "BFCL-V4 (vendor)",
    "value": "50.3",
    "url": "https://huggingface.co/Qwen/Qwen3.5-9B"
   },
   {
    "name": "TAU2-Bench (vendor)",
    "value": "79.9",
    "url": "https://huggingface.co/Qwen/Qwen3.5-9B"
   },
   {
    "name": "GPQA Diamond (vendor)",
    "value": "76.2",
    "url": "https://huggingface.co/Qwen/Qwen3.5-9B"
   },
   {
    "name": "BFCL-v3 (NVIDIA Bolt-E4B card)",
    "value": "70.95",
    "url": "https://huggingface.co/nvidia/NVIDIA-Nemotron-3.5-Bolt-E4B-BF16"
   },
   {
    "name": "Danish mean (DFM Mimir card)",
    "value": "49.82",
    "url": "https://huggingface.co/danish-foundation-models/DFM-Mimir-v1.5"
   }
  ],
  "research": "Still one of the most downloaded small GGUFs (unsloth repo 1.33M/30d). Ollama 'qwen3.5' 24.1M pulls.",
  "hf": {
   "downloads30d": 6376702,
   "likes": 1181,
   "ggufRepo": "unsloth/Qwen3.5-4B-GGUF",
   "ggufDownloads30d": 1334288,
   "ggufLikes": 533
  }
 },
 "gemma-4-e4b": {
  "benchmarks": [
   {
    "name": "Tau2 avg (Google card)",
    "value": "42.2%",
    "url": "https://huggingface.co/google/gemma-4-31B-it"
   },
   {
    "name": "MMMLU (Google card)",
    "value": "76.6%",
    "url": "https://huggingface.co/google/gemma-4-31B-it"
   },
   {
    "name": "BFCL-v3 (NVIDIA Bolt-E4B card)",
    "value": "66.39",
    "url": "https://huggingface.co/nvidia/NVIDIA-Nemotron-3.5-Bolt-E4B-BF16"
   },
   {
    "name": "Danish mean (DFM Mimir card)",
    "value": "53.58 (54.53 thinking)",
    "url": "https://huggingface.co/danish-foundation-models/DFM-Mimir-v1.5"
   }
  ],
  "research": "Best small Danish in the DFM table among stock models (ties Qwen3.5 9B). Nemotron-3.5-Bolt-E4B (in catalog) is the tool-use-tuned version: Tau2 55.1 vs 38.5. Google also ships a first-party QAT GGUF google/gemma-4-E4B-it-qat-q4_0-gguf (1.17M dl/30d).",
  "hf": {
   "downloads30d": 4128512,
   "likes": 1820,
   "ggufRepo": "unsloth/gemma-4-E4B-it-GGUF",
   "ggufDownloads30d": 581312,
   "ggufLikes": 676
  }
 },
 "qwen3.5-9b": {
  "benchmarks": [
   {
    "name": "BFCL-V4 (vendor)",
    "value": "66.1",
    "url": "https://huggingface.co/Qwen/Qwen3.5-9B"
   },
   {
    "name": "TAU2-Bench (vendor)",
    "value": "79.1",
    "url": "https://huggingface.co/Qwen/Qwen3.5-9B"
   },
   {
    "name": "GPQA Diamond (vendor)",
    "value": "81.7",
    "url": "https://huggingface.co/Qwen/Qwen3.5-9B"
   },
   {
    "name": "MMMLU (vendor)",
    "value": "81.2",
    "url": "https://huggingface.co/Qwen/Qwen3.5-9B"
   },
   {
    "name": "AA Intelligence Index v4.1.1 (reasoning)",
    "value": "22",
    "url": "https://artificialanalysis.ai/models/releases/comparisons/gemma-4-26b-a4b-vs-qwen3-5-9b"
   },
   {
    "name": "Danish mean (DFM Mimir card)",
    "value": "53.05",
    "url": "https://huggingface.co/danish-foundation-models/DFM-Mimir-v1.5"
   },
   {
    "name": "SWE-bench Verified (Ornith card)",
    "value": "53.2",
    "url": "https://huggingface.co/ornith-ai/Ornith-1.5-9B"
   }
  ],
  "supersededBy": "ornith-1.5-9b (for agent/code; same qwen35 arch and size)",
  "research": "Ornith-1.5-9B is a Qwen3.5-9B-class post-train reporting SWE-bench Verified 70.6 vs 53.2 and Terminal-Bench 2.1 46.2 vs 21.3 (vendor). Keep Qwen3.5-9B for general/Danish chat.",
  "hf": {
   "downloads30d": 6412961,
   "likes": 2295,
   "ggufRepo": "unsloth/Qwen3.5-9B-GGUF",
   "ggufDownloads30d": 1597726,
   "ggufLikes": 1056
  }
 },
 "gemma-4-12b": {
  "benchmarks": [
   {
    "name": "Tau2 avg (Google card)",
    "value": "69.0%",
    "url": "https://huggingface.co/google/gemma-4-31B-it"
   },
   {
    "name": "GPQA Diamond (Google card)",
    "value": "78.8%",
    "url": "https://huggingface.co/google/gemma-4-31B-it"
   },
   {
    "name": "MMMLU (Google card)",
    "value": "83.4%",
    "url": "https://huggingface.co/google/gemma-4-31B-it"
   },
   {
    "name": "LiveCodeBench v6 (Google card)",
    "value": "72.0%",
    "url": "https://huggingface.co/google/gemma-4-31B-it"
   }
  ],
  "research": "unsloth GGUF 2.08M dl/30d: among the 25 most downloaded GGUF repos on HF. Google also ships google/gemma-4-12B-it-qat-q4_0-gguf (1.05M dl/30d).",
  "hf": {
   "downloads30d": 1718827,
   "likes": 1711,
   "ggufRepo": "unsloth/gemma-4-12b-it-GGUF",
   "ggufDownloads30d": 2079952,
   "ggufLikes": 946
  }
 },
 "gpt-oss-20b": {
  "benchmarks": [
   {
    "name": "GPQA Diamond (Qwen3.5 card comparison)",
    "value": "71.5",
    "url": "https://huggingface.co/Qwen/Qwen3.5-9B"
   },
   {
    "name": "SWE-bench Verified (GLM-4.7-Flash card comparison)",
    "value": "34.0",
    "url": "https://huggingface.co/zai-org/GLM-4.7-Flash"
   },
   {
    "name": "τ²-Bench (GLM-4.7-Flash card comparison)",
    "value": "47.7",
    "url": "https://huggingface.co/zai-org/GLM-4.7-Flash"
   },
   {
    "name": "AA output speed (High)",
    "value": "178 tok/s (API)",
    "url": "https://artificialanalysis.ai/models/gpt-oss-20b"
   }
  ],
  "research": "Old (2025-08) but still heavily used: 5.9M base dl/30d, Ollama gpt-oss 14.5M pulls. AA v5.0 shows no index score for it. On tool benchmarks it now trails Qwen3.5-9B and the 30B-A3B MoEs.",
  "hf": {
   "downloads30d": 5939725,
   "likes": 5263,
   "ggufRepo": "unsloth/gpt-oss-20b-GGUF",
   "ggufDownloads30d": 581293,
   "ggufLikes": 897
  }
 },
 "qwen3-vl-8b": {
  "supersededBy": "qwen3.5-9b / minicpm-v-4.7-35b-a3b (partially)",
  "research": "No benchmark verified this pass. Qwen3.5/3.6/3.8 are natively multimodal (OCRBench 89–90 at 27B–35B per Qwen3.6-27B card), so a separate 8B VL model is less needed. Note first-party Qwen/Qwen3-VL-8B-Instruct-GGUF has 1.47M dl/30d vs 0.22M for unsloth.",
  "hf": {
   "downloads30d": 6915010,
   "likes": 1236,
   "ggufRepo": "unsloth/Qwen3-VL-8B-Instruct-GGUF",
   "ggufDownloads30d": 217523,
   "ggufLikes": 100
  }
 },
 "qwen3.6-35b-a3b": {
  "benchmarks": [
   {
    "name": "SWE-bench Verified (vendor)",
    "value": "73.4",
    "url": "https://huggingface.co/Qwen/Qwen3.6-35B-A3B"
   },
   {
    "name": "Terminal-Bench 2.0 (vendor)",
    "value": "51.5",
    "url": "https://huggingface.co/Qwen/Qwen3.6-35B-A3B"
   },
   {
    "name": "GPQA (vendor)",
    "value": "86.0",
    "url": "https://huggingface.co/Qwen/Qwen3.6-35B-A3B"
   },
   {
    "name": "AA Intelligence Index v4.1 (reasoning)",
    "value": "32",
    "url": "https://artificialanalysis.ai/models/comparisons/qwen3-6-35b-a3b-vs-gemma-4-31b"
   },
   {
    "name": "BFCLv4 (LFM2.5-24B card comparison)",
    "value": "65.00",
    "url": "https://huggingface.co/LiquidAI/LFM2.5-24B-A2B"
   }
  ],
  "research": "Still the base most agent fine-tunes start from (Occamy, Groot, MemT, Sage-like). Ollama qwen3.6 7.4M pulls. MTP GGUF (unsloth/Qwen3.6-35B-A3B-MTP-GGUF, 1.58M dl/30d) is more downloaded than the plain one.",
  "hf": {
   "downloads30d": 4555162,
   "likes": 3068,
   "ggufRepo": "unsloth/Qwen3.6-35B-A3B-GGUF",
   "ggufDownloads30d": 1410978,
   "ggufLikes": 1759
  }
 },
 "qwen-agentworld-35b-a3b": {
  "benchmarks": [
   {
    "name": "AgentWorldBench overall (vendor)",
    "value": "56.39",
    "url": "https://huggingface.co/Qwen/Qwen-AgentWorld-35B-A3B"
   }
  ],
  "research": "CAUTION: the card describes it as 'a native language world model trained for agentic environment simulation' – i.e. it simulates environments/tool results, not an agent policy. Its AgentWorldBench is a world-model benchmark. Low base usage (9.5k dl/30d). Likely mis-routed as an agent; consider demoting from the agent route.",
  "hf": {
   "downloads30d": 9546,
   "likes": 743,
   "ggufRepo": "unsloth/Qwen-AgentWorld-35B-A3B-GGUF",
   "ggufDownloads30d": 211826,
   "ggufLikes": 253
  },
  "routesRemove": [
   "agent"
  ],
  "toolsCap": 5
 },
 "qwen3.8-27b": {
  "benchmarks": [
   {
    "name": "AA Intelligence Index (xhigh, older index version)",
    "value": "52",
    "url": "https://artificialanalysis.ai/models/qwen3-8-27b"
   },
   {
    "name": "AA Intelligence Index v5.0 (xhigh)",
    "value": "20 (only <40B open model scored on v5.0)",
    "url": "https://artificialanalysis.ai/models/open-source"
   },
   {
    "name": "Terminal-Bench 2.1 Terminus (vendor)",
    "value": "73.0",
    "url": "https://huggingface.co/Qwen/Qwen3.8-27B"
   },
   {
    "name": "SWE-bench Pro (vendor)",
    "value": "61.7",
    "url": "https://huggingface.co/Qwen/Qwen3.8-27B"
   },
   {
    "name": "GPQA Diamond (vendor)",
    "value": "89.2",
    "url": "https://huggingface.co/Qwen/Qwen3.8-27B"
   },
   {
    "name": "OmniDocBench 1.5 (vendor)",
    "value": "91.1",
    "url": "https://huggingface.co/Qwen/Qwen3.8-27B"
   }
  ],
  "research": "The single most used open model of its size class: base 7.9M dl/30d and 19k likes; unsloth GGUF 6.1M dl/30d (no. 4 GGUF repo on HF by downloads); dozens of derivative GGUFs (GSQ-RCO, ternary, MTP, abliterated). Ollama qwen3.8 5.6M pulls. AA: very verbose (≈160M tokens for index vs 43M median).",
  "hf": {
   "downloads30d": 7915637,
   "likes": 18993,
   "ggufRepo": "unsloth/Qwen3.8-27B-GGUF",
   "ggufDownloads30d": 6083526,
   "ggufLikes": 5471
  }
 },
 "gemma-4-26b-a4b": {
  "benchmarks": [
   {
    "name": "AA Intelligence Index v4.1.1 (reasoning)",
    "value": "26",
    "url": "https://artificialanalysis.ai/models/releases/comparisons/gemma-4-26b-a4b-vs-qwen3-5-9b"
   },
   {
    "name": "Tau2 avg (Google card)",
    "value": "68.2%",
    "url": "https://huggingface.co/google/gemma-4-31B-it"
   },
   {
    "name": "MMMLU (Google card)",
    "value": "86.3%",
    "url": "https://huggingface.co/google/gemma-4-31B-it"
   },
   {
    "name": "SWE-bench Verified (Qwen3.6 card comparison)",
    "value": "17.4",
    "url": "https://huggingface.co/Qwen/Qwen3.6-35B-A3B"
   }
  ],
  "research": "Danish lane choice stands (Gemma family is consistently reported best on EuroEval Nordic among open models), but it is weak at agentic coding.",
  "hf": {
   "downloads30d": 5944935,
   "likes": 1726,
   "ggufRepo": "unsloth/gemma-4-26B-A4B-it-GGUF",
   "ggufDownloads30d": 1510688,
   "ggufLikes": 1263
  }
 },
 "gemma-4-31b": {
  "benchmarks": [
   {
    "name": "AA Intelligence Index v4.1 (reasoning)",
    "value": "29–30 (pages disagree)",
    "url": "https://artificialanalysis.ai/models/comparisons/qwen3-6-35b-a3b-vs-gemma-4-31b"
   },
   {
    "name": "Tau2 avg (Google card)",
    "value": "76.9%",
    "url": "https://huggingface.co/google/gemma-4-31B-it"
   },
   {
    "name": "MMMLU (Google card)",
    "value": "88.4%",
    "url": "https://huggingface.co/google/gemma-4-31B-it"
   },
   {
    "name": "GPQA Diamond (Google card)",
    "value": "84.3%",
    "url": "https://huggingface.co/google/gemma-4-31B-it"
   },
   {
    "name": "EuroEval Nordic",
    "value": "reported 1st among open-weights models in each Nordic language (secondary: Berget.ai) / 2nd on Danish (secondary: Reddit snapshot Apr 2026) – UNVERIFIED",
    "url": "https://berget.ai/en/blog/gemma-4-general-availability"
   }
  ],
  "research": "Base repo 8.1M dl/30d (most downloaded Gemma 4). Best documented Danish candidate.",
  "hf": {
   "downloads30d": 8147734,
   "likes": 4271,
   "ggufRepo": "unsloth/gemma-4-31B-it-GGUF",
   "ggufDownloads30d": 320820,
   "ggufLikes": 665
  }
 },
 "qwen3.6-27b": {
  "benchmarks": [
   {
    "name": "SWE-bench Verified (vendor)",
    "value": "77.2",
    "url": "https://huggingface.co/Qwen/Qwen3.6-27B"
   },
   {
    "name": "Terminal-Bench 2.0 (vendor)",
    "value": "59.3",
    "url": "https://huggingface.co/Qwen/Qwen3.6-27B"
   },
   {
    "name": "Terminal-Bench 2.1 (Qwen3.8 card)",
    "value": "63.4",
    "url": "https://huggingface.co/Qwen/Qwen3.8-27B"
   }
  ],
  "supersededBy": "qwen3.8-27b",
  "research": "Superseded (Qwen3.8 27B: TB2.1 73.0 vs 63.4, SWE-bench Pro 61.7 vs 53.5). Usage collapsed: unsloth GGUF 0.31M vs 6.1M for 3.8.",
  "hf": {
   "downloads30d": 2263609,
   "likes": 2342,
   "ggufRepo": "unsloth/Qwen3.6-27B-GGUF",
   "ggufDownloads30d": 308067,
   "ggufLikes": 975
  }
 },
 "glm-4.7-flash": {
  "benchmarks": [
   {
    "name": "SWE-bench Verified (vendor)",
    "value": "59.2",
    "url": "https://huggingface.co/zai-org/GLM-4.7-Flash"
   },
   {
    "name": "τ²-Bench (vendor)",
    "value": "79.5",
    "url": "https://huggingface.co/zai-org/GLM-4.7-Flash"
   },
   {
    "name": "GPQA (vendor)",
    "value": "75.2",
    "url": "https://huggingface.co/zai-org/GLM-4.7-Flash"
   },
   {
    "name": "AA Intelligence Index v4.0 (secondary)",
    "value": "30",
    "url": "https://localairig.pages.dev/blog/llm-leaderboard-2026"
   }
  ],
  "supersededBy": "qwen3.6-35b-a3b / ornith-1.5-35b-a3b (code)",
  "research": "GLM-5.3-Flash (Aug 2026) is the successor but is 321B params – not local. Within 30B-A3B the Qwen3.6-based models now lead (SWE-V 73–79).",
  "hf": {
   "downloads30d": 951991,
   "likes": 1891,
   "ggufRepo": "unsloth/GLM-4.7-Flash-GGUF",
   "ggufDownloads30d": 248568,
   "ggufLikes": 741
  }
 },
 "qwen3-coder-30b-a3b": {
  "benchmarks": [
   {
    "name": "SWE-bench Verified (Qwen blog, 2025; not re-verified)",
    "value": "51.6 – UNVERIFIED this pass",
    "url": "https://qwenlm.github.io/blog/qwen3-coder/"
   }
  ],
  "supersededBy": "ornith-1.5-35b-a3b / qwen3.6-35b-a3b",
  "research": "Effectively superseded for agentic coding by same-size Qwen3.6-35B-A3B (SWE-V 73.4) and Ornith-1.5-35B-A3B (79). Still popular: ggml-org re-published a GGUF on 2026-10-22; Ollama qwen3-coder 10.6M pulls.",
  "hf": {
   "downloads30d": 1126184,
   "likes": 1316,
   "ggufRepo": "unsloth/Qwen3-Coder-30B-A3B-Instruct-GGUF",
   "ggufDownloads30d": 481010,
   "ggufLikes": 1198
  }
 },
 "north-mini-code-1.0": {
  "benchmarks": [
   {
    "name": "SWE-bench Verified pass@1 SWE-Agent (secondary, citing Cohere)",
    "value": "67.6",
    "url": "https://opencode.ai/data/cohere/north-mini-code-1-0.md"
   },
   {
    "name": "SWE-bench Verified pass@1 mini-SWE-agent (secondary)",
    "value": "61.0",
    "url": "https://www.llmreference.com/model/north-mini-code-1.0"
   }
  ],
  "research": "Low base usage (8k dl/30d). AA lists it without an index score.",
  "hf": {
   "downloads30d": 8061,
   "likes": 585,
   "ggufRepo": "unsloth/North-Mini-Code-1.0-GGUF",
   "ggufDownloads30d": 241939,
   "ggufLikes": 148
  }
 },
 "qwen3-coder-next": {
  "benchmarks": [
   {
    "name": "SWE-bench Verified SWE-Agent (secondary)",
    "value": "70.6",
    "url": "https://dev.to/thousand_miles_ai/qwen3-coder-next-80b-total-3b-active-706-on-swe-bench-2g5o"
   },
   {
    "name": "SWE-bench Pro (secondary)",
    "value": "44.3",
    "url": "https://dev.to/thousand_miles_ai/qwen3-coder-next-80b-total-3b-active-706-on-swe-bench-2g5o"
   }
  ],
  "supersededBy": "qwen3.8-27b / ornith-1.5-35b-a3b",
  "research": "At 48.5 GB it is now beaten by models half its size (Qwen3.8 27B SWE-bench Pro 61.7 vs 44.3; Ornith-1.5-35B SWE-V 79 vs 70.6). Recommend dropping or demoting.",
  "hf": {
   "downloads30d": 431761,
   "likes": 1728,
   "ggufRepo": "unsloth/Qwen3-Coder-Next-GGUF",
   "ggufDownloads30d": 168619,
   "ggufLikes": 899
  }
 },
 "gpt-oss-120b": {
  "benchmarks": [
   {
    "name": "GPQA Diamond (Qwen3.5 card comparison)",
    "value": "80.1",
    "url": "https://huggingface.co/Qwen/Qwen3.5-9B"
   },
   {
    "name": "LiveCodeBench v6 (Qwen3.5 card comparison)",
    "value": "82.7",
    "url": "https://huggingface.co/Qwen/Qwen3.5-9B"
   }
  ],
  "supersededBy": "qwen3.8-27b",
  "research": "Still trending on HF (base 2.5M dl/30d) but needs 63 GB; Qwen3.8 27B (16.5 GB) matches or beats it on reported reasoning/coding.",
  "hf": {
   "downloads30d": 2475702,
   "likes": 5480,
   "ggufRepo": "unsloth/gpt-oss-120b-GGUF",
   "ggufDownloads30d": 73765,
   "ggufLikes": 302
  }
 },
 "bge-m3": {
  "benchmarks": [
   {
    "name": "MTEB Multilingual mean (Qwen3-Embedding card)",
    "value": "59.56",
    "url": "https://huggingface.co/Qwen/Qwen3-Embedding-0.6B"
   }
  ],
  "supersededBy": "harrier-oss-v1-0.6b / qwen3-embedding-0.6b (quality)",
  "research": "Most downloaded embedding in this catalog by far (30.3M dl/30d; Ollama bge-m3 8.1M pulls) – the safe default for compatibility, but newer 0.3–0.6B models score 5–10 points higher on multilingual MTEB.",
  "hf": {
   "downloads30d": 30252576,
   "likes": 3958,
   "ggufRepo": "gpustack/bge-m3-GGUF",
   "ggufDownloads30d": 63474,
   "ggufLikes": 58
  }
 },
 "qwen3-embedding-0.6b": {
  "benchmarks": [
   {
    "name": "MTEB Multilingual mean (vendor)",
    "value": "64.33",
    "url": "https://huggingface.co/Qwen/Qwen3-Embedding-0.6B"
   },
   {
    "name": "MMTEB-R retrieval (Qwen3-Reranker card)",
    "value": "64.64",
    "url": "https://huggingface.co/Qwen/Qwen3-Reranker-0.6B"
   }
  ],
  "research": "8.9M base dl/30d. harrier-oss-v1-0.6b (same Qwen3 arch) reports MTEB v2 69.0.",
  "hf": {
   "downloads30d": 8874546,
   "likes": 1322,
   "ggufRepo": "Qwen/Qwen3-Embedding-0.6B-GGUF",
   "ggufDownloads30d": 168912,
   "ggufLikes": 589
  }
 },
 "lfm3-1.7b": {
  "benchmarks": [
   {
    "name": "Card table: IFEval",
    "value": "96.66",
    "url": "https://huggingface.co/LiquidAI/LFM3-1.7B"
   },
   {
    "name": "Card table: GPQA Diamond",
    "value": "63.37",
    "url": "https://huggingface.co/LiquidAI/LFM3-1.7B"
   }
  ],
  "research": "No. 1 trending text-generation model on HF (trendingScore 709, 2026-11-02). Benchmarks vendor-only.",
  "hf": {
   "downloads30d": 42384,
   "likes": 919,
   "ggufRepo": "LiquidAI/LFM3-1.7B-GGUF",
   "ggufDownloads30d": 174177,
   "ggufLikes": 197
  }
 },
 "minicpm5-2b": {
  "benchmarks": [
   {
    "name": "BFCL v4 (vendor)",
    "value": "66.6",
    "url": "https://huggingface.co/openbmb/MiniCPM5-2B"
   },
   {
    "name": "τ²-Bench Telecom (vendor)",
    "value": "97.1",
    "url": "https://huggingface.co/openbmb/MiniCPM5-2B"
   },
   {
    "name": "SWE-bench Verified (vendor)",
    "value": "46.4",
    "url": "https://huggingface.co/openbmb/MiniCPM5-2B"
   },
   {
    "name": "AA",
    "value": "listed, no index score",
    "url": "https://artificialanalysis.ai/leaderboards/models"
   }
  ],
  "research": "1.07M base dl/30d. Strongest tool-calling claims in the 2B class.",
  "hf": {
   "downloads30d": 1067287,
   "likes": 1832,
   "ggufRepo": "openbmb/MiniCPM5-2B-GGUF",
   "ggufDownloads30d": 345226,
   "ggufLikes": 386
  }
 },
 "nemotron-3.5-bolt-e4b": {
  "benchmarks": [
   {
    "name": "BFCL-v3 (vendor)",
    "value": "68.51",
    "url": "https://huggingface.co/nvidia/NVIDIA-Nemotron-3.5-Bolt-E4B-BF16"
   },
   {
    "name": "Tau2-Bench (vendor)",
    "value": "55.10",
    "url": "https://huggingface.co/nvidia/NVIDIA-Nemotron-3.5-Bolt-E4B-BF16"
   }
  ],
  "research": "NVIDIA's own nvidia/NVIDIA-Nemotron-3.5-Bolt-E4B-4GB (file Nemotron-3.5-Bolt-E4B-Q4_K_M.gguf, 6.18 GB; 92.7k dl, trending 136) is the more popular build. Same card shows Qwen3.5-4B ahead on Tau2 (75.06).",
  "hf": {
   "downloads30d": 10563,
   "likes": 62,
   "ggufRepo": "unsloth/NVIDIA-Nemotron-3.5-Bolt-E4B-GGUF",
   "ggufDownloads30d": 315003,
   "ggufLikes": 163
  },
  "repo": "nvidia/NVIDIA-Nemotron-3.5-Bolt-E4B-4GB",
  "file": "Nemotron-3.5-Bolt-E4B-Q4_K_M.gguf",
  "sizeGb": 6.18
 },
 "ornith-1.5-35b-a3b": {
  "benchmarks": [
   {
    "name": "SWE-bench Verified (vendor)",
    "value": "79",
    "url": "https://huggingface.co/ornith-ai/Ornith-1.5-35B-A3B"
   },
   {
    "name": "Terminal-Bench 2.1 Terminus-2 (vendor)",
    "value": "67.8",
    "url": "https://huggingface.co/ornith-ai/Ornith-1.5-35B-A3B"
   }
  ],
  "research": "GGUF 4.0M dl/30d (no. 6 GGUF repo on HF). Vendor numbers, five-run averages, no independent verification yet.",
  "hf": {
   "downloads30d": 275679,
   "likes": 772,
   "ggufRepo": "ornith-ai/Ornith-1.5-35B-A3B-GGUF",
   "ggufDownloads30d": 4036317,
   "ggufLikes": 571
  }
 },
 "occamy-1.0": {
  "benchmarks": [
   {
    "name": "BFCL v4 (vendor)",
    "value": "65.40",
    "url": "https://huggingface.co/Accio-Lab/occamy-1.0"
   },
   {
    "name": "Terminal-Bench 2.1 (vendor)",
    "value": "59.00",
    "url": "https://huggingface.co/Accio-Lab/occamy-1.0"
   },
   {
    "name": "τ³-Bench Banking (vendor)",
    "value": "37.10",
    "url": "https://huggingface.co/Accio-Lab/occamy-1.0"
   }
  ],
  "research": "GGUF 0.8M dl/30d but only 42 likes – usage may be automated.",
  "hf": {
   "downloads30d": 1952,
   "likes": 237,
   "ggufRepo": "Accio-Lab/occamy-1.0-GGUF",
   "ggufDownloads30d": 797116,
   "ggufLikes": 42
  }
 },
 "nemotron-3.5-lightning-30b-a3b": {
  "benchmarks": [
   {
    "name": "SWE-bench Verified (vendor)",
    "value": "70.12",
    "url": "https://huggingface.co/nvidia/NVIDIA-Nemotron-3.5-Lightning-30B-A3B-BF16"
   },
   {
    "name": "GPQA Diamond (vendor)",
    "value": "83.40",
    "url": "https://huggingface.co/nvidia/NVIDIA-Nemotron-3.5-Lightning-30B-A3B-BF16"
   },
   {
    "name": "Terminal-Bench 2.1 (vendor)",
    "value": "44.38",
    "url": "https://huggingface.co/nvidia/NVIDIA-Nemotron-3.5-Lightning-30B-A3B-BF16"
   },
   {
    "name": "AA Intelligence Index v5.0",
    "value": "6",
    "url": "https://artificialanalysis.ai/leaderboards/models"
   }
  ],
  "research": "Base 1.15M dl/30d.",
  "hf": {
   "downloads30d": 1149020,
   "likes": 262,
   "ggufRepo": "unsloth/NVIDIA-Nemotron-3.5-Lightning-30B-A3B-GGUF",
   "ggufDownloads30d": 51567,
   "ggufLikes": 121
  }
 },
 "nemotron-3.5-bolt-74b-a9b-24gb": {
  "benchmarks": [
   {
    "name": "GPQA Diamond (secondary, DataLearner)",
    "value": "88.83 – UNVERIFIED",
    "url": "https://www.datalearner.com/ai-models/pretrained-models/nemotron-3-5-bolt-74b-a9b/analysis"
   },
   {
    "name": "HLE (secondary)",
    "value": "28.73 – UNVERIFIED",
    "url": "https://www.datalearner.com/ai-models/pretrained-models/nemotron-3-5-bolt-74b-a9b/analysis"
   }
  ],
  "research": "NVIDIA publishes the benchmark only as a chart; numbers unverified. AA lists it without a score.",
  "hf": {
   "downloads30d": 7429,
   "likes": 52,
   "ggufRepo": "nvidia/NVIDIA-Nemotron-3.5-Bolt-74B-A9B-24GB-GGUF",
   "ggufDownloads30d": 195714,
   "ggufLikes": 127
  }
 },
 "granite-4.1-8b": {
  "benchmarks": [
   {
    "name": "BFCL v3 (vendor; column uncertain)",
    "value": "68.27",
    "url": "https://huggingface.co/ibm-granite/granite-4.1-8b"
   }
  ],
  "supersededBy": "granite-4.2-8b",
  "research": "IBM released Granite 4.2 (3B/8B/30B, native reasoning, 512K ext. ctx) on 2026-08-07 with first-party GGUFs (granite-4.2-8b-GGUF 274k dl/30d vs 14k for 4.1).",
  "hf": {
   "downloads30d": 93017,
   "likes": 257,
   "ggufRepo": "ibm-granite/granite-4.1-8b-GGUF",
   "ggufDownloads30d": 13899,
   "ggufLikes": 12
  }
 },
 "devstral-small-2-24b": {
  "benchmarks": [
   {
    "name": "SWE-bench Verified (vendor)",
    "value": "68.0%",
    "url": "https://huggingface.co/mistralai/Devstral-Small-2-24B-Instruct-2512"
   },
   {
    "name": "Terminal Bench 2 (vendor)",
    "value": "22.5%",
    "url": "https://huggingface.co/mistralai/Devstral-Small-2-24B-Instruct-2512"
   }
  ],
  "supersededBy": "ornith-1.5-9b / ornith-1.5-35b-a3b",
  "research": "Ollama devstral-small-2 2.5M pulls. Beaten on SWE-V by 9B Ornith-1.5 (70.6) at a third of the size.",
  "hf": {
   "downloads30d": 138229,
   "likes": 712,
   "ggufRepo": "unsloth/Devstral-Small-2-24B-Instruct-2512-GGUF",
   "ggufDownloads30d": 95270,
   "ggufLikes": 193
  }
 },
 "flint": {
  "benchmarks": [
   {
    "name": "SWE-bench Verified (vendor)",
    "value": "74.2%",
    "url": "https://huggingface.co/RecursiveSI/flint"
   },
   {
    "name": "Terminal-Bench 2.1 (vendor)",
    "value": "54.9%",
    "url": "https://huggingface.co/RecursiveSI/flint"
   }
  ],
  "research": "Better-used GGUFs exist: unsloth/flint-GGUF (244k dl/30d, flint-UD-Q4_K_XL.gguf 25.05 GB) and ggml-org/Flint-GGUF (Flint-Q4_K_M.gguf 23.39 GB, 16k) vs bartowski 19k. Consider switching repo. Trending no. 3 text-generation on HF.",
  "hf": {
   "downloads30d": 29574,
   "likes": 1310,
   "ggufRepo": "bartowski/RecursiveSI_flint-GGUF",
   "ggufDownloads30d": 19085,
   "ggufLikes": 7
  },
  "repo": "unsloth/flint-GGUF",
  "file": "flint-UD-Q4_K_XL.gguf",
  "sizeGb": 25.05
 },
 "qwen3-embedding-4b": {
  "benchmarks": [
   {
    "name": "MTEB Multilingual mean (vendor)",
    "value": "69.45",
    "url": "https://huggingface.co/Qwen/Qwen3-Embedding-0.6B"
   }
  ],
  "research": "2.24M base dl/30d.",
  "hf": {
   "downloads30d": 2242549,
   "likes": 345,
   "ggufRepo": "Qwen/Qwen3-Embedding-4B-GGUF",
   "ggufDownloads30d": 60668,
   "ggufLikes": 144
  }
 },
 "embeddinggemma-2": {
  "benchmarks": [
   {
    "name": "MTEB multilingual v2 Mean(Task) (vendor)",
    "value": "61.36",
    "url": "https://huggingface.co/google/embeddinggemma-2"
   },
   {
    "name": "MTEB code v1 (vendor)",
    "value": "78.68",
    "url": "https://huggingface.co/google/embeddinggemma-2"
   }
  ],
  "research": "No. 1 trending feature-extraction model on HF. unsloth/embeddinggemma-2-GGUF (153k dl/30d) more used than ggml-org (120k). Text quality below harrier/Qwen3-Embedding; its edge is multimodal.",
  "hf": {
   "downloads30d": 407228,
   "likes": 3075,
   "ggufRepo": "ggml-org/embeddinggemma-2-GGUF",
   "ggufDownloads30d": 120389,
   "ggufLikes": 56
  }
 },
 "qwen3-reranker-0.6b": {
  "benchmarks": [
   {
    "name": "MMTEB-R (vendor)",
    "value": "66.36",
    "url": "https://huggingface.co/Qwen/Qwen3-Reranker-0.6B"
   },
   {
    "name": "MTEB-R (vendor)",
    "value": "65.80",
    "url": "https://huggingface.co/Qwen/Qwen3-Reranker-0.6B"
   }
  ],
  "research": "Qwen3-Reranker-4B is +6 MMTEB-R (72.74) at 2.5 GB Q4.",
  "hf": {
   "downloads30d": 1292593,
   "likes": 433,
   "ggufRepo": "ggml-org/Qwen3-Reranker-0.6B-Q8_0-GGUF",
   "ggufDownloads30d": 118557,
   "ggufLikes": 29
  }
 },
 "clef-flash": {
  "research": "No standard public benchmark (router/guard/systemone class).",
  "hf": {
   "downloads30d": 44656,
   "likes": 898,
   "ggufRepo": "ggml-org/Clef-Flash-GGUF",
   "ggufDownloads30d": 87318,
   "ggufLikes": 42
  }
 },
 "clef": {
  "research": "No standard public benchmark (router/guard/systemone class).",
  "hf": {
   "downloads30d": 44091,
   "likes": 2330,
   "ggufRepo": "ggml-org/Clef-GGUF",
   "ggufDownloads30d": 33599,
   "ggufLikes": 28
  }
 },
 "laya-gguf": {
  "research": "No standard public benchmark (router/guard/systemone class). Base repo has 5,885 likes – the most liked of the systemone models.",
  "hf": {
   "downloads30d": 59083,
   "likes": 5885,
   "ggufRepo": "ggml-org/Laya-GGUF",
   "ggufDownloads30d": 22201,
   "ggufLikes": 38
  }
 },
 "vllm-d3-nano": {
  "research": "No standard public benchmark (router/guard/systemone class). ggml-org also publishes vllm-d3, vllm-d3-mini and vllm-d3-lite GGUFs (2026-10-12).",
  "hf": {
   "downloads30d": 7157,
   "likes": 46,
   "ggufRepo": "ggml-org/vllm-d3-nano-GGUF",
   "ggufDownloads30d": 12006,
   "ggufLikes": 8
  }
 },
 "vllm-d3-flash": {
  "research": "No standard public benchmark (router/guard/systemone class).",
  "hf": {
   "downloads30d": 102347,
   "likes": 101,
   "ggufRepo": "ggml-org/vllm-d3-flash-GGUF",
   "ggufDownloads30d": 19387,
   "ggufLikes": 12
  }
 },
 "d1-3b": {
  "research": "No standard public benchmark (router/guard/systemone class). LiquidAI released d1-2B (base LFM3-VL-2B, 2026-10-24, trending 173) plus d1-Omni-2B; likely successor – check before promoting d1-3B.",
  "hf": {
   "downloads30d": 33299,
   "likes": 492,
   "ggufRepo": "LiquidAI/d1-3B-GGUF",
   "ggufDownloads30d": 50586,
   "ggufLikes": 65
  }
 },
 "granite-switch-4.1-8b": {
  "research": "No standard public benchmark (router/guard/systemone class). A 30B sibling (ibm-granite/granite-switch-4.1-30b-GGUF) exists.",
  "hf": {
   "downloads30d": 4521,
   "likes": 55,
   "ggufRepo": "ibm-granite/granite-switch-4.1-8b-GGUF",
   "ggufDownloads30d": 2498,
   "ggufLikes": 1
  }
 },
 "arch-router-1.5b": {
  "research": "No standard public benchmark (router/guard/systemone class). 2025-05, Qwen2.5 base; low usage.",
  "hf": {
   "downloads30d": 3258,
   "likes": 283,
   "ggufRepo": "katanemo/Arch-Router-1.5B.gguf",
   "ggufDownloads30d": 1416,
   "ggufLikes": 15
  }
 },
 "qwen3guard-gen-0.6b": {
  "research": "No standard public benchmark (router/guard/systemone class).",
  "hf": {
   "downloads30d": 228231,
   "likes": 98,
   "ggufRepo": "mradermacher/Qwen3Guard-Gen-0.6B-GGUF",
   "ggufDownloads30d": 1937,
   "ggufLikes": 2
  }
 },
 "granite-guardian-4.1-8b": {
  "research": "No standard public benchmark (router/guard/systemone class).",
  "hf": {
   "downloads30d": 10013,
   "likes": 52,
   "ggufRepo": "ibm-granite/granite-guardian-4.1-8b-GGUF",
   "ggufDownloads30d": 3486,
   "ggufLikes": 5
  }
 },
 "privasis-cleaner-0.6b": {
  "research": "No standard public benchmark (router/guard/systemone class). Near-zero usage (14 dl/30d base, 244 GGUF); unproven.",
  "hf": {
   "downloads30d": 14,
   "likes": 0,
   "ggufRepo": "mradermacher/Privasis-Cleaner-0.6B-GGUF",
   "ggufDownloads30d": 244,
   "ggufLikes": 0
  }
 }
};

/** Who uses which open models, outside Hugging Face. */
export const USAGE_RANKINGS = [
 {
  "source": "OpenRouter rankings, monthly view (tokens = prompt+completion, aggregated from the page's embedded data by model version)",
  "url": "https://openrouter.ai/rankings?view=month",
  "date": "2026-11-01 (page: usage data through Nov 1, 2026)",
  "ranking": [
   {
    "model": "deepseek/deepseek-v4.1-flash-20261017 (open, 552–763B)",
    "rank": 1,
    "metric": "48.08 T tokens"
   },
   {
    "model": "z-ai/glm-5.3-flash-20260826 (open, 321B)",
    "rank": 2,
    "metric": "15.01 T tokens"
   },
   {
    "model": "deepseek/deepseek-v4.1-flash-20260910 (open)",
    "rank": 3,
    "metric": "14.87 T tokens"
   },
   {
    "model": "openai/gpt-6-luna (closed)",
    "rank": 4,
    "metric": "9.62 T tokens"
   },
   {
    "model": "tencent/hy4-preview",
    "rank": 5,
    "metric": "9.07 T tokens"
   },
   {
    "model": "anthropic/claude-opus-5.5 (closed)",
    "rank": 6,
    "metric": "6.73 T tokens"
   },
   {
    "model": "stepfun/step-5-preview (open, 600B)",
    "rank": 7,
    "metric": "6.25 T tokens"
   },
   {
    "model": "minimax/minimax-m3.1-flash (open, 220–428B)",
    "rank": 8,
    "metric": "6.23 T tokens"
   },
   {
    "model": "openai/gpt-5.6-luna (closed)",
    "rank": 9,
    "metric": "4.33 T tokens"
   },
   {
    "model": "z-ai/glm-5.3 (open)",
    "rank": 10,
    "metric": "4.23 T tokens"
   },
   {
    "model": "deepseek/deepseek-v4-flash-20260731",
    "rank": 11,
    "metric": "3.94 T tokens"
   },
   {
    "model": "openai/gpt-6.1-sol (closed)",
    "rank": 12,
    "metric": "3.75 T tokens"
   }
  ]
 },
 {
  "source": "Hugging Face, GGUF repos sorted by 30-day downloads",
  "url": "https://huggingface.co/api/models?filter=gguf&sort=downloads&limit=60",
  "date": "2026-11-02",
  "ranking": [
   {
    "model": "ISTA-DASLab/Qwen3.8-Flash-Next-GSQ-RCO-GGUF (180B, too big)",
    "rank": 3,
    "metric": "7.43M downloads/30d"
   },
   {
    "model": "unsloth/Qwen3.8-27B-GGUF",
    "rank": 4,
    "metric": "6.08M downloads/30d"
   },
   {
    "model": "ornith-ai/Ornith-1.5-9B-GGUF",
    "rank": 5,
    "metric": "5.44M downloads/30d"
   },
   {
    "model": "ornith-ai/Ornith-1.5-35B-A3B-GGUF",
    "rank": 6,
    "metric": "4.04M downloads/30d"
   },
   {
    "model": "huihui-ai/Huihui-Qwen3.8-27B-abliterated-GGUF",
    "rank": 8,
    "metric": "3.25M downloads/30d"
   },
   {
    "model": "peculiar-ragdoll/Tiel-Coder-35B-A3B-GGUF-MTP",
    "rank": 10,
    "metric": "2.97M downloads/30d"
   },
   {
    "model": "unsloth/MiniMax-H3-GGUF",
    "rank": 13,
    "metric": "2.61M downloads/30d"
   },
   {
    "model": "ggml-org/Qwen3.8-27B-GGUF",
    "rank": 18,
    "metric": "2.35M downloads/30d"
   },
   {
    "model": "unsloth/gemma-4-12b-it-GGUF",
    "rank": 24,
    "metric": "2.08M downloads/30d"
   },
   {
    "model": "prism-ml/Ternary-Bonsai-2-27B-gguf",
    "rank": 29,
    "metric": "1.82M downloads/30d"
   },
   {
    "model": "unsloth/Qwen3.5-9B-GGUF",
    "rank": 32,
    "metric": "1.60M downloads/30d"
   },
   {
    "model": "unsloth/Qwen3.6-35B-A3B-MTP-GGUF",
    "rank": 33,
    "metric": "1.58M downloads/30d"
   }
  ]
 },
 {
  "source": "Hugging Face trending (text-generation and GGUF)",
  "url": "https://huggingface.co/api/models?sort=trendingScore&pipeline_tag=text-generation",
  "date": "2026-11-02",
  "ranking": [
   {
    "model": "LiquidAI/LFM3-1.7B",
    "rank": 1,
    "metric": "trendingScore 709"
   },
   {
    "model": "Nanbeige/Nanbeige4.3-33B",
    "rank": 2,
    "metric": "trendingScore 305"
   },
   {
    "model": "RecursiveSI/flint",
    "rank": 3,
    "metric": "trendingScore 220"
   },
   {
    "model": "Diffuspace/Clover-35B-A3B-Preview (custom clover_moe arch; no llama.cpp support verified)",
    "rank": 4,
    "metric": "trendingScore 208"
   },
   {
    "model": "XHToken/Spark-X2.6-4B (spark2_5 arch, llama.cpp ≥ b10828; en/zh)",
    "rank": 5,
    "metric": "trendingScore 196"
   },
   {
    "model": "nvidia/NVIDIA-Nemotron-3.5-Bolt-E4B-4GB",
    "rank": 6,
    "metric": "trendingScore 136"
   },
   {
    "model": "inclusionAI/Ling-3.1-flash-1019 (572B)",
    "rank": 7,
    "metric": "trendingScore 91"
   },
   {
    "model": "google/embeddinggemma-2 (feature-extraction #1)",
    "rank": 8,
    "metric": "trendingScore 100"
   },
   {
    "model": "nvidia/Nemotron-3.5-Rerank-8B-BF16 (text-ranking #1)",
    "rank": 9,
    "metric": "trendingScore 9"
   }
  ]
 },
 {
  "source": "Ollama library, sorted by popularity (all-time pulls)",
  "url": "https://ollama.com/library?sort=popular",
  "date": "2026-11-02",
  "ranking": [
   {
    "model": "llama3.1",
    "rank": 1,
    "metric": "120.8M pulls"
   },
   {
    "model": "nomic-embed-text",
    "rank": 2,
    "metric": "95.3M pulls"
   },
   {
    "model": "deepseek-r1",
    "rank": 3,
    "metric": "94.6M pulls"
   },
   {
    "model": "llama3.2",
    "rank": 4,
    "metric": "86.8M pulls"
   },
   {
    "model": "qwen2.5",
    "rank": 5,
    "metric": "44.5M pulls"
   },
   {
    "model": "qwen3",
    "rank": 6,
    "metric": "42.3M pulls"
   },
   {
    "model": "gemma3",
    "rank": 7,
    "metric": "41.6M pulls"
   },
   {
    "model": "gemma4",
    "rank": 10,
    "metric": "28.4M pulls"
   },
   {
    "model": "qwen3.5",
    "rank": 12,
    "metric": "24.1M pulls"
   },
   {
    "model": "gpt-oss",
    "rank": 17,
    "metric": "14.5M pulls"
   },
   {
    "model": "qwen3-coder",
    "rank": 18,
    "metric": "10.6M pulls"
   },
   {
    "model": "glm-ocr",
    "rank": 19,
    "metric": "8.9M pulls"
   }
  ]
 },
 {
  "source": "Artificial Analysis Intelligence Index v5.0, open-weights list",
  "url": "https://artificialanalysis.ai/models/open-source",
  "date": "2026-11-02 (fetched)",
  "ranking": [
   {
    "model": "DeepSeek V4.1 Flash 1017 (Max)",
    "rank": 1,
    "metric": "AA index v5.0 32"
   },
   {
    "model": "GLM-5.3 (Max)",
    "rank": 2,
    "metric": "AA index v5.0 32"
   },
   {
    "model": "MiMo-V2.6-Pro",
    "rank": 3,
    "metric": "AA index v5.0 30"
   },
   {
    "model": "Ling 3.1 Flash 1019",
    "rank": 4,
    "metric": "AA index v5.0 29"
   },
   {
    "model": "MiniMax-M3.1-Flash",
    "rank": 5,
    "metric": "AA index v5.0 29"
   },
   {
    "model": "Step 5 Preview",
    "rank": 6,
    "metric": "AA index v5.0 29"
   },
   {
    "model": "Mistral Large 4 (High)",
    "rank": 7,
    "metric": "AA index v5.0 26"
   },
   {
    "model": "Muse Spark Open (Xhigh)",
    "rank": 8,
    "metric": "AA index v5.0 25"
   },
   {
    "model": "Qwen3.8 27B (Xhigh)",
    "rank": 9,
    "metric": "AA index v5.0 20"
   },
   {
    "model": "Nanbeige4.3-33B",
    "rank": 10,
    "metric": "AA index v5.0 20"
   },
   {
    "model": "Nemotron 3.5 Super VL",
    "rank": 11,
    "metric": "AA index v5.0 14"
   },
   {
    "model": "Nemotron 3.5 Lightning",
    "rank": 12,
    "metric": "AA index v5.0 6"
   }
  ]
 }
];
