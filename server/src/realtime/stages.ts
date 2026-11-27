/**
 * The stages of a realtime session, as interfaces: the session (session.ts) knows nothing of sockets, routes or
 * models, so every stage has a fake in the tests and a real adapter in adapters.ts.
 */

export interface Message { role: string; content?: unknown; [k: string]: unknown }
export interface ChatTool { type?: string; function?: { name: string; description?: string; parameters?: unknown }; [k: string]: unknown }
export interface ToolCall { id: string; name: string; arguments: string }
export interface Usage { prompt_tokens: number; completion_tokens: number }

/** The LLM: Bloom's conversation in, streamed words (and tool calls) out. */
export interface Thinker {
  stream(req: { model?: string; messages: Message[]; tools?: ChatTool[]; tool_choice?: unknown }, signal: AbortSignal, onText: (delta: string) => void):
    Promise<{ text: string; toolCalls: ToolCall[]; usage: Usage; coldStart: boolean; model?: string }>;
}

/** Speech for one sentence: pcm16 mono and its rate. */
export interface Speaker {
  speak(text: string, voice: string, signal: AbortSignal): Promise<{ pcm: Buffer; rate: number; coldStart?: boolean }>;
}

/** Speech to text for one turn's audio (pcm16 at 16 kHz), when the hearing does not transcribe as it listens. */
export interface Transcriber {
  transcribe(pcm16k: Buffer, signal: AbortSignal): Promise<string>;
}

/** What a duplex engine sends back: its voice (pcm16 at `rate`), its words, its own errors. */
export type DuplexEvent =
  | { type: "audio"; pcm: Buffer; rate: number }
  | { type: "text"; text: string }
  | { type: "error"; message: string }
  | { type: "closed"; reason: string };

/** A full-duplex model (Haru-4B, MiniCPM-o 4.5): it hears every frame and speaks when it decides to. */
export interface DuplexEngine {
  readonly name: string;
  readonly rate: number;
  /** Whether it can be made to say a given sentence (Haru's forced text, experimental). */
  readonly canSpeak: boolean;
  push(pcm16k: Buffer): void;
  speak(text: string): void;
  close(): void;
}
export type DuplexFactory = (opts: { model: string; instructions: string; voice?: string }, onEvent: (e: DuplexEvent) => void, signal: AbortSignal) =>
  Promise<DuplexEngine>;
