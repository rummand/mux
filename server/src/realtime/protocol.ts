/**
 * The /v1/realtime protocol (mux.realtime.v1): one WebSocket is one person's voice conversation. Every message is a
 * JSON object with a `type`, except the caller's microphone, which may also come as binary frames of raw pcm16 at
 * 16 kHz mono (the same bytes `input.audio` carries as base64). The whole message list, with examples, is in
 * docs/realtime.md; the names are the ones bloom for business codes against, so they change only with a new version.
 */
import type { ChatTool, Message } from "./stages.js";

export const PROTOCOL_VERSION = "mux.realtime.v1";

export interface SessionStart {
  type: "session.start";
  /** The engine: "cascade" (VAD → STT → LLM → TTS, the default), "haru-4b" or "minicpm-o-4.5" (duplex trials), or any
   *  model or route of kind realtime. Anything else names the LLM of a cascade (same as `llm`). */
  model?: string;
  /** The cascade's LLM: a mux chat route or model ("agent", "qwen3.6-35b-a3b"); default the tenant's default route. */
  llm?: string;
  /** The voice: "af_heart" (Kokoro, English) by default. A duplex engine takes a path to a clip on the Mac, or none. */
  voice?: string;
  /** The system prompt, as Bloom writes it. */
  instructions?: string;
  /** OpenAI chat tools, passed through to the LLM; calls come back to the caller as tool.call. */
  tools?: ChatTool[];
  tool_choice?: unknown;
  /** The conversation so far (OpenAI chat messages, without the system prompt): a spoken turn continues it. */
  messages?: Message[];
  /** false: after transcript.final mux waits for response.create (Bloom sends the conversation itself). Default true. */
  auto_response?: boolean;
  /** false: the caller's speech does not interrupt Bloom's. Default true. */
  barge_in?: boolean;
  /** The person this session is for: one voice session per person (a second one ends the first). */
  user?: string;
  /** Only "pcm16" (16-bit little-endian mono at 16 kHz). */
  input_audio_format?: string;
  /** The silence that ends a turn when no turn model is running (ms, 300–3000; default 700). */
  turn_silence_ms?: number;
  /** "auto" (default): the hear sidecar when it answers, else the energy VAD. "energy": always the energy VAD. */
  hearing?: "auto" | "energy" | "sidecar";
}

export type ClientEvent =
  | SessionStart
  | { type: "input.audio"; audio: string }
  | { type: "input.text"; text: string }
  | { type: "response.create"; messages?: Message[]; instructions?: string; say?: string }
  | { type: "response.cancel" }
  | { type: "tool.result"; call_id: string; output: unknown }
  | { type: "session.update"; instructions?: string; tools?: ChatTool[]; tool_choice?: unknown; messages?: Message[]; voice?: string; auto_response?: boolean; barge_in?: boolean }
  | { type: "session.end" };

export type ServerEvent = { type: string; [k: string]: unknown };

export class ProtocolError extends Error {
  constructor(public code: string, message: string) { super(message); }
}

const TYPES = new Set(["session.start", "input.audio", "input.text", "response.create", "response.cancel", "tool.result", "session.update", "session.end"]);
const isStr = (v: unknown): v is string => typeof v === "string";

/** One text frame from the caller, checked; ProtocolError says what is wrong in the caller's terms. */
export function parseClient(raw: string): ClientEvent {
  let v: unknown;
  try { v = JSON.parse(raw); } catch { throw new ProtocolError("invalid_json", "a text frame must be one JSON object"); }
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new ProtocolError("invalid_event", "a text frame must be one JSON object");
  const e = v as Record<string, unknown>;
  if (!isStr(e.type) || !TYPES.has(e.type)) throw new ProtocolError("unknown_event", `unknown event type ${JSON.stringify(e.type)}; see docs/realtime.md`);
  switch (e.type) {
    case "input.audio": if (!isStr(e.audio)) throw new ProtocolError("invalid_event", "input.audio needs audio (base64 pcm16 at 16 kHz)"); break;
    case "input.text": if (!isStr(e.text) || !e.text.trim()) throw new ProtocolError("invalid_event", "input.text needs text"); break;
    case "tool.result": if (!isStr(e.call_id)) throw new ProtocolError("invalid_event", "tool.result needs the call_id of its tool.call"); break;
    case "session.start":
      if (e.input_audio_format !== undefined && e.input_audio_format !== "pcm16") throw new ProtocolError("unsupported_audio_format", "only input_audio_format \"pcm16\" (16 kHz mono, little-endian) is supported");
      for (const k of ["model", "llm", "voice", "instructions", "user"]) if (e[k] !== undefined && !isStr(e[k])) throw new ProtocolError("invalid_event", `session.start ${k} must be a string`);
      if (e.tools !== undefined && !Array.isArray(e.tools)) throw new ProtocolError("invalid_event", "session.start tools must be an array of OpenAI chat tools");
      if (e.messages !== undefined && !Array.isArray(e.messages)) throw new ProtocolError("invalid_event", "session.start messages must be an array of chat messages");
      break;
    case "response.create":
      if (e.messages !== undefined && !Array.isArray(e.messages)) throw new ProtocolError("invalid_event", "response.create messages must be an array of chat messages");
      if (e.say !== undefined && (!isStr(e.say) || !e.say.trim())) throw new ProtocolError("invalid_event", "response.create say must be text");
      break;
  }
  return e as unknown as ClientEvent;
}
