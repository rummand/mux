import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "mux-border-"));
process.env.MUX_HOME = dir;
process.env.MUX_DB = join(dir, "mux.db");
process.env.MUX_PORT = "1";
const { outside, ownNetwork, placeOf } = await import("../src/router/border.js");
const { decide, RouteError } = await import("../src/router/select.js");
const { saveProvider } = await import("../src/providers.js");
const { getModel, upsertModel, upsertRoute } = await import("../src/models.js");
const { getTenant, upsertTenant } = await import("../src/tenants.js");
const { rules } = await import("../src/lens.js");
type Presence = import("../src/presence.js").Presence;

const presence = (cls: Presence["class"], load: Presence["load"] = {}): Presence => ({ state: "free", mode: "available", using: false, class: cls, reasons: [], since: 0, load,
  signals: { idleS: 9999, onBattery: false, batteryPct: null, thermal: "nominal", pressure: 1, source: "macos", ts: 0 } });

function fleet(load: Presence["load"] = {}) {
  saveProvider({ id: "studio", name: "Studio", kind: "mux", base_url: "https://studio.tail.ts.net/mux", status: "online", info: { instances: [{ id: "qwen", state: "ready", estimateGb: 20, inflight: 0, rssGb: null }], presence: presence("always-on", load) } });
  saveProvider({ id: "mbp", name: "MacBook", kind: "mux", base_url: "http://mbp.local:7070", status: "online", info: { instances: [{ id: "qwen", state: "ready", estimateGb: 20, inflight: 0, rssGb: null }], presence: presence("laptop") } });
  saveProvider({ id: "openai", name: "OpenAI", kind: "openai", base_url: "https://api.openai.com/v1", status: "online" });
  upsertModel({ id: "studio/qwen", backend: "node", kind: "chat", provider_id: "studio", upstream_model: "qwen", ctx: 32768, caps: { quality: 7 } });
  upsertModel({ id: "mbp/qwen", backend: "node", kind: "chat", provider_id: "mbp", upstream_model: "qwen", ctx: 32768, caps: { quality: 7 } });
  upsertModel({ id: "openai/gpt", backend: "external", kind: "chat", provider_id: "openai", upstream_model: "gpt", ctx: 128000, cost_in: 2, cost_out: 8, caps: { quality: 9 } });
  upsertModel({ id: "ollama", backend: "external", kind: "chat", base_url: "http://192.168.1.20:11434/v1", ctx: 32768 });
  upsertRoute({ name: "auto", kind: "chat", strategy: "auto", candidates: ["studio/qwen", "mbp/qwen", "openai/gpt"] });
}

test("where a model runs", () => {
  fleet();
  assert.equal(placeOf(getModel("studio/qwen")!), "server");
  assert.equal(placeOf(getModel("mbp/qwen")!), "shared");
  assert.equal(placeOf(getModel("openai/gpt")!), "cloud");
  assert.equal(placeOf(getModel("ollama")!), "server"); // a model server in the house is ours
  assert.ok(ownNetwork("http://100.101.1.2:7070") && ownNetwork("https://x.tail1.ts.net/mux") && !ownNetwork("https://api.groq.com"));
  assert.equal(outside("any", getModel("openai/gpt")!), null);
  assert.match(outside("own", getModel("openai/gpt")!)!, /cloud API/);
  assert.equal(outside("own", getModel("mbp/qwen")!), null);
  assert.match(outside("servers", getModel("mbp/qwen")!)!, /someone works at/);
});

test("the router keeps a tenant inside its border, also for a model named outright", () => {
  fleet();
  upsertTenant({ id: "nexus", name: "Nexus", data_border: "own" });
  upsertTenant({ id: "bank", name: "Bank", data_border: "servers" });
  upsertTenant({ id: "free", name: "Free" });
  const ids = (t: string) => decide(getTenant(t)!, "auto", "chat", null).candidates.map((m) => m.id);
  assert.deepEqual(ids("nexus").sort(), ["mbp/qwen", "studio/qwen"]);
  assert.deepEqual(ids("bank"), ["studio/qwen"]);
  assert.ok(ids("free").includes("openai/gpt"));
  assert.throws(() => decide(getTenant("nexus")!, "openai/gpt", "chat", null), (e: unknown) => e instanceof RouteError && e.status === 403 && e.type === "data_border");
});

test("burst: a node whose slots are all taken loses to the cloud, when the border allows", () => {
  fleet({ qwen: { inflight: 1, slots: 2 } });
  const first = (t: string) => decide(getTenant(t)!, "auto", "chat", null).candidates[0].id;
  assert.equal(first("free"), "studio/qwen"); // a free slot: local first
  fleet({ qwen: { inflight: 6, slots: 2 } });
  saveProvider({ id: "mbp", name: "MacBook", kind: "mux", base_url: "http://mbp.local:7070", status: "online", info: { instances: [], presence: presence("laptop", { qwen: { inflight: 4, slots: 1 } }) } });
  assert.equal(first("free"), "openai/gpt"); // five waiting: burst to the cloud
  assert.notEqual(first("nexus"), "openai/gpt"); // but never across a border: it queues locally
});

test("Lens: requests that ran outside a tenant's border", () => {
  fleet();
  const r = (id: string, model: string) => ({ id, ts: Date.now(), tenant_id: "nexus", agent: null, trace_id: null, endpoint: "openai.chat", model_id: model, provider_id: model.split("/")[0], route: "auto", status: 200, error_type: null, error: null, latency_ms: 500, ttft_ms: 100, prompt_tokens: 100, completion_tokens: 10, fallbacks: 0, cold_start: 0, finish_reason: "stop", forced_tool: 0, tools: 0, body_req: null, body_res: null, route_reason: null });
  const f = rules([r("a", "openai/gpt"), r("b", "studio/qwen")]).find((x) => x.key === "border|nexus");
  assert.ok(f);
  assert.deepEqual(f.evidence.map((e) => e.request_id), ["a"]);
});
