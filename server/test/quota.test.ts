import { test } from "node:test";
import assert from "node:assert/strict";

const { saveSettings } = await import("../src/db.js");
const { saveProvider } = await import("../src/providers.js");
const { upsertModel, upsertRoute } = await import("../src/models.js");
const { upsertTenant, getTenant } = await import("../src/tenants.js");
const { countRequest, noteHeaders, quotaBlock, parseReset } = await import("../src/quota.js");
const { decide } = await import("../src/router/select.js");
const { getModel } = await import("../src/models.js");

saveProvider({ id: "groq", name: "Groq", kind: "groq", base_url: "https://api.groq.com/openai/v1", api_key: "k", plan: "free", limits: JSON.stringify({ default: { rpm: 10, rpd: 100 }, per_model: { "big": { rpd: 3 } } }), trains_on_data: 0 });
saveProvider({ id: "trainer", name: "Trains", kind: "custom", base_url: "https://free.example.com/v1", api_key: "k", plan: "free", limits: "{}", trains_on_data: 1 });
upsertModel({ id: "groq/small", backend: "external", kind: "chat", provider_id: "groq", upstream_model: "small", ctx: 32768, caps: { quality: 6, tools: 7 } });
upsertModel({ id: "groq/big", backend: "external", kind: "chat", provider_id: "groq", upstream_model: "big", ctx: 32768, caps: { quality: 8, tools: 8 } });
upsertModel({ id: "trainer/x", backend: "external", kind: "chat", provider_id: "trainer", upstream_model: "x", ctx: 32768, caps: { quality: 9, tools: 9 } });
upsertModel({ id: "local", backend: "llamacpp", kind: "chat", ctx: 32768, caps: { quality: 7, tools: 8 } });

test("reset times as providers write them", () => {
  assert.equal(parseReset("2m59.56s"), 179_560);
  assert.equal(parseReset("7.66s"), 7660);
  assert.equal(parseReset("120ms"), 120);
  assert.equal(parseReset("30"), 30_000);
  assert.equal(parseReset(null), null);
});

test("a free model is taken out just before its limit, per model, and by what the provider says", () => {
  const big = getModel("groq/big")!;
  for (let i = 0; i < 2; i++) countRequest("groq/big", 100);
  assert.match(quotaBlock(big)!, /2 of 3 requests today/); // 95% of 3 → 2
  const small = getModel("groq/small")!;
  assert.equal(quotaBlock(small), null);
  const h = new Headers({ "x-ratelimit-remaining-requests": "0", "x-ratelimit-reset-requests": "1m" });
  noteHeaders("groq/small", 200, h);
  assert.match(quotaBlock(small)!, /no requests left/);
  assert.equal(quotaBlock(getModel("local")!), null); // ours: no quota
});

test("rescue: free models answer last, never when the border keeps a tenant local, never a trainer by default", () => {
  saveSettings({ freeRescue: true, freeRescueTraining: false });
  upsertRoute({ name: "agent", kind: "chat", strategy: "priority", candidates: ["local"] });
  upsertTenant({ id: "open", name: "Open" });
  upsertTenant({ id: "own", name: "Own", data_border: "own" });
  upsertModel({ id: "groq/fresh", backend: "external", kind: "chat", provider_id: "groq", upstream_model: "fresh", ctx: 32768, caps: { quality: 7, tools: 7 } });
  const ids = (t: string) => decide(getTenant(t)!, "agent", "chat", null).candidates.map((m) => m.id);
  assert.deepEqual(ids("open"), ["local", "groq/fresh"]); // big: quota used; small: rate-limited; trainer: trains on prompts
  assert.deepEqual(ids("own"), ["local"]);
  saveSettings({ freeRescueTraining: true });
  assert.deepEqual(ids("open"), ["local", "trainer/x", "groq/fresh"]);
  saveSettings({ freeRescue: false });
  assert.deepEqual(ids("open"), ["local"]);
});

test("a route that lists no models does not take free ones into its pool", () => {
  saveSettings({ freeRescue: false });
  upsertRoute({ name: "open-route", kind: "chat", strategy: "auto", candidates: [] });
  const ids = decide(getTenant("open")!, "open-route", "chat", null).candidates.map((m) => m.id);
  assert.deepEqual(ids, ["local"]);
});

test("free tiers: OVH needs no key, others do; models arrive free, counted, with their catalog id", async () => {
  const { addFreeTier, getProvider } = await import("../src/providers.js");
  assert.throws(() => addFreeTier("groq", {}), /needs an API key/);
  const p = addFreeTier("ovh", {});
  assert.equal(p.plan, "free");
  const q = getModel("ovh/Qwen3.8-27B")!;
  assert.equal(q.catalog_id, "qwen3.8-27b");
  assert.equal(q.cost_in, 0);
  assert.equal(getProvider("ovh")!.api_key, null);
  assert.ok(getModel("ovh/bge-m3") && getModel("ovh/whisper-large-v3"));
});

test("embeddings are rescued only by the same model: other vectors would not match the stored ones", async () => {
  saveSettings({ freeRescue: true, freeRescueTraining: false });
  upsertModel({ id: "bge-m3", backend: "llamacpp", kind: "embedding", ctx: 8192 });
  upsertModel({ id: "qwen3-embedding-0.6b", backend: "llamacpp", kind: "embedding", ctx: 8192 });
  upsertRoute({ name: "embed", kind: "embedding", strategy: "priority", candidates: ["bge-m3"] });
  upsertRoute({ name: "embed-qwen", kind: "embedding", strategy: "priority", candidates: ["qwen3-embedding-0.6b"] });
  const ids = (r: string) => decide(getTenant("open")!, r, "embedding", null).candidates.map((m) => m.id);
  assert.deepEqual(ids("embed"), ["bge-m3", "ovh/bge-m3"]);
  assert.deepEqual(ids("embed-qwen"), ["qwen3-embedding-0.6b"]); // OVH's Qwen3-Embedding-8B is another model
});

test("a model tested on a free tier informs the advisor, without counting as installed", async () => {
  const { advise } = await import("../src/advisor.js");
  const { db, now } = await import("../src/db.js");
  const before = (await advise("reasoning")).ranked.find((a) => a.id === "qwen3.8-27b")!;
  assert.equal(before.installed, false);
  db.prepare("INSERT INTO benchmarks(id, model_id, ts, status, score) VALUES('cloud1', 'ovh/Qwen3.8-27B', ?, 'done', 0.5)").run(now());
  const after = (await advise("reasoning")).ranked.find((a) => a.id === "qwen3.8-27b")!;
  assert.equal(after.installed, false);
  assert.equal(after.cloudTest!.modelId, "ovh/Qwen3.8-27B");
  assert.ok(after.caps.quality! < before.caps.quality!); // 50% of the checks pulls its quality estimate down
});

test("a gateway takes only what runs on a node, never the node's cloud or free-tier models", async () => {
  const { syncNode, saveProvider: save, getProvider } = await import("../src/providers.js");
  const { listModels } = await import("../src/models.js");
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string) => {
    const u = String(url);
    const body = u.endsWith("/system?range=15m") ? { system: {}, instances: [], budget: { budgetGb: 48, usedGb: 0 } }
      : [{ id: "qwen-local", display_name: "Qwen", kind: "chat", backend: "llamacpp", enabled: true, ctx: 32768, size_bytes: 1, caps: {}, notes: "", catalog_id: null },
         { id: "ovh/Qwen3.8-27B", display_name: "OVH", kind: "chat", backend: "external", enabled: true, ctx: 32768, size_bytes: 0, caps: {}, notes: "", catalog_id: "qwen3.8-27b", provider_id: "ovh" },
         { id: "whisper", display_name: "Whisper", kind: "transcription", backend: "external", enabled: true, ctx: 0, size_bytes: 0, caps: {}, notes: "", catalog_id: null, provider_id: null }];
    return new Response(JSON.stringify(body), { status: 200 });
  }) as typeof fetch;
  try {
    save({ id: "studio", name: "Studio", kind: "mux", base_url: "http://studio", admin_token: "x" });
    await syncNode(getProvider("studio")!);
    const ids = listModels().filter((m) => m.provider_id === "studio").map((m) => m.id);
    assert.deepEqual(ids.sort(), ["studio/qwen-local", "studio/whisper"]); // its own speech server, not its free tier
  } finally { globalThis.fetch = realFetch; }
});

test("an embedding route's first model changes only when forced", async () => {
  const Fastify = (await import("fastify")).default;
  const { registerAdmin } = await import("../src/admin/routes.js");
  const app = Fastify(); registerAdmin(app);
  const h = { authorization: "Bearer dev" };
  upsertModel({ id: "gemini/gemini-embedding-001", backend: "external", kind: "embedding", provider_id: "groq", upstream_model: "gemini-embedding-001", ctx: 8192 });
  upsertRoute({ name: "embed", kind: "embedding", strategy: "priority", candidates: ["bge-m3", "ovh/bge-m3"] });
  const put = (body: object) => app.inject({ method: "PUT", url: "/api/admin/routes/embed", headers: h, payload: body });
  assert.equal((await put({ candidates: ["gemini/gemini-embedding-001", "bge-m3"] })).statusCode, 409);
  assert.equal((await put({ candidates: ["bge-m3"] })).statusCode, 200); // the same first model: fine
  assert.equal((await put({ candidates: ["ovh/bge-m3", "bge-m3"] })).statusCode, 200); // the same model elsewhere: fine
  assert.equal((await put({ candidates: ["gemini/gemini-embedding-001"], force: true })).statusCode, 200);
  await app.close();
});
