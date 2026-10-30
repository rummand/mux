# mux

The model router and control plane for the LLMs our SaaS agents and assistants run on. A SaaS gets a mux API key and
points its OpenAI or Anthropic SDK at mux; mux picks the model — on one of our machines or a paid cloud API — and
records every call.

## Topology

```
SaaS ──► mux gateway (Railway, MUX_ROLE=gateway)       keys · tenants · routing · metering · USD spend · dashboard
             │
             ├─► node: Mac Studio (mux, MUX_ROLE=all) ── llama-server per model (Qwen3.6, bge-m3, Laya, …)
             │      reached over Tailscale Funnel https://lv426.tail134047.ts.net/mux
             ├─► node: any other machine running mux
             └─► cloud: OpenAI · Anthropic · OpenRouter · Groq · Together · Gemini · Mistral · DeepSeek · custom
```

- **Providers** (Providers page): a *node* is a machine running mux; the gateway becomes a tenant on it, syncs its
  models every 15 s as `<node>/<model>` (with what is loaded and its memory), and manages it through its admin API
  (pick the machine at the top of Models, Advisor, Benchmarks or System). A *cloud API* is an OpenAI-compatible base
  URL with a key; its models are added with a price per million tokens.
- **Routes mix them**: e.g. `agent` = `mac-studio/qwen3.6-35b-a3b`, then `openai/gpt-…`. A node that goes offline
  leaves every route until it is back; `auto` prefers loaded local models and uses paid ones when nothing local fits.
- **Spend**: every call records `cost_usd`; tenants can have a monthly USD budget beside their token budget.
- A bare model name (`qwen3.6-35b-a3b`) finds the node model of that name, so callers need not know the node.
- The Mac also answers directly (Nexus keeps its own path via Caddy and the compat ports).

```
SaaS (OpenAI / Anthropic SDK, curl)          Nexus (Railway → Funnel → Caddy :8091)
        │  Bearer mux-sk-…                            │  its old key, its old ports
        ▼                                             ▼
   mux :7070  ──────────────  compat 127.0.0.1:8090 / 8094 / 8099
   ├─ /v1/chat/completions   OpenAI, streaming, tools, images
   ├─ /v1/messages           Anthropic Messages, streaming, tool_use
   ├─ /v1/embeddings  /v1/rerank
   ├─ /v1/systemone          Jev's System One (Laya / Clef / d3 / d1, or hosted Jev)
   ├─ keys · tenants · RPM/TPM · monthly budgets · max parallel
   ├─ router: routes (auto · fast · agent · smart · code · multilingual · vision · embed · rerank · systemone),
   │          fallbacks, cooldowns, context/vision pre-checks, forced-tool guard
   ├─ runtime: one llama-server per model on 127.0.0.1:82xx, loaded on demand, idle-unloaded,
   │           memory budget + macOS pressure guard, pinned models kept warm
   ├─ Hugging Face downloads (resumable), local GGUF import, advisor, benchmarks
   └─ dashboard /  ·  admin API /api/admin  ·  Lens investigations
```

## Using it from a SaaS

```python
from openai import OpenAI
client = OpenAI(base_url="http://<mac-studio>:7070/v1", api_key="mux-sk-…")
client.chat.completions.create(model="auto", messages=[{"role": "user", "content": "Hej!"}])
```

```python
import anthropic
client = anthropic.Anthropic(base_url="http://<mac-studio>:7070", api_key="mux-sk-…")
client.messages.create(model="claude-sonnet-4-5", max_tokens=512, messages=[{"role": "user", "content": "Hej!"}])
```

`model` is a route (`auto`, `fast`, `agent`, `smart`, `code`, `multilingual`, `vision`), a model id, or anything
else (`gpt-4o`, `claude-sonnet-4-5`) — unknown names go to the tenant's default route, and a tenant can alias names.

Optional headers: `x-mux-trace-id` (groups an agent run into a trace), `x-mux-agent` (which agent), `x-mux-tags`
(comma list), `x-mux-user` (end user), `x-mux-no-fallback: 1`. Every answer carries `x-mux-request-id`,
`x-mux-model`, `x-mux-route`, `x-mux-fallbacks`, `x-mux-cold-start`.

## Routing

- **auto** reads the request (tools, a forced tool, code, reasoning cues, Danish, images, length, JSON) and scores
  every candidate by its capabilities, preferring models already loaded; the reason is recorded on each request.
- **priority** tries candidates in order; **fastest** orders by measured tokens/s; **quality** by quality.
- A model that fails 3 times in a minute cools down for 30 s. A failure before any byte is streamed (unreachable, 5xx,
  out of context) falls through to the next candidate; a model named directly falls back to the tenant's default route.
- **Forced tools** (`tool_choice` naming a function, or `required`) are answered through llama.cpp's JSON-schema
  grammar, ported from Nexus's tool guard: the model cannot answer anything but the tool call.

## Runtime and engines

llama.cpp's `llama-server` (Homebrew, 0.8.0) is the engine: one process per model, Metal, GGUF, OpenAI + embeddings +
rerank + native `/v1/systemone` for decision models. Laya also runs on ONNX (`server/laya/worker.mjs`).
Backends: `llamacpp`, `mlx` (mlx-lm server, when `~/.mux/mlx-venv` exists), `laya`, `external` (any
OpenAI-compatible URL — Ollama, LM Studio, omlx, vLLM, a cloud provider, LiteLLM), `jev` (hosted System One).

Memory: each model has an estimate (weights + KV for its context + half its prompt cache). A load must fit the
memory budget (default 48 GB) and leave the headroom macOS reports as available; idle unpinned models are unloaded LRU
to make room, after their keep-alive, and when macOS reports memory pressure. Why these choices, and what else was
considered (MLX/omlx, Ollama, llama-swap, LiteLLM, Rust gateways): `docs/research-local-llm.md` and `docs/decisions.md`.

## Running it

Gateway on Railway (project `mux`, service `mux`, volume at `/data`): `railway up --service mux` builds the
`Dockerfile` (role gateway). Its admin token and URL are in `~/.mux/railway.env` on the Mac Studio.
Join a node to it: publish the node (`tailscale funnel --bg --https=443 --set-path=/mux http://127.0.0.1:7070`),
then `./deploy/join-node.sh`.

On a machine that runs models:

```
./deploy/install.sh          # build, ~/.mux/mux.env (admin token), launchd agent com.mux.server on :7070
node deploy/migrate-nexus.mjs  # once: Nexus's Qwen3.6 + bge-m3 (linked), tenants nexus + lan with their old keys
./deploy/cutover.sh          # stop Nexus's model servers; mux answers their ports (8090, 8094, 8099)
./deploy/rollback.sh         # give Nexus its servers back
```

Logs: `~/.mux/logs/mux.log`, one per model in `~/.mux/logs/models/`. Data: `~/.mux/mux.db` (SQLite).
Models: `~/.mux/models/` (downloads; `imported/` holds links to files elsewhere).

Development: `npm run dev -w server` (tsx watch) and `npm run dev -w web` (Vite, proxied to the server).
