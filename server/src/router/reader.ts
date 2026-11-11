import { createHash } from "node:crypto";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { inflateRawSync } from "node:zlib";
import { settings } from "../db.js";
import { noteCall } from "../services.js";
import { MuxError } from "./errors.js";
import type { Ctx } from "./metering.js";
import { decode, pageText, privateAddress } from "./web.js";

/**
 * `/v1/read`, mux's page reader (route `web.read`, metered as model `reader`). It fetches one public address and
 * gives back what a caller needs to read a whole site and keep its sources (the owner 2026-11-12: "it can return
 * files to bloom for business so it can use them for provenance"):
 *  - a web page's words as plain text (web.ts `pageText`), and with `links: true` every link on it, absolute, and
 *    its stylesheets (`rel: "stylesheet"`, 2026-11-12: bloom for business reads a company's look from them);
 *  - with `files: true`, a document (PDF, Office, OpenDocument, CSV, text, CSS, RTF, images, zip) as its exact bytes,
 *    base64, with their SHA-256 – text extracted where that is cheap (text, CSV, docx/xlsx/pptx/odt), else empty;
 *  - what a crawler must know to behave: the status, content type, redirects (at most 5, each one checked for a public
 *    address again), the page's meta robots and X-Robots-Tag, the canonical, ETag and Last-Modified;
 *  - with `robots_txt: true`, the site's /robots.txt as it is. mux does not decide on robots.txt: the caller does;
 *  - with `html: true`, a web page's markup as it came (decoded, scripts left in as text, never run), capped at
 *    `max_html_chars` (200 000 default, 2 000 000 at most) with `html_truncated` saying whether it was cut
 *    (2026-11-12: bloom for business ranks a company's colours by the elements its start page shows).
 * Old callers ({url, max_chars} → {title, text}) get the same answer, with more fields beside it.
 * Safety: public addresses only, no cookies, no JavaScript, a size cap (413 above it, never a cut file), a timeout.
 */

const MB = 1024 * 1024;
const MAX_HOPS = 5;
const PAGE_TIMEOUT_MS = 15_000;
const FILE_TIMEOUT_MS = 30_000;
const ROBOTS_MAX_BYTES = 512 * 1024; // what Google reads of a robots.txt
const HTML_DEFAULT_CHARS = 200_000;
const HTML_MAX_CHARS = 2_000_000;

export interface ReadBody {
  url?: unknown; max_chars?: unknown; links?: unknown; files?: unknown; max_bytes?: unknown; robots_txt?: unknown;
  html?: unknown; max_html_chars?: unknown;
}
export type Link = { href: string; text: string; rel: string | null };
export interface PageAnswer {
  object: "page"; url: string; final_url: string; status: number; content_type: string; fetched_at: string;
  title: string; text: string;
  links?: Link[];
  html?: string; html_truncated?: boolean;
  robots?: { meta: string | null; x_robots_tag: string | null };
  canonical?: string | null; lang?: string | null;
  redirects: string[];
  file?: { mime: string; size: number; sha256: string; name: string; bytes_base64: string };
  etag?: string; last_modified?: string;
}
/** For the tests only: which addresses count as private (the fixture server is on loopback). */
export interface ReadOptions { isPrivate?: (ip: string) => boolean }

// ── Files ─────────────────────────────────────────────────────────────────────────────────────────────────────────
const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const PPTX = "application/vnd.openxmlformats-officedocument.presentationml.presentation";
const ODT = "application/vnd.oasis.opendocument.text";
const ODS = "application/vnd.oasis.opendocument.spreadsheet";
const ODP = "application/vnd.oasis.opendocument.presentation";
const BY_EXT: Record<string, string> = {
  pdf: "application/pdf", docx: DOCX, xlsx: XLSX, pptx: PPTX, doc: "application/msword", xls: "application/vnd.ms-excel",
  ppt: "application/vnd.ms-powerpoint", odt: ODT, ods: ODS, odp: ODP, csv: "text/csv", txt: "text/plain", css: "text/css", rtf: "application/rtf",
  zip: "application/zip", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp",
  svg: "image/svg+xml", tif: "image/tiff", tiff: "image/tiff", bmp: "image/bmp", avif: "image/avif", heic: "image/heic",
};
const FILE_TYPES = new Set([...Object.values(BY_EXT), "text/rtf", "application/x-zip-compressed", "application/x-pdf"]);
const isFileType = (mime: string) => FILE_TYPES.has(mime) || mime.startsWith("image/");
const isHtml = (mime: string) => mime === "text/html" || mime === "application/xhtml+xml";

/** The file's type: the server's word, unless it only says "bytes" – then the name's extension, then the bytes' own magic. */
export function fileMime(header: string, name: string, bytes: Uint8Array): string {
  const m = header.split(";")[0].trim().toLowerCase();
  if (m && m !== "application/octet-stream" && m !== "binary/octet-stream" && m !== "application/download" && m !== "application/force-download") return m;
  const ext = /\.([a-z0-9]{2,5})$/i.exec(name)?.[1]?.toLowerCase();
  if (ext && BY_EXT[ext]) return BY_EXT[ext];
  const head = Buffer.from(bytes.subarray(0, 8)).toString("latin1");
  if (head.startsWith("%PDF")) return "application/pdf";
  if (head.startsWith("PK\x03\x04")) return "application/zip";
  return m || "application/octet-stream";
}

/** The file's name: Content-Disposition's, else the address's last part, else "file". */
export function fileName(disposition: string | null, url: URL): string {
  const star = disposition && /filename\*\s*=\s*(?:UTF-8|utf-8)?''([^;]+)/i.exec(disposition)?.[1];
  const plain = disposition && /filename\s*=\s*("([^"]*)"|[^;]+)/i.exec(disposition);
  let name = "";
  try { name = star ? decodeURIComponent(star.trim()) : plain ? (plain[2] ?? plain[1]).trim() : decodeURIComponent(url.pathname.split("/").pop() ?? ""); } catch { name = ""; }
  return name.replace(/[\/\\\0\r\n]/g, "_").slice(0, 200) || "file";
}

/** The entries of a zip (docx, xlsx, pptx and OpenDocument are zips), read from its central directory. */
export function unzip(buf: Buffer, want: (name: string) => boolean, maxEach = 20 * MB): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65_557); i--) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) return out;
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  for (let n = 0; n < count && p + 46 <= buf.length && buf.readUInt32LE(p) === 0x02014b50; n++) {
    const method = buf.readUInt16LE(p + 10), size = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28), extraLen = buf.readUInt16LE(p + 30), commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString("utf8");
    p += 46 + nameLen + extraLen + commentLen;
    if (!want(name) || local + 30 > buf.length || buf.readUInt32LE(local) !== 0x04034b50) continue;
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const data = buf.subarray(start, start + size);
    try {
      if (method === 0) out.set(name, data);
      else if (method === 8) out.set(name, inflateRawSync(data, { maxOutputLength: maxEach }));
    } catch { /* a broken or too-large entry is left out */ }
  }
  return out;
}

const xmlText = (xml: string, para: RegExp) =>
  decode(xml.replace(para, "\n").replace(/<(w:tab|text:tab)\b[^>]*\/>/g, "\t").replace(/<[^>]+>/g, ""))
    .split("\n").map((l) => l.replace(/[ \t ]+/g, " ").trim()).filter(Boolean).join("\n");
const byNumber = (a: string, b: string) => Number(/(\d+)\.xml$/.exec(a)?.[1] ?? 0) - Number(/(\d+)\.xml$/.exec(b)?.[1] ?? 0);

/** The text of a file, where that is cheap: plain text and CSV, and the XML inside docx/xlsx/pptx/OpenDocument. Else "". */
export function fileText(mime: string, bytes: Buffer, charset: string | null): string {
  if (mime === "text/plain" || mime === "text/csv" || mime === "text/css") return decodeText(bytes, charset);
  try {
    if (mime === DOCX) return xmlText(unzip(bytes, (n) => n === "word/document.xml").get("word/document.xml")?.toString("utf8") ?? "", /<\/w:p>/g);
    if (mime === PPTX) {
      const slides = unzip(bytes, (n) => /^ppt\/slides\/slide\d+\.xml$/.test(n));
      return [...slides.keys()].sort(byNumber).map((k) => xmlText(slides.get(k)!.toString("utf8"), /<\/a:p>/g)).filter(Boolean).join("\n\n");
    }
    if (mime === XLSX) return xmlText(unzip(bytes, (n) => n === "xl/sharedStrings.xml").get("xl/sharedStrings.xml")?.toString("utf8") ?? "", /<\/si>/g);
    if (mime === ODT || mime === ODS || mime === ODP) return xmlText(unzip(bytes, (n) => n === "content.xml").get("content.xml")?.toString("utf8") ?? "", /<\/text:(p|h)>/g);
  } catch { /* the caller extracts it */ }
  return "";
}

function decodeText(bytes: Uint8Array, charset: string | null): string {
  try { return new TextDecoder(charset ?? "utf-8").decode(bytes); } catch { return new TextDecoder("utf-8").decode(bytes); }
}
const cut = (s: string, max: number) => (s.length > max ? `${s.slice(0, max).replace(/\s+\S*$/, "")} …` : s);

// ── Pages: links and robots ───────────────────────────────────────────────────────────────────────────────────────
function attrs(tag: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of tag.matchAll(/([\w:-]+)\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'>]+))/g)) out[m[1].toLowerCase()] ??= decode(m[3] ?? m[4] ?? m[5] ?? "");
  return out;
}
const absolute = (href: string, base: URL): string | null => {
  const h = href.trim();
  if (!h || h.startsWith("#") || /^(javascript|data|vbscript|blob):/i.test(h)) return null;
  try { const u = new URL(h, base); u.hash = ""; return u.toString(); } catch { return null; }
};

/** What a page says about itself: its links, meta robots, canonical and language. */
export function pageMeta(html: string, pageUrl: URL, maxLinks = 5000) {
  const clean = html.replace(/<!--[\s\S]*?-->/g, " ").replace(/<(script|style|template|noscript)\b[\s\S]*?<\/\1>/gi, " ");
  const baseHref = /<base\b[^>]*>/i.exec(clean)?.[0];
  let base = pageUrl;
  if (baseHref) { try { base = new URL(attrs(baseHref).href ?? "", pageUrl); } catch { /* the page's own */ } }
  const robots: string[] = [];
  let canonical: string | null = null;
  const links = new Map<string, Link>();
  const add = (href: string | null, text: string, rel: string | null) => {
    if (!href || links.size >= maxLinks) return;
    const had = links.get(href);
    if (!had) links.set(href, { href, text, rel });
    else if (!had.text && text) had.text = text;
  };
  for (const m of clean.matchAll(/<meta\b[^>]*>/gi)) {
    const a = attrs(m[0]);
    if (a.name?.toLowerCase() === "robots" && a.content != null) robots.push(a.content.trim());
  }
  for (const m of clean.matchAll(/<link\b[^>]*>/gi)) {
    const a = attrs(m[0]);
    const rels = (a.rel ?? "").toLowerCase().split(/\s+/);
    const href = a.href != null ? absolute(a.href, base) : null;
    if (rels.includes("canonical") && href && !canonical) canonical = href;
    const rel = rels.find((r) => r === "canonical" || r === "alternate" || r === "next" || r === "stylesheet");
    if (rel) add(href, (a.title ?? a.hreflang ?? "").trim(), a.rel.trim());
  }
  for (const m of clean.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
    const a = attrs(m[1]);
    if (a.href == null) continue;
    const text = decode(m[2].replace(/<img\b[^>]*\balt\s*=\s*"([^"]*)"[^>]*>/gi, " $1 ").replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim().slice(0, 300);
    add(absolute(a.href, base), text, a.rel?.trim() || null);
  }
  const lang = attrs(/<html\b[^>]*>/i.exec(clean)?.[0] ?? "").lang?.trim() || null;
  return { links: [...links.values()], robots: robots.length ? robots.join(", ") : null, canonical, lang };
}

// ── Fetching ──────────────────────────────────────────────────────────────────────────────────────────────────────
async function publicUrl(raw: string, isPrivate: (ip: string) => boolean): Promise<URL> {
  let url: URL;
  try { url = new URL(raw); } catch { throw new MuxError(400, "invalid_request_error", "url must be an http(s) address"); }
  if (!/^https?:$/.test(url.protocol) || url.username || url.password) throw new MuxError(400, "invalid_request_error", "url must be an http(s) address");
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const ips = isIP(host) ? [host] : (await lookup(host, { all: true }).catch(() => [])).map((a) => a.address);
  if (!ips.length) throw new MuxError(400, "invalid_request_error", "the address could not be found");
  if (ips.some(isPrivate) || /(^|\.)(internal|local|localhost)$/i.test(host)) throw new MuxError(400, "invalid_request_error", "only pages on the public web can be read");
  url.hash = "";
  return url;
}

/** The caller's agent name in the user agent's comment, as it is safe there. */
export function userAgent(agent: string | null | undefined): string {
  const a = (agent ?? "").replace(/[^\w.\-]/g, "").slice(0, 64);
  return `Mozilla/5.0 (compatible; mux-reader/2.0; +https://github.com/rummand/mux${a ? `; ${a}` : ""})`;
}

/** The body, at most `max` bytes: above it a 413 with the size, never a cut file. */
async function body(res: Response, max: number): Promise<Buffer> {
  const told = Number(res.headers.get("content-length"));
  const tooBig = (size: string) => new MuxError(413, "file_too_large", `the answer is ${size}, more than max_bytes (${max})`);
  if (Number.isFinite(told) && told > max) { await res.body?.cancel().catch(() => {}); throw tooBig(`${told} bytes`); }
  if (!res.body) return Buffer.alloc(0);
  const chunks: Buffer[] = [];
  let n = 0;
  const reader = res.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    n += value.byteLength;
    if (n > max) { await reader.cancel().catch(() => {}); throw tooBig(`over ${max} bytes (the server did not say its size; the reader stopped there)`); }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks, n);
}

/** Follows at most 5 redirects by hand, each new address checked for the public web again; a loop is an error. */
async function fetchFollowing(start: URL, init: RequestInit, isPrivate: (ip: string) => boolean): Promise<{ res: Response; url: URL; redirects: string[] }> {
  const seen = new Set([start.toString()]);
  const redirects: string[] = [];
  let url = start;
  for (;;) {
    const res = await fetch(url, { ...init, redirect: "manual" }).catch((e) => {
      const why = e instanceof Error ? (e.name === "TimeoutError" ? "no answer in time" : e.name) : "error";
      throw new MuxError(502, "upstream_error", `the page could not be fetched (${why})`);
    });
    const loc = res.headers.get("location");
    if (res.status < 300 || res.status >= 400 || !loc) return { res, url, redirects };
    await res.body?.cancel().catch(() => {});
    let next: URL;
    try { next = new URL(loc, url); } catch { throw new MuxError(502, "upstream_error", `the page redirected to an address that is not one (${loc.slice(0, 200)})`); }
    next.hash = "";
    const hop = next.toString();
    if (seen.has(hop)) throw new MuxError(502, "redirect_loop", `the redirects go round in a loop: ${[start.toString(), ...redirects, hop].join(" → ")}`);
    if (redirects.length >= MAX_HOPS) throw new MuxError(502, "too_many_redirects", `more than ${MAX_HOPS} redirects: ${[start.toString(), ...redirects, hop].join(" → ")}`);
    url = await publicUrl(hop, isPrivate);
    seen.add(hop);
    redirects.push(hop);
  }
}

// One tenant's reads in flight at once (settings.readerParallel), beside its max_parallel for every call
const reading = new Map<string, number>();

export async function runRead(ctx: Ctx, b: ReadBody, signal: AbortSignal, opts: ReadOptions = {}): Promise<PageAnswer> {
  ctx.modelId = "reader";
  ctx.route = "web.read";
  const isPrivate = opts.isPrivate ?? privateAddress;
  const requested = await publicUrl(String(b.url ?? ""), isPrivate);
  const maxChars = Math.min(Math.max(Number(b.max_chars) || 20_000, 1000), 100_000);
  const maxBytes = Math.min(Math.max(Number(b.max_bytes) || 25 * MB, 1024), 50 * MB);
  const wantLinks = b.links === true, wantFiles = b.files === true, robotsTxt = b.robots_txt === true, wantHtml = b.html === true;
  const maxHtml = Math.min(Math.max(Number(b.max_html_chars) || HTML_DEFAULT_CHARS, 1000), HTML_MAX_CHARS);

  const tenant = ctx.tenant?.id ?? "";
  const limit = Math.max(1, Number(settings().readerParallel) || 8);
  const n = reading.get(tenant) ?? 0;
  if (n >= limit) throw new MuxError(429, "too_many_parallel", `the page reader takes ${limit} reads at once per tenant (settings.readerParallel)`, 1);
  reading.set(tenant, n + 1);
  try {
    const target = robotsTxt ? new URL("/robots.txt", requested.origin) : requested;
    const init: RequestInit = {
      headers: {
        accept: robotsTxt ? "text/plain,*/*;q=0.5" : wantFiles ? "text/html,application/xhtml+xml,text/plain;q=0.9,text/css;q=0.9,*/*;q=0.8" : "text/html,application/xhtml+xml,text/plain;q=0.9",
        "user-agent": userAgent(ctx.agent),
        "accept-language": "da,en;q=0.8",
      },
      credentials: "omit",
      signal: AbortSignal.any([signal, AbortSignal.timeout(wantFiles ? FILE_TIMEOUT_MS : PAGE_TIMEOUT_MS)]),
    };
    const { res, url: final, redirects } = await fetchFollowing(target, init, isPrivate);
    const type = res.headers.get("content-type") ?? "";
    const charset = /charset=["']?([\w-]+)/i.exec(type)?.[1] ?? null;
    const base = {
      object: "page" as const, url: target.toString(), final_url: final.toString(), status: res.status, content_type: type, fetched_at: new Date().toISOString(),
      robots: { meta: null as string | null, x_robots_tag: res.headers.get("x-robots-tag") },
      redirects,
      ...(res.headers.get("etag") ? { etag: res.headers.get("etag")! } : {}),
      ...(res.headers.get("last-modified") ? { last_modified: res.headers.get("last-modified")! } : {}),
    };
    const note = (bytes: number, chars: number, mime: string) =>
      noteCall(ctx, { service: "web.read", host: final.hostname.replace(/^www\./, ""), chars, bytes, mime: robotsTxt ? "robots.txt" : mime });

    // robots.txt as it is, whatever it answered: no robots.txt (404) is an answer the caller needs too
    if (robotsTxt) {
      let raw: Buffer = Buffer.alloc(0);
      if (res.ok) raw = await body(res, ROBOTS_MAX_BYTES).catch((e) => { if (e instanceof MuxError && e.status === 413) return Buffer.alloc(0); throw e; });
      else await res.body?.cancel().catch(() => {});
      const text = decodeText(raw, charset);
      note(raw.length, text.length, type.split(";")[0]);
      return { ...base, title: "", text };
    }

    if (!res.ok) { await res.body?.cancel().catch(() => {}); throw new MuxError(502, "upstream_error", `the page answered ${res.status}`); }
    const header = type.split(";")[0].trim().toLowerCase();
    const asPage = (bytes: Buffer): PageAnswer => {
      const html = decodeText(bytes.subarray(0, 5_000_000), charset);
      const page = pageText(html, maxChars);
      const meta = pageMeta(html, final);
      // The markup, when asked: metered as characters returned, like the text
      const markup = wantHtml ? (html.length > maxHtml ? { html: html.slice(0, maxHtml), html_truncated: true } : { html, html_truncated: false }) : {};
      note(bytes.length, page.text.length + (markup.html?.length ?? 0), header || "text/html");
      return { ...base, title: page.title, text: page.text, ...(wantLinks ? { links: meta.links } : {}), ...markup, robots: { ...base.robots, meta: meta.robots }, canonical: meta.canonical, lang: meta.lang };
    };
    if (isHtml(header) || (!header && !wantFiles)) return asPage(await body(res, maxBytes));
    if (!wantFiles) {
      if (header !== "text/plain") { await res.body?.cancel().catch(() => {}); throw new MuxError(415, "unsupported_media", `the page is ${header || "not text"}, not a web page (send files: true to have it as a file)`); }
      const bytes = await body(res, maxBytes);
      const text = cut(decodeText(bytes, charset), maxChars);
      note(bytes.length, text.length, header);
      return { ...base, title: "", text, canonical: null, lang: null };
    }
    const bytes = await body(res, maxBytes);
    const name = fileName(res.headers.get("content-disposition"), final);
    const mime = fileMime(type, name, bytes);
    // A page served without a type, or as bytes
    if (mime === "application/octet-stream" && /^\s*<(!doctype html|html|head|body)\b/i.test(bytes.subarray(0, 512).toString("latin1"))) return asPage(bytes);
    if (!isFileType(mime)) throw new MuxError(415, "unsupported_media", `the answer is ${mime}: not a page or a file the reader returns (pdf, Office, OpenDocument, csv, txt, rtf, images, zip)`);
    const text = cut(fileText(mime, bytes, charset), maxChars);
    note(bytes.length, text.length, mime);
    return {
      ...base, title: "", text, canonical: null, lang: null,
      file: { mime, size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"), name, bytes_base64: bytes.toString("base64") },
    };
  } finally {
    reading.set(tenant, Math.max(0, (reading.get(tenant) ?? 1) - 1));
  }
}
