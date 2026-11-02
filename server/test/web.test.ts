import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "mux-web-"));
process.env.MUX_HOME = dir;
process.env.MUX_DB = join(dir, "mux.db");
process.env.MUX_PORT = "1";
const { pageText, privateAddress, resultsFrom } = await import("../src/router/web.js");

test("search results from SearXNG: links only, no doubles, capped", () => {
  const r = resultsFrom({ results: [
    { url: "https://a.it/agriturismo", title: "Agriturismo  Il Poggio", content: "Stone farmhouse\nwith a pool", engine: "duckduckgo" },
    { url: "https://a.it/agriturismo", title: "again" },
    { url: "javascript:alert(1)", title: "no" },
    { url: "https://b.it", title: "", content: "" },
  ] }, 5);
  assert.deepEqual(r.map((x) => x.url), ["https://a.it/agriturismo", "https://b.it"]);
  assert.equal(r[0].title, "Agriturismo Il Poggio");
  assert.equal(r[0].snippet, "Stone farmhouse with a pool");
  assert.equal(r[1].title, "https://b.it");
  assert.equal(resultsFrom(null, 5).length, 0);
});

test("a page as plain text: the main content, headings and lists, no scripts or menus", () => {
  const html = `<html><head><title>Podere &amp; Casa</title><style>p{}</style></head><body>
    <nav><a>Home</a><a>Book</a></nav><header>Logo</header>
    <main><h1>Podere Casanova</h1><p>An old stone farmhouse in the Val d&#39;Orcia.</p>
    <ul><li>Pool</li><li>View &ndash; 360°</li></ul><script>track()</script></main>
    <footer>© 2026</footer></body></html>`;
  const p = pageText(html);
  assert.equal(p.title, "Podere & Casa");
  assert.equal(p.text, "# Podere Casanova\n\nAn old stone farmhouse in the Val d'Orcia.\n- Pool\n- View – 360°");
  assert.ok(!/Home|Logo|track|2026/.test(p.text));
});

test("long pages are cut at a word", () => {
  const p = pageText(`<main><p>${"ord ".repeat(5000)}</p></main>`, 1000);
  assert.ok(p.text.length <= 1002);
  assert.ok(p.text.endsWith(" …"));
});

test("only the public web is read", () => {
  for (const ip of ["127.0.0.1", "10.1.2.3", "192.168.0.10", "172.20.1.1", "169.254.169.254", "100.64.0.1", "::1", "fd12::1"]) assert.equal(privateAddress(ip), true, ip);
  for (const ip of ["8.8.8.8", "93.184.216.34", "2606:4700::1111"]) assert.equal(privateAddress(ip), false, ip);
});
