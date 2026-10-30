import { randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import { db, settings } from "../db.js";
import type { ApiKey, Tenant } from "../tenants.js";
import { addTokens } from "./limits.js";

/** One call's record, filled in as it goes and written once at the end. */
export interface Ctx {
  id: string; t0: number; tenant: Tenant; key: ApiKey; endpoint: string; ip: string; userAgent: string; tags: string[];
  noFallback?: boolean;
  traceId?: string | null; agent?: string | null; endUser?: string | null;
  requested?: string; route?: string | null; modelId?: string; reason?: string; stream?: boolean; tools?: boolean; forcedTool?: boolean;
  promptTokens?: number; completionTokens?: number; cachedTokens?: number;
  ttftMs?: number | null; queueMs?: number; upstreamMs?: number; tps?: number | null; coldStart?: boolean; fallbacks?: number; finish?: string | null;
  bodyReq?: unknown; bodyRes?: unknown;
}

export const live = new EventEmitter();
live.setMaxListeners(100);

export function newCtx(tenant: Tenant, key: ApiKey, endpoint: string, ip: string, userAgent: string, tags: string[]): Ctx {
  return { id: `req_${randomBytes(10).toString("hex")}`, t0: performance.now(), tenant, key, endpoint, ip, userAgent, tags, fallbacks: 0, queueMs: 0, upstreamMs: 0 };
}

const clip = (v: unknown, n = 8000) => {
  if (v === undefined || v === null) return null;
  const s = typeof v === "string" ? v : JSON.stringify(v);
  return s.length > n ? s.slice(0, n) + `…[${s.length - n} more]` : s;
};

const insert = db.prepare(`INSERT INTO requests(id, ts, tenant_id, key_id, endpoint, requested_model, route, model_id, route_reason, stream, tools, forced_tool,
  status, error_type, error, prompt_tokens, completion_tokens, cached_tokens, latency_ms, ttft_ms, queue_ms, tps, overhead_ms, tags, cold_start, fallbacks, trace_id, agent, end_user,
  finish_reason, ip, user_agent, body_req, body_res)
  VALUES(@id, @ts, @tenant_id, @key_id, @endpoint, @requested_model, @route, @model_id, @route_reason, @stream, @tools, @forced_tool,
  @status, @error_type, @error, @prompt_tokens, @completion_tokens, @cached_tokens, @latency_ms, @ttft_ms, @queue_ms, @tps, @overhead_ms, @tags, @cold_start, @fallbacks, @trace_id, @agent, @end_user,
  @finish_reason, @ip, @user_agent, @body_req, @body_res)`);

/** Write the call's row and tell the live view. */
export function finish(ctx: Ctx, status: number, error?: { type: string; message: string }) {
  const latency = performance.now() - ctx.t0;
  const keepBodies = !!error || ctx.tenant.log_bodies || settings().logBodies;
  const row = {
    id: ctx.id, ts: Date.now(), tenant_id: ctx.tenant.id, key_id: ctx.key.id, endpoint: ctx.endpoint, requested_model: ctx.requested ?? null,
    route: ctx.route ?? null, model_id: ctx.modelId ?? null, route_reason: ctx.reason ?? null, stream: ctx.stream ? 1 : 0, tools: ctx.tools ? 1 : 0,
    forced_tool: ctx.forcedTool ? 1 : 0, status, error_type: error?.type ?? null, error: error?.message?.slice(0, 2000) ?? null,
    prompt_tokens: ctx.promptTokens ?? 0, completion_tokens: ctx.completionTokens ?? 0, cached_tokens: ctx.cachedTokens ?? 0,
    latency_ms: Math.round(latency), ttft_ms: ctx.ttftMs != null ? Math.round(ctx.ttftMs) : null, queue_ms: Math.round(ctx.queueMs ?? 0), tps: ctx.tps ?? null,
    overhead_ms: Math.max(0, Math.round((latency - (ctx.upstreamMs ?? 0) - (ctx.queueMs ?? 0)) * 100) / 100),
    tags: ctx.tags.length ? ctx.tags.join(",") : null, cold_start: ctx.coldStart ? 1 : 0, fallbacks: ctx.fallbacks ?? 0, trace_id: ctx.traceId ?? null, agent: ctx.agent ?? null, end_user: ctx.endUser ?? null, finish_reason: ctx.finish ?? null,
    ip: ctx.ip, user_agent: ctx.userAgent.slice(0, 200), body_req: keepBodies ? clip(ctx.bodyReq) : null, body_res: keepBodies ? clip(ctx.bodyRes) : null,
  };
  try { insert.run(row); } catch (e) { console.error("metering:", (e as Error).message); }
  addTokens(ctx.tenant.id, row.prompt_tokens + row.completion_tokens);
  const { body_req: _q, body_res: _r, ...summary } = row;
  live.emit("request", { ...summary, tenant_name: ctx.tenant.name, tenant_color: ctx.tenant.color });
}
