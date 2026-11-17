import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "mux-measure-"));
process.env.MUX_HOME = dir;
process.env.MUX_DB = join(dir, "mux.db");
process.env.MUX_PORT = "1";
process.env.MUX_ADMIN_TOKEN = "admin-token";

const PHOTO = Buffer.from("a photo of a tiny house").toString("base64");
const RESULT = { cameras: [{ photo: 0, K: [[1, 0, 0], [0, 1, 0], [0, 0, 1]], R: [[1, 0, 0], [0, 1, 0], [0, 0, 1]], t: [0, 0, 0] }], points: { format: "ply", count: 1, b64: "cGx5" }, scale_source: "model" };

// A measure server like server/measure/measure_server.py, with the same contract: two models, jobs it numbers itself.
async function fakeMeasureServer() {
  const state = { loaded: { depth: false, recon: false }, depth: [] as Record<string, unknown>[], created: [] as Record<string, unknown>[], jobs: new Map<string, string>(), auth: [] as string[] };
  const srv = createServer(async (req: IncomingMessage, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    state.auth.push(req.headers.authorization ?? "");
    const send = (status: number, obj: unknown) => { res.statusCode = status; res.setHeader("content-type", "application/json"); res.end(JSON.stringify(obj)); };
    const path = (req.url ?? "").split("?")[0];
    if (req.method === "GET" && path === "/v1/models") {
      return send(200, { object: "list", data: [{ id: "depth-test", route: "depth", loaded: state.loaded.depth }, { id: "recon-test", route: "reconstruct", loaded: state.loaded.recon }] });
    }
    if (req.method === "POST" && path === "/v1/depth") {
      const b = JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>;
      if (b.focal_px === 0) return send(400, { error: { message: "focal_px must be a number of pixels from 10 to 100000", type: "invalid_request_error" } });
      state.depth.push(b);
      state.loaded.depth = true;
      return send(200, { object: "depth", model: "depth-test", width: 4, height: 3, focal_px: 812.5, focal_source: "model", unit: "mm", depth_png16_b64: "UE5H" });
    }
    if (req.method === "POST" && path === "/v1/reconstruct") {
      const b = JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>;
      if ((b.known as { one_measurement?: { metres?: number } } | undefined)?.one_measurement?.metres === 0) return send(400, { error: { message: "known.one_measurement.metres must be from 0.01 to 1000", type: "invalid_request_error" } });
      state.created.push(b);
      state.loaded.recon = true;
      const id = `up_${state.created.length}`;
      state.jobs.set(id, "queued");
      return send(202, { id, object: "reconstruction", status: "queued", model: "recon-test" });
    }
    const m = /^\/v1\/reconstruct\/([^/]+)(\/cancel)?$/.exec(path);
    if (m && state.jobs.has(m[1])) {
      if (m[2] === "/cancel") { state.jobs.set(m[1], "cancelled"); return send(200, { id: m[1], status: "cancelled" }); }
      state.jobs.set(m[1], "succeeded");
      return send(200, { id: m[1], object: "reconstruction", status: "succeeded", progress: 1, model: "recon-test", photos: 2, result: RESULT });
    }
    send(404, { error: { message: "no such reconstruction (or it expired: they are kept 1 hour)", type: "not_found" } });
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  return { state, url: `http://127.0.0.1:${(srv.address() as AddressInfo).port}/v1`, close: () => srv.close() };
}

async function setupLocal(prefix: string, url: string) {
  const { upsertModel, upsertRoute } = await import("../src/models.js");
  upsertModel({ id: `${prefix}-depth`, backend: "external", kind: "depth", base_url: url, upstream_model: "depth-test" });
  upsertModel({ id: `${prefix}-recon`, backend: "external", kind: "reconstruct", base_url: url, upstream_model: "recon-test" });
  upsertRoute({ name: "depth", kind: "depth", strategy: "priority", candidates: [`${prefix}-depth`] });
  upsertRoute({ name: "reconstruct", kind: "reconstruct", strategy: "priority", candidates: [`${prefix}-recon`] });
}

const ASK = { images_b64: [PHOTO, PHOTO], known: { one_measurement: { photo: 0, p1: [10, 20], p2: [110, 20], metres: 0.81 } } };

test("measure: depth and a reconstruction through the gateway, as Thread makes them; only the tenant's own jobs", async () => {
  const Fastify = (await import("fastify")).default;
  const { upsertTenant, createKey } = await import("../src/tenants.js");
  const { registerGateway } = await import("../src/api/gateway.js");
  const { db } = await import("../src/db.js");
  const up = await fakeMeasureServer();
  await setupLocal("m1", up.url);
  upsertTenant({ id: "thread-m", name: "Thread test", allowed: ["depth", "reconstruct"] });
  upsertTenant({ id: "other-m", name: "Someone else" });
  upsertTenant({ id: "chat-only-m", name: "Chat only", allowed: ["agent"] });
  const thread = { authorization: `Bearer ${createKey("thread-m", "t").key}` };
  const other = { authorization: `Bearer ${createKey("other-m", "o").key}` };
  const chatOnly = { authorization: `Bearer ${createKey("chat-only-m", "c").key}` };
  const app = Fastify({ bodyLimit: 64 * 1024 * 1024 });
  registerGateway(app);
  try {
    // Depth: one request, one answer, from the depth model only
    const d = await app.inject({ method: "POST", url: "/v1/depth", headers: thread, payload: { image_b64: PHOTO, focal_px: 812.5 } });
    assert.equal(d.statusCode, 200, d.body);
    assert.equal(d.headers["x-mux-route"], "depth");
    assert.equal(d.headers["x-mux-model"], "m1-depth");
    assert.equal(JSON.parse(d.body).focal_px, 812.5);
    assert.equal(up.state.depth[0].image_b64, PHOTO, "the photo goes on untouched");
    assert.equal(up.state.depth[0].model, "depth-test");
    const badDepth = await app.inject({ method: "POST", url: "/v1/depth", headers: thread, payload: { image_b64: PHOTO, focal_px: 0 } });
    assert.equal(badDepth.statusCode, 400);
    assert.match(badDepth.body, /focal_px/);

    // A reconstruction: create, poll (the result comes with the status), cancel
    const made = await app.inject({ method: "POST", url: "/v1/reconstruct", headers: thread, payload: ASK });
    assert.equal(made.statusCode, 202, made.body);
    assert.equal(made.headers["x-mux-route"], "reconstruct");
    assert.equal(made.headers["x-mux-model"], "m1-recon");
    const job = JSON.parse(made.body);
    assert.match(job.id, /^recon_[0-9a-f]{24}$/);
    assert.notEqual(job.id, "up_1", "the caller gets mux's id, not the machine's");
    assert.equal(job.model, "recon-test");
    const sent = up.state.created[0];
    assert.equal(sent.model, "recon-test");
    assert.deepEqual(sent.images_b64, ASK.images_b64);
    assert.deepEqual(sent.known, ASK.known, "the measurement goes on untouched");
    const poll = await app.inject({ method: "GET", url: `/v1/reconstruct/${job.id}`, headers: thread });
    assert.equal(poll.statusCode, 200, poll.body);
    const p = JSON.parse(poll.body);
    assert.equal(p.id, job.id);
    assert.equal(p.status, "succeeded");
    assert.deepEqual(p.result, RESULT);
    const cancel = await app.inject({ method: "POST", url: `/v1/reconstruct/${job.id}/cancel`, headers: thread });
    assert.deepEqual(JSON.parse(cancel.body), { id: job.id, status: "cancelled" });

    // Someone else's key, no key, an id that never was
    assert.equal((await app.inject({ method: "GET", url: `/v1/reconstruct/${job.id}`, headers: other })).statusCode, 404);
    assert.equal((await app.inject({ method: "POST", url: `/v1/reconstruct/${job.id}/cancel`, headers: other })).statusCode, 404);
    assert.equal((await app.inject({ method: "GET", url: `/v1/reconstruct/${job.id}` })).statusCode, 401);
    assert.equal((await app.inject({ method: "GET", url: "/v1/reconstruct/recon_nope", headers: thread })).statusCode, 404);
    assert.equal((await app.inject({ method: "POST", url: "/v1/reconstruct", payload: ASK })).statusCode, 401);
    assert.equal((await app.inject({ method: "POST", url: "/v1/depth", payload: { image_b64: PHOTO } })).statusCode, 401);

    // A key not allowed the routes
    assert.equal((await app.inject({ method: "POST", url: "/v1/reconstruct", headers: chatOnly, payload: ASK })).statusCode, 403);
    assert.equal((await app.inject({ method: "POST", url: "/v1/depth", headers: chatOnly, payload: { image_b64: PHOTO } })).statusCode, 403);

    // Too few photos: 400 here, before any machine is asked; the server's own 400 comes back with its words
    const n = up.state.created.length;
    const one = await app.inject({ method: "POST", url: "/v1/reconstruct", headers: thread, payload: { images_b64: [PHOTO] } });
    assert.equal(one.statusCode, 400);
    assert.match(JSON.parse(one.body).error.message, /2 to 12/);
    const bad = await app.inject({ method: "POST", url: "/v1/reconstruct", headers: thread, payload: { ...ASK, known: { one_measurement: { ...ASK.known.one_measurement, metres: 0 } } } });
    assert.equal(bad.statusCode, 400);
    assert.equal(JSON.parse(bad.body).error.message, "known.one_measurement.metres must be from 0.01 to 1000");
    assert.equal(up.state.created.length, n);

    // A `model` in the body does not move a reconstruction to the depth model, nor depth to the reconstruction model
    const named = await app.inject({ method: "POST", url: "/v1/reconstruct", headers: thread, payload: { ...ASK, model: "depth" } });
    assert.equal(named.statusCode, 202, named.body);
    assert.equal(named.headers["x-mux-model"], "m1-recon");
    const namedDepth = await app.inject({ method: "POST", url: "/v1/depth", headers: thread, payload: { image_b64: PHOTO, model: "reconstruct" } });
    assert.equal(namedDepth.headers["x-mux-model"], "m1-depth");

    // Nothing of the photos is kept in the request log; polls are not metered
    const logged = db.prepare("SELECT * FROM requests WHERE endpoint LIKE 'measure.%'").all() as Record<string, unknown>[];
    assert.ok(logged.length >= 4, `${logged.length} logged`);
    assert.ok(!JSON.stringify(logged).includes(PHOTO), "the photos are never logged");
    assert.ok(!JSON.stringify(logged).includes("0.81"), "the measurement is never logged");
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM requests WHERE endpoint LIKE '%reconstruct%' AND endpoint <> 'measure.reconstruct'").get() as { n: number }).n, 0);
  } finally {
    await app.close();
    up.close();
  }
});

test("measure: without the route the gateway says what to run; body limits: depth 50 MB, reconstruct 150 MB", async () => {
  const Fastify = (await import("fastify")).default;
  const { registerGateway } = await import("../src/api/gateway.js");
  const { upsertTenant, createKey } = await import("../src/tenants.js");
  const { db } = await import("../src/db.js");
  upsertTenant({ id: "big-m", name: "Big" });
  const h = { authorization: `Bearer ${createKey("big-m", "b").key}`, "content-type": "application/json" };
  const app = Fastify({ bodyLimit: 64 * 1024 * 1024 });
  registerGateway(app);
  const saved = db.prepare("SELECT * FROM routes WHERE name = 'reconstruct'").get();
  try {
    db.prepare("DELETE FROM routes WHERE name = 'reconstruct'").run();
    const none = await app.inject({ method: "POST", url: "/v1/reconstruct", headers: h, payload: ASK });
    assert.equal(none.statusCode, 503, none.body);
    assert.match(none.body, /deploy\/measure\.sh/);
    // Over the server's usual 64 MB, under 150: accepted as a body (no route here: 503, not 413)
    const mid = Buffer.from(JSON.stringify({ images_b64: ["A".repeat(80 * 1024 * 1024), PHOTO] }));
    assert.notEqual((await app.inject({ method: "POST", url: "/v1/reconstruct", headers: h, payload: mid })).statusCode, 413, "80 MB is within the limit");
    assert.equal((await app.inject({ method: "POST", url: "/v1/reconstruct", headers: h, payload: Buffer.alloc(150 * 1024 * 1024 + 1, 0x20) })).statusCode, 413);
    const d40 = Buffer.from(JSON.stringify({ image_b64: "A".repeat(40 * 1024 * 1024) }));
    assert.notEqual((await app.inject({ method: "POST", url: "/v1/depth", headers: h, payload: d40 })).statusCode, 413, "40 MB is within the limit");
    assert.equal((await app.inject({ method: "POST", url: "/v1/depth", headers: h, payload: Buffer.alloc(50 * 1024 * 1024 + 1, 0x20) })).statusCode, 413);
  } finally {
    if (saved) {
      const { upsertRoute } = await import("../src/models.js");
      upsertRoute({ name: "reconstruct", kind: "reconstruct", strategy: "priority", candidates: [] });
    }
    await app.close();
  }
});

test("measure: from the Railway gateway to the Mac node and on to its measure server, each with its own id", async () => {
  const Fastify = (await import("fastify")).default;
  const { upsertModel, upsertRoute } = await import("../src/models.js");
  const { upsertTenant, createKey } = await import("../src/tenants.js");
  const { saveProvider } = await import("../src/providers.js");
  const { registerGateway } = await import("../src/api/gateway.js");
  const up = await fakeMeasureServer();
  // The node: a mux whose measure models are the measure server; the gateway is its tenant
  const node = Fastify({ bodyLimit: 64 * 1024 * 1024 });
  registerGateway(node);
  await node.listen({ port: 0, host: "127.0.0.1" });
  const nodeUrl = `http://127.0.0.1:${(node.server.address() as AddressInfo).port}`;
  await setupLocal("mnode", up.url);
  upsertTenant({ id: "gateway-on-node-m", name: "the gateway" });
  const gwKey = createKey("gateway-on-node-m", "g").key;
  saveProvider({ id: "mac-m", name: "Mac test", kind: "mux", base_url: nodeUrl, api_key: gwKey, enabled: true, status: "online" });
  upsertModel({ id: "mac-m/mnode-depth", backend: "node", kind: "depth", provider_id: "mac-m", upstream_model: "mnode-depth", base_url: `${nodeUrl}/v1` });
  upsertModel({ id: "mac-m/mnode-recon", backend: "node", kind: "reconstruct", provider_id: "mac-m", upstream_model: "mnode-recon", base_url: `${nodeUrl}/v1` });
  upsertTenant({ id: "thread-gw-m", name: "Thread" });
  const thread = { authorization: `Bearer ${createKey("thread-gw-m", "t").key}` };
  const gw = Fastify({ bodyLimit: 64 * 1024 * 1024 });
  registerGateway(gw);
  try {
    // One database plays both machines here: the gateway's routes name the node's models, the node's its own
    upsertRoute({ name: "depth", kind: "depth", strategy: "priority", candidates: ["mac-m/mnode-depth", "mnode-depth"] });
    upsertRoute({ name: "reconstruct", kind: "reconstruct", strategy: "priority", candidates: ["mac-m/mnode-recon", "mnode-recon"] });
    const d = await gw.inject({ method: "POST", url: "/v1/depth", headers: thread, payload: { image_b64: PHOTO } });
    assert.equal(d.statusCode, 200, d.body);
    assert.equal(d.headers["x-mux-model"], "mac-m/mnode-depth");
    assert.equal(JSON.parse(d.body).model, "depth-test");
    const made = await gw.inject({ method: "POST", url: "/v1/reconstruct", headers: thread, payload: ASK });
    assert.equal(made.statusCode, 202, made.body);
    assert.equal(made.headers["x-mux-model"], "mac-m/mnode-recon");
    const job = JSON.parse(made.body);
    assert.equal(up.state.created.at(-1)!.model, "recon-test");
    const poll = await gw.inject({ method: "GET", url: `/v1/reconstruct/${job.id}`, headers: thread });
    assert.equal(poll.statusCode, 200, poll.body);
    assert.equal(JSON.parse(poll.body).id, job.id);
    assert.deepEqual(JSON.parse(poll.body).result, RESULT);
    const cancel = await gw.inject({ method: "POST", url: `/v1/reconstruct/${job.id}/cancel`, headers: thread });
    assert.equal(JSON.parse(cancel.body).status, "cancelled");
    // The node was asked with the gateway's key on it, never the caller's
    assert.ok(!up.state.auth.includes(thread.authorization));
  } finally {
    await gw.close();
    await node.close();
    up.close();
  }
});

test("measure: the local measure server keeps this Mac's presence: polite only when that model is loaded, nothing when away", async () => {
  const Fastify = (await import("fastify")).default;
  const { upsertTenant, createKey } = await import("../src/tenants.js");
  const { registerGateway } = await import("../src/api/gateway.js");
  const { registerAdmin } = await import("../src/admin/routes.js");
  const { inCooldown } = await import("../src/router/health.js");
  const up = await fakeMeasureServer();
  await setupLocal("mp", up.url);
  upsertTenant({ id: "presence-m", name: "Presence" });
  const key = createKey("presence-m", "p").key;
  const app = Fastify();
  registerGateway(app);
  registerAdmin(app);
  const admin = { authorization: "Bearer admin-token" };
  const setPresence = (payload: object) => app.inject({ method: "PUT", url: "/api/admin/presence", headers: admin, payload });
  const make = () => app.inject({ method: "POST", url: "/v1/reconstruct", headers: { authorization: `Bearer ${key}` }, payload: ASK });
  const depth = () => app.inject({ method: "POST", url: "/v1/depth", headers: { authorization: `Bearer ${key}` }, payload: { image_b64: PHOTO } });
  try {
    assert.equal(JSON.parse((await setPresence({ mode: "available", using: true })).body).state, "polite");
    const r = await make();
    assert.equal(r.statusCode, 503, r.body);
    assert.match(r.body, /polite/);
    assert.equal((await depth()).statusCode, 503);
    assert.equal(up.state.created.length + up.state.depth.length, 0);
    assert.equal(inCooldown("mp-recon"), false, "resting is not failing");
    await setPresence({ using: false });
    assert.equal((await depth()).statusCode, 200);
    await setPresence({ using: true });
    assert.equal((await depth()).statusCode, 200, "polite, and the depth model is loaded now: it answers");
    assert.equal((await make()).statusCode, 503, "polite, and the reconstruction model is not loaded: the depth model's being loaded does not count");
    await setPresence({ using: false });
    assert.equal((await make()).statusCode, 202);
    await setPresence({ using: true });
    assert.equal((await make()).statusCode, 202, "polite, and loaded now: it takes the job");
    await setPresence({ mode: "off", using: false });
    assert.equal((await make()).statusCode, 503);
    assert.equal((await depth()).statusCode, 503);
    assert.equal(up.state.created.length, 2);
  } finally {
    await setPresence({ mode: "available", using: false });
    await app.close();
    up.close();
  }
});
