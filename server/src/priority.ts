import { EventEmitter } from "node:events";
import { settings } from "./db.js";

/**
 * Priority classes (owner, 27 November 2026: "give Bloom's live answers priority"):
 *
 *   interactive  a person is waiting: Bloom's chat bar, Ask Bloom, Talk (voice), Record's live notes and dictation
 *   normal       everything else
 *   background   nobody is waiting: CI, batch writers and indexers, Record's summaries, embedding sweeps
 *
 * A caller says so with `x-mux-priority`; otherwise the first of settings.priorityRules that matches decides. The class
 * is used by runtime/slots.ts (who gets a model's next slot), recorded in turn stats (speed.ts), and passed on to a node.
 */
export type Priority = "interactive" | "normal" | "background";
export const PRIORITIES: Priority[] = ["interactive", "normal", "background"];
export const RANK: Record<Priority, number> = { interactive: 0, normal: 1, background: 2 };

export function parsePriority(v: unknown): Priority | null {
  const s = typeof v === "string" ? v.trim().toLowerCase() : "";
  if (s === "interactive" || s === "live" || s === "high") return "interactive";
  if (s === "normal" || s === "default") return "normal";
  if (s === "background" || s === "batch" || s === "low") return "background";
  return null;
}

export interface Rule { tenant?: string; endpoint?: string; agent?: string; tag?: string; model?: string; priority: Priority }
export interface Who { header?: string | null; tenant: string; endpoint: string; agent?: string | null; tags?: string[]; model?: string | null }

const whole = (re: string, v: string | null | undefined) => {
  if (v == null) return false;
  try { return new RegExp(`^(?:${re})$`, "i").test(v); } catch { return false; }
};

/** The class of one request: the caller's header, else the first rule that matches, else normal. */
export function classify(w: Who, rules: Rule[] = settings().priorityRules as Rule[]): { priority: Priority; why: string } {
  const said = parsePriority(w.header);
  if (said) return { priority: said, why: "x-mux-priority" };
  for (const [i, r] of rules.entries()) {
    if (r.tenant && !whole(r.tenant, w.tenant)) continue;
    if (r.endpoint && !whole(r.endpoint, w.endpoint)) continue;
    if (r.agent && !whole(r.agent, w.agent)) continue;
    if (r.model && !whole(r.model, w.model)) continue;
    if (r.tag && !(w.tags ?? []).some((t) => whole(r.tag!, t))) continue;
    const p = parsePriority(r.priority);
    if (p) return { priority: p, why: `rule ${i + 1}` };
  }
  return { priority: "normal", why: "default" };
}

/**
 * `x-mux-stage`: the caller's own stages before it called mux (Bloom's prompt build), so its time and mux's join.
 * Takes Server-Timing (`prompt_build;dur=120, retrieval;dur=40`), pairs (`prompt_build=120;retrieval=40`) or JSON.
 */
export function parseStages(v: unknown): Record<string, number> | null {
  if (typeof v !== "string" || !v.trim()) return null;
  const out: Record<string, number> = {};
  const put = (k: string, n: unknown) => {
    const key = k.trim().toLowerCase().replace(/[^a-z0-9_.-]/g, "_").slice(0, 40);
    const num = Number(n);
    if (key && Number.isFinite(num) && num >= 0 && Object.keys(out).length < 12) out[key] = Math.round(num * 10) / 10;
  };
  const s = v.trim().slice(0, 1000);
  if (s.startsWith("{")) {
    try { for (const [k, n] of Object.entries(JSON.parse(s) as Record<string, unknown>)) put(k, n); } catch { return null; }
  } else {
    for (const part of s.split(",")) {
      const p = part.trim();
      const dur = /^([^;=]+);(?:.*;)?\s*dur=([\d.]+)/.exec(p);
      if (dur) { put(dur[1], dur[2]); continue; }
      for (const kv of p.split(";")) { const m = /^\s*([^=]+)=\s*([\d.]+)\s*$/.exec(kv); if (m) put(m[1], m[2]); }
    }
  }
  return Object.keys(out).length ? out : null;
}

/* ── What else is going on: read by the slot gate, the build keeper and turn stats ─────────────────────────── */

/** "voice" (open count changed), so the build keeper can pause CI at once rather than within 15 s. */
export const contention = new EventEmitter();
let voice = 0;
export const voiceOpened = () => { voice++; contention.emit("voice", voice); };
export const voiceClosed = () => { voice = Math.max(0, voice - 1); contention.emit("voice", voice); };
export const voiceOpen = () => voice;

/** What the build keeper last saw (it runs on the Mac only): Record busy, CI steps paused for live work. */
let keeper: { recordBusy: boolean; ciPaused: number; ciRunning: number | null } = { recordBusy: false, ciPaused: 0, ciRunning: null };
export const setKeeperState = (s: Partial<typeof keeper>) => { keeper = { ...keeper, ...s }; };
export const keeperSeen = () => keeper;

/**
 * Whether CI steps on this Mac should be paused now: Record's live work (the original "Record first"), or a person in a
 * voice session (a turn's latency is what they hear). Pure, so it is tested without a Mac.
 */
export function shouldPauseCi(s: { recordBusy: boolean; voiceSessions: number; pauseForVoice: boolean }): { pause: boolean; why: string } {
  if (s.voiceSessions > 0 && s.pauseForVoice) return { pause: true, why: `${s.voiceSessions} voice session(s) open` };
  if (s.recordBusy) return { pause: true, why: "Record's live work" };
  return { pause: false, why: "" };
}
