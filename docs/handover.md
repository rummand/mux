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
