import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { settings } from "../db.js";
import { MuxError } from "./errors.js";

/**
 * The page reader's render mode (`/v1/read {render: true}`, route `web.render`; bloom for business 2026-11-14: a
 * site that builds its pages in the browser, energinet.dk with Vue, gave titles and no words). The page is opened in
 * a headless Chromium on this machine, its scripts run, and the rendered DOM comes back for the reader to turn into
 * words and links as it does any page.
 *
 * Safety (the owner's conditions):
 *  - **Public addresses only, on every request the page makes**: the browser never touches the network itself.
 *    Every request (the page, its scripts, its XHR, each redirect hop) is intercepted, checked for a public address
 *    (DNS resolved here, every address of the name), and fetched by mux; the browser's own DNS maps every name to
 *    nothing and its proxy is a closed port, so a request that escaped interception (a WebSocket, a prefetch)
 *    cannot reach anything.
 *  - **No cookies or storage kept**: a new browser context per page (its own in-memory profile), closed after;
 *    Set-Cookie is dropped from every answer and no Cookie or Authorization header is ever sent.
 *  - **Time and byte caps**: the whole render within `timeoutMs`, all its answers within `maxBytes`, at most
 *    `maxRequests` requests; pictures, media and fonts are never fetched (words need none of them).
 *  - **No downloads**, no pop-ups, no dialogs, no service workers, no permissions; only GET and HEAD are sent.
 *  - **The same honest user agent** as the reader.
 */

const MB = 1024 * 1024;
export const RENDER_DEFAULTS = { timeoutMs: 25_000, maxBytes: 15 * MB, maxRequests: 150, settleMs: 1200, quietMs: 10_000 } as const;
const MAX_HOPS = 5;
// Stylesheets too: a bundler that loads a part of the page with its stylesheet waits for both (energinet.dk renders nothing without).
const KEEP = new Set(["document", "script", "xhr", "fetch", "stylesheet"]);
const DROP_HEADERS = new Set(["set-cookie", "set-cookie2", "content-encoding", "content-length", "transfer-encoding", "connection", "keep-alive", "strict-transport-security", "alt-svc", "clear-site-data"]);

export interface RenderResult {
  final_url: string; status: number; content_type: string; html: string; redirects: string[];
  render: { ms: number; requests: number; blocked: number; refused: number; bytes: number; cached: number; settled: boolean; engine: string };
  etag?: string; last_modified?: string; x_robots_tag?: string | null;
}
export interface RenderOptions {
  isPrivate: (ip: string) => boolean; userAgent: string; signal: AbortSignal;
  timeoutMs?: number; maxBytes?: number; maxRequests?: number; settleMs?: number; quietMs?: number;
}

/** Whether an address may be fetched: http(s), no credentials, every address of its name public. */
async function isPublic(u: URL, isPrivate: (ip: string) => boolean): Promise<boolean> {
  if (!/^https?:$/.test(u.protocol) || u.username || u.password) return false;
  const host = u.hostname.replace(/^\[|\]$/g, "");
  if (/(^|\.)(internal|local|localhost)$/i.test(host)) return false;
  const ips = isIP(host) ? [host] : (await lookup(host, { all: true }).catch(() => [])).map((a) => a.address);
  return ips.length > 0 && !ips.some(isPrivate);
}

// ── The browser: one process, launched on first use, closed when idle; a fresh context per page ────────────────────
type PW = typeof import("playwright-core");
type Browser = Awaited<ReturnType<PW["chromium"]["launch"]>>;
let browser: Promise<Browser> | null = null;
let idle: ReturnType<typeof setTimeout> | null = null;
let busy = 0;
const waiters: (() => void)[] = [];

/** Why rendering is not available here, or null when it is (playwright-core and a Chromium on this machine). */
export async function renderUnavailable(): Promise<string | null> {
  try { await import("playwright-core"); } catch { return "this mux has no headless browser (playwright-core is not installed)"; }
  return null;
}

async function getBrowser(): Promise<Browser> {
  if (!browser) {
    browser = (async () => {
      let pw: PW;
      try { pw = await import("playwright-core"); } catch { throw new MuxError(503, "render_unavailable", "this mux has no headless browser (playwright-core is not installed)"); }
      try {
        return await pw.chromium.launch({
          headless: true,
          chromiumSandbox: true,
          ...(process.env.MUX_CHROMIUM_PATH ? { executablePath: process.env.MUX_CHROMIUM_PATH } : {}),
          args: [
            // The browser resolves no name and reaches no proxy: everything it loads comes through mux's checks.
            "--host-resolver-rules=MAP * ~NOTFOUND",
            "--proxy-server=http://127.0.0.1:9",
            "--proxy-bypass-list=<-loopback>",
            "--disable-background-networking", "--disable-sync", "--disable-extensions", "--disable-component-update",
            "--no-first-run", "--no-default-browser-check", "--disable-domain-reliability", "--disable-breakpad",
            "--disable-features=DnsOverHttps,NetworkPrediction,InterestFeedContentSuggestions,Translate,OptimizationHints",
            "--webrtc-ip-handling-policy=disable_non_proxied_udp", "--force-webrtc-ip-handling-policy",
          ],
        });
      } catch (e) {
        throw new MuxError(503, "render_unavailable", `the headless browser could not start (${(e instanceof Error ? e.message : String(e)).split("\n")[0].slice(0, 200)})`);
      }
    })();
    browser.catch(() => { browser = null; });
    void browser.then((b) => b.on("disconnected", () => { browser = null; })).catch(() => undefined);
  }
  return browser;
}
function scheduleClose() {
  if (idle) clearTimeout(idle);
  idle = setTimeout(() => {
    if (busy) return;
    const b = browser;
    browser = null;
    void b?.then((x) => x.close()).catch(() => undefined);
  }, 120_000);
  idle.unref();
}

// ── A short cache of public scripts and stylesheets ───────────────────────────────────────────────────────────────
// Only answers that are 200, have no Set-Cookie and do not say no-store or private, fetched without credentials (the
// renderer never sends any), for ten minutes, 64 MB at most, oldest out first. Pages and data (XHR) are never cached.
const CACHE_MS = 10 * 60_000;
const CACHE_BYTES = 64 * MB;
const sharedCache = new Map<string, { at: number; headers: Record<string, string>; body: Buffer }>();
let cacheBytes = 0;
function fromCache(url: string) {
  const e = sharedCache.get(url);
  if (!e) return null;
  if (Date.now() - e.at > CACHE_MS) { sharedCache.delete(url); cacheBytes -= e.body.length; return null; }
  return e;
}
function toCache(url: string, res: Response, headers: Record<string, string>, body: Buffer) {
  const cc = (res.headers.get("cache-control") ?? "").toLowerCase();
  if (res.status !== 200 || res.headers.get("set-cookie") || /no-store|private/.test(cc) || body.length > 8 * MB) return;
  const old = sharedCache.get(url);
  if (old) { sharedCache.delete(url); cacheBytes -= old.body.length; }
  sharedCache.set(url, { at: Date.now(), headers, body });
  cacheBytes += body.length;
  for (const [k, v] of sharedCache) { if (cacheBytes <= CACHE_BYTES) break; sharedCache.delete(k); cacheBytes -= v.body.length; }
}
/** Tests: forget every cached script and stylesheet. */
export function clearRenderCache() { sharedCache.clear(); cacheBytes = 0; }

/** Pages rendered at once on this machine (settings.renderParallel, 2 by default); more wait up to 20 s for a turn. */
async function slot(signal: AbortSignal): Promise<() => void> {
  const cap = Math.max(1, Number(settings().renderParallel) || 2);
  const started = Date.now();
  while (busy >= cap) {
    if (Date.now() - started > 20_000) throw new MuxError(429, "render_busy", `the renderer is busy (${cap} pages at once on this machine); ask again shortly`, 5);
    await new Promise<void>((r) => { waiters.push(r); setTimeout(r, 1000).unref(); });
    if (signal.aborted) throw new MuxError(499, "aborted", "the caller went away");
  }
  busy++;
  if (idle) clearTimeout(idle);
  let done = false;
  return () => { if (done) return; done = true; busy--; waiters.shift()?.(); if (!busy) scheduleClose(); };
}

/** Renders one public page with its scripts run, by the rules above. */
export async function renderPage(start: URL, o: RenderOptions): Promise<RenderResult> {
  const timeoutMs = o.timeoutMs ?? RENDER_DEFAULTS.timeoutMs;
  const maxBytes = o.maxBytes ?? RENDER_DEFAULTS.maxBytes;
  const maxRequests = o.maxRequests ?? RENDER_DEFAULTS.maxRequests;
  const settleMs = o.settleMs ?? RENDER_DEFAULTS.settleMs;
  const quietMs = o.quietMs ?? RENDER_DEFAULTS.quietMs;
  const t0 = Date.now();
  const release = await slot(o.signal);
  const deadline = AbortSignal.any([o.signal, AbortSignal.timeout(timeoutMs)]);
  const b = await getBrowser().catch((e) => { release(); throw e; });
  const stats = { requests: 0, blocked: 0, refused: 0, bytes: 0, cached: 0 };
  const redirects: string[] = [];
  type Main = { status: number; type: string; etag?: string; last_modified?: string; robots: string | null };
  let main: Main | null = null;
  let notPage: string | null = null;
  let page: import("playwright-core").Page | undefined;
  const context = await b.newContext({
    userAgent: o.userAgent, acceptDownloads: false, serviceWorkers: "block", javaScriptEnabled: true, locale: "da-DK",
    viewport: { width: 1280, height: 900 }, permissions: [], geolocation: undefined, offline: false, bypassCSP: false,
    extraHTTPHeaders: { "accept-language": "da,en;q=0.8" },
  });
  try {
    // Every request, the page's own included, is fetched here: each address (and each redirect hop) checked for
    // the public web first. Redirects are followed here, at most 5, since the browser does not hand a redirected
    // request back for checking.
    const fetchChecked = async (first: URL, method: string, headers: Record<string, string>): Promise<{ res: Response; url: URL } | "refused" | "failed" | "hops"> => {
      let u = first;
      for (let hop = 0; ; hop++) {
        if (!(await isPublic(u, o.isPrivate))) return "refused";
        let res: Response;
        try { res = await fetch(u, { method, headers, redirect: "manual", credentials: "omit", signal: deadline }); } catch { return "failed"; }
        const loc = res.headers.get("location");
        if (res.status < 300 || res.status >= 400 || !loc) return { res, url: u };
        await res.body?.cancel().catch(() => {});
        if (hop >= MAX_HOPS) return "hops";
        try { u = new URL(loc, u); u.hash = ""; } catch { return "failed"; }
        stats.requests++;
      }
    };
    await context.route("**/*", async (route) => {
      const req = route.request();
      const type = req.resourceType();
      let isMain = false;
      try { isMain = req.isNavigationRequest() && !!page && req.frame() === page.mainFrame(); } catch { /* a worker's request */ }
      let u: URL;
      try { u = new URL(req.url()); } catch { stats.blocked++; return route.abort("blockedbyclient").catch(() => undefined); }
      // Words need the page, its scripts and their data; not pictures, media, fonts or beacons.
      // A frame's page (a video player, a map) is not this page's words: only the page itself is opened.
      if (!KEEP.has(type) || (type === "document" && !isMain) || (req.method() !== "GET" && req.method() !== "HEAD")) { stats.blocked++; return route.abort("blockedbyclient").catch(() => undefined); }
      if (deadline.aborted || stats.requests >= maxRequests || stats.bytes >= maxBytes) { stats.blocked++; return route.abort("blockedbyclient").catch(() => undefined); }
      stats.requests++;
      // A site's own scripts and stylesheets, the same on every page, are fetched once in ten minutes (sharedCache):
      // rendering a thousand pages does not ask the site for its bundles a thousand times.
      const hit = (type === "script" || type === "stylesheet") && req.method() === "GET" ? fromCache(u.toString()) : null;
      if (hit) { stats.cached++; return route.fulfill({ status: 200, headers: hit.headers, body: hit.body }).catch(() => undefined); }
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(req.headers())) if (!/^(cookie|authorization|proxy-authorization|user-agent|host)$/i.test(k)) headers[k] = v;
      headers["user-agent"] = o.userAgent;
      const got = await fetchChecked(u, req.method(), headers);
      if (got === "refused") { stats.refused++; return route.abort("addressunreachable").catch(() => undefined); }
      if (got === "failed" || got === "hops") { stats.blocked++; return route.abort("failed").catch(() => undefined); }
      const res = got.res;
      const out: Record<string, string> = {};
      res.headers.forEach((v, k) => { if (!DROP_HEADERS.has(k.toLowerCase())) out[k] = v; });
      if (isMain && !main) {
        const ct = res.headers.get("content-type") ?? "";
        main = { status: res.status, type: ct, ...(res.headers.get("etag") ? { etag: res.headers.get("etag")! } : {}), ...(res.headers.get("last-modified") ? { last_modified: res.headers.get("last-modified")! } : {}), robots: res.headers.get("x-robots-tag") };
        // A download is never taken; something that is not a web page is the plain reader's to read.
        if (/attachment/i.test(res.headers.get("content-disposition") ?? "") || !/^(text\/html|application\/xhtml\+xml)/i.test(ct.trim())) {
          await res.body?.cancel().catch(() => {});
          notPage = ct.split(";")[0].trim() || "no type";
          return route.abort("blockedbyclient").catch(() => undefined);
        }
      }
      // The body, within what is left of the byte cap
      const chunks: Buffer[] = [];
      let n = 0;
      if (res.body && req.method() !== "HEAD") {
        const reader = res.body.getReader();
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            n += value.byteLength;
            if (stats.bytes + n > maxBytes) { await reader.cancel().catch(() => {}); stats.bytes += n; stats.blocked++; return route.abort("blockedbyclient").catch(() => undefined); }
            chunks.push(Buffer.from(value));
          }
        } catch { stats.blocked++; return route.abort("failed").catch(() => undefined); }
      }
      stats.bytes += n;
      const bodyBytes = Buffer.concat(chunks, n);
      if ((type === "script" || type === "stylesheet") && req.method() === "GET" && got.url.toString() === u.toString()) toCache(u.toString(), res, out, bodyBytes);
      return route.fulfill({ status: res.status, headers: out, body: bodyBytes }).catch(() => undefined);
    });
    // Nothing reaches the network but through the route above; WebSockets are closed at once.
    await context.routeWebSocket(/.*/, (ws) => { stats.blocked++; void ws.close(); }).catch(() => undefined);
    // The page's own redirects first, each hop checked, so the browser opens the final address (its base for links).
    let target = start;
    for (let hop = 0; ; hop++) {
      if (!(await isPublic(target, o.isPrivate))) throw new MuxError(400, "invalid_request_error", "only pages on the public web can be read");
      stats.requests++;
      const r = await fetch(target, { method: "GET", headers: { "user-agent": o.userAgent, accept: "text/html,application/xhtml+xml", "accept-language": "da,en;q=0.8" }, redirect: "manual", credentials: "omit", signal: deadline }).catch((e) => {
        throw new MuxError(502, "upstream_error", `the page could not be fetched (${e instanceof Error ? (e.name === "TimeoutError" ? "no answer in time" : e.name) : "error"})`);
      });
      await r.body?.cancel().catch(() => {});
      const loc = r.headers.get("location");
      if (r.status < 300 || r.status >= 400 || !loc) break;
      if (hop >= MAX_HOPS) throw new MuxError(502, "too_many_redirects", `more than ${MAX_HOPS} redirects: ${[start.toString(), ...redirects].join(" → ")}`);
      let next: URL;
      try { next = new URL(loc, target); next.hash = ""; } catch { throw new MuxError(502, "upstream_error", "the page redirected to an address that is not one"); }
      if (redirects.includes(next.toString()) || next.toString() === start.toString()) throw new MuxError(502, "redirect_loop", `the redirects go round in a loop: ${[start.toString(), ...redirects, next.toString()].join(" → ")}`);
      redirects.push(next.toString());
      target = next;
    }
    page = await context.newPage();
    page.on("dialog", (d) => void d.dismiss().catch(() => undefined));
    page.on("popup", (p) => void p.close().catch(() => undefined));
    page.on("download", (d) => void d.cancel().catch(() => undefined));
    const left = () => Math.max(500, timeoutMs - (Date.now() - t0) - 500);
    try {
      await page.goto(target.toString(), { waitUntil: "domcontentloaded", timeout: left() });
    } catch (e) {
      if (notPage) throw new MuxError(415, "unsupported_media", `the answer is ${notPage}: not a web page to render (read it without render)`);
      if (deadline.aborted) throw new MuxError(504, "render_timeout", `the page did not render within ${Math.round(timeoutMs / 1000)} s`);
      if (stats.refused && !main) throw new MuxError(400, "invalid_request_error", "only pages on the public web can be read");
      throw new MuxError(502, "upstream_error", `the page could not be rendered (${(e instanceof Error ? e.message : String(e)).split("\n")[0].slice(0, 160)})`);
    }
    const m = main as Main | null;
    if (!m) throw new MuxError(502, "upstream_error", "the page gave no answer to render");
    if (m.status < 200 || m.status >= 300) throw new MuxError(502, "upstream_error", `the page answered ${m.status}`);
    // Scripts run until the page's words stop changing for settleMs (a page that keeps polling never goes quiet on
    // the network), at most quietMs after the page loaded, within the time cap.
    await page.waitForLoadState("load", { timeout: Math.min(8000, left()) }).catch(() => undefined);
    let settled = false;
    const until = Date.now() + Math.min(left(), quietMs);
    let last = -1;
    let since = Date.now();
    while (Date.now() < until) {
      await page.waitForTimeout(300).catch(() => undefined);
      const chars = await page.evaluate(() => document.body?.innerText?.length ?? 0).catch(() => -1);
      if (chars !== last) { last = chars; since = Date.now(); }
      else if (Date.now() - since >= (chars > 0 ? settleMs : 4 * settleMs)) { settled = chars > 0; break; }
    }
    const html = await page.content();
    return {
      final_url: page.url().replace(/#.*$/, ""), status: m.status, content_type: m.type, html, redirects,
      render: { ms: Date.now() - t0, ...stats, settled, engine: `chromium ${b.version()}` },
      ...(m.etag ? { etag: m.etag } : {}), ...(m.last_modified ? { last_modified: m.last_modified } : {}), x_robots_tag: m.robots,
    };
  } finally {
    await context.close().catch(() => undefined);
    release();
  }
}

/** Closes the browser now (tests, and a clean shutdown). */
export async function closeRenderer() {
  if (idle) clearTimeout(idle);
  const b = browser;
  browser = null;
  await b?.then((x) => x.close()).catch(() => undefined);
}
