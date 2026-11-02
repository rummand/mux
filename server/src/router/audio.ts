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

/**
 * A plain field of a multipart form, read from the raw body without parsing the file: OpenAI's clients name the
 * transcription model there (`model=whisper-1`), not in the address. Only the first 64 KB are looked at, where the
 * fields before the file are; undefined when it is not there.
 */
export function formField(body: Buffer, contentType: string, name: string): string | undefined {
  const boundary = /boundary=(?:"([^"]+)"|([^;\s]+))/i.exec(contentType);
  if (!boundary) return undefined;
  const sep = `--${boundary[1] ?? boundary[2]}`;
  for (const part of body.subarray(0, 65536).toString("latin1").split(sep)) {
    const end = part.indexOf("\r\n\r\n");
    if (end < 0) continue;
    const head = part.slice(0, end);
    if (!new RegExp(`content-disposition:[^\\r\\n]*\\bname="${name}"`, "i").test(head) || /filename=/i.test(head)) continue;
    return Buffer.from(part.slice(end + 4).replace(/\r\n$/, ""), "latin1").toString("utf8").trim() || undefined;
  }
  return undefined;
}

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
