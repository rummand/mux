import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { FastifyInstance } from "fastify";
import { config } from "./config.js";
import { event, saveSettings, settings } from "./db.js";

/**
 * Presence: whether this machine may take work now, so that nobody at it ever notices mux. Recomputed every 5 s from
 * what the machine says about itself — on a Mac, idle time, battery and AC, heat and memory pressure; on Windows, what
 * its session helper reports — and from what its owner set. The gateway reads it with the node's state and routes by
 * it; the node enforces it too, so a gateway that has not caught up cannot overrule it.
 *
 *   free    nobody there (10+ minutes), or the owner made it available: loads anything that fits.
 *   polite  someone is there (or, on a machine that works only when nobody is, it is warm or short of memory), on
 *           battery, or "I'm using this Mac": only models already loaded, one at a time.
 *   busy    on a machine that works only when nobody is there: a fullscreen app, a call or a game, critical heat or
 *           memory — it finishes what runs, takes nothing new, and unloads idle models after a minute.
 *   away    turned off by its owner, or a battery nearly empty: out of every route.
 *
 * A move to a stricter state is at once; back to a freer one only after it has held for a minute, so a mouse nudged
 * once does not flap a node between states.
 */
export type NodeState = "free" | "polite" | "busy" | "away";
export type Mode = "available" | "away-only" | "off";
export type NodeClass = "always-on" | "desktop" | "laptop";

export interface Signals {
  /** Seconds since the last keyboard or mouse input; null when nobody is logged in to report it. */
  idleS: number | null;
  onBattery: boolean | null; batteryPct: number | null;
  thermal: "nominal" | "fair" | "serious" | "critical" | null;
  /** macOS's memory pressure: 1 normal, 2 warn, 4 critical. */
  pressure: number;
  /** From a session helper (Windows): a fullscreen app, a video call, a game in the foreground. */
  fullscreen?: boolean; call?: boolean; game?: boolean;
  source: "macos" | "helper" | "none"; ts: number;
}
export interface Presence {
  state: NodeState; mode: Mode; using: boolean; class: NodeClass; reasons: string[]; since: number; signals: Signals;
  /** Per loaded model: requests running and slots — so a gateway sees a node's queue every 5 s, and can burst past it. */
  load?: Record<string, { inflight: number; slots: number }>;
}
let loadReader: () => Presence["load"] = () => ({});
/** The runtime says how loaded its models are (it imports this module, so it registers rather than being imported). */
export const setLoadReader = (f: () => Presence["load"]) => { loadReader = f; };

/** Someone at the machine: input within this long. */
export const PRESENT_S = 600;
/** "I'm using this Mac" ends by itself after this long without input. */
const USING_CLEARS_S = 1800;
const SETTLE_MS = 60_000;
const RANK: Record<NodeState, number> = { free: 0, polite: 1, busy: 2, away: 3 };

/** The state the signals and the owner's settings call for, and why. */
export function judge(s: Signals, o: { mode: Mode; using: boolean }): { state: NodeState; reasons: string[] } {
  if (o.mode === "off") return { state: "away", reasons: ["turned off by its owner"] };
  if (s.onBattery && s.batteryPct != null && s.batteryPct < 20) return { state: "away", reasons: [`on battery at ${s.batteryPct}%`] };
  const busy: string[] = [];
  // A machine its owner made available is a server: it serves through a film, a call, heat or tight memory (its
  // runtime's memory guard unloads what is idle). One that works only when nobody is there steps back for all of them.
  if (o.mode === "away-only") {
    if (s.thermal === "critical") busy.push("too hot");
    if (s.pressure >= 4) busy.push("memory pressure critical");
    if (s.fullscreen) busy.push("a fullscreen app");
    if (s.call) busy.push("a call");
    if (s.game) busy.push("a game");
  }
  if (busy.length) return { state: "busy", reasons: busy };
  const polite: string[] = [];
  if (o.using) polite.push("its owner is using it");
  if (o.mode === "away-only" && s.idleS != null && s.idleS < PRESENT_S) polite.push(`someone there (input ${Math.round(s.idleS)} s ago)`);
  if (s.onBattery) polite.push("on battery");
  // A server (available) keeps all its slots when it is warm or memory is tight: the runtime's own memory guard
  // unloads what is idle. A machine someone also works at steps back instead.
  if (o.mode === "away-only" && s.thermal === "serious") polite.push("warm");
  if (o.mode === "away-only" && s.pressure >= 2) polite.push("memory pressure");
  if (polite.length) return { state: "polite", reasons: polite };
  return { state: "free", reasons: [o.mode === "available" ? "available" : s.idleS == null ? "nobody logged in" : `nobody there for ${Math.round(s.idleS / 60)} min`] };
}

/** Holds a state against flapping: stricter at once, freer only once the freer reading has lasted SETTLE_MS. */
export class Tracker {
  state: NodeState = "free"; since = Date.now(); reasons: string[] = [];
  private pending: { state: NodeState; from: number } | null = null;
  update(target: { state: NodeState; reasons: string[] }, at = Date.now()): boolean {
    const was = this.state;
    if (RANK[target.state] >= RANK[this.state]) { this.pending = null; if (target.state !== this.state) { this.state = target.state; this.since = at; } this.reasons = target.reasons; }
    else if (this.pending?.state !== target.state) this.pending = { state: target.state, from: at };
    else if (at - this.pending.from >= SETTLE_MS) { this.state = target.state; this.since = at; this.reasons = target.reasons; this.pending = null; }
    return this.state !== was;
  }
  /** The owner's own say is not a reading to wait out: it applies at once, either way. */
  force(target: { state: NodeState; reasons: string[] }, at = Date.now()) {
    if (target.state !== this.state) { this.state = target.state; this.since = at; }
    this.reasons = target.reasons; this.pending = null;
  }
}

/* ── Signals ────────────────────────────────────────────────────────────────────────────────────────────────── */

const run = promisify(execFile);
const out = (cmd: string, args: string[]) => run(cmd, args, { timeout: 4000 }).then((r) => r.stdout).catch(() => "");

/** What a Mac says about itself; the node runs in the user's session (a LaunchAgent), so it sees idle time. */
async function macSignals(): Promise<Signals> {
  const [hid, batt, therm, pressure] = await Promise.all([
    out("ioreg", ["-c", "IOHIDSystem", "-d", "4", "-k", "HIDIdleTime"]),
    out("pmset", ["-g", "batt"]),
    out("pmset", ["-g", "therm"]),
    out("sysctl", ["-n", "kern.memorystatus_vm_pressure_level"]),
  ]);
  const ns = /"HIDIdleTime" = (\d+)/.exec(hid)?.[1];
  const pct = /(\d+)%;/.exec(batt)?.[1];
  const limit = Number(/CPU_Speed_Limit\s*=\s*(\d+)/.exec(therm)?.[1] ?? 100);
  const level = /thermal warning level.*?(\d+)/i.exec(therm)?.[1];
  return {
    idleS: ns ? Number(ns) / 1e9 : null,
    onBattery: pct ? /'Battery Power'/.test(batt) : null, batteryPct: pct ? Number(pct) : null,
    thermal: limit < 60 || Number(level) >= 2 ? "critical" : limit < 100 || Number(level) === 1 ? "serious" : "nominal",
    pressure: Number(pressure.trim()) || 1, source: "macos", ts: Date.now(),
  };
}

let helper: Signals | null = null;
/** Elsewhere (Windows): what the session helper last reported, or — with no helper reporting — nobody logged in. */
function helperSignals(): Signals {
  if (helper && Date.now() - helper.ts < 30_000) return helper;
  return { idleS: null, onBattery: null, batteryPct: null, thermal: null, pressure: 1, source: "none", ts: Date.now() };
}

/** On a Mac, the menu bar app adds what the node cannot see: a fullscreen app and the microphone in use (a call). */
function withHelper(s: Signals): Signals {
  if (!helper || Date.now() - helper.ts > 30_000) return s;
  return { ...s, fullscreen: helper.fullscreen, call: helper.call, game: helper.game };
}

/* ── This machine ───────────────────────────────────────────────────────────────────────────────────────────── */

const tracker = new Tracker();
let signals: Signals = helperSignals();
/** When "I'm using this machine" was turned on: only a pause in input that starts after it ends it. */
let usingSince = Date.now();

export function nodeClass(s: Signals = signals, mode: Mode = settings().presenceMode): NodeClass {
  const set = settings().nodeClass;
  if (set !== "auto") return set;
  return s.batteryPct != null ? "laptop" : mode === "available" ? "always-on" : "desktop";
}

export function presence(): Presence {
  const s = settings();
  return { state: tracker.state, mode: s.presenceMode, using: s.presenceUsing, class: nodeClass(), reasons: tracker.reasons, since: tracker.since, signals, load: loadReader() };
}

export async function tick(owner = false) {
  signals = process.platform === "darwin" ? withHelper(await macSignals()) : helperSignals();
  const s = settings();
  if (s.presenceUsing && signals.idleS != null && signals.idleS > USING_CLEARS_S && Date.now() - signals.idleS * 1000 > usingSince) {
    saveSettings({ presenceUsing: false });
    event("info", "presence", `"I'm using this machine" ended: nobody there for ${Math.round(USING_CLEARS_S / 60)} min`);
  }
  const was = tracker.state;
  const target = judge(signals, { mode: s.presenceMode, using: settings().presenceUsing });
  if (owner) tracker.force(target); else tracker.update(target);
  if (tracker.state !== was) event("info", "presence", `${config.name}: ${was} → ${tracker.state} (${tracker.reasons.join(", ")})`);
}

/**
 * Whether this machine's runtime may serve a model now. A busy or away machine takes nothing new; a polite one serves
 * only what is loaded, one request at a time — the next waits up to 20 s for the one before.
 */
export async function admit(modelId: string, loaded: () => boolean, inflight: () => number): Promise<void> {
  const p = tracker.state;
  if (p === "away" || p === "busy") throw new Resting(`${config.name} is ${p} (${tracker.reasons.join(", ")}): it takes no new work now`);
  if (p !== "polite") return;
  if (!loaded()) throw new Resting(`${config.name} is polite (${tracker.reasons.join(", ")}): it serves only models already loaded, and ${modelId} is not`);
  for (let i = 0; i < 200 && inflight() > 0; i++) await new Promise((r) => setTimeout(r, 100));
  if (inflight() > 0) throw new Resting(`${config.name} is polite (${tracker.reasons.join(", ")}): one request at a time, and one is running`);
}
export class Resting extends Error {}

/** After a minute busy or away, models nobody is using are unloaded, so the person at the machine has its memory. */
export function shouldFree(at = Date.now()) {
  return (tracker.state === "busy" || tracker.state === "away") && at - tracker.since >= 60_000;
}

export function startPresence(freeUp: () => Promise<void>) {
  const loop = async () => {
    try { await tick(); if (shouldFree()) await freeUp(); } catch (e) { event("warn", "presence", (e as Error).message); }
  };
  void loop();
  setInterval(loop, 5000).unref();
}

/* ── Admin API ──────────────────────────────────────────────────────────────────────────────────────────────── */

export function registerPresence(api: FastifyInstance) {
  api.get("/presence", async () => presence());
  // The owner's settings: from the menu bar ("I'm using this Mac", available / only when I'm away / off) or a gateway.
  api.put("/presence", async (req, reply) => {
    const b = (req.body ?? {}) as { mode?: string; using?: boolean; class?: string };
    if (b.mode !== undefined && !["available", "away-only", "off"].includes(b.mode)) return reply.code(400).send({ error: "mode is available, away-only or off" });
    if (b.class !== undefined && !["auto", "always-on", "desktop", "laptop"].includes(b.class)) return reply.code(400).send({ error: "class is auto, always-on, desktop or laptop" });
    if (b.using) usingSince = Date.now();
    saveSettings({ ...(b.mode ? { presenceMode: b.mode as Mode } : {}), ...(b.using !== undefined ? { presenceUsing: !!b.using } : {}), ...(b.class ? { nodeClass: b.class as NodeClass } : {}) });
    event("info", "presence", `owner set ${Object.entries(b).map(([k, v]) => `${k} ${v}`).join(", ")}`);
    await tick(true);
    return presence();
  });
  // A session helper's report (Windows: the service itself cannot see the person at the machine).
  api.post("/presence/signals", async (req) => {
    const b = (req.body ?? {}) as Partial<Signals>;
    const num = (x: unknown) => (typeof x === "number" && Number.isFinite(x) ? x : null);
    helper = {
      idleS: num(b.idleS), onBattery: typeof b.onBattery === "boolean" ? b.onBattery : null, batteryPct: num(b.batteryPct),
      thermal: ["nominal", "fair", "serious", "critical"].includes(String(b.thermal)) ? (b.thermal as Signals["thermal"]) : null,
      pressure: num(b.pressure) ?? 1, fullscreen: !!b.fullscreen, call: !!b.call, game: !!b.game, source: "helper", ts: Date.now(),
    };
    if (process.platform !== "darwin") await tick();
    return presence();
  });
}

/** For the router's reasons: whether a model's own runtime would refuse it here now. */
export const restingReason = (modelId: string, loaded: boolean): string | null => {
  const s = tracker.state;
  if (s === "away" || s === "busy") return `this machine is ${s}`;
  if (s === "polite" && !loaded) return `this machine is polite: only loaded models, and ${modelId} is not`;
  return null;
};
