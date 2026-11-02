import { AsyncLocalStorage } from "node:async_hooks";
import { db, json, now } from "./db.js";

/**
 * mux's journal of its own changes: whatever mux decides to change about itself — a route, a model, a setting, a page
 * in its brain, an experiment, a download — is written here with what it was before and after, and shown to the owner
 * (Home, the Journal page, the menu bar). The owner asked to see it; nothing mux does to itself is silent.
 *
 * Who is acting is carried through the work as an actor (asActor): the autopilot, an experiment, the doctor, the brain
 * keeper, the assistant once the owner approved its change. A change made with no actor is the owner's own, from the
 * dashboard, and is not journaled.
 */
db.exec(`
CREATE TABLE IF NOT EXISTS journal (
  id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, actor TEXT NOT NULL, kind TEXT NOT NULL,
  title TEXT NOT NULL, detail TEXT, before TEXT, after TEXT, ref TEXT
);
CREATE INDEX IF NOT EXISTS journal_ts ON journal(ts);
`);

export type Actor = "autopilot" | "experiments" | "doctor" | "healer" | "brain-keeper" | "assistant" | "lens";
const current = new AsyncLocalStorage<Actor>();

/** Do `fn` as `who`: what it changes about mux is journaled under that name. */
export const asActor = <T>(who: Actor, fn: () => T): T => current.run(who, fn);
export const actor = (): Actor | undefined => current.getStore();

export interface Entry { id: number; ts: number; actor: string; kind: string; title: string; detail: string | null; before: unknown; after: unknown; ref: string | null }

/** Write an entry, if mux itself is acting (or `who` says it is). */
export function journal(e: { kind: string; title: string; detail?: string; before?: unknown; after?: unknown; ref?: string; who?: Actor }) {
  const who = e.who ?? actor();
  if (!who) return;
  db.prepare("INSERT INTO journal(ts, actor, kind, title, detail, before, after, ref) VALUES(?, ?, ?, ?, ?, ?, ?, ?)")
    .run(now(), who, e.kind, e.title.slice(0, 300), e.detail?.slice(0, 4000) ?? null, e.before === undefined ? null : JSON.stringify(e.before), e.after === undefined ? null : JSON.stringify(e.after), e.ref ?? null);
}

export function entries(o: { limit?: number; since?: number; actor?: string; kind?: string } = {}): Entry[] {
  const where: string[] = []; const args: unknown[] = [];
  if (o.since) { where.push("ts > ?"); args.push(o.since); }
  if (o.actor) { where.push("actor = ?"); args.push(o.actor); }
  if (o.kind) { where.push("kind = ?"); args.push(o.kind); }
  return (db.prepare(`SELECT * FROM journal ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY ts DESC LIMIT ?`).all(...args, Math.min(o.limit ?? 100, 500)) as (Omit<Entry, "before" | "after"> & { before: string | null; after: string | null })[])
    .map((r) => ({ ...r, before: json(r.before, null), after: json(r.after, null) }));
}
