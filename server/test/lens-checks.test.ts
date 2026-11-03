import { test } from "node:test";
import assert from "node:assert/strict";

const { ground, check } = await import("../src/lens-checks.js");
const { upsertModel } = await import("../src/models.js");
const { upsertTenant } = await import("../src/tenants.js");
type Row = import("../src/lens.js").Row;
type Finding = import("../src/lens.js").Finding;
type Claim = import("../src/lens-checks.js").Claim;

let n = 0;
const row = (o: Partial<Row> = {}): Row => ({
  id: `r${++n}`, ts: Date.now() - n * 1000, tenant_id: "nexus", agent: null, trace_id: null, endpoint: "openai.chat", model_id: "qwen-local", provider_id: null, route: "auto",
  status: 200, error_type: null, error: null, latency_ms: 800, ttft_ms: 200, prompt_tokens: 1000, completion_tokens: 100, fallbacks: 0, cold_start: 0,
  finish_reason: "stop", forced_tool: 0, tools: 0, stream: 0, cost_usd: 0, body_req: null, body_res: null, route_reason: null, ...o,
});
const claim = (o: Partial<Claim>): Claim => ({ kind: "count", tenant: null, model: null, agent: null, status: "any", finish: null, tool: null, error: null, op: ">=", value: 1, ...o });
const finding = (o: Partial<Finding> & { claims?: Claim[] }, rows: Row[]) => ({
  key: "model|x", source: "model" as const, kind: "needs-attention" as const, priority: "high" as const, title: "x", description: "", suggestion: "",
  evidence: rows.slice(0, 2).map((r) => ({ request_id: r.id, quote: "" })), ...o,
});

upsertModel({ id: "qwen-local", backend: "llamacpp", kind: "chat", ctx: 32768 });
upsertTenant({ id: "nexus", name: "Nexus", data_border: "any" });

test("2026-11-03: 'nexus breaks its border' on a local model, with no border set, is rejected", () => {
  const rows = [row({ status: 499, error: "the caller went away" }), row(), row(), row()];
  const g = ground(finding({ title: "Tenant nexus violating provider policy", claims: [claim({ kind: "border", tenant: "nexus", model: "qwen-local" })] }, rows), rows);
  assert.ok("rejected" in g, "rejected");
  assert.match(g.rejected.reason, /border is any/);
});

test("2026-11-03: 'assistant does not use brain_search' cannot be checked without kept responses: a guess at low", () => {
  const rows = Array.from({ length: 28 }, () => row({ tenant_id: "assistant" }));
  upsertTenant({ id: "assistant", name: "Assistant" });
  const g = ground(finding({ title: "Assistant not using brain_search", claims: [claim({ kind: "tool", tenant: "assistant", tool: "brain_search", op: "<=", value: 0 })] }, rows), rows);
  assert.ok("finding" in g);
  assert.equal(g.finding.priority, "low");
  assert.equal(g.finding.confidence, "guess");
});

test("with kept responses the tool claim is checked — and a false one rejects the finding", () => {
  const called = JSON.stringify({ choices: [{ message: { tool_calls: [{ function: { name: "brain_search", arguments: "{}" } }] } }] });
  const rows = [row({ tenant_id: "assistant", body_res: called }), row({ tenant_id: "assistant", body_res: "{}" })];
  const c = check(claim({ kind: "tool", tenant: "assistant", tool: "brain_search", op: "<=", value: 0 }), rows);
  assert.equal(c.ok, false);
  assert.match(c.actual, /1 of 2/);
});

test("a single failed request is not a high alarm; three or more that hold are", () => {
  const one = [row({ status: 500 }), row(), row()];
  const g1 = ground(finding({ claims: [claim({ status: "error", tenant: "nexus" })] }, one), one);
  assert.ok("finding" in g1 && g1.finding.priority === "medium" && g1.finding.confidence === "checked");
  const many = [row({ status: 500, error: "context length exceeded" }), row({ status: 500, error: "context length exceeded" }), row({ status: 500, error: "context length exceeded" }), row()];
  const g3 = ground(finding({ claims: [claim({ status: "error", tenant: "nexus", error: "context", value: 3 })] }, many), many);
  assert.ok("finding" in g3 && g3.finding.priority === "high");
  // a plain error count holds for any story about these errors: medium at most
  const plain = ground(finding({ title: "Context overflow", claims: [claim({ status: "error", tenant: "nexus", value: 3 })] }, many), many);
  assert.ok("finding" in plain && plain.finding.priority === "medium");
  // and a story about errors these requests did not fail with is rejected
  const wrong = ground(finding({ title: "Timeouts", claims: [claim({ status: "error", error: "timeout", value: 3 })] }, many), many);
  assert.ok("rejected" in wrong);
});

test("no claims, or no evidence, is a guess", () => {
  const rows = [row(), row()];
  const g = ground(finding({ claims: [] }, rows), rows);
  assert.ok("finding" in g && g.finding.confidence === "guess" && g.finding.priority === "low");
});

test("a claim about a tenant or model with no requests is false", () => {
  const rows = [row()];
  assert.equal(check(claim({ kind: "rate", tenant: "ghost", value: 0.5 }), rows).ok, false);
  assert.equal(check(claim({ kind: "latency", op: ">=", value: 500 }), rows).ok, true);
});
