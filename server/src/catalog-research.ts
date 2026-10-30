import type { CatalogEntry } from "./catalog.js";

/** Entries from docs/research-local-llm.md (verified against the Hugging Face API, 2026-10-30). */
export const RESEARCH: CatalogEntry[] = [
 {
  "id": "lfm3-1.7b",
  "name": "LFM3 1.7B",
  "family": "LFM3",
  "kind": "chat",
  "repo": "LiquidAI/LFM3-1.7B-GGUF",
  "file": "LFM3-1.7B-Q4_K_M.gguf",
  "sizeGb": 1.1,
  "params": "?",
  "arch": "lfm3",
  "ctx": 262144,
  "license": "lfm1.0",
  "routes": [
   "fast",
   "classifier"
  ],
  "caps": {
   "quality": 4,
   "speed": 10,
   "tools": 5,
   "code": 3.5,
   "reasoning": 3.5,
   "multilingual": 5.5
  },
  "defaultCtx": 32768,
  "notes": "Needs llama.cpp >= 0.8.0 (PR #31252). LFM licence has commercial limits.",
  "released": "2026",
  "minLlama": "0.8.0"
 },
 {
  "id": "minicpm5-2b",
  "name": "MiniCPM5 2B",
  "family": "MiniCPM5",
  "kind": "chat",
  "repo": "openbmb/MiniCPM5-2B-GGUF",
  "file": "MiniCPM5-2B-Q8_0.gguf",
  "sizeGb": 2.68,
  "params": "?",
  "arch": "llama",
  "ctx": 131072,
  "license": "apache-2.0",
  "routes": [
   "fast"
  ],
  "caps": {
   "quality": 4.5,
   "speed": 9.5,
   "tools": 6,
   "code": 4,
   "reasoning": 4,
   "multilingual": 4
  },
  "defaultCtx": 32768,
  "notes": "Tool-calling tuned on-device model; en/zh focus.",
  "released": "2026"
 },
 {
  "id": "nemotron-3.5-bolt-e4b",
  "name": "Nemotron 3.5 Bolt E4B",
  "family": "Nemotron",
  "kind": "chat",
  "repo": "unsloth/NVIDIA-Nemotron-3.5-Bolt-E4B-GGUF",
  "file": "NVIDIA-Nemotron-3.5-Bolt-E4B-UD-Q4_K_XL.gguf",
  "mmproj": "mmproj-F16.gguf",
  "sizeGb": 5.06,
  "params": "?",
  "arch": "gemma4",
  "ctx": 131072,
  "license": "openmdw-1.1",
  "routes": [
   "fast",
   "multilingual",
   "agent"
  ],
  "caps": {
   "quality": 6,
   "speed": 8.5,
   "tools": 7,
   "code": 5.5,
   "reasoning": 5.5,
   "multilingual": 8,
   "vision": 6
  },
  "defaultCtx": 32768,
  "notes": "Gemma 4 E4B fine-tune by NVIDIA; HF language list includes da.",
  "released": "2026"
 },
 {
  "id": "ornith-1.5-35b-a3b",
  "name": "Ornith 1.5 35B-A3B",
  "family": "Ornith",
  "kind": "chat",
  "repo": "ornith-ai/Ornith-1.5-35B-A3B-GGUF",
  "file": "Ornith-1.5-35B-Q4_K_M.gguf",
  "mmproj": "mmproj-Ornith-1.5-35B-BF16.gguf",
  "sizeGb": 21.71,
  "params": "?",
  "arch": "qwen35moe",
  "ctx": 262144,
  "license": "mit",
  "routes": [
   "agent",
   "code"
  ],
  "caps": {
   "quality": 8.5,
   "speed": 8.5,
   "tools": 9,
   "code": 8.7,
   "reasoning": 8,
   "multilingual": 7,
   "vision": 7
  },
  "defaultCtx": 65536,
  "notes": "Self-improved Qwen3.5-class MoE; card reports Terminal-Bench 2.1 67.8 vs Qwen3.6 52.5. Challenger for agent default.",
  "released": "2026"
 },
 {
  "id": "occamy-1.0",
  "name": "Occamy 1.0",
  "family": "Occamy",
  "kind": "chat",
  "repo": "Accio-Lab/occamy-1.0-GGUF",
  "file": "occamy-1.0-Q4_K_M.gguf",
  "mmproj": "mmproj-occamy-1.0-F16.gguf",
  "sizeGb": 21.17,
  "params": "?",
  "arch": "qwen35moe",
  "ctx": 262144,
  "license": "apache-2.0",
  "routes": [
   "agent"
  ],
  "caps": {
   "quality": 8.3,
   "speed": 8.5,
   "tools": 9,
   "code": 7.5,
   "reasoning": 7.5,
   "multilingual": 7,
   "vision": 7
  },
  "defaultCtx": 65536,
  "notes": "Qwen3.6-35B-A3B fine-tune for co-work/tool use. No mlx-community build found.",
  "released": "2026"
 },
 {
  "id": "nemotron-3.5-lightning-30b-a3b",
  "name": "Nemotron 3.5 Lightning 30B-A3B",
  "family": "Nemotron",
  "kind": "chat",
  "repo": "unsloth/NVIDIA-Nemotron-3.5-Lightning-30B-A3B-GGUF",
  "file": "NVIDIA-Nemotron-3.5-Lightning-30B-A3B-UD-Q4_K_M.gguf",
  "sizeGb": 25.27,
  "params": "?",
  "arch": "nemotron_h_moe",
  "ctx": 1048576,
  "license": "openmdw-1.1",
  "routes": [
   "agent",
   "reasoning",
   "code"
  ],
  "caps": {
   "quality": 8.5,
   "speed": 8.5,
   "tools": 8.5,
   "code": 8.3,
   "reasoning": 8.7,
   "multilingual": 7
  },
  "defaultCtx": 65536,
  "notes": "Hybrid Mamba-MoE, 1M ctx; card: SWE-bench Verified 70.1, GPQA-D 83.4. MTP head in ggml-org repo.",
  "released": "2026",
  "minLlama": "0.8.0"
 },
 {
  "id": "nemotron-3.5-bolt-74b-a9b-24gb",
  "name": "Nemotron 3.5 Bolt 74B-A9B (24GB)",
  "family": "Nemotron",
  "kind": "chat",
  "repo": "nvidia/NVIDIA-Nemotron-3.5-Bolt-74B-A9B-24GB-GGUF",
  "file": "NVIDIA-Nemotron-3.5-Bolt-74B-A9B-24GB.gguf",
  "mmproj": "mmproj-NVIDIA-Nemotron-3.5-Bolt-74B-A9B-24GB.gguf",
  "sizeGb": 22.02,
  "params": "?",
  "arch": "nemotron_h_moe",
  "ctx": 262144,
  "license": "openmdw-1.1",
  "routes": [
   "agent",
   "vision",
   "smart"
  ],
  "caps": {
   "quality": 8.7,
   "speed": 7,
   "tools": 8.5,
   "code": 8,
   "reasoning": 8.5,
   "multilingual": 7,
   "vision": 8.5
  },
  "defaultCtx": 65536,
  "notes": "Native 2-bit QAT VLM; needs llama.cpp >= 0.8.0 (PR #30520). Quality caps unverified.",
  "released": "2026",
  "minLlama": "0.8.0"
 },
 {
  "id": "granite-4.1-8b",
  "name": "Granite 4.1 8B",
  "family": "Granite",
  "kind": "chat",
  "repo": "ibm-granite/granite-4.1-8b-GGUF",
  "file": "granite-4.1-8b-Q4_K_M.gguf",
  "sizeGb": 5.35,
  "params": "?",
  "arch": "granite",
  "ctx": 131072,
  "license": "apache-2.0",
  "routes": [
   "fast",
   "agent"
  ],
  "caps": {
   "quality": 6.5,
   "speed": 8,
   "tools": 7,
   "code": 6,
   "reasoning": 6,
   "multilingual": 6.5
  },
  "defaultCtx": 32768,
  "notes": "Enterprise/RAG tone; first-party GGUF.",
  "released": "2026"
 },
 {
  "id": "devstral-small-2-24b",
  "name": "Devstral Small 2 24B",
  "family": "Devstral",
  "kind": "chat",
  "repo": "unsloth/Devstral-Small-2-24B-Instruct-2512-GGUF",
  "file": "Devstral-Small-2-24B-Instruct-2512-Q4_K_M.gguf",
  "mmproj": "mmproj-F16.gguf",
  "sizeGb": 14.33,
  "params": "?",
  "arch": "mistral3",
  "ctx": 393216,
  "license": "apache-2.0",
  "routes": [
   "code"
  ],
  "caps": {
   "quality": 7.5,
   "speed": 5.5,
   "tools": 8,
   "code": 8,
   "reasoning": 7,
   "multilingual": 6.5,
   "vision": 6
  },
  "defaultCtx": 65536,
  "notes": "Code lane that works on b11146 today.",
  "released": "2026"
 },
 {
  "id": "flint",
  "name": "Flint",
  "family": "Flint",
  "kind": "chat",
  "repo": "bartowski/RecursiveSI_flint-GGUF",
  "file": "RecursiveSI_flint-Q4_K_M.gguf",
  "sizeGb": 25.35,
  "params": "?",
  "arch": "flint",
  "ctx": 262144,
  "license": "apache-2.0",
  "routes": [
   "code",
   "agent"
  ],
  "caps": {
   "quality": 8.7,
   "speed": 8.5,
   "tools": 9,
   "code": 9.3,
   "reasoning": 8,
   "multilingual": 5.5
  },
  "defaultCtx": 65536,
  "notes": "~40B MoE (active ~2.5B, unverified); card: SWE-bench Verified 74.2%, Terminal-Bench 2.1 54.9%. Needs llama.cpp >= 0.8.0 (PR #30928).",
  "released": "2026",
  "minLlama": "0.8.0"
 },
 {
  "id": "qwen3-embedding-4b",
  "name": "Qwen3 Embedding 4B",
  "family": "Qwen3",
  "kind": "embedding",
  "repo": "Qwen/Qwen3-Embedding-4B-GGUF",
  "file": "Qwen3-Embedding-4B-Q4_K_M.gguf",
  "sizeGb": 2.5,
  "params": "?",
  "arch": "qwen3",
  "ctx": 40960,
  "license": "apache-2.0",
  "routes": [
   "embed"
  ],
  "caps": {
   "quality": 8.3,
   "speed": 8,
   "code": 7,
   "multilingual": 8.5
  },
  "defaultCtx": 8192,
  "extraArgs": [
   "--pooling",
   "last"
  ],
  "notes": "Higher-quality embed tier.",
  "released": "2026"
 },
 {
  "id": "embeddinggemma-2",
  "name": "EmbeddingGemma 2",
  "family": "EmbeddingGemma",
  "kind": "embedding",
  "repo": "ggml-org/embeddinggemma-2-GGUF",
  "file": "embeddinggemma-2-Q8_0.gguf",
  "mmproj": "mmproj-embeddinggemma-2-Q8_0.gguf",
  "sizeGb": 0.31,
  "params": "?",
  "arch": "gemma-embedding2",
  "ctx": 262144,
  "license": "apache-2.0",
  "routes": [
   "embed"
  ],
  "caps": {
   "quality": 7.5,
   "speed": 10,
   "code": 6,
   "multilingual": 8.5,
   "vision": 6
  },
  "defaultCtx": 8192,
  "notes": "Multimodal 768-d embeddings (text/image/audio/video with mmproj). Needs llama.cpp >= 0.8.0 (PR #30054).",
  "released": "2026",
  "minLlama": "0.8.0"
 },
 {
  "id": "qwen3-reranker-0.6b",
  "name": "Qwen3 Reranker 0.6B",
  "family": "Qwen3",
  "kind": "rerank",
  "repo": "ggml-org/Qwen3-Reranker-0.6B-Q8_0-GGUF",
  "file": "qwen3-reranker-0.6b-q8_0.gguf",
  "sizeGb": 0.64,
  "params": "?",
  "arch": "qwen3",
  "ctx": 40960,
  "license": "apache-2.0",
  "routes": [
   "rerank"
  ],
  "caps": {
   "quality": 7,
   "speed": 9.5,
   "code": 5,
   "multilingual": 8
  },
  "defaultCtx": 8192,
  "notes": "Run with --rerank; serves /v1/rerank.",
  "released": "2026"
 },
 {
  "id": "clef-flash",
  "name": "Clef Flash 9B",
  "family": "Clef",
  "kind": "systemone",
  "repo": "ggml-org/Clef-Flash-GGUF",
  "file": "Clef-Flash-Q4_K_M.gguf",
  "mmproj": "mmproj-Clef-Flash-Q8_0.gguf",
  "sizeGb": 6.73,
  "params": "?",
  "arch": "clef",
  "ctx": 262144,
  "license": "apache-2.0",
  "routes": [
   "systemone",
   "router",
   "guard"
  ],
  "caps": {
   "quality": 8.5,
   "speed": 8.5,
   "tools": 9,
   "code": 7,
   "reasoning": 7,
   "multilingual": 7,
   "vision": 7
  },
  "defaultCtx": 8192,
  "notes": "Jev/SystemOne-native (joint schema head). llama-server >= 0.8.0 serves /v1/systemone only. Raise --ubatch-size to fit whole prompt. Median 38.8 ms on Cloudflare infra.",
  "released": "2026",
  "minLlama": "0.8.0"
 },
 {
  "id": "clef",
  "name": "Clef 27B",
  "family": "Clef",
  "kind": "systemone",
  "repo": "ggml-org/Clef-GGUF",
  "file": "Clef-Q4_K_M.gguf",
  "mmproj": "mmproj-Clef-Q8_0.gguf",
  "sizeGb": 19.54,
  "params": "?",
  "arch": "clef",
  "ctx": 262144,
  "license": "apache-2.0",
  "routes": [
   "systemone"
  ],
  "caps": {
   "quality": 9.3,
   "speed": 6,
   "tools": 9,
   "code": 8,
   "reasoning": 8,
   "multilingual": 7.5,
   "vision": 8
  },
  "defaultCtx": 8192,
  "notes": "Quality systemone tier; median 209 ms on Cloudflare infra. Load on demand.",
  "released": "2026",
  "minLlama": "0.8.0"
 },
 {
  "id": "laya-gguf",
  "name": "Laya",
  "family": "Laya",
  "kind": "systemone",
  "repo": "ggml-org/Laya-GGUF",
  "file": "Laya-Q8_0.gguf",
  "sizeGb": 0.45,
  "params": "?",
  "arch": "modern-bert",
  "ctx": 8192,
  "license": "apache-2.0",
  "routes": [
   "systemone",
   "router"
  ],
  "caps": {
   "quality": 4,
   "speed": 10,
   "tools": 3,
   "code": 3,
   "reasoning": 3,
   "multilingual": 3
  },
  "defaultCtx": 8192,
  "notes": "Current mux backend (ONNX). Also servable by llama-server >= 0.8.0. Median 5.8 ms. Multilingual variant: convaiinnovations/laya-multilingual (onnx-community/laya-multilingual-ONNX).",
  "released": "2026",
  "minLlama": "0.8.0"
 },
 {
  "id": "vllm-d3-nano",
  "name": "Decision 3.0 d3-nano",
  "family": "Decision",
  "kind": "systemone",
  "repo": "ggml-org/vllm-d3-nano-GGUF",
  "file": "vllm-d3-nano-Q8_0.gguf",
  "mmproj": "mmproj-vllm-d3-nano-Q8_0.gguf",
  "sizeGb": 2.55,
  "params": "?",
  "arch": "qwen35",
  "ctx": 262144,
  "license": "apache-2.0",
  "routes": [
   "systemone",
   "router"
  ],
  "caps": {
   "quality": 6.5,
   "speed": 9,
   "tools": 7,
   "code": 5,
   "reasoning": 5,
   "multilingual": 6,
   "vision": 6
  },
  "defaultCtx": 8192,
  "notes": "Mid systemone tier (Qwen3.5-2B base); decision type vllm-d3 in llama.cpp >= 0.8.0.",
  "released": "2026",
  "minLlama": "0.8.0"
 },
 {
  "id": "vllm-d3-flash",
  "name": "Decision 3.0 d3-flash",
  "family": "Decision",
  "kind": "systemone",
  "repo": "ggml-org/vllm-d3-flash-GGUF",
  "file": "vllm-d3-flash-Q4_K_M.gguf",
  "mmproj": "mmproj-vllm-d3-flash-Q8_0.gguf",
  "sizeGb": 6.6,
  "params": "?",
  "arch": "qwen35",
  "ctx": 262144,
  "license": "apache-2.0",
  "routes": [
   "systemone"
  ],
  "caps": {
   "quality": 8,
   "speed": 8,
   "tools": 8,
   "code": 6,
   "reasoning": 6.5,
   "multilingual": 6.5,
   "vision": 7
  },
  "defaultCtx": 8192,
  "notes": "Apache alternative to Clef-Flash (Qwen3.5-9B base); images and video.",
  "released": "2026",
  "minLlama": "0.8.0"
 },
 {
  "id": "d1-3b",
  "name": "LiquidAI d1-3B",
  "family": "LiquidAI",
  "kind": "systemone",
  "repo": "LiquidAI/d1-3B-GGUF",
  "file": "d1-3B-Q4_K_M.gguf",
  "mmproj": "mmproj-d1-3B-Q8_0.gguf",
  "sizeGb": 1.67,
  "params": "?",
  "arch": "lfm2",
  "ctx": 32768,
  "license": "lfm1.0",
  "routes": [
   "systemone",
   "router"
  ],
  "caps": {
   "quality": 6.5,
   "speed": 9.5,
   "tools": 6,
   "code": 4,
   "reasoning": 4.5,
   "multilingual": 6.5,
   "vision": 6
  },
  "defaultCtx": 8192,
  "notes": "30 ms/decision on Apple M5 Pro per card. Decision type lfm2-d1 (llama.cpp >= 0.8.0). LFM licence has commercial limits.",
  "released": "2026",
  "minLlama": "0.8.0"
 },
 {
  "id": "granite-switch-4.1-8b",
  "name": "Granite Switch 4.1 8B",
  "family": "Granite",
  "kind": "systemone",
  "repo": "ibm-granite/granite-switch-4.1-8b-GGUF",
  "file": "granite-switch-4.1-8b-Q4_K_M.gguf",
  "sizeGb": 6.41,
  "params": "?",
  "arch": "graniteswitch",
  "ctx": 131072,
  "license": "apache-2.0",
  "routes": [
   "systemone",
   "fast"
  ],
  "caps": {
   "quality": 6.5,
   "speed": 8,
   "tools": 7,
   "code": 6,
   "reasoning": 6,
   "multilingual": 6.5
  },
  "defaultCtx": 8192,
  "notes": "One process serves chat and /v1/systemone (output_modalities text+decisions). Decision support from llama.cpp 0.8.0; quality caps unverified.",
  "released": "2026",
  "minLlama": "0.8.0"
 },
 {
  "id": "arch-router-1.5b",
  "name": "Arch-Router 1.5B",
  "family": "Arch-Router",
  "kind": "chat",
  "repo": "katanemo/Arch-Router-1.5B.gguf",
  "file": "Arch-Router-1.5B-Q4_K_M.gguf",
  "sizeGb": 0.99,
  "params": "?",
  "arch": "qwen2",
  "ctx": 32768,
  "license": "katanemo-research",
  "routes": [
   "router"
  ],
  "caps": {
   "quality": 6,
   "speed": 9.5,
   "reasoning": 3,
   "multilingual": 4
  },
  "defaultCtx": 32768,
  "notes": "Generative preference router: routes [{name,description}] + conversation -> {\"route\":name}. Research licence; check before commercial use.",
  "released": "2026"
 },
 {
  "id": "qwen3guard-gen-0.6b",
  "name": "Qwen3Guard Gen 0.6B",
  "family": "Qwen3Guard",
  "kind": "chat",
  "repo": "mradermacher/Qwen3Guard-Gen-0.6B-GGUF",
  "file": "Qwen3Guard-Gen-0.6B.Q8_0.gguf",
  "sizeGb": 0.8,
  "params": "?",
  "arch": "qwen3",
  "ctx": 32768,
  "license": "apache-2.0",
  "routes": [
   "guard"
  ],
  "caps": {
   "quality": 6.5,
   "speed": 9.5,
   "multilingual": 7.5
  },
  "defaultCtx": 32768,
  "notes": "Prompt/response safety label + category. Community GGUF (no first-party GGUF).",
  "released": "2026"
 },
 {
  "id": "granite-guardian-4.1-8b",
  "name": "Granite Guardian 4.1 8B",
  "family": "Granite",
  "kind": "chat",
  "repo": "ibm-granite/granite-guardian-4.1-8b-GGUF",
  "file": "granite-guardian-4.1-8b-Q4_K_M.gguf",
  "sizeGb": 5.12,
  "params": "?",
  "arch": "granite",
  "ctx": 131072,
  "license": "apache-2.0",
  "routes": [
   "guard"
  ],
  "caps": {
   "quality": 8,
   "speed": 7.5,
   "multilingual": 5
  },
  "defaultCtx": 32768,
  "notes": "Harm, jailbreak, RAG groundedness and function-call risk checks; first-party GGUF.",
  "released": "2026"
 },
 {
  "id": "privasis-cleaner-0.6b",
  "name": "Privasis Cleaner 0.6B",
  "family": "Privasis",
  "kind": "chat",
  "repo": "mradermacher/Privasis-Cleaner-0.6B-GGUF",
  "file": "Privasis-Cleaner-0.6B.Q8_0.gguf",
  "sizeGb": 0.64,
  "params": "?",
  "arch": "qwen3",
  "ctx": 40960,
  "license": "nvidia-other",
  "routes": [
   "guard"
  ],
  "caps": {
   "quality": 6,
   "speed": 9.5,
   "multilingual": 3
  },
  "defaultCtx": 32768,
  "notes": "Instruction-driven PII sanitisation (rewrites text). For span masking use openai/privacy-filter ONNX (onnx/model_q4.onnx, ~0.92 GB) in-process; it has no llama.cpp support.",
  "released": "2026"
 }
];
