import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage } from "node:http";
import { createServer as createTcpServer, type AddressInfo } from "node:net";
import { existsSync, mkdirSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "mux-convert-"));
process.env.MUX_HOME = dir;
process.env.MUX_DB = join(dir, "mux.db");
process.env.MUX_PORT = "1";
process.env.MUX_ADMIN_TOKEN = "admin-token";
// The converter's own folders: a home of its own (the profile denies it), jobs inside it as on the Mac
const fakeHome = join(dir, "home");
mkdirSync(fakeHome);
process.env.MUX_CONVERT_HOME_TO_DENY = fakeHome;
process.env.MUX_CONVERT_JOBS = join(fakeHome, ".mux", "convert", "jobs");

// @ts-expect-error: a plain ES module without types
const files = await import("../convert/probe-files.mjs");
// @ts-expect-error: a plain ES module without types
const conv = await import("../convert/convert_server.mjs");

const DOCX = files.plainDocx(["A plain document."], 2) as Buffer;
const PDF = Buffer.from("%PDF-1.7\n% a fake pdf\n%%EOF\n");

// A converter like server/convert/convert_server.mjs, with the same contract.
async function fakeConverter() {
  const state = { asked: [] as Record<string, unknown>[], auth: [] as string[] };
  const srv = createServer(async (req: IncomingMessage, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    state.auth.push(req.headers.authorization ?? "");
    const send = (status: number, obj: unknown) => { res.statusCode = status; res.setHeader("content-type", "application/json"); res.end(JSON.stringify(obj)); };
    const path = (req.url ?? "").split("?")[0];
    if (req.method === "GET" && path === "/v1/models") return send(200, { object: "list", data: [{ id: "lo-test", loaded: true }] });
    if (req.method === "POST" && path === "/v1/convert") {
      const b = JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>;
      state.asked.push(b);
      const bytes = Buffer.from(String(b.file_b64), "base64");
      if (!conv.sniff(bytes)) return send(415, { error: { message: "only Word, PowerPoint, Excel and OpenDocument files are converted", type: "unsupported_type" } });
      return send(200, { object: "conversion", model: "lo-test", input: conv.sniff(bytes), format: "pdf", bytes: PDF.length, sha256: "x", ms: 5, pdf_b64: PDF.toString("base64") });
    }
    send(404, { error: { message: "not found", type: "not_found" } });
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  return { state, url: `http://127.0.0.1:${(srv.address() as AddressInfo).port}/v1`, close: () => srv.close() };
}

test("convert: the converter knows files by their bytes and builds a profile that denies the network and the home folder", () => {
  assert.equal(conv.sniff(DOCX), "docx");
  assert.equal(conv.sniff(files.deckPptx()), "pptx");
  assert.equal(conv.sniff(Buffer.from("PK\u0003\u0004 not really a zip at all, just its first bytes")), null);
  assert.equal(conv.sniff(Buffer.from("%PDF-1.7")), null);
  const odt = files.zip([["mimetype", "application/vnd.oasis.opendocument.text"], ["content.xml", "<x/>"]]);
  assert.equal(conv.sniff(odt), "odt");
  // A docx renamed or not, a zip with word/document.xml but no content types: not Office
  assert.equal(conv.sniff(files.zip([["word/document.xml", "<x/>"]])), null);
  const p = conv.profile("/Users/x/.mux/convert/jobs/job-1", "/Users/x");
  assert.match(p, /\(deny network-outbound \(remote ip\)\)/);
  assert.match(p, /\(deny network-bind \(local ip\)\)/);
  assert.match(p, /mDNSResponder/);
  assert.match(p, /\(deny file-read-data file-write\* \(subpath "\/Users\/x"\)/);
  assert.match(p, /\(allow file-read-data file-write\* \(subpath "\/Users\/x\/\.mux\/convert\/jobs\/job-1"\)/);
  assert.ok(p.indexOf("(allow file-read-data") > p.indexOf("(deny file-read-data"), "the job's folder is allowed after the home is denied");
});

test("convert: through the gateway for an allowed tenant only; the file is checked first and never logged", async () => {
  const Fastify = (await import("fastify")).default;
  const { upsertModel, upsertRoute } = await import("../src/models.js");
  const { upsertTenant, createKey } = await import("../src/tenants.js");
  const { registerGateway } = await import("../src/api/gateway.js");
  const { saveSettings } = await import("../src/db.js");
  const { db } = await import("../src/db.js");
  const up = await fakeConverter();
  upsertModel({ id: "c1-lo", backend: "external", kind: "document", base_url: up.url, upstream_model: "lo-test" });
  upsertRoute({ name: "convert", kind: "document", strategy: "priority", candidates: ["c1-lo"] });
  saveSettings({ convertTenants: ["bloom-c", "bloom-test-c"] });
  upsertTenant({ id: "bloom-c", name: "bloom" }); // every route allowed (an empty list), and named for convert
  upsertTenant({ id: "bloom-test-c", name: "bloom test", allowed: ["vision", "convert"] });
  upsertTenant({ id: "bloom-test-no-route", name: "named, the route not allowed", allowed: ["vision"] });
  upsertTenant({ id: "other-c", name: "every route, not named for convert" });
  saveSettings({ convertTenants: ["bloom-c", "bloom-test-c", "bloom-test-no-route"] });
  const key = (t: string) => ({ authorization: `Bearer ${createKey(t, "k").key}` });
  const bloom = key("bloom-c"), test1 = key("bloom-test-c"), noRoute = key("bloom-test-no-route"), other = key("other-c");
  const app = Fastify({ bodyLimit: 64 * 1024 * 1024 });
  registerGateway(app);
  const ask = (headers: Record<string, string>, payload: unknown) => app.inject({ method: "POST", url: "/v1/convert", headers, payload: payload as object });
  try {
    const ok = await ask(bloom, { file_b64: DOCX.toString("base64"), filename: "Policy.docx" });
    assert.equal(ok.statusCode, 200, ok.body);
    assert.equal(ok.headers["x-mux-route"], "convert");
    assert.equal(ok.headers["x-mux-model"], "c1-lo");
    const answer = JSON.parse(ok.body);
    assert.equal(answer.input, "docx");
    assert.deepEqual(Buffer.from(answer.pdf_b64, "base64"), PDF);
    assert.equal(up.state.asked[0].file_b64, DOCX.toString("base64"), "the file goes on whole");
    assert.equal(up.state.asked[0].model, "lo-test");
    assert.equal(up.state.asked[0].filename, undefined, "the file's name does not go on");
    assert.equal((await ask(test1, { file_b64: DOCX.toString("base64") })).statusCode, 200);

    // Not named in settings.convertTenants (every route allowed otherwise), or the route not in its allowed list: 403
    const n = up.state.asked.length;
    const refusedOther = await ask(other, { file_b64: DOCX.toString("base64") });
    assert.equal(refusedOther.statusCode, 403, refusedOther.body);
    assert.match(refusedOther.body, /convertTenants/);
    assert.equal((await ask(noRoute, { file_b64: DOCX.toString("base64") })).statusCode, 403);
    assert.equal((await ask({}, { file_b64: DOCX.toString("base64") })).statusCode, 401);

    // Checked here, before the converter is asked
    assert.equal((await ask(bloom, {})).statusCode, 400);
    assert.equal((await ask(bloom, { file_b64: "not base64!" })).statusCode, 400);
    const big = await ask(bloom, { file_b64: "A".repeat(Math.ceil((25 * 1024 * 1024 + 10) * 4 / 3)) });
    assert.equal(big.statusCode, 413, big.body.slice(0, 200));
    assert.equal(up.state.asked.length, n, "nothing refused here reached the converter");

    // The converter's own refusal comes back with its status
    const junk = await ask(bloom, { file_b64: Buffer.from("plain words").toString("base64") });
    assert.equal(junk.statusCode, 415, junk.body);

    // Metered like any call, per tenant; the file and the PDF never in the request log
    const rows = db.prepare("SELECT tenant_id, status, endpoint, body_req, body_res FROM requests WHERE endpoint = 'document.convert'").all() as Record<string, unknown>[];
    assert.ok(rows.filter((r) => r.tenant_id === "bloom-c" && r.status === 200).length >= 1);
    assert.ok(rows.some((r) => r.tenant_id === "other-c" && r.status === 403), "a refusal is metered too");
    const logged = JSON.stringify(rows);
    assert.ok(!logged.includes(DOCX.toString("base64").slice(0, 200)), "the file is never logged");
    assert.ok(!logged.includes(PDF.toString("base64")), "the PDF is never logged");
  } finally {
    await app.close();
    up.close();
  }
});

test("convert: without the route the gateway says what to run", async () => {
  const Fastify = (await import("fastify")).default;
  const { registerGateway } = await import("../src/api/gateway.js");
  const { upsertTenant, createKey } = await import("../src/tenants.js");
  const { saveSettings, db } = await import("../src/db.js");
  upsertTenant({ id: "bloom-none", name: "bloom" });
  saveSettings({ convertTenants: ["bloom-none"] });
  const app = Fastify({ bodyLimit: 64 * 1024 * 1024 });
  registerGateway(app);
  const saved = db.prepare("SELECT * FROM routes WHERE name = 'convert'").get();
  try {
    db.prepare("DELETE FROM routes WHERE name = 'convert'").run();
    const r = await app.inject({ method: "POST", url: "/v1/convert", headers: { authorization: `Bearer ${createKey("bloom-none", "k").key}` }, payload: { file_b64: DOCX.toString("base64") } });
    assert.equal(r.statusCode, 503, r.body);
    assert.match(r.body, /deploy\/convert\.sh/);
  } finally {
    if (saved) {
      const { upsertRoute } = await import("../src/models.js");
      upsertRoute({ name: "convert", kind: "document", strategy: "priority", candidates: ["c1-lo"] });
    }
    await app.close();
  }
});

test("convert: from the Railway gateway to the Mac node and on to its converter, as the gateway's tenant there", async () => {
  const Fastify = (await import("fastify")).default;
  const { upsertModel, upsertRoute } = await import("../src/models.js");
  const { upsertTenant, createKey } = await import("../src/tenants.js");
  const { saveProvider } = await import("../src/providers.js");
  const { registerGateway } = await import("../src/api/gateway.js");
  const { saveSettings } = await import("../src/db.js");
  const up = await fakeConverter();
  const node = Fastify({ bodyLimit: 64 * 1024 * 1024 });
  registerGateway(node);
  await node.listen({ port: 0, host: "127.0.0.1" });
  const nodeUrl = `http://127.0.0.1:${(node.server.address() as AddressInfo).port}`;
  upsertModel({ id: "cnode-lo", backend: "external", kind: "document", base_url: up.url, upstream_model: "lo-test" });
  upsertTenant({ id: "gateway-on-node-c", name: "the gateway" });
  const gwKey = createKey("gateway-on-node-c", "g").key;
  saveProvider({ id: "mac-c", name: "Mac test", kind: "mux", base_url: nodeUrl, api_key: gwKey, enabled: true, status: "online" });
  upsertModel({ id: "mac-c/cnode-lo", backend: "node", kind: "document", provider_id: "mac-c", upstream_model: "cnode-lo", base_url: `${nodeUrl}/v1` });
  upsertTenant({ id: "bloom-gw-c", name: "bloom for business" });
  saveSettings({ convertTenants: ["bloom-gw-c", "gateway-on-node-c"] });
  const bloom = { authorization: `Bearer ${createKey("bloom-gw-c", "b").key}` };
  const gw = Fastify({ bodyLimit: 64 * 1024 * 1024 });
  registerGateway(gw);
  try {
    upsertRoute({ name: "convert", kind: "document", strategy: "priority", candidates: ["mac-c/cnode-lo", "cnode-lo"] });
    const r = await gw.inject({ method: "POST", url: "/v1/convert", headers: bloom, payload: { file_b64: DOCX.toString("base64") } });
    assert.equal(r.statusCode, 200, r.body);
    assert.equal(r.headers["x-mux-model"], "mac-c/cnode-lo");
    assert.deepEqual(Buffer.from(JSON.parse(r.body).pdf_b64, "base64"), PDF);
    assert.equal(up.state.asked.at(-1)!.model, "lo-test");
    assert.ok(!up.state.auth.includes(bloom.authorization), "the node was asked with the gateway's key, never the caller's");
    // The gateway's tenant on the node must itself be named for convert
    saveSettings({ convertTenants: ["bloom-gw-c"] });
    const refused = await gw.inject({ method: "POST", url: "/v1/convert", headers: bloom, payload: { file_b64: DOCX.toString("base64") } });
    assert.notEqual(refused.statusCode, 200, "the node refuses a gateway it does not name");
  } finally {
    await gw.close();
    await node.close();
    up.close();
  }
});

const SOFFICE = conv.config.soffice as string;
const real = process.platform === "darwin" && existsSync("/usr/bin/sandbox-exec") && existsSync(SOFFICE);

test("convert: the real converter under the sandbox: no connection to a linked picture's address, pages out, nothing left", { skip: real ? false : "needs macOS and LibreOffice (deploy/convert.sh)", timeout: 120_000 }, async () => {
  // The proof first: a probe under the same profile is refused TCP, the resolver and the home folder
  const proof = await conv.proveSandbox(true);
  assert.equal(proof.proven, true, proof.says);
  // A listener the document points at
  let reached = 0;
  const listener = createTcpServer((s) => { reached++; s.destroy(); });
  await new Promise<void>((r) => listener.listen(0, "127.0.0.1", r));
  const port = (listener.address() as AddressInfo).port;
  const srv = conv.server();
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  const post = (bytes: Buffer) => fetch(`${base}/v1/convert`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ file_b64: bytes.toString("base64") }) });
  try {
    for (const [name, bytes, want] of [["linked", files.linkedPictureDocx(`http://127.0.0.1:${port}/pic.png`), 1], ["deck", files.deckPptx(), 2], ["plain", DOCX, 2]] as const) {
      const r = await post(bytes);
      const j = (await r.json()) as { pdf_b64?: string; error?: { message: string } };
      assert.equal(r.status, 200, `${name}: ${j.error?.message}`);
      const pdf = Buffer.from(j.pdf_b64!, "base64");
      assert.equal(pdf.subarray(0, 5).toString("latin1"), "%PDF-", name);
      const pages = (pdf.toString("latin1").match(/\/Type\s*\/Page[^s]/g) || []).length;
      assert.equal(pages, want, `${name}: ${want} page(s)`);
    }
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(reached, 0, "the document's linked address was never reached");
    assert.deepEqual(readdirSync(process.env.MUX_CONVERT_JOBS!), [], "every job's folder is gone");

    // The time limit: past it the whole job is killed and its folder deleted
    const saved = conv.config.timeoutMs;
    conv.config.timeoutMs = 50;
    try {
      const slow = await post(DOCX);
      assert.equal(slow.status, 422);
      assert.equal(((await slow.json()) as { error: { type: string } }).error.type, "conversion_timeout");
    } finally {
      conv.config.timeoutMs = saved;
    }
    assert.deepEqual(readdirSync(process.env.MUX_CONVERT_JOBS!), []);
    const junk = await post(Buffer.from("plain words"));
    assert.equal(junk.status, 415);
  } finally {
    srv.close();
    listener.close();
  }
});
