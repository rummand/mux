import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { crc32, deflateRawSync } from "node:zlib";

// The page reader (/v1/read) against a fixture server on loopback. The tests let 127.0.0.1 count as public (the
// fixture is there); every other private address stays refused, and without that option loopback is refused too.
const { runRead, fileMime, unzip } = await import("../src/router/reader.js");
const { privateAddress } = await import("../src/router/web.js");
type Ctx = Parameters<typeof runRead>[0];

const ctx = (agent: string | null = null) => ({ id: `test_${Math.random()}`, tenant: { id: "t_reader" }, agent }) as unknown as Ctx;
const loopbackIsPublic = { isPrivate: (ip: string) => ip !== "127.0.0.1" && privateAddress(ip) };
const read = (body: Record<string, unknown>, agent: string | null = null) => runRead(ctx(agent), body, AbortSignal.timeout(10_000), loopbackIsPublic);
const fails = async (p: Promise<unknown>, status: number, type?: string) => {
  try { await p; } catch (e) {
    const err = e as { status: number; type: string; message: string };
    assert.equal(err.status, status, err.message);
    if (type) assert.equal(err.type, type, err.message);
    return err.message;
  }
  assert.fail("expected the read to fail");
};

/** A zip with deflated entries, as docx is */
function zip(entries: Record<string, string>): Buffer {
  const locals: Buffer[] = [], centrals: Buffer[] = [];
  let off = 0;
  for (const [name, content] of Object.entries(entries)) {
    const raw = Buffer.from(content), data = deflateRawSync(raw), n = Buffer.from(name);
    const l = Buffer.alloc(30); l.writeUInt32LE(0x04034b50, 0); l.writeUInt16LE(20, 4); l.writeUInt16LE(8, 8); l.writeUInt32LE(crc32(raw), 14); l.writeUInt32LE(data.length, 18); l.writeUInt32LE(raw.length, 22); l.writeUInt16LE(n.length, 26);
    const c = Buffer.alloc(46); c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6); c.writeUInt16LE(8, 10); c.writeUInt32LE(crc32(raw), 16); c.writeUInt32LE(data.length, 20); c.writeUInt32LE(raw.length, 24); c.writeUInt16LE(n.length, 28); c.writeUInt32LE(off, 42);
    locals.push(l, n, data); centrals.push(c, n);
    off += 30 + n.length + data.length;
  }
  const cd = Buffer.concat(centrals), e = Buffer.alloc(22);
  e.writeUInt32LE(0x06054b50, 0); e.writeUInt16LE(centrals.length / 2, 8); e.writeUInt16LE(centrals.length / 2, 10); e.writeUInt32LE(cd.length, 12); e.writeUInt32LE(off, 16);
  return Buffer.concat([...locals, cd, e]);
}

const PDF = Buffer.concat([Buffer.from("%PDF-1.4\n"), Buffer.from([0, 1, 2, 250, 251, 252, 253, 254, 255]), Buffer.from("\n%%EOF\n")]);
const DOCX = zip({ "[Content_Types].xml": "<Types/>", "word/document.xml": "<w:document><w:body><w:p><w:r><w:t>Bloom &amp; Co</w:t></w:r></w:p><w:p><w:r><w:t>Annual report</w:t></w:r></w:p></w:body></w:document>" });
const PAGE = `<!doctype html><html lang="da"><head><title>Om os</title>
  <meta name="robots" content="noindex, follow"><link rel="canonical" href="/om-os">
  <link rel="alternate" hreflang="en" href="https://example.org/en/about"><link rel="next" href="?page=2"><link rel="stylesheet" href="/x.css">
  <script>document.write('<a href="/from-script">no</a>')</script></head>
  <body><nav><a href="/">Forside</a> <a href="/kontakt#form">Kontakt</a></nav>
  <main><h1>Om os</h1><p>Vi er en lille virksomhed. <a href="rapport.pdf" rel="nofollow">Årsrapport</a></p>
  <a href="/kontakt">Kontakt igen</a><a href="#top">Til toppen</a><a href="javascript:void(0)">Nej</a><a href="mailto:hej@example.org">Skriv</a>
  <a href="https://other.example/x"><img src="a.png" alt="Partner"></a></main></body></html>`;

const LONG = `<!doctype html><html><head><title>Long</title></head><body><header class="top"><a class="btn">Book</a></header>${"<p>words</p>".repeat(300)}</body></html>`;

let server: Server;
let base = "";
const seenUA: string[] = [];
before(async () => {
  server = createServer((req, res) => {
    seenUA.push(String(req.headers["user-agent"]));
    const u = new URL(req.url ?? "/", "http://x");
    const send = (status: number, type: string, body: string | Buffer, headers: Record<string, string> = {}) => { res.writeHead(status, { "content-type": type, ...headers }); res.end(body); };
    switch (u.pathname) {
      case "/page": return send(200, "text/html; charset=utf-8", PAGE, { "x-robots-tag": "noarchive", etag: '"v1"', "last-modified": "Tue, 10 Nov 2026 08:00:00 GMT" });
      case "/x.css": return send(200, "text/css; charset=utf-8", ":root{--brand:#c2410c} body{font-family:Georgia,serif}");
      case "/long": return send(200, "text/html; charset=utf-8", LONG);
      case "/plain": return send(200, "text/plain; charset=utf-8", "just words");
      case "/report.pdf": return send(200, "application/pdf", PDF);
      case "/download": return send(200, "application/octet-stream", PDF, { "content-disposition": 'attachment; filename="aarsrapport 2025.pdf"' });
      case "/doc.docx": return send(200, "application/vnd.openxmlformats-officedocument.wordprocessingml.document", DOCX);
      case "/big": return send(200, "application/pdf", Buffer.alloc(4096, 7), { "content-length": "4096" });
      case "/big-chunked": res.writeHead(200, { "content-type": "application/pdf" }); res.write(Buffer.alloc(3000, 1)); res.end(Buffer.alloc(3000, 2)); return;
      case "/hop": { const n = Number(u.searchParams.get("n")); return n > 0 ? send(302, "text/plain", "", { location: `/hop?n=${n - 1}` }) : send(200, "text/html", "<title>End</title><p>arrived</p>"); }
      case "/loop-a": return send(301, "text/plain", "", { location: "/loop-b" });
      case "/loop-b": return send(301, "text/plain", "", { location: "/loop-a" });
      case "/to-private": return send(302, "text/plain", "", { location: "http://10.0.0.1/admin" });
      case "/robots.txt": return send(200, "text/plain", "User-agent: *\nDisallow: /private\n");
      case "/missing": return send(404, "text/html", "no");
      default: return send(404, "text/plain", "not found");
    }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => server.close());

test("old callers: {url, max_chars} gives title and text as before, the new fields beside them, no links or file unless asked", async () => {
  const p = await read({ url: `${base}/page`, max_chars: 4000 });
  assert.equal(p.object, "page");
  assert.equal(p.title, "Om os");
  assert.match(p.text, /^# Om os\n\nVi er en lille virksomhed\. Årsrapport/);
  assert.ok(!/Forside/.test(p.text));
  assert.equal(p.links, undefined);
  assert.equal(p.file, undefined);
  assert.equal(p.status, 200);
  assert.equal(p.content_type, "text/html; charset=utf-8");
  assert.equal(p.url, `${base}/page`);
  assert.equal(p.final_url, `${base}/page`);
  assert.deepEqual(p.redirects, []);
  assert.ok(!Number.isNaN(Date.parse(p.fetched_at)));
  assert.equal(p.etag, '"v1"');
  assert.equal(p.last_modified, "Tue, 10 Nov 2026 08:00:00 GMT");
  const t = await read({ url: `${base}/plain` });
  assert.equal(t.text, "just words");
});

test("links: every <a href> absolute, fragments stripped, no doubles, plus alternate, next, stylesheets and the canonical", async () => {
  const p = await read({ url: `${base}/page`, links: true });
  const hrefs = p.links!.map((l) => l.href);
  assert.deepEqual(hrefs, [
    `${base}/om-os`, "https://example.org/en/about", `${base}/page?page=2`, `${base}/x.css`,
    `${base}/`, `${base}/kontakt`, `${base}/rapport.pdf`, "mailto:hej@example.org", "https://other.example/x",
  ]);
  const by = Object.fromEntries(p.links!.map((l) => [l.href, l]));
  assert.deepEqual(by[`${base}/kontakt`], { href: `${base}/kontakt`, text: "Kontakt", rel: null });
  assert.equal(by[`${base}/rapport.pdf`].rel, "nofollow");
  assert.equal(by[`${base}/om-os`].rel, "canonical");
  assert.equal(by["https://example.org/en/about"].rel, "alternate");
  assert.equal(by["https://example.org/en/about"].text, "en");
  assert.equal(by["https://other.example/x"].text, "Partner");
  assert.ok(!hrefs.some((h) => /from-script|javascript/.test(h)));
  assert.equal(by[`${base}/x.css`].rel, "stylesheet", "a page's stylesheets come back as links (2026-11-12)");
  assert.equal(p.canonical, `${base}/om-os`);
  assert.equal(p.lang, "da");
});

test("files: a stylesheet comes back as text/css, its exact bytes and its words; without files: true it is refused as before", async () => {
  const p = await read({ url: `${base}/x.css`, files: true });
  assert.equal(p.file!.mime, "text/css");
  const css = ":root{--brand:#c2410c} body{font-family:Georgia,serif}";
  assert.equal(Buffer.from(p.file!.bytes_base64, "base64").toString("utf8"), css);
  assert.equal(p.file!.sha256, createHash("sha256").update(css).digest("hex"));
  assert.equal(p.text, css);
  await assert.rejects(read({ url: `${base}/x.css` }), (e: unknown) => (e as { status?: number }).status === 415);
});

test("html: the page's markup only when asked, capped with html_truncated, links and files unchanged", async () => {
  const plain = await read({ url: `${base}/page`, links: true });
  assert.equal(plain.html, undefined);
  assert.equal(plain.html_truncated, undefined);
  const p = await read({ url: `${base}/page`, html: true, links: true });
  assert.equal(p.html, PAGE);
  assert.equal(p.html_truncated, false);
  assert.deepEqual(p.links, plain.links, "links as before");
  assert.equal(p.text, plain.text);
  const cut = await read({ url: `${base}/long`, html: true, max_html_chars: 1000 });
  assert.equal(cut.html!.length, 1000);
  assert.equal(cut.html_truncated, true);
  assert.equal(cut.html, LONG.slice(0, 1000));
  // Not a page: no markup, the file as before
  const css = await read({ url: `${base}/x.css`, files: true, html: true });
  assert.equal(css.html, undefined);
  assert.equal(css.file!.mime, "text/css");
  const t = await read({ url: `${base}/plain`, html: true });
  assert.equal(t.html, undefined);
});

test("robots: the meta robots and X-Robots-Tag come back; robots_txt: true returns /robots.txt raw", async () => {
  const p = await read({ url: `${base}/page` });
  assert.deepEqual(p.robots, { meta: "noindex, follow", x_robots_tag: "noarchive" });
  const r = await read({ url: `${base}/page`, robots_txt: true });
  assert.equal(r.url, `${base}/robots.txt`);
  assert.equal(r.status, 200);
  assert.equal(r.text, "User-agent: *\nDisallow: /private\n");
});

test("files: a PDF comes back as its exact bytes with their SHA-256, the text left to the caller", async () => {
  const p = await read({ url: `${base}/report.pdf`, files: true });
  const f = p.file!;
  assert.equal(f.mime, "application/pdf");
  assert.equal(f.size, PDF.length);
  assert.equal(f.name, "report.pdf");
  assert.ok(Buffer.from(f.bytes_base64, "base64").equals(PDF));
  assert.equal(f.sha256, createHash("sha256").update(PDF).digest("hex"));
  assert.equal(p.text, "");
  // Served as bytes: the name (Content-Disposition) says what it is
  const d = await read({ url: `${base}/download`, files: true });
  assert.equal(d.file!.mime, "application/pdf");
  assert.equal(d.file!.name, "aarsrapport 2025.pdf");
  assert.equal(d.file!.sha256, f.sha256);
  // Without files: true, as before
  await fails(read({ url: `${base}/report.pdf` }), 415, "unsupported_media");
});

test("files: a docx's text is read from inside it", async () => {
  const p = await read({ url: `${base}/doc.docx`, files: true });
  assert.equal(p.text, "Bloom & Co\nAnnual report");
  assert.equal(p.file!.sha256, createHash("sha256").update(DOCX).digest("hex"));
  assert.equal(unzip(DOCX, () => true).size, 2);
  assert.equal(fileMime("", "x.bin", PDF), "application/pdf");
});

test("above max_bytes: 413 with the size, never a cut file", async () => {
  const told = await fails(read({ url: `${base}/big`, files: true, max_bytes: 2048 }), 413, "file_too_large");
  assert.match(told!, /4096 bytes/);
  await fails(read({ url: `${base}/big-chunked`, files: true, max_bytes: 4096 }), 413, "file_too_large");
  const ok = await read({ url: `${base}/big`, files: true, max_bytes: 5000 });
  assert.equal(ok.file!.size, 4096);
});

test("redirects: every hop listed, at most 5, a loop a clear error", async () => {
  const five = await read({ url: `${base}/hop?n=5` });
  assert.equal(five.redirects.length, 5);
  assert.deepEqual(five.redirects, [4, 3, 2, 1, 0].map((n) => `${base}/hop?n=${n}`));
  assert.equal(five.final_url, `${base}/hop?n=0`);
  assert.equal(five.url, `${base}/hop?n=5`);
  assert.equal(five.title, "End");
  await fails(read({ url: `${base}/hop?n=6` }), 502, "too_many_redirects");
  const loop = await fails(read({ url: `${base}/loop-a` }), 502, "redirect_loop");
  assert.match(loop!, /loop-a → .*loop-b → .*loop-a/);
});

test("only the public web: loopback refused without the test's leave, and a redirect to a private address refused at its hop", async () => {
  await fails(runRead(ctx(), { url: `${base}/page` }, AbortSignal.timeout(5000)), 400, "invalid_request_error");
  await fails(runRead(ctx(), { url: "http://169.254.169.254/latest/meta-data" }, AbortSignal.timeout(5000)), 400);
  const m = await fails(read({ url: `${base}/to-private` }), 400, "invalid_request_error");
  assert.match(m!, /public web/);
  await fails(read({ url: "file:///etc/passwd" }), 400);
});

test("an honest user agent, with the caller's x-mux-agent in its comment", async () => {
  seenUA.length = 0;
  await read({ url: `${base}/plain` }, "bloom-site-reader");
  assert.equal(seenUA[0], "Mozilla/5.0 (compatible; mux-reader/2.0; +https://github.com/rummand/mux; bloom-site-reader)");
  await read({ url: `${base}/plain` }, "evil); rm -rf (");
  assert.ok(seenUA[1].endsWith("; evilrm-rf)"), seenUA[1]);
});

test("a non-2xx page is an error, as before", async () => {
  const m = await fails(read({ url: `${base}/missing` }), 502, "upstream_error");
  assert.match(m!, /404/);
});
