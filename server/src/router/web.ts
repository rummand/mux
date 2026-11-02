import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { config } from "../config.js";
import { MuxError } from "./errors.js";
import type { Ctx } from "./metering.js";

/**
 * Search and read the web for every product (mux's shared services, the owner 2026-11-02: "SearXNG on mux, a
 * general service across all our products"). `/v1/search` asks the SearXNG beside mux (MUX_SEARXNG_URL, on
 * Railway's private network) and gives back titles, links and the engines' extracts; `/v1/read` fetches one page
 * and gives back its words as plain, AI-readable text – headings, paragraphs and lists, no scripts, menus or ads.
 * Both sit behind a mux key, so they are metered and limited like any call. Free: no search vendor, no key.
 */

export type WebResult = { title: string; url: string; snippet: string; engine: string | null; published: string | null };

/** SearXNG's JSON → results, the junk left out */
export function resultsFrom(json: unknown, limit: number): WebResult[] {
  const raw = (json as { results?: Record<string, unknown>[] } | null)?.results ?? [];
  const seen = new Set<string>();
  const out: WebResult[] = [];
  for (const r of raw) {
    const url = typeof r.url === "string" ? r.url : "";
    if (!/^https?:\/\//.test(url) || seen.has(url)) continue;
    seen.add(url);
    out.push({
      title: String(r.title ?? "").replace(/\s+/g, " ").trim().slice(0, 200) || url,
      url,
      snippet: String(r.content ?? "").replace(/\s+/g, " ").trim().slice(0, 600),
      engine: typeof r.engine === "string" ? r.engine : null,
      published: typeof r.publishedDate === "string" ? r.publishedDate : null,
    });
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * SearXNG's own results page → results, for an instance run from the official image as it is (JSON is switched on
 * only in its settings file): each <article class="result"> has the link in its <h3> and the extract in <p class="content">.
 */
export function resultsFromHtml(html: string, limit: number): WebResult[] {
  const raw: Record<string, unknown>[] = [];
  for (const m of html.matchAll(/<article class="result[^"]*"[\s\S]*?<\/article>/g)) {
    const a = m[0];
    const link = /<h3>\s*<a href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/.exec(a);
    if (!link) continue;
    const content = /<p class="content">([\s\S]*?)<\/p>/.exec(a)?.[1] ?? "";
    const strip = (x: string) => decode(x.replace(/<[^>]+>/g, ""));
    raw.push({ url: decode(link[1]), title: strip(link[2]), content: strip(content) });
  }
  return resultsFrom({ results: raw }, limit);
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", aelig: "æ", oslash: "ø", aring: "å", AElig: "Æ", Oslash: "Ø", Aring: "Å", ndash: "–", mdash: "—", hellip: "…", laquo: "«", raquo: "»" };
const decode = (s: string) =>
  s.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === "#") {
      const n = e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : "";
    }
    return ENTITIES[e] ?? m;
  });

/**
 * A page's words as plain text an AI reads well: the title, then the main content's headings ("# …"), paragraphs
 * and list items ("- …"), in order. Scripts, styles, menus, headers, footers, forms and asides are dropped; when the
 * page marks its main content (<article> or <main>) only that is read.
 */
export function pageText(html: string, max = 20_000): { title: string; text: string } {
  const title = decode((/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? "").replace(/\s+/g, " ").trim());
  let body = html.replace(/<!--[\s\S]*?-->/g, " ");
  for (const tag of ["script", "style", "noscript", "svg", "template", "nav", "header", "footer", "aside", "form", "iframe", "button", "select"]) {
    body = body.replace(new RegExp(`<${tag}\\b[\\s\\S]*?<\\/${tag}>`, "gi"), " ");
  }
  const main = /<(article|main)\b[^>]*>([\s\S]*?)<\/\1>/i.exec(body)?.[2] ?? /<body\b[^>]*>([\s\S]*)<\/body>/i.exec(body)?.[1] ?? body;
  const text = main
    .replace(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi, (_m, n: string, t: string) => `\n\n${"#".repeat(Math.min(3, Number(n)))} ${t}\n\n`)
    .replace(/<li\b[^>]*>/gi, "\n- ")
    .replace(/<(br|hr)\b[^>]*\/?>/gi, "\n")
    .replace(/<\/(p|div|section|ul|ol|table|tr|blockquote|pre|li|dd|dt)>/gi, "\n")
    .replace(/<(td|th)\b[^>]*>/gi, " | ")
    .replace(/<[^>]+>/g, " ");
  const lines = decode(text)
    .split("\n")
    .map((l) => l.replace(/[ \t ]+/g, " ").trim())
    .filter((l, i, all) => l && l !== "-" && !/^#{1,3}$/.test(l) && !(l === all[i - 1]));
  // A heading stands apart, a blank line on each side
  const joined = lines.map((l) => (/^#{1,3} /.test(l) ? `\n${l}\n` : l)).join("\n").replace(/\n{3,}/g, "\n\n").trim();
  return { title, text: joined.length > max ? `${joined.slice(0, max).replace(/\s+\S*$/, "")} …` : joined };
}

/** Private, loopback and link-local addresses: a page to read must be on the public web */
export function privateAddress(ip: string): boolean {
  if (ip.includes(":")) {
    const v = ip.toLowerCase();
    return v === "::1" || v === "::" || v.startsWith("fc") || v.startsWith("fd") || v.startsWith("fe80") || v.startsWith("::ffff:127.") || v.startsWith("::ffff:10.") || v.startsWith("::ffff:192.168.");
  }
  const [a, b] = ip.split(".").map(Number);
  return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
}

async function publicUrl(raw: string): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new MuxError(400, "invalid_request_error", "url must be an http(s) address");
  }
  if (!/^https?:$/.test(url.protocol) || url.username || url.password) throw new MuxError(400, "invalid_request_error", "url must be an http(s) address");
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const ips = isIP(host) ? [host] : (await lookup(host, { all: true }).catch(() => [])).map((a) => a.address);
  if (!ips.length) throw new MuxError(400, "invalid_request_error", "the address could not be found");
  if (ips.some(privateAddress) || /(^|\.)(internal|local|localhost)$/i.test(host)) throw new MuxError(400, "invalid_request_error", "only pages on the public web can be read");
  return url;
}

export async function runSearch(ctx: Ctx, body: { query?: unknown; q?: unknown; limit?: unknown; language?: unknown }, signal: AbortSignal) {
  if (!config.searxngUrl) throw new MuxError(503, "search_unavailable", "web search is not set up on this mux (MUX_SEARXNG_URL)");
  const query = String(body.query ?? body.q ?? "").replace(/\s+/g, " ").trim().slice(0, 400);
  if (!query) throw new MuxError(400, "invalid_request_error", "query is required");
  const limit = Math.min(Math.max(Number(body.limit) || 6, 1), 20);
  const params = new URLSearchParams({ q: query, format: "json", safesearch: "1" });
  if (typeof body.language === "string" && /^[a-z]{2}(-[A-Z]{2})?$/.test(body.language)) params.set("language", body.language);
  ctx.modelId = "searxng";
  ctx.route = "web.search";
  const ask = (format: "json" | "html") => {
    params.set("format", format);
    return fetch(`${config.searxngUrl.replace(/\/$/, "")}/search?${params}`, { headers: { accept: format === "json" ? "application/json" : "text/html" }, signal: AbortSignal.any([signal, AbortSignal.timeout(12_000)]) }).catch((e) => {
      throw new MuxError(502, "upstream_error", `the search engine could not be reached (${e instanceof Error ? e.name : "error"})`);
    });
  };
  const json = await ask("json");
  if (json.ok) return { object: "search", query, results: resultsFrom(await json.json().catch(() => null), limit) };
  // JSON not switched on in this instance's settings (it answers 403): its results page says the same
  if (json.status !== 403) throw new MuxError(502, "upstream_error", `the search engine answered ${json.status}`);
  const html = await ask("html");
  if (!html.ok) throw new MuxError(502, "upstream_error", `the search engine answered ${html.status}`);
  return { object: "search", query, results: resultsFromHtml(await html.text(), limit) };
}

export async function runRead(ctx: Ctx, body: { url?: unknown; max_chars?: unknown }, signal: AbortSignal) {
  const url = await publicUrl(String(body.url ?? ""));
  const max = Math.min(Math.max(Number(body.max_chars) || 20_000, 1000), 100_000);
  ctx.modelId = "reader";
  ctx.route = "web.read";
  const res = await fetch(url, {
    redirect: "manual",
    headers: { accept: "text/html,application/xhtml+xml,text/plain;q=0.9", "user-agent": "Mozilla/5.0 (compatible; mux-reader/1.0; +https://github.com/rummand/mux)", "accept-language": "da,en;q=0.8" },
    signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
  }).catch((e) => {
    throw new MuxError(502, "upstream_error", `the page could not be fetched (${e instanceof Error ? e.name : "error"})`);
  });
  // A redirect is followed once, checked again – so a public page cannot hand the reader to a private one
  if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
    return runRead(ctx, { url: new URL(res.headers.get("location")!, url).toString(), max_chars: max }, signal);
  }
  if (!res.ok) throw new MuxError(502, "upstream_error", `the page answered ${res.status}`);
  const type = res.headers.get("content-type") ?? "";
  if (!/text\/html|application\/xhtml|text\/plain/.test(type)) throw new MuxError(415, "unsupported_media", `the page is ${type.split(";")[0] || "not text"}, not a web page`);
  const buf = await res.arrayBuffer();
  const html = new TextDecoder(/charset=([\w-]+)/i.exec(type)?.[1] ?? "utf-8").decode(buf.slice(0, 3_000_000));
  const page = type.includes("text/plain") ? { title: "", text: html.slice(0, max) } : pageText(html, max);
  return { object: "page", url: res.url || url.toString(), title: page.title, text: page.text };
}
