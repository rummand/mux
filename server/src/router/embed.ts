import { acquire, release } from "../runtime/manager.js";
import { MuxError } from "./errors.js";
import { recordFailure, recordSuccess } from "./health.js";
import type { Ctx } from "./metering.js";
import { decide } from "./select.js";

/** POST /v1/embeddings (or /v1/rerank) across the route's candidates. */
export async function runEmbeddings(ctx: Ctx, body: { model?: string; input?: unknown; documents?: unknown; query?: string; [k: string]: unknown }, signal: AbortSignal, kind: "embedding" | "rerank" = "embedding") {
  ctx.requested = body.model;
  const d = decide(ctx.tenant, body.model, kind, null);
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
    const tu = performance.now();
    try {
      const res = await fetch(`${up.baseUrl}/${kind === "rerank" ? "rerank" : "embeddings"}`, { method: "POST", headers: { "content-type": "application/json", ...up.headers }, body: JSON.stringify({ ...body, model: up.model }), signal });
      ctx.upstreamMs = performance.now() - tu;
      if (!res.ok) {
        const text = await res.text();
        if (res.status < 500) throw new MuxError(res.status, "upstream_error", text.slice(0, 500));
        recordFailure(m.id); last = `upstream ${res.status}: ${text.slice(0, 200)}`; continue;
      }
      const out = (await res.json()) as { usage?: { prompt_tokens?: number }; data?: unknown[] };
      const inputs = kind === "rerank" ? [body.query, body.documents] : Array.isArray(body.input) ? body.input : [body.input];
      ctx.promptTokens = out.usage?.prompt_tokens ?? Math.ceil(JSON.stringify(inputs).length / 4);
      ctx.ttftMs = performance.now() - ctx.t0;
      recordSuccess(m.id, ctx.ttftMs, null);
      return { ...out, model: m.id };
    } catch (e) {
      if (e instanceof MuxError || (e as Error).name === "AbortError") throw e;
      recordFailure(m.id); last = (e as Error).message;
    } finally { release(m.id); }
  }
  throw new MuxError(503, "all_models_failed", last || `no ${kind} model could take the request`);
}
