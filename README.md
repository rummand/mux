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
   ├─ /v1/audio/transcriptions  /v1/audio/speech   OpenAI audio: Whisper in, Piper (Danish) out
   ├─ /v1/images/generations  /v1/images/edits     OpenAI images: FLUX.2 klein 4B through mflux (LBS Studio)
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

Optional headers: `x-mux-affinity` (keeps one run's calls on one model; without it, a run's `x-mux-trace-id`, else the conversation's opening, keeps them together), `x-mux-trace-id` (groups an agent run into a trace), `x-mux-agent` (which agent), `x-mux-tags`
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

## The assistant and its brain

The dashboard opens on the **assistant**: a chat that runs mux with mux. It reads the admin API, the logs and the
system on its own, sends test requests, and proposes changes that run only when you approve them. On every other page
it is a panel (⌘J) in the same conversation; conversations are kept on the server, so every device sees them.

The **brain** (after Garry Tan's GBrain) is its memory across conversations: pages of how this mux is set up and why,
decisions, preferences and runbooks (`server/src/brain.ts`, the Brain page, `/api/admin/brain`). Before each answer the
assistant recalls the pages that match the question; it writes new ones (`brain_write`) as it learns, and the doctor
(self-healing) recalls them for an incident and writes a runbook once it knows a cause. Pages are embedded through
mux's own `embed` route, metered as the Assistant tenant; without it, search goes by words.

**Lens** investigates the traffic: rules count what fails, what is slow and what costs (error clusters, retry storms,
truncated and empty answers, full contexts, fallbacks, cold starts, runaway traces, repeats, slow first tokens, spend
hot spots, budgets on pace to run out), and a local model reads samples against the investigation's criteria and the
brain — a tenant on a provider the brain says it must not use is a finding. Each run is compared with the window
before it and with the last run of its scope (new, ongoing, resolved). Watches repeat an investigation on a schedule
(one, every 6 hours, ships enabled) and log a warning for a new serious finding; findings go to the assistant, into the
brain, or are muted.

**GBrain as the brain.** With [GBrain](https://github.com/garrytan/gbrain) installed (`bun install -g
github:garrytan/gbrain#latest-stable`, `gbrain init --pglite --embedding-model litellm:embed --embedding-dimensions 1024`
with `LITELLM_BASE_URL` pointing at mux's `/v1` and a mux key as `LITELLM_API_KEY`) and a token for mux in
`~/.mux/mux.env` (`MUX_GBRAIN_TOKEN`, from `gbrain auth create mux --scopes read,write`), mux runs `gbrain serve --http`
on loopback port 3131 and keeps its brain there (`server/src/gbrain.ts`): pages as `mux/<kind>/<slug>`, facts through
GBrain's `remember` (the assistant's `brain_remember`), recall through its `recall` verb. GBrain embeds through mux's
`embed` route as the GBrain tenant, so nothing leaves the Mac. Without the token, the brain is mux's own SQLite one.

GBrain runs entirely on mux: embeddings (`litellm:embed`, bge-m3), reranking (`llama-server-reranker:qwen3-reranker-0.6b`
through mux's `/v1/rerank`), and its chat work through the `ollama` provider pointed at mux (`provider_base_urls.ollama`):
utility and fact extraction on `agent`, reasoning and deep on `smart`, query expansion on `fast`. Search mode
`balanced`. The GBrain tenant's key lives in `~/.gbrain/mux.env` (`LITELLM_API_KEY`, `LLAMA_SERVER_RERANKER_API_KEY`,
`OLLAMA_BASE_URL`, `OLLAMA_API_KEY`), which mux hands every GBrain process it starts. Do not configure GBrain's `openai`
provider with a mux key: its chat calls ignore `provider_base_urls.openai` and go to api.openai.com. mux runs
`gbrain sweep --once` every 30 minutes (links, timelines, facts), which `gbrain serve --http` does not do itself.

The dashboard is installable as an app (Chrome/Edge "Install mux", Safari "Add to Dock", iOS "Add to Home Screen"),
which opens straight on the assistant.

## The fleet: Macs and PCs that also have people at them

A node can be a machine someone works at: a MacBook, an iMac, a Windows PC. Each node has a **presence**
(`server/src/presence.ts`), recomputed every 5 s and read by the gateway every 5 s:

- **free** — nobody there for 10 minutes, or its owner made it *available* (a server): loads anything that fits.
- **polite** — someone is there, it runs on battery, or "I'm using this Mac" is on: only models already loaded, one
  request at a time.
- **busy** — a fullscreen app, a game or a call (on a machine that works only when nobody is there): nothing new; idle
  models are unloaded after a minute.
- **away** — turned off by its owner, or a battery under 20%: out of every route.

The owner says when a machine takes work: **available** (the default — the Mac Studio is unchanged), **only when
nobody is there**, or **off**. A Mac reads its own idle time, battery, heat and memory pressure, and the menu bar app
adds a fullscreen app and the microphone in use (a call); a Windows PC gets them from a helper in the user's session,
which reports with a token that can do nothing else. The router skips busy and
away nodes, lets polite ones serve only what they have loaded, and prefers a server to a desktop to a laptop. The node
enforces its state too, so a gateway that has not caught up cannot overrule it.

**Data borders** (`server/src/router/border.ts`): a tenant may run **anywhere**, on **our machines** only (this one,
our nodes and model servers on our own network — never a cloud API, not even as a fallback), or on **our servers**
only (not a desktop or laptop someone works at). The router enforces it for every kind of request, also for a model
named outright (403 `data_border`); Lens reports traffic that ran outside a border. A request still passes through the
gateway that routes it.

**Burst**: a model whose slots are all taken counts its queue against it (nodes report their queues every 5 s), so
past a couple of waiting requests another node — or a paid API, where the tenant's border allows — answers first.

Joining: from the menu bar on a Mac (Machines → Cluster → Join the cluster), with `deploy/join-node.sh`, or on Windows
with `deploy/windows/install.ps1` (untested so far: see `deploy/windows/README.md`).

## In the menu bar

`mac/` is Mux.app, a native menu bar app for any Mac: an M in the top bar whose dot says how mux is (red: a problem
or unreachable, orange: something wants a look or a change waits for approval, blue: working, purple: the agent is
thinking). Its panel opens on the **agent** — the same assistant as the dashboard's, conversations shared — with the
machines (memory, pressure, loaded models with Unload; on a gateway, every node) and what needs attention (incidents,
new Lens findings, nodes down, each with Ask). It notifies about new incidents, Lens findings and nodes going down.

It finds this Mac's mux (`~/.mux/mux.env`) and the gateway (`~/.mux/railway.env`) on its own; any other mux — another
Mac in the house, over Tailscale or the internet — is added by URL and admin token (kept in the keychain).

```sh
./mac/build.sh --install     # builds mac/build/Mux.app, copies it to ~/Applications and opens it
```

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

Speech: `./deploy/audio.sh` installs whisper.cpp (large-v3-turbo, `whisper` on route `transcribe`, :8310) and Piper
with the Danish voice da_DK-talesyntese-medium (`piper-da` on route `speak`, :8311, `server/tts/piper_server.py`) as
launchd agents com.mux.whisper and com.mux.tts, and registers them; the gateway gets them as `mac-studio/…` on its
next sync. Callers use OpenAI's audio API on mux; audio is never logged.

Images: `./deploy/images.sh` first unloads every loaded model that is neither pinned nor first on `agent` (`--keep`
skips that; nothing is deleted), then installs mflux in `~/.mux/images-venv`, fetches FLUX.2 [klein] 4B (Apache-2.0,
~16 GB, into `~/.mux/models/hf`) and runs `server/images/image_server.py` as launchd agent com.mux.images (:8312). It
becomes `flux2-klein-4b` on the routes `image` and `image-edit`, the names LBS Studio's ComfyUI nodes ask for. The
model loads on the first request (~9 GB at 8-bit) and is let go after 10 idle minutes. An edit takes one or more
images (`image` or `image[]`); without a `size` it keeps the first image's shape at about a megapixel. Images and their
prompts are never logged. The script ends with a test image in `~/.mux/logs/images-test.png`.

All of it at once — this Mac, the Railway gateway and LBS Studio — is `./deploy/setup-images.sh` (it hands itself to
launchd, so Ask mux can start it although it restarts mux; follow `~/.mux/logs/setup-images.log`).

Danish speech: `./deploy/speech-da.sh` registers Record's Danish engines on this Mac (Record's `speech-da` service,
:8798) as `roest-v3` (CoRal's Røst v3, a Danish Whisper large-v3), `hviske-v5` and `whisper-turbo`, and the route
`transcribe-da` (Røst first, whisper.cpp last). The model is read from `?model=` or, as OpenAI's clients send it, from
the form's `model` field.

Logs: `~/.mux/logs/mux.log`, one per model in `~/.mux/logs/models/`. Data: `~/.mux/mux.db` (SQLite).
Models: `~/.mux/models/` (downloads; `imported/` holds links to files elsewhere).

Development: `npm run dev -w server` (tsx watch) and `npm run dev -w web` (Vite, proxied to the server).
