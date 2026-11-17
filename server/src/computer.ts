import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { config } from "./config.js";

/**
 * The Mac itself, for Ask mux: look at the screen and the apps, and act in them (click, type, keys, menus, apps),
 * through Peekaboo (openclaw/Peekaboo, MIT), a macOS CLI built on Accessibility and ScreenCaptureKit.
 *
 * mux runs as a LaunchAgent, so Peekaboo works through its Bridge: Peekaboo.app (the menu-bar app) holds the Screen
 * Recording and Accessibility grants and does the work; the CLI that mux starts asks it. deploy/computer.sh installs
 * both and says which permissions to grant. Only the owner's Ask mux conversation gets these tools — never a tenant
 * key, never the doctor or the brain keeper — and every action waits for the owner's approval in the dashboard.
 * Looking (a UI map of an app or the screen) runs at once, as reading mux does.
 *
 * Commands run with execFile (no shell): arguments are passed as they are, never interpreted.
 */
const CANDIDATES = [process.env.MUX_PEEKABOO, "/opt/homebrew/bin/peekaboo", "/usr/local/bin/peekaboo", join(config.home, "bin/peekaboo")];
export const peekabooBin = (): string | null => CANDIDATES.find((p): p is string => !!p && existsSync(p)) ?? null;
export const computerAvailable = () => config.role !== "gateway" && process.platform === "darwin" && !!peekabooBin();

const SHOTS = join(config.home, "computer");
const MAX_OUT = 2 * 1024 * 1024;

export interface PeekResult { ok: boolean; code: number | null; data: unknown; stderr: string }

/** Run peekaboo with these arguments and --json; the parsed JSON (or the text) back. */
export function peekaboo(args: string[], timeoutMs = 30_000): Promise<PeekResult> {
  const bin = peekabooBin();
  if (!bin) return Promise.resolve({ ok: false, code: null, data: { error: "Peekaboo is not installed on this Mac: run ./deploy/computer.sh" }, stderr: "" });
  return new Promise((resolve) => {
    execFile(bin, [...args, "--json"], { timeout: timeoutMs, maxBuffer: MAX_OUT, env: { ...process.env, PATH: `/opt/homebrew/bin:/usr/local/bin:${process.env.PATH ?? ""}` } }, (err, stdout, stderr) => {
      let data: unknown = stdout.trim();
      try { data = JSON.parse(stdout); } catch { /* text */ }
      const code = err ? ((err as NodeJS.ErrnoException & { code?: number }).code as number | undefined) ?? 1 : 0;
      resolve({ ok: !err, code: typeof code === "number" ? code : 1, data, stderr: stderr.slice(-2000) });
    });
  });
}

/** Keep what a model needs from a UI map: element ids, roles, labels, values, where; drop the rest. */
export function compactSee(data: unknown, max = 160): unknown {
  const d = (data ?? {}) as Record<string, unknown>;
  const body = (d.data ?? d) as Record<string, unknown>;
  const raw = (body.ui_elements ?? body.elements ?? body.uiElements ?? []) as Record<string, unknown>[];
  const elements = Array.isArray(raw) ? raw : [];
  const pick = (e: Record<string, unknown>) => {
    const out: Record<string, unknown> = {};
    for (const k of ["id", "role", "title", "label", "value", "description", "identifier", "is_actionable", "actionable", "bounds", "frame"]) if (e[k] !== undefined && e[k] !== null && e[k] !== "") out[k] = e[k];
    return out;
  };
  const keep = elements.filter((e) => e.is_actionable !== false && e.actionable !== false).slice(0, max).map(pick);
  return {
    snapshot_id: body.snapshot_id ?? body.snapshotId ?? null,
    app: body.application_name ?? body.app ?? body.applicationName ?? null,
    window: body.window_title ?? body.windowTitle ?? null,
    window_id: body.window_id ?? body.windowId ?? null,
    elements: keep,
    more: elements.length > keep.length ? `${elements.length - keep.length} more elements left out (non-actionable or over ${max}); narrow with app or window_id` : undefined,
    warnings: body.warnings ?? d.warnings ?? undefined,
    error: d.success === false ? d.error ?? body.error : undefined,
  };
}

const str = (v: unknown) => (v === undefined || v === null ? "" : String(v)).trim();
/** Who an action is aimed at: app, pid or window id, as Peekaboo's target flags. */
function target(a: Record<string, unknown>): string[] {
  const out: string[] = [];
  if (str(a.app)) out.push("--app", str(a.app));
  else if (str(a.pid)) out.push("--pid", str(a.pid));
  if (str(a.window_id)) out.push("--window-id", str(a.window_id));
  return out;
}

/** computer_look: a UI map (and a screenshot file kept for the dashboard) of an app, a window, or the whole screen. */
export async function look(a: Record<string, unknown>) {
  mkdirSync(SHOTS, { recursive: true, mode: 0o700 });
  const path = join(SHOTS, `see-${Date.now()}.png`);
  const args = ["see", "--path", path];
  if (str(a.app) || str(a.pid) || str(a.window_id)) args.push(...target(a));
  else args.push("--mode", str(a.mode) === "screen" ? "screen" : "frontmost");
  if (a.ocr) args.push("--ocr");
  const r = await peekaboo(args, 45_000);
  const shot = existsSync(path) ? path : null;
  return { ok: r.ok, ...(compactSee(r.data) as object), screenshot: shot, stderr: r.ok ? undefined : r.stderr || undefined };
}

/** computer_list: running apps, or one app's windows. */
export async function list(a: Record<string, unknown>) {
  const r = str(a.what) === "windows" && str(a.app) ? await peekaboo(["window", "list", "--app", str(a.app)]) : await peekaboo(["app", "list"]);
  return { ok: r.ok, data: r.data, stderr: r.ok ? undefined : r.stderr || undefined };
}

export const ACTIONS = ["click", "double_click", "right_click", "type", "press", "hotkey", "scroll", "menu", "launch", "focus", "quit", "open_url"] as const;

/** The peekaboo arguments one approved action becomes; an error string when it is not well formed. */
export function actionArgs(a: Record<string, unknown>): string[] | string {
  const action = str(a.action);
  const t = target(a);
  const snap = str(a.snapshot_id) ? ["--snapshot", str(a.snapshot_id)] : [];
  const fg = a.foreground ? ["--foreground"] : [];
  switch (action) {
    case "click": case "double_click": case "right_click": {
      const kind = action === "double_click" ? ["--double"] : action === "right_click" ? ["--right"] : [];
      if (str(a.element)) return ["click", "--on", str(a.element), ...snap, ...t, ...kind, ...fg];
      if (str(a.text)) return ["click", str(a.text), ...snap, ...t, ...kind, ...fg];
      if (str(a.at)) return ["click", "--at", str(a.at), ...snap, ...t, ...kind, ...fg];
      return "click needs element (an id from computer_look), text, or at (x,y)";
    }
    case "type":
      if (!str(a.text)) return "type needs text";
      return ["type", String(a.text), ...snap, ...t, ...fg];
    case "press":
      if (!str(a.key)) return "press needs key, e.g. return, tab, escape, down";
      return ["press", str(a.key), ...t, ...snap, ...fg];
    case "hotkey": // a chord is a press: cmd+s
      if (!str(a.keys)) return "hotkey needs keys, e.g. cmd+s";
      return ["press", str(a.keys).replace(/\s*[,+]\s*/g, "+"), ...t, ...snap, ...fg];
    case "scroll": {
      const dir = ["up", "down", "left", "right"].includes(str(a.direction)) ? str(a.direction) : "down";
      const amount = String(Math.max(1, Math.min(50, Number(a.amount) || 3)));
      // On an element it stays in the background; without one Peekaboo needs foreground wheel input
      return str(a.element) ? ["scroll", "--direction", dir, "--amount", amount, "--on", str(a.element), ...snap, ...t] : ["scroll", "--direction", dir, "--amount", amount, ...t, "--foreground"];
    }
    case "menu":
      if (!str(a.app) || !str(a.path)) return "menu needs app and path, e.g. File > Save";
      return ["menu", "click", "--app", str(a.app), "--path", str(a.path)];
    case "launch":
      if (!str(a.app)) return "launch needs app";
      return ["app", "launch", str(a.app), "--foreground", "--wait-ready"];
    case "focus":
      if (!str(a.app)) return "focus needs app";
      return ["app", "focus", str(a.app), "--foreground"];
    case "quit":
      if (!str(a.app)) return "quit needs app";
      return ["app", "quit", str(a.app)];
    case "open_url": {
      if (!/^https?:\/\//i.test(str(a.url))) return "open_url needs an http(s) url";
      return ["app", "launch", str(a.app) || "Safari", "--open", str(a.url), "--foreground"];
    }
    default:
      return `no action ${action}: one of ${ACTIONS.join(", ")}`;
  }
}

/** computer_act: one action, already approved by the owner. */
export async function act(a: Record<string, unknown>) {
  const args = actionArgs(a);
  if (typeof args === "string") return { ok: false, error: args };
  const r = await peekaboo(args, 60_000);
  return { ok: r.ok, ran: ["peekaboo", ...args].join(" ").slice(0, 300), data: r.data, stderr: r.ok ? undefined : r.stderr || undefined, next: "Look again (computer_look) to see what changed before the next action." };
}

/** What the dashboard and deploy/computer.sh show: installed, version, the permissions Peekaboo sees. */
export async function computerStatus() {
  const bin = peekabooBin();
  if (!bin || process.platform !== "darwin") return { available: false, reason: config.role === "gateway" ? "a gateway has no screen" : bin ? "not macOS" : "Peekaboo is not installed: ./deploy/computer.sh" };
  const [v, p] = await Promise.all([peekaboo(["--version"], 10_000), peekaboo(["permissions", "status"], 15_000)]);
  return { available: computerAvailable(), bin, version: typeof v.data === "string" ? v.data : v.data, permissions: p.data, error: p.ok ? undefined : p.stderr || undefined };
}

/** A screenshot computer_look kept, for the dashboard (only files in mux's own folder, by name). */
export function screenshot(name: string): Buffer | null {
  if (!/^see-\d+\.png$/.test(name)) return null;
  const p = join(SHOTS, name);
  return existsSync(p) ? readFileSync(p) : null;
}

/** Screenshots older than an hour go. */
export function sweepScreenshots() {
  if (!existsSync(SHOTS)) return;
  const cutoff = Date.now() - 3600_000;
  for (const f of readdirSync(SHOTS)) {
    const m = /^see-(\d+)\.png$/.exec(f);
    if (m && Number(m[1]) < cutoff) rmSync(join(SHOTS, f), { force: true });
  }
}
