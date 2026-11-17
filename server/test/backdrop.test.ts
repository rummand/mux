import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "mux-backdrop-"));
process.env.MUX_HOME = dir;
process.env.MUX_DB = join(dir, "mux.db");
process.env.MUX_PORT = "1";
process.env.MUX_ADMIN_TOKEN = "admin-token";

const PROMPT = "a fjord at dusk, kestrel-4417";
const PHOTO = Buffer.from("a photo of a harbour").toString("base64");
const META = { horizon: 0.5, groundDepth: 1.62, depthScale: "metric" };
const FILES: Record<string, { type: string; body: Buffer }> = {
  panorama: { type: "image/png", body: Buffer.from("\x89PNG panorama") },
  depth: { type: "image/png", body: Buffer.from("\x89PNG depth16") },
  dome: { type: "model/gltf-binary", body: Buffer.from("glTF\x02\x00\x00\x00 dome") },
};

// A backdrop server like server/backdrop/backdrop_server.py, with the same contract and jobs it numbers itself.
async function fakeBackdropServer() {
  const state = { loaded: false, created: [] as Record<string, unknown>[], jobs: new Map<string, string>(), auth: [] as string[], busy: false };
  const srv = createServer(async (req: IncomingMessage, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    state.auth.push(req.headers.authorization ?? "");
    const send = (status: number, obj: unknown) => { res.statusCode = status; res.setHeader("content-type", "application/json"); res.end(JSON.stringify(obj)); };
    const path = (req.url ?? "").split("?")[0];
    if (req.method === "GET" && path === "/v1/models") return send(200, { object: "list", data: [{ id: "backdrop-test", route: "backdrop", loaded: state.loaded }] });
    if (req.method === "POST" && path === "/v1/backdrops") {
      const b = JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>;
      if (b.seed === -1) return send(400, { error: { message: "seed must be a whole number from 0", type: "invalid_request_error" } });
      if (state.busy) return send(429, { error: { message: "the Mac is busy: it has 11 GB of memory free and a backdrop needs about 30 GB", type: "busy" } });
      state.created.push(b);
      state.loaded = true;
      const id = `up_${state.created.length}`;
      state.jobs.set(id, "queued");
      return send(202, { id, object: "backdrop", status: "queued", model: "backdrop" });
    }
    const m = /^\/v1\/backdrops\/([^/]+)(?:\/(panorama|depth|dome|cancel))?$/.exec(path);
    if (m && state.jobs.has(m[1])) {
      if (m[2] === "cancel") { state.jobs.set(m[1], "cancelled"); return send(200, { id: m[1], status: "cancelled" }); }
      if (m[2]) { res.statusCode = 200; res.setHeader("content-type", FILES[m[2]].type); return res.end(FILES[m[2]].body); }
      state.jobs.set(m[1], "succeeded");
      return send(200, { id: m[1], object: "backdrop", status: "succeeded", progress: 1, model: "backdrop", meta: META });
    }
    send(404, { error: { message: "no such backdrop (or it expired: backdrops are kept 1 hour)", type: "not_found" } });
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  return { state, url: `http://127.0.0.1:${(srv.address() as AddressInfo).port}/v1`, close: () => srv.close() };
}

async function setupLocal(id: string, url: string, sizeBytes = 0) {
  const { upsertModel, upsertRoute } = await import("../src/models.js");
  upsertModel({ id, backend: "external", kind: "backdrop", base_url: url, upstream_model: "backdrop-test", size_bytes: sizeBytes });
  upsertRoute({ name: "backdrop", kind: "backdrop", strategy: "priority", candidates: [id] });
}

const ASK = { prompt: PROMPT, seed: 7, size: "1920x960" };

test("backdrop: create, poll, the three files and cancel through the gateway, as Thread does; only the tenant's own jobs", async () => {
  const Fastify = (await import("fastify")).default;
  const { upsertTenant, createKey } = await import("../src/tenants.js");
  const { registerGateway } = await import("../src/api/gateway.js");
  const { db } = await import("../src/db.js");
  const up = await fakeBackdropServer();
  await setupLocal("b1", up.url);
  upsertTenant({ id: "thread-b", name: "Thread test", allowed: ["backdrop"] });
  upsertTenant({ id: "other-b", name: "Someone else" });
  upsertTenant({ id: "chat-only-b", name: "Chat only", allowed: ["agent"] });
  const thread = { authorization: `Bearer ${createKey("thread-b", "t").key}` };
  const other = { authorization: `Bearer ${createKey("other-b", "o").key}` };
  const chatOnly = { authorization: `Bearer ${createKey("chat-only-b", "c").key}` };
  const app = Fastify({ bodyLimit: 64 * 1024 * 1024 });
  registerGateway(app);
  try {
    const made = await app.inject({ method: "POST", url: "/v1/backdrops", headers: thread, payload: { ...ASK, image_b64: PHOTO } });
    assert.equal(made.statusCode, 202, made.body);
    assert.equal(made.headers["x-mux-route"], "backdrop");
    assert.equal(made.headers["x-mux-model"], "b1");
    const job = JSON.parse(made.body);
    assert.match(job.id, /^backdrop_[0-9a-f]{24}$/);
    assert.equal(job.status, "queued");
    assert.equal(job.model, "backdrop", "the contract's model name");
    const sent = up.state.created[0];
    assert.equal(sent.model, "backdrop-test");
    assert.equal(sent.prompt, PROMPT);
    assert.equal(sent.image_b64, PHOTO, "the image goes on untouched");
    assert.equal(sent.seed, 7);

    const poll = await app.inject({ method: "GET", url: `/v1/backdrops/${job.id}`, headers: thread });
    assert.equal(poll.statusCode, 200, poll.body);
    const p = JSON.parse(poll.body);
    assert.equal(p.id, job.id);
    assert.equal(p.status, "succeeded");
    assert.deepEqual(p.meta, META);
    for (const [name, f] of Object.entries(FILES)) {
      const r = await app.inject({ method: "GET", url: `/v1/backdrops/${job.id}/${name}`, headers: thread });
      assert.equal(r.statusCode, 200, `${name}: ${r.body}`);
      assert.equal(r.headers["content-type"], f.type);
      assert.ok(r.rawPayload.equals(f.body), `${name} comes through byte for byte`);
    }
    const cancel = await app.inject({ method: "POST", url: `/v1/backdrops/${job.id}/cancel`, headers: thread });
    assert.deepEqual(JSON.parse(cancel.body), { id: job.id, status: "cancelled" });

    // Someone else's key, no key, an id that never was, a file that is not one
    assert.equal((await app.inject({ method: "GET", url: `/v1/backdrops/${job.id}`, headers: other })).statusCode, 404);
    assert.equal((await app.inject({ method: "GET", url: `/v1/backdrops/${job.id}/dome`, headers: other })).statusCode, 404);
    assert.equal((await app.inject({ method: "POST", url: `/v1/backdrops/${job.id}/cancel`, headers: other })).statusCode, 404);
    assert.equal((await app.inject({ method: "GET", url: `/v1/backdrops/${job.id}` })).statusCode, 401);
    assert.equal((await app.inject({ method: "GET", url: "/v1/backdrops/backdrop_nope", headers: thread })).statusCode, 404);
    assert.equal((await app.inject({ method: "GET", url: `/v1/backdrops/${job.id}/mesh`, headers: thread })).statusCode, 404);
    assert.equal((await app.inject({ method: "POST", url: "/v1/backdrops", payload: ASK })).statusCode, 401);
    assert.equal((await app.inject({ method: "POST", url: "/v1/backdrops", headers: chatOnly, payload: ASK })).statusCode, 403);

    // Bad input: 400 before any machine is asked, or the server's own 400 with its words
    const n = up.state.created.length;
    for (const bad of [{ seed: 1 }, { ...ASK, prompt: "  " }, { ...ASK, size: "1024x512" }]) {
      const r = await app.inject({ method: "POST", url: "/v1/backdrops", headers: thread, payload: bad });
      assert.equal(r.statusCode, 400, r.body);
    }
    const badSeed = await app.inject({ method: "POST", url: "/v1/backdrops", headers: thread, payload: { ...ASK, seed: -1 } });
    assert.equal(badSeed.statusCode, 400);
    assert.equal(JSON.parse(badSeed.body).error.message, "seed must be a whole number from 0");
    assert.equal(up.state.created.length, n);

    // Nothing of the prompt or the image is kept in the request log; polls and files are not metered
    const logged = db.prepare("SELECT * FROM requests WHERE endpoint LIKE 'backdrop%'").all() as Record<string, unknown>[];
    assert.ok(logged.length >= 2, `${logged.length} logged`);
    assert.ok(!JSON.stringify(logged).includes("kestrel"), "the prompt is never logged");
    assert.ok(!JSON.stringify(logged).includes(PHOTO), "the image is never logged");
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM requests WHERE endpoint LIKE '%backdrop%' AND endpoint <> 'backdrop.generate'").get() as { n: number }).n, 0);
  } finally {
    await app.close();
    up.close();
  }
});

test("backdrop: when the Mac is busy the answer is 503 all_models_failed, in words; a cooldown does not follow", async () => {
  const Fastify = (await import("fastify")).default;
  const { upsertTenant, createKey } = await import("../src/tenants.js");
  const { registerGateway } = await import("../src/api/gateway.js");
  const { registerAdmin } = await import("../src/admin/routes.js");
  const { inCooldown } = await import("../src/router/health.js");
  const up = await fakeBackdropServer();
  await setupLocal("bbusy", up.url);
  upsertTenant({ id: "busy-b", name: "Busy" });
  const h = { authorization: `Bearer ${createKey("busy-b", "b").key}` };
  const app = Fastify();
  registerGateway(app);
  registerAdmin(app);
  const admin = { authorization: "Bearer admin-token" };
  const setPresence = (payload: object) => app.inject({ method: "PUT", url: "/api/admin/presence", headers: admin, payload });
  try {
    // The backdrop server itself says busy (its memory, its queue)
    up.state.busy = true;
    const r = await app.inject({ method: "POST", url: "/v1/backdrops", headers: h, payload: ASK });
    assert.equal(r.statusCode, 503, r.body);
    const e = JSON.parse(r.body).error;
    assert.equal(e.type, "all_models_failed");
    assert.match(e.message, /the Mac is busy: it has 11 GB of memory free/);
    assert.equal(inCooldown("bbusy"), false, "busy is not failing");
    up.state.busy = false;
    assert.equal((await app.inject({ method: "POST", url: "/v1/backdrops", headers: h, payload: ASK })).statusCode, 202);

    // This Mac turned off, or someone at it with the model not loaded: the same answer, saying so
    await setPresence({ mode: "off", using: false });
    const off = await app.inject({ method: "POST", url: "/v1/backdrops", headers: h, payload: ASK });
    assert.equal(off.statusCode, 503, off.body);
    assert.equal(JSON.parse(off.body).error.type, "all_models_failed");
    assert.match(JSON.parse(off.body).error.message, /away|turned off/);
    await setPresence({ mode: "available", using: true });
    up.state.loaded = false;
    const polite = await app.inject({ method: "POST", url: "/v1/backdrops", headers: h, payload: ASK });
    assert.equal(polite.statusCode, 503, polite.body);
    assert.match(JSON.parse(polite.body).error.message, /polite/);
    up.state.loaded = true;
    assert.equal((await app.inject({ method: "POST", url: "/v1/backdrops", headers: h, payload: ASK })).statusCode, 202, "polite, and loaded: it takes the job");
    assert.equal(inCooldown("bbusy"), false);
  } finally {
    await setPresence({ mode: "available", using: false });
    await app.close();
    up.close();
  }
});

test("backdrop: a service that needs more memory than the Mac has free is refused before it is asked, in words", async () => {
  const Fastify = (await import("fastify")).default;
  const { upsertTenant, createKey } = await import("../src/tenants.js");
  const { registerGateway } = await import("../src/api/gateway.js");
  const { inCooldown } = await import("../src/router/health.js");
  const up = await fakeBackdropServer();
  up.state.loaded = false;
  await setupLocal("bmem", up.url, 1e15); // a million GB: no Mac has that free, whatever mux unloads
  upsertTenant({ id: "mem-b", name: "Memory" });
  const h = { authorization: `Bearer ${createKey("mem-b", "m").key}` };
  const app = Fastify();
  registerGateway(app);
  try {
    const r = await app.inject({ method: "POST", url: "/v1/backdrops", headers: h, payload: ASK });
    assert.equal(r.statusCode, 503, r.body);
    const e = JSON.parse(r.body).error;
    assert.equal(e.type, "all_models_failed");
    assert.match(e.message, /is busy: .* GB of memory free, and bmem needs about/);
    assert.equal(up.state.created.length, 0, "the backdrop server was not asked");
    assert.equal(inCooldown("bmem"), false);
    // Loaded already: the room is there, the job goes in
    up.state.loaded = true;
    assert.equal((await app.inject({ method: "POST", url: "/v1/backdrops", headers: h, payload: ASK })).statusCode, 202);
  } finally {
    await app.close();
    up.close();
  }
});

test("backdrop: without the route the gateway says what to run; body limit 50 MB", async () => {
  const Fastify = (await import("fastify")).default;
  const { registerGateway } = await import("../src/api/gateway.js");
  const { upsertTenant, createKey } = await import("../src/tenants.js");
  const { db } = await import("../src/db.js");
  const { upsertRoute } = await import("../src/models.js");
  upsertTenant({ id: "big-b", name: "Big" });
  const h = { authorization: `Bearer ${createKey("big-b", "b").key}`, "content-type": "application/json" };
  const app = Fastify({ bodyLimit: 64 * 1024 * 1024 });
  registerGateway(app);
  try {
    db.prepare("DELETE FROM routes WHERE name = 'backdrop'").run();
    const none = await app.inject({ method: "POST", url: "/v1/backdrops", headers: h, payload: ASK });
    assert.equal(none.statusCode, 503, none.body);
    assert.match(none.body, /deploy\/backdrop\.sh/);
    const mid = Buffer.from(JSON.stringify({ ...ASK, image_b64: "A".repeat(40 * 1024 * 1024) }));
    assert.notEqual((await app.inject({ method: "POST", url: "/v1/backdrops", headers: h, payload: mid })).statusCode, 413, "40 MB is within the limit");
    assert.equal((await app.inject({ method: "POST", url: "/v1/backdrops", headers: h, payload: Buffer.alloc(50 * 1024 * 1024 + 1, 0x20) })).statusCode, 413);
  } finally {
    upsertRoute({ name: "backdrop", kind: "backdrop", strategy: "priority", candidates: [] });
    await app.close();
  }
});

test("backdrop: from the Railway gateway to the Mac node and on to its backdrop server, each with its own id", async () => {
  const Fastify = (await import("fastify")).default;
  const { upsertModel, upsertRoute } = await import("../src/models.js");
  const { upsertTenant, createKey } = await import("../src/tenants.js");
  const { saveProvider } = await import("../src/providers.js");
  const { registerGateway } = await import("../src/api/gateway.js");
  const { inCooldown } = await import("../src/router/health.js");
  const up = await fakeBackdropServer();
  const node = Fastify({ bodyLimit: 64 * 1024 * 1024 });
  registerGateway(node);
  await node.listen({ port: 0, host: "127.0.0.1" });
  const nodeUrl = `http://127.0.0.1:${(node.server.address() as AddressInfo).port}`;
  upsertModel({ id: "bnode", backend: "external", kind: "backdrop", base_url: up.url, upstream_model: "backdrop-test" });
  upsertTenant({ id: "gateway-on-node-b", name: "the gateway" });
  const gwKey = createKey("gateway-on-node-b", "g").key;
  saveProvider({ id: "mac-b", name: "Mac test", kind: "mux", base_url: nodeUrl, api_key: gwKey, enabled: true, status: "online" });
  upsertModel({ id: "mac-b/bnode", backend: "node", kind: "backdrop", provider_id: "mac-b", upstream_model: "bnode", base_url: `${nodeUrl}/v1` });
  upsertTenant({ id: "thread-gw-b", name: "Thread" });
  const thread = { authorization: `Bearer ${createKey("thread-gw-b", "t").key}` };
  const gw = Fastify({ bodyLimit: 64 * 1024 * 1024 });
  registerGateway(gw);
  try {
    // One database plays both machines here: the gateway's route names the node's model, the node's its own
    upsertRoute({ name: "backdrop", kind: "backdrop", strategy: "priority", candidates: ["mac-b/bnode", "bnode"] });
    const made = await gw.inject({ method: "POST", url: "/v1/backdrops", headers: thread, payload: ASK });
    assert.equal(made.statusCode, 202, made.body);
    assert.equal(made.headers["x-mux-model"], "mac-b/bnode");
    const job = JSON.parse(made.body);
    assert.equal(job.model, "backdrop");
    assert.equal(up.state.created.at(-1)!.model, "backdrop-test");
    const poll = await gw.inject({ method: "GET", url: `/v1/backdrops/${job.id}`, headers: thread });
    assert.equal(poll.statusCode, 200, poll.body);
    assert.equal(JSON.parse(poll.body).id, job.id);
    assert.deepEqual(JSON.parse(poll.body).meta, META);
    const dome = await gw.inject({ method: "GET", url: `/v1/backdrops/${job.id}/dome`, headers: thread });
    assert.equal(dome.headers["content-type"], "model/gltf-binary");
    assert.ok(dome.rawPayload.equals(FILES.dome.body));
    const cancel = await gw.inject({ method: "POST", url: `/v1/backdrops/${job.id}/cancel`, headers: thread });
    assert.equal(JSON.parse(cancel.body).status, "cancelled");
    assert.ok(!up.state.auth.includes(thread.authorization), "the node is asked with the gateway's key, never the caller's");

    // Busy on the Mac: the node says all_models_failed, the gateway says it on, and does not cool the node down
    up.state.busy = true;
    const busy = await gw.inject({ method: "POST", url: "/v1/backdrops", headers: thread, payload: ASK });
    assert.equal(busy.statusCode, 503, busy.body);
    assert.equal(JSON.parse(busy.body).error.type, "all_models_failed");
    assert.match(JSON.parse(busy.body).error.message, /the Mac is busy/);
    assert.equal(inCooldown("mac-b/bnode"), false);
    up.state.busy = false;
  } finally {
    await gw.close();
    await node.close();
    up.close();
  }
});
