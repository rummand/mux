import { test } from "node:test";
import assert from "node:assert/strict";

const { db, now } = await import("../src/db.js");
const { upsertModel, upsertRoute } = await import("../src/models.js");
const { usageOf, insights, advise } = await import("../src/advisor.js");
const { trendingNotInCatalog, signals } = await import("../src/signals.js");

let n = 0;
const req = (model: string, ok: boolean, o: { tenant?: string; tps?: number } = {}) =>
  db.prepare("INSERT INTO requests(id, ts, tenant_id, endpoint, model_id, status, latency_ms, tps) VALUES(?, ?, ?, 'openai.chat', ?, ?, 900, ?)").run(`r${++n}`, now() - 3600_000, o.tenant ?? "t1", model, ok ? 200 : 503, o.tps ?? 50);

test("usage: a model's traffic over 30 days, across the ids it runs under", () => {
  for (let i = 0; i < 18; i++) req("qwen3.6-35b-a3b", true, { tenant: i % 2 ? "nexus" : "lan" });
  for (let i = 0; i < 2; i++) req("qwen3.6-35b-a3b", false);
  for (let i = 0; i < 5; i++) req("mac-studio/qwen3.6-35b-a3b", true);
  const u = usageOf(["qwen3.6-35b-a3b", "mac-studio/qwen3.6-35b-a3b"])!;
  assert.equal(u.requests, 25);
  assert.equal(u.errors, 2);
  assert.equal(u.tenants, 3);
  assert.equal(usageOf(["nobody"]), null);
});

test("insights: a failing model first on a route moves back; alone on a route, it gets a fallback of its family", async () => {
  for (const id of ["whisper", "whisper-turbo", "roest-v3"]) upsertModel({ id, backend: "llamacpp", kind: "transcription" });
  for (let i = 0; i < 10; i++) req("whisper", i < 3); // 70% failing
  for (let i = 0; i < 40; i++) req("whisper-turbo", i !== 0); // 2.5%
  for (let i = 0; i < 40; i++) req("roest-v3", true); // 0%, but Danish-only
  upsertRoute({ name: "transcribe", kind: "transcription", strategy: "priority", candidates: ["whisper"] });
  upsertRoute({ name: "transcribe-da", kind: "transcription", strategy: "priority", candidates: ["whisper", "roest-v3"] });
  const { insights: list } = await insights();
  const alone = list.find((i) => i.title.includes("alone on transcribe"))!;
  assert.equal(alone.priority, "high");
  assert.deepEqual(alone.action!.body, { route: "transcribe", challenger: "whisper-turbo", share: 0.5 }); // same family, nearly as reliable: an A/B test
  const first = list.find((i) => i.title.includes("first on transcribe-da"))!;
  assert.deepEqual(first.action!.body, { route: "transcribe-da", challenger: "roest-v3", share: 0.5 });
});

test("insights: no promotion on estimates alone — a model must be measured or used here", async () => {
  upsertModel({ id: "qwen3.8-27b", catalog_id: "qwen3.8-27b", backend: "llamacpp", kind: "chat", ctx: 32768, size_bytes: 1 });
  upsertModel({ id: "qwen3.5-0.8b", catalog_id: "qwen3.5-0.8b", backend: "llamacpp", kind: "chat", ctx: 16384, size_bytes: 1 });
  upsertRoute({ name: "smart", kind: "chat", strategy: "quality", candidates: ["qwen3.5-0.8b", "qwen3.8-27b"] });
  const before = (await insights()).insights.filter((i) => i.title.includes("first on smart"));
  assert.equal(before.length, 0);
  db.prepare("INSERT INTO benchmarks(id, model_id, ts, status, score, tps) VALUES('b1', 'qwen3.8-27b', ?, 'done', 1, 30)").run(now());
  const after = (await insights()).insights.find((i) => i.title === "Put Qwen3.8 27B first on smart")!;
  assert.ok(after);
  assert.deepEqual(after.action!.body, { route: "smart", challenger: "qwen3.8-27b", share: 0.1 });
});

test("trending: servable kinds only, no safety-stripped uploads, one row per model", () => {
  const put = db.prepare("INSERT INTO trending_models(repo, downloads, likes, trending, created_at, pipeline, fetched_at) VALUES(?, ?, ?, ?, NULL, ?, ?)");
  put.run("someone/Image-Thing-GGUF", 900, 1, 99, "text-to-image", now());
  put.run("someone/Cool-Model-7B-Uncensored-GGUF", 900, 1, 98, "text-generation", now());
  put.run("unsloth/Cool-Model-7B-GGUF", 500, 9, 97, "text-generation", now());
  put.run("bartowski/Cool-Model-7B-GGUF", 700, 3, 96, "text-generation", now());
  const t = trendingNotInCatalog();
  assert.deepEqual(t.map((x) => x.repo), ["bartowski/Cool-Model-7B-GGUF"]);
  assert.equal(t[0].uploads, 2);
});

test("web signals nudge the ranking by at most 0.3 either way", async () => {
  const base = (await advise("agent")).ranked.find((a) => a.id === "gemma-4-12b")!.score;
  db.prepare("INSERT INTO model_signals(catalog_id, repo, downloads, likes, fetched_at) VALUES('gemma-4-12b', 'x/y', 1000000, 10, ?), ('qwen3.5-4b', 'x/z', 10, 0, ?)").run(now(), now());
  assert.equal(signals().get("gemma-4-12b")!.popularity, 10);
  const after = (await advise("agent")).ranked.find((a) => a.id === "gemma-4-12b")!.score;
  assert.ok(after > base && after - base <= 0.31, `${base} → ${after}`);
});
