import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "mux-presence-"));
process.env.MUX_HOME = dir;
process.env.MUX_DB = join(dir, "mux.db");
process.env.MUX_PORT = "1";
process.env.MUX_ADMIN_TOKEN = "admin-token";
process.env.MUX_PRESENCE_TOKEN = "presence-token";
const { judge, Tracker } = await import("../src/presence.js");
const { saveProvider } = await import("../src/providers.js");
const { upsertModel, upsertRoute } = await import("../src/models.js");
const { upsertTenant, getTenant } = await import("../src/tenants.js");
const { decide } = await import("../src/router/select.js");
type Signals = import("../src/presence.js").Signals;
type Presence = import("../src/presence.js").Presence;

const sig = (o: Partial<Signals> = {}): Signals => ({ idleS: 3600, onBattery: false, batteryPct: null, thermal: "nominal", pressure: 1, source: "macos", ts: Date.now(), ...o });

test("available: a server serves whoever sits at it, through a film or a call", () => {
  assert.equal(judge(sig({ idleS: 2, fullscreen: true, call: true }), { mode: "available", using: false }).state, "free");
});

test("only when I'm away: someone there is polite, a fullscreen app or a call is busy, nobody for 10 min is free", () => {
  const o = { mode: "away-only" as const, using: false };
  assert.equal(judge(sig({ idleS: 30 }), o).state, "polite");
  assert.equal(judge(sig({ idleS: 30, fullscreen: true }), o).state, "busy");
  assert.equal(judge(sig({ idleS: 30, call: true }), o).state, "busy");
  assert.equal(judge(sig({ idleS: 900 }), o).state, "free");
  assert.equal(judge(sig({ idleS: null, source: "none" }), o).state, "free"); // nobody logged in
});

test("the owner, the battery, heat and memory", () => {
  assert.equal(judge(sig(), { mode: "off", using: false }).state, "away");
  assert.equal(judge(sig(), { mode: "available", using: true }).state, "polite");
  assert.equal(judge(sig({ onBattery: true, batteryPct: 80 }), { mode: "available", using: false }).state, "polite");
  assert.equal(judge(sig({ onBattery: true, batteryPct: 15 }), { mode: "available", using: false }).state, "away");
  assert.equal(judge(sig({ thermal: "serious" }), { mode: "away-only", using: false }).state, "polite");
  assert.equal(judge(sig({ pressure: 2 }), { mode: "away-only", using: false }).state, "polite");
  // A server keeps its slots when warm or short of memory (its runtime unloads what is idle).
  assert.equal(judge(sig({ thermal: "serious", pressure: 2 }), { mode: "available", using: false }).state, "free");
  assert.equal(judge(sig({ thermal: "critical" }), { mode: "away-only", using: false }).state, "busy");
  assert.equal(judge(sig({ pressure: 4 }), { mode: "away-only", using: false }).state, "busy");
  assert.equal(judge(sig({ thermal: "critical", pressure: 4 }), { mode: "available", using: false }).state, "free");
});

test("the tracker: stricter at once, freer only after a minute of it", () => {
  const t = new Tracker();
  const t0 = 1_000_000;
  assert.equal(t.update({ state: "polite", reasons: ["x"] }, t0), true);
  assert.equal(t.update({ state: "free", reasons: [] }, t0 + 5_000), false);
  assert.equal(t.state, "polite");
  assert.equal(t.update({ state: "polite", reasons: ["x"] }, t0 + 10_000), false); // a nudge resets the wait
  t.update({ state: "free", reasons: [] }, t0 + 15_000);
  assert.equal(t.update({ state: "free", reasons: [] }, t0 + 60_000), false);
  assert.equal(t.update({ state: "free", reasons: [] }, t0 + 75_001), true);
  assert.equal(t.state, "free");
  assert.equal(t.update({ state: "busy", reasons: ["call"] }, t0 + 80_000), true);
  t.force({ state: "free", reasons: ["owner"] }, t0 + 81_000); // the owner's say applies at once
  assert.equal(t.state, "free");
});

test("the router: a busy node is skipped, a polite one serves only what it has loaded, a laptop comes after a server", () => {
  const node = (id: string, presence: Partial<Presence> & { state: Presence["state"] }, loaded: string[]) => {
    saveProvider({ id, name: id, kind: "mux", base_url: `http://${id}`, status: "online", info: { instances: loaded.map((m) => ({ id: m, state: "ready", estimateGb: 1, inflight: 0, rssGb: null })), presence: { mode: "away-only", using: false, class: "desktop", reasons: ["test"], since: 0, signals: sig(), ...presence } as Presence } });
    upsertModel({ id: `${id}/qwen`, backend: "node", kind: "chat", provider_id: id, upstream_model: "qwen", ctx: 32768 });
    upsertModel({ id: `${id}/gemma`, backend: "node", kind: "chat", provider_id: id, upstream_model: "gemma", ctx: 32768 });
  };
  node("studio", { state: "free", class: "always-on" }, ["qwen"]);
  node("laptop", { state: "free", class: "laptop" }, ["qwen"]);
  node("pc-01", { state: "busy" }, ["qwen"]);
  node("pc-02", { state: "polite" }, ["qwen"]);
  upsertRoute({ name: "auto", kind: "chat", strategy: "auto", candidates: [] });
  upsertTenant({ id: "t", name: "T" });
  const d = decide(getTenant("t")!, "auto", "chat", null);
  const ids = d.candidates.map((m) => m.id);
  assert.ok(!ids.some((i) => i.startsWith("pc-01/")), "busy node skipped");
  assert.ok(ids.includes("pc-02/qwen") && !ids.includes("pc-02/gemma"), "polite node: only its loaded model");
  assert.ok(ids.indexOf("studio/qwen") < ids.indexOf("laptop/qwen"), "a server before a laptop");
  assert.ok(ids.indexOf("laptop/qwen") < ids.indexOf("pc-02/qwen"), "a polite machine after a free one");
  assert.match(d.reason, /pc-01\/qwen: node busy/);
});

test("the presence token reports signals and nothing else", async () => {
  const Fastify = (await import("fastify")).default;
  const { registerAdmin } = await import("../src/admin/routes.js");
  const app = Fastify();
  registerAdmin(app);
  const as = (token: string, method: "GET" | "POST" | "PUT", url: string, payload?: object) => app.inject({ method, url, payload, headers: { authorization: `Bearer ${token}` } }).then((r) => r.statusCode);
  assert.equal(await as("presence-token", "POST", "/api/admin/presence/signals", { idleS: 5 }), 200);
  assert.equal(await as("presence-token", "GET", "/api/admin/presence"), 401);
  assert.equal(await as("presence-token", "PUT", "/api/admin/presence", { mode: "off" }), 401);
  assert.equal(await as("presence-token", "POST", "/api/admin/presence/signals?x=1/../../tenants", {}), 200); // still only the signals route
  assert.equal(await as("admin-token", "GET", "/api/admin/presence"), 200);
  await app.close();
});

test("on a Mac, the menu bar's fullscreen and call reports join the node's own signals", { skip: process.platform !== "darwin" }, async () => {
  const Fastify = (await import("fastify")).default;
  const { registerAdmin } = await import("../src/admin/routes.js");
  const app = Fastify();
  registerAdmin(app);
  const h = { authorization: "Bearer admin-token" };
  await app.inject({ method: "POST", url: "/api/admin/presence/signals", headers: h, payload: { fullscreen: true, call: false } });
  const busy = JSON.parse((await app.inject({ method: "PUT", url: "/api/admin/presence", headers: h, payload: { mode: "away-only", using: false } })).body);
  assert.equal(busy.state, "busy");
  assert.deepEqual(busy.reasons, ["a fullscreen app"]);
  assert.equal(busy.signals.source, "macos"); // idle time, battery and heat still the Mac's own
  const server = JSON.parse((await app.inject({ method: "PUT", url: "/api/admin/presence", headers: h, payload: { mode: "available" } })).body);
  assert.equal(server.state, "free"); // a server serves through a film
  await app.close();
});
