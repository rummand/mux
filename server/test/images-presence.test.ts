import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "mux-images-presence-"));
process.env.MUX_HOME = dir;
process.env.MUX_DB = join(dir, "mux.db");
process.env.MUX_PORT = "1";
process.env.MUX_ADMIN_TOKEN = "admin-token";

// A local image server like server/images/image_server.py: GET /v1/models says whether its model is loaded.
async function fakeImageServer() {
  const state = { loaded: false, generations: 0 };
  const srv = createServer(async (req: IncomingMessage, res) => {
    for await (const _ of req) void _;
    res.setHeader("content-type", "application/json");
    if (req.method === "GET") return res.end(JSON.stringify({ object: "list", data: [{ id: "flux2-klein-4b-q4", loaded: state.loaded }] }));
    state.generations++;
    state.loaded = true;
    res.end(JSON.stringify({ created: 1, data: [{ b64_json: Buffer.from("png").toString("base64") }] }));
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  return { state, url: `http://127.0.0.1:${(srv.address() as AddressInfo).port}/v1`, close: () => srv.close() };
}

test("a local image service keeps this Mac's presence: polite only when its model is loaded, nothing when away", async () => {
  const Fastify = (await import("fastify")).default;
  const { upsertModel, upsertRoute } = await import("../src/models.js");
  const { upsertTenant, createKey } = await import("../src/tenants.js");
  const { registerGateway } = await import("../src/api/gateway.js");
  const { registerAdmin } = await import("../src/admin/routes.js");
  const { inCooldown } = await import("../src/router/health.js");
  const up = await fakeImageServer();
  upsertModel({ id: "flux-local", backend: "external", kind: "image", base_url: up.url, upstream_model: "flux2-klein-4b-q4" });
  upsertRoute({ name: "image", kind: "image", strategy: "priority", candidates: ["flux-local"] });
  upsertTenant({ id: "composer-test", name: "Composer test" });
  const { key } = createKey("composer-test", "test");
  const app = Fastify();
  registerGateway(app);
  registerAdmin(app);
  const admin = { authorization: "Bearer admin-token" };
  const setPresence = (payload: object) => app.inject({ method: "PUT", url: "/api/admin/presence", headers: admin, payload });
  const generate = () => app.inject({ method: "POST", url: "/v1/images/generations", headers: { authorization: `Bearer ${key}` }, payload: { model: "image", prompt: "a lamp", size: "512x512", seed: 1 } });
  try {
    // The owner is using the Mac: polite. The model is not loaded, so the heavy load does not start now.
    assert.equal(JSON.parse((await setPresence({ mode: "available", using: true })).body).state, "polite");
    for (let i = 0; i < 4; i++) {
      const r = await generate();
      assert.equal(r.statusCode, 503, r.body);
      assert.match(r.body, /polite/);
    }
    assert.equal(up.state.generations, 0);
    assert.equal(inCooldown("flux-local"), false, "resting is not failing: no cooldown");

    // Free: it loads and answers; then polite again, and as it is loaded now, it answers
    await setPresence({ using: false });
    assert.equal((await generate()).statusCode, 200);
    await setPresence({ using: true });
    assert.equal((await generate()).statusCode, 200);
    assert.equal(up.state.generations, 2);

    // Turned off: away, nothing at all
    await setPresence({ mode: "off", using: false });
    const away = await generate();
    assert.equal(away.statusCode, 503, away.body);
    assert.equal(up.state.generations, 2);
  } finally {
    await setPresence({ mode: "available", using: false });
    await app.close();
    up.close();
  }
});
