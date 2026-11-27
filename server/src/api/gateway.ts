import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { listModels, listRoutes } from "../models.js";
import { runChat, type ChatBody } from "../router/chat.js";
import { formField, runAudio, runDepth, runImage, type AudioKind, type ImageOp } from "../router/audio.js";
import { runEmbeddings } from "../router/embed.js";
import { MuxError, toMuxError } from "../router/errors.js";
import { check, enter, leave, rateLeft } from "../router/limits.js";
import { finish, newCtx, type Ctx } from "../router/metering.js";
import { features } from "../router/select.js";
import { runSystemOne } from "../router/systemone.js";
import { runSearch } from "../router/web.js";
import { runRead } from "../router/reader.js";
import { cancelVideo, createVideo, videoContent, videoStatus } from "../router/video.js";
import { cancelReconstruction, createReconstruction, measureName, reconstructionStatus } from "../router/measure.js";
import { CONVERT_BODY_LIMIT, runConvert } from "../router/convert.js";
import { BACKDROP_FILES, backdropFile, backdropStatus, cancelBackdrop, createBackdrop, type BackdropFile } from "../router/backdrop.js";
import { authenticate } from "../tenants.js";
import { classify, parseStages } from "../priority.js";
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

/**
 * Who is calling, what they may do, and the call's record — or the reply that refuses them. `logBody` false: the
 * body is never kept, not even with a refusal (images, audio, video and their prompts).
 */
function begin(req: FastifyRequest, reply: FastifyReply, endpoint: string, flavour: Flavour, logBody = true): Ctx | null {
  const who = authenticate(bearer(req));
  if (!who) { sendError(reply, flavour, new MuxError(401, "invalid_api_key", "a mux API key is required (Authorization: Bearer mux-sk-… or x-api-key)")); return null; }
  const body = (req.body ?? {}) as { metadata?: { tags?: string[]; user_id?: string }; user?: string };
  const tags = [...(header(req, "x-mux-tags")?.split(",") ?? []), ...(body.metadata?.tags ?? [])].map((t) => t.trim()).filter(Boolean);
  const ctx = newCtx(who.tenant, who.key, endpoint, req.ip, header(req, "user-agent") ?? "", tags);
  ctx.traceId = header(req, "x-mux-trace-id") ?? header(req, "x-request-id");
  ctx.affinity = header(req, "x-mux-affinity") ?? header(req, "x-mux-trace-id");
  ctx.agent = header(req, "x-mux-agent");
  ctx.endUser = body.user ?? body.metadata?.user_id ?? header(req, "x-mux-user");
  ctx.noFallback = header(req, "x-mux-no-fallback") === "1";
  // Turn stats and priority (speed.ts, priority.ts): the caller's trace for this turn and its own stages, and its class
  ctx.trace = header(req, "x-mux-trace") ?? header(req, "x-mux-trace-id");
  ctx.traceId ??= header(req, "x-mux-trace");
  ctx.stageHeader = header(req, "x-mux-stage");
  ctx.stages = parseStages(ctx.stageHeader);
  const requestedModel = typeof (body as { model?: unknown }).model === "string" ? (body as { model: string }).model : null;
  const cls = classify({ header: header(req, "x-mux-priority"), tenant: who.tenant.id, endpoint, agent: ctx.agent, tags, model: requestedModel });
  ctx.priority = cls.priority; ctx.priorityWhy = cls.why;
  ctx.bodyReq = logBody ? req.body : null;
  try { check(who.tenant, who.key); enter(who.tenant); ctx.rate = rateLeft(who.tenant); } catch (e) {
    const err = toMuxError(e);
    const rate = rateLeft(who.tenant);
    if (rate) reply.headers({ "x-ratelimit-limit-requests": String(rate.limit), "x-ratelimit-remaining-requests": String(rate.remaining) });
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
    "x-mux-priority": ctx.priority ?? "normal", "x-mux-queue-ms": String(Math.round(ctx.queueMs ?? 0)),
    ...(ctx.rate ? { "x-ratelimit-limit-requests": String(ctx.rate.limit), "x-ratelimit-remaining-requests": String(ctx.rate.remaining) } : {}),
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
    reply.headers(muxHeaders(ctx));
    return sendError(reply, "openai", err);
  } finally {
    leave(ctx.tenant);
  }
}

/** Speech to text or text to speech: the upstream's audio or JSON goes back as it came. */
async function audio(req: FastifyRequest, reply: FastifyReply, kind: AudioKind) {
  const ctx = begin(req, reply, kind === "transcription" ? "openai.audio.transcriptions" : "openai.audio.speech", "openai", false);
  if (!ctx) return reply;
  ctx.bodyReq = null; // audio is never logged
  const ac = abortOnClose(reply);
  try {
    const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from(JSON.stringify(req.body ?? {}));
    const query = (req.query ?? {}) as { model?: string };
    const requested = query.model ?? (kind === "speech" ? (req.body as { model?: string } | undefined)?.model : formField(raw, header(req, "content-type") ?? "", "model"));
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

/** Text to image or an edit of images: the upstream's JSON (`data[].b64_json`) goes back as it came. */
async function image(req: FastifyRequest, reply: FastifyReply, op: ImageOp) {
  const ctx = begin(req, reply, `openai.images.${op}`, "openai", false);
  if (!ctx) return reply;
  ctx.bodyReq = null; // images and their prompts are never logged
  const ac = abortOnClose(reply);
  try {
    const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from(JSON.stringify(req.body ?? {}));
    const type = header(req, "content-type") ?? "application/json";
    const query = (req.query ?? {}) as { model?: string };
    const requested = query.model ?? (op === "generations" ? (req.body as { model?: string } | undefined)?.model : formField(raw, type, "model"));
    const res = await runImage(ctx, op, requested, raw, type, ac.signal);
    const out = Buffer.from(await res.arrayBuffer());
    finish(ctx, 200);
    reply.headers(muxHeaders(ctx));
    return reply.type(res.headers.get("content-type") ?? "application/json").send(out);
  } catch (e) {
    const err = toMuxError(e);
    finish(ctx, err.status, { type: err.type, message: err.message });
    reply.headers(muxHeaders(ctx));
    return sendError(reply, "openai", err);
  } finally {
    leave(ctx.tenant);
  }
}

/** POST /v1/videos/generations: a job starts where the route's model runs; 202 with mux's id for it. */
async function videoCreate(req: FastifyRequest, reply: FastifyReply) {
  const ctx = begin(req, reply, "openai.videos.generations", "openai", false);
  if (!ctx) return reply;
  const ac = abortOnClose(reply);
  try {
    const out = await createVideo(ctx, (req.body ?? {}) as Record<string, unknown>, ac.signal);
    finish(ctx, 202);
    reply.headers(muxHeaders(ctx));
    return reply.code(202).send(out);
  } catch (e) {
    const err = toMuxError(e);
    finish(ctx, err.status, { type: err.type, message: err.message });
    reply.headers(muxHeaders(ctx));
    return sendError(reply, "openai", err);
  } finally {
    leave(ctx.tenant);
  }
}

/** Status, content and cancel of a video job: the caller's key, and only its own jobs. Polls are not metered. */
async function videoJob(req: FastifyRequest, reply: FastifyReply, what: "status" | "content" | "cancel") {
  const who = authenticate(bearer(req));
  if (!who) return sendError(reply, "openai", new MuxError(401, "invalid_api_key", "a mux API key is required (Authorization: Bearer mux-sk-… or x-api-key)"));
  const id = (req.params as { id: string }).id;
  try {
    if (what === "content") {
      const v = await videoContent(who.tenant, id, abortOnClose(reply).signal);
      return reply.type(v.type).send(v.body);
    }
    return await (what === "status" ? videoStatus(who.tenant, id) : cancelVideo(who.tenant, id));
  } catch (e) {
    return sendError(reply, "openai", toMuxError(e));
  }
}

/** POST /v1/depth: one photo, metric depth back (Measure, route `depth`). The photo is never logged. */
async function depth(req: FastifyRequest, reply: FastifyReply) {
  const ctx = begin(req, reply, "measure.depth", "openai", false);
  if (!ctx) return reply;
  const ac = abortOnClose(reply);
  try {
    // A name that is not a depth route or model goes to the route `depth` (router/measure.ts measureName)
    const requested = ((req.query ?? {}) as { model?: string }).model ?? (req.body as { model?: string } | undefined)?.model;
    const res = await runDepth(ctx, measureName(requested, "depth"), Buffer.from(JSON.stringify(req.body ?? {})), ac.signal);
    const out = Buffer.from(await res.arrayBuffer());
    finish(ctx, 200);
    reply.headers(muxHeaders(ctx));
    return reply.type(res.headers.get("content-type") ?? "application/json").send(out);
  } catch (e) {
    const err = toMuxError(e);
    finish(ctx, err.status, { type: err.type, message: err.message });
    reply.headers(muxHeaders(ctx));
    return sendError(reply, "openai", err);
  } finally {
    leave(ctx.tenant);
  }
}

/** POST /v1/convert: a document in, its PDF out (route `convert`, router/convert.ts). The file and the PDF are never logged. */
async function convertDoc(req: FastifyRequest, reply: FastifyReply) {
  const ctx = begin(req, reply, "document.convert", "openai", false);
  if (!ctx) return reply;
  const ac = abortOnClose(reply);
  try {
    const res = await runConvert(ctx, req.body, ac.signal);
    const out = Buffer.from(await res.arrayBuffer());
    finish(ctx, 200);
    reply.headers(muxHeaders(ctx));
    return reply.type(res.headers.get("content-type") ?? "application/json").send(out);
  } catch (e) {
    const err = toMuxError(e);
    finish(ctx, err.status, { type: err.type, message: err.message });
    reply.headers(muxHeaders(ctx));
    return sendError(reply, "openai", err);
  } finally {
    leave(ctx.tenant);
  }
}

/** POST /v1/reconstruct: a job starts where the route's model runs; 202 with mux's id for it. */
async function reconstructCreate(req: FastifyRequest, reply: FastifyReply) {
  const ctx = begin(req, reply, "measure.reconstruct", "openai", false);
  if (!ctx) return reply;
  const ac = abortOnClose(reply);
  try {
    const out = await createReconstruction(ctx, (req.body ?? {}) as Record<string, unknown>, ac.signal);
    finish(ctx, 202);
    reply.headers(muxHeaders(ctx));
    return reply.code(202).send(out);
  } catch (e) {
    const err = toMuxError(e);
    finish(ctx, err.status, { type: err.type, message: err.message });
    reply.headers(muxHeaders(ctx));
    return sendError(reply, "openai", err);
  } finally {
    leave(ctx.tenant);
  }
}

/** Status (with the result once done) and cancel of a reconstruction: the caller's key, only its own jobs; not metered. */
async function reconstructJob(req: FastifyRequest, reply: FastifyReply, what: "status" | "cancel") {
  const who = authenticate(bearer(req));
  if (!who) return sendError(reply, "openai", new MuxError(401, "invalid_api_key", "a mux API key is required (Authorization: Bearer mux-sk-… or x-api-key)"));
  const id = (req.params as { id: string }).id;
  try {
    const signal = abortOnClose(reply).signal;
    return await (what === "status" ? reconstructionStatus(who.tenant, id, signal) : cancelReconstruction(who.tenant, id, signal));
  } catch (e) {
    return sendError(reply, "openai", toMuxError(e));
  }
}

/** POST /v1/backdrops: a job starts where the route's model runs; 202 with mux's id for it. The prompt and image are never logged. */
async function backdropCreate(req: FastifyRequest, reply: FastifyReply) {
  const ctx = begin(req, reply, "backdrop.generate", "openai", false);
  if (!ctx) return reply;
  const ac = abortOnClose(reply);
  try {
    const out = await createBackdrop(ctx, (req.body ?? {}) as Record<string, unknown>, ac.signal);
    finish(ctx, 202);
    reply.headers(muxHeaders(ctx));
    return reply.code(202).send(out);
  } catch (e) {
    const err = toMuxError(e);
    finish(ctx, err.status, { type: err.type, message: err.message });
    reply.headers(muxHeaders(ctx));
    return sendError(reply, "openai", err);
  } finally {
    leave(ctx.tenant);
  }
}

/** Status, files and cancel of a backdrop: the caller's key, only its own jobs; not metered. */
async function backdropJob(req: FastifyRequest, reply: FastifyReply, what: "status" | "cancel" | BackdropFile) {
  const who = authenticate(bearer(req));
  if (!who) return sendError(reply, "openai", new MuxError(401, "invalid_api_key", "a mux API key is required (Authorization: Bearer mux-sk-… or x-api-key)"));
  const id = (req.params as { id: string }).id;
  try {
    const signal = abortOnClose(reply).signal;
    if (what in BACKDROP_FILES) {
      const f = await backdropFile(who.tenant, id, what as BackdropFile, signal);
      return reply.type(f.type).send(f.body);
    }
    return await (what === "status" ? backdropStatus(who.tenant, id, signal) : cancelBackdrop(who.tenant, id, signal));
  } catch (e) {
    return sendError(reply, "openai", toMuxError(e));
  }
}

export function registerGateway(app: FastifyInstance) {
  // Audio uploads are passed on untouched
  app.addContentTypeParser("multipart/form-data", { parseAs: "buffer" }, (_req, body, done) => done(null, body));
  app.post("/v1/audio/transcriptions", (req, reply) => audio(req, reply, "transcription"));
  app.post("/v1/audio/speech", (req, reply) => audio(req, reply, "speech"));
  app.post("/v1/images/generations", (req, reply) => image(req, reply, "generations"));
  app.post("/v1/images/edits", (req, reply) => image(req, reply, "edits"));
  // Video: async jobs; a depth pass comes as base64 in the JSON, so the body may be up to 200 MB
  app.post("/v1/videos/generations", { bodyLimit: 200 * 1024 * 1024 }, videoCreate);
  app.get("/v1/videos/:id", (req, reply) => videoJob(req, reply, "status"));
  app.get("/v1/videos/:id/content", (req, reply) => videoJob(req, reply, "content"));
  app.post("/v1/videos/:id/cancel", (req, reply) => videoJob(req, reply, "cancel"));
  // Measure (Thread's Reference Build): depth from one photo; cameras and points from 2–12, as an async job
  app.post("/v1/depth", { bodyLimit: 50 * 1024 * 1024 }, depth);
  app.post("/v1/reconstruct", { bodyLimit: 150 * 1024 * 1024 }, reconstructCreate);
  app.get("/v1/reconstruct/:id", (req, reply) => reconstructJob(req, reply, "status"));
  app.post("/v1/reconstruct/:id/cancel", (req, reply) => reconstructJob(req, reply, "cancel"));
  // Documents to PDF (bloom for business's Desk): the file as base64, up to 25 MB of it
  app.post("/v1/convert", { bodyLimit: CONVERT_BODY_LIMIT }, convertDoc);
  // Backdrops (Thread's Sets): a panorama, its depth and a dome, as an async job; the files fetched one by one
  app.post("/v1/backdrops", { bodyLimit: 50 * 1024 * 1024 }, backdropCreate);
  app.get("/v1/backdrops/:id", (req, reply) => backdropJob(req, reply, "status"));
  for (const f of Object.keys(BACKDROP_FILES) as BackdropFile[]) app.get(`/v1/backdrops/:id/${f}`, (req, reply) => backdropJob(req, reply, f));
  app.post("/v1/backdrops/:id/cancel", (req, reply) => backdropJob(req, reply, "cancel"));
  app.post("/v1/chat/completions", (req, reply) => chat(req, reply, "openai"));
  app.post("/v1/messages", (req, reply) => chat(req, reply, "anthropic"));
  app.post("/v1/embeddings", (req, reply) => simple(req, reply, "openai.embeddings", (ctx, s) => runEmbeddings(ctx, req.body as never, s)));
  for (const path of ["/v1/rerank", "/v1/reranking", "/rerank"]) app.post(path, (req, reply) => simple(req, reply, "rerank", (ctx, s) => runEmbeddings(ctx, req.body as never, s, "rerank")));
  // Shared services for every product: search the web, read a page as plain text (router/web.ts)
  app.post("/v1/search", (req, reply) => simple(req, reply, "web.search", (ctx, s) => runSearch(ctx, (req.body ?? {}) as never, s)));
  app.post("/v1/read", (req, reply) => simple(req, reply, "web.read", (ctx, s) => runRead(ctx, (req.body ?? {}) as never, s)));
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
