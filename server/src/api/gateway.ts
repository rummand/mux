import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { listModels, listRoutes } from "../models.js";
import { runChat, type ChatBody } from "../router/chat.js";
import { runAudio, type AudioKind } from "../router/audio.js";
import { runEmbeddings } from "../router/embed.js";
import { MuxError, toMuxError } from "../router/errors.js";
import { check, enter, leave } from "../router/limits.js";
import { finish, newCtx, type Ctx } from "../router/metering.js";
import { features } from "../router/select.js";
import { runSystemOne } from "../router/systemone.js";
import { authenticate } from "../tenants.js";
import { anthropicErrorType, fromOpenAI, StreamTranslator, toOpenAI, type MessagesBody } from "./anthropic.js";

type Flavour = "openai" | "anthropic";

function bearer(req: FastifyRequest): string {
  const h = req.headers;
  const auth = typeof h.authorization === "string" ? h.authorization.replace(/^Bearer\s+/i, "") : "";
  return auth || (typeof h["x-api-key"] === "string" ? h["x-api-key"] : "") || (typeof h["api-key"] === "string" ? h["api-key"] : "");
}

const header = (req: FastifyRequest, name: string) => (typeof req.headers[name] === "string" ? (req.headers[name] as string) : null);

function errorBody(flavour: Flavour, e: MuxError) {
  return flavour === "anthropic"
    ? { type: "error", error: { type: anthropicErrorType(e.status), message: e.message } }
    : { error: { message: e.message, type: e.type, code: e.status } };
}

function sendError(reply: FastifyReply, flavour: Flavour, e: MuxError) {
  if (e.retryAfterS) reply.header("retry-after", String(e.retryAfterS));
  return reply.code(e.status === 499 ? 400 : e.status).send(errorBody(flavour, e));
}

/** Who is calling, what they may do, and the call's record — or the reply that refuses them. */
function begin(req: FastifyRequest, reply: FastifyReply, endpoint: string, flavour: Flavour): Ctx | null {
  const who = authenticate(bearer(req));
  if (!who) { sendError(reply, flavour, new MuxError(401, "invalid_api_key", "a mux API key is required (Authorization: Bearer mux-sk-… or x-api-key)")); return null; }
  const body = (req.body ?? {}) as { metadata?: { tags?: string[]; user_id?: string }; user?: string };
  const tags = [...(header(req, "x-mux-tags")?.split(",") ?? []), ...(body.metadata?.tags ?? [])].map((t) => t.trim()).filter(Boolean);
  const ctx = newCtx(who.tenant, who.key, endpoint, req.ip, header(req, "user-agent") ?? "", tags);
  ctx.traceId = header(req, "x-mux-trace-id") ?? header(req, "x-request-id");
  ctx.agent = header(req, "x-mux-agent");
  ctx.endUser = body.user ?? body.metadata?.user_id ?? header(req, "x-mux-user");
  ctx.noFallback = header(req, "x-mux-no-fallback") === "1";
  ctx.bodyReq = req.body;
  try { check(who.tenant, who.key); enter(who.tenant); } catch (e) {
    const err = toMuxError(e);
    finish(ctx, err.status, { type: err.type, message: err.message });
    sendError(reply, flavour, err);
    return null;
  }
  return ctx;
}

function muxHeaders(ctx: Ctx): Record<string, string> {
  return {
    "x-mux-request-id": ctx.id, "x-mux-model": ctx.modelId ?? "", "x-mux-route": ctx.route ?? "",
    "x-mux-fallbacks": String(ctx.fallbacks ?? 0), "x-mux-cold-start": ctx.coldStart ? "1" : "0",
  };
}

/** A caller that hangs up mid-answer stops the model too. */
function abortOnClose(reply: FastifyReply) {
  const ac = new AbortController();
  reply.raw.on("close", () => { if (!reply.raw.writableFinished) ac.abort(); });
  return ac;
}

async function chat(req: FastifyRequest, reply: FastifyReply, flavour: Flavour) {
  const ctx = begin(req, reply, flavour === "anthropic" ? "anthropic.messages" : "openai.chat", flavour);
  if (!ctx) return reply;
  const ac = abortOnClose(reply);
  let body: ChatBody;
  let requested = "";
  try {
    if (flavour === "anthropic") {
      const a = req.body as MessagesBody;
      if (!a?.messages || !a.max_tokens) throw new MuxError(400, "invalid_request", "messages and max_tokens are required");
      requested = a.model;
      body = toOpenAI(a);
    } else {
      body = req.body as ChatBody;
      if (!Array.isArray(body?.messages)) throw new MuxError(400, "invalid_request", "messages is required");
      requested = body.model ?? "";
    }
  } catch (e) {
    const err = toMuxError(e);
    leave(ctx.tenant);
    finish(ctx, err.status, { type: err.type, message: err.message });
    return sendError(reply, flavour, err);
  }

  let headersSent = false;
  const startStream = () => {
    if (headersSent) return;
    headersSent = true;
    reply.hijack();
    reply.raw.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive", "x-accel-buffering": "no", ...muxHeaders(ctx) });
  };
  const translator = flavour === "anthropic" ? new StreamTranslator(requested, (event, data) => { startStream(); reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); }) : null;
  try {
    if (body.stream) {
      await runChat(ctx, body, ac.signal, (c) => {
        if (translator) return translator.chunk(c);
        startStream();
        reply.raw.write(`data: ${JSON.stringify(c)}\n\n`);
      });
      if (translator) translator.end(ctx.promptTokens ?? 0, ctx.completionTokens ?? 0);
      else { startStream(); reply.raw.write("data: [DONE]\n\n"); }
      reply.raw.end();
      finish(ctx, 200);
      return reply;
    }
    const out = await runChat(ctx, body, ac.signal);
    finish(ctx, 200);
    reply.headers(muxHeaders(ctx));
    return reply.send(flavour === "anthropic" ? fromOpenAI(out!, requested) : out);
  } catch (e) {
    const err = toMuxError(e);
    finish(ctx, err.status, { type: err.type, message: err.message });
    if (!headersSent) return sendError(reply, flavour, err);
    // Mid-stream there is no status left to set: the error goes out as the stream's last event.
    if (flavour === "anthropic") reply.raw.write(`event: error\ndata: ${JSON.stringify(errorBody(flavour, err))}\n\n`);
    else reply.raw.write(`data: ${JSON.stringify(errorBody(flavour, err))}\n\n`);
    reply.raw.end();
    return reply;
  } finally {
    leave(ctx.tenant);
  }
}

async function simple(req: FastifyRequest, reply: FastifyReply, endpoint: string, run: (ctx: Ctx, signal: AbortSignal) => Promise<unknown>) {
  const ctx = begin(req, reply, endpoint, "openai");
  if (!ctx) return reply;
  const ac = abortOnClose(reply);
  try {
    const out = await run(ctx, ac.signal);
    finish(ctx, 200);
    reply.headers(muxHeaders(ctx));
    return reply.send(out);
  } catch (e) {
    const err = toMuxError(e);
    finish(ctx, err.status, { type: err.type, message: err.message });
    return sendError(reply, "openai", err);
  } finally {
    leave(ctx.tenant);
  }
}

/** Speech to text or text to speech: the upstream's audio or JSON goes back as it came. */
async function audio(req: FastifyRequest, reply: FastifyReply, kind: AudioKind) {
  const ctx = begin(req, reply, kind === "transcription" ? "openai.audio.transcriptions" : "openai.audio.speech", "openai");
  if (!ctx) return reply;
  ctx.bodyReq = null; // audio is never logged
  const ac = abortOnClose(reply);
  try {
    const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from(JSON.stringify(req.body ?? {}));
    const query = (req.query ?? {}) as { model?: string };
    const requested = query.model ?? (kind === "speech" ? (req.body as { model?: string } | undefined)?.model : undefined);
    const res = await runAudio(ctx, kind, requested, raw, header(req, "content-type") ?? "application/json", ac.signal);
    const out = Buffer.from(await res.arrayBuffer());
    finish(ctx, 200);
    reply.headers(muxHeaders(ctx));
    return reply.type(res.headers.get("content-type") ?? "application/octet-stream").send(out);
  } catch (e) {
    const err = toMuxError(e);
    finish(ctx, err.status, { type: err.type, message: err.message });
    return sendError(reply, "openai", err);
  } finally {
    leave(ctx.tenant);
  }
}

export function registerGateway(app: FastifyInstance) {
  // Audio uploads are passed on untouched
  app.addContentTypeParser("multipart/form-data", { parseAs: "buffer" }, (_req, body, done) => done(null, body));
  app.post("/v1/audio/transcriptions", (req, reply) => audio(req, reply, "transcription"));
  app.post("/v1/audio/speech", (req, reply) => audio(req, reply, "speech"));
  app.post("/v1/chat/completions", (req, reply) => chat(req, reply, "openai"));
  app.post("/v1/messages", (req, reply) => chat(req, reply, "anthropic"));
  app.post("/v1/embeddings", (req, reply) => simple(req, reply, "openai.embeddings", (ctx, s) => runEmbeddings(ctx, req.body as never, s)));
  for (const path of ["/v1/rerank", "/v1/reranking", "/rerank"]) app.post(path, (req, reply) => simple(req, reply, "rerank", (ctx, s) => runEmbeddings(ctx, req.body as never, s, "rerank")));
  app.post("/v1/systemone", (req, reply) => simple(req, reply, "systemone", (ctx, s) => runSystemOne(ctx, req.body as never, s)));

  app.post("/v1/messages/count_tokens", async (req, reply) => {
    if (!authenticate(bearer(req))) return sendError(reply, "anthropic", new MuxError(401, "invalid_api_key", "a mux API key is required"));
    return { input_tokens: features(toOpenAI({ ...(req.body as MessagesBody), max_tokens: (req.body as MessagesBody).max_tokens ?? 1 })).inputTokens };
  });

  // What this key can ask for: the routes first (what most callers should use), then the models by name.
  app.get("/v1/models", async (req, reply) => {
    const who = authenticate(bearer(req));
    if (!who) return sendError(reply, "openai", new MuxError(401, "invalid_api_key", "a mux API key is required"));
    const ok = (n: string) => !who.tenant.allowed.length || who.tenant.allowed.includes(n);
    const created = Math.floor(Date.now() / 1000);
    const data = [
      ...listRoutes().filter((r) => ok(r.name)).map((r) => ({ id: r.name, object: "model", created, owned_by: "mux-route", kind: r.kind, description: r.description })),
      ...listModels().filter((m) => m.enabled && ok(m.id)).map((m) => ({ id: m.id, object: "model", created, owned_by: `mux-${m.backend}`, kind: m.kind, context_length: m.ctx })),
    ];
    return { object: "list", data };
  });
}
