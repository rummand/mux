import WebSocket from "ws";
import { event } from "../db.js";
import { getModel, getRoute } from "../models.js";
import { acquire, release } from "../runtime/manager.js";
import { runAudio } from "../router/audio.js";
import { runChat, type ChatBody } from "../router/chat.js";
import { MuxError, toMuxError } from "../router/errors.js";
import { check } from "../router/limits.js";
import { finish, newCtx, type Ctx } from "../router/metering.js";
import { decide } from "../router/select.js";
import { INPUT_RATE, parseWav, resample, wavOf } from "./audio.js";
import type { SessionStart } from "./protocol.js";
import type { DuplexEngine, DuplexEvent, DuplexFactory, Speaker, Thinker, ToolCall, Transcriber } from "./stages.js";
import { EnergyVad, type HearEvent, type Hearing, type HearingFactory } from "./vad.js";

/**
 * The real stages of a session on the machine that has the models (the Mac): every model call goes through mux's own
 * routes as the session's tenant — chat for the LLM, `transcribe` for words, `speak` for the voice — so each is routed,
 * limited and metered like any call (endpoints realtime.chat, realtime.transcription, realtime.speech), and none of
 * them keeps a body: what Bloom says and what the caller said live only in the session.
 */

/** The caller of a session, as each inner call is recorded: its tenant and key, and the person (end user). */
export type Caller = Pick<Ctx, "tenant" | "key" | "ip" | "userAgent"> & { user: string | null; sessionId: string };

function innerCtx(c: Caller, endpoint: string): Ctx {
  // The tenant's budgets and tokens a minute hold inside a session too; its requests a minute do not (one spoken answer
  // is a transcription, an LLM call and a speech call per sentence: the session was counted when it opened)
  check({ ...c.tenant, rpm_limit: 0 }, { ...c.key, rpm_limit: 0 });
  // What a person says stays on our machines: no cloud model and no free tier answers an inner call, whatever the
  // tenant's own border ("servers" stays as strict as it is)
  const tenant = { ...c.tenant, data_border: c.tenant.data_border === "servers" ? "servers" as const : "own" as const };
  const ctx = newCtx(tenant, c.key, endpoint, c.ip, c.userAgent, ["realtime"]);
  ctx.traceId = c.sessionId;
  ctx.affinity = c.sessionId; // one session's turns stay on one model (its prompt cache stays warm)
  ctx.endUser = c.user;
  ctx.bodyReq = null;
  return ctx;
}
const done = (ctx: Ctx, status: number, err?: MuxError) => { ctx.bodyReq = null; ctx.bodyRes = null; finish(ctx, status, err && { type: err.type, message: err.message }); };

async function metered<T>(c: Caller, endpoint: string, run: (ctx: Ctx) => Promise<T>): Promise<T> {
  const ctx = innerCtx(c, endpoint);
  try {
    const out = await run(ctx);
    done(ctx, 200);
    return out;
  } catch (e) {
    const err = toMuxError(e);
    done(ctx, err.status, err);
    throw err;
  }
}

/** The LLM through mux's chat route, streamed; tool calls gathered from their fragments, by index. */
/** Streamed tool calls: a call's id and name come once, its arguments in fragments, each fragment with its call's index. */
export function gatherCalls(prefix: string) {
  const calls = new Map<number, ToolCall>();
  return {
    add(fragments: { index?: number; id?: string; function?: { name?: string; arguments?: string } }[] | undefined) {
      for (const t of fragments ?? []) {
        const i = t.index ?? 0;
        const cur = calls.get(i) ?? { id: "", name: "", arguments: "" };
        if (t.id) cur.id = t.id;
        if (t.function?.name) cur.name += t.function.name;
        if (t.function?.arguments) cur.arguments += t.function.arguments;
        calls.set(i, cur);
      }
    },
    list: (): ToolCall[] => [...calls.entries()].sort((a, b) => a[0] - b[0]).map(([i, t]) => ({ ...t, id: t.id || `call_${prefix}_${i}`, arguments: t.arguments || "{}" })),
  };
}

export function routeThinker(c: Caller): Thinker {
  return {
    stream: (req, signal, onText) => metered(c, "realtime.chat", async (ctx) => {
      const calls = gatherCalls(c.sessionId);
      let text = "";
      const body: ChatBody = { model: req.model, messages: req.messages, stream: true, ...(req.tools ? { tools: req.tools as never, tool_choice: req.tool_choice } : {}) };
      await runChat(ctx, body, signal, (chunk) => {
        const delta = chunk.choices?.[0]?.delta as { content?: unknown; tool_calls?: { index?: number; id?: string; function?: { name?: string; arguments?: string } }[] } | undefined;
        if (typeof delta?.content === "string" && delta.content) { text += delta.content; onText(delta.content); }
        calls.add(delta?.tool_calls);
      });
      const toolCalls = calls.list();
      return { text, toolCalls, usage: { prompt_tokens: ctx.promptTokens ?? 0, completion_tokens: ctx.completionTokens ?? 0 }, coldStart: !!ctx.coldStart, model: ctx.modelId };
    }),
  };
}

/** Speech through mux's speak route (Kokoro af_heart for English), one sentence per call, as WAV. */
export function routeSpeaker(c: Caller): Speaker {
  return {
    speak: (text, voice, signal) => metered(c, "realtime.speech", async (ctx) => {
      const body = Buffer.from(JSON.stringify({ model: "speak", input: text, voice, response_format: "wav" }));
      const res = await runAudio(ctx, "speech", "speak", body, "application/json", signal);
      const buf = Buffer.from(await res.arrayBuffer());
      const { pcm, rate } = parseWav(buf);
      return { pcm, rate, coldStart: !!ctx.coldStart };
    }),
  };
}

/** Words for one turn through mux's transcribe route (whisper large-v3-turbo), English. */
export function routeTranscriber(c: Caller): Transcriber {
  return {
    transcribe: (pcm, signal) => metered(c, "realtime.transcription", async (ctx) => {
      const b = `----muxrt${Math.random().toString(16).slice(2)}`;
      const field = (name: string, value: string) => Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`);
      const body = Buffer.concat([
        field("model", "transcribe"), field("language", "en"), field("response_format", "json"),
        Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="file"; filename="turn.wav"\r\nContent-Type: audio/wav\r\n\r\n`),
        wavOf(pcm, INPUT_RATE), Buffer.from(`\r\n--${b}--\r\n`),
      ]);
      const res = await runAudio(ctx, "transcription", "transcribe", body, `multipart/form-data; boundary=${b}`, signal);
      const raw = await res.text();
      try { return String((JSON.parse(raw) as { text?: unknown }).text ?? ""); } catch { return raw; }
    }),
  };
}

/**
 * The hear sidecar (server/realtime/hear_server.py, launchd com.mux.hear, ws://127.0.0.1:8326/hear): Silero VAD,
 * Smart Turn v3 and parakeet-mlx's streaming transcription on the Mac, one connection per session. `auto` uses it when
 * it answers within 800 ms and falls back to the energy VAD (and whisper on the transcribe route) when it does not.
 */
export function hearingFor(url: string | null): (want: SessionStart["hearing"], opts: { turnMs?: number }) => HearingFactory {
  return (want, opts) => async (emit) => {
    if (want === "energy" || !url) {
      if (want === "sidecar") throw new MuxError(503, "hearing_unavailable", "the hear sidecar is not configured (settings.realtimeHearUrl)");
      return new EnergyVad(emit, { turnMs: opts.turnMs });
    }
    try {
      return await connectHear(url, emit, opts.turnMs);
    } catch (e) {
      if (want === "sidecar") throw new MuxError(503, "hearing_unavailable", `the hear sidecar did not answer: ${(e as Error).message}`);
      return new EnergyVad(emit, { turnMs: opts.turnMs });
    }
  };
}

function connectHear(url: string, emit: (e: HearEvent) => void, turnMs?: number): Promise<Hearing> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const timer = setTimeout(() => { ws.terminate(); reject(new Error("timed out")); }, 800);
    ws.once("error", (e) => { clearTimeout(timer); reject(e); });
    ws.once("open", () => {
      ws.send(JSON.stringify({ type: "start", sample_rate: INPUT_RATE, language: "en", ...(turnMs ? { turn_silence_ms: turnMs } : {}) }));
    });
    let ready = false;
    ws.on("message", (data, binary) => {
      if (binary) return;
      let m: { type?: string; at_ms?: number; text?: string; confidence?: number; name?: string; message?: string };
      try { m = JSON.parse(String(data)); } catch { return; }
      if (m.type === "ready" && !ready) {
        ready = true;
        clearTimeout(timer);
        resolve({
          transcribes: true, name: m.name ?? "silero+smart-turn+parakeet",
          push: (pcm) => { if (ws.readyState === WebSocket.OPEN) ws.send(pcm); },
          close: () => { try { ws.close(); } catch { /* gone */ } },
        });
        return;
      }
      const at = Number(m.at_ms ?? 0);
      if (m.type === "vad.start") emit({ type: "speech_start", atMs: at });
      else if (m.type === "vad.end") emit({ type: "speech_end", atMs: at });
      else if (m.type === "turn.end") emit({ type: "turn_end", atMs: at, confidence: Number(m.confidence ?? 0.5) });
      else if (m.type === "partial") emit({ type: "partial", text: String(m.text ?? "") });
      else if (m.type === "final") emit({ type: "final", text: String(m.text ?? "") });
      else if (m.type === "error") event("warn", "realtime", `hear sidecar: ${m.message ?? "error"}`);
    });
  });
}

/** Whether a name is a duplex engine on this mux: a model or route of kind realtime. */
export function isDuplexName(name: string): boolean {
  const n = name.replace(/^mux\//, "");
  return getRoute(n)?.kind === "realtime" || getModel(n)?.kind === "realtime";
}

/**
 * A duplex engine (Haru-4B, MiniCPM-o 4.5): a model of kind realtime whose base_url is its wrapper on this Mac
 * (server/realtime/haru_server.py on :8321, minicpm_o_server.py on :8322). `acquire` admits it like any local service:
 * presence, and the memory floor (the wrapper's GET /models says what it needs free to load). The wrapper speaks
 * mux's engine protocol on /duplex (docs/realtime.md, "Duplex engines").
 */
export function duplexFor(c: Caller): (model: string) => DuplexFactory | null {
  return (model) => {
    if (!isDuplexName(model)) return null;
    return async (opts, onEvent, signal) => {
      const d = decide(c.tenant, model, "realtime", null);
      let last = "";
      for (const m of d.candidates) {
        let up;
        try { up = await acquire(m); } catch (e) { last = `${m.id}: ${(e as Error).message}`; continue; }
        try {
          return await connectDuplex(m.id, up.baseUrl, opts, onEvent, signal, () => release(m.id));
        } catch (e) {
          release(m.id);
          last = `${m.id}: ${(e as Error).message}`;
        }
      }
      throw new MuxError(503, "engine_unavailable", last || `no realtime model could take ${model}`);
    };
  };
}

function connectDuplex(name: string, base: string, opts: { instructions: string; voice?: string }, onEvent: (e: DuplexEvent) => void, signal: AbortSignal, onClose: () => void): Promise<DuplexEngine> {
  const url = `${base.replace(/^http/, "ws").replace(/\/v1$/, "").replace(/\/$/, "")}/duplex`;
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    let rate = 24_000;
    let canSpeak = false;
    let ready = false;
    let closed = false;
    const close = () => { if (closed) return; closed = true; try { ws.close(); } catch { /* gone */ } onClose(); };
    // Loading a duplex model takes a while on the first session (Haru: ~10 GB from disk)
    const timer = setTimeout(() => { ws.terminate(); reject(new Error("the engine did not get ready within 180 s")); }, 180_000);
    signal.addEventListener("abort", () => { clearTimeout(timer); close(); }, { once: true });
    ws.once("error", (e) => { clearTimeout(timer); if (!ready) reject(e); });
    ws.once("open", () => ws.send(JSON.stringify({ type: "start", instructions: opts.instructions, voice: opts.voice ?? null, input_sample_rate: INPUT_RATE })));
    ws.on("close", (_code, why) => { if (ready && !closed) onEvent({ type: "closed", reason: String(why) || "the engine went away" }); closed = true; onClose(); });
    ws.on("message", (data, binary) => {
      if (binary) { onEvent({ type: "audio", pcm: Buffer.from(data as Buffer), rate }); return; }
      let m: { type?: string; sample_rate?: number; text?: string; message?: string; can_speak?: boolean };
      try { m = JSON.parse(String(data)); } catch { return; }
      if (m.type === "ready") {
        if (m.sample_rate) rate = m.sample_rate;
        canSpeak = !!m.can_speak;
        ready = true;
        clearTimeout(timer);
        resolve({
          name, rate, canSpeak,
          push: (pcm) => { if (ws.readyState === WebSocket.OPEN) ws.send(pcm); },
          speak: (text) => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "speak", text })); },
          close: () => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "end" })); close(); },
        });
      } else if (m.type === "text" && m.text) onEvent({ type: "text", text: m.text });
      else if (m.type === "error") { if (!ready) { clearTimeout(timer); reject(new Error(m.message ?? "engine error")); } else onEvent({ type: "error", message: m.message ?? "engine error" }); }
    });
  });
}

/** For tests and the measurement script: 16 kHz pcm16 from any WAV. */
export function wavTo16k(buf: Buffer): Buffer {
  const { pcm, rate } = parseWav(buf);
  return resample(pcm, rate, INPUT_RATE);
}
