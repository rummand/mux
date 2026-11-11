import { config } from "../config.js";
import { MuxError } from "./errors.js";
import type { Ctx } from "./metering.js";
import { noteCall } from "../services.js";

/**
 * Search and read the web for every product (mux's shared services, the owner 2026-11-02: "SearXNG on mux, a
 * general service across all our products"). `/v1/search` asks the SearXNG beside mux (MUX_SEARXNG_URL, on
 * Railway's private network) and gives back titles, links and the engines' extracts; `/v1/read` (reader.ts) fetches one
 * page or file and gives back its words as plain, AI-readable text – headings, paragraphs and lists, no scripts, menus
 * or ads – and, when asked, its links and the file's exact bytes.
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

export type EngineReport = { answered: { name: string; s: number | null }[]; failed: { name: string; reason: string }[] };

/** SearXNG's results page lists every engine it asked, with its response time or why it failed ("CAPTCHA", "Suspended: …"). */
export function enginesFromHtml(html: string): EngineReport {
  const out: EngineReport = { answered: [], failed: [] };
  const table = /<table class="engine-stats"[\s\S]*?<\/table>/.exec(html)?.[0] ?? "";
  for (const row of table.split(/<tr>/).slice(1)) {
    const name = decode(/<td class="engine-name">[\s\S]*?<a [^>]*>([\s\S]*?)<\/a>/.exec(row)?.[1]?.trim() ?? "");
    if (!name) continue;
    const err = /<td class="response-error">([\s\S]*?)<\/td>/.exec(row)?.[1];
    if (err != null) out.failed.push({ name, reason: decode(err.replace(/<[^>]+>/g, "")).replace(/\s+/g, " ").trim() || "error" });
    else out.answered.push({ name, s: Number(/<div class="bar-chart-value">([\d.]+)<\/div>/.exec(row)?.[1] ?? NaN) || null });
  }
  return out;
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", aelig: "æ", oslash: "ø", aring: "å", AElig: "Æ", Oslash: "Ø", Aring: "Å", ndash: "–", mdash: "—", hellip: "…", laquo: "«", raquo: "»" };
export const decode = (s: string) =>
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

export async function runSearch(ctx: Ctx, body: { query?: unknown; q?: unknown; limit?: unknown; language?: unknown }, signal: AbortSignal) {
  ctx.modelId = "searxng";
  ctx.route = "web.search";
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
  if (json.ok) {
    const data = (await json.json().catch(() => null)) as { results?: { engines?: unknown; engine?: unknown }[]; unresponsive_engines?: unknown[][] } | null;
    const results = resultsFrom(data, limit);
    // Which engines found something, and which did not answer – for the Services page (never the query)
    const names = [...new Set((data?.results ?? []).flatMap((r) => (Array.isArray(r.engines) ? r.engines : [r.engine]).filter((e): e is string => typeof e === "string")))];
    noteCall(ctx, { service: "web.search", results: results.length, engines: { answered: names.map((name) => ({ name, s: null })), failed: (data?.unresponsive_engines ?? []).map((u) => ({ name: String(u?.[0] ?? ""), reason: String(u?.[1] ?? "no answer") })).filter((u) => u.name) } });
    return { object: "search", query, results };
  }
  // JSON not switched on in this instance's settings (it answers 403): its results page says the same
  if (json.status !== 403) throw new MuxError(502, "upstream_error", `the search engine answered ${json.status}`);
  const html = await ask("html");
  if (!html.ok) throw new MuxError(502, "upstream_error", `the search engine answered ${html.status}`);
  const page = await html.text();
  const results = resultsFromHtml(page, limit);
  noteCall(ctx, { service: "web.search", results: results.length, engines: enginesFromHtml(page) });
  return { object: "search", query, results };
}
