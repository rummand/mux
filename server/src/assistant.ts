import { randomBytes } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { config } from "./config.js";
import { db, now, settings } from "./db.js";
import { listModels, listRoutes } from "./models.js";
import { listProviders } from "./providers.js";
import { status } from "./runtime/manager.js";
import { createKey, getTenant, upsertTenant } from "./tenants.js";

/**
 * The dashboard's assistant: a chat that runs mux with mux. A model (through mux's own gateway, metered as the
 * Assistant tenant) gets the whole admin API as a tool, the logs, a test request and the dashboard's pages. Reading runs
 * on its own; anything that changes mux waits for the person to approve it in the dashboard.
 *
 * The conversation lives in the browser: each call sends the transcript and, after a pause, which pending calls were
 * approved; the reply streams as server-sent events and ends with the transcript as it now is.
 */
export interface Call { id: string; type: "function"; function: { name: string; arguments: string } }
export interface Msg { role: "user" | "assistant" | "tool"; content: string | null; tool_calls?: Call[]; tool_call_id?: string; reasoning_content?: string; model?: string }

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
        properties: { path: { type: "string", enum: ["/", "/tenants", "/tenants/<id>", "/requests", "/traces", "/lens", "/providers", "/models", "/advisor", "/routes", "/benchmarks", "/playground", "/system"], description: "A page; /tenants/<id> with a real tenant id" } },
        required: ["path"],
      },
    },
  },
];

const API_REFERENCE = `Admin API (paths under /api/admin). Tenants, routes and providers are created and updated with the same PUT to their id (there is no POST /tenants, /routes or /providers):
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
- GET /catalog; GET /advisor?useCase=&priority=quality|balanced|speed; GET /advisor/use-cases; GET /advisor/stack
- GET /hf/search?q=; GET /hf/files?repo=; GET /downloads; POST /downloads {catalogId} or {repo, file}; DELETE /downloads/:id; GET /local; POST /local/import {path, id?, kind?}
- GET /routes; PUT /routes/:name (create or update) {description, kind, strategy: priority|auto|fastest|quality, candidates: [model ids]}; DELETE /routes/:name
- POST /routes/explain {tenant?, model?, messages, tools?, kind?} — what the router would do, without sending (runs without approval)
- GET /tenants; GET /tenants/:id; PUT /tenants/:id (create or update) {name, description, color, status: active|paused, rpm_limit, tpm_limit, monthly_token_budget, monthly_usd_budget, max_parallel, default_route, allowed, aliases, log_bodies}; DELETE /tenants/:id
- POST /tenants/:id/keys {name, expiresInDays?, rpmLimit?, monthlyTokenBudget?} — returns the key once; DELETE /keys/:id revokes
- GET /requests?tenant=&model=&status=ok|error&agent=&trace=&q=&limit=; GET /requests/:id (with bodies and route reason); GET /traces?range=&tenant=
- GET /benchmarks?model=; POST /benchmarks {model}; GET /lens; POST /lens {title, filters: {range, tenant?, model?, status?}, criteria?, useModel?}
- GET /settings; PATCH /settings {memoryBudgetGb, memoryHeadroomGb, diskReserveGb, keepAliveMin, maxLoaded, retentionDays, pressureGuard, logBodies, assistantModel}`;

function systemPrompt(snapshot: string, page: string | undefined) {
  return `You are the mux assistant, inside mux's dashboard. mux is a model router and control plane: SaaS products call it with an API key through an OpenAI-style (/v1/chat/completions, /v1/embeddings, /v1/audio/*) or Anthropic-style (/v1/messages) API, and mux routes each request to a model — local models on mux nodes (llama.cpp llama-server, MLX, Laya for Jev's System One) or paid cloud APIs. A gateway (mux on Railway) runs no models; nodes (the Mac Studio) do. Tenants are the SaaS products, each with keys, limits, budgets, aliases and a default route. Routes are named model lists with a strategy. Every request is metered (tokens, latency, time to first token, speed, cost, fallbacks), and Lens looks for problems in the traffic.

Your job: help the user run and fix mux — find out why something fails, explain what mux is doing, and set up models, routes, tenants, keys, providers and settings. Look before you answer: read the state with your tools instead of guessing, and quote what you saw (numbers, ids, errors). When something is broken, find the cause in the events, the logs, the request detail and the system state, then propose the fix. For a change, call mux_api with a short "why"; the user approves it in the dashboard, so ask nothing first — propose the call itself. Make one change at a time and check its effect. Never ask for or repeat secrets (API keys, admin tokens): the user enters those in the dashboard. Answer in the user's language, briefly, in Markdown.

${API_REFERENCE}

Now: ${new Date().toISOString()}. This mux: role ${config.role}, name "${config.name}".${page ? ` The user is on the dashboard page ${page}.` : ""}
${snapshot}`;
}

/** A short picture of mux now, so the first answer starts from facts. */
async function snapshot(): Promise<string> {
  const inst = await status().catch(() => []);
  const providers = listProviders().map((p) => `${p.id} (${p.kind}, ${p.enabled ? p.status : "disabled"}${p.error ? `: ${p.error.slice(0, 120)}` : ""})`);
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

const isChange = (name: string, args: Record<string, unknown>) =>
  name === "mux_api" && String(args.method ?? "GET").toUpperCase() !== "GET" && !/\/routes\/explain$/.test(String(args.path ?? ""));

const parse = (s: string): Record<string, unknown> => { try { const v = JSON.parse(s || "{}"); return v && typeof v === "object" ? v : {}; } catch { return {}; } };

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

/** The Assistant tenant's own key: what the assistant sends through the gateway is metered like anyone's. */
function assistantKey(): string {
  const row = db.prepare("SELECT value FROM settings WHERE key = 'assistant_key'").get() as { value: string } | undefined;
  if (row && getTenant("assistant")) return JSON.parse(row.value);
  if (!getTenant("assistant")) upsertTenant({ id: "assistant", name: "Assistant", description: "The dashboard's assistant and its test requests", color: "#a855f7" });
  const { key } = createKey("assistant", "dashboard");
  db.prepare("INSERT INTO settings(key, value) VALUES('assistant_key', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(JSON.stringify(key));
  return key;
}

const gateway = `http://127.0.0.1:${config.port}`;

async function runTool(app: FastifyInstance, call: Call, emit: (type: string, data: unknown) => void): Promise<string> {
  const a = parse(call.function.arguments);
  try {
    switch (call.function.name) {
      case "mux_api": {
        const r = await admin(app, String(a.method ?? "GET"), String(a.path ?? "/"), a.query as Record<string, unknown>, a.body);
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
async function step(msgs: Msg[], sys: string, model: string, convo: string, signal: AbortSignal, emit: (type: string, data: unknown) => void): Promise<Step> {
  const wire = [{ role: "system", content: sys }, ...msgs.map(({ role, content, tool_calls, tool_call_id }) => ({ role, content: content ?? (tool_calls ? null : ""), ...(tool_calls ? { tool_calls } : {}), ...(tool_call_id ? { tool_call_id } : {}) }))];
  const res = await fetch(`${gateway}/v1/chat/completions`, {
    method: "POST", signal,
    headers: { "content-type": "application/json", authorization: `Bearer ${assistantKey()}`, "x-mux-agent": "assistant", "x-mux-trace-id": convo },
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
export function registerAssistant(api: FastifyInstance, app: FastifyInstance) {
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
      const sys = systemPrompt(await snapshot(), b.page);

      for (let n = 0; n < MAX_STEPS; n++) {
        const s = await step(msgs, sys, model, convo, ac.signal, emit);
        msgs.push({ role: "assistant", content: s.content || null, ...(s.calls.length ? { tool_calls: s.calls } : {}), ...(s.reasoning ? { reasoning_content: s.reasoning } : {}), ...(s.model ? { model: s.model } : {}) });
        if (!s.calls.length) break;
        const pending: Call[] = [];
        for (const c of s.calls) {
          const change = isChange(c.function.name, parse(c.function.arguments));
          emit("call", { id: c.id, name: c.function.name, args: parse(c.function.arguments), change });
          if (change) { pending.push(c); continue; }
          const content = await runTool(app, c, emit);
          emit("result", { id: c.id, content });
          msgs.push({ role: "tool", tool_call_id: c.id, content });
        }
        if (pending.length) { emit("pending", { ids: pending.map((c) => c.id) }); break; }
        if (n === MAX_STEPS - 1) emit("delta", { text: "\n\n_(stopped after many steps; say \"go on\" to continue)_" });
      }
    } catch (e) {
      if (!ac.signal.aborted) emit("error", { message: (e as Error).message });
    } finally {
      clearInterval(ping);
      emit("messages", { messages: msgs, conversation: convo });
      emit("done", {});
      reply.raw.end();
    }
  });
}
