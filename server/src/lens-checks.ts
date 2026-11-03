import { getModel } from "./models.js";
import { outside } from "./router/border.js";
import { getTenant } from "./tenants.js";
import type { Finding, Row } from "./lens.js";

/**
 * Lens's model writes findings that read well; these checks decide whether they are true. The model states each
 * finding's claims in a form mux can test against its own requests and settings — how many, what share failed, how
 * slow, which tool a response called, whether a tenant ran outside its data border — and:
 *
 *   a claim that is false     → the finding is rejected (kept, with why, so the owner sees what Lens threw away)
 *   no claim can be checked   → a guess: priority low at most
 *   all claims hold           → checked; high only with at least 3 requests behind it, and a claim that pins down
 *                               the thing itself (the error, the tool, the finish reason, the border) — "18 errors on
 *                               qwen" holds for any story about qwen's errors, so it alone does not make one high
 *
 * The owner, 2026-11-03: Lens must not cry wolf, or the day something is really wrong it will be ignored.
 */
export interface Claim {
  kind: "count" | "rate" | "latency" | "tool" | "border";
  tenant: string | null; model: string | null; agent: string | null;
  status: "any" | "error" | "ok"; finish: string | null; tool: string | null;
  /** Part of the error message or type the matching requests failed with, e.g. "context" or "client_closed". */
  error: string | null;
  op: ">=" | "<="; value: number;
}
export interface Check { claim: string; ok: boolean | null; actual: string }

export const CLAIM_SCHEMA = {
  type: "object", required: ["kind", "tenant", "model", "agent", "status", "finish", "tool", "error", "op", "value"],
  properties: {
    kind: { enum: ["count", "rate", "latency", "tool", "border"] },
    tenant: { type: ["string", "null"] }, model: { type: ["string", "null"] }, agent: { type: ["string", "null"] },
    status: { enum: ["any", "error", "ok"] }, finish: { type: ["string", "null"] }, tool: { type: ["string", "null"] }, error: { type: ["string", "null"] },
    op: { enum: [">=", "<="] }, value: { type: "number" },
  },
};

export const CLAIMS_HELP = `Each finding lists "claims": the facts it rests on, which mux checks against the traffic and its settings before you are believed.
- count: requests matching tenant/model/agent (null = any), status (any|error|ok), finish reason and error (a part of the error message or type, e.g. "context", "client_closed"), compared with value (op >= or <=)
- rate: the share of matching requests that failed, 0 to 1, compared with value
- latency: the p95 latency in ms of matching requests, compared with value
- tool: matching requests whose response called the tool named in "tool", compared with value (0 with op <= means it was never called)
- border: the tenant ran on a model outside its data border (value ignored)
A false claim rejects the finding. A finding whose claims cannot be checked is shown as a guess at low priority. High priority needs claims that hold, at least 3 requests behind them, and a claim that pins down what the title says (the error, the tool, the finish reason or the border) — a plain count of errors is not enough. Do not claim what the digest does not show.`;

const p95 = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(0.95 * s.length))]; };
const cmp = (a: number, op: Claim["op"], b: number) => (op === ">=" ? a >= b : a <= b);
const failedWith = (r: Row, e: string) => `${r.error ?? ""} ${r.error_type ?? ""}`.toLowerCase().includes(e.toLowerCase());
const calls = (r: Row, tool: string) => !!r.body_res && (r.body_res.includes(`"name":"${tool}"`) || r.body_res.includes(`"name": "${tool}"`));

export function describe(c: Claim): string {
  const who = [c.tenant && `tenant ${c.tenant}`, c.model && `model ${c.model}`, c.agent && `agent ${c.agent}`, c.status !== "any" && `${c.status} requests`, c.finish && `finish ${c.finish}`, c.error && `failing with “${c.error}”`].filter(Boolean).join(", ") || "all requests";
  if (c.kind === "border") return `${c.tenant ?? "a tenant"} ran outside its data border${c.model ? ` on ${c.model}` : ""}`;
  if (c.kind === "rate") return `error rate of ${who} ${c.op} ${(c.value * 100).toFixed(1)}%`;
  if (c.kind === "latency") return `p95 latency of ${who} ${c.op} ${c.value} ms`;
  if (c.kind === "tool") return `${who} calling ${c.tool}: ${c.op} ${c.value}`;
  return `${who}: ${c.op} ${c.value}`;
}

/** One claim against the requests: true, false, or null when mux cannot tell. `support` is how many requests show it. */
export function check(c: Claim, rows: Row[]): Check & { support: number } {
  const claim = describe(c);
  if (c.tenant && !rows.some((r) => r.tenant_id === c.tenant)) return { claim, ok: c.kind === "count" ? cmp(0, c.op, c.value) : false, actual: `no requests from tenant ${c.tenant}`, support: 0 };
  if (c.model && !rows.some((r) => r.model_id === c.model)) return { claim, ok: c.kind === "count" ? cmp(0, c.op, c.value) : false, actual: `no requests to model ${c.model}`, support: 0 };
  const scope = rows.filter((r) => (!c.tenant || r.tenant_id === c.tenant) && (!c.model || r.model_id === c.model) && (!c.agent || r.agent === c.agent));
  const match = scope.filter((r) => (c.status === "any" || (c.status === "error") === (r.status >= 400)) && (!c.finish || r.finish_reason === c.finish) && (!c.error || failedWith(r, c.error)));
  switch (c.kind) {
    case "count": return { claim, ok: cmp(match.length, c.op, c.value), actual: `${match.length} requests`, support: match.length };
    case "rate": {
      if (!scope.length) return { claim, ok: null, actual: "no matching requests", support: 0 };
      const errs = scope.filter((r) => r.status >= 400).length;
      return { claim, ok: cmp(errs / scope.length, c.op, c.value), actual: `${errs} of ${scope.length} failed (${((100 * errs) / scope.length).toFixed(1)}%)`, support: errs };
    }
    case "latency": {
      if (!match.length) return { claim, ok: null, actual: "no matching requests", support: 0 };
      const v = p95(match.map((r) => r.latency_ms));
      return { claim, ok: cmp(v, c.op, c.value), actual: `p95 ${v} ms over ${match.length} requests`, support: match.length };
    }
    case "tool": {
      if (!c.tool) return { claim, ok: null, actual: "no tool named", support: 0 };
      const logged = match.filter((r) => r.body_res);
      // Responses are kept only for tenants that log bodies: without them, mux cannot know what was called
      if (!logged.length) return { claim, ok: null, actual: `${match.length} requests, none with its response kept`, support: 0 };
      const n = logged.filter((r) => calls(r, c.tool!)).length;
      return { claim, ok: cmp(n, c.op, c.value), actual: `${n} of ${logged.length} kept responses called ${c.tool}`, support: logged.length };
    }
    case "border": {
      const crossed = match.filter((r) => {
        const t = getTenant(r.tenant_id), m = r.model_id ? getModel(r.model_id) : undefined;
        return t && m && r.status < 400 && outside(t.data_border, m);
      });
      const borders = [...new Set(scope.map((r) => getTenant(r.tenant_id)?.data_border ?? "any"))].join(", ");
      return { claim, ok: crossed.length > 0, actual: crossed.length ? `${crossed.length} requests ran outside the border` : `none did: the border is ${borders || "any"}`, support: crossed.length };
    }
  }
}

export type Grounded = { finding: Finding } | { rejected: { title: string; reason: string; checks: Check[] } };

/** Decide what a model's finding is worth: checked, a guess, or rejected. */
export function ground(f: Finding & { claims?: Claim[] }, rows: Row[]): Grounded {
  const { claims = [], ...rest } = f;
  const results = claims.map((c) => check(c, rows));
  const checks = results.map(({ support: _s, ...c }) => c);
  const wrong = checks.filter((c) => c.ok === false);
  if (wrong.length) return { rejected: { title: f.title, reason: wrong.map((c) => `“${c.claim}” is not so: ${c.actual}`).join("; "), checks } };
  const held = results.filter((c) => c.ok === true);
  const support = Math.max(0, ...held.map((c) => c.support));
  if (!held.length || !f.evidence.length) return { finding: { ...rest, priority: "low", confidence: "guess", checks } };
  const allHeld = held.length === results.length;
  // Pinned down: a claim about the very error, tool, finish reason or border — not just "requests" or "errors"
  const pinned = claims.some((c, i) => results[i].ok === true && (c.kind === "border" || c.kind === "tool" || !!c.error || !!c.finish));
  const priority = f.priority === "high" && (support < 3 || !allHeld || !pinned) ? "medium" : f.priority;
  return { finding: { ...rest, priority, confidence: "checked", checks } };
}
