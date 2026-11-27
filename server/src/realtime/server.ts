import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import type { FastifyInstance } from "fastify";
import WebSocket, { WebSocketServer, type RawData } from "ws";
import { config } from "../config.js";
import { db, event, settings } from "../db.js";
import { listProviders, type Provider } from "../providers.js";
import { MuxError, toMuxError } from "../router/errors.js";
import { listModels } from "../models.js";
import { decide } from "../router/select.js";
import { check } from "../router/limits.js";
import { finish, newCtx, type Ctx } from "../router/metering.js";
import { authenticate, type ApiKey, type Tenant } from "../tenants.js";
import { duplexFor, faceFor, hearingFor, routeSpeaker, routeThinker, routeTranscriber, type Caller } from "./adapters.js";
import { PROTOCOL_VERSION, ProtocolError, parseClient, type ServerEvent } from "./protocol.js";
import { Session, type SessionDeps } from "./session.js";
import { voiceClosed, voiceOpened } from "../priority.js";
import { recordRealtimeTurn, type RealtimeMetrics } from "../speed.js";

/**
 * WebSocket /v1/realtime: one socket, one person's voice conversation (docs/realtime.md).
 *
 * Who may: a mux key (Authorization: Bearer, x-api-key, or — for a browser, which cannot set headers on a WebSocket —
 * the subprotocol `mux-key.<key>` next to `mux.realtime.v1`; never in the address, where proxies log it), of a tenant
 * in settings.realtimeTenants, within its limits and budgets. One session per person: a second session.start with the
 * same `user` (or x-mux-user) for the same tenant ends the first. A session holds no slot of the tenant's max_parallel;
 * its inner calls are metered one by one, and the session itself is a row in realtime_sessions (seconds, turns, tokens).
 *
 * On a gateway (Railway) the session runs on the first online mux node (the Mac, over Tailscale Funnel): the gateway
 * opens the same socket there as its own tenant (gateway-railway), passes every frame both ways, and meters each
 * response's tokens (from response.done) and the session's seconds (from session.ended) to the caller's tenant here.
 */

export const REALTIME_PATH = "/v1/realtime";
const PING_MS = 20_000;

type Live = { tenant: Tenant; user: string | null; stop: (reason: string) => void };
const live = new Map<string, Live>();
export const realtimeSessions = () => [...live.entries()].map(([id, l]) => ({ id, tenant: l.tenant.id, user: l.user }));

export function realtimeAllowed(tenant: Tenant): boolean {
  const list = settings().realtimeTenants;
  return Array.isArray(list) && list.includes(tenant.id);
}

/** The caller's key: a header, or the browser's `mux-key.<key>` subprotocol. */
export function keyOf(req: IncomingMessage): string {
  const h = req.headers;
  const auth = typeof h.authorization === "string" ? h.authorization.replace(/^Bearer\s+/i, "") : "";
  if (auth) return auth;
  if (typeof h["x-api-key"] === "string" && h["x-api-key"]) return h["x-api-key"];
  const protos = String(h["sec-websocket-protocol"] ?? "").split(",").map((s) => s.trim());
  const p = protos.find((x) => x.startsWith("mux-key."));
  return p ? p.slice("mux-key.".length) : "";
}

function refuse(socket: Duplex, status: number, type: string, message: string, retryAfter?: number) {
  const body = JSON.stringify({ error: { message, type, code: status } });
  const reason = { 400: "Bad Request", 401: "Unauthorized", 403: "Forbidden", 404: "Not Found", 429: "Too Many Requests", 503: "Service Unavailable" }[status] ?? "Error";
  socket.write(`HTTP/1.1 ${status} ${reason}\r\ncontent-type: application/json\r\ncontent-length: ${Buffer.byteLength(body)}\r\n${retryAfter ? `retry-after: ${retryAfter}\r\n` : ""}connection: close\r\n\r\n${body}`);
  socket.destroy();
}

const putSession = db.prepare(`INSERT OR REPLACE INTO realtime_sessions(id, ts, ended_at, tenant_id, key_id, end_user, engine, llm, hearing, node, seconds, turns, prompt_tokens, completion_tokens, input_ms, output_ms, reason)
  VALUES(@id, @ts, @ended_at, @tenant_id, @key_id, @end_user, @engine, @llm, @hearing, @node, @seconds, @turns, @prompt_tokens, @completion_tokens, @input_ms, @output_ms, @reason)`);

interface Record_ { id: string; ts: number; engine: string | null; llm: string | null; hearing: string | null; node: string | null; seconds: number; turns: number; prompt_tokens: number; completion_tokens: number; input_ms: number; output_ms: number; reason: string }
function record(ctx: Ctx, r: Record_, status: number) {
  try {
    putSession.run({ ...r, ended_at: Date.now(), tenant_id: ctx.tenant.id, key_id: ctx.key.id, end_user: ctx.endUser ?? null });
  } catch (e) { console.error("realtime:", (e as Error).message); }
  ctx.requested = r.engine ?? undefined;
  ctx.route = "realtime";
  ctx.reason = `voice session ${r.id}: ${r.seconds} s, ${r.turns} turns, ${r.engine}${r.llm ? ` with ${r.llm}` : ""}${r.node ? ` on ${r.node}` : ""}; ${r.reason}`;
  ctx.bodyReq = null; ctx.bodyRes = null;
  finish(ctx, status);
}

export interface RealtimeOptions {
  /** Stages for the tests; the real ones (adapters.ts) otherwise. */
  deps?: (caller: Caller) => Omit<SessionDeps, "send" | "close">;
  /** Relay sessions to a node, as a gateway does (the tests run a gateway and a node in one process). */
  relayTo?: () => Provider | null;
}

export function registerRealtime(app: FastifyInstance, opts: RealtimeOptions = {}) {
  const wss = new WebSocketServer({
    noServer: true, maxPayload: 4 * 1024 * 1024,
    // A browser offers mux.realtime.v1 with its key protocol; the answer names mux.realtime.v1, never the key.
    handleProtocols: (protocols) => (protocols.has(PROTOCOL_VERSION) ? PROTOCOL_VERSION : false),
  });
  // mux stopping (or a test's server closing) ends its sessions rather than waiting for them
  app.addHook("onClose", async () => {
    for (const ws of wss.clients) ws.close(1001, "mux is stopping");
    await new Promise((r) => setTimeout(r, 50));
    for (const ws of wss.clients) ws.terminate();
  });
  app.server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const path = (req.url ?? "").split("?")[0];
    if (path !== REALTIME_PATH) {
      // Another WebSocket on this server is its own listener's; with none, the upgrade is refused rather than left hanging
      if (app.server.listenerCount("upgrade") > 1) return;
      return refuse(socket, 404, "not_found", `no WebSocket at ${path}; the voice session is ${REALTIME_PATH}`);
    }
    const who = authenticate(keyOf(req));
    if (!who) return refuse(socket, 401, "invalid_api_key", "a mux API key is required (Authorization: Bearer mux-sk-…, x-api-key, or the subprotocol mux-key.<key>)");
    if (!realtimeAllowed(who.tenant)) return refuse(socket, 403, "permission_denied", `${who.tenant.name} may not open voice sessions (settings.realtimeTenants)`);
    try { check(who.tenant, who.key); } catch (e) { const err = toMuxError(e); return refuse(socket, err.status, err.type, err.message, err.retryAfterS); }
    if (live.size >= settings().realtimeMaxSessions) return refuse(socket, 503, "realtime_busy", `this mux holds ${live.size} voice sessions, its most (settings.realtimeMaxSessions); try again shortly`, 5);
    wss.handleUpgrade(req, socket, head, (ws) => {
      try { connected(ws, req, who.tenant, who.key, opts); } catch (e) { event("error", "realtime", (e as Error).message); ws.close(1011, "internal error"); }
    });
  });
}

function header(req: IncomingMessage, name: string): string | null {
  const v = req.headers[name];
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

/** Keep the socket alive through the proxies on the way (Railway, Tailscale Funnel) and notice a dead peer. */
function keepAlive(ws: WebSocket, onDead: () => void) {
  let alive = true;
  ws.on("pong", () => { alive = true; });
  const t = setInterval(() => {
    if (!alive) { clearInterval(t); onDead(); ws.terminate(); return; }
    alive = false;
    try { ws.ping(); } catch { /* closing */ }
  }, PING_MS);
  t.unref();
  ws.on("close", () => clearInterval(t));
}

function connected(ws: WebSocket, req: IncomingMessage, tenant: Tenant, key: ApiKey, opts: RealtimeOptions) {
  const ctx = newCtx(tenant, key, "realtime.session", req.socket.remoteAddress ?? "", header(req, "user-agent") ?? "", ["realtime"]);
  ctx.bodyReq = null;
  ctx.endUser = header(req, "x-mux-user");
  ctx.traceId = header(req, "x-mux-trace-id");
  if (opts.relayTo) return relay(ws, ctx, opts.relayTo());
  if (config.role === "gateway" && !opts.deps) return relay(ws, ctx, realtimeNode());

  const caller: Caller = { tenant, key, ip: ctx.ip, userAgent: ctx.userAgent, user: ctx.endUser ?? null, sessionId: "" };
  let sessionRef: Session | null = null;
  const send = (e: ServerEvent) => {
    // Each voice turn's own marks are a row of turn stats (speed.ts), beside its inner LLM call's
    if (e.type === "metrics" && sessionRef) recordRealtimeTurn({ tenant: tenant.id, user: caller.user, session: sessionRef.id, llm: sessionRef.llm ?? null, via: "node", metrics: e as unknown as RealtimeMetrics });
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(e));
  };
  let closedBy = "";
  const s: Session = new Session({
    ...(opts.deps ? opts.deps(caller) : {
      thinker: routeThinker(caller), speaker: routeSpeaker(caller), transcriber: routeTranscriber(caller),
      hearing: hearingFor(settings().realtimeHearUrl || null), duplex: duplexFor(caller), face: faceFor(caller),
      defaultLlm: tenant.default_route || undefined,
    }),
    defaultVoice: settings().realtimeVoice,
    send,
    close: (reason) => { closedBy = reason; if (ws.readyState === WebSocket.OPEN) ws.close(1000, reason.slice(0, 120)); },
  });
  caller.sessionId = s.id;
  sessionRef = s;
  voiceOpened();
  let user: string | null = ctx.endUser ?? null;
  const limit = setTimeout(() => s.stop("time limit"), settings().realtimeMaxMinutes * 60_000);
  limit.unref();
  keepAlive(ws, () => s.stop("the caller stopped answering"));

  let ready: Promise<void> = Promise.resolve();
  const fail = (e: unknown) => {
    if (e instanceof ProtocolError) send({ type: "error", code: e.code, message: e.message });
    else { const err = toMuxError(e); send({ type: "error", code: err.type, message: err.message }); }
  };
  ws.on("message", (data: RawData, binary: boolean) => {
    if (binary) {
      const buf = Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data as Buffer);
      ready = ready.then(() => s.audio(buf)).catch(fail);
      return;
    }
    let e;
    try { e = parseClient(String(data)); } catch (err) { fail(err); return; }
    if (e.type === "session.start") {
      user = (e.user ?? user)?.trim() || null;
      ctx.endUser = user;
      caller.user = user;
      // One voice session per person: the newer one wins (a reconnect after a dropped network replaces the old)
      if (user) for (const [id, l] of live) if (id !== s.id && l.tenant.id === tenant.id && l.user === user) l.stop("replaced by a newer session of the same person");
      live.set(s.id, { tenant, user, stop: (r) => s.stop(r) });
      ready = ready.then(() => s.handle(e)).catch(fail);
      return;
    }
    // Events after session.start wait for it (the hearing and the engine are ready), never for a running response
    ready = ready.then(() => s.handle(e)).catch(fail);
  });
  ws.on("close", () => {
    clearTimeout(limit);
    voiceClosed();
    s.stop(closedBy || "the caller closed the socket");
    live.delete(s.id);
    record(ctx, {
      id: s.id, ts: Date.now() - Math.round(performance.now() - s.t0), engine: s.started ? s.engine : null, llm: s.llm ?? null, hearing: s.hearingName || null, node: null,
      seconds: Math.round((performance.now() - s.t0) / 100) / 10, turns: s.turns, prompt_tokens: s.usage.prompt_tokens, completion_tokens: s.usage.completion_tokens,
      input_ms: Math.round(s.inputMs), output_ms: Math.round(s.outputMs), reason: closedBy || "the caller closed the socket",
    }, 200);
  });
}

/**
 * On a gateway: the cascade's LLM for a session.start, as this gateway would route a chat call of the tenant (`llm`,
 * else a `model` that is not a duplex engine, else the tenant's default route), narrowed to the models on the node
 * that runs the session; returns that model's own name on the node. Undefined for a duplex engine.
 */
export function gatewayLlm(tenant: Tenant, e: { model?: string; llm?: string }, node: Provider): string | undefined {
  const model = (e.model ?? "").trim();
  const duplex = !!model && (model === "realtime" || listModels().some((m) => m.kind === "realtime" && (m.id === model || m.upstream_model === model)));
  if (duplex && !e.llm) return undefined;
  const name = e.llm?.trim() || (model && model !== "cascade" && !duplex ? model : "") || tenant.default_route || "auto";
  const d = decide(tenant, name, "chat", null);
  const here = d.candidates.find((m) => m.backend === "node" && m.provider_id === node.id && m.upstream_model);
  if (!here) throw new MuxError(503, "llm_unavailable", `${name}: none of its models is on ${node.name}, where voice sessions run (${d.candidates.map((m) => m.id).join(", ") || "no candidates"})`);
  return here.upstream_model!;
}

/** The node a gateway sends voice sessions to: the first online mux node it holds a key for. */
export function realtimeNode(): Provider | null {
  return listProviders().find((p) => p.kind === "mux" && p.enabled && p.status === "online" && !!p.api_key) ?? null;
}

/** The node's WebSocket address for /v1/realtime: https://host/mux → wss://host/mux/v1/realtime. */
export const nodeSocketUrl = (base: string) => `${base.replace(/\/$/, "").replace(/^http/, "ws")}${REALTIME_PATH}`;

/** On a gateway: the session runs on the node; every frame passes through, and the tokens and seconds are metered here. */
function relay(ws: WebSocket, ctx: Ctx, node: Provider | null) {
  const id = `rt_gw_${ctx.id.slice(4)}`;
  if (!node) {
    ws.send(JSON.stringify({ type: "error", code: "realtime_unavailable", message: "no mux node is online for this gateway's voice sessions" }));
    ws.close(1013, "no node online");
    record(ctx, { id, ts: Date.now(), engine: null, llm: null, hearing: null, node: null, seconds: 0, turns: 0, prompt_tokens: 0, completion_tokens: 0, input_ms: 0, output_ms: 0, reason: "no node online" }, 503);
    return;
  }
  const t0 = performance.now();
  const up = new WebSocket(nodeSocketUrl(node.base_url), PROTOCOL_VERSION, {
    headers: {
      authorization: `Bearer ${node.api_key}`,
      ...(ctx.endUser ? { "x-mux-user": `${ctx.tenant.id}:${ctx.endUser}` } : {}),
      ...(ctx.traceId ? { "x-mux-trace-id": ctx.traceId } : {}),
    },
    handshakeTimeout: 15_000, perMessageDeflate: false,
  });
  const queue: { data: RawData | string; binary: boolean }[] = [];
  let engine: string | null = null, llm: string | null = null, hearing: string | null = null, turns = 0, inMs = 0, outMs = 0, reason = "";
  let usage = { prompt_tokens: 0, completion_tokens: 0 };
  let user = ctx.endUser ?? null;
  const live_: Live = { tenant: ctx.tenant, user, stop: (r) => { reason = r; ws.close(1000, r.slice(0, 120)); } };
  live.set(id, live_);
  const toUp = (data: RawData | string, binary: boolean) => { if (up.readyState === WebSocket.OPEN) up.send(data as Buffer, { binary }); else queue.push({ data, binary }); };
  up.on("open", () => { for (const q of queue.splice(0)) up.send(q.data as Buffer, { binary: q.binary }); });
  up.on("unexpected-response", (_r, res) => {
    let body = "";
    res.on("data", (d) => { body += d; });
    res.on("end", () => {
      let msg = body.slice(0, 300);
      try { msg = JSON.parse(body).error?.message ?? msg; } catch { /* plain */ }
      reason = `${node.name} refused the session (${res.statusCode}): ${msg}`;
      if (ws.readyState === WebSocket.OPEN) { ws.send(JSON.stringify({ type: "error", code: res.statusCode === 401 || res.statusCode === 403 ? "realtime_unavailable" : "upstream_error", message: reason })); ws.close(1011, "node refused"); }
    });
  });
  up.on("error", (e) => {
    reason ||= `${node.name} could not be reached: ${e.message}`;
    if (ws.readyState === WebSocket.OPEN) { ws.send(JSON.stringify({ type: "error", code: "upstream_error", message: reason })); ws.close(1011, "node unreachable"); }
  });
  up.on("message", (data, binary) => {
    if (!binary) {
      // Read what is metered; everything is passed on as it came
      try {
        const e = JSON.parse(String(data)) as { type?: string; usage?: { prompt_tokens?: number; completion_tokens?: number }; engine?: string; llm?: string; hearing?: string; turns?: number; input_ms?: number; output_ms?: number; reason?: string };
        if (e.type === "session.created") { engine = e.engine ?? null; llm = e.llm ?? null; hearing = e.hearing ?? null; }
        else if (e.type === "response.done" && e.usage) {
          const t = newCtx(ctx.tenant, ctx.key, "realtime.turn", ctx.ip, ctx.userAgent, ["realtime"]);
          t.traceId = id; t.endUser = ctx.endUser; t.route = "realtime"; t.requested = llm ?? engine ?? undefined; t.bodyReq = null;
          t.promptTokens = e.usage.prompt_tokens ?? 0; t.completionTokens = e.usage.completion_tokens ?? 0;
          usage = { prompt_tokens: usage.prompt_tokens + t.promptTokens, completion_tokens: usage.completion_tokens + t.completionTokens };
          finish(t, 200);
        } else if (e.type === "metrics") {
          recordRealtimeTurn({ tenant: ctx.tenant.id, user: ctx.endUser ?? null, session: id, llm: llm ?? engine, via: "gateway", metrics: e as unknown as RealtimeMetrics });
        } else if (e.type === "session.ended") { turns = e.turns ?? turns; inMs = e.input_ms ?? 0; outMs = e.output_ms ?? 0; reason ||= e.reason ?? ""; }
      } catch { /* not ours to judge */ }
    }
    if (ws.readyState === WebSocket.OPEN) ws.send(data as Buffer, { binary });
  });
  up.on("close", (code, why) => { reason ||= String(why) || `the node closed (${code})`; if (ws.readyState === WebSocket.OPEN) ws.close(code === 1005 || code === 1006 ? 1011 : code, String(why).slice(0, 120)); });
  ws.on("message", (data, binary) => {
    if (!binary) {
      try {
        const e = JSON.parse(String(data)) as { type?: string; user?: string; model?: string; llm?: string };
        if (e.type === "session.start") {
          user = e.user?.trim() || user;
          ctx.endUser = user;
          live_.user = user;
          if (user) for (const [other, l] of live) if (other !== id && l.tenant.id === ctx.tenant.id && l.user === user) l.stop("replaced by a newer session of the same person");
          // Bloom's LLM is chosen here, by this gateway's routes, aliases and allowed list for bloom's tenant, and named
          // to the node as the node's own model: the node would otherwise resolve "agent" by its own routes, as the
          // gateway's tenant there, and a voice answer would come from another model than a typed one
          let llm: string | undefined;
          try { llm = gatewayLlm(ctx.tenant, e, node); } catch (err) {
            const m = toMuxError(err);
            reason = m.message;
            ws.send(JSON.stringify({ type: "error", code: m.type, message: m.message }));
            ws.close(1008, "LLM not available");
            return;
          }
          // The node sees every gateway session as one tenant: the person is named per tenant there
          toUp(JSON.stringify({ ...e, ...(llm ? { llm } : {}), ...(user ? { user: `${ctx.tenant.id}:${user}` } : {}) }), false);
          return;
        }
      } catch { /* the node says what is wrong */ }
    }
    toUp(data, binary);
  });
  keepAlive(ws, () => { reason ||= "the caller stopped answering"; up.terminate(); });
  ws.on("close", () => {
    live.delete(id);
    if (up.readyState === WebSocket.OPEN || up.readyState === WebSocket.CONNECTING) up.close(1000, "the caller closed");
    record(ctx, {
      id, ts: Date.now() - Math.round(performance.now() - t0), engine, llm, hearing, node: node.name, seconds: Math.round((performance.now() - t0) / 100) / 10, turns,
      prompt_tokens: usage.prompt_tokens, completion_tokens: usage.completion_tokens, input_ms: inMs, output_ms: outMs, reason: reason || "the caller closed the socket",
    }, 200);
  });
}
