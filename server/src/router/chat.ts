import { acquire, release } from "../runtime/manager.js";
import type { Model } from "../models.js";
import { MuxError } from "./errors.js";
import { recordFailure, recordSuccess } from "./health.js";
import type { Ctx } from "./metering.js";
import { decide, features } from "./select.js";
import { asToolCall, forcedTools, guarded, isGoodNativeCall, type Tool } from "./toolguard.js";
import { noteHeaders } from "../quota.js";

/* OpenAI chat shapes, as loosely as mux needs them. */
export interface ChatBody { model?: string; messages: { role: string; content?: unknown; [k: string]: unknown }[]; stream?: boolean; tools?: Tool[]; tool_choice?: unknown; [k: string]: unknown }
export interface Usage { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number; prompt_tokens_details?: { cached_tokens?: number } }
interface Timings { prompt_n?: number; prompt_ms?: number; predicted_n?: number; predicted_ms?: number; predicted_per_second?: number; cache_n?: number }
export interface Completion { id?: string; object?: string; created?: number; model?: string; choices: { index?: number; message: Record<string, unknown>; finish_reason?: string | null }[]; usage?: Usage; timings?: Timings; [k: string]: unknown }
export interface Chunk { id?: string; object?: string; created?: number; model?: string; choices: { index?: number; delta: Record<string, unknown>; finish_reason?: string | null }[]; usage?: Usage | null; timings?: Timings; [k: string]: unknown }

/** Read an upstream SSE body as JSON events. */
export async function* sse(res: Response): AsyncGenerator<Record<string, unknown>> {
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let buf = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i: number;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (data === "[DONE]") return;
      try { yield JSON.parse(data); } catch { /* a keep-alive or a partial line */ }
    }
  }
}

/** A failure that another model may not have: try the next candidate. */
class Retryable extends Error {}

async function post(url: string, headers: Record<string, string>, body: unknown, signal: AbortSignal, modelId?: string) {
  try {
    const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body), signal });
    if (modelId) noteHeaders(modelId, res.status, res.headers); // a free tier's limits, as it reports them
    return res;
  } catch (e) {
    if ((e as Error).name === "AbortError") throw e;
    throw new Retryable(`could not reach the model server: ${(e as Error).message}`);
  }
}

async function upstreamError(res: Response): Promise<Error> {
  const text = await res.text().catch(() => "");
  let msg = text;
  try { const j = JSON.parse(text); msg = j.error?.message ?? j.error ?? j.message ?? text; } catch { /* plain text */ }
  msg = String(msg).slice(0, 500);
  // Out of context on this model is a reason to try a bigger one (LiteLLM's context-window fallback).
  if (res.status >= 500 || res.status === 429 || /context|too long|exceeds/i.test(msg)) return new Retryable(`upstream ${res.status}: ${msg}`);
  return new MuxError(res.status, "upstream_error", msg);
}

const toFinal = (c: Completion, model: Model): Completion => ({ ...c, model: model.id });

/** Run a chat request across the route's candidates. Streams through `onChunk` when given, else returns the completion. */
export async function runChat(ctx: Ctx, body: ChatBody, signal: AbortSignal, onChunk?: (c: Chunk) => void): Promise<Completion | null> {
  const f = features(body);
  const forced = forcedTools(body);
  ctx.tools = f.tools; ctx.forcedTool = !!forced; ctx.stream = !!onChunk; ctx.requested = body.model;
  const d = decide(ctx.tenant, body.model, "chat", f);
  ctx.experiment = d.experiment ?? null;
  ctx.route = d.route?.name ?? null;
  ctx.reason = d.reason;
  let lastErr: Error | null = null;
  for (const [i, m] of (ctx.noFallback ? d.candidates.slice(0, 1) : d.candidates).entries()) {
    if (i > 0) ctx.fallbacks = i;
    const tq = performance.now();
    let up;
    try { up = await acquire(m); } catch (e) {
      recordFailure(m.id);
      lastErr = e as Error;
      ctx.queueMs = (ctx.queueMs ?? 0) + (performance.now() - tq);
      continue;
    }
    ctx.queueMs = (ctx.queueMs ?? 0) + (performance.now() - tq);
    ctx.coldStart = up.coldStartMs > 0;
    ctx.modelId = m.id;
    const url = `${up.baseUrl}/chat/completions`;
    const tu = performance.now();
    try {
      const out = forced
        ? await forcedCall(ctx, m, url, up.headers, { ...body, model: up.model }, forced, signal, onChunk)
        : onChunk ? await streamCall(ctx, m, url, up.headers, { ...body, model: up.model }, signal, onChunk)
        : await plainCall(ctx, m, url, up.headers, { ...body, model: up.model }, signal);
      ctx.upstreamMs = performance.now() - tu;
      recordSuccess(m.id, ctx.ttftMs ?? null, ctx.tps ?? null);
      return out;
    } catch (e) {
      ctx.upstreamMs = (ctx.upstreamMs ?? 0) + (performance.now() - tu);
      if (e instanceof Retryable) { recordFailure(m.id); lastErr = e; continue; }
      throw e;
    } finally {
      release(m.id);
    }
  }
  const msg = lastErr?.message ?? "no model could take the request";
  throw new MuxError(503, "all_models_failed", d.candidates.length > 1 ? `every model on the route failed; the last: ${msg}` : msg);
}

function meter(ctx: Ctx, usage: Usage | undefined | null, timings: Timings | undefined, firstAt: number | null, endAt: number) {
  ctx.promptTokens = usage?.prompt_tokens ?? timings?.prompt_n ?? ctx.promptTokens ?? 0;
  ctx.completionTokens = usage?.completion_tokens ?? timings?.predicted_n ?? ctx.completionTokens ?? 0;
  ctx.cachedTokens = usage?.prompt_tokens_details?.cached_tokens ?? timings?.cache_n ?? 0;
  if (timings?.predicted_per_second) ctx.tps = Math.round(timings.predicted_per_second * 10) / 10;
  else if (firstAt && ctx.completionTokens > 1 && endAt > firstAt) ctx.tps = Math.round((ctx.completionTokens / ((endAt - firstAt) / 1000)) * 10) / 10;
}

async function plainCall(ctx: Ctx, m: Model, url: string, headers: Record<string, string>, body: ChatBody, signal: AbortSignal): Promise<Completion> {
  const { stream: _s, stream_options: _o, ...rest } = body;
  const res = await post(url, headers, rest, signal, m.id);
  if (!res.ok) throw await upstreamError(res);
  const c = (await res.json()) as Completion;
  meter(ctx, c.usage, c.timings, null, performance.now());
  // Without a stream the first token is not seen; the prompt's time stands in for it.
  ctx.ttftMs = c.timings?.prompt_ms != null ? (ctx.queueMs ?? 0) + c.timings.prompt_ms : null;
  ctx.finish = c.choices?.[0]?.finish_reason ?? null;
  ctx.bodyRes = c.choices?.[0]?.message;
  return toFinal(c, m);
}

async function streamCall(ctx: Ctx, m: Model, url: string, headers: Record<string, string>, body: ChatBody, signal: AbortSignal, onChunk: (c: Chunk) => void): Promise<null> {
  const wantsUsage = !!(body.stream_options as { include_usage?: boolean } | undefined)?.include_usage;
  const res = await post(url, headers, { ...body, stream: true, stream_options: { include_usage: true } }, signal, m.id);
  if (!res.ok) throw await upstreamError(res);
  let first: number | null = null;
  let usage: Usage | null = null;
  let timings: Timings | undefined;
  let text = "";
  for await (const ev of sse(res)) {
    const c = ev as unknown as Chunk;
    if (c.usage) usage = c.usage;
    if (c.timings) timings = c.timings;
    const delta = c.choices?.[0]?.delta;
    if (delta && first === null && (delta.content || delta.tool_calls || delta.reasoning_content)) {
      first = performance.now();
      ctx.ttftMs = first - ctx.t0;
    }
    if (typeof delta?.content === "string" && text.length < 8000) text += delta.content;
    if (c.choices?.[0]?.finish_reason) ctx.finish = c.choices[0].finish_reason;
    // The usage-only chunk goes out only to callers who asked for it; some clients choke on empty choices.
    if (!c.choices?.length && !wantsUsage) continue;
    const { timings: _t, ...out } = c;
    onChunk({ ...out, model: m.id });
  }
  meter(ctx, usage, timings, first, performance.now());
  ctx.bodyRes = text;
  return null;
}

async function forcedCall(ctx: Ctx, m: Model, url: string, headers: Record<string, string>, body: ChatBody, tools: Tool[], signal: AbortSignal, onChunk?: (c: Chunk) => void): Promise<Completion | null> {
  const { stream: _s, stream_options: _o, ...plain } = body;
  let answer: Completion | null = null;
  // `required` among several tools: the model's own format first (its tool calling is trained); words fall through.
  if (tools.length > 1 && body.tool_choice === "required") {
    const res = await post(url, headers, plain, signal, m.id);
    if (res.ok) {
      const c = (await res.json()) as Completion;
      if (isGoodNativeCall(c, tools)) answer = c;
    }
  }
  if (!answer) {
    const ask = guarded(plain, tools) as ChatBody;
    let res = await post(url, headers, ask, signal, m.id);
    if (!res.ok) throw await upstreamError(res);
    let c = (await res.json()) as Completion;
    // Cut off by max_tokens, the JSON is half a JSON: ask once more with room.
    if (c.choices?.[0]?.finish_reason === "length") {
      const max = Number(ask.max_tokens ?? ask.max_completion_tokens ?? 1600);
      res = await post(url, headers, { ...ask, max_tokens: Math.min(Math.max(max * 2, 2048), 8192) }, signal, m.id);
      if (!res.ok) throw await upstreamError(res);
      c = (await res.json()) as Completion;
    }
    try { answer = asToolCall(c, tools); } catch (e) { throw new Retryable(`the model's answer did not fit the tool: ${(e as Error).message}`); }
  }
  const done: Completion = answer;
  meter(ctx, done.usage, done.timings, null, performance.now());
  ctx.ttftMs = performance.now() - ctx.t0;
  ctx.finish = "tool_calls";
  ctx.bodyRes = done.choices?.[0]?.message;
  const final = toFinal(done, m);
  if (!onChunk) return final;
  // The caller asked for a stream: the one answer, as the chunks a stream of it would have been.
  const base = { id: final.id ?? ctx.id, object: "chat.completion.chunk", created: final.created ?? Math.floor(Date.now() / 1000), model: m.id };
  const calls = (final.choices[0].message.tool_calls ?? []) as { id: string; type: string; function: { name: string; arguments: string } }[];
  onChunk({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: null }, finish_reason: null }] });
  onChunk({ ...base, choices: [{ index: 0, delta: { tool_calls: calls.map((tc, index) => ({ index, ...tc })) }, finish_reason: null }] });
  onChunk({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] });
  if ((body.stream_options as { include_usage?: boolean } | undefined)?.include_usage && final.usage) onChunk({ ...base, choices: [], usage: final.usage });
  return null;
}
