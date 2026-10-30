# Local LLM research for mux (Mac Studio M3 Ultra, 96 GB)

Research date: 2026-10-30. Sources: the Hugging Face API (`/api/models/<repo>`, `?expand[]=gguf`, `/tree/main?recursive=true`, `/api/collections/...`), model cards, GitHub READMEs, releases and PRs (via `gh api`), the local `llama-server --help`, and the symbol strings of the installed `libllama.0.5.0.dylib`. Starting point: [rafska/awesome-local-llm](https://github.com/rafska/awesome-local-llm).

File sizes are the sum of the GGUF shards in the HF tree listing, in decimal GB. "Supported in build 11146" means the GGUF architecture string appears in the installed `libllama.0.5.0.dylib` and no later PR was needed. **unverified** marks anything I could not confirm from a primary source.

---

## 0. Executive recommendation

### The one action that matters most: upgrade llama.cpp 0.5.0 (b11146) to 0.8.0

The installed llama.cpp is `0.5.0 (build 11146, commit 7fe450e19)`, committed 2026-09-23. Homebrew stable is now **0.8.0** (released 2026-10-28; upstream is at b12005). A lot of what mux needs landed after 09-23:

| Landed upstream (merged) | PR | Why mux cares |
|---|---|---|
| `/v1/systemone` endpoint, TypeSafe-compatible (laya, julia-1, lev, openjev, kev), 2026-10-02 | #29818 | mux's `/v1/systemone` can proxy straight to a llama-server child, the same way chat does. Laya no longer needs ONNX. |
| Clef decision model (text 10-03, vision 10-05) | #29831, #29969 | Cloudflare's Clef/Clef-Flash run natively. They say they are "fully compatible with Jev and SystemOne". |
| EmbeddingGemma 2 (`gemma-embedding2`), 10-06 | #30054 | the newest multimodal embedder |
| Nemotron 3.5 Super VL + Bolt 74B-A9B, 10-15 | #30520 | Bolt-24GB, a 74B VLM in 22 GB |
| Flint (`FlintForCausalLM`), 10-21 | #30928 | the strongest coding model that fits |
| LFM3 family + d1-2B / d1-Omni-2B, 10-27 | #31252, #31257, #31275 | tiny fast models and Liquid's decision models |
| Granite Switch Decision, vllm-d3, lfm2-d1 decision types | (v0.8.0 release notes) | more `/v1/systemone` backends |

The v0.8.0 release notes confirm it includes "LFM3 ... Flint ... Granite Switch Decision, plus decision/embedding models from LiquidAI, Baidu and NVIDIA". Running `brew upgrade llama.cpp` is up to the user. I did not run it. After upgrading, re-check `--help` flags. The ones mux relies on are all present in 0.5.0: `--parallel`, `--cont-batching`, `--cache-reuse`, `--cache-ram`, `--embedding`, `--rerank`, `--mmproj`, `--jinja`, `--reasoning*`, `--spec-type draft-mtp|draft-dflash|draft-dspark|draft-eagle3`, `--sleep-idle-seconds`, `--metrics`, and router mode `--models-dir/--models-max`.

### Setup I would run on this Mac (≈48 GB budget)

**Always loaded ("hot set", ≈34 GB weights + ≈6–8 GB KV/compute ≈ 40–42 GB):**

| Route | Model | File | GB | Why |
|---|---|---|---|---|
| `agent` (default), `smart` | Qwen3.6-35B-A3B | `unsloth/Qwen3.6-35B-A3B-GGUF` · `Qwen3.6-35B-A3B-UD-Q4_K_M.gguf` | 22.13 | MoE with 3B active. Already in mux's catalog at ≈80 tok/s measured here. Best agent per GB. Ornith-1.5-35B-A3B (MIT, same arch, 21.71 GB) is a drop-in challenger that reports higher coding/agent scores. |
| `fast`, `classifier` | Qwen3.5-4B | `unsloth/Qwen3.5-4B-GGUF` · `Qwen3.5-4B-Q4_K_M.gguf` | 2.74 | snappy replies, simple tools, vision via mmproj |
| `systemone` (quality) | **Clef-Flash 9B** | `ggml-org/Clef-Flash-GGUF` · `Clef-Flash-Q4_K_M.gguf` (+`mmproj-Clef-Flash-Q8_0.gguf` 0.62) | 6.73 | Jev/SystemOne-native. One forward pass answers all questions jointly. Median 38.8 ms on Cloudflare hardware (Mac latency unverified). **Needs llama.cpp ≥ 0.8.0.** |
| `systemone` (fast tier) | Laya | `ggml-org/Laya-GGUF` · `Laya-Q8_0.gguf` (or keep the existing `@receptron/laya` ONNX) | 0.45 | about 5.8 ms median in Clef's table. Much weaker. Use it for cheap gates and as the fallback. |
| `embed` | Qwen3-Embedding-0.6B | `Qwen/Qwen3-Embedding-0.6B-GGUF` · `Qwen3-Embedding-0.6B-Q8_0.gguf` | 0.64 | 100+ languages, supported now |
| `rerank` | Qwen3-Reranker-0.6B | `ggml-org/Qwen3-Reranker-0.6B-Q8_0-GGUF` · `qwen3-reranker-0.6b-q8_0.gguf` | 0.64 | `llama-server --rerank` → `/v1/rerank` |

**On demand (swap in, LRU/TTL out; one at a time next to the hot set):**

| Route | Model | GB | Note |
|---|---|---|---|
| `reasoning`, `smart` (top quality) | Qwen3.8-27B `UD-Q4_K_M` | 16.46 | dense and slow (dense-27B speed, unverified ~20–25 tok/s), highest general quality that fits |
| `multilingual` (Danish), `vision` | Gemma 4 26B-A4B `UD-Q4_K_M` | 16.95 | 140+ languages per card, MoE speed, strong vision |
| `code` | Flint `Q4_K_M` (bartowski) | 25.35 | SWE-bench Verified 74.2% per card. **Needs ≥ 0.8.0.** Fallback before upgrading: Devstral-Small-2-24B Q4_K_M, 14.33 GB. |
| `vision` (heavy) / agent alt | Nemotron-3.5-Bolt-74B-A9B-24GB | 22.02 + 1.73 mmproj | 2-bit QAT VLM. **Needs ≥ 0.8.0.** |

**Optional filters** (load only when a tenant enables them): Qwen3Guard-Gen-0.6B (0.80 GB Q8) for safety and openai/privacy-filter ONNX (q4 ≈0.92 GB) for PII. Both are cheap enough to keep resident if used.

**Backends:**
- **Primary: llama.cpp `llama-server`, one process per model** (what mux already does). It is the only engine here with OpenAI + Anthropic (`/v1/messages`) + embeddings + rerank + `/v1/systemone` + Prometheus `/metrics` + `/health` in one binary. Its architecture coverage is the widest, and Homebrew ships it.
- **Secondary: MLX through omlx** (`omlx serve --model-dir ...`, port 8000). It is OpenAI- and Anthropic-compatible and also serves `/v1/embeddings`, `/v1/rerank` and `/v1/systemone`. It adds continuous batching and an SSD-tiered KV cache. Its model management is multi-model with LRU, TTL and pinning, so mux should treat it as **one managed upstream**, not one process per model. If mux wants strict one-model-per-process MLX, use `vllm-mlx serve <repo> --port N --continuous-batching`. `mlx_lm.server` is the zero-dependency fallback, but its own docs say it is "not recommended for production".
- **Router:** use the systemone model itself (Clef-Flash, or Laya for the cheapest pass) to answer "which route?" as a `choice` question. It returns calibrated probabilities with no text parsing, and mux already speaks the shape. Arch-Router-1.5B (0.99 GB) is a good second opinion when routes are described in free text.

---

## 1. Inference engines

| Engine | Latest (verified) | Apple Silicon | OpenAI API | Anthropic `/v1/messages` | Tool calling | Concurrency / batching | Prompt cache | Model swapping | Maturity | Fit for mux |
|---|---|---|---|---|---|---|---|---|---|---|
| **llama.cpp `llama-server`** | v0.8.0 (2026-10-28); installed 0.5.0 b11146 | Metal, first-class | yes (`/v1/chat/completions`, `/v1/completions`, `/v1/responses`, `/v1/embeddings`, `/v1/rerank`) | yes (`/v1/messages`, `count_tokens`), seen in the binary's strings | Good with `--jinja` + per-model parsers (minicpm5, qwen, gemma, gpt-oss harmony, ...) | `--parallel N` slots + `--cont-batching`, `--kv-unified` | `--cache-reuse`, `--cache-ram` (host prompt cache), `--slot-save-path`, ctx checkpoints for SWA/hybrid | Router mode built in: `--models-dir`, `--models-preset`, `--models-max`, `--models-autoload`, `--sleep-idle-seconds` | Very high (132.8k★) | **Primary.** Already integrated. Also gives `/v1/systemone` after the upgrade. |
| **mlx-lm** (`mlx_lm.server`) | v0.32.2 (2026-10-16) | native MLX | partial (chat/completions, `/v1/models`) | no (unverified) | Through templates. Basic. | basic batching; "A quantized KV cache does not support batching" | prompt cache in-process | none (one model per server; `model` field can load) | High as a library. Server not for production. | Fallback MLX runner |
| **mlx-vlm** | v0.7.11 (2026-10-28) | native MLX | has a server (unverified details) | unverified | limited | limited | – | – | Medium-high (5.7k★) | Only if a VLM is MLX-only |
| **omlx** | v0.7.3rc1 (2026-10-27) | native MLX, macOS 15+, needs custom kernels for Qwen3.5/GLM-5.2 (DMG ships them) | yes, plus `/tokenize` | yes, including adaptive thinking | "all function calling formats available in mlx-lm", JSON-schema validation, MCP | **continuous batching** via mlx-lm BatchGenerator, `--max-concurrent-requests` | **hot RAM + cold SSD KV tiers**, prefix sharing, CoW, survives restart | multi-model EnginePool: LRU, pin, per-model TTL, aliases, profiles; GGUF via external "Splash" engine | Fast-moving (23.2k★), RC releases | **Secondary (MLX).** Add as a "managed upstream" backend. Also has `/v1/systemone`. |
| **vllm-mlx** (waybarrios) | v0.6.0 (2026-10-20) | native MLX | yes | yes | MCP tool calling, reasoning parsers | **continuous batching**, paged KV, prefix cache, SSD-tiered cache | yes | one model per process (+ optional embedding model) | Medium (1.6k★) | Best fit for mux's one-process-per-model design on MLX |
| **vllm-metal** (vllm-project) | v0.32.0 (2026-10-21) | vLLM plugin with MLX compute | yes (vLLM server) | vLLM's | vLLM parsers | real vLLM scheduler + paged varlen Metal kernel | prefix caching | one model per process; sleep mode | Medium (1.9k★), official vLLM project | Interesting. Runs Qwen3.8 and Flint INT4, and DiffusionGemma System-1 decisions. Heavy Python install. |
| **Ollama** | v0.40.13 (2026-10-28) | Metal (llama.cpp-derived engine) plus an MLX engine (MLX PRs merged Oct 2026, including `mlx: add d3 decision model support` #19196) | yes | yes, "a subset" | good | `OLLAMA_NUM_PARALLEL` | yes | built-in load/unload with keep-alive | Very high (185k★) | No benefit over raw llama-server for mux. It hides GGUF files and flags. Its `/v1/systemone` exists but has open issues (#18718). |
| **llama-swap** | v268 (2026-10-28) | Go binary, any upstream | proxies OpenAI + Anthropic + rerank + audio | yes (proxy) | upstream's | concurrent models via a "swap matrix" DSL | upstream's | **its whole purpose**: on-demand swap, `ttl`, preload hooks, `/upstream/:model` passthrough, `/running`, `/api/models/unload` | High (6.1k★) | mux already does this job. Borrow its ideas (§5), don't run it. |
| **Strata** | v0.2.8 (2026-10-29) | Mac DMG (arm64). Mac docs exist. Aimed at running Qwen3.8-Flash-Next (180B) / DeepSeek V4.1 with SSD offload. | yes | yes | yes (unverified quality) | unverified | unverified | per-family launcher | Young but popular (36k★) | Not useful here. Its flagship models (Qwen3.8-Flash-Next UD-Q4_K_XL = 111 GB) exceed mux's budget. |
| **exo** | v1.0.71 (2026-04-23) | MLX + MLX distributed, RDMA over Thunderbolt 5 | yes, plus Responses and Ollama API | yes | unverified | – | – | cluster placement | High (48k★), aimed at multiple Macs | Only if a second Mac joins. Not for a single box. |
| **mistral.rs** | v0.9.5 (2026-10-19) | Metal; paged attention default on Metal in 0.9.5 | yes (+ `/v1/files`, `/v1/skills`) | yes | good (agentic runtime built in) | paged attention, continuous batching | prefix caching | multi-model (unverified details) | Medium (7.8k★) | A credible third backend. Loads GGUF and HF safetensors with ISQ, supports LFM3 and Gemma 4 audio. Launch with `mistralrs serve ...`, `/metrics` exposed. |
| **LM Studio** (`lms`) | app; `lms` CLI (MIT) | llama.cpp + MLX engines | yes | unverified | good | unverified | yes | `lms load/unload/ps` | High (closed app) | Not scriptable enough for a headless control plane. `lms ls --decision` shows it also knows decision models. |
| **ik_llama.cpp** | no releases (rolling) | Metal is explicitly low priority ("issues related to ... Metal ... will not get resolved") | llama-server fork | unverified | – | – | – | – | CPU/CUDA focused | Skip on Mac |
| **vLLM (main)** | – | via vllm-metal only | – | – | – | – | – | – | – | `/v1/systemone` for d3 landed on vLLM main 2026-10-14 (per the d3 card). Use vllm-metal if mux ever needs it. |

### Adding a backend type cheaply

Every candidate speaks OpenAI on `/v1/*`. A mux backend only needs three things: **launch**, **health**, and **base URL**.

| Backend | Launch (per model) | Health | Notes |
|---|---|---|---|
| llama-server | `llama-server -m <gguf> [--mmproj f] --port P --jinja -np 4 -c CTX --metrics [--embedding\|--rerank]` | `GET /health` (public; `/v1/health` too). `GET /v1/models` exposes `architecture.output_modalities`, e.g. `["decisions"]` for systemone models. | Use `output_modalities` to auto-classify a model as `systemone` instead of hard-coding it. |
| vllm-mlx | `vllm-mlx serve <mlx-repo> --host 127.0.0.1 --port P --continuous-batching [--reasoning-parser qwen3]` | `GET /v1/models` (no documented `/health` found; unverified) | Python venv. One model per process, the same lifecycle as llama-server. |
| omlx | `omlx serve --model-dir <dir> --max-concurrent-requests 16` (port 8000 default, `OMLX_PORT`) | `GET /v1/models`; admin API under `/admin` with Bearer key | One process holds many models. Model it as a single upstream and list its models into mux's catalog. Let omlx do LRU/TTL inside its own memory cap, and count that cap against mux's 48 GB. |
| mlx_lm.server | `mlx_lm.server --model <repo> --port P` | `GET /v1/models` | simplest; no Anthropic API |
| mistral.rs | `mistralrs serve ... --port P` (exact flags unverified) | `/metrics` (Prometheus); health unverified | OpenAI + Anthropic |

---

## 2. Models that fit (≤ ~45 GB)

Legend for "11146": ✅ arch present in installed lib · ⬆ needs llama.cpp ≥ 0.8.0 · ❌ not in llama.cpp.

### 2a. Fast / cheap chat

| Model | GGUF repo · file | GB | GGUF arch | ctx | License | 11146 | MLX repo |
|---|---|---|---|---|---|---|---|
| Qwen3.5-4B | `unsloth/Qwen3.5-4B-GGUF` · `Qwen3.5-4B-Q4_K_M.gguf` (+`mmproj-F16.gguf` 0.67) | 2.74 | qwen35 | 262144 | apache-2.0 | ✅ | (mlx-community, not checked) |
| LFM3-1.7B | `LiquidAI/LFM3-1.7B-GGUF` · `LFM3-1.7B-Q4_K_M.gguf` | 1.10 | lfm3 | 262144 | LFM Open License v1.0 (`lfm1.0`) | ⬆ | `mlx-community/LFM3-1.7B-OptiQ-4bit` |
| MiniCPM5-2B | `openbmb/MiniCPM5-2B-GGUF` · `MiniCPM5-2B-Q8_0.gguf` | 2.68 | llama | 131072 | apache-2.0 | ✅ (minicpm5 parser #24889) | `openbmb/MiniCPM5-2B-MLX`, `mlx-community/MiniCPM5-2B-8bit` |
| Gemma 4 E4B | `unsloth/gemma-4-E4B-it-GGUF` · `gemma-4-E4B-it-Q4_K_M.gguf` (+`mmproj-F16.gguf` 0.99) | 4.98 | gemma4 | 131072 | apache-2.0 | ✅ | `mlx-community/gemma-4-e4b-it-4bit` |
| Nemotron-3.5-Bolt-E4B (Gemma 4 E4B fine-tune, lists Danish) | `unsloth/NVIDIA-Nemotron-3.5-Bolt-E4B-GGUF` · `NVIDIA-Nemotron-3.5-Bolt-E4B-UD-Q4_K_XL.gguf` | 5.06 | gemma4 | 131072 | NVIDIA openmdw-1.1 | ✅ | – |
| Granite 4.1 3B | `ibm-granite/granite-4.1-3b-GGUF` · `granite-4.1-3b-Q4_K_M.gguf` | 2.10 | granite | 131072 | apache-2.0 | ✅ | `mlx-community/granite-4.1-3b-4bit` |

### 2b. Agent with tool calling

| Model | GGUF repo · file | GB | arch | ctx | License | 11146 | MLX | Notes |
|---|---|---|---|---|---|---|---|---|
| **Qwen3.6-35B-A3B** | `unsloth/Qwen3.6-35B-A3B-GGUF` · `Qwen3.6-35B-A3B-UD-Q4_K_M.gguf` (+`mmproj-F16.gguf` 0.90) | 22.13 | qwen35moe | 262144 | apache-2.0 | ✅ | `mlx-community/Qwen3.6-35B-A3B-4bit` | in catalog, ~80 tok/s measured |
| **Ornith-1.5-35B-A3B** | `ornith-ai/Ornith-1.5-35B-A3B-GGUF` · `Ornith-1.5-35B-Q4_K_M.gguf` (+`mmproj-Ornith-1.5-35B-BF16.gguf` 0.90) | 21.71 | qwen35moe | 262144 | MIT | ✅ | `ornith-ai/Ornith-1.5-35B-A3B-MLX` | Card: Terminal-Bench 2.1 67.8 vs Qwen3.6-35B-A3B 52.5 (developer-reported) |
| Occamy-1.0 (Qwen3.6-35B-A3B fine-tune, "co-work") | `Accio-Lab/occamy-1.0-GGUF` · `occamy-1.0-Q4_K_M.gguf` (+`mmproj-occamy-1.0-F16.gguf`) | 21.17 | qwen35moe | 262144 | apache-2.0 | ✅ | none in mlx-community | BFCL v4 / Terminal-Bench tables on the card |
| Nemotron-3.5-Lightning-30B-A3B | `unsloth/NVIDIA-Nemotron-3.5-Lightning-30B-A3B-GGUF` · `...-UD-Q4_K_M.gguf` | 25.27 | nemotron_h_moe | 1048576 | openmdw-1.1 | ✅ (arch from Aug; conversion fix #27729 08-26) | `mlx-community/NVIDIA-Nemotron-3.5-Lightning-30B-A3B-4bit` | Card: SWE-bench Verified 70.12, GPQA-D 83.4. Lists Danish. 1M ctx. ggml-org ships an `mtp-...Q8_0.gguf` (2.18 GB) for MTP speculation. |
| Nemotron-3.5-Bolt-74B-A9B-24GB (VLM) | `nvidia/NVIDIA-Nemotron-3.5-Bolt-74B-A9B-24GB-GGUF` · `NVIDIA-Nemotron-3.5-Bolt-74B-A9B-24GB.gguf` (+`mmproj-...-24GB.gguf` 1.73) | 22.02 | nemotron_h_moe | 262144 | openmdw-1.1 | ⬆ (#30520, 10-15) | – | native 2-bit QAT |
| gpt-oss-20b | `ggml-org/gpt-oss-20b-GGUF` · `gpt-oss-20b-MXFP4.gguf` (native MXFP4; `eagle3-gpt-oss-20b-Q8_0.gguf` 0.92 draft) | 12.11 | gpt-oss | 131072 | apache-2.0 | ✅ | `mlx-community/gpt-oss-20b-MXFP4-Q4` | in catalog |
| GLM-4.7-Flash | `unsloth/GLM-4.7-Flash-GGUF` · `GLM-4.7-Flash-Q4_K_M.gguf` (UD-Q4_K_XL 17.52) | 18.31 | deepseek2 | 202752 | MIT | ✅ | `mlx-community/GLM-4.7-Flash-4bit` | Card: τ²-Bench 79.5, SWE-bench Verified 59.2 |
| Qwen3.5-9B / Ornith-1.5-9B | `unsloth/Qwen3.5-9B-GGUF` · `Qwen3.5-9B-Q4_K_M.gguf` 5.68 / `ornith-ai/Ornith-1.5-9B-GGUF` · `Ornith-1.5-9B-Q4_K_M.gguf` 5.78 | 5.7 | qwen35 | 262144 | apache / MIT | ✅ | `ornith-ai/Ornith-1.5-9B-MLX` | small always-on agents |
| Granite 4.1 8B / 30B | `ibm-granite/granite-4.1-8b-GGUF` · `granite-4.1-8b-Q4_K_M.gguf` 5.35 / `granite-4.1-30b-Q4_K_M.gguf` 17.49 | – | granite (dense) | 131072 | apache-2.0 | ✅ | `mlx-community/granite-4.1-8b-4bit`, `...-30b-4bit` | enterprise/RAG tone, BFCL v3 reported |

### 2c. Code

| Model | GGUF repo · file | GB | arch | ctx | License | 11146 | MLX | Notes |
|---|---|---|---|---|---|---|---|---|
| **Flint** (≈40B MoE, ~2.5B active per community repo names; unverified) | `bartowski/RecursiveSI_flint-GGUF` · `RecursiveSI_flint-Q4_K_M.gguf` (alt `unsloth/flint-GGUF` · `flint-UD-Q4_K_XL.gguf` 25.05) | 25.35 | flint | 262144 | apache-2.0 | ⬆ (#30928, 10-21) | `mlx-community/flint-OptiQ-4bit` | Card: SWE-bench Verified 74.2%, Terminal-Bench 2.1 54.9% |
| Devstral-Small-2-24B | `unsloth/Devstral-Small-2-24B-Instruct-2512-GGUF` · `Devstral-Small-2-24B-Instruct-2512-Q4_K_M.gguf` (+`mmproj-F16.gguf` 0.88) | 14.33 | mistral3 | 393216 | apache-2.0 (base); unsloth tags "other" | ✅ | `mlx-community/Devstral-Small-2-24B-Instruct-2512-4bit` | dense. Mistral tool format. |
| Ornith-1.5-35B-A3B | see 2b | 21.71 | qwen35moe | 262144 | MIT | ✅ | yes | coding-tuned |
| Qwen3-Coder-Next (80B-A3B) | `Qwen/Qwen3-Coder-Next-GGUF` · `Qwen3-Coder-Next-Q4_K_M/Qwen3-Coder-Next-Q4_K_M.gguf` | **48.41** | qwen3next | 262144 | apache-2.0 | ✅ | – | **Over budget.** The smallest sane option is `unsloth/...-UD-Q4_K_S.gguf` at 46.08 GB. Only run it alone, with everything else unloaded. |
| Devstral 2 123B, Mistral Medium 3.5 128B, Laguna-S-2.1 118B | – | ≥ 65 | – | – | – | – | – | do not fit |

### 2d. Reasoning / top quality

| Model | GGUF repo · file | GB | arch | ctx | License | 11146 | MLX |
|---|---|---|---|---|---|---|---|
| **Qwen3.8-27B** (dense, vision) | `unsloth/Qwen3.8-27B-GGUF` · `Qwen3.8-27B-UD-Q4_K_M.gguf` (+`mmproj-F16.gguf` 0.93); ggml-org adds `mtp-Qwen3.8-27B-Q8_0.gguf` 3.16 and `dflash-...Q8_0.gguf` 2.06 for speculative decoding | 16.46 | qwen35 | 262144 | apache-2.0 | ✅ | `mlx-community/Qwen3.8-27B-4bit` (and `-MTP-4bit`) |
| Gemma 4 31B (dense) | `unsloth/gemma-4-31B-it-GGUF` · `gemma-4-31B-it-Q4_K_M.gguf` (+`mmproj-F16.gguf` 1.20) | 18.32 | gemma4 | 262144 | apache-2.0 | ✅ | `mlx-community/gemma-4-31b-it-4bit` |
| Nemotron-3.5-Lightning-30B-A3B | see 2b | 25.27 | nemotron_h_moe | 1M | openmdw-1.1 | ✅ | yes |
| Qwen3.8-Flash-Next (180B) | `unsloth/...-UD-Q4_K_XL` | 111.33 | qwen4exp | – | qwen-community-1.0 | ✅ | – | does not fit (this is what Strata targets) |

The speculative-decoding draft heads (MTP / DFlash / DSpark / EAGLE3) published in ggml-org and unsloth repos are a cheap speed win. llama-server already exposes `--spec-type draft-mtp|draft-dflash|draft-dspark|draft-eagle3`. Throughput gains on M3 Ultra are unverified.

### 2e. Vision

| Model | File | GB | Notes |
|---|---|---|---|
| Gemma 4 26B-A4B | `unsloth/gemma-4-26B-A4B-it-GGUF` · `gemma-4-26B-A4B-it-UD-Q4_K_M.gguf` + `mmproj-F16.gguf` (1.19) | 16.95 | gemma4, 262144, apache-2.0, ✅. MLX: `mlx-community/gemma-4-26b-a4b-it-4bit` |
| Gemma 4 12B (unified any-to-any) | `unsloth/gemma-4-12b-it-GGUF` · `gemma-4-12b-it-Q4_K_M.gguf` + `mmproj-F16.gguf` (0.18) | 7.12 | GGUF arch gemma4; libmtmd has `gemma4ua/uv` ✅ |
| Qwen3.8-27B / Qwen3.6-35B-A3B | mmproj in repo | – | images and video |
| LFM3-VL-2B | `LiquidAI/LFM3-VL-2B-GGUF` · `LFM3-VL-2B-Q4_K_M.gguf` + `mmproj-LFM3-VL-2B-Q8_0.gguf` (0.20) | 1.10 | ⬆; tiny OCR-ish vision |
| Nemotron-3.5-Bolt-74B-A9B-24GB | see 2b | 22.02 + 1.73 | ⬆ |

### 2f. Danish / multilingual

- **Gemma 4** (card: "140 languages", "35+ languages" out of the box) is the best Danish lane. Use 26B-A4B for quality and E4B for speed.
- **Nemotron 3.5 Bolt-E4B** explicitly tags `da` in its HF language list. Nemotron 3.5 Lightning's card mentions Danish.
- Qwen3.5/3.6/3.8 are broadly multilingual (Qwen3.6 card says "Multilingual"; no Danish-specific claim found). Granite 4.1 is "multilingual" (no list checked).
- For embeddings: Qwen3-Embedding (100+ languages) and EmbeddingGemma 2 (100+ languages; card also says 140). For systemone: `convaiinnovations/laya-multilingual` (ONNX at `onnx-community/laya-multilingual-ONNX`) and `fastino/GLiNER2.5-multi-Decide`.

### 2g. Embeddings

| Model | GGUF repo · file | GB | arch | ctx | License | 11146 | MLX |
|---|---|---|---|---|---|---|---|
| **Qwen3-Embedding-0.6B** | `Qwen/Qwen3-Embedding-0.6B-GGUF` · `Qwen3-Embedding-0.6B-Q8_0.gguf` | 0.64 | qwen3 | 32768 | apache-2.0 | ✅ | `mlx-community/Qwen3-Embedding-0.6B-8bit` |
| Qwen3-Embedding-4B / 8B | `Qwen/Qwen3-Embedding-4B-GGUF` · `Qwen3-Embedding-4B-Q4_K_M.gguf` 2.50 / `...-8B-Q4_K_M.gguf` 4.68 | – | qwen3 | 40960 | apache-2.0 | ✅ | `-4bit-DWQ` variants |
| **EmbeddingGemma 2** (multimodal: text, image, audio, video, 768-d) | `ggml-org/embeddinggemma-2-GGUF` · `embeddinggemma-2-Q8_0.gguf` (+`mmproj-embeddinggemma-2-Q8_0.gguf` 0.55 for media) | 0.31 | gemma-embedding2 | 262144 (GGUF metadata) | apache-2.0 | ⬆ (#30054) | `mlx-community/embeddinggemma-2-8bit` |
| EmbeddingGemma 300M | `ggml-org/embeddinggemma-300M-GGUF` · `embeddinggemma-300M-Q8_0.gguf` | 0.33 | gemma-embedding | 2048 | gemma | ✅ (`--embd-gemma-default`) | `mlx-community/embeddinggemma-300m-8bit` |
| Nemotron-3.5-Embed-1B / 8B (multimodal, multilingual incl. da) | only community GGUFs (`W4D/...`, `mradermacher/...`) | – | mistral3 | – | openmdw-1.1 | unverified (tokenizer fix #30974 merged 10-23) | – |

### 2h. Rerankers

| Model | GGUF repo · file | GB | License | 11146 |
|---|---|---|---|---|
| **Qwen3-Reranker-0.6B** | `ggml-org/Qwen3-Reranker-0.6B-Q8_0-GGUF` · `qwen3-reranker-0.6b-q8_0.gguf` | 0.64 | apache-2.0 | ✅ (`--rerank`) |
| Qwen3-Reranker-4B | community only (`mradermacher/Qwen3-Reranker-4B-GGUF`, files not checked) | ~2.5 (unverified) | apache-2.0 | ✅ arch |
| Nemotron-3.5-Rerank-8B | no GGUF found | – | openmdw-1.1 | – |
| A systemone model as a reranker | Clef's card reports ToolRet nDCG@10 69.2 and BRIGHT 45.9. d1-2B lists "judging and reranking". | – | – | ⬆ |

---

## 3. Router / orchestrator / decision models

Key finding: **upstream llama-server now implements `/v1/systemone`** with the exact TypeSafe shape mux uses: `{state, questions:{id:{type: choice|score|noul, instructions, criteria}}}` → `{model, answers:{id:{choice, probabilities, confidence} | {score, legend, probabilities, confidence} | {noul}}, usage}`. Images are supported via `files`/`images` data URLs. Supported decision types include laya, openjev, lev, kev, julia-1, **clef**, **vllm-d3**, **lfm2-d1**, **lfm2-d1-omni**, **granite-switch**, pplx-decider, h2o-lightning and vllm-decision2. A clef server serves *only* this endpoint. `GET /v1/models` reports `output_modalities: ["decisions"]`. Errors: 400 for an invalid request, 501 for a non-decision model or unsupported images.

So most of the rows below become "spawn one more llama-server and forward the body". For a `systemone`-kind model, mux's integration cost is near zero.

| Model | Input | Params / size | Runtime | License | Latency (published) | Jev/systemone compatible? | How mux integrates |
|---|---|---|---|---|---|---|---|
| **Cloudflare/clef-flash** | state (text/JSON) + images/video + typed questions; one pass, joint scoring | 9.4B (Qwen3.5-9B base) · `ggml-org/Clef-Flash-GGUF` `Clef-Flash-Q4_K_M.gguf` 6.73 GB | llama.cpp ⬆ (arch `clef`), MLX (`mlx-community/clef-flash-4bit`), SGLang, transformers | apache-2.0 | median 38.8 ms / p95 122 ms (Cloudflare infra) | **Yes**: card says "The Clef API is fully compatible with Jev and SystemOne". Same field names. | `llama-server -m Clef-Flash-Q4_K_M.gguf --mmproj mmproj-Clef-Flash-Q8_0.gguf --port P`. Forward `/v1/systemone`. Whole prompt must fit in `--ubatch-size`, so raise `-ub`. |
| **Cloudflare/clef** | same | 27.4B (Qwen3.8-27B) · `ggml-org/Clef-GGUF` `Clef-Q4_K_M.gguf` 19.54 GB (bartowski 17.65) | same | apache-2.0 | median 209 ms (Cloudflare infra) | Yes | quality tier. Decision Index wins on BANKING77, CLINC150, RAGTruth. |
| Laya (current mux backend) | Jev shape | ModernBERT, `ggml-org/Laya-GGUF` `Laya-Q8_0.gguf` 0.45 GB | llama.cpp ⬆ (`modern-bert` + decision head), ONNX (`onnx-community/laya-ONNX`), LiteRT, MLX | apache-2.0 | median 5.8 ms | Yes (first-class in llama.cpp #29818) | keep as the ultra-fast tier, or move it from ONNX to llama-server for one runtime |
| **vllm-sr d3** family (Decision 3.0) | Jev shape + images + video | edge 0.6B, lite 0.85B, nano 2.2B, mini 4.5B, flash 8.4B, d3 26B; `ggml-org/vllm-d3-nano-GGUF` `vllm-d3-nano-Q8_0.gguf` 2.55, `vllm-d3-mini-Q4_K_M.gguf` 3.71, `vllm-d3-flash-Q4_K_M.gguf` 6.60 | llama.cpp ⬆ (`vllm-d3` type), vLLM main `/v1/systemone`, Ollama MLX (#19196), transformers custom code | apache-2.0 | d3 (26B): 54.4 ms median text on MI325X | Yes ("Jev Decision Index 0.3.2: 66.3, first on the official text board") | same as Clef. d3-nano/mini are good mid tiers between Laya and Clef-Flash. |
| **LiquidAI d1-3B** | Jev shape (`noul`, `choice`, `score`) + images | 3.1B (LFM2.5-VL-3B) · `LiquidAI/d1-3B-GGUF` `d1-3B-Q4_K_M.gguf` 1.67 (+mmproj Q8 0.58) | llama.cpp ⬆ (`lfm2-d1`; arch lfm2), MLX `LiquidAI/d1-3B-MLX-4bit`, LiteRT | LFM Open License v1.0 (revenue-limited; check terms) | **30 ms on Apple M5 Pro**, 41 ms for 3 questions | Yes (Decision Index schema, `system_one()`) | same; good Mac latency |
| LiquidAI d1-omni-600M | + audio | 0.59B · `LiquidAI/d1-omni-600M-GGUF` `d1-omni-600M-Q8_0.gguf` 0.41 (+mmproj 0.26) | llama.cpp ⬆ (`lfm2-d1-omni`), ONNX `onnx-community/d1-omni-600M-ONNX` | lfm1.0 | unverified | Yes | audio gates |
| LiquidAI d1-2B / d1-Omni-2B (LFM3) | + video; `multiple` choice, counts, boxes | 1.9B · `LiquidAI/d1-2B-GGUF` `d1-2B-Q4_K_M.gguf` 1.10 | llama.cpp ⬆ (#31275, 10-27), ONNX `LiquidAI/d1-2B-ONNX`, MLX | lfm1.0 | 5.7 ms on H100 | Yes, with extensions | newest Liquid tier |
| IBM granite-switch-4.1-8b | chat **and** decisions | 8.9B · `ibm-granite/granite-switch-4.1-8b-GGUF` `granite-switch-4.1-8b-Q4_K_M.gguf` 6.41 | llama.cpp (arch `graniteswitch` ✅; decision support ⬆) | apache-2.0 | unverified | Yes (`["text","decisions"]`) | one process serves both chat and systemone |
| **GLiNER2.5-Decide** / -multi-Decide / -1B | text + label schema (`classify_text(task, labels, label_descriptions, prompt, multi_label)`) | 0.49B / 0.29B / 1.19B | Python `gliner2` / transformers. ONNX `onnx-community/GLiNER2.5-Decide-ONNX` (q4/fp16). llama.cpp PR #30504 still **open**. | apache-2.0 | fast encoder (unverified ms) | **Not natively.** Different schema. Maps cleanly: choice→labels, noul→yes/no, score→ordinal labels. | run via onnxruntime-node next to Laya with a small adapter. Use the multi variant for Danish. |
| **Arch-Router-1.5B** | routes `[{name, description}]` + conversation → `{"route": name}` (generative) | 1.5B (Qwen2.5) · `katanemo/Arch-Router-1.5B.gguf` `Arch-Router-1.5B-Q4_K_M.gguf` 0.99 | llama.cpp ✅, MLX (`mlx-community/Arch-Router-1.5B-mlx-8Bit`) | katanemo-research (non-commercial-style; check) | tens of ms for a short JSON output (unverified) | No (text generation, needs JSON parsing) | load as a chat model. mux builds the prompt from its Routes table descriptions and parses `route`. Good for "preference" routes in free text. |
| Plano-Orchestrator-4B / 30B-A3B (Arch-Router successor, used by katanemo/plano) | agent/route orchestration | 4B / 30B-A3B · community GGUF only (`mradermacher/...`) | llama.cpp ✅ (qwen3 / qwen3moe) | katanemo-research | unverified | No | optional |
| Nemotron-Orchestrator-8B (ToolOrchestra) | multi-turn task + tool/model catalog with prices → tool calls to experts | 8.2B (Qwen3-8B) · `MaziyarPanahi/Nemotron-Orchestrator-8B-GGUF` `Nemotron-Orchestrator-8B.Q4_K_M.gguf` 5.03 | llama.cpp ✅ (qwen3) | NVIDIA License (card says so; HF field empty) | full generation, so seconds, not ms | No | an *agent* that calls mux routes as tools. It is not a per-request router. Out of scope for the hot path. |

**Recommendation for routing in mux:** ask the systemone backend a `choice` question whose criteria are the route descriptions, plus `noul` questions for "needs tools?", "needs vision?" and "is Danish?". Use Laya first. If confidence is below a threshold, escalate to Clef-Flash. Its calibrated probabilities feed directly into `router/select.ts` scoring. Keep Arch-Router as an optional "preference router" for tenants who write routes in prose.

---

## 4. Safeguard models (optional pre/post filters)

| Model | Purpose | Size | GGUF (repo · file · GB) | llama.cpp | License | Notes |
|---|---|---|---|---|---|---|
| **Qwen3Guard-Gen-0.6B** / 4B / 8B | prompt + response safety classification (Safe/Unsafe/Controversial + category), generative | 0.75B / 4.4B / 8B | `mradermacher/Qwen3Guard-Gen-0.6B-GGUF` · `Qwen3Guard-Gen-0.6B.Q8_0.gguf` 0.80; `mradermacher/Qwen3Guard-Gen-4B-GGUF` · `Qwen3Guard-Gen-4B.Q4_K_M.gguf` 2.72; `katanemo/Qwen3Guard-Gen-0.6B.gguf` (F16 1.51) | ✅ qwen3 | apache-2.0 | Qwen3Guard-Stream-* variants for token-level streaming moderation (transformers only, unverified GGUF) |
| **Granite Guardian 4.1 8B** | harm, jailbreak, RAG groundedness/hallucination, function-call checks | 8.4B | `ibm-granite/granite-guardian-4.1-8b-GGUF` · `granite-guardian-4.1-8b-Q4_K_M.gguf` 5.12 | ✅ granite | apache-2.0 | first-party GGUF. Also `granite-guardian-hap-38m/125m` (tiny HAP classifiers, transformers). |
| **Shieldstral-1.0-3B** (Mistral) | policy-adaptive multimodal safety classifier | 3.8B (Ministral-3-3B) | community: `noctrex/Shieldstral-1.0-3B-GGUF` · `Shieldstral-1.0-3B-Q4_K_M.gguf` 2.15 (+`mmproj-F32.gguf` 1.68) | ✅ mistral3 (prompt format via mistral-common; unverified in llama.cpp) | apache-2.0 | official release targets vLLM |
| **openai/privacy-filter** | PII token classification + masking (bidirectional) | 1.4B | **ONNX first-party**: `onnx/model_q4.onnx` (+data 0.92 GB), fp16 2.08 GB; transformers.js tag. GGUF `LocalAI-io/privacy-filter-GGUF` (arch `openai-privacy-filter`, LocalAI-specific) | ❌ | apache-2.0 | run in-process via onnxruntime-node like Laya. Multilingual fine-tunes: `OpenMed/privacy-filter-multilingual(-v2)`. |
| **NVIDIA Privasis-Cleaner-0.6B / 4B** | instruction-driven text sanitisation (rewrite/abstract PII) | 0.6B / 4B | `mradermacher/Privasis-Cleaner-0.6B-GGUF` · `Privasis-Cleaner-0.6B.Q8_0.gguf` 0.64; `mradermacher/Privasis-Cleaner-4B-GGUF` · `Privasis-Cleaner-4B.Q4_K_M.gguf` 2.50 | ✅ qwen3 | NVIDIA (other) | generative. Use when the output must be redacted text, not spans. |
| Nemotron-3.5-Content-Safety | multimodal, multilingual content safety (Gemma-3-4B base) | 4.3B | community `mradermacher/Nemotron-3.5-Content-Safety-GGUF` (files not checked) | ✅ gemma3 | openmdw | – |
| gpt-oss-safeguard-20b | policy-as-prompt reasoning safety | 21B (3.6B active) | `unsloth/gpt-oss-safeguard-20b-GGUF` · `gpt-oss-safeguard-20b-Q4_K_M.gguf` 11.62 | ✅ gpt-oss | apache-2.0 | heavy. Use for offline/async review. |
| A systemone model as a guard | `noul` questions such as "is this a jailbreak?" or "contains PII?" | – | Clef-Flash / d1 | ⬆ | – | Clef's card reports PhishNChips 79.6 and RAGTruth 79.4. This is probably the cheapest guard mux can offer, because the model is already loaded. |

Suggested mux shape: `guards: { pre: ["qwen3guard-0.6b", "privacy-filter"], post: ["qwen3guard-0.6b"] }` per tenant. A guard returns `{allow, categories, spans}`. Run pre-guards in parallel with routing.

---

## 5. Tools to borrow ideas from

| Tool | Version (verified) | Idea for mux |
|---|---|---|
| **llmfit** (AlexsJones, 38.5k★, v1.1.18) | Detects hardware (Apple unified memory), projects memory and tok/s per quant, scores models on quality/speed/fit/context, REST API (`/api/v1/system`, `/api/v1/models`), crowd-sourced measured benchmarks. | mux's advisor should show *fit* per catalog entry (weights + KV at `defaultCtx` vs the free budget) and replace estimated `caps.speed` with measured tok/s (llmfit's "✓ measured" idea). Sister project `llama-panel` is a macOS manager for llama-server instances. |
| **llama-swap** (v268) | One YAML file. `ttl` per model, preload `hooks`, a "swap matrix" DSL for which models can co-reside, `/upstream/:model` passthrough, `/running`, `/api/models/unload`, `/api/models/pause`, `/logs/stream`, `/metrics`, a playground UI with token metrics. | Add a co-residency rule ("these may be loaded together") to the memory planner. Add a pause/drain switch for when builds/VMs need the RAM. Add a raw passthrough for debugging. |
| **llama-server router mode** (built in) | `--models-dir`, `--models-preset` INI, `--models-max`, `--models-autoload`, `--sleep-idle-seconds`; `/models` reports `architecture.output_modalities` offline. | mux could delegate the *lifecycle* to one router-mode llama-server and keep only policy. Read `output_modalities` to auto-detect decision models. |
| **katanemo/plano** (ex-archgw, v0.4.39) | Envoy-based data plane. Preference routing via Arch-Router / Plano-Orchestrator, "Agentic Signals" plus OTEL traces, guardrail filters, model aliases ("semantic names"). | Route descriptions written as domain + action. Guardrail hooks as filters. OTEL export. |
| **LiteLLM** (v1.106.6) | Gateway: per-key budgets, cost tracking, fallbacks, load balancing, guardrails, a unified OpenAI format over 100+ providers. | Per-tenant spend/token budgets, fallback chains (local → cloud when local is saturated), request-level `metadata` tags. |
| **Langfuse** (v4.72.0) | Traces, sessions, prompt management, evals and datasets, scores. | Per-request trace with route decision, chosen model, systemone probabilities and latency split. Datasets of real requests to replay against new catalog models. |
| **Opik** (Comet, 2.2.137) | Tracing, LLM-as-judge evals, online scoring rules, dashboards. | Online evaluation: sample N% of responses and score them with a systemone `score` question ("answer quality 0–4") to learn per-route quality on real traffic. |
| **omlx** admin | Menu-bar app, `/admin` dashboard (load/unload badges, pin, TTL, profiles exposed as `model:profile` IDs, in-app benchmark). | Expose "profiles" (thinking on/off, reasoning effort) as virtual model IDs. No reload is needed, because they are per-request template kwargs in llama-server too (`chat_template_kwargs`, `reasoning_effort`). |

---

## 6. Notes, caveats, unverified

- Tok/s numbers other than mux's own Qwen3.6 measurement (~80 tok/s) are **unverified estimates**. Benchmark on this Mac before trusting `caps.speed`.
- Decision-model latencies come from vendor hardware (H200/H100/MI325X), except d1-3B, which has an Apple M5 Pro number. M3 Ultra numbers are **unverified**.
- Benchmarks quoted from model cards are developer-reported.
- Licenses: `lfm1.0` (LiquidAI) and `katanemo-research` have commercial restrictions. Read them before offering these to SaaS tenants. NVIDIA `openmdw-1.1` is an open-model licence (terms not reviewed here).
- Qwen3-Coder-Next Q4 (48.4 GB) and gpt-oss-120b (in the current catalog) exceed the 48 GB budget. Mark them "exclusive" (unload everything else first) or drop them.
- `ggml-org/Clef-Flash-GGUF` file sizes are verified. That `--ubatch-size` must cover the whole clef prompt comes from the llama.cpp README.
- The `lfm2-d1` decision type is named in the upstream README. d1-2B (arch lfm3) support is confirmed by merged PR #31275. Exact GGUF decision metadata in LiquidAI's repos is **unverified**.

---

## 7. Machine-readable catalog (recommended entries)

`caps` are 0–10 estimates. `routes` use mux's route names (`fast`, `classifier`, `agent`, `smart`, `code`, `reasoning`, `multilingual`, `vision`, `embed`, `rerank`, `systemone`, `router`, `guard`). `minLlamaCpp` marks entries that need llama.cpp ≥ 0.8.0.

```json
[
  {"id":"qwen3.5-4b","name":"Qwen3.5 4B","repo":"unsloth/Qwen3.5-4B-GGUF","file":"Qwen3.5-4B-Q4_K_M.gguf","mmproj":"mmproj-F16.gguf","sizeGb":2.74,"arch":"qwen35","ctx":262144,"license":"apache-2.0","kind":"chat","routes":["fast","classifier"],"caps":{"quality":5.5,"speed":9,"tools":6.5,"code":5,"reasoning":5,"multilingual":6,"vision":5},"notes":"Fast-lane default; supported in b11146."},
  {"id":"lfm3-1.7b","name":"LFM3 1.7B","repo":"LiquidAI/LFM3-1.7B-GGUF","file":"LFM3-1.7B-Q4_K_M.gguf","sizeGb":1.10,"arch":"lfm3","ctx":262144,"license":"lfm1.0","kind":"chat","routes":["fast","classifier"],"caps":{"quality":4,"speed":10,"tools":5,"code":3.5,"reasoning":3.5,"multilingual":5.5,"vision":0},"notes":"Needs llama.cpp >= 0.8.0 (PR #31252). LFM licence has commercial limits.","mlxRepo":"mlx-community/LFM3-1.7B-OptiQ-4bit","minLlamaCpp":"0.8.0"},
  {"id":"minicpm5-2b","name":"MiniCPM5 2B","repo":"openbmb/MiniCPM5-2B-GGUF","file":"MiniCPM5-2B-Q8_0.gguf","sizeGb":2.68,"arch":"llama","ctx":131072,"license":"apache-2.0","kind":"chat","routes":["fast"],"caps":{"quality":4.5,"speed":9.5,"tools":6,"code":4,"reasoning":4,"multilingual":4,"vision":0},"notes":"Tool-calling tuned on-device model; en/zh focus.","mlxRepo":"openbmb/MiniCPM5-2B-MLX"},
  {"id":"gemma-4-e4b","name":"Gemma 4 E4B","repo":"unsloth/gemma-4-E4B-it-GGUF","file":"gemma-4-E4B-it-Q4_K_M.gguf","mmproj":"mmproj-F16.gguf","sizeGb":4.98,"arch":"gemma4","ctx":131072,"license":"apache-2.0","kind":"chat","routes":["fast","multilingual"],"caps":{"quality":5.5,"speed":8.5,"tools":5.5,"code":5,"reasoning":5,"multilingual":8,"vision":6},"notes":"Fast Danish lane.","mlxRepo":"mlx-community/gemma-4-e4b-it-4bit"},
  {"id":"nemotron-3.5-bolt-e4b","name":"Nemotron 3.5 Bolt E4B","repo":"unsloth/NVIDIA-Nemotron-3.5-Bolt-E4B-GGUF","file":"NVIDIA-Nemotron-3.5-Bolt-E4B-UD-Q4_K_XL.gguf","mmproj":"mmproj-F16.gguf","sizeGb":5.06,"arch":"gemma4","ctx":131072,"license":"openmdw-1.1","kind":"chat","routes":["fast","multilingual","agent"],"caps":{"quality":6,"speed":8.5,"tools":7,"code":5.5,"reasoning":5.5,"multilingual":8,"vision":6},"notes":"Gemma 4 E4B fine-tune by NVIDIA; HF language list includes da."},
  {"id":"gpt-oss-20b","name":"gpt-oss 20B","repo":"ggml-org/gpt-oss-20b-GGUF","file":"gpt-oss-20b-MXFP4.gguf","sizeGb":12.11,"arch":"gpt-oss","ctx":131072,"license":"apache-2.0","kind":"chat","routes":["agent","reasoning","fast"],"caps":{"quality":7,"speed":9,"tools":8,"code":7,"reasoning":8,"multilingual":5.5,"vision":0},"notes":"Native MXFP4; eagle3 draft available (eagle3-gpt-oss-20b-Q8_0.gguf).","mlxRepo":"mlx-community/gpt-oss-20b-MXFP4-Q4"},
  {"id":"qwen3.6-35b-a3b","name":"Qwen3.6 35B-A3B","repo":"unsloth/Qwen3.6-35B-A3B-GGUF","file":"Qwen3.6-35B-A3B-UD-Q4_K_M.gguf","mmproj":"mmproj-F16.gguf","sizeGb":22.13,"arch":"qwen35moe","ctx":262144,"license":"apache-2.0","kind":"chat","routes":["agent","smart","code"],"caps":{"quality":8.3,"speed":8.5,"tools":8.5,"code":8,"reasoning":8,"multilingual":7,"vision":7},"notes":"Default agent; ~80 tok/s measured on this Mac.","mlxRepo":"mlx-community/Qwen3.6-35B-A3B-4bit"},
  {"id":"ornith-1.5-35b-a3b","name":"Ornith 1.5 35B-A3B","repo":"ornith-ai/Ornith-1.5-35B-A3B-GGUF","file":"Ornith-1.5-35B-Q4_K_M.gguf","mmproj":"mmproj-Ornith-1.5-35B-BF16.gguf","sizeGb":21.71,"arch":"qwen35moe","ctx":262144,"license":"mit","kind":"chat","routes":["agent","code"],"caps":{"quality":8.5,"speed":8.5,"tools":9,"code":8.7,"reasoning":8,"multilingual":7,"vision":7},"notes":"Self-improved Qwen3.5-class MoE; card reports Terminal-Bench 2.1 67.8 vs Qwen3.6 52.5. Challenger for agent default.","mlxRepo":"ornith-ai/Ornith-1.5-35B-A3B-MLX"},
  {"id":"occamy-1.0","name":"Occamy 1.0","repo":"Accio-Lab/occamy-1.0-GGUF","file":"occamy-1.0-Q4_K_M.gguf","mmproj":"mmproj-occamy-1.0-F16.gguf","sizeGb":21.17,"arch":"qwen35moe","ctx":262144,"license":"apache-2.0","kind":"chat","routes":["agent"],"caps":{"quality":8.3,"speed":8.5,"tools":9,"code":7.5,"reasoning":7.5,"multilingual":7,"vision":7},"notes":"Qwen3.6-35B-A3B fine-tune for co-work/tool use. No mlx-community build found."},
  {"id":"nemotron-3.5-lightning-30b-a3b","name":"Nemotron 3.5 Lightning 30B-A3B","repo":"unsloth/NVIDIA-Nemotron-3.5-Lightning-30B-A3B-GGUF","file":"NVIDIA-Nemotron-3.5-Lightning-30B-A3B-UD-Q4_K_M.gguf","sizeGb":25.27,"arch":"nemotron_h_moe","ctx":1048576,"license":"openmdw-1.1","kind":"chat","routes":["agent","reasoning","code"],"caps":{"quality":8.5,"speed":8.5,"tools":8.5,"code":8.3,"reasoning":8.7,"multilingual":7,"vision":0},"notes":"Hybrid Mamba-MoE, 1M ctx; card: SWE-bench Verified 70.1, GPQA-D 83.4. MTP head in ggml-org repo.","mlxRepo":"mlx-community/NVIDIA-Nemotron-3.5-Lightning-30B-A3B-4bit"},
  {"id":"nemotron-3.5-bolt-74b-a9b-24gb","name":"Nemotron 3.5 Bolt 74B-A9B (24GB)","repo":"nvidia/NVIDIA-Nemotron-3.5-Bolt-74B-A9B-24GB-GGUF","file":"NVIDIA-Nemotron-3.5-Bolt-74B-A9B-24GB.gguf","mmproj":"mmproj-NVIDIA-Nemotron-3.5-Bolt-74B-A9B-24GB.gguf","sizeGb":22.02,"arch":"nemotron_h_moe","ctx":262144,"license":"openmdw-1.1","kind":"chat","routes":["agent","vision","smart"],"caps":{"quality":8.7,"speed":7,"tools":8.5,"code":8,"reasoning":8.5,"multilingual":7,"vision":8.5},"notes":"Native 2-bit QAT VLM; needs llama.cpp >= 0.8.0 (PR #30520). Quality caps unverified.","minLlamaCpp":"0.8.0"},
  {"id":"qwen3.8-27b","name":"Qwen3.8 27B","repo":"unsloth/Qwen3.8-27B-GGUF","file":"Qwen3.8-27B-UD-Q4_K_M.gguf","mmproj":"mmproj-F16.gguf","sizeGb":16.46,"arch":"qwen35","ctx":262144,"license":"apache-2.0","kind":"chat","routes":["smart","reasoning","agent"],"caps":{"quality":9,"speed":5,"tools":9,"code":8.5,"reasoning":9,"multilingual":7.5,"vision":7.5},"notes":"Top quality that fits; dense. Use mtp-/dflash- heads from ggml-org/Qwen3.8-27B-GGUF for speculative decoding.","mlxRepo":"mlx-community/Qwen3.8-27B-4bit"},
  {"id":"gemma-4-26b-a4b","name":"Gemma 4 26B-A4B","repo":"unsloth/gemma-4-26B-A4B-it-GGUF","file":"gemma-4-26B-A4B-it-UD-Q4_K_M.gguf","mmproj":"mmproj-F16.gguf","sizeGb":16.95,"arch":"gemma4","ctx":262144,"license":"apache-2.0","kind":"chat","routes":["multilingual","vision","smart"],"caps":{"quality":8,"speed":8,"tools":7.5,"code":7,"reasoning":7.8,"multilingual":9,"vision":8},"notes":"Danish/customer-facing lane; 140+ languages per card; Tau2 avg 68.2.","mlxRepo":"mlx-community/gemma-4-26b-a4b-it-4bit"},
  {"id":"gemma-4-12b","name":"Gemma 4 12B","repo":"unsloth/gemma-4-12b-it-GGUF","file":"gemma-4-12b-it-Q4_K_M.gguf","mmproj":"mmproj-F16.gguf","sizeGb":7.12,"arch":"gemma4","ctx":262144,"license":"apache-2.0","kind":"chat","routes":["multilingual","vision"],"caps":{"quality":7,"speed":7,"tools":6.5,"code":6,"reasoning":6.5,"multilingual":8.5,"vision":7.5},"notes":"Unified any-to-any variant (HF arch gemma4_unified, GGUF arch gemma4).","mlxRepo":"mlx-community/gemma-4-12B-it-4bit"},
  {"id":"glm-4.7-flash","name":"GLM-4.7 Flash","repo":"unsloth/GLM-4.7-Flash-GGUF","file":"GLM-4.7-Flash-Q4_K_M.gguf","sizeGb":18.31,"arch":"deepseek2","ctx":202752,"license":"mit","kind":"chat","routes":["agent","code","reasoning"],"caps":{"quality":8,"speed":8.5,"tools":8.5,"code":7.8,"reasoning":8,"multilingual":6,"vision":0},"notes":"30B-A3B MLA MoE; card: tau2 79.5, SWE-bench Verified 59.2.","mlxRepo":"mlx-community/GLM-4.7-Flash-4bit"},
  {"id":"granite-4.1-8b","name":"Granite 4.1 8B","repo":"ibm-granite/granite-4.1-8b-GGUF","file":"granite-4.1-8b-Q4_K_M.gguf","sizeGb":5.35,"arch":"granite","ctx":131072,"license":"apache-2.0","kind":"chat","routes":["fast","agent"],"caps":{"quality":6.5,"speed":8,"tools":7,"code":6,"reasoning":6,"multilingual":6.5,"vision":0},"notes":"Enterprise/RAG tone; first-party GGUF.","mlxRepo":"mlx-community/granite-4.1-8b-4bit"},
  {"id":"devstral-small-2-24b","name":"Devstral Small 2 24B","repo":"unsloth/Devstral-Small-2-24B-Instruct-2512-GGUF","file":"Devstral-Small-2-24B-Instruct-2512-Q4_K_M.gguf","mmproj":"mmproj-F16.gguf","sizeGb":14.33,"arch":"mistral3","ctx":393216,"license":"apache-2.0","kind":"chat","routes":["code"],"caps":{"quality":7.5,"speed":5.5,"tools":8,"code":8,"reasoning":7,"multilingual":6.5,"vision":6},"notes":"Code lane that works on b11146 today.","mlxRepo":"mlx-community/Devstral-Small-2-24B-Instruct-2512-4bit"},
  {"id":"flint","name":"Flint","repo":"bartowski/RecursiveSI_flint-GGUF","file":"RecursiveSI_flint-Q4_K_M.gguf","sizeGb":25.35,"arch":"flint","ctx":262144,"license":"apache-2.0","kind":"chat","routes":["code","agent"],"caps":{"quality":8.7,"speed":8.5,"tools":9,"code":9.3,"reasoning":8,"multilingual":5.5,"vision":0},"notes":"~40B MoE (active ~2.5B, unverified); card: SWE-bench Verified 74.2%, Terminal-Bench 2.1 54.9%. Needs llama.cpp >= 0.8.0 (PR #30928).","mlxRepo":"mlx-community/flint-OptiQ-4bit","minLlamaCpp":"0.8.0"},
  {"id":"qwen3-embedding-0.6b","name":"Qwen3 Embedding 0.6B","repo":"Qwen/Qwen3-Embedding-0.6B-GGUF","file":"Qwen3-Embedding-0.6B-Q8_0.gguf","sizeGb":0.64,"arch":"qwen3","ctx":32768,"license":"apache-2.0","kind":"embedding","routes":["embed"],"caps":{"quality":7,"speed":9.5,"tools":0,"code":6,"reasoning":0,"multilingual":8,"vision":0},"notes":"Run with --embedding --pooling last.","mlxRepo":"mlx-community/Qwen3-Embedding-0.6B-8bit"},
  {"id":"qwen3-embedding-4b","name":"Qwen3 Embedding 4B","repo":"Qwen/Qwen3-Embedding-4B-GGUF","file":"Qwen3-Embedding-4B-Q4_K_M.gguf","sizeGb":2.50,"arch":"qwen3","ctx":40960,"license":"apache-2.0","kind":"embedding","routes":["embed"],"caps":{"quality":8.3,"speed":8,"tools":0,"code":7,"reasoning":0,"multilingual":8.5,"vision":0},"notes":"Higher-quality embed tier.","mlxRepo":"mlx-community/Qwen3-Embedding-4B-4bit-DWQ"},
  {"id":"embeddinggemma-2","name":"EmbeddingGemma 2","repo":"ggml-org/embeddinggemma-2-GGUF","file":"embeddinggemma-2-Q8_0.gguf","mmproj":"mmproj-embeddinggemma-2-Q8_0.gguf","sizeGb":0.31,"arch":"gemma-embedding2","ctx":262144,"license":"apache-2.0","kind":"embedding","routes":["embed"],"caps":{"quality":7.5,"speed":10,"tools":0,"code":6,"reasoning":0,"multilingual":8.5,"vision":6},"notes":"Multimodal 768-d embeddings (text/image/audio/video with mmproj). Needs llama.cpp >= 0.8.0 (PR #30054).","mlxRepo":"mlx-community/embeddinggemma-2-8bit","minLlamaCpp":"0.8.0"},
  {"id":"qwen3-reranker-0.6b","name":"Qwen3 Reranker 0.6B","repo":"ggml-org/Qwen3-Reranker-0.6B-Q8_0-GGUF","file":"qwen3-reranker-0.6b-q8_0.gguf","sizeGb":0.64,"arch":"qwen3","ctx":40960,"license":"apache-2.0","kind":"rerank","routes":["rerank"],"caps":{"quality":7,"speed":9.5,"tools":0,"code":5,"reasoning":0,"multilingual":8,"vision":0},"notes":"Run with --rerank; serves /v1/rerank.","mlxRepo":"mlx-community/Qwen3-Reranker-0.6B-mxfp8"},
  {"id":"clef-flash","name":"Clef Flash 9B","repo":"ggml-org/Clef-Flash-GGUF","file":"Clef-Flash-Q4_K_M.gguf","mmproj":"mmproj-Clef-Flash-Q8_0.gguf","sizeGb":6.73,"arch":"clef","ctx":262144,"license":"apache-2.0","kind":"systemone","routes":["systemone","router","guard"],"caps":{"quality":8.5,"speed":8.5,"tools":9,"code":7,"reasoning":7,"multilingual":7,"vision":7},"notes":"Jev/SystemOne-native (joint schema head). llama-server >= 0.8.0 serves /v1/systemone only. Raise --ubatch-size to fit whole prompt. Median 38.8 ms on Cloudflare infra.","mlxRepo":"mlx-community/clef-flash-4bit","minLlamaCpp":"0.8.0"},
  {"id":"clef","name":"Clef 27B","repo":"ggml-org/Clef-GGUF","file":"Clef-Q4_K_M.gguf","mmproj":"mmproj-Clef-Q8_0.gguf","sizeGb":19.54,"arch":"clef","ctx":262144,"license":"apache-2.0","kind":"systemone","routes":["systemone"],"caps":{"quality":9.3,"speed":6,"tools":9,"code":8,"reasoning":8,"multilingual":7.5,"vision":8},"notes":"Quality systemone tier; median 209 ms on Cloudflare infra. Load on demand.","mlxRepo":"mlx-community/clef-4bit","minLlamaCpp":"0.8.0"},
  {"id":"laya","name":"Laya","repo":"ggml-org/Laya-GGUF","file":"Laya-Q8_0.gguf","sizeGb":0.45,"arch":"modern-bert","ctx":8192,"license":"apache-2.0","kind":"systemone","routes":["systemone","router"],"caps":{"quality":4,"speed":10,"tools":3,"code":3,"reasoning":3,"multilingual":3,"vision":0},"notes":"Current mux backend (ONNX). Also servable by llama-server >= 0.8.0. Median 5.8 ms. Multilingual variant: convaiinnovations/laya-multilingual (onnx-community/laya-multilingual-ONNX).","minLlamaCpp":"0.8.0"},
  {"id":"vllm-d3-nano","name":"Decision 3.0 d3-nano","repo":"ggml-org/vllm-d3-nano-GGUF","file":"vllm-d3-nano-Q8_0.gguf","mmproj":"mmproj-vllm-d3-nano-Q8_0.gguf","sizeGb":2.55,"arch":"qwen35","ctx":262144,"license":"apache-2.0","kind":"systemone","routes":["systemone","router"],"caps":{"quality":6.5,"speed":9,"tools":7,"code":5,"reasoning":5,"multilingual":6,"vision":6},"notes":"Mid systemone tier (Qwen3.5-2B base); decision type vllm-d3 in llama.cpp >= 0.8.0.","minLlamaCpp":"0.8.0"},
  {"id":"vllm-d3-flash","name":"Decision 3.0 d3-flash","repo":"ggml-org/vllm-d3-flash-GGUF","file":"vllm-d3-flash-Q4_K_M.gguf","mmproj":"mmproj-vllm-d3-flash-Q8_0.gguf","sizeGb":6.60,"arch":"qwen35","ctx":262144,"license":"apache-2.0","kind":"systemone","routes":["systemone"],"caps":{"quality":8,"speed":8,"tools":8,"code":6,"reasoning":6.5,"multilingual":6.5,"vision":7},"notes":"Apache alternative to Clef-Flash (Qwen3.5-9B base); images and video.","minLlamaCpp":"0.8.0"},
  {"id":"d1-3b","name":"LiquidAI d1-3B","repo":"LiquidAI/d1-3B-GGUF","file":"d1-3B-Q4_K_M.gguf","mmproj":"mmproj-d1-3B-Q8_0.gguf","sizeGb":1.67,"arch":"lfm2","ctx":32768,"license":"lfm1.0","kind":"systemone","routes":["systemone","router"],"caps":{"quality":6.5,"speed":9.5,"tools":6,"code":4,"reasoning":4.5,"multilingual":6.5,"vision":6},"notes":"30 ms/decision on Apple M5 Pro per card. Decision type lfm2-d1 (llama.cpp >= 0.8.0). LFM licence has commercial limits.","mlxRepo":"LiquidAI/d1-3B-MLX-4bit","minLlamaCpp":"0.8.0"},
  {"id":"granite-switch-4.1-8b","name":"Granite Switch 4.1 8B","repo":"ibm-granite/granite-switch-4.1-8b-GGUF","file":"granite-switch-4.1-8b-Q4_K_M.gguf","sizeGb":6.41,"arch":"graniteswitch","ctx":131072,"license":"apache-2.0","kind":"systemone","routes":["systemone","fast"],"caps":{"quality":6.5,"speed":8,"tools":7,"code":6,"reasoning":6,"multilingual":6.5,"vision":0},"notes":"One process serves chat and /v1/systemone (output_modalities text+decisions). Decision support from llama.cpp 0.8.0; quality caps unverified.","minLlamaCpp":"0.8.0"},
  {"id":"arch-router-1.5b","name":"Arch-Router 1.5B","repo":"katanemo/Arch-Router-1.5B.gguf","file":"Arch-Router-1.5B-Q4_K_M.gguf","sizeGb":0.99,"arch":"qwen2","ctx":32768,"license":"katanemo-research","kind":"router","routes":["router"],"caps":{"quality":6,"speed":9.5,"tools":0,"code":0,"reasoning":3,"multilingual":4,"vision":0},"notes":"Generative preference router: routes [{name,description}] + conversation -> {\"route\":name}. Research licence; check before commercial use.","mlxRepo":"mlx-community/Arch-Router-1.5B-mlx-8Bit"},
  {"id":"qwen3guard-gen-0.6b","name":"Qwen3Guard Gen 0.6B","repo":"mradermacher/Qwen3Guard-Gen-0.6B-GGUF","file":"Qwen3Guard-Gen-0.6B.Q8_0.gguf","sizeGb":0.80,"arch":"qwen3","ctx":32768,"license":"apache-2.0","kind":"guard","routes":["guard"],"caps":{"quality":6.5,"speed":9.5,"tools":0,"code":0,"reasoning":0,"multilingual":7.5,"vision":0},"notes":"Prompt/response safety label + category. Community GGUF (no first-party GGUF)."},
  {"id":"granite-guardian-4.1-8b","name":"Granite Guardian 4.1 8B","repo":"ibm-granite/granite-guardian-4.1-8b-GGUF","file":"granite-guardian-4.1-8b-Q4_K_M.gguf","sizeGb":5.12,"arch":"granite","ctx":131072,"license":"apache-2.0","kind":"guard","routes":["guard"],"caps":{"quality":8,"speed":7.5,"tools":0,"code":0,"reasoning":0,"multilingual":5,"vision":0},"notes":"Harm, jailbreak, RAG groundedness and function-call risk checks; first-party GGUF."},
  {"id":"privasis-cleaner-0.6b","name":"Privasis Cleaner 0.6B","repo":"mradermacher/Privasis-Cleaner-0.6B-GGUF","file":"Privasis-Cleaner-0.6B.Q8_0.gguf","sizeGb":0.64,"arch":"qwen3","ctx":40960,"license":"nvidia-other","kind":"guard","routes":["guard"],"caps":{"quality":6,"speed":9.5,"tools":0,"code":0,"reasoning":0,"multilingual":3,"vision":0},"notes":"Instruction-driven PII sanitisation (rewrites text). For span masking use openai/privacy-filter ONNX (onnx/model_q4.onnx, ~0.92 GB) in-process; it has no llama.cpp support."}
]
```
