import { acquire, release } from "../runtime/manager.js";
import { MuxError } from "./errors.js";
import { recordFailure, recordSuccess } from "./health.js";
import type { Ctx } from "./metering.js";
import { decide } from "./select.js";

/**
 * POST /v1/systemone — Jev's System One shape (TypeSafe), the fast lane for small closed decisions between agent moves:
 * `{ state, questions: { <id>: { type: choice|score|noul, instructions, criteria? } } }` → probabilities per answer.
 * Answered by Laya on this Mac (backend "laya", ONNX on CPU) or by hosted Jev (backend "jev", by key), as the
 * systemone route orders them. The request is checked here, the one way, before either sees it.
 */
const TYPES = new Set(["choice", "score", "noul"]);

export function checkSystemOne(p: unknown): string | null {
  if (!p || typeof p !== "object" || Array.isArray(p)) return "the body must be a JSON object";
  const b = p as { state?: unknown; questions?: unknown };
  if (typeof b.state !== "string" && (typeof b.state !== "object" || b.state === null)) return "state must be a string or an object";
  const qs = b.questions as Record<string, { type?: string; instructions?: unknown; criteria?: unknown }>;
  if (!qs || typeof qs !== "object" || Array.isArray(qs)) return "questions must be an object keyed by question id (Jev's shape), not an array";
  const ids = Object.keys(qs);
  if (!ids.length) return "at least one question is required";
  if (ids.length > 32) return "at most 32 questions a request";
  for (const id of ids) {
    const q = qs[id];
    if (!q || typeof q !== "object") return `question ${id} is not an object`;
    if (!TYPES.has(q.type ?? "")) return `question ${id}: type must be choice, score or noul`;
    if (typeof q.instructions !== "string" && (typeof q.instructions !== "object" || q.instructions === null)) return `question ${id}: instructions are required`;
    if (q.type === "choice") {
      const c = q.criteria;
      const n = Array.isArray(c) ? c.length : c && typeof c === "object" ? Object.keys(c).length : 0;
      if (n < 2) return `question ${id}: a choice needs at least two options in criteria`;
      if (n > 120) return `question ${id}: at most 120 options`;
    }
    if (q.type === "score" && (!Array.isArray(q.criteria) || q.criteria.length < 2)) return `question ${id}: a score needs its ordered levels as criteria`;
  }
  return null;
}

export async function runSystemOne(ctx: Ctx, body: { model?: string; state: unknown; questions: Record<string, unknown> }, signal: AbortSignal) {
  const wrong = checkSystemOne(body);
  if (wrong) throw new MuxError(400, "invalid_request", wrong);
  ctx.requested = body.model;
  const d = decide(ctx.tenant, body.model, "systemone", null);
  ctx.experiment = d.experiment ?? null;
  ctx.route = d.route?.name ?? null;
  ctx.reason = d.reason;
  let last = "";
  for (const [i, m] of d.candidates.entries()) {
    ctx.fallbacks = i;
    const tq = performance.now();
    let up;
    try { up = await acquire(m); } catch (e) { recordFailure(m.id); last = (e as Error).message; continue; } finally { ctx.queueMs = performance.now() - tq; }
    ctx.modelId = m.id;
    ctx.coldStart = up.coldStartMs > 0;
    const url = /systemone\/?$/.test(up.baseUrl) ? up.baseUrl : `${up.baseUrl.replace(/\/v1$/, "")}/v1/systemone`;
    const tu = performance.now();
    try {
      const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json", ...up.headers }, body: JSON.stringify({ ...body, model: up.model }), signal });
      ctx.upstreamMs = performance.now() - tu;
      const text = await res.text();
      if (!res.ok) {
        if (res.status < 500 && res.status !== 429) throw new MuxError(res.status, "upstream_error", text.slice(0, 500));
        recordFailure(m.id); last = `upstream ${res.status}: ${text.slice(0, 200)}`; continue;
      }
      const out = JSON.parse(text) as { usage?: { input_tokens?: number; output_tokens?: number } };
      ctx.promptTokens = out.usage?.input_tokens ?? 0;
      ctx.completionTokens = out.usage?.output_tokens ?? 0;
      ctx.ttftMs = performance.now() - ctx.t0;
      ctx.bodyRes = out;
      recordSuccess(m.id, ctx.ttftMs, null);
      return { ...out, model: m.id };
    } catch (e) {
      if (e instanceof MuxError || (e as Error).name === "AbortError") throw e;
      recordFailure(m.id); last = (e as Error).message;
    } finally { release(m.id); }
  }
  throw new MuxError(503, "all_models_failed", last || "no System One model could answer");
}
