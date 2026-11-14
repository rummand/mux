import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { gzipSync } from "node:zlib";

// The page reader's render mode (/v1/read {render: true}, route web.render) and its XML and gzip files, against a
// fixture server on loopback. 127.0.0.1 counts as public for these tests (the fixture is there); every other
// private address stays refused. The browser is the Chromium playwright-core finds on this machine.
const { runRead } = await import("../src/router/reader.js");
const { renderPage, closeRenderer } = await import("../src/router/render.js");
const { privateAddress } = await import("../src/router/web.js");
const { config } = await import("../src/config.js");
type Ctx = Parameters<typeof runRead>[0];

const ctx = (allowed: string[] = [], tenant = "t_render") => ({ id: `test_${Math.random()}`, tenant: { id: tenant, allowed }, agent: "bloom-site-reader-2" }) as unknown as Ctx;
const loopbackIsPublic = { isPrivate: (ip: string) => ip !== "127.0.0.1" && privateAddress(ip) };
const read = (body: Record<string, unknown>, c = ctx()) => runRead(c, body, AbortSignal.timeout(40_000), loopbackIsPublic);
const fails = async (p: Promise<unknown>, status: number, type?: string) => {
  try { await p; } catch (e) {
    const err = e as { status: number; type: string; message: string };
    assert.equal(err.status, status, err.message);
    if (type) assert.equal(err.type, type, err.message);
    return err.message;
  }
  assert.fail("expected the read to fail");
};

// A page that is a script shell: its words and links exist only after app.js runs (as energinet.dk with Vue).
const SHELL = `<!doctype html><html lang="da"><head><title>Energi</title><link rel="stylesheet" href="/app.css"></head>
  <body><a href="#main" class="skip">Spring til indhold</a><main id="main"></main><script src="/app.js"></script></body></html>`;
const APP = `
  document.cookie = "seen=1; path=/";
  try { localStorage.setItem("k", "v"); } catch {}
  const m = document.getElementById("main");
  m.innerHTML = '<h1>Om os</h1><p>Vi ejer og udvikler el- og gasnet i Danmark.</p><p>Cookie: ' + (document.cookie || "none") + '</p><a href="/om-os/strategi">Strategi</a>';
  fetch("/data.json").then((r) => r.json()).then((d) => { const p = document.createElement("p"); p.textContent = d.words; m.appendChild(p); });
  fetch("http://10.0.0.1/admin").catch(() => {});
  fetch("/post", { method: "POST", body: "x" }).catch(() => {});
  const i = document.createElement("img"); i.src = "/pic.png"; document.body.appendChild(i);
`;

let server: Server;
let base = "";
const seen: { path: string; method: string; ua: string; cookie: string | undefined }[] = [];
before(async () => {
  server = createServer((req, res) => {
    const u = new URL(req.url ?? "/", "http://x");
    seen.push({ path: u.pathname, method: req.method ?? "", ua: String(req.headers["user-agent"]), cookie: req.headers.cookie });
    const send = (status: number, type: string, body: string | Buffer, headers: Record<string, string> = {}) => { res.writeHead(status, { "content-type": type, ...headers }); res.end(body); };
    switch (u.pathname) {
      case "/shell": return send(200, "text/html; charset=utf-8", SHELL, { "set-cookie": "session=abc; Path=/; HttpOnly", "x-robots-tag": "noarchive" });
      case "/app.js": return send(200, "application/javascript", APP);
      case "/app.css": return send(200, "text/css", "main{display:block}");
      case "/data.json": return send(200, "application/json", JSON.stringify({ words: "Forsyningssikkerhed og den grønne omstilling." }));
      case "/pic.png": return send(200, "image/png", Buffer.alloc(10));
      case "/post": return send(200, "text/plain", "posted");
      case "/moved": return send(301, "text/plain", "", { location: "/shell" });
      case "/to-private": return send(302, "text/plain", "", { location: "http://10.0.0.1/admin" });
      case "/download": return send(200, "text/html", SHELL, { "content-disposition": 'attachment; filename="x.html"' });
      case "/report.pdf": return send(200, "application/pdf", Buffer.from("%PDF-1.4\n%%EOF\n"));
      case "/heavy": return send(200, "text/html", `<title>Heavy</title><main id="m"></main><script src="/big.js"></script>`);
      case "/big.js": return send(200, "application/javascript", `document.getElementById("m").textContent = "loaded";/*${"x".repeat(300_000)}*/`);
      case "/slow": return; // never answers
      case "/sitemap.xml": return send(200, "text/xml; charset=utf-8", `<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>${base}/a</loc></url></urlset>`);
      case "/sitemap.xml.gz": return send(200, "application/octet-stream", gzipSync(`<?xml version="1.0"?><urlset><url><loc>${base}/b</loc></url></urlset>`));
      default: return send(404, "text/plain", "not found");
    }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(async () => { server.close(); await closeRenderer(); });

test("render: a script shell's words and links come back once its scripts ran; the plain read has none", async () => {
  const plain = await read({ url: `${base}/shell`, links: true });
  assert.equal(plain.text, "");
  assert.equal(plain.rendered, undefined);
  const r = await read({ url: `${base}/shell`, links: true, render: true, html: true, images: true });
  assert.deepEqual(r.images, [{ src: `${base}/pic.png`, alt: "" }], "a picture the script added is listed (never fetched)");
  assert.equal(r.rendered, true);
  assert.equal(r.title, "Energi");
  assert.match(r.text, /# Om os/);
  assert.match(r.text, /Vi ejer og udvikler el- og gasnet i Danmark\./);
  assert.match(r.text, /Forsyningssikkerhed og den grønne omstilling\./, "the page's own XHR (GET, same site) is fetched");
  assert.ok(r.links!.some((l) => l.href === `${base}/om-os/strategi`));
  assert.match(r.html!, /<h1>Om os<\/h1>/);
  assert.equal(r.status, 200);
  assert.equal(r.robots?.x_robots_tag, "noarchive");
  assert.ok(r.render!.ms > 0 && r.render!.requests >= 3);
  assert.match(r.render!.engine, /^chromium /);
});

test("render safety: a private address the page asks for is refused, never fetched; only GET; no pictures; no cookies kept or sent; the honest user agent", async () => {
  seen.length = 0;
  const r = await read({ url: `${base}/shell`, render: true });
  assert.ok(r.render!.refused >= 1, "the fetch to 10.0.0.1 was refused before any connection");
  assert.ok(!seen.some((s) => s.method !== "GET" && s.method !== "HEAD"), "no POST reached the site");
  assert.ok(!seen.some((s) => s.path === "/pic.png"), "pictures are never fetched");
  assert.ok(!seen.some((s) => s.cookie), "no Cookie header is ever sent, though the site set one and the script wrote one");
  assert.ok(seen.every((s) => /^mux-reader\/2\.1 .*bloom-site-reader-2/.test(s.ua)), "every request, scripts and XHR too, carries mux's user agent");
  // A second render starts from an empty profile: nothing the first kept
  seen.length = 0;
  const again = await read({ url: `${base}/shell`, render: true });
  assert.match(again.text, /Cookie: seen=1/, "the page's own cookie lives only within its render");
  assert.ok(!seen.some((s) => s.cookie));
});

test("render: redirects are followed and checked; one into a private address is refused; a download is never taken", async () => {
  const r = await read({ url: `${base}/moved`, render: true });
  assert.equal(r.final_url, `${base}/shell`);
  assert.deepEqual(r.redirects, [`${base}/shell`]);
  await fails(read({ url: `${base}/to-private`, render: true }), 400);
  await fails(read({ url: `${base}/download`, render: true }), 415, "unsupported_media");
  await fails(read({ url: `${base}/report.pdf`, render: true }), 415, "unsupported_media");
});

test("render caps: bytes and time", async () => {
  const capped = await renderPage(new URL(`${base}/heavy`), { ...loopbackIsPublic, userAgent: "ua-test", signal: AbortSignal.timeout(20_000), maxBytes: 50_000 });
  assert.ok(capped.render.blocked >= 1, "the script over the byte cap was not loaded");
  assert.ok(!/loaded/.test(capped.html));
  await fails(renderPage(new URL(`${base}/slow`), { ...loopbackIsPublic, userAgent: "ua-test", signal: AbortSignal.timeout(20_000), timeoutMs: 2500 }), 502);
});

test("render needs route web.render when a tenant lists what it may use; a gateway without a node says rendering is unavailable", async () => {
  await fails(read({ url: `${base}/shell`, render: true }, ctx(["qwen3.6-35b-a3b"])), 403, "permission_denied");
  const ok = await read({ url: `${base}/shell`, render: true }, ctx(["qwen3.6-35b-a3b", "web.render"]));
  assert.equal(ok.rendered, true);
  const role = config.role;
  (config as { role: string }).role = "gateway";
  try {
    await fails(read({ url: `${base}/shell`, render: true }), 503, "render_unavailable");
  } finally {
    (config as { role: string }).role = role;
  }
});

test("files: true returns a sitemap (XML) and a sitemap.xml.gz as files, with the XML's words", async () => {
  const x = await read({ url: `${base}/sitemap.xml`, files: true });
  assert.equal(x.file!.mime, "text/xml");
  assert.match(x.text, /<loc>http:\/\/127\.0\.0\.1:\d+\/a<\/loc>/);
  const g = await read({ url: `${base}/sitemap.xml.gz`, files: true });
  assert.equal(g.file!.mime, "application/gzip");
  assert.equal(Buffer.from(g.file!.bytes_base64, "base64")[0], 0x1f);
  // Without files: true, XML is refused as before
  await fails(read({ url: `${base}/sitemap.xml` }), 415);
});
