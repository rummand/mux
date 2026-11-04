import { test } from "node:test";
import assert from "node:assert/strict";

const { affinityKey, unit } = await import("../src/router/affinity.js");
const { decide } = await import("../src/router/select.js");
const { upsertModel, upsertRoute } = await import("../src/models.js");
const { getTenant, upsertTenant } = await import("../src/tenants.js");

const sys = { role: "system", content: "You are a coding agent." };
const ask = { role: "user", content: "Fix the failing test in parser.ts" };

test("every call of one agent loop has the same key; another conversation or tenant does not", () => {
  const first = affinityKey("t1", null, [sys, ask]);
  const later = affinityKey("t1", null, [sys, ask, { role: "assistant", content: "…" }, { role: "tool", content: "ok" }, { role: "user", content: "and now the docs" }]);
  assert.ok(first);
  assert.equal(first, later);
  assert.notEqual(first, affinityKey("t1", null, [sys, { role: "user", content: "Something else" }]));
  assert.notEqual(first, affinityKey("t2", null, [sys, ask]));
  assert.equal(affinityKey("t1", "run-42", [sys, ask]), affinityKey("t1", "run-42", []));
  assert.equal(affinityKey("t1", null, []), null);
});

test("an experiment's arm is fixed by the run, and the split keeps its share", () => {
  assert.equal(unit("k1", "exp_a"), unit("k1", "exp_a"));
  const b = Array.from({ length: 4000 }, (_, i) => unit(`run${i}`, "exp_a") < 0.1).filter(Boolean).length / 4000;
  assert.ok(b > 0.08 && b < 0.12, `share ${b}`);
});

test("a run stays on the model it started on when the route would now pick another", () => {
  upsertTenant({ id: "aff", name: "Aff" });
  upsertModel({ id: "lan-a", backend: "external", kind: "chat", base_url: "http://192.168.1.20:11434/v1", ctx: 32768 });
  upsertModel({ id: "lan-b", backend: "external", kind: "chat", base_url: "http://192.168.1.21:11434/v1", ctx: 32768 });
  upsertRoute({ name: "pinned", kind: "chat", strategy: "priority", candidates: ["lan-a", "lan-b"] });
  const t = getTenant("aff")!;
  const key = affinityKey("aff", null, [sys, ask]);
  assert.equal(decide(t, "pinned", "chat", null, key).candidates[0].id, "lan-a");
  upsertRoute({ name: "pinned", kind: "chat", strategy: "priority", candidates: ["lan-b", "lan-a"] });
  const d = decide(t, "pinned", "chat", null, key);
  assert.equal(d.candidates[0].id, "lan-a");
  assert.ok(d.sticky);
  assert.match(d.reason, /kept on lan-a/);
  // a new run takes the route as it is now
  assert.equal(decide(t, "pinned", "chat", null, affinityKey("aff", null, [sys, { role: "user", content: "new task" }])).candidates[0].id, "lan-b");
  assert.equal(decide(t, "pinned", "chat", null, null).candidates[0].id, "lan-b");
});
