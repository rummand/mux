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
