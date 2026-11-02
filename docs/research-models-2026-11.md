# Model research, 2026-11-02

What the world uses and rates, for mux's catalog. Every repo, file and size was checked against the Hugging Face API; the
data behind the catalog is `server/src/catalog-research-2026-11.ts`. The advisor reads Hugging Face itself once a day
(`server/src/signals.ts`) and weighs it least: what mux measures (its traffic, its benchmarks) counts most.

## How much to trust it

- Most benchmark numbers are the makers' own (model cards). Independent scores are scarce: Artificial Analysis moved to
  index v5.0 and most small models have no v5 score yet.
- Danish: EuroEval could not be read; the Danish signals come from the DFM-Mimir card and one secondary source.
- Unverified in llama.cpp: DFM-Mimir's architecture, Nemotron 3.5 Rerank with `--rerank`, Harrier's pooling. These are
  marked experimental in the catalog.

## Changes to the catalog

- Added: Ornith 1.5 9B (5.78 GB), Nanbeige4.3 33B (20.79 GB), Granite 4.2 8B (5.35 GB), LFM2.5 24B-A2B (14.53 GB), MiniCPM-V 4.7 35B-A3B (21.17 GB), MiniCPM-OCR 1.0 (0.81 GB), LFM3-VL 2B (1.85 GB), Ternary Bonsai 2 27B (7.63 GB), Groot 19B-A3B (261023) (12.48 GB), Sage-A1.5 (21.71 GB), Qwen3 Embedding 8B (4.68 GB), Harrier OSS v1 0.6B (0.64 GB), Granite Embedding 311M Multilingual R2 (0.35 GB), Qwen3 Reranker 4B (2.5 GB), Nemotron 3.5 Rerank 8B (4.9 GB), DFM Mimir v1.5 (1.91 GB).
- Superseded (kept, −0.3 unless measured here): qwen3.5-9b → ornith-1.5-9b (for agent/code; same qwen35 arch and size); qwen3-vl-8b → qwen3.5-9b / minicpm-v-4.7-35b-a3b (partially); qwen3.6-27b → qwen3.8-27b; glm-4.7-flash → qwen3.6-35b-a3b / ornith-1.5-35b-a3b (code); qwen3-coder-30b-a3b → ornith-1.5-35b-a3b / qwen3.6-35b-a3b; qwen3-coder-next → qwen3.8-27b / ornith-1.5-35b-a3b; gpt-oss-120b → qwen3.8-27b; bge-m3 → harrier-oss-v1-0.6b / qwen3-embedding-0.6b (quality); granite-4.1-8b → granite-4.2-8b; devstral-small-2-24b → ornith-1.5-9b / ornith-1.5-35b-a3b.
- Qwen AgentWorld 35B-A3B is a world model that simulates tool results, not an agent: off the agent route, tools capped at 5.
- Better uploads: flint → unsloth/flint-GGUF; Nemotron 3.5 Bolt E4B → NVIDIA's own 4GB build.

## Who uses what

**OpenRouter rankings, monthly view (tokens = prompt+completion, aggregated from the page's embedded data by model version)** (2026-11-01 (page: usage data through Nov 1, 2026), https://openrouter.ai/rankings?view=month): 1. deepseek/deepseek-v4.1-flash-20261017 (open, 552–763B) (48.08 T tokens), 2. z-ai/glm-5.3-flash-20260826 (open, 321B) (15.01 T tokens), 3. deepseek/deepseek-v4.1-flash-20260910 (open) (14.87 T tokens), 4. openai/gpt-6-luna (closed) (9.62 T tokens), 5. tencent/hy4-preview (9.07 T tokens), 6. anthropic/claude-opus-5.5 (closed) (6.73 T tokens), 7. stepfun/step-5-preview (open, 600B) (6.25 T tokens), 8. minimax/minimax-m3.1-flash (open, 220–428B) (6.23 T tokens).

**Hugging Face, GGUF repos sorted by 30-day downloads** (2026-11-02, https://huggingface.co/api/models?filter=gguf&sort=downloads&limit=60): 3. ISTA-DASLab/Qwen3.8-Flash-Next-GSQ-RCO-GGUF (180B, too big) (7.43M downloads/30d), 4. unsloth/Qwen3.8-27B-GGUF (6.08M downloads/30d), 5. ornith-ai/Ornith-1.5-9B-GGUF (5.44M downloads/30d), 6. ornith-ai/Ornith-1.5-35B-A3B-GGUF (4.04M downloads/30d), 8. huihui-ai/Huihui-Qwen3.8-27B-abliterated-GGUF (3.25M downloads/30d), 10. peculiar-ragdoll/Tiel-Coder-35B-A3B-GGUF-MTP (2.97M downloads/30d), 13. unsloth/MiniMax-H3-GGUF (2.61M downloads/30d), 18. ggml-org/Qwen3.8-27B-GGUF (2.35M downloads/30d).

**Hugging Face trending (text-generation and GGUF)** (2026-11-02, https://huggingface.co/api/models?sort=trendingScore&pipeline_tag=text-generation): 1. LiquidAI/LFM3-1.7B (trendingScore 709), 2. Nanbeige/Nanbeige4.3-33B (trendingScore 305), 3. RecursiveSI/flint (trendingScore 220), 4. Diffuspace/Clover-35B-A3B-Preview (custom clover_moe arch; no llama.cpp support verified) (trendingScore 208), 5. XHToken/Spark-X2.6-4B (spark2_5 arch, llama.cpp ≥ b10828; en/zh) (trendingScore 196), 6. nvidia/NVIDIA-Nemotron-3.5-Bolt-E4B-4GB (trendingScore 136), 7. inclusionAI/Ling-3.1-flash-1019 (572B) (trendingScore 91), 8. google/embeddinggemma-2 (feature-extraction #1) (trendingScore 100).

**Ollama library, sorted by popularity (all-time pulls)** (2026-11-02, https://ollama.com/library?sort=popular): 1. llama3.1 (120.8M pulls), 2. nomic-embed-text (95.3M pulls), 3. deepseek-r1 (94.6M pulls), 4. llama3.2 (86.8M pulls), 5. qwen2.5 (44.5M pulls), 6. qwen3 (42.3M pulls), 7. gemma3 (41.6M pulls), 10. gemma4 (28.4M pulls).

**Artificial Analysis Intelligence Index v5.0, open-weights list** (2026-11-02 (fetched), https://artificialanalysis.ai/models/open-source): 1. DeepSeek V4.1 Flash 1017 (Max) (AA index v5.0 32), 2. GLM-5.3 (Max) (AA index v5.0 32), 3. MiMo-V2.6-Pro (AA index v5.0 30), 4. Ling 3.1 Flash 1019 (AA index v5.0 29), 5. MiniMax-M3.1-Flash (AA index v5.0 29), 6. Step 5 Preview (AA index v5.0 29), 7. Mistral Large 4 (High) (AA index v5.0 26), 8. Muse Spark Open (Xhigh) (AA index v5.0 25).

The open models with the most tokens on OpenRouter are all 200B+ (DeepSeek V4.1 Flash, GLM-5.3-Flash, Step 5, MiniMax
M3.1 Flash): none fits mux. Among models that do, the Qwen3.8 27B family dominates Hugging Face GGUF downloads.

## Rejected

- Qwen3.8-Flash-Next (180B): None
- DeepSeek V4.1 Flash / GLM-5.3-Flash / MiniMax-M3.1-Flash / Mistral Large 4: None
- tencent/Hy-MT2-7B: None
- Diffuspace/Clover-35B-A3B-Preview: None
- XHToken/Spark-X2.6-4B: None
- KRAFTON/Raon-1-mini-preview (28.8B, raon1 arch, 19.69 GB Q4_K_M): None
- tencent/Hy-Memory-30B-A3B: None
- microsoft/FrogNano-4B-2609: None
- NVIDIA Nemotron-Labs Dory1.0 4B: None
- granite-4.2-30b (17.72 GB): None

## Sources

- [Hugging Face model API (downloads = last 30 days)](https://huggingface.co/api/models)
- [OpenRouter rankings](https://openrouter.ai/rankings?view=month)
- [Artificial Analysis open-weights models](https://artificialanalysis.ai/models/open-source)
- [Artificial Analysis leaderboard](https://artificialanalysis.ai/leaderboards/models)
- [Artificial Analysis Qwen3.8 27B](https://artificialanalysis.ai/models/qwen3-8-27b)
- [Artificial Analysis Gemma 4 26B vs Qwen3.5 9B](https://artificialanalysis.ai/models/releases/comparisons/gemma-4-26b-a4b-vs-qwen3-5-9b)
- [Artificial Analysis Qwen3.6 35B vs Gemma 4 31B](https://artificialanalysis.ai/models/comparisons/qwen3-6-35b-a3b-vs-gemma-4-31b)
- [Ollama library (popular)](https://ollama.com/library?sort=popular)
- [DFM Mimir v1.5 card (Danish comparison table)](https://huggingface.co/danish-foundation-models/DFM-Mimir-v1.5)
- [Berget.ai Gemma 4 / EuroEval Nordic (secondary)](https://berget.ai/en/blog/gemma-4-general-availability)
- [EuroEval leaderboards (not machine-readable; not verified)](https://euroeval.com/leaderboards/)
- [Nanbeige 4.3 coverage (secondary)](https://www.eesel.ai/blog/nanbeige-4-3)
- [Ornith 1.5 coverage (secondary)](https://datanorth.ai/news/ornith-releases-ornith-1-5)
- [LFM2.5-24B-A2B blog](https://liquid.ai/blog/lfm2-5-24b-a2b)
- [MiniCPM-V 4.7 OCRBench (secondary)](https://www.datalearner.com/en/ai-models/pretrained-models/minicpm-v-4-7-35b-a3b/analysis)
- [North Mini Code data (secondary)](https://opencode.ai/data/cohere/north-mini-code-1-0.md)
- [Qwen3-Coder-Next SWE-bench (secondary)](https://dev.to/thousand_miles_ai/qwen3-coder-next-80b-total-3b-active-706-on-swe-bench-2g5o)
- [Model cards on Hugging Face (vendor benchmarks)](https://huggingface.co)
