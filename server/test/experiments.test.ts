import { test } from "node:test";
import assert from "node:assert/strict";

const { db, now, saveSettings } = await import("../src/db.js");
const { getRoute, upsertModel, upsertRoute, getModel } = await import("../src/models.js");
const { split, startExperiment, tickExperiments, measure, tripped, verdict, getExperiment, autopilot } = await import("../src/experiments.js");
const { search } = await import("../src/brain.js");

saveSettings({ autoExperiments: false });
const GB = 1024 ** 3;
const model = (id: string, kind = "chat", gb = 2) => upsertModel({ id, backend: "llamacpp", kind: kind as "chat", size_bytes: gb * GB, ctx: 8192 });
let n = 0;
const req = (exp: string, arm: "A" | "B", model_id: string, ok = true, latency = 1000) =>
  db.prepare("INSERT INTO requests(id, ts, tenant_id, endpoint, model_id, status, latency_ms, experiment_id, arm) VALUES(?, ?, 't', 'openai.chat', ?, ?, ?, ?, ?)").run(`x${++n}`, now(), model_id, ok ? 200 : 503, latency, exp, arm);

test("the split: arm B tries the challenger first, arm A the champion; each keeps the other behind it", () => {
  model("champ"); model("chall"); model("other");
  upsertRoute({ name: "agent", kind: "chat", strategy: "priority", candidates: ["champ", "other"] });
  const ex = startExperiment({ route: "agent", challenger: "chall", share: 0.5 });
  assert.deepEqual(getRoute("agent")!.candidates, ["champ", "other", "chall"]); // the challenger joins last: nothing changes outside arm B
  const ordered = ["champ", "other", "chall"].map((id) => getModel(id)!);
  const seen = new Set<string>();
  for (let i = 0; i < 200; i++) {
    const s = split("agent", ordered)!;
    seen.add(s.experiment.arm);
    assert.deepEqual(s.candidates.map((m) => m.id), s.experiment.arm === "B" ? ["chall", "champ", "other"] : ["champ", "other", "chall"]);
    assert.equal(s.experiment.id, ex.id);
  }
  assert.deepEqual([...seen].sort(), ["A", "B"]);
  assert.throws(() => startExperiment({ route: "agent", challenger: "other" }), /already runs/);
});

test("guardrails: a challenger that fails much more is rolled back at once, and the brain learns it", async () => {
  const ex = getExperiment([...db.prepare("SELECT id FROM experiments WHERE route = 'agent'").all() as { id: string }[]][0].id)!;
  for (let i = 0; i < 20; i++) req(ex.id, "A", "champ");
  for (let i = 0; i < 6; i++) req(ex.id, "B", i < 3 ? "champ" : "chall"); // 3 of 6 first tries failed: the champion answered
  const s = measure(ex);
  assert.equal(s.B.failRate, 0.5);
  assert.match(tripped(s)!, /failed 50%/);
  await tickExperiments();
  assert.equal(getExperiment(ex.id)!.status, "rolled_back");
  assert.equal(getRoute("agent")!.candidates[0], "champ"); // production as it was
  assert.ok((await search("experiment agent chall champ")).some((p) => /Experiment on agent/.test(p.title)));
});

test("verdict: promoted only when at least as reliable, not much slower, no worse benchmarked", async () => {
  model("fast-new");
  upsertRoute({ name: "smart", kind: "chat", strategy: "priority", candidates: ["champ"] });
  const ex = startExperiment({ route: "smart", challenger: "fast-new", minRequests: 10 });
  for (let i = 0; i < 12; i++) { req(ex.id, "A", "champ", true, 1000); req(ex.id, "B", "fast-new", true, 900); }
  assert.equal(verdict(measure(ex)).promote, true);
  await tickExperiments();
  assert.equal(getExperiment(ex.id)!.status, "promoted");
  assert.equal(getRoute("smart")!.candidates[0], "fast-new");
  const slow = { A: { requests: 50, firstChoiceFailed: 0, failRate: 0, userErrors: 0, p50: 1000, p95: 2000, ttft: null, tps: null, bench: 0.9 }, B: { requests: 50, firstChoiceFailed: 0, failRate: 0, userErrors: 0, p50: 1300, p95: 2500, ttft: null, tps: null, bench: 0.9 }, at: 0 };
  assert.match(verdict(slow).why, /slower/);
});

test("never on an embedding route, and never when the two do not fit in memory together", () => {
  model("emb-a", "embedding", 1); model("emb-b", "embedding", 1);
  upsertRoute({ name: "embed", kind: "embedding", strategy: "priority", candidates: ["emb-a"] });
  assert.throws(() => startExperiment({ route: "embed", challenger: "emb-b" }), /embedding route/);
  model("big-a", "chat", 30); model("big-b", "chat", 25);
  upsertRoute({ name: "code", kind: "chat", strategy: "priority", candidates: ["big-a"] });
  assert.throws(() => startExperiment({ route: "code", challenger: "big-b" }), /memory budget/);
});

test("autopilot: a route whose only model fails starts an A/B test with a reliable model of its family", async () => {
  saveSettings({ autoExperiments: true });
  db.prepare("DELETE FROM routes WHERE name != 'transcribe'").run();
  for (const id of ["whisper", "whisper-turbo"]) model(id, "transcription", 1);
  for (let i = 0; i < 12; i++) db.prepare("INSERT INTO requests(id, ts, tenant_id, endpoint, model_id, status, latency_ms) VALUES(?, ?, 't', 'audio', 'whisper', ?, 500)").run(`w${i}`, now(), i < 6 ? 503 : 200);
  for (let i = 0; i < 20; i++) db.prepare("INSERT INTO requests(id, ts, tenant_id, endpoint, model_id, status, latency_ms) VALUES(?, ?, 't', 'audio', 'whisper-turbo', 200, 500)").run(`wt${i}`, now());
  upsertRoute({ name: "transcribe", kind: "transcription", strategy: "priority", candidates: ["whisper"] });
  const p = await autopilot();
  assert.ok(p.actions.some((a) => /transcribe: whisper-turbo \(50%\)/.test(a)), JSON.stringify(p));
  assert.deepEqual(getRoute("transcribe")!.candidates, ["whisper", "whisper-turbo"]);
});
