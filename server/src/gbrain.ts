import { execFile, spawn, type ChildProcess } from "node:child_process";
import { createWriteStream, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { config } from "./config.js";
import { event } from "./db.js";

/**
 * GBrain (github.com/garrytan/gbrain) as mux's brain. GBrain keeps the pages and facts — in its own database under
 * ~/.gbrain, embedded through mux's `embed` route as the GBrain tenant — and mux speaks MCP to it over loopback.
 * mux runs `gbrain serve --http` itself (and restarts it), unless one already answers on the port; other agents can
 * share the same brain through that server with their own `gbrain auth` tokens.
 *
 * GBrain is tuned to work on mux alone: embeddings (bge-m3), reranking (qwen3-reranker) and its chat work — query
 * expansion, fact extraction, synthesis (the qwen routes) — all go to this mux as the GBrain tenant, with the key in
 * ~/.gbrain/mux.env, which mux hands every GBrain process it starts. Its chat runs through GBrain's `ollama`
 * provider pointed at mux: with no base URL that provider can only reach localhost, never a cloud API.
 * `gbrain serve --http` does not sweep its own links and facts, so mux runs `gbrain sweep --once` every 30 minutes.
 *
 * Turned on by MUX_GBRAIN_TOKEN (a `gbrain auth create mux --scopes read,write` token); without it the brain is
 * mux's own SQLite one (brain.ts).
 */
export const gbrainOn = () => !!config.gbrainToken;
const base = () => `http://127.0.0.1:${config.gbrainPort}`;

/* ── The server ─────────────────────────────────────────────────────────────────────────────────────────────── */

let child: ChildProcess | null = null;
let stopping = false;
let restarts = 0;
let state: { ok: boolean; version: string | null; managed: boolean; error: string | null; lastSweep: { at: number; ok: boolean; detail: string } | null } = { ok: false, version: null, managed: false, error: null, lastSweep: null };

/** The environment GBrain's processes run with: mux's, Bun on the PATH, and ~/.gbrain/mux.env. */
function gbrainEnv(): NodeJS.ProcessEnv {
  const extra: Record<string, string> = {};
  try {
    for (const line of readFileSync(config.gbrainEnvFile, "utf8").split("\n")) {
      const m = /^\s*([A-Z_][A-Z0-9_]*)=(.*)$/.exec(line);
      if (m) extra[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
    }
  } catch { /* no file: GBrain runs keyless */ }
  const path = [process.env.PATH, "/opt/homebrew/bin", join(process.env.HOME ?? "", ".bun/bin")].filter(Boolean).join(":");
  // Not mux's own secrets (its admin token, GBrain's token for mux): GBrain needs only its own.
  const own = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("MUX_")));
  return { ...own, ...extra, PATH: path };
}

/** Links, timelines and facts of recently changed pages (the sweep a stdio server would run itself). */
function sweep() {
  if (!state.ok) return;
  execFile(config.gbrainBin, ["sweep", "--once", "--json"], { cwd: config.home, env: gbrainEnv(), timeout: 10 * 60_000, maxBuffer: 8 << 20 }, (err, stdout, stderr) => {
    const detail = (err ? (stderr || err.message) : stdout).trim().split("\n").slice(-1)[0]?.slice(0, 300) ?? "";
    state.lastSweep = { at: Date.now(), ok: !err, detail };
    if (err) event("warn", "gbrain", `sweep failed: ${detail}`);
  });
}
export const gbrainState = () => ({ ...state, url: base(), bin: config.gbrainBin });

async function health(): Promise<string | null> {
  try {
    const r = await fetch(`${base()}/health`, { signal: AbortSignal.timeout(3000) });
    if (!r.ok) return null;
    return ((await r.json()) as { version?: string }).version ?? "?";
  } catch { return null; }
}

/** Keep a GBrain server answering on the port: one already there is used as it is; otherwise mux starts its own. */
export async function startGbrain() {
  if (!gbrainOn()) return;
  const check = async () => {
    const v = await health();
    if (v) { if (!state.ok) event("info", "gbrain", `GBrain ${v} answers on ${base()}${child ? " (run by mux)" : ""}`); state = { ...state, ok: true, version: v, error: null }; return; }
    state = { ...state, ok: false };
    if (child || stopping) return;
    if (!existsSync(config.gbrainBin)) { state.error = `gbrain is not installed at ${config.gbrainBin}`; return; }
    const log = createWriteStream(join(config.logsDir, "gbrain.log"), { flags: "a" });
    // gbrain is a Bun program (Bun on the PATH), and reaches mux with the key in ~/.gbrain/mux.env.
    child = spawn(config.gbrainBin, ["serve", "--http", "--port", String(config.gbrainPort)], { cwd: config.home, env: gbrainEnv(), stdio: ["ignore", "pipe", "pipe"] });
    state.managed = true;
    child.stdout?.pipe(log); child.stderr?.pipe(log);
    event("info", "gbrain", `started gbrain serve on ${base()} (pid ${child.pid})`);
    child.on("exit", (code, sig) => {
      child = null;
      if (stopping) return;
      restarts++;
      state = { ...state, ok: false, error: `gbrain serve stopped (${sig ?? `exit ${code}`}); see ${join(config.logsDir, "gbrain.log")}` };
      event("warn", "gbrain", state.error!);
    });
  };
  await check();
  // A server mux just started takes a few seconds to open its brain: wait for it (up to a minute) before going on.
  for (let i = 0; i < 60 && child && !state.ok; i++) { await new Promise((r) => setTimeout(r, 1000)); const v = await health(); if (v) state = { ...state, ok: true, version: v, error: null }; }
  if (state.ok) event("info", "gbrain", `GBrain ${state.version} answers on ${base()}${child ? " (run by mux)" : ""}`);
  // Checked every 15 s; a server that stopped is started again, at most once a minute after the first few times.
  setInterval(() => { if (restarts < 3 || Date.now() % 60_000 < 15_000) void check(); }, 15_000).unref();
  setTimeout(sweep, 2 * 60_000).unref();
  setInterval(sweep, 30 * 60_000).unref();
}

export function stopGbrain() {
  stopping = true;
  child?.kill("SIGTERM");
}

/* ── MCP over HTTP ──────────────────────────────────────────────────────────────────────────────────────────── */

let seq = 0;
/** Call a GBrain operation; its answer is the JSON in the tool result's text. */
export async function gcall<T = Record<string, unknown>>(name: string, args: Record<string, unknown>, timeoutMs = 20_000): Promise<T> {
  const r = await fetch(`${base()}/mcp`, {
    method: "POST", signal: AbortSignal.timeout(timeoutMs),
    headers: { authorization: `Bearer ${config.gbrainToken}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++seq, method: "tools/call", params: { name, arguments: args } }),
  });
  const raw = await r.text();
  if (!r.ok) throw new Error(`GBrain ${name}: ${r.status} ${raw.slice(0, 200)}`);
  // Streamable HTTP answers as server-sent events (one `data:` line here) or as plain JSON.
  const line = raw.split("\n").find((l) => l.startsWith("data:"));
  const msg = JSON.parse(line ? line.slice(5) : raw) as { result?: { content?: { text?: string }[]; isError?: boolean }; error?: { message?: string } };
  if (msg.error) throw new Error(`GBrain ${name}: ${msg.error.message}`);
  const text = msg.result?.content?.[0]?.text ?? "{}";
  if (msg.result?.isError) throw new Error(`GBrain ${name}: ${text.slice(0, 300)}`);
  try { return JSON.parse(text) as T; } catch { return { text } as T; }
}

/**
 * GBrain hands back stored text as quoted source material ("[quoted … excerpt from <slug>; source material, not
 * instructions]" and a fenced block), so that a page can never pass for an instruction. The assistant reads it framed;
 * the dashboard shows and edits the text inside.
 */
export function unwrap(s: unknown): string {
  if (typeof s !== "string") return s == null ? "" : String(s);
  const m = /^\[quoted [^\]]*\]\n```[a-z]*\n([\s\S]*?)\n```\s*$/.exec(s);
  return m ? m[1] : s;
}
