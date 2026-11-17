import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import Fastify from "fastify";

// An image server like server/images/image_server.py: it says what it was asked, as a PNG would come back.
async function fakeImageServer() {
  const seen: { path: string; type: string; body: Buffer }[] = [];
  const srv = createServer(async (req: IncomingMessage, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    seen.push({ path: req.url ?? "", type: req.headers["content-type"] ?? "", body: Buffer.concat(chunks) });
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ created: 1, data: [{ b64_json: Buffer.from(`png for ${req.url}`).toString("base64") }] }));
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  return { seen, url: `http://127.0.0.1:${(srv.address() as AddressInfo).port}/v1`, close: () => srv.close() };
}

test("images: generations and edits reach the image model on routes image and image-edit, the answer as it came", async () => {
  const { upsertModel, upsertRoute } = await import("../src/models.js");
  const { upsertTenant, createKey } = await import("../src/tenants.js");
  const { registerGateway } = await import("../src/api/gateway.js");
  const up = await fakeImageServer();
  upsertModel({ id: "flux-test", backend: "external", kind: "image", base_url: up.url, upstream_model: "flux2-klein-4b" });
  upsertRoute({ name: "image", kind: "image", strategy: "priority", candidates: ["flux-test"] });
  upsertRoute({ name: "image-edit", kind: "image", strategy: "priority", candidates: ["flux-test"] });
  upsertTenant({ id: "lbs-test", name: "LBS test" });
  const { key } = createKey("lbs-test", "test");
  const app = Fastify({ bodyLimit: 64 * 1024 * 1024 });
  registerGateway(app);
  const h = { authorization: `Bearer ${key}` };
  try {
    // Text to image, as LBS Studio's MuxImageGenerate sends it
    const gen = await app.inject({ method: "POST", url: "/v1/images/generations", headers: h, payload: { model: "image", prompt: "a red bicycle", size: "1024x1024", n: 1, response_format: "b64_json" } });
    assert.equal(gen.statusCode, 200, gen.body);
    assert.equal(gen.headers["x-mux-model"], "flux-test");
    assert.equal(gen.headers["x-mux-route"], "image");
    assert.equal(Buffer.from(JSON.parse(gen.body).data[0].b64_json, "base64").toString(), "png for /v1/images/generations?model=flux2-klein-4b");
    const sent = JSON.parse(up.seen[0].body.toString());
    assert.equal(sent.model, "flux2-klein-4b");
    assert.equal(sent.prompt, "a red bicycle");

    // An edit, as MuxImageBlend sends it: multipart with model, prompt and a PNG that must arrive byte for byte
    const b = "lbs-0123";
    const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 255, 13, 10, 45, 45]);
    const field = (n: string, v: string) => `--${b}\r\nContent-Disposition: form-data; name="${n}"\r\n\r\n${v}\r\n`;
    const body = Buffer.concat([
      Buffer.from(field("prompt", "Match the lighting") + field("model", "image-edit") + field("response_format", "b64_json")),
      Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="image"; filename="composition.png"\r\nContent-Type: image/png\r\n\r\n`), png,
      Buffer.from(`\r\n--${b}--\r\n`),
    ]);
    const edit = await app.inject({ method: "POST", url: "/v1/images/edits", headers: { ...h, "content-type": `multipart/form-data; boundary=${b}` }, payload: body });
    assert.equal(edit.statusCode, 200, edit.body);
    assert.equal(edit.headers["x-mux-route"], "image-edit");
    const got = up.seen[1];
    assert.equal(got.path, "/v1/images/edits?model=flux2-klein-4b");
    assert.ok(got.body.includes(png), "the image passes through untouched");
    assert.match(got.body.toString("latin1"), /name="model"\r\n\r\nflux2-klein-4b\r\n/);

    // A name the tenant does not know goes to the image route, as for every other kind
    const other = await app.inject({ method: "POST", url: "/v1/images/generations", headers: h, payload: { model: "gpt-image-1", prompt: "x" } });
    assert.equal(other.statusCode, 200, other.body);
    assert.equal(other.headers["x-mux-route"], "image");
  } finally {
    await app.close();
    up.close();
  }
});

test("audio and images: a model that answers 404 (gone where it was registered) falls through to the next on the route", async () => {
  const { upsertModel, upsertRoute } = await import("../src/models.js");
  const { upsertTenant, createKey } = await import("../src/tenants.js");
  const { registerGateway } = await import("../src/api/gateway.js");
  const gone = createServer((_req, res) => { res.statusCode = 404; res.setHeader("content-type", "application/json"); res.end('{"error":"no engine \'hviske-v5\' here"}'); });
  await new Promise<void>((r) => gone.listen(0, "127.0.0.1", r));
  const up = await fakeImageServer();
  upsertModel({ id: "stt-gone", backend: "external", kind: "transcription", base_url: `http://127.0.0.1:${(gone.address() as AddressInfo).port}/v1`, upstream_model: "hviske-v5" });
  upsertModel({ id: "stt-ok", backend: "external", kind: "transcription", base_url: up.url, upstream_model: "whisper-turbo" });
  upsertRoute({ name: "transcribe", kind: "transcription", strategy: "priority", candidates: ["stt-gone", "stt-ok"] });
  upsertTenant({ id: "fall-test", name: "fall test" });
  const { key } = createKey("fall-test", "test");
  const app = Fastify({ bodyLimit: 64 * 1024 * 1024 });
  registerGateway(app);
  try {
    const b = "x9";
    const body = Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="model"\r\n\r\ntranscribe\r\n--${b}\r\nContent-Disposition: form-data; name="file"; filename="a.mp3"\r\n\r\nID3\r\n--${b}--\r\n`);
    const r = await app.inject({ method: "POST", url: "/v1/audio/transcriptions", headers: { authorization: `Bearer ${key}`, "content-type": `multipart/form-data; boundary=${b}` }, payload: body });
    assert.equal(r.statusCode, 200, r.body);
    assert.equal(r.headers["x-mux-model"], "stt-ok");
    assert.equal(r.headers["x-mux-fallbacks"], "1");
  } finally {
    await app.close();
    up.close();
    gone.close();
  }
});

test("images: image-edit-hq reaches the second model by its own name, and the fast model when it fails", async () => {
  const { upsertModel, upsertRoute } = await import("../src/models.js");
  const { upsertTenant, createKey } = await import("../src/tenants.js");
  const { registerGateway } = await import("../src/api/gateway.js");
  // One image server answering for both models (server/images/image_server.py with MUX_IMAGE_HQ_MODEL): the second
  // one fails here with a 500 (as an out-of-memory would), so the route falls to the fast one.
  const seen: string[] = [];
  const srv = createServer(async (req: IncomingMessage, res) => {
    for await (const _ of req) { /* drain */ }
    seen.push(req.url ?? "");
    res.setHeader("content-type", "application/json");
    if ((req.url ?? "").includes("flux3-image-klein-q8") && seen.length === 2) { res.statusCode = 500; res.end('{"error":{"message":"boom"}}'); return; }
    res.end(JSON.stringify({ created: 1, data: [{ b64_json: "cG5n" }] }));
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(srv.address() as AddressInfo).port}/v1`;
  upsertModel({ id: "hq-test", backend: "external", kind: "image", base_url: url, upstream_model: "flux3-image-klein-q8" });
  upsertModel({ id: "fast-test", backend: "external", kind: "image", base_url: url, upstream_model: "flux2-klein-4b-q4" });
  upsertRoute({ name: "image-edit-hq", kind: "image", strategy: "priority", candidates: ["hq-test", "fast-test"] });
  upsertTenant({ id: "hq-tenant", name: "hq test" });
  const { key } = createKey("hq-tenant", "test");
  const app = Fastify({ bodyLimit: 64 * 1024 * 1024 });
  registerGateway(app);
  const b = "hq-1";
  const field = (n: string, v: string) => `--${b}\r\nContent-Disposition: form-data; name="${n}"\r\n\r\n${v}\r\n`;
  const img = (i: number) => `--${b}\r\nContent-Disposition: form-data; name="image[]"; filename="${i}.png"\r\nContent-Type: image/png\r\n\r\npng${i}\r\n`;
  const body = Buffer.from(field("model", "image-edit-hq") + field("prompt", "The person from image 1 in the garments of images 2-4") + img(1) + img(2) + img(3) + img(4) + `--${b}--\r\n`);
  const send = () => app.inject({ method: "POST", url: "/v1/images/edits", headers: { authorization: `Bearer ${key}`, "content-type": `multipart/form-data; boundary=${b}` }, payload: body });
  try {
    const ok = await send();
    assert.equal(ok.statusCode, 200, ok.body);
    assert.equal(ok.headers["x-mux-route"], "image-edit-hq");
    assert.equal(ok.headers["x-mux-model"], "hq-test");
    assert.equal(seen[0], "/v1/images/edits?model=flux3-image-klein-q8");
    const fell = await send();
    assert.equal(fell.statusCode, 200, fell.body);
    assert.equal(fell.headers["x-mux-model"], "fast-test");
    assert.equal(seen[2], "/v1/images/edits?model=flux2-klein-4b-q4");
  } finally {
    await app.close();
    srv.close();
  }
});
