import { randomBytes } from "node:crypto";
import type { ChatBody, Chunk, Completion } from "../router/chat.js";
import type { Tool } from "../router/toolguard.js";

/**
 * Anthropic's Messages API in front of mux's OpenAI-shaped core: a SaaS written against Anthropic's SDK points its
 * base URL at mux and keeps its code. Text, images, tools (tool_use / tool_result) and streaming are translated both ways.
 */
type Block = { type: string; text?: string; source?: { type: string; media_type?: string; data?: string; url?: string }; id?: string; name?: string; input?: unknown; tool_use_id?: string; content?: string | Block[]; is_error?: boolean };
export interface MessagesBody {
  model: string; max_tokens: number; messages: { role: "user" | "assistant"; content: string | Block[] }[];
  system?: string | Block[]; tools?: { name: string; description?: string; input_schema?: Record<string, unknown>; type?: string }[];
  tool_choice?: { type: "auto" | "any" | "tool" | "none"; name?: string; disable_parallel_tool_use?: boolean };
  temperature?: number; top_p?: number; top_k?: number; stop_sequences?: string[]; stream?: boolean; metadata?: { user_id?: string; tags?: string[] };
}

const textOf = (c: string | Block[] | undefined): string => (typeof c === "string" ? c : (c ?? []).filter((b) => b.type === "text").map((b) => b.text ?? "").join("\n"));

function image(b: Block) {
  const url = b.source?.type === "base64" ? `data:${b.source.media_type};base64,${b.source.data}` : b.source?.url ?? "";
  return { type: "image_url", image_url: { url } };
}

export function toOpenAI(a: MessagesBody): ChatBody {
  const messages: ChatBody["messages"] = [];
  const system = textOf(a.system);
  if (system) messages.push({ role: "system", content: system });
  for (const m of a.messages) {
    if (typeof m.content === "string") { messages.push({ role: m.role, content: m.content }); continue; }
    if (m.role === "assistant") {
      const text = m.content.filter((b) => b.type === "text").map((b) => b.text).join("");
      const calls = m.content.filter((b) => b.type === "tool_use").map((b) => ({ id: b.id, type: "function", function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) } }));
      messages.push({ role: "assistant", content: text || null, ...(calls.length ? { tool_calls: calls } : {}) });
      continue;
    }
    // Tool results answer the assistant's calls, so they go first, as OpenAI's tool messages.
    for (const b of m.content.filter((x) => x.type === "tool_result")) {
      const content = typeof b.content === "string" ? b.content : textOf(b.content);
      messages.push({ role: "tool", tool_call_id: b.tool_use_id, content: b.is_error ? `Error: ${content}` : content });
    }
    const parts = m.content.filter((b) => b.type === "text" || b.type === "image").map((b) => (b.type === "image" ? image(b) : { type: "text", text: b.text ?? "" }));
    if (parts.length) messages.push({ role: "user", content: parts.every((p) => p.type === "text") ? parts.map((p) => (p as { text: string }).text).join("\n") : parts });
  }
  const tools: Tool[] = (a.tools ?? []).filter((t) => t.input_schema).map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.input_schema } }));
  const tc = a.tool_choice;
  const tool_choice = !tc || !tools.length ? undefined : tc.type === "any" ? "required" : tc.type === "tool" ? { type: "function", function: { name: tc.name } } : tc.type;
  return {
    model: a.model, messages, max_tokens: a.max_tokens, stream: !!a.stream,
    ...(a.temperature !== undefined ? { temperature: a.temperature } : {}), ...(a.top_p !== undefined ? { top_p: a.top_p } : {}),
    ...(a.top_k !== undefined ? { top_k: a.top_k } : {}), ...(a.stop_sequences?.length ? { stop: a.stop_sequences } : {}),
    ...(tools.length ? { tools, ...(tool_choice ? { tool_choice } : {}), ...(tc?.disable_parallel_tool_use ? { parallel_tool_calls: false } : {}) } : {}),
  };
}

const stopReason = (f: string | null | undefined) => (f === "length" ? "max_tokens" : f === "tool_calls" ? "tool_use" : "end_turn");
const msgId = () => `msg_${randomBytes(12).toString("hex")}`;

export function fromOpenAI(c: Completion, model: string) {
  const msg = c.choices?.[0]?.message ?? {};
  const content: unknown[] = [];
  if (typeof msg.content === "string" && msg.content) content.push({ type: "text", text: msg.content });
  for (const tc of (msg.tool_calls ?? []) as { id: string; function: { name: string; arguments: string } }[]) {
    let input: unknown = {};
    try { input = JSON.parse(tc.function.arguments || "{}"); } catch { input = { _raw: tc.function.arguments }; }
    content.push({ type: "tool_use", id: tc.id, name: tc.function.name, input });
  }
  return {
    id: msgId(), type: "message", role: "assistant", model, content,
    stop_reason: stopReason(c.choices?.[0]?.finish_reason), stop_sequence: null,
    usage: { input_tokens: c.usage?.prompt_tokens ?? 0, output_tokens: c.usage?.completion_tokens ?? 0, cache_read_input_tokens: c.usage?.prompt_tokens_details?.cached_tokens ?? 0 },
  };
}

/** Turns OpenAI chunks into Anthropic's stream events, one block at a time. */
export class StreamTranslator {
  private index = -1;
  private open: "text" | "tool" | null = null;
  private toolIdx = -1;
  private started = false;
  finish: string | null = null;
  constructor(private model: string, private emit: (event: string, data: unknown) => void) {}

  private start() {
    if (this.started) return;
    this.started = true;
    this.emit("message_start", { type: "message_start", message: { id: msgId(), type: "message", role: "assistant", model: this.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } } });
  }
  private close() {
    if (this.open) this.emit("content_block_stop", { type: "content_block_stop", index: this.index });
    this.open = null;
  }

  chunk(c: Chunk) {
    this.start();
    const ch = c.choices?.[0];
    if (!ch) return;
    const d = ch.delta ?? {};
    if (typeof d.content === "string" && d.content) {
      if (this.open !== "text") {
        this.close();
        this.index++; this.open = "text";
        this.emit("content_block_start", { type: "content_block_start", index: this.index, content_block: { type: "text", text: "" } });
      }
      this.emit("content_block_delta", { type: "content_block_delta", index: this.index, delta: { type: "text_delta", text: d.content } });
    }
    for (const tc of (d.tool_calls ?? []) as { index?: number; id?: string; function?: { name?: string; arguments?: string } }[]) {
      const k = tc.index ?? 0;
      if (this.open !== "tool" || k !== this.toolIdx) {
        this.close();
        this.index++; this.open = "tool"; this.toolIdx = k;
        this.emit("content_block_start", { type: "content_block_start", index: this.index, content_block: { type: "tool_use", id: tc.id ?? `toolu_${randomBytes(10).toString("hex")}`, name: tc.function?.name ?? "", input: {} } });
      }
      if (tc.function?.arguments) this.emit("content_block_delta", { type: "content_block_delta", index: this.index, delta: { type: "input_json_delta", partial_json: tc.function.arguments } });
    }
    if (ch.finish_reason) this.finish = ch.finish_reason;
  }

  end(inputTokens: number, outputTokens: number) {
    this.start();
    this.close();
    this.emit("message_delta", { type: "message_delta", delta: { stop_reason: stopReason(this.finish), stop_sequence: null }, usage: { input_tokens: inputTokens, output_tokens: outputTokens } });
    this.emit("message_stop", { type: "message_stop" });
  }
}

export function anthropicErrorType(status: number) {
  return status === 400 ? "invalid_request_error" : status === 401 ? "authentication_error" : status === 403 ? "permission_error"
    : status === 404 ? "not_found_error" : status === 413 ? "request_too_large" : status === 429 ? "rate_limit_error" : status === 529 ? "overloaded_error" : "api_error";
}
