import { createHash, randomBytes } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { recall } from "./brain.js";
import { db, event, json, now } from "./db.js";
import { getModel, getRoute, listModels } from "./models.js";
import { acquire, release } from "./runtime/manager.js";
import { getTenant } from "./tenants.js";
import { outside } from "./router/border.js";

/**
 * Lens (after LiteLLM's): an investigation reads a slice of traffic — a tenant, an agent, a time window — and writes
 * findings, each with the requests that are its evidence. Rules find what can be counted (error clusters, truncated or
 * empty answers, fallbacks, cold starts, runaway traces, retry storms, full contexts, repeats, spend, budgets); a local
 * model then reads the digest and samples for what cannot, against the investigation's criteria and what mux's brain
 * says the traffic should do. Nothing leaves the Mac.
 *
 * Every run is measured against the window before it, and its findings against the last run of the same scope: each
 * is new or ongoing, and what the last run found and this one does not is resolved. Watches repeat an investigation on a
 * schedule and raise a warning event for a new finding that needs attention; mutes keep a finding someone has seen out.
 */
export interface Finding {
  key: string; title: string; kind: "needs-attention" | "pattern"; priority: "high" | "medium" | "low";
  description: string; suggestion: string; evidence: { request_id: string; quote: string }[]; source: "rules" | "model"; status?: "new" | "ongoing";
}
export interface LensFilters { tenantId?: string; agent?: string; model?: string; hours?: number; sample?: number }
export interface Metrics { requests: number; errorRate: number; latencyP95: number | null; ttftP50: number | null; tokensPerRequest: number; costUsd: number }

export interface Row { id: string; ts: number; tenant_id: string; agent: string | null; trace_id: string | null; endpoint: string; model_id: string | null; provider_id?: string | null; route: string | null; status: number; error_type: string | null; error: string | null; latency_ms: number; ttft_ms: number | null; prompt_tokens: number; completion_tokens: number; fallbacks: number; cold_start: number; finish_reason: string | null; forced_tool: number; tools: number; stream?: number; cost_usd?: number | null; body_req: string | null; body_res: string | null; route_reason: string | null }

function select(f: LensFilters, from: number, to: number): Row[] {
  const where = ["ts >= ?", "ts < ?"]; const args: unknown[] = [from, to];
  if (f.tenantId) { where.push("tenant_id = ?"); args.push(f.tenantId); }
  if (f.agent) { where.push("agent = ?"); args.push(f.agent); }
  if (f.model) { where.push("model_id = ?"); args.push(f.model); }
  return db.prepare(`SELECT * FROM requests WHERE ${where.join(" AND ")} ORDER BY ts DESC LIMIT 20000`).all(...args) as Row[];
}

const pct = (xs: number[], p: number) => { if (!xs.length) return 0; const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]; };
const groupBy = <T>(xs: T[], k: (x: T) => string) => xs.reduce((m, x) => m.set(k(x), [...(m.get(k(x)) ?? []), x]), new Map<string, T[]>());
const isChat = (r: Row) => /chat|messages/.test(r.endpoint);

export function metrics(rows: Row[]): Metrics {
  const ok = rows.filter((r) => r.status < 400);
  const ttft = ok.map((r) => r.ttft_ms).filter((x): x is number => x != null);
  return {
    requests: rows.length, errorRate: rows.length ? (rows.length - ok.length) / rows.length : 0,
    latencyP95: ok.length ? pct(ok.map((r) => r.latency_ms), 95) : null, ttftP50: ttft.length ? pct(ttft, 50) : null,
    tokensPerRequest: rows.length ? rows.reduce((a, r) => a + r.prompt_tokens + r.completion_tokens, 0) / rows.length : 0,
    costUsd: rows.reduce((a, r) => a + (r.cost_usd ?? 0), 0),
  };
}

export function rules(rows: Row[], at = now()): Finding[] {
  const out: Finding[] = [];
  const errors = rows.filter((r) => r.status >= 400);
  const clusters = new Map<string, Row[]>();
  for (const r of errors) {
    const key = `${r.error_type ?? r.status}|${r.model_id ?? "-"}|${(r.error ?? "").replace(/\d+/g, "#").slice(0, 80)}`;
    clusters.set(key, [...(clusters.get(key) ?? []), r]);
  }
  for (const [key, rs] of [...clusters].sort((a, b) => b[1].length - a[1].length).slice(0, 5)) {
    const [type, model] = key.split("|");
    const share = rs.length / rows.length;
    out.push({
      key: `errors|${type}|${model}`, source: "rules", kind: "needs-attention", priority: share > 0.05 || rs.length > 50 ? "high" : rs.length > 5 ? "medium" : "low",
      title: `${rs.length} × ${type}${model !== "-" ? ` on ${model}` : ""}`,
      description: `${(share * 100).toFixed(1)}% of the ${rows.length} requests failed this way. First: ${new Date(rs[rs.length - 1].ts).toISOString()}, last: ${new Date(rs[0].ts).toISOString()}.`,
      suggestion: type === "rate_limit_exceeded" ? "Raise the tenant's RPM limit, or have the client back off on 429 (retry-after is set)."
        : type === "memory_budget" ? "Raise the memory budget, pin fewer models, or point the route at a smaller model."
        : type === "budget_exceeded" ? "Raise the monthly budget or move the tenant to a cheaper route."
        : type === "all_models_failed" || type === "load_failed" ? "Open the model's log on the Models page; check it loads, and give the route a second candidate."
        : "Open a sample request and compare with the model's log.",
      evidence: rs.slice(0, 5).map((r) => ({ request_id: r.id, quote: (r.error ?? "").slice(0, 160) })),
    });
  }
  // A client that retries at once on failure: many errors from one tenant inside a minute.
  const storms = [...groupBy(errors, (r) => r.tenant_id)].map(([tenant, rs]) => {
    const peak = [...groupBy(rs, (r) => String(Math.floor(r.ts / 60_000)))].sort((a, b) => b[1].length - a[1].length)[0][1];
    return { tenant, peak };
  }).filter((s) => s.peak.length >= 20).sort((a, b) => b.peak.length - a.peak.length).slice(0, 3);
  for (const s of storms) out.push({ key: `storm|${s.tenant}`, source: "rules", kind: "needs-attention", priority: "high",
    title: `${s.tenant} sent ${s.peak.length} failing requests within one minute`, description: `A retry storm: the client retried at once instead of backing off, around ${new Date(s.peak[0].ts).toISOString()}. Each retry takes a slot from every other tenant.`,
    suggestion: "Have the client back off exponentially and honour retry-after; set a max-parallel limit on the tenant so a storm cannot crowd others out.",
    evidence: s.peak.slice(0, 5).map((r) => ({ request_id: r.id, quote: `${r.status} ${(r.error ?? r.error_type ?? "").slice(0, 120)}` })) });
  const truncated = rows.filter((r) => r.finish_reason === "length");
  if (truncated.length >= 3) out.push({ key: "truncated", source: "rules", kind: "needs-attention", priority: truncated.length / rows.length > 0.05 ? "high" : "medium",
    title: `${truncated.length} answers cut off by max_tokens`, description: "The model stopped because it ran out of tokens, so the caller got half an answer (or half a JSON).",
    suggestion: "Raise max_tokens for these calls, or turn reasoning off for the model if thinking eats the budget.", evidence: truncated.slice(0, 5).map((r) => ({ request_id: r.id, quote: `${r.completion_tokens} tokens on ${r.model_id}` })) });
  const empty = rows.filter((r) => r.status < 400 && isChat(r) && r.completion_tokens === 0);
  if (empty.length >= 3) out.push({ key: "empty", source: "rules", kind: "needs-attention", priority: empty.length / rows.length > 0.02 ? "high" : "medium",
    title: `${empty.length} empty answers`, description: "The model answered 200 with no tokens at all: the caller got nothing to work with, and nothing failed to tell it so.",
    suggestion: "Open one and the model's log: often a chat template that ends the turn at once, or reasoning that uses up the turn. Try reasoning off, or another model on the route.",
    evidence: empty.slice(0, 5).map((r) => ({ request_id: r.id, quote: `${r.model_id}, ${r.prompt_tokens} prompt tokens, finish ${r.finish_reason ?? "-"}` })) });
  // Prompts that nearly fill the model's context: the next, slightly longer one fails.
  const ctx = new Map<string, number>();
  const ctxOf = (id: string) => { if (!ctx.has(id)) ctx.set(id, getModel(id)?.ctx ?? 0); return ctx.get(id)!; };
  const full = rows.filter((r) => r.model_id && ctxOf(r.model_id) > 0 && r.prompt_tokens >= 0.85 * ctxOf(r.model_id));
  if (full.length >= 3) out.push({ key: "context-full", source: "rules", kind: "needs-attention", priority: full.length / rows.length > 0.05 ? "high" : "medium",
    title: `${full.length} requests used 85%+ of their model's context`, description: `On ${[...new Set(full.map((r) => r.model_id))].join(", ")}. These are one tool result away from failing with a context overflow.`,
    suggestion: "Raise the model's ctx if memory allows, route long prompts to a model with a larger context, or have the agent trim its history.",
    evidence: full.slice(0, 5).map((r) => ({ request_id: r.id, quote: `${r.prompt_tokens} of ${ctxOf(r.model_id!)} tokens on ${r.model_id}` })) });
  const fb = rows.filter((r) => r.fallbacks > 0);
  if (fb.length >= 3) out.push({ key: "fallbacks", source: "rules", kind: "pattern", priority: "medium", title: `${fb.length} requests needed a fallback`,
    description: `The first candidate failed and mux answered with the next. Routes affected: ${[...new Set(fb.map((r) => r.route))].join(", ")}.`,
    suggestion: "Check the first candidate's health; fallbacks hide failures from callers but add latency.", evidence: fb.slice(0, 5).map((r) => ({ request_id: r.id, quote: r.route_reason?.slice(0, 160) ?? "" })) });
  const cold = rows.filter((r) => r.cold_start);
  if (cold.length >= 3) out.push({ key: "cold-starts", source: "rules", kind: "pattern", priority: "medium", title: `${cold.length} requests waited for a model to load`,
    description: `Median latency of those: ${pct(cold.map((r) => r.latency_ms), 50)} ms.`, suggestion: "Pin the model or raise its keep-alive so it stays loaded between bursts.",
    evidence: cold.slice(0, 5).map((r) => ({ request_id: r.id, quote: `${r.model_id}: ${r.latency_ms} ms` })) });
  const traces = new Map<string, Row[]>();
  for (const r of rows) if (r.trace_id) traces.set(r.trace_id, [...(traces.get(r.trace_id) ?? []), r]);
  const runaway = [...traces].filter(([, rs]) => rs.length >= 25).sort((a, b) => b[1].length - a[1].length);
  if (runaway.length) out.push({ key: "runaway", source: "rules", kind: "needs-attention", priority: "high", title: `${runaway.length} agent run(s) with 25+ model calls`,
    description: `The longest: trace ${runaway[0][0]} made ${runaway[0][1].length} calls (${runaway[0][1].reduce((a, r) => a + r.prompt_tokens + r.completion_tokens, 0).toLocaleString()} tokens). Agents that loop burn the Mac's time for every tenant.`,
    suggestion: "Give the agent a step limit, or look at the trace for a tool it keeps retrying.", evidence: runaway.slice(0, 5).map(([t, rs]) => ({ request_id: rs[0].id, quote: `trace ${t}: ${rs.length} calls` })) });
  // The same request, word for word, again and again (only where bodies are logged).
  const same = [...groupBy(rows.filter((r) => r.body_req && isChat(r)), (r) => createHash("sha1").update(r.body_req!).digest("hex"))].filter(([, rs]) => rs.length >= 5).sort((a, b) => b[1].length - a[1].length);
  if (same.length) {
    const n = same.reduce((a, [, rs]) => a + rs.length - 1, 0);
    out.push({ key: "repeats", source: "rules", kind: "pattern", priority: n >= 100 ? "medium" : "low", title: `${n} requests repeated one sent before, word for word`,
      description: `${same.length} distinct request(s) were each sent 5 or more times; the most: ${same[0][1].length} times by ${same[0][1][0].tenant_id}.`,
      suggestion: "Cache these answers in the client, or check the agent is not polling the model for something that has not changed.",
      evidence: same.slice(0, 5).map(([, rs]) => ({ request_id: rs[0].id, quote: `${rs.length}× “${lastUser(rs[0].body_req!).slice(0, 100)}”` })) });
  }
  const lat = rows.filter((r) => r.status < 400).map((r) => r.latency_ms);
  if (lat.length >= 20) {
    const p50 = pct(lat, 50), p95 = pct(lat, 95);
    if (p95 > p50 * 5 && p95 > 5000) {
      const slow = rows.filter((r) => r.latency_ms >= p95).slice(0, 5);
      out.push({ key: "latency-tail", source: "rules", kind: "pattern", priority: "low", title: `A long latency tail: p95 ${p95} ms against p50 ${p50} ms`, description: "A few requests take far longer than most.",
        suggestion: "Compare their prompt sizes and models; long prompts may belong on a route with a faster prefill.", evidence: slow.map((r) => ({ request_id: r.id, quote: `${r.latency_ms} ms, ${r.prompt_tokens} prompt tokens, ${r.model_id}` })) });
    }
  }
  const streamed = rows.filter((r) => r.status < 400 && r.stream && r.ttft_ms != null);
  if (streamed.length >= 20 && pct(streamed.map((r) => r.ttft_ms!), 95) > 10_000) {
    const p95 = pct(streamed.map((r) => r.ttft_ms!), 95);
    out.push({ key: "slow-first-token", source: "rules", kind: "pattern", priority: p95 > 30_000 ? "medium" : "low", title: `Streams wait ${(p95 / 1000).toFixed(1)} s for their first token (p95)`,
      description: "A user watching a stream sees nothing for this long: queueing, a cold model or a long prompt's prefill.",
      suggestion: "Raise the model's parallel slots if it queues, pin it if it loads cold, or move long prompts to a model with a faster prefill.",
      evidence: streamed.filter((r) => r.ttft_ms! >= p95).slice(0, 5).map((r) => ({ request_id: r.id, quote: `${r.ttft_ms} ms to first token, ${r.prompt_tokens} prompt tokens, ${r.model_id}` })) });
  }
  // Where the money goes: one tenant on one paid model taking most of the spend.
  const spend = rows.reduce((a, r) => a + (r.cost_usd ?? 0), 0);
  if (spend >= 1) {
    const [pair, rs] = [...groupBy(rows.filter((r) => (r.cost_usd ?? 0) > 0), (r) => `${r.tenant_id}|${r.model_id}`)].sort((a, b) => sum(b[1]) - sum(a[1]))[0];
    const [tenant, model] = pair.split("|");
    if (sum(rs) / spend > 0.5) out.push({ key: `spend|${pair}`, source: "rules", kind: "pattern", priority: sum(rs) >= 20 ? "medium" : "low",
      title: `${tenant} on ${model} is ${Math.round((sum(rs) / spend) * 100)}% of the spend ($${sum(rs).toFixed(2)})`, description: `Of $${spend.toFixed(2)} spent on paid APIs in this slice, across ${rs.length} requests.`,
      suggestion: "If a local model is good enough for these calls (try them in the Playground or a benchmark), point the tenant's route at it: local tokens cost no USD.",
      evidence: [...rs].sort((a, b) => (b.cost_usd ?? 0) - (a.cost_usd ?? 0)).slice(0, 5).map((r) => ({ request_id: r.id, quote: `$${(r.cost_usd ?? 0).toFixed(4)}, ${r.prompt_tokens}+${r.completion_tokens} tokens` })) });
  }
  // Data borders: requests a tenant's border does not allow where they ran (from before the border, or a stale route).
  const crossed = new Map<string, { rs: Row[]; why: string }>();
  for (const r of rows) {
    const t = r.tenant_id ? getTenant(r.tenant_id) : undefined;
    const m = r.model_id ? getModel(r.model_id) : undefined;
    const why = t && m && r.status < 400 ? outside(t.data_border, m) : null;
    if (why) { const c = crossed.get(r.tenant_id) ?? { rs: [], why }; c.rs.push(r); crossed.set(r.tenant_id, c); }
  }
  for (const [tenant, c] of crossed) out.push({ key: `border|${tenant}`, source: "rules", kind: "needs-attention", priority: "high",
    title: `${c.rs.length} of ${tenant}'s requests ran outside its data border`, description: `${getTenant(tenant)?.name ?? tenant} may run only on ${getTenant(tenant)?.data_border === "servers" ? "our always-on machines" : "our own machines"}, but these ran on ${[...new Set(c.rs.map((r) => r.model_id))].join(", ")} — ${c.why}. The router refuses this now; these are from before the border, or a route that has since changed.`,
    suggestion: "Check what these requests carried; if the border is right, nothing more to do — new requests stay inside it. Take the outside models off the tenant's routes so fallbacks do not fail.",
    evidence: c.rs.slice(0, 5).map((r) => ({ request_id: r.id, quote: `${r.model_id} (${r.provider_id ?? "here"})` })) });
  // Budgets: at this month's pace, will a tenant run out before the month does?
  const d = new Date(at); const start = new Date(d.getFullYear(), d.getMonth(), 1).getTime(); const end = new Date(d.getFullYear(), d.getMonth() + 1, 1).getTime();
  const elapsed = Math.max((at - start) / (end - start), 1 / 60);
  for (const id of new Set(rows.map((r) => r.tenant_id))) {
    const t = id ? getTenant(id) : undefined;
    if (!t || (!t.monthly_token_budget && !t.monthly_usd_budget)) continue;
    const u = db.prepare("SELECT COALESCE(SUM(prompt_tokens + completion_tokens), 0) tokens, COALESCE(SUM(cost_usd), 0) usd FROM requests WHERE tenant_id = ? AND ts >= ? AND ts < ?").get(id, start, at) as { tokens: number; usd: number };
    for (const [used, budget, unit] of [[u.tokens, t.monthly_token_budget, "tokens"], [u.usd, t.monthly_usd_budget, "USD"]] as const) {
      if (!budget || used / elapsed <= budget) continue;
      const day = new Date(start + (budget / (used / elapsed)) * (end - start));
      const fmt = (x: number) => (unit === "USD" ? `$${x.toFixed(2)}` : `${Math.round(x).toLocaleString()} tokens`);
      out.push({ key: `budget|${id}|${unit}`, source: "rules", kind: "needs-attention", priority: used >= budget * 0.8 ? "high" : "medium",
        title: `${t.name} will use up its monthly ${unit === "USD" ? "USD" : "token"} budget around ${day.toISOString().slice(0, 10)}`,
        description: `${fmt(used)} of ${fmt(budget)} used ${Math.round(elapsed * 100)}% into the month; at this pace the month ends near ${fmt(used / elapsed)}. When it runs out, mux refuses the tenant's requests.`,
        suggestion: "Raise the budget, move the tenant to a cheaper route, or find what grew (Overview, filtered to the tenant).", evidence: [] });
    }
  }
  return out;
}
const sum = (rs: Row[]) => rs.reduce((a, r) => a + (r.cost_usd ?? 0), 0);

function digest(rows: Row[], criteria: string) {
  const by = (k: (r: Row) => unknown) => Object.entries(rows.reduce<Record<string, number>>((a, r) => { const v = String(k(r) ?? "-"); a[v] = (a[v] ?? 0) + 1; return a; }, {})).sort((a, b) => b[1] - a[1]).slice(0, 12);
  const samples = [...rows.filter((r) => r.status >= 400 || r.body_req).slice(0, 24)].map((r) => ({
    id: r.id, tenant: r.tenant_id, status: r.status, model: r.model_id, provider: r.provider_id ?? "local", agent: r.agent, error: r.error?.slice(0, 200), finish: r.finish_reason, latency_ms: r.latency_ms,
    request: r.body_req ? lastUser(r.body_req) : undefined, response: r.body_res?.slice(0, 300),
  }));
  // A few requests of every tenant → model pair, so a pair that breaks a rule has evidence even when nothing failed.
  const pairs = [...groupBy(rows, (r) => `${r.tenant_id} → ${r.model_id}`)].map(([pair, rs]) => ({ pair, requests: rs.length, provider: rs[0].provider_id ?? "local", examples: rs.slice(0, 2).map((r) => r.id) }));
  return JSON.stringify({ criteria, requests: rows.length, errors: rows.filter((r) => r.status >= 400).length, byTenant: by((r) => r.tenant_id), byModel: by((r) => r.model_id), byProvider: by((r) => r.provider_id ?? "local"), byAgent: by((r) => r.agent), byStatus: by((r) => r.status), byFinish: by((r) => r.finish_reason), tenantModels: pairs.slice(0, 30), samples });
}

function lastUser(body: string): string {
  const b = json<{ messages?: { role: string; content?: unknown }[] }>(body, {});
  const m = [...(b.messages ?? [])].reverse().find((x) => x.role === "user");
  const c = typeof m?.content === "string" ? m.content : JSON.stringify(m?.content ?? "");
  return c.slice(0, 300);
}

const FINDINGS_SCHEMA = {
  type: "object", required: ["findings"], properties: { findings: { type: "array", maxItems: 6, items: { type: "object", required: ["title", "kind", "priority", "description", "suggestion", "evidence"], properties: {
    title: { type: "string" }, kind: { enum: ["needs-attention", "pattern"] }, priority: { enum: ["high", "medium", "low"] }, description: { type: "string" }, suggestion: { type: "string" },
    evidence: { type: "array", maxItems: 4, items: { type: "object", required: ["request_id", "quote"], properties: { request_id: { type: "string" }, quote: { type: "string" } } } } } } } },
};

/** A model's finding, named the same way twice, is the same finding: its title without numbers. */
export const modelKey = (title: string) => `model|${title.toLowerCase().replace(/\d+([.,]\d+)?/g, "#").replace(/[^\p{L}#]+/gu, " ").trim().slice(0, 80)}`;

async function modelFindings(rows: Row[], criteria: string, modelId: string | undefined): Promise<{ findings: Finding[]; model: string | null }> {
  const pick = modelId ? getModel(modelId) : (getRoute("smart")?.candidates ?? []).concat(getRoute("auto")?.candidates ?? []).map(getModel).find((m) => m?.enabled && m.kind === "chat") ?? listModels().find((m) => m.enabled && m.kind === "chat");
  if (!pick) return { findings: [], model: null };
  const top = (k: (r: Row) => string | null) => [...groupBy(rows, (r) => k(r) ?? "")].sort((a, b) => b[1].length - a[1].length).slice(0, 5).map(([v]) => v).filter(Boolean).join(" ");
  const mem = await recall(`${criteria} ${top((r) => r.tenant_id)} ${top((r) => r.model_id)}`, 6);
  const up = await acquire(pick);
  try {
    const r = await fetch(`${up.baseUrl}/chat/completions`, { method: "POST", headers: { "content-type": "application/json", ...up.headers }, signal: AbortSignal.timeout(240_000), body: JSON.stringify({
      model: up.model, temperature: 0.2, max_tokens: 2500,
      response_format: { type: "json_schema", json_schema: { name: "findings", schema: FINDINGS_SCHEMA, strict: true } },
      messages: [
        { role: "system", content: `You review the traffic of an LLM gateway serving SaaS agents. Find recurring problems and notable patterns in the digest. Each finding must cite request ids from the digest (samples or tenantModels examples) as evidence, quoting what shows the problem. Be specific and practical; do not invent requests. Reply as JSON.

mux's brain holds what its operators decided and expect: rules for tenants, preferences, known problems. Check the traffic against it — a tenant on a provider or model it must not use, a known problem coming back — and make each breach a high-priority finding that needs attention, naming the brain page. Do not report what the brain says when the traffic keeps to it.

## From the brain
${mem.block}` },
        { role: "user", content: digest(rows, criteria) },
      ] }) });
    if (!r.ok) throw new Error(`${r.status} ${(await r.text()).slice(0, 200)}`);
    const j = (await r.json()) as { choices: { message: { content: string } }[] };
    const ids = new Set(rows.map((x) => x.id));
    const found = (JSON.parse(j.choices[0].message.content).findings as Omit<Finding, "key" | "source">[]).map((f) => ({ ...f, key: modelKey(f.title), source: "model" as const, evidence: f.evidence.filter((e) => ids.has(e.request_id)) }));
    return { findings: found, model: pick.id };
  } finally { release(pick.id); }
}

/* ── Runs ───────────────────────────────────────────────────────────────────────────────────────────────────── */

/** Which runs compare with each other: a watch's own, or ad-hoc runs over the same slice. */
const scopeOf = (f: LensFilters, watchId?: string) => watchId ? `watch:${watchId}` : `filters:${JSON.stringify([f.tenantId ?? "", f.agent ?? "", f.model ?? "", f.hours ?? 24])}`;

const muted = () => new Set((db.prepare("SELECT key FROM lens_mutes WHERE until IS NULL OR until > ?").all(now()) as { key: string }[]).map((m) => m.key));

const ORDER = { high: 0, medium: 1, low: 2 };
/**
 * Mark findings new or ongoing against the last run of the scope, and list what that run found and this one did not —
 * only what this run looked for: not what is muted now, nor a model's findings when this run asked no model.
 */
export function compare(found: Finding[], prev: Finding[] | null, o: { muted?: Set<string>; modelRan?: boolean } = {}): { findings: Finding[]; resolved: { key: string; title: string }[] } {
  const before = new Set((prev ?? []).map((f) => f.key));
  const nowKeys = new Set(found.map((f) => f.key));
  return {
    findings: found.map((f) => ({ ...f, status: prev && before.has(f.key) ? "ongoing" : "new" })),
    resolved: (prev ?? []).filter((f) => !nowKeys.has(f.key) && !o.muted?.has(f.key) && (f.source !== "model" || o.modelRan !== false)).map((f) => ({ key: f.key, title: f.title })),
  };
}

export function startInvestigation(input: { title?: string; filters: LensFilters; criteria?: string; modelId?: string; useModel?: boolean; watchId?: string }) {
  const id = `lens_${randomBytes(6).toString("hex")}`;
  const filters = input.filters ?? {};
  const scope = scopeOf(filters, input.watchId);
  db.prepare("INSERT INTO lens_runs(id, ts, status, title, filters, criteria, model_id, scope, watch_id) VALUES(?, ?, 'running', ?, ?, ?, ?, ?, ?)")
    .run(id, now(), input.title ?? "Investigation", JSON.stringify(filters), input.criteria ?? "", input.modelId ?? null, scope, input.watchId ?? null);
  void (async () => {
    const t0 = Date.now();
    try {
      const span = (filters.hours ?? 24) * 3600_000;
      let rows = select(filters, t0 - span, t0);
      const eligible = rows.length;
      if (filters.sample && filters.sample < 100) rows = rows.filter(() => Math.random() * 100 < filters.sample!);
      let found = rules(rows, t0);
      let model: string | null = null;
      if (input.useModel !== false && rows.length) {
        try { const m = await modelFindings(rows, input.criteria || "Is the gateway serving its tenants well? What fails, what is slow, what wastes tokens?", input.modelId); found.push(...m.findings); model = m.model; }
        catch (e) { event("warn", "lens", `${id}: the model's pass failed: ${(e as Error).message}`); }
      }
      const mutes = muted();
      const hidden = found.filter((f) => mutes.has(f.key)).length;
      found = found.filter((f) => !mutes.has(f.key));
      found.sort((a, b) => (a.kind === b.kind ? 0 : a.kind === "needs-attention" ? -1 : 1) || ORDER[a.priority] - ORDER[b.priority]);
      const prev = db.prepare("SELECT findings FROM lens_runs WHERE scope = ? AND status = 'done' AND id != ? ORDER BY ts DESC LIMIT 1").get(scope, id) as { findings: string } | undefined;
      const c = compare(found, prev ? json<Finding[]>(prev.findings, []) : null, { muted: mutes, modelRan: model !== null });
      const baseline = { now: metrics(rows), before: metrics(select(filters, t0 - 2 * span, t0 - span)) };
      db.prepare("UPDATE lens_runs SET status = 'done', findings = ?, resolved = ?, baseline = ?, muted = ?, coverage = ?, model_id = ?, duration_ms = ? WHERE id = ?")
        .run(JSON.stringify(c.findings), JSON.stringify(c.resolved), JSON.stringify(baseline), hidden, JSON.stringify({ eligible, screened: rows.length, errors: rows.filter((r) => r.status >= 400).length }), model, Date.now() - t0, id);
      // A watch speaks up when something new needs attention: the event reaches the assistant's and the healer's view.
      const fresh = c.findings.filter((f) => f.status === "new" && (f.priority === "high" || (f.kind === "needs-attention" && f.priority === "medium")));
      if (input.watchId && fresh.length) event("warn", "lens", `${input.title ?? "Watch"}: ${fresh.length} new finding(s) — ${fresh.slice(0, 3).map((f) => f.title).join("; ")}`, { run: id, keys: fresh.map((f) => f.key) });
    } catch (e) {
      db.prepare("UPDATE lens_runs SET status = 'error', error = ?, duration_ms = ? WHERE id = ?").run((e as Error).message, Date.now() - t0, id);
    }
  })();
  return id;
}

const fromRun = (r: Record<string, string>) => ({ ...r, filters: json(r.filters, {}), coverage: json(r.coverage, null), findings: json(r.findings, []), resolved: json(r.resolved, []), baseline: json(r.baseline, null) });
export const listInvestigations = (watchId?: string, limit = 50) =>
  (db.prepare(`SELECT * FROM lens_runs ${watchId ? "WHERE watch_id = ?" : ""} ORDER BY ts DESC LIMIT ?`).all(...(watchId ? [watchId] : []), Math.min(Math.max(limit, 1), 200)) as Record<string, string>[]).map(fromRun);

/* ── Watches ────────────────────────────────────────────────────────────────────────────────────────────────── */

export interface Watch { id: string; title: string; filters: LensFilters; criteria: string; every_hours: number; use_model: boolean; model_id: string | null; enabled: boolean; last_run: number | null; last_run_id: string | null; created_at: number }
interface WatchRow { id: string; title: string; filters: string; criteria: string | null; every_hours: number; use_model: number; model_id: string | null; enabled: number; last_run: number | null; last_run_id: string | null; created_at: number }
const fromWatch = (w: WatchRow): Watch => ({ ...w, filters: json(w.filters, {}), criteria: w.criteria ?? "", use_model: !!w.use_model, enabled: !!w.enabled });
export const listWatches = () => (db.prepare("SELECT * FROM lens_watches ORDER BY created_at").all() as WatchRow[]).map(fromWatch);
const getWatch = (id: string) => { const w = db.prepare("SELECT * FROM lens_watches WHERE id = ?").get(id) as WatchRow | undefined; return w ? fromWatch(w) : undefined; };

export function upsertWatch(id: string, b: Partial<Watch>): Watch {
  const w = { ...(getWatch(id) ?? { id, title: "Watch", filters: {}, criteria: "", every_hours: 6, use_model: true, model_id: null, enabled: true, last_run: null, last_run_id: null, created_at: now() }), ...b, id };
  w.every_hours = Math.max(0.25, Number(w.every_hours) || 6);
  db.prepare(`INSERT INTO lens_watches(id, title, filters, criteria, every_hours, use_model, model_id, enabled, last_run, last_run_id, created_at) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET title = excluded.title, filters = excluded.filters, criteria = excluded.criteria, every_hours = excluded.every_hours, use_model = excluded.use_model, model_id = excluded.model_id, enabled = excluded.enabled`)
    .run(id, w.title, JSON.stringify(w.filters ?? {}), w.criteria ?? "", w.every_hours, w.use_model ? 1 : 0, w.model_id || null, w.enabled ? 1 : 0, w.last_run, w.last_run_id, w.created_at);
  return getWatch(id)!;
}

export function runWatch(w: Watch) {
  const id = startInvestigation({ title: w.title, filters: w.filters, criteria: w.criteria, useModel: w.use_model, modelId: w.model_id ?? undefined, watchId: w.id });
  db.prepare("UPDATE lens_watches SET last_run = ?, last_run_id = ? WHERE id = ?").run(now(), id, w.id);
  return id;
}

/** Every minute: start the one watch most overdue, if no investigation is running (one model pass at a time). */
export function tickWatches(at = now()) {
  if (db.prepare("SELECT 1 FROM lens_runs WHERE status = 'running' LIMIT 1").get()) return null;
  const due = listWatches().filter((w) => w.enabled && (w.last_run ?? 0) + w.every_hours * 3600_000 <= at).sort((a, b) => (a.last_run ?? 0) - (b.last_run ?? 0))[0];
  return due ? runWatch(due) : null;
}

export function startLens() {
  // A run cut off by a restart never finishes: say so instead of showing it running for ever.
  db.prepare("UPDATE lens_runs SET status = 'error', error = 'mux restarted during the investigation' WHERE status = 'running'").run();
  if (!db.prepare("SELECT 1 FROM lens_watches LIMIT 1").get())
    // Its first run half an hour after mux first starts with Lens, not in the rush of a start.
    upsertWatch("every-6h", { title: "Every 6 hours", last_run: now() - 5.5 * 3600_000, filters: { hours: 6 }, criteria: "Is every tenant served well and as the brain says it should be? What fails, what is slow, what wastes tokens or money, what loops?", every_hours: 6, use_model: true });
  setInterval(() => { try { tickWatches(); } catch (e) { event("warn", "lens", `watches: ${(e as Error).message}`); } }, 60_000).unref();
}

/* ── Admin API ──────────────────────────────────────────────────────────────────────────────────────────────── */

export function registerLens(api: FastifyInstance) {
  api.get("/lens", async (req) => { const q = req.query as { watch?: string; limit?: string }; return listInvestigations(q.watch || undefined, Number(q.limit) || 50); });
  api.get("/lens/runs/:id", async (req, reply) => { const r = db.prepare("SELECT * FROM lens_runs WHERE id = ?").get((req.params as { id: string }).id) as Record<string, string> | undefined; return r ? fromRun(r) : reply.code(404).send({ error: "no such investigation" }); });
  api.post("/lens", async (req) => ({ id: startInvestigation(req.body as never) }));
  api.get("/lens/watches", async () => listWatches().map((w) => ({ ...w, next_run: w.enabled ? (w.last_run ?? 0) + w.every_hours * 3600_000 : null })));
  api.put("/lens/watches/:id", async (req) => upsertWatch((req.params as { id: string }).id, req.body as Partial<Watch>));
  api.delete("/lens/watches/:id", async (req) => ({ ok: db.prepare("DELETE FROM lens_watches WHERE id = ?").run((req.params as { id: string }).id).changes > 0 }));
  api.post("/lens/watches/:id/run", async (req, reply) => { const w = getWatch((req.params as { id: string }).id); return w ? { id: runWatch(w) } : reply.code(404).send({ error: "no such watch" }); });
  api.get("/lens/mutes", async () => db.prepare("SELECT * FROM lens_mutes WHERE until IS NULL OR until > ? ORDER BY created_at DESC").all(now()));
  api.post("/lens/mutes", async (req, reply) => {
    const b = req.body as { key?: string; title?: string; days?: number };
    if (!b?.key) return reply.code(400).send({ error: "key is required" });
    db.prepare("INSERT INTO lens_mutes(key, title, until, created_at) VALUES(?, ?, ?, ?) ON CONFLICT(key) DO UPDATE SET title = excluded.title, until = excluded.until")
      .run(b.key, b.title ?? b.key, b.days ? now() + b.days * 86400_000 : null, now());
    return { ok: true };
  });
  api.delete("/lens/mutes/:key", async (req) => ({ ok: db.prepare("DELETE FROM lens_mutes WHERE key = ?").run((req.params as { key: string }).key).changes > 0 }));
}
