import { acquire, release } from "../runtime/manager.js";
import { MuxError } from "./errors.js";
import { recordFailure, recordSuccess } from "./health.js";
import type { Ctx } from "./metering.js";
import { decide } from "./select.js";

/**
 * Speech in and out, OpenAI's audio API: /v1/audio/transcriptions (multipart, passed through as it came) and
 * /v1/audio/speech (JSON → audio). The models are OpenAI-compatible servers on a machine — whisper.cpp's
 * whisper-server and server/tts/piper_server.py — or another mux, which gets the model it is to use as ?model=.
 * Like chat, a failure before anything is answered falls through to the next model on the route.
 */
export type AudioKind = "transcription" | "speech";

export async function runAudio(ctx: Ctx, kind: AudioKind, requested: string | undefined, body: Buffer, contentType: string, signal: AbortSignal): Promise<Response> {
  const d = decide(ctx.tenant, requested, kind, null);
  ctx.route = d.route?.name ?? null;
  ctx.reason = d.reason;
  ctx.requested = requested;
  const path = kind === "transcription" ? "audio/transcriptions" : "audio/speech";
  let last = "";
  for (const [i, m] of (ctx.noFallback ? d.candidates.slice(0, 1) : d.candidates).entries()) {
    if (i > 0) ctx.fallbacks = i;
    let up;
    try { up = await acquire(m); } catch (e) { recordFailure(m.id); last = `${m.id}: ${(e as Error).message}`; continue; }
    ctx.modelId = m.id;
    const tu = performance.now();
    try {
      const payload = kind === "speech" ? Buffer.from(JSON.stringify({ ...JSON.parse(body.toString("utf8") || "{}"), model: up.model })) : body;
      const res = await fetch(`${up.baseUrl}/${path}?model=${encodeURIComponent(up.model)}`, {
        method: "POST", headers: { ...up.headers, "content-type": contentType }, body: new Uint8Array(payload), signal,
      });
      ctx.upstreamMs = (ctx.upstreamMs ?? 0) + (performance.now() - tu);
      if (res.ok) { recordSuccess(m.id, null, null); return res; }
      const text = (await res.text()).slice(0, 500);
      // The request itself is wrong: another model would say the same
      if (res.status < 500 && res.status !== 429) throw new MuxError(res.status, "upstream_error", text);
      recordFailure(m.id);
      last = `${m.id}: HTTP ${res.status} ${text.slice(0, 200)}`;
    } catch (e) {
      if (e instanceof MuxError || signal.aborted) throw e;
      recordFailure(m.id);
      last = `${m.id}: ${(e as Error).message}`;
    } finally {
      release(m.id);
    }
  }
  throw new MuxError(503, "all_models_failed", last || `no ${kind} model could take the request`);
}
