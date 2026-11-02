import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "mux-lens-"));
process.env.MUX_HOME = dir;
process.env.MUX_DB = join(dir, "mux.db");
process.env.MUX_PORT = "1";
const { compare, metrics, modelKey, rules, tickWatches, upsertWatch } = await import("../src/lens.js");
const { db } = await import("../src/db.js");
const { upsertModel } = await import("../src/models.js");
const { upsertTenant } = await import("../src/tenants.js");
type Row = import("../src/lens.js").Row;

const T0 = new Date(2026, 10, 16, 12).getTime(); // halfway through November
let n = 0;
const row = (o: Partial<Row> = {}): Row => ({
  id: `r${++n}`, ts: T0 - n * 1000, tenant_id: "nexus", agent: null, trace_id: null, endpoint: "openai.chat", model_id: "qwen", provider_id: null, route: "auto",
  status: 200, error_type: null, error: null, latency_ms: 800, ttft_ms: 200, prompt_tokens: 1000, completion_tokens: 100, fallbacks: 0, cold_start: 0,
  finish_reason: "stop", forced_tool: 0, tools: 0, stream: 0, cost_usd: 0, body_req: null, body_res: null, route_reason: null, ...o,
});
const keys = (rs: Row[]) => rules(rs, T0).map((f) => f.key);

test("a healthy slice has no findings", () => {
  assert.deepEqual(keys(Array.from({ length: 50 }, () => row())), []);
});

test("empty answers, full contexts and repeated requests are found", () => {
  upsertModel({ id: "qwen", backend: "external", kind: "chat", ctx: 32768 });
  const body = JSON.stringify({ messages: [{ role: "user", content: "what is the weather" }] });
  const rs = [
    ...Array.from({ length: 3 }, () => row({ completion_tokens: 0 })),
    ...Array.from({ length: 3 }, () => row({ prompt_tokens: 30_000 })),
    ...Array.from({ length: 6 }, () => row({ body_req: body })),
  ];
  const k = keys(rs);
  for (const want of ["empty", "context-full", "repeats"]) assert.ok(k.includes(want), `${want} in ${k}`);
});

test("a retry storm: many failures from one tenant inside a minute", () => {
  const rs = Array.from({ length: 25 }, (_, i) => row({ ts: T0 - i * 100, status: 503, error_type: "all_models_failed", error: "busy" }));
  const f = rules(rs, T0).find((x) => x.key === "storm|nexus");
  assert.ok(f);
  assert.equal(f.priority, "high");
});

test("budgets: a tenant on pace to run out before the month ends", () => {
  upsertTenant({ id: "acme", name: "Acme", monthly_usd_budget: 10 });
  // $6 spent halfway through the month → $12 by the end.
  db.prepare("INSERT INTO requests(id, ts, tenant_id, endpoint, status, cost_usd) VALUES('b1', ?, 'acme', 'openai.chat', 200, 6)").run(T0 - 3600_000);
  const f = rules([row({ tenant_id: "acme" })], T0).find((x) => x.key === "budget|acme|USD");
  assert.ok(f);
  assert.match(f.title, /Acme will use up its monthly USD budget around 2026-11-2/);
});

test("spend: one tenant on one paid model taking most of it", () => {
  const rs = [...Array.from({ length: 4 }, () => row({ model_id: "openai/gpt", cost_usd: 1 })), row({ tenant_id: "other", model_id: "openai/gpt", cost_usd: 0.5 })];
  assert.ok(keys(rs).includes("spend|nexus|openai/gpt"));
});

test("compare: new, ongoing and resolved against the last run", () => {
  const f = (key: string) => ({ key, title: key, kind: "pattern" as const, priority: "low" as const, description: "", suggestion: "", evidence: [], source: "rules" as const });
  const c = compare([f("a"), f("b")], [f("b"), f("c")]);
  assert.deepEqual(c.findings.map((x) => x.status), ["new", "ongoing"]);
  assert.deepEqual(c.resolved.map((x) => x.key), ["c"]);
  assert.deepEqual(compare([f("a")], null).findings.map((x) => x.status), ["new"]);
  // Not resolved: what is muted, and a model's finding when no model looked this time.
  const m = { ...f("m"), source: "model" as const };
  assert.deepEqual(compare([], [f("x"), m]).resolved.map((x) => x.key), ["x", "m"]);
  assert.deepEqual(compare([], [f("x"), m], { muted: new Set(["x"]), modelRan: false }).resolved, []);
});

test("a model's finding keeps its key when only its numbers change", () => {
  assert.equal(modelKey("Nexus sent 12 requests to OpenAI"), modelKey("Nexus sent 340 requests to OpenAI!"));
  assert.notEqual(modelKey("Nexus sent requests to OpenAI"), modelKey("Acme sent requests to OpenAI"));
});

test("metrics: error rate, p95 latency, tokens per request, cost", () => {
  const m = metrics([row({ latency_ms: 100, cost_usd: 0.5 }), row({ status: 500 }), row({ latency_ms: 300 })]);
  assert.equal(m.requests, 3);
  assert.equal(m.errorRate, 1 / 3);
  assert.equal(m.latencyP95, 300);
  assert.equal(m.costUsd, 0.5);
});

test("watches: due ones run, one at a time, and not again until their interval has passed", async () => {
  upsertWatch("w", { title: "Hourly", filters: { hours: 1 }, every_hours: 1, use_model: false });
  const id = tickWatches();
  assert.ok(id);
  assert.equal(tickWatches(), null); // running, or not due
  for (let i = 0; i < 50 && (db.prepare("SELECT status FROM lens_runs WHERE id = ?").get(id) as { status: string }).status === "running"; i++) await new Promise((r) => setTimeout(r, 20));
  assert.equal((db.prepare("SELECT status FROM lens_runs WHERE id = ?").get(id) as { status: string }).status, "done");
  assert.equal(tickWatches(), null);
  assert.ok(tickWatches(Date.now() + 3601_000));
});
