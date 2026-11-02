import { randomBytes } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { config } from "./config.js";
import { db, json, now, settings } from "./db.js";
import { listModels, listRoutes } from "./models.js";
import { listProviders } from "./providers.js";
import { status } from "./runtime/manager.js";
import { brainStats, forgetPage, KINDS, recall, rememberFact, search, writePage } from "./brain.js";
import { assistantKey, gateway } from "./self.js";
import { asActor } from "./journal.js";

/**
 * The dashboard's assistant: a chat that runs mux with mux. A model (through mux's own gateway, metered as the
 * Assistant tenant) gets the whole admin API as a tool, the logs, a test request and the dashboard's pages. Reading runs
 * on its own; anything that changes mux waits for the person to approve it in the dashboard.
 *
 * It has a brain (brain.ts): pages it recalls before each answer and writes as it learns, shared with the doctor.
 *
 * Each call sends the transcript and, after a pause, which pending calls were approved; the reply streams as
 * server-sent events and ends with the transcript as it now is, which is also kept as a conversation on the server.
 */
export interface Call { id: string; type: "function"; function: { name: string; arguments: string } }
export interface Msg { role: "user" | "assistant" | "tool"; content: string | null; tool_calls?: Call[]; tool_call_id?: string; reasoning_content?: string; model?: string; recalled?: { id: string; title: string }[] }

const MAX_STEPS = 16;
const RESULT_CHARS = 14_000;

const TOOLS = [
  {
    type: "function",
    function: {
      name: "mux_api",
      description: "Call mux's admin API (the API the dashboard itself uses). GET reads run at once; POST, PUT, PATCH and DELETE change mux and wait for the user's approval. A node's own admin API is reached through /providers/<node id>/proxy/<path>.",
      parameters: {
        type: "object",
        properties: {
          method: { type: "string", enum: ["GET", "POST", "PUT", "PATCH", "DELETE"] },
          path: { type: "string", description: "Path under /api/admin, e.g. /models or /providers/mac-studio/proxy/system" },
          query: { type: "object", description: "Query parameters, e.g. {\"range\":\"1h\"}", additionalProperties: { type: "string" } },
          body: { type: "object", description: "JSON body for POST, PUT and PATCH" },
          why: { type: "string", description: "For a change: one sentence the user reads before approving it" },
        },
        required: ["method", "path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "read_log",
      description: "Read the end of a log: mux's own server log, or a local model server's (llama-server) log. Filter with grep.",
      parameters: {
        type: "object",
        properties: {
          source: { type: "string", enum: ["mux", "model"] },
          model: { type: "string", description: "The model id, for source=model" },
          node: { type: "string", description: "A node's provider id, to read that node's log instead of this machine's" },
          grep: { type: "string", description: "Keep only lines containing this text (case-insensitive)" },
          lines: { type: "number", description: "How many lines from the end (default 120, at most 400)" },
        },
        required: ["source"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "test_request",
      description: "Send a real chat request through mux's gateway, as a SaaS would (metered as the Assistant tenant), and see which model and route answered, how fast, and what it said. Use it to check that routing and a model work.",
      parameters: {
        type: "object",
        properties: {
          model: { type: "string", description: "A route (auto, agent, fast, smart…) or a model id; default auto" },
          prompt: { type: "string" },
          max_tokens: { type: "number" },
        },
        required: ["prompt"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "open_page",
      description: "Open a page of the dashboard for the user, to show them what you are talking about.",
      parameters: {
        type: "object",
        properties: { path: { type: "string", enum: ["/", "/tenants", "/tenants/<id>", "/requests", "/traces", "/lens", "/providers", "/models", "/advisor", "/routes", "/benchmarks", "/playground", "/system", "/overview", "/health", "/brain", "/experiments"], description: "A page; /tenants/<id> with a real tenant id" } },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "brain_search",
      description: "Search mux's brain: the memory you and mux's doctor keep across conversations (how mux is set up and why, decisions, the user's preferences, runbooks for problems solved before). Searches by meaning and by words.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string" },
          kind: { type: "string", enum: [...KINDS] },
          limit: { type: "number", description: "At most this many pages (default 6)" },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "brain_write",
      description: "Write a page in mux's brain, at once, so you (and the doctor) know it next time. Write what will matter later, briefly and concretely: a fact about this mux and why it is so, a decision and its reason, what the user prefers, or a runbook (symptom, cause, fix, how to check). Give the id of a page you recalled to update it instead of writing a near-copy. Never write secrets.",
      parameters: {
        type: "object",
        properties: {
          id: { type: "string", description: "An existing page's id, to update it" },
          title: { type: "string", description: "Short and specific, e.g. \"qwen3.6-35b-a3b crashes with ctx 131072 on the Mac Studio\"" },
          kind: { type: "string", enum: [...KINDS] },
          subject: { type: "string", description: "What it is about: a model, tenant, provider or route id" },
          body: { type: "string", description: "Markdown" },
          tags: { type: "array", items: { type: "string" } },
        },
        required: ["title", "kind", "body"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "brain_remember",
      description: "Remember one fact about something (a tenant, a model, a machine, the user), at once: a short claim the brain recalls whenever that thing comes up. For a fact; a runbook or a decision with its reasons is a page (brain_write).",
      parameters: {
        type: "object",
        properties: {
          fact: { type: "string", description: "One claim, e.g. \"Nexus's customer data must stay on our machines\"" },
          entity: { type: "string", description: "What it is about: a tenant, model or machine id, or a name" },
          kind: { type: "string", enum: ["fact", "preference", "commitment", "event", "belief"] },
        },
        required: ["fact", "entity"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "brain_forget",
      description: "Delete a page from mux's brain that is wrong or no longer true (waits for the user's approval). Prefer updating it with brain_write.",
      parameters: { type: "object", properties: { id: { type: "string" }, why: { type: "string" } }, required: ["id", "why"] },
    },
  },
];

export const API_REFERENCE = `Admin API (paths under /api/admin). Tenants, routes and providers are created and updated with the same PUT to their id (there is no POST /tenants, /routes or /providers):
- GET /overview?range=15m|1h|6h|24h|7d|30d&tenant=&model=&agent= — totals, latency/ttft/tps percentiles, cost, breakdowns by tenant/provider/model/route/endpoint/agent/user/error
- GET /system?range= — memory, swap, pressure, disk, loaded instances, model health and cooldowns, failures, in-flight, memory budget, role and name
- GET /events?limit=&level=info|warn|error — mux's event log (loads, unloads, failures, settings, providers)
- GET /models — every model with its instance, provider, last benchmark, 24h usage
- POST /models {id, backend, kind, path|base_url, upstream_model, ctx, caps…}; PATCH /models/:id {fields} (ctx, parallel, extra_args, reasoning, keep_alive_min, pinned, enabled, caps, cost_in, cost_out, notes…; server flags unload it to take effect); DELETE /models/:id?files=1
- POST /models/:id/load; POST /models/:id/unload; GET /models/:id/log
- GET /logs?source=mux|model&model=&grep=&lines= — the tail of a log
- GET /providers; GET /providers/presets; PUT /providers/:id (create or update) {name, kind: mux|openai|anthropic|openrouter|groq|together|fireworks|cerebras|gemini|mistral|deepseek|custom, base_url, api_key, admin_token, enabled}; DELETE /providers/:id; POST /providers/:id/sync
- GET /providers/:id/remote-models; POST /providers/:id/models {model, kind, cost_in, cost_out, ctx, caps} — add a cloud model (USD per million tokens)
- ANY /providers/:id/proxy/<path> — the same admin API on a mux node (its models, system, downloads, benchmarks, logs)
- Presence (on a node, or a node through /providers/:id/proxy/presence): GET /presence — state free|polite|busy|away, why, class always-on|desktop|laptop, the owner's mode; PUT /presence {mode: available|away-only|off, using: bool, class?}. available: always takes work (a server); away-only: only while nobody is at the machine (someone there → polite: only loaded models, one at a time; fullscreen/call/game → busy); off: out of the cluster. The gateway routes by it. Set a person's machine only when they ask.
- GET /join (on a node: how a gateway could reach it, and the gateways that joined it); POST /join {gatewayUrl, gatewayToken, nodeUrl, name} joins this node to a gateway
- GET /catalog; GET /advisor?useCase=&priority=quality|balanced|speed (each model with its score, reasons, usage here over 30 days, Hugging Face downloads/likes, the routes it is on); GET /advisor/use-cases; GET /advisor/stack
- GET /advisor/insights — what to do about models, each with the admin call that does it: promote (put a measured, better model first on a route), try (download a model that would beat what is here), measure (benchmark one in use but unmeasured), retire (disable one nothing uses); plus trending GGUF models not in the catalog. GET /advisor/trending; POST /advisor/signals re-reads Hugging Face (runs without approval)
- GET /hf/search?q=; GET /hf/files?repo=; GET /downloads; POST /downloads {catalogId} or {repo, file}; DELETE /downloads/:id; GET /local; POST /local/import {path, id?, kind?}
- GET /routes; PUT /routes/:name (create or update) {description, kind, strategy: priority|auto|fastest|quality, candidates: [model ids]}; DELETE /routes/:name. Routes list mux's own models first; free tiers rescue on their own (do not put them ahead of ours), and never one that trains on prompts. An embedding route's first model is never changed (another model's vectors break the tenants' stored ones; mux refuses without force: true).
- POST /routes/explain {tenant?, model?, messages, tools?, kind?} — what the router would do, without sending (runs without approval)
- GET /tenants; GET /tenants/:id; PUT /tenants/:id (create or update) {name, description, color, status: active|paused, rpm_limit, tpm_limit, monthly_token_budget, monthly_usd_budget, max_parallel, default_route, allowed, aliases, log_bodies, data_border: any|own|servers} — data_border: own keeps a tenant on our machines (never a cloud API), servers on our always-on machines only; the router enforces it; DELETE /tenants/:id
- POST /tenants/:id/keys {name, expiresInDays?, rpmLimit?, monthlyTokenBudget?} — returns the key once; DELETE /keys/:id revokes
- GET /requests?tenant=&model=&status=ok|error&agent=&trace=&q=&limit=; GET /requests/:id (with bodies and route reason); GET /traces?range=&tenant=
- GET /benchmarks?model=; POST /benchmarks {model}
- Lens, investigations of the traffic (they only read, so they run without approval): GET /lens?watch= (runs, newest first: findings each new or ongoing, resolved since the last run, baseline metrics against the window before); GET /lens/runs/:id; POST /lens {title, filters: {tenantId?, agent?, model?, hours?, sample?}, criteria?, useModel?, modelId?} — returns {id}, done in seconds to a few minutes
- GET /lens/watches; PUT /lens/watches/:id {title, filters, criteria, every_hours, use_model, model_id, enabled}; DELETE /lens/watches/:id; POST /lens/watches/:id/run; GET /lens/mutes; POST /lens/mutes {key, title, days?}; DELETE /lens/mutes/:key
- Experiments, A/B tests on live traffic with production always served (each arm keeps the other model behind it as a fallback; guardrails roll back a worse challenger at once): GET /experiments (each with live arm stats); POST /experiments {route, challenger, share? 0.01–0.5, minRequests?, maxHours?, autoPromote?}; POST /experiments/:id/stop; GET /experiments/autopilot (what mux decided to try last, and what it could not and why); POST /experiments/autopilot/run. mux runs its own experiments (autoExperiments): suggest a change as an experiment, not a direct route switch.
- GET /settings; PATCH /settings {memoryBudgetGb, memoryHeadroomGb, diskReserveGb, keepAliveMin, maxLoaded, retentionDays, pressureGuard, logBodies, assistantModel}`;

/** One line on the brain, for the prompt: where it is and how much it holds — so the assistant knows it has one. */
export async function brainLine(): Promise<string> {
  try {
    const s = await brainStats();
    const where = s.node ? `on the node ${(s.node as { name: string }).name}, shared with every mux` : s.backend === "gbrain" ? "on this machine" : "in mux's own database";
    const what = s.backend === "gbrain" ? `GBrain${(s.gbrain as { version?: string } | undefined)?.version ? ` ${(s.gbrain as { version: string }).version}` : ""}` : s.backend === "unreachable" ? "the node's brain" : "mux's own brain";
    return s.backend === "unreachable" ? `Your brain is ${where}, but it does not answer right now (${String(s.error ?? "").slice(0, 120)}): say so if memory matters to the answer.` : `Your brain is ${what}, ${where}: ${s.pages}${s.morePages ? "+" : ""} page${s.pages === 1 ? "" : "s"} so far.`;
  } catch (e) { return `Your brain did not answer just now (${(e as Error).message.slice(0, 120)}).`; }
}

/**
 * Answers that denied having a memory (from before mux had a brain), and the copies of a canned correction an earlier
 * version put in their place. A small model copies its own earlier answers over any instruction — those copies became
 * a loop — so the model does not read these answers at all; the stored conversation keeps them.
 */
const DENIES = /no memory|start (?:fresh|over)|don.t have (?:a |any )?(?:brain|memory)|no (?:brain|persistent memory)|ingen hukommelse|husker ikke|^Yes — I have a brain\. (?:Your|My) brain is/i;
export const deniedMemory = (msgs: Msg[]) => msgs.some((m) => m.role === "assistant" && typeof m.content === "string" && DENIES.test(m.content));
const left = (m: Msg) => m.role === "assistant" && !m.tool_calls?.length && typeof m.content === "string" && DENIES.test(m.content);

function systemPrompt() {
  return `You are mux's own assistant — mux thinking about itself — inside mux's dashboard. This mux belongs to its owner, the person talking to you, and always will: you look after it for them. You may learn and optimise whatever you want — read anything, remember anything worth keeping, work out and propose any improvement — but every change to mux waits for the owner's approval in the dashboard. It is their mux.

You have a brain: memory that lasts between conversations (its state is in the mux context on the owner's latest message). You recall from it before every answer (what matched is in that context), search it (brain_search), and write to it as you learn (brain_write for pages, brain_remember for facts about a tenant, model or machine). So you do remember across sessions: never say you have no memory or start fresh; if the brain holds nothing on a subject yet, say that, and remember it now if it matters.

mux is a model router and control plane: SaaS products call it with an API key through an OpenAI-style (/v1/chat/completions, /v1/embeddings, /v1/audio/*) or Anthropic-style (/v1/messages) API, and mux routes each request to a model — local models on mux nodes (llama.cpp llama-server, MLX, Laya for Jev's System One) or paid cloud APIs. A gateway (mux on Railway) runs no models; nodes (the Mac Studio) do. Tenants are the SaaS products, each with keys, limits, budgets, aliases and a default route. Routes are named model lists with a strategy. Every request is metered (tokens, latency, time to first token, speed, cost, fallbacks), and Lens looks for problems in the traffic.

Your job: help the user run and fix mux — find out why something fails, explain what mux is doing, and set up models, routes, tenants, keys, providers and settings. Look before you answer: read the state with your tools instead of guessing, and quote what you saw (numbers, ids, errors). When something is broken, find the cause in the events, the logs, the request detail and the system state, then propose the fix. For a change, call mux_api with a short "why"; the user approves it in the dashboard, so ask nothing first — propose the call itself. Make one change at a time and check its effect. Never ask for or repeat secrets (API keys, admin tokens): the user enters those in the dashboard. Answer in the user's language, briefly, in Markdown.

About the brain: pages and facts that you and mux's doctor keep across conversations. The pages that match the user's message are in the mux context; search it (brain_search) when the question touches something you may have learned before. When you learn something that will matter in a later conversation — why something is set up as it is, a decision and its reason, what the user prefers, the cause and fix of a problem — write it (brain_write) without asking, short and concrete, updating a page you recalled rather than adding a near-copy. Do not write what mux's API already shows (the list of models, the current settings), only what it does not: the why, the history, the lessons. When the brain and what you read now disagree, trust what you read and fix the page. When the brain says where a tenant's data may go ("stays local", "never to the cloud"), check that tenant's data_border matches, and propose setting it if not.

${API_REFERENCE}

This mux: role ${config.role}, name "${config.name}". Each message from the owner ends with a "mux context" block that mux attaches — the time, mux's state now, what your brain recalled. It is not the owner's words; use it, and do not repeat it back.`;
}

/** What changes from question to question, attached to the owner's latest message (not the instructions). */
function contextBlock(snapshot: string, page: string | undefined, memory: string, brain: string, corrected: boolean): string {
  return `

---
mux context (attached by mux, not written by the owner) — ${new Date().toISOString()}${page ? `, the owner is on the dashboard page ${page}` : ""}
${brain}
${snapshot}

From your brain:
${memory}${corrected ? `

Some of your earlier answers in this conversation are left out: they wrongly said you had no memory, or repeated one canned line about your brain to every question. You do have a brain. Answer the owner's latest message itself — do not talk about your memory unless asked.` : ""}`;
}

/** A short picture of mux now, so the first answer starts from facts. */
export async function snapshot(): Promise<string> {
  const inst = await status().catch(() => []);
  const providers = listProviders().map((p) => `${p.id} (${p.kind}, ${p.enabled ? p.status : "disabled"}${p.info?.presence && p.status === "online" ? `, ${p.info.presence.state} ${p.info.presence.class}${p.info.presence.state !== "free" ? `: ${p.info.presence.reasons.join(", ")}` : ""}` : ""}${p.error ? `: ${p.error.slice(0, 120)}` : ""})`);
  const models = listModels();
  const routes = listRoutes().map((r) => `${r.name}[${r.strategy}: ${r.candidates.join(", ") || "all fitting"}]`);
  const problems = db.prepare("SELECT ts, level, source, message FROM events WHERE level != 'info' AND ts >= ? ORDER BY ts DESC LIMIT 6").all(now() - 6 * 3600_000) as { ts: number; level: string; source: string; message: string }[];
  const errs = db.prepare("SELECT COUNT(*) n, SUM(CASE WHEN status >= 400 THEN 1 ELSE 0 END) e FROM requests WHERE ts >= ?").get(now() - 3600_000) as { n: number; e: number | null };
  return [
    `Providers: ${providers.join("; ") || "none"}.`,
    `Models (${models.length}): ${models.map((m) => `${m.id}${m.enabled ? "" : " (disabled)"}`).join(", ") || "none"}.`,
    `Loaded here: ${inst.map((i) => `${i.id} ${i.state}`).join(", ") || "nothing"}.`,
    `Routes: ${routes.join("; ")}.`,
    `Last hour: ${errs.n} requests, ${errs.e ?? 0} errors.`,
    problems.length ? `Recent warnings and errors:\n${problems.map((p) => `  ${new Date(p.ts).toISOString()} ${p.level} [${p.source}] ${p.message.slice(0, 200)}`).join("\n")}` : "No warnings or errors in the last 6 hours.",
  ].join("\n");
}

export const isChange = (name: string, args: Record<string, unknown>) =>
  name === "brain_forget" || name === "mux_api" && String(args.method ?? "GET").toUpperCase() !== "GET" && !/\/routes\/explain$|^\/?lens(\/watches\/[^/]+\/run)?$|^\/?advisor\/signals$/.test(String(args.path ?? "").replace(/^\/api\/admin/, ""));

export const parse = (s: string): Record<string, unknown> => { try { const v = JSON.parse(s || "{}"); return v && typeof v === "object" ? v : {}; } catch { return {}; } };

/** Long arrays and texts are cut so one answer cannot fill the model's context. */
function compact(v: unknown, key = ""): unknown {
  if (Array.isArray(v)) {
    const keep = key === "series" ? v.slice(-24) : v.slice(0, 40);
    const out = keep.map((x) => compact(x));
    return v.length > keep.length ? [...out, `… ${v.length - keep.length} more ${key === "series" ? "earlier points" : "items"}`] : out;
  }
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, compact(x, k)]));
  if (typeof v === "string" && v.length > 4000) return `${v.slice(0, 1500)}\n…\n${v.slice(-2500)}`;
  return v;
}
const clip = (s: string) => (s.length > RESULT_CHARS ? `${s.slice(0, RESULT_CHARS)}\n… (cut at ${RESULT_CHARS} characters: ask for less, e.g. with a filter or a limit)` : s);

async function admin(app: FastifyInstance, method: string, path: string, query?: Record<string, unknown>, body?: unknown) {
  if (!path.startsWith("/")) path = `/${path}`;
  path = path.replace(/^\/api\/admin/, "");
  if (/^\/(live|assistant)\b/.test(path)) return { status: 400, data: { error: `${path} is not for the assistant` } };
  const qs = query ? Object.entries(query).filter(([, v]) => v !== undefined && v !== null && v !== "").map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`).join("&") : "";
  const res = await app.inject({
    method: method.toUpperCase() as "GET", url: `/api/admin${path}${qs ? `${path.includes("?") ? "&" : "?"}${qs}` : ""}`,
    headers: { authorization: `Bearer ${config.adminToken}`, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    payload: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let data: unknown = res.body;
  try { data = JSON.parse(res.body); } catch { /* text */ }
  return { status: res.statusCode, data };
}

export async function runTool(app: FastifyInstance, call: Call, emit: (type: string, data: unknown) => void, source = "assistant"): Promise<string> {
  const who = source === "doctor" ? "doctor" : source === "brain-keeper" ? "brain-keeper" : "assistant";
  const a = parse(call.function.arguments);
  try {
    switch (call.function.name) {
      case "mux_api": {
        // A change runs as its agent: approved by the owner (the assistant) or within the doctor's safe set (the doctor).
        const r = await asActor(who, () => admin(app, String(a.method ?? "GET"), String(a.path ?? "/"), a.query as Record<string, unknown>, a.body));
        return clip(JSON.stringify({ status: r.status, data: compact(r.data) }));
      }
      case "read_log": {
        const q = { source: a.source, model: a.model, grep: a.grep, lines: a.lines };
        const r = await admin(app, "GET", a.node ? `/providers/${a.node}/proxy/logs` : "/logs", q);
        const d = r.data as { log?: string; error?: string };
        return clip(r.status === 200 ? d.log || "(empty)" : JSON.stringify(r.data));
      }
      case "test_request": {
        const t0 = Date.now();
        const res = await fetch(`${gateway}/v1/chat/completions`, {
          method: "POST", signal: AbortSignal.timeout(180_000),
          headers: { "content-type": "application/json", authorization: `Bearer ${assistantKey()}`, "x-mux-agent": "assistant-test" },
          body: JSON.stringify({ model: a.model || "auto", max_tokens: Number(a.max_tokens) || 300, messages: [{ role: "user", content: String(a.prompt ?? "") }] }),
        });
        const j = (await res.json().catch(() => ({}))) as { choices?: { message?: { content?: string } }[]; usage?: unknown; error?: unknown };
        const h = (k: string) => res.headers.get(k);
        return clip(JSON.stringify({
          status: res.status, ms: Date.now() - t0, model: h("x-mux-model"), route: h("x-mux-route"), fallbacks: h("x-mux-fallbacks"), coldStart: h("x-mux-cold-start"),
          requestId: h("x-mux-request-id"), answer: j.choices?.[0]?.message?.content ?? null, usage: j.usage, error: j.error,
        }));
      }
      case "brain_search": {
        const pages = await search(String(a.query ?? ""), { kind: a.kind ? String(a.kind) : undefined, limit: Math.min(Number(a.limit) || 6, 20), touch: true });
        return clip(JSON.stringify(pages.length ? pages.map((p) => ({ id: p.id, title: p.title, kind: p.kind, subject: p.subject, updated: new Date(p.updated_at).toISOString().slice(0, 10), score: Number(p.score.toFixed(2)), body: p.body.slice(0, 2500) })) : { pages: [], note: "nothing in the brain matches" }));
      }
      case "brain_write": {
        const p = await asActor(who, () => writePage({ id: a.id ? String(a.id) : undefined, title: String(a.title ?? ""), body: String(a.body ?? ""), kind: String(a.kind ?? "note"), subject: a.subject ? String(a.subject) : undefined, tags: a.tags as string[] | undefined, source }));
        emit("brain", { id: p.id, title: p.title });
        return JSON.stringify({ ok: true, id: p.id, title: p.title, embedded: p.embedded });
      }
      case "brain_forget":
        return JSON.stringify((await asActor(who, () => forgetPage(String(a.id ?? "")))) ? { ok: true, forgotten: a.id } : { error: `no page ${a.id}` });
      case "brain_remember":
        return clip(JSON.stringify(await asActor(who, () => rememberFact({ fact: String(a.fact ?? ""), entity: a.entity ? String(a.entity) : undefined, kind: a.kind ? String(a.kind) : undefined, provenance: `mux ${source}` }))));
      case "open_page":
        emit("navigate", { path: String(a.path ?? "/") });
        return JSON.stringify({ ok: true, opened: a.path });
      default:
        return JSON.stringify({ error: `no tool ${call.function.name}` });
    }
  } catch (e) {
    return JSON.stringify({ error: (e as Error).message });
  }
}

/** Every tool call gets a result before the next message; calls left open (the user moved on) are marked not run. */
function repair(msgs: Msg[]): Msg[] {
  const out: Msg[] = [];
  for (let i = 0; i < msgs.length; i++) {
    const m = msgs[i];
    out.push(m);
    if (m.role !== "assistant" || !m.tool_calls?.length) continue;
    const answered = new Set<string>();
    for (let j = i + 1; j < msgs.length && msgs[j].role === "tool"; j++) answered.add(msgs[j].tool_call_id ?? "");
    const open = m.tool_calls.filter((c) => !answered.has(c.id));
    let k = i + 1;
    while (k < msgs.length && msgs[k].role === "tool") out.push(msgs[k++]);
    for (const c of open) out.push({ role: "tool", tool_call_id: c.id, content: JSON.stringify({ error: "not run: the user did not approve it" }) });
    i = k - 1;
  }
  return out;
}

interface Step { content: string; reasoning: string; calls: Call[]; model: string | null; route: string | null; requestId: string | null }

/** One model turn through the gateway, streamed: text and thinking go to the dashboard as they come. */
/** Tool results from turns before the latest question, as the model reads them: their start, enough to recall them. */
const OLD_RESULT_CHARS = 1200;

/**
 * The conversation as the model reads it: the same text turn after turn, so the prompt cache holds it — earlier
 * turns' tool results cut short (the current turn's in full), and mux's context only on the latest question.
 */
export function wireMessages(msgs: Msg[], _brain = "", context = "") {
  const lastUser = msgs.map((m) => m.role).lastIndexOf("user");
  return msgs.flatMap((m, i) => {
    if (left(m)) return [];
    let content = m.content;
    if (m.role === "tool" && i < lastUser && typeof content === "string" && content.length > OLD_RESULT_CHARS) content = `${content.slice(0, OLD_RESULT_CHARS)}… (cut: an earlier turn's result)`;
    if (i === lastUser && context) content = `${content ?? ""}${context}`;
    return [{ role: m.role, content: content ?? (m.tool_calls ? null : ""), ...(m.tool_calls ? { tool_calls: m.tool_calls } : {}), ...(m.tool_call_id ? { tool_call_id: m.tool_call_id } : {}) }];
  });
}

async function step(msgs: Msg[], sys: string, model: string, convo: string, signal: AbortSignal, emit: (type: string, data: unknown) => void, agent = "assistant", brain = "", context = ""): Promise<Step> {
  const wire = [{ role: "system", content: sys }, ...wireMessages(msgs, brain, context)];
  const res = await fetch(`${gateway}/v1/chat/completions`, {
    method: "POST", signal,
    headers: { "content-type": "application/json", authorization: `Bearer ${assistantKey()}`, "x-mux-agent": agent, "x-mux-trace-id": convo },
    body: JSON.stringify({ model, stream: true, messages: wire, tools: TOOLS, tool_choice: "auto", max_tokens: 4096, temperature: 0.3 }),
  });
  const out: Step = { content: "", reasoning: "", calls: [], model: res.headers.get("x-mux-model"), route: res.headers.get("x-mux-route"), requestId: res.headers.get("x-mux-request-id") };
  emit("meta", { model: out.model, route: out.route, requestId: out.requestId });
  if (!res.ok) {
    const j = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
    throw new Error(`the assistant's model (${model}) failed: ${j.error?.message ?? res.status}`);
  }
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let buf = "";
  const partial: { id: string; name: string; args: string }[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i: number;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
      if (!line.startsWith("data:")) continue;
      const d = line.slice(5).trim();
      if (d === "[DONE]") continue;
      let j: { choices?: { delta?: { content?: string; reasoning_content?: string; tool_calls?: { index: number; id?: string; function?: { name?: string; arguments?: string } }[] } }[] };
      try { j = JSON.parse(d); } catch { continue; }
      const delta = j.choices?.[0]?.delta;
      if (!delta) continue;
      if (delta.reasoning_content) { out.reasoning += delta.reasoning_content; emit("reasoning", { text: delta.reasoning_content }); }
      if (delta.content) { out.content += delta.content; emit("delta", { text: delta.content }); }
      for (const tc of delta.tool_calls ?? []) {
        const p = (partial[tc.index] ??= { id: "", name: "", args: "" });
        if (tc.id) p.id = tc.id;
        if (tc.function?.name) p.name += tc.function.name;
        if (tc.function?.arguments) p.args += tc.function.arguments;
      }
    }
  }
  out.calls = partial.filter(Boolean).map((p) => ({ id: p.id || `call_${randomBytes(6).toString("hex")}`, type: "function", function: { name: p.name, arguments: p.args || "{}" } }));
  return out;
}

/** `api` is the admin scope (its token check guards this route); `app` is the server, which the tools call into. */
export type Decision = "run" | "pause" | { skip: string };

/**
 * The agent loop: the model thinks, calls tools, reads their results and goes on, until it answers, a call must wait
 * for the user ("pause"), or MAX_STEPS. `decide` says, per call, whether it runs now. Returns the transcript.
 */
export async function converse(app: FastifyInstance, o: { msgs: Msg[]; sys: string; model: string; convo: string; signal: AbortSignal; emit: (type: string, data: unknown) => void; decide: (c: Call) => Decision; agent?: string; brain?: string; context?: string }): Promise<Msg[]> {
  const msgs = [...o.msgs];
  for (let n = 0; n < MAX_STEPS; n++) {
    const s = await step(msgs, o.sys, o.model, o.convo, o.signal, o.emit, o.agent, o.brain, o.context);
    msgs.push({ role: "assistant", content: s.content || null, ...(s.calls.length ? { tool_calls: s.calls } : {}), ...(s.reasoning ? { reasoning_content: s.reasoning } : {}), ...(s.model ? { model: s.model } : {}) });
    if (!s.calls.length) break;
    const pending: Call[] = [];
    for (const c of s.calls) {
      const d = o.decide(c);
      o.emit("call", { id: c.id, name: c.function.name, args: parse(c.function.arguments), change: d === "pause" });
      if (d === "pause") { pending.push(c); continue; }
      const content = d === "run" ? await runTool(app, c, o.emit, o.agent) : JSON.stringify({ error: d.skip });
      o.emit("result", { id: c.id, content });
      msgs.push({ role: "tool", tool_call_id: c.id, content });
    }
    if (pending.length) { o.emit("pending", { ids: pending.map((c) => c.id) }); break; }
    if (n === MAX_STEPS - 1) o.emit("delta", { text: "\n\n_(stopped after many steps; say \"go on\" to continue)_" });
  }
  return msgs;
}

/** Keep a conversation on the server, named after its first question. */
function saveConversation(id: string, msgs: Msg[], page?: string) {
  const first = msgs.find((m) => m.role === "user" && m.content)?.content;
  if (!first) return;
  const title = first.replace(/\s+/g, " ").trim().slice(0, 80);
  db.prepare(`INSERT INTO assistant_conversations(id, title, messages, page, created_at, updated_at) VALUES(?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET messages = excluded.messages, page = excluded.page, updated_at = excluded.updated_at`)
    .run(id, title, JSON.stringify(msgs), page ?? null, now(), now());
}

export function registerAssistant(api: FastifyInstance, app: FastifyInstance) {
  api.get("/assistant/conversations", async (req) => {
    const q = req.query as { limit?: string };
    return db.prepare("SELECT id, title, page, created_at, updated_at, json_array_length(messages) messages FROM assistant_conversations ORDER BY updated_at DESC LIMIT ?").all(Math.min(Number(q.limit) || 50, 200));
  });
  api.get("/assistant/conversations/:id", async (req, reply) => {
    const r = db.prepare("SELECT * FROM assistant_conversations WHERE id = ?").get((req.params as { id: string }).id) as { messages: string } | undefined;
    return r ? { ...r, messages: json<Msg[]>(r.messages, []) } : reply.code(404).send({ error: "no such conversation" });
  });
  api.delete("/assistant/conversations/:id", async (req) => ({ ok: db.prepare("DELETE FROM assistant_conversations WHERE id = ?").run((req.params as { id: string }).id).changes > 0 }));

  api.post("/assistant", async (req: FastifyRequest, reply: FastifyReply) => {
    const b = (req.body ?? {}) as { messages?: Msg[]; approvals?: Record<string, boolean>; page?: string; model?: string; conversation?: string };
    let msgs: Msg[] = Array.isArray(b.messages) ? b.messages.filter((m) => m && ["user", "assistant", "tool"].includes(m.role)) : [];
    if (!msgs.length) return reply.code(400).send({ error: "messages are required" });
    const model = b.model || settings().assistantModel || "auto";
    const convo = b.conversation || `asst_${randomBytes(6).toString("hex")}`;

    reply.hijack();
    reply.raw.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive", "x-accel-buffering": "no" });
    const emit = (type: string, data: unknown) => { if (!reply.raw.destroyed) reply.raw.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`); };
    const ac = new AbortController();
    reply.raw.on("close", () => ac.abort());
    const ping = setInterval(() => { if (!reply.raw.destroyed) reply.raw.write(": ping\n\n"); }, 15_000);

    try {
      // Resuming after a pause: run what was approved, mark what was not.
      const last = [...msgs].reverse().find((m) => m.role !== "tool");
      if (last?.role === "assistant" && last.tool_calls?.length && b.approvals) {
        const done = new Set(msgs.filter((m) => m.role === "tool").map((m) => m.tool_call_id));
        for (const c of last.tool_calls.filter((x) => !done.has(x.id))) {
          const yes = b.approvals[c.id] === true;
          const content = yes ? await runTool(app, c, emit) : JSON.stringify({ error: "the user declined this change" });
          emit("result", { id: c.id, approved: yes, content });
          msgs.push({ role: "tool", tool_call_id: c.id, content });
        }
      }
      msgs = repair(msgs);
      // What the brain knows about the latest question, recalled once per question.
      const asked = [...msgs].reverse().find((m) => m.role === "user");
      const mem = await recall(asked?.content ?? "");
      if (asked && !asked.recalled) {
        asked.recalled = mem.pages.map((p) => ({ id: p.id, title: p.title }));
        emit("recall", { pages: asked.recalled });
      }
      const brain = await brainLine();
      const sys = systemPrompt();
      const context = contextBlock(await snapshot(), b.page, mem.block, brain, deniedMemory(msgs));
      msgs = await converse(app, { msgs, sys, model, convo, signal: ac.signal, emit, brain, context, decide: (c) => (isChange(c.function.name, parse(c.function.arguments)) ? "pause" : "run") });
    } catch (e) {
      if (!ac.signal.aborted) emit("error", { message: (e as Error).message });
    } finally {
      clearInterval(ping);
      try { saveConversation(convo, msgs, b.page); } catch { /* a conversation that cannot be kept is still answered */ }
      emit("messages", { messages: msgs, conversation: convo });
      emit("done", {});
      reply.raw.end();
    }
  });
}
