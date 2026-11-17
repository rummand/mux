import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "mux-video-"));
process.env.MUX_HOME = dir;
process.env.MUX_DB = join(dir, "mux.db");
process.env.MUX_PORT = "1";
process.env.MUX_ADMIN_TOKEN = "admin-token";

const MP4 = Buffer.from([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x6d, 0x70, 0x34, 0x32, 1, 2, 3]);

// A video server like server/video/video_server.py, with the same contract: jobs it numbers itself.
async function fakeVideoServer() {
  const state = { loaded: false, created: [] as Record<string, unknown>[], jobs: new Map<string, string>(), auth: [] as string[] };
  const srv = createServer(async (req: IncomingMessage, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    state.auth.push(req.headers.authorization ?? "");
    const send = (status: number, obj: unknown) => { res.statusCode = status; res.setHeader("content-type", "application/json"); res.end(JSON.stringify(obj)); };
    const path = (req.url ?? "").split("?")[0];
    if (req.method === "GET" && path === "/v1/models") return send(200, { object: "list", data: [{ id: "wan-test", loaded: state.loaded }] });
    if (req.method === "POST" && path === "/v1/videos/generations") {
      const b = JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>;
      if (b.seconds === 11) return send(400, { error: { message: "seconds must be from 1 to 10 (got 11)", type: "invalid_request_error" } });
      state.created.push(b);
      state.loaded = true;
      const id = `up_${state.created.length}`;
      state.jobs.set(id, "queued");
      return send(202, { id, object: "video", status: "queued", model: "wan-test" });
    }
    const m = /^\/v1\/videos\/([^/]+)(\/content|\/cancel)?$/.exec(path);
    if (m && state.jobs.has(m[1])) {
      if (m[2] === "/cancel") { state.jobs.set(m[1], "cancelled"); return send(200, { id: m[1], status: "cancelled" }); }
      if (m[2] === "/content") { res.setHeader("content-type", "video/mp4"); return res.end(MP4); }
      state.jobs.set(m[1], "succeeded");
      return send(200, { id: m[1], object: "video", status: "succeeded", progress: 1, model: "wan-test", seconds: 2, size: "832x480" });
    }
    send(404, { error: { message: "no such video (or it expired: videos are kept 1 hour)", type: "not_found" } });
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  return { state, url: `http://127.0.0.1:${(srv.address() as AddressInfo).port}/v1`, close: () => srv.close() };
}

const DEPTH = { type: "depth", format: "png16-zip", video_b64: Buffer.from("zip").toString("base64") };
const ASK = { prompt: "a quiet street, evening", seconds: 2, fps: 8, size: "832x480", seed: 1 };

test("video: a job through the gateway, as Thread makes it: create, poll, content, cancel; only the tenant's own", async () => {
  const Fastify = (await import("fastify")).default;
  const { upsertModel, upsertRoute } = await import("../src/models.js");
  const { upsertTenant, createKey } = await import("../src/tenants.js");
  const { registerGateway } = await import("../src/api/gateway.js");
  const { db } = await import("../src/db.js");
  const up = await fakeVideoServer();
  upsertModel({ id: "wan-local", backend: "external", kind: "video", base_url: up.url, upstream_model: "wan-test" });
  upsertRoute({ name: "video", kind: "video", strategy: "priority", candidates: ["wan-local"] });
  upsertRoute({ name: "video-depth", kind: "video", strategy: "priority", candidates: ["wan-local"] });
  upsertTenant({ id: "thread-test", name: "Thread test", allowed: ["video", "video-depth"] });
  upsertTenant({ id: "other-test", name: "Someone else" });
  upsertTenant({ id: "chat-only", name: "Chat only", allowed: ["agent"] });
  const thread = { authorization: `Bearer ${createKey("thread-test", "t").key}` };
  const other = { authorization: `Bearer ${createKey("other-test", "o").key}` };
  const chatOnly = { authorization: `Bearer ${createKey("chat-only", "c").key}` };
  const app = Fastify({ bodyLimit: 64 * 1024 * 1024 });
  registerGateway(app);
  try {
    const made = await app.inject({ method: "POST", url: "/v1/videos/generations", headers: thread, payload: { model: "video-depth", ...ASK, control: DEPTH } });
    assert.equal(made.statusCode, 202, made.body);
    assert.equal(made.headers["x-mux-route"], "video-depth");
    assert.equal(made.headers["x-mux-model"], "wan-local");
    const job = JSON.parse(made.body);
    assert.match(job.id, /^video_[0-9a-f]{24}$/);
    assert.notEqual(job.id, "up_1", "the caller gets mux's id, not the machine's");
    assert.equal(job.status, "queued");
    assert.equal(job.model, "wan-test");
    const sent = up.state.created[0];
    assert.equal(sent.model, "wan-test", "the server gets its own model name");
    assert.deepEqual(sent.control, DEPTH, "the depth pass goes on untouched");
    assert.equal(sent.prompt, ASK.prompt);

    const poll = await app.inject({ method: "GET", url: `/v1/videos/${job.id}`, headers: thread });
    assert.equal(poll.statusCode, 200, poll.body);
    assert.deepEqual(JSON.parse(poll.body), { id: job.id, object: "video", status: "succeeded", progress: 1, model: "wan-test", seconds: 2, size: "832x480" });
    const content = await app.inject({ method: "GET", url: `/v1/videos/${job.id}/content`, headers: thread });
    assert.equal(content.statusCode, 200);
    assert.equal(content.headers["content-type"], "video/mp4");
    assert.deepEqual(content.rawPayload, MP4);
    const cancel = await app.inject({ method: "POST", url: `/v1/videos/${job.id}/cancel`, headers: thread });
    assert.deepEqual(JSON.parse(cancel.body), { id: job.id, status: "cancelled" });

    // Someone else's key, no key, an id that never was
    for (const url of [`/v1/videos/${job.id}`, `/v1/videos/${job.id}/content`]) {
      assert.equal((await app.inject({ method: "GET", url, headers: other })).statusCode, 404);
      assert.equal((await app.inject({ method: "GET", url })).statusCode, 401);
    }
    assert.equal((await app.inject({ method: "POST", url: `/v1/videos/${job.id}/cancel`, headers: other })).statusCode, 404);
    assert.equal((await app.inject({ method: "GET", url: "/v1/videos/video_nope", headers: thread })).statusCode, 404);
    assert.equal((await app.inject({ method: "POST", url: "/v1/videos/generations", payload: ASK })).statusCode, 401);

    // A key not allowed the route
    const refused = await app.inject({ method: "POST", url: "/v1/videos/generations", headers: chatOnly, payload: { model: "video", ...ASK } });
    assert.equal(refused.statusCode, 403, refused.body);

    // video-depth without a depth pass: 400 here, before any machine is asked
    const n = up.state.created.length;
    const noDepth = await app.inject({ method: "POST", url: "/v1/videos/generations", headers: thread, payload: { model: "video-depth", ...ASK } });
    assert.equal(noDepth.statusCode, 400);
    assert.match(JSON.parse(noDepth.body).error.message, /control/);
    // The server's own 400 comes back with its words, and is not a failure of the model
    const bad = await app.inject({ method: "POST", url: "/v1/videos/generations", headers: thread, payload: { model: "video", ...ASK, seconds: 11 } });
    assert.equal(bad.statusCode, 400);
    assert.equal(JSON.parse(bad.body).error.message, "seconds must be from 1 to 10 (got 11)");
    assert.equal(up.state.created.length, n);

    // Text to video on the plain route; an unknown name goes to `video`
    const plain = await app.inject({ method: "POST", url: "/v1/videos/generations", headers: thread, payload: { model: "sora-2", ...ASK } });
    assert.equal(plain.statusCode, 202, plain.body);
    assert.equal(plain.headers["x-mux-route"], "video");

    // Nothing of the prompt or the media is kept in the request log
    const logged = db.prepare("SELECT * FROM requests WHERE endpoint = 'openai.videos.generations'").all() as Record<string, unknown>[];
    assert.ok(logged.length >= 3);
    assert.ok(!JSON.stringify(logged).includes("quiet street"), "the prompt is never logged");
    assert.ok(!JSON.stringify(logged).includes(DEPTH.video_b64), "the depth pass is never logged");
    // Polls are not metered
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM requests WHERE endpoint LIKE '%video%' AND endpoint <> 'openai.videos.generations'").get() as { n: number }).n, 0);
  } finally {
    await app.close();
    up.close();
  }
});

test("video: the body may be 200 MB, no more", async () => {
  const Fastify = (await import("fastify")).default;
  const { registerGateway } = await import("../src/api/gateway.js");
  const { upsertTenant, createKey } = await import("../src/tenants.js");
  upsertTenant({ id: "big-test", name: "Big" });
  const h = { authorization: `Bearer ${createKey("big-test", "b").key}`, "content-type": "application/json" };
  const app = Fastify({ bodyLimit: 64 * 1024 * 1024 });
  registerGateway(app);
  try {
    // Over the server's usual 64 MB, under 200: accepted as a body (the route then has no model here: 503)
    const mid = Buffer.from(JSON.stringify({ model: "video", ...ASK, control: { ...DEPTH, video_b64: "A".repeat(80 * 1024 * 1024) } }));
    const r1 = await app.inject({ method: "POST", url: "/v1/videos/generations", headers: h, payload: mid });
    assert.notEqual(r1.statusCode, 413, "80 MB is within the limit");
    const big = Buffer.alloc(200 * 1024 * 1024 + 1, 0x20);
    const r2 = await app.inject({ method: "POST", url: "/v1/videos/generations", headers: h, payload: big });
    assert.equal(r2.statusCode, 413);
  } finally {
    await app.close();
  }
});

test("video: from the Railway gateway to the Mac node and on to its video server, each with its own id", async () => {
  const Fastify = (await import("fastify")).default;
  const { upsertModel, upsertRoute } = await import("../src/models.js");
  const { upsertTenant, createKey } = await import("../src/tenants.js");
  const { saveProvider } = await import("../src/providers.js");
  const { registerGateway } = await import("../src/api/gateway.js");
  const up = await fakeVideoServer();
  // The node: a mux whose `wan-node-local` is the video server; the gateway is its tenant
  const node = Fastify({ bodyLimit: 64 * 1024 * 1024 });
  registerGateway(node);
  await node.listen({ port: 0, host: "127.0.0.1" });
  const nodeUrl = `http://127.0.0.1:${(node.server.address() as AddressInfo).port}`;
  upsertModel({ id: "wan-node-local", backend: "external", kind: "video", base_url: up.url, upstream_model: "wan-test" });
  upsertTenant({ id: "gateway-on-node", name: "the gateway" });
  const gwKey = createKey("gateway-on-node", "g").key;
  saveProvider({ id: "mac-test", name: "Mac test", kind: "mux", base_url: nodeUrl, api_key: gwKey, enabled: true, status: "online" });
  upsertModel({ id: "mac-test/wan-node-local", backend: "node", kind: "video", provider_id: "mac-test", upstream_model: "wan-node-local", base_url: `${nodeUrl}/v1` });
  upsertRoute({ name: "video-depth", kind: "video", strategy: "priority", candidates: ["mac-test/wan-node-local"] });
  upsertTenant({ id: "thread-gw", name: "Thread" });
  const thread = { authorization: `Bearer ${createKey("thread-gw", "t").key}` };
  const gw = Fastify({ bodyLimit: 64 * 1024 * 1024 });
  registerGateway(gw);
  try {
    const made = await gw.inject({ method: "POST", url: "/v1/videos/generations", headers: thread, payload: { model: "video-depth", ...ASK, control: DEPTH } });
    assert.equal(made.statusCode, 202, made.body);
    assert.equal(made.headers["x-mux-model"], "mac-test/wan-node-local");
    const job = JSON.parse(made.body);
    assert.equal(up.state.created.at(-1)!.model, "wan-test");
    const poll = await gw.inject({ method: "GET", url: `/v1/videos/${job.id}`, headers: thread });
    assert.equal(poll.statusCode, 200, poll.body);
    assert.equal(JSON.parse(poll.body).id, job.id);
    assert.equal(JSON.parse(poll.body).status, "succeeded");
    const content = await gw.inject({ method: "GET", url: `/v1/videos/${job.id}/content`, headers: thread });
    assert.equal(content.statusCode, 200);
    assert.deepEqual(content.rawPayload, MP4);
    // The node was asked with the gateway's key on it, never the caller's
    assert.ok(!up.state.auth.includes(thread.authorization));
  } finally {
    await gw.close();
    await node.close();
    up.close();
  }
});

test("video: a local video server keeps this Mac's presence: polite only when loaded, nothing when away", async () => {
  const Fastify = (await import("fastify")).default;
  const { upsertModel, upsertRoute } = await import("../src/models.js");
  const { upsertTenant, createKey } = await import("../src/tenants.js");
  const { registerGateway } = await import("../src/api/gateway.js");
  const { registerAdmin } = await import("../src/admin/routes.js");
  const { inCooldown } = await import("../src/router/health.js");
  const up = await fakeVideoServer();
  upsertModel({ id: "wan-presence", backend: "external", kind: "video", base_url: up.url, upstream_model: "wan-test" });
  upsertRoute({ name: "video", kind: "video", strategy: "priority", candidates: ["wan-presence"] });
  upsertTenant({ id: "presence-test", name: "Presence" });
  const key = createKey("presence-test", "p").key;
  const app = Fastify();
  registerGateway(app);
  registerAdmin(app);
  const admin = { authorization: "Bearer admin-token" };
  const setPresence = (payload: object) => app.inject({ method: "PUT", url: "/api/admin/presence", headers: admin, payload });
  const make = () => app.inject({ method: "POST", url: "/v1/videos/generations", headers: { authorization: `Bearer ${key}` }, payload: { model: "video", ...ASK } });
  try {
    assert.equal(JSON.parse((await setPresence({ mode: "available", using: true })).body).state, "polite");
    const r = await make();
    assert.equal(r.statusCode, 503, r.body);
    assert.match(r.body, /polite/);
    assert.equal(up.state.created.length, 0);
    assert.equal(inCooldown("wan-presence"), false, "resting is not failing");
    await setPresence({ using: false });
    assert.equal((await make()).statusCode, 202);
    await setPresence({ using: true });
    assert.equal((await make()).statusCode, 202, "polite, and loaded now: it takes the job");
    await setPresence({ mode: "off", using: false });
    assert.equal((await make()).statusCode, 503);
    assert.equal(up.state.created.length, 2);
  } finally {
    await setPresence({ mode: "available", using: false });
    await app.close();
    up.close();
  }
});

const CAMERA = { convention: "sets", sensorMm: [36, 24], aspect: "16:9", frames: [{ t: 0, pos: [0, 1.6, 0], quat: [0, 0, 0, 1], focalMm: 24 }, { t: 2, pos: [0, 1.6, -1.2], quat: [0, 0.087, 0, 0.996], focalMm: 24 }] };
const TAKE = { model: "video-camera", prompt: "a lakeside walk at noon", seconds: 2, fps: 16, size: "832x480", seed: 2, image_b64: Buffer.from("png").toString("base64"), camera: CAMERA };

test("video-camera: its own kind — a camera take goes only to a camera model, a plain video never does", async () => {
  const Fastify = (await import("fastify")).default;
  const { upsertModel, upsertRoute } = await import("../src/models.js");
  const { upsertTenant, createKey } = await import("../src/tenants.js");
  const { registerGateway } = await import("../src/api/gateway.js");
  const wan = await fakeVideoServer();
  const cam = await fakeVideoServer();
  upsertModel({ id: "wan-cam-test", backend: "external", kind: "video", base_url: wan.url, upstream_model: "wan-test" });
  upsertModel({ id: "lingbot-cam-test", backend: "external", kind: "video-camera", base_url: cam.url, upstream_model: "lingbot-test" });
  upsertRoute({ name: "video", kind: "video", strategy: "priority", candidates: [] });           // an empty route takes every model of its kind
  upsertRoute({ name: "video-camera", kind: "video-camera", strategy: "priority", candidates: [] });
  upsertTenant({ id: "thread-cam", name: "Thread", allowed: ["video", "video-camera"], aliases: { "sets-long-take": "video-camera" } });
  upsertTenant({ id: "no-cam", name: "Without the camera route", allowed: ["video"] });
  const thread = { authorization: `Bearer ${createKey("thread-cam", "t").key}` };
  const noCam = { authorization: `Bearer ${createKey("no-cam", "n").key}` };
  const app = Fastify({ bodyLimit: 64 * 1024 * 1024 });
  registerGateway(app);
  try {
    const made = await app.inject({ method: "POST", url: "/v1/videos/generations", headers: thread, payload: TAKE });
    assert.equal(made.statusCode, 202, made.body);
    assert.equal(made.headers["x-mux-route"], "video-camera");
    assert.equal(made.headers["x-mux-model"], "lingbot-cam-test");
    assert.equal(wan.state.created.length, 0, "Wan never sees a camera take");
    const sent = cam.state.created[0];
    assert.equal(sent.model, "lingbot-test", "the camera server gets its own model name");
    assert.deepEqual(sent.camera, CAMERA, "the camera path goes on untouched");
    assert.equal(sent.image_b64, TAKE.image_b64);
    const job = JSON.parse(made.body);
    const poll = await app.inject({ method: "GET", url: `/v1/videos/${job.id}`, headers: thread });
    assert.equal(JSON.parse(poll.body).status, "succeeded");
    const content = await app.inject({ method: "GET", url: `/v1/videos/${job.id}/content`, headers: thread });
    assert.deepEqual(content.rawPayload, MP4);
    // by the tenant's alias and with "mux/"
    for (const model of ["sets-long-take", "mux/video-camera"]) {
      const r = await app.inject({ method: "POST", url: "/v1/videos/generations", headers: thread, payload: { ...TAKE, model } });
      assert.equal(r.statusCode, 202, `${model}: ${r.body}`);
    }
    assert.equal(wan.state.created.length, 0);
    assert.equal(cam.state.created.length, 3);

    // A plain video (even with a camera in the body) goes to Wan; the camera model is not of its kind
    const plain = await app.inject({ method: "POST", url: "/v1/videos/generations", headers: thread, payload: { ...TAKE, model: "video" } });
    assert.equal(plain.statusCode, 202, plain.body);
    assert.equal(plain.headers["x-mux-model"], "wan-cam-test");
    assert.equal(cam.state.created.length, 3);

    // What can never work is refused here, before a machine is asked
    for (const [change, words] of [[{ camera: undefined }, /camera/], [{ camera: { ...CAMERA, frames: [] } }, /camera/], [{ image_b64: undefined }, /image_b64/]] as const) {
      const r = await app.inject({ method: "POST", url: "/v1/videos/generations", headers: thread, payload: { ...TAKE, ...change } });
      assert.equal(r.statusCode, 400, r.body);
      assert.match(JSON.parse(r.body).error.message, words);
    }
    assert.equal(cam.state.created.length, 3);
    // A key without the route
    assert.equal((await app.inject({ method: "POST", url: "/v1/videos/generations", headers: noCam, payload: TAKE })).statusCode, 403);
    // No camera model up: 503 (no_capable_model, as for any route whose models are all resting or off; all_models_failed
    // when one was tried and failed), never Wan in its place
    upsertModel({ id: "lingbot-cam-test", backend: "external", kind: "video-camera", base_url: cam.url, upstream_model: "lingbot-test", enabled: false });
    const none = await app.inject({ method: "POST", url: "/v1/videos/generations", headers: thread, payload: TAKE });
    assert.equal(none.statusCode, 503, none.body);
    assert.equal(JSON.parse(none.body).error.type, "no_capable_model");
    assert.equal(wan.state.created.length, 1);
  } finally {
    await app.close();
    wan.close();
    cam.close();
  }
});
