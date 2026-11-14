# Handover — 2026-11-06

What mux is now, how it runs, what was built in the last stretch (2026-11-02 → 11-04), and what is waiting.
Read with `README.md` (how mux works) and `docs/decisions.md` (why it is built this way).

## Where mux runs

| | Mac Studio (`mac-studio`) | Railway gateway |
|---|---|---|
| Role | `MUX_ROLE=all`: gateway + the models | `MUX_ROLE=gateway`: routes SaaS traffic, runs no models |
| Address | `localhost:7070`; tailnet / Funnel `https://lv426.tail134047.ts.net/mux` | https://mux-production-0b55.up.railway.app (shown as "Railway mux") |
| Admin token | `MUX_ADMIN_TOKEN` in `~/.mux/mux.env` | `MUX_GATEWAY_ADMIN_TOKEN` in `~/.mux/railway.env` |
| Runs from | launchd `com.mux.server` → `deploy/run.sh` from this working tree | `railway up` (it does **not** deploy from GitHub) |
| Models loaded | qwen3.6-35b-a3b, bge-m3, arch-router (pinned) | reaches them as `mac-studio/…` |

Never put a token in the repo: it is public. Secrets live in `~/.mux/*.env`, `~/.gbrain/mux.env`, and the dashboard.

## How to ship a change

1. Branch, commit, push the branch; `git merge --ff-only` into `main`; push `main` (secret scan the diff first).
2. **The Mac:** `npm run build`, then `launchctl kickstart -k gui/$(id -u)/com.mux.server` (~30 s; Railway and the
   Nexus ports come back on their own).
3. **Railway — from a clean checkout of `main`, not the working tree.** Other sessions often have uncommitted work
   here, and `railway up` uploads whatever is on disk:
   ```sh
   git worktree add --detach /tmp/mux-deploy main && cd /tmp/mux-deploy
   railway up --detach -p a5bf89be-0ec9-4d3d-afcc-40226c2a86f4 -e production -s mux
   cd - && git worktree remove --force /tmp/mux-deploy
   railway deployment list -s mux   # wait for SUCCESS
   ```
4. When another session's files are dirty: stage only your own (`git apply --cached` for a shared file's hunks),
   check the commit builds and tests on its own in a worktree, and move `main` with `git fetch . <branch>:main` if
   `git checkout main` refuses.

Tests: `cd server && npm test` (74 pass). They never touch `~/.mux/mux.db` (`test/setup.ts`).

## Built 2026-11-02 → 11-04

| Commit | What |
|---|---|
| `4c6f288` `b4d3525` `fa49613` `449ad8a` | **System page, live:** every core every 2 s (P/E clusters, heatmap), GPU %, memory as macOS splits it, network, disk, processes with model servers named; Linux readings from /proc and the container's cgroup on Railway; the Machine bar's first button is this mux's name ("Railway mux"). `runtime/live.ts`, `components/SystemLive.tsx` |
| `73ce67d` | **Services page:** web search (SearXNG beside Railway) and the page reader — health every minute, engines and their errors, calls, latency, tenants, per-engine answers and failure reasons, try-it box. Query words are never stored. `services.ts` |
| `e5fc9c7` | **"Ask mux"** instead of "Assistant" everywhere visible; the chat speaks as mux. Internal names (`/assistant`, the Assistant tenant) unchanged |
| `0ccf39d` | **Lens checks its model's claims** (`lens-checks.ts`): a false claim rejects the finding ("Thrown away", with why); nothing checkable = "guess", low at most; high needs claims that hold, ≥ 3 requests and a claim pinned to the error/tool/finish/border |
| `e96987f` | **Agents page:** healer & doctor, experiments autopilot, Lens watches, brain keeper — state, schedule, last run, what each changed, Run now. Autopilot runs now persist (`autopilot_runs`). `agents.ts` |
| `bda780f` | **Affinity:** one agent run stays on one model (`router/affinity.ts`). Key: `x-mux-affinity`, else `x-mux-trace-id`, else the conversation's opening. Experiment arms are fixed per run; the route's first choice is kept 30 min unless the model is unfit or has a queue ≥ 2 |
| `6850b54` | **Arch-Router** (Katanemo 1.5B, Q6_K, pinned on the Mac) picks the route for requests on `auto` routes, once per user turn (`router/intent.ts`). Routes have an `intent` field (defaults built in for agent/code/fast/multilingual/smart: 10/12 right in a sample, against 4/7 with the plain descriptions). Falls back to the old scoring on "other", unknown route or > 2 s. Never answers a chat itself. Setting `intentRouterModel`: `arch-router` (Mac), `mac-studio/arch-router` (Railway). Card on the Routes page |

Outside the repo: LongCat-Video staged in `~/.mux/longcat` (see below).

## 2026-11-12: the page reader reads whole sites (reader v2)

`/v1/read` moved to `server/src/router/reader.ts` and grew, backward compatible, for bloom for business (the owner:
"it can return files to bloom for business so it can use them for provenance"): `links: true` (every link, absolute),
`files: true` (a document's exact bytes, base64, with their SHA-256; 413 above `max_bytes`, 25 MB default, 50 MB cap),
at most 5 redirects each re-checked (loop and cap are clear errors), status, content type, redirects, meta robots and
X-Robots-Tag, canonical, lang, ETag, Last-Modified, and `robots_txt: true` (raw; mux does not decide on robots.txt).
The user agent carries `x-mux-agent`. `service_calls` gained `bytes` and `mime`; the Services page shows bytes read and
what was read. Setting `readerParallel` (8): reads in flight per tenant. Contract in `README.md`; tests in
`server/test/reader.test.ts` (a fixture server on loopback).

Later the same day (bloom for business's design system reads a company's look from its own stylesheets; the owner
approved the reader returning links and files): `links: true` also returns `<link rel=stylesheet>` hrefs with
`rel: "stylesheet"`, and `files: true` returns a stylesheet as a file (`text/css`, exact bytes, SHA-256, its words as
`text`). Without `files: true` a stylesheet is still refused (415), as before. Tests in `server/test/reader.test.ts`.

Then (bloom for business ranks a company's colours by the elements its start page shows): `html: true` returns a web
page's markup as it came, capped at `max_html_chars` (200 000 default, 2 000 000 at most) with `html_truncated`;
metered with the text. `links` and `file` unchanged. Contract in `README.md`; test in `server/test/reader.test.ts`.

## 2026-11-14: the page reader renders pages that build themselves in the browser (`render: true`)

bloom for business read energinet.dk (a Vue site) through Railway's reader and got titles and no words from every page;
its sitemap (8,308 addresses) was refused with 415. The owner approved extending the reader again. Branch
`reader-render`.

- **`render: true`** on `/v1/read` (route `web.render`, model `renderer`, `server/src/router/render.ts`): a headless
  Chromium through `playwright-core` 1.56.1 (an optional dependency; the Chromium in `~/Library/Caches/ms-playwright`,
  or `MUX_CHROMIUM_PATH`). The browser resolves no name (`--host-resolver-rules=MAP * ~NOTFOUND`) and its proxy is a
  closed port: every request the page makes is intercepted, checked for a public address (each redirect hop too, at
  most 5) and fetched by mux; frames, pictures, media, fonts, WebSockets, beacons and non-GET are refused; a fresh
  context per page, Set-Cookie dropped, no Cookie or Authorization sent; no downloads, pop-ups, dialogs or service
  workers; 25 s, 15 MB, 150 requests; the reader's user agent. Words settle when the page's text has not changed for
  1.2 s (at most 10 s after load). A tenant with an `allowed` list must name `web.render`. `renderParallel` (2) per
  tenant and per machine. energinet.dk: plain read 0 words, rendered 348 words and 84 links in 3.5 s.
- **On a gateway** (Railway) the render is sent to the first online `mux` provider (the Mac Studio, over its
  Funnel/tailnet address, with the gateway's own tenant key there) and metered on both sides; no node is 503
  `render_unavailable`, and so is a node that answers without `rendered: true`.
- **`files: true` returns XML and gzip** (a sitemap, `sitemap.xml.gz`), the XML's words as `text`.
- **Services page**: a "Page renderer" row (`web.render`), with its try-it box.
- Tests: `server/test/render.test.ts` (a script shell rendered; a private fetch from the page refused; no POST,
  pictures or cookies; redirects; download refused; byte and time caps; the route permission; a gateway without a
  node; XML and gzip files).

## 2026-11-12: images on the Mac Studio (FLUX.2 klein 4B Q4)

The owner (bloom for business, testing Composer's images with a real model): "Local image model: install an open image
model on the Mac Studio's Mux. Free and local." `dc5aefc`.

- **Model:** `mflux-community/flux2-klein-4b-mflux-q4` @ `794cd159` — FLUX.2 [klein] 4B pre-quantised to 4 bits,
  **Apache-2.0** (the files' card; inherits `black-forest-labs/FLUX.2-klein-4B`, Apache-2.0). 4.3 GiB in
  `~/.mux/models/flux2-klein-4b-mflux-q4`; mflux 0.24.0 in `~/.mux/images-venv` (1.4 GiB). Candidates and licences:
  `docs/research-local-llm.md` (SDXL-Turbo and klein 9B are non-commercial; the 16 GB bf16 default did not fit).
- **Service:** launchd `com.mux.images`, `server/images/image_server.py` on **127.0.0.1:8312** only, installed with
  `./deploy/images.sh --q4 --keep` (no chat model unloaded). Model `flux2-klein-4b-q4` on routes `image` and
  `image-edit`. Loads on the first request (~1 s, ~5 GB), lets go after 10 idle minutes.
- **Fixed on the way:** mflux 0.24's `Flux2KleinEdit` fails without an input image, so text to image now runs
  `Flux2Klein`; edits keep `Flux2KleinEdit`; one in memory at a time.
- **Presence:** `acquire` skipped presence for every `external` model. A local image service (external, kind image,
  loopback) is now admitted like the models mux runs (`isLocalService`, `runtime/manager.ts`): busy/away nothing,
  polite only when its model is loaded and one at a time; a resting refusal counts no cooldown.
  `server/test/images-presence.test.ts`. Whisper, Piper and other loopback audio services are unchanged.
- **Tenant:** `bloom-design-composer-test` `allowed` += `image`, `flux2-klein-4b-q4` (nothing else changed; read back).
- **Verified through mux** (one-day key, revoked): `POST /v1/images/generations {model: "image", size: "768x768",
  seed: 1234, response_format: "b64_json"}` → 200 in 5.9 s and 5.8 s (warm), `x-mux-model: flux2-klein-4b-q4`,
  `model` in the JSON, PNG 768×768 decodes; **the same seed gives a byte-identical PNG**. 512×512: ~4 s warm, ~7 s
  cold. Requests page: tenant and `x-mux-agent` recorded; prompts and images are never logged.
- **Railway** runs no image model; it reaches this one as `mac-studio/flux2-klein-4b-q4` on its next sync if a route
  there names it (none does).
- **Disk:** 25 GB free before, 18 GB right after the download; 13 GB at the end of the session as other projects built
  (mux's share is the 5.7 GiB above). Watch it.

## 2026-11-12: `vision` on the Mac Studio is the local qwen3.6

The owner (bloom for business, whose Library reads pictures and scanned pages through route `vision`): "Yes, use the
local qwen". A route setting, not code: `PUT /api/admin/routes/vision {candidates: ["qwen3.6-35b-a3b"]}` on the Mac
Studio (was `[]`, which took every chat model in list order); journaled as a route change. Presence rules unchanged.

- **Tenants:** no `bloom-for-business` tenant exists on the Mac Studio. Bloom tests here as
  `bloom-design-composer-test` (`allowed`: `qwen3.6-35b-a3b`, `image`, `flux2-klein-4b-q4`), which **may not name
  route `vision`** (403 `permission_denied`) but may name `qwen3.6-35b-a3b`. No tenant was changed; adding `vision`
  there waits for the owner.
- **Thinking:** qwen3.6 runs here with `--reasoning off`; no `reasoning_content` came back, and 800 tokens were plenty.
  Per request, `chat_template_kwargs: {enable_thinking: false}` passes through to llama-server (README, *Pictures*).
- **Verified** with one-day keys, each revoked (200), then 401, files deleted. A synthetic 900×360 PNG with four
  lines of text, `max_tokens` 800: tenant `lan`, `model: "vision"` → 200 in 1.4 s, `x-mux-route: vision`,
  `x-mux-model: qwen3.6-35b-a3b`, 342 prompt + 90 completion tokens, all four lines exact plus a one-sentence
  description. With `enable_thinking: false`: 0.9 s, 61 completion tokens, the same text. Tenant
  `bloom-design-composer-test`: `vision` → 403; `qwen3.6-35b-a3b` by name → 200 in 7.8 s (cold prompt cache), the
  same text, 90 completion tokens.
- **Railway** (read only, nothing changed): `vision` = `mac-studio/qwen3.6-35b-a3b`, `mac-studio/qwen3.5-0.8b`, then
  OVH. Tenant `bloom-for-business` (allowed all, border `own`): `/routes/explain` with a picture gives only
  `mac-studio/qwen3.6-35b-a3b` (0.8b has no vision, OVH is outside the border). Production bloom's `MUX_URL` is this
  Railway gateway. That path was not tried with a real call.

## Live state (2026-11-06)

- Railway intent router: 19 decisions, 17 routed, 2 "other", 0 failed; **p50 436 ms, p95 1.8 s** — the p95 is close
  to the 2 s budget because each decision goes Railway → Mac → Railway. Watch `/routes/intent`; if failures appear,
  raise `BUDGET_MS` in `router/intent.ts` or run the router nearer the gateway.
- Memory budget 48 GB; autoExperiments, freeRescue, selfHeal on.
- Mac disk: 107 GB free (was 2.8 GB on 11-04 — Epic Games deleted, 60 GB). The big users are `~/.record/corpus`
  (261 GB of Danish speech data), `~/.nexus` (108 GB, incl. qwen3.6's weights — keep `~/.nexus/models`),
  `~/.mux/longcat` (79 GB).
- Docker (Colima, 2 GB RAM VM) runs the other projects' databases; `nexus-laya-laya-1`, its image and volume were
  deleted on the owner's word (it was dying of out-of-memory).

## Waiting on the owner

- **Memory budget 48 → ~58–60 GB.** The autopilot is blocked from trying Gemma 4 26B on the multilingual route
  (advisor 8.8 vs qwen3.6's 7.5; the two need ~58 GB together).
- **Free tier as a regular candidate on Railway:** `ovh/gpt-oss-20b` is listed on the `fast` and `agent` routes, so
  those prompts can go to OVH's free tier, though free tiers are meant as rescue only. Offered to take it out.
- **LongCat-Video test:** weights (78 GB), venv and Mac patches in `~/.mux/longcat` (`README.md` there); smoke test
  passes. Run with `~/.mux/longcat/schedule.sh HH:MM` (or `run-test.sh` now) — it takes the chat models offline up
  to ~100 min, then restores them. If usable: a video kind with a background job API. If not: delete the weights.
- **Kimi K3:** does not fit the Mac (≥ 594 GB). Through the cloud needs a Moonshot or OpenRouter key in the dashboard.
- **Smaller:** `@fastify/static` advisories (upgrade on its own branch); Funnel `/mux` dashboard asset paths; Windows
  installer untested on a real PC; SearXNG engines DuckDuckGo (CAPTCHA) and Brave (rate-limited) failing — switch them
  off once the Services page has a few days of data; qwen3.6 context overflows (8 in a day) — a longer-context fallback
  would catch them; the Routes page's "Explain a decision" shows the scoring, not Arch-Router's choice.

## Gotchas learned

- `lsof -ti tcp:PORT` also matches clients — use `-sTCP:LISTEN` before killing anything.
- GBrain: never configure its `openai` provider with a mux key (it ignores the base URL and sends the key to OpenAI).
- MPS (Apple GPU) asserts on mixed-dtype matmuls instead of raising; CUDA-autocast code paths need explicit casts.
- Arch-Router's GGUF answers with single quotes (`{'route': 'code'}`).
- The owner's rules: every change mux makes to itself is journaled and shown ("What mux changed"); Ask mux's changes
  wait for approval; the owner's brain pages are never rewritten; restarting mux or the Mac is allowed for healing.
