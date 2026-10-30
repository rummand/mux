import { randomBytes } from "node:crypto";
import { db, event, json, now } from "./db.js";
import { getModel, getRoute, listModels } from "./models.js";
import { acquire, release } from "./runtime/manager.js";

/**
 * Lens (after LiteLLM's): an investigation reads a slice of traffic — a tenant, an agent, a time window — and writes
 * findings, each with the requests that are its evidence. Rules find what can be counted (error clusters, truncated
 * answers, fallbacks, cold starts, runaway traces); a local model then reads the digest and samples for what cannot,
 * against the criteria the investigation was given. Nothing leaves the Mac.
 */
export interface Finding {
  title: string; kind: "needs-attention" | "pattern"; priority: "high" | "medium" | "low";
  description: string; suggestion: string; evidence: { request_id: string; quote: string }[]; source: "rules" | "model";
}
export interface LensFilters { tenantId?: string; agent?: string; model?: string; hours?: number; sample?: number }

interface Row { id: string; ts: number; tenant_id: string; agent: string | null; trace_id: string | null; endpoint: string; model_id: string | null; route: string | null; status: number; error_type: string | null; error: string | null; latency_ms: number; ttft_ms: number | null; prompt_tokens: number; completion_tokens: number; fallbacks: number; cold_start: number; finish_reason: string | null; forced_tool: number; tools: number; body_req: string | null; body_res: string | null; route_reason: string | null }

function select(f: LensFilters): Row[] {
  const where = ["ts >= ?"]; const args: unknown[] = [now() - (f.hours ?? 24) * 3600_000];
  if (f.tenantId) { where.push("tenant_id = ?"); args.push(f.tenantId); }
  if (f.agent) { where.push("agent = ?"); args.push(f.agent); }
  if (f.model) { where.push("model_id = ?"); args.push(f.model); }
  return db.prepare(`SELECT * FROM requests WHERE ${where.join(" AND ")} ORDER BY ts DESC LIMIT 20000`).all(...args) as Row[];
}

const pct = (xs: number[], p: number) => { if (!xs.length) return 0; const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]; };

function rules(rows: Row[]): Finding[] {
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
      source: "rules", kind: "needs-attention", priority: share > 0.05 || rs.length > 50 ? "high" : rs.length > 5 ? "medium" : "low",
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
  const truncated = rows.filter((r) => r.finish_reason === "length");
  if (truncated.length >= 3) out.push({ source: "rules", kind: "needs-attention", priority: truncated.length / rows.length > 0.05 ? "high" : "medium",
    title: `${truncated.length} answers cut off by max_tokens`, description: "The model stopped because it ran out of tokens, so the caller got half an answer (or half a JSON).",
    suggestion: "Raise max_tokens for these calls, or turn reasoning off for the model if thinking eats the budget.", evidence: truncated.slice(0, 5).map((r) => ({ request_id: r.id, quote: `${r.completion_tokens} tokens on ${r.model_id}` })) });
  const fb = rows.filter((r) => r.fallbacks > 0);
  if (fb.length >= 3) out.push({ source: "rules", kind: "pattern", priority: "medium", title: `${fb.length} requests needed a fallback`,
    description: `The first candidate failed and mux answered with the next. Routes affected: ${[...new Set(fb.map((r) => r.route))].join(", ")}.`,
    suggestion: "Check the first candidate's health; fallbacks hide failures from callers but add latency.", evidence: fb.slice(0, 5).map((r) => ({ request_id: r.id, quote: r.route_reason?.slice(0, 160) ?? "" })) });
  const cold = rows.filter((r) => r.cold_start);
  if (cold.length >= 3) out.push({ source: "rules", kind: "pattern", priority: "medium", title: `${cold.length} requests waited for a model to load`,
    description: `Median latency of those: ${pct(cold.map((r) => r.latency_ms), 50)} ms.`, suggestion: "Pin the model or raise its keep-alive so it stays loaded between bursts.",
    evidence: cold.slice(0, 5).map((r) => ({ request_id: r.id, quote: `${r.model_id}: ${r.latency_ms} ms` })) });
  const traces = new Map<string, Row[]>();
  for (const r of rows) if (r.trace_id) traces.set(r.trace_id, [...(traces.get(r.trace_id) ?? []), r]);
  const runaway = [...traces].filter(([, rs]) => rs.length >= 25).sort((a, b) => b[1].length - a[1].length);
  if (runaway.length) out.push({ source: "rules", kind: "needs-attention", priority: "high", title: `${runaway.length} agent run(s) with 25+ model calls`,
    description: `The longest: trace ${runaway[0][0]} made ${runaway[0][1].length} calls (${runaway[0][1].reduce((a, r) => a + r.prompt_tokens + r.completion_tokens, 0).toLocaleString()} tokens). Agents that loop burn the Mac's time for every tenant.`,
    suggestion: "Give the agent a step limit, or look at the trace for a tool it keeps retrying.", evidence: runaway.slice(0, 5).map(([t, rs]) => ({ request_id: rs[0].id, quote: `trace ${t}: ${rs.length} calls` })) });
  const lat = rows.filter((r) => r.status < 400).map((r) => r.latency_ms);
  if (lat.length >= 20) {
    const p50 = pct(lat, 50), p95 = pct(lat, 95);
    if (p95 > p50 * 5 && p95 > 5000) {
      const slow = rows.filter((r) => r.latency_ms >= p95).slice(0, 5);
      out.push({ source: "rules", kind: "pattern", priority: "low", title: `A long latency tail: p95 ${p95} ms against p50 ${p50} ms`, description: "A few requests take far longer than most.",
        suggestion: "Compare their prompt sizes and models; long prompts may belong on a route with a faster prefill.", evidence: slow.map((r) => ({ request_id: r.id, quote: `${r.latency_ms} ms, ${r.prompt_tokens} prompt tokens, ${r.model_id}` })) });
    }
  }
  return out;
}

function digest(rows: Row[], criteria: string) {
  const by = (k: keyof Row) => Object.entries(rows.reduce<Record<string, number>>((a, r) => { const v = String(r[k] ?? "-"); a[v] = (a[v] ?? 0) + 1; return a; }, {})).sort((a, b) => b[1] - a[1]).slice(0, 8);
  const samples = [...rows.filter((r) => r.status >= 400 || r.body_req).slice(0, 24)].map((r) => ({
    id: r.id, status: r.status, model: r.model_id, agent: r.agent, error: r.error?.slice(0, 200), finish: r.finish_reason, latency_ms: r.latency_ms,
    request: r.body_req ? lastUser(r.body_req) : undefined, response: r.body_res?.slice(0, 300),
  }));
  return JSON.stringify({ criteria, requests: rows.length, errors: rows.filter((r) => r.status >= 400).length, byModel: by("model_id"), byAgent: by("agent"), byStatus: by("status"), byFinish: by("finish_reason"), samples });
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

async function modelFindings(rows: Row[], criteria: string, modelId: string | undefined): Promise<{ findings: Finding[]; model: string | null }> {
  const pick = modelId ? getModel(modelId) : (getRoute("smart")?.candidates ?? []).concat(getRoute("auto")?.candidates ?? []).map(getModel).find((m) => m?.enabled && m.kind === "chat") ?? listModels().find((m) => m.enabled && m.kind === "chat");
  if (!pick) return { findings: [], model: null };
  const up = await acquire(pick);
  try {
    const r = await fetch(`${up.baseUrl}/chat/completions`, { method: "POST", headers: { "content-type": "application/json", ...up.headers }, signal: AbortSignal.timeout(240_000), body: JSON.stringify({
      model: up.model, temperature: 0.2, max_tokens: 2500,
      response_format: { type: "json_schema", json_schema: { name: "findings", schema: FINDINGS_SCHEMA, strict: true } },
      messages: [
        { role: "system", content: "You review the traffic of an LLM gateway serving SaaS agents. Find recurring problems and notable patterns in the digest. Each finding must cite request ids from the samples as evidence, quoting what shows the problem. Be specific and practical; do not invent requests. Reply as JSON." },
        { role: "user", content: digest(rows, criteria) },
      ] }) });
    if (!r.ok) throw new Error(`${r.status} ${(await r.text()).slice(0, 200)}`);
    const j = (await r.json()) as { choices: { message: { content: string } }[] };
    const ids = new Set(rows.map((x) => x.id));
    const found = (JSON.parse(j.choices[0].message.content).findings as Finding[]).map((f) => ({ ...f, source: "model" as const, evidence: f.evidence.filter((e) => ids.has(e.request_id)) }));
    return { findings: found, model: pick.id };
  } finally { release(pick.id); }
}

export function startInvestigation(input: { title?: string; filters: LensFilters; criteria?: string; modelId?: string; useModel?: boolean }) {
  const id = `lens_${randomBytes(6).toString("hex")}`;
  db.prepare("INSERT INTO lens_runs(id, ts, status, title, filters, criteria, model_id) VALUES(?, ?, 'running', ?, ?, ?, ?)").run(id, now(), input.title ?? "Investigation", JSON.stringify(input.filters), input.criteria ?? "", input.modelId ?? null);
  void (async () => {
    const t0 = Date.now();
    try {
      let rows = select(input.filters);
      const eligible = rows.length;
      if (input.filters.sample && input.filters.sample < 100) rows = rows.filter(() => Math.random() * 100 < input.filters.sample!);
      const found = rules(rows);
      let model: string | null = null;
      if (input.useModel !== false && rows.length) {
        try { const m = await modelFindings(rows, input.criteria || "Is the gateway serving its tenants well? What fails, what is slow, what wastes tokens?", input.modelId); found.push(...m.findings); model = m.model; }
        catch (e) { event("warn", "lens", `${id}: the model's pass failed: ${(e as Error).message}`); }
      }
      const order = { high: 0, medium: 1, low: 2 };
      found.sort((a, b) => (a.kind === b.kind ? 0 : a.kind === "needs-attention" ? -1 : 1) || order[a.priority] - order[b.priority]);
      db.prepare("UPDATE lens_runs SET status = 'done', findings = ?, coverage = ?, model_id = ?, duration_ms = ? WHERE id = ?")
        .run(JSON.stringify(found), JSON.stringify({ eligible, screened: rows.length, errors: rows.filter((r) => r.status >= 400).length }), model, Date.now() - t0, id);
    } catch (e) {
      db.prepare("UPDATE lens_runs SET status = 'error', error = ?, duration_ms = ? WHERE id = ?").run((e as Error).message, Date.now() - t0, id);
    }
  })();
  return id;
}

export const listInvestigations = () => (db.prepare("SELECT * FROM lens_runs ORDER BY ts DESC LIMIT 50").all() as Record<string, string>[]).map((r) => ({ ...r, filters: json(r.filters, {}), coverage: json(r.coverage, null), findings: json(r.findings, []) }));
