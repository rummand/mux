import { createHash } from "node:crypto";

/**
 * Affinity: one agent run, one model. Every model call of an agent loop shares a key, and the router keeps the run on
 * the model it chose first — so the agent does not change behaviour halfway through, llama.cpp's prompt cache for the
 * run stays warm, and an experiment's arms are measured on whole runs, not a mix (the owner, 2026-11-04, after
 * Plano's model affinity).
 *
 * The key: the caller's own (x-mux-affinity), else its trace (x-mux-trace-id), else the conversation itself — the
 * tenant, the first system message and the first user message, which every call of an agent loop repeats.
 */
const TTL = 30 * 60_000;
const MAX = 20_000;
const chosen = new Map<string, { model: string; at: number }>();

const textOf = (c: unknown): string =>
  typeof c === "string" ? c : Array.isArray(c) ? c.map((p) => (typeof p === "string" ? p : (p as { text?: string })?.text ?? "")).join(" ") : "";

export function affinityKey(tenant: string, explicit: string | null | undefined, messages?: { role: string; content?: unknown }[]): string | null {
  if (explicit) return `${tenant}:k:${explicit}`;
  const sys = messages?.find((m) => m.role === "system" || m.role === "developer");
  const user = messages?.find((m) => m.role === "user");
  if (!user) return null;
  return `${tenant}:c:${createHash("sha256").update(textOf(sys?.content)).update("\u0000").update(textOf(user.content)).digest("hex").slice(0, 24)}`;
}

/** A number in [0, 1) fixed by the key and the experiment: the same run always lands in the same arm. */
export function unit(key: string, salt: string): number {
  return createHash("sha256").update(`${salt}\u0000${key}`).digest().readUInt32BE(0) / 2 ** 32;
}

/** The model this key's run is on, if it is still within the 30 minutes since its last call. */
export function stuck(key: string, route: string): string | null {
  const e = chosen.get(`${route}|${key}`);
  if (!e || Date.now() - e.at > TTL) return null;
  return e.model;
}

export function stick(key: string, route: string, model: string) {
  chosen.set(`${route}|${key}`, { model, at: Date.now() });
  if (chosen.size > MAX) {
    const cut = Date.now() - TTL;
    for (const [k, v] of chosen) if (v.at < cut) chosen.delete(k);
    // still too many: forget the oldest
    if (chosen.size > MAX) for (const k of [...chosen.keys()].slice(0, chosen.size - MAX)) chosen.delete(k);
  }
}

export const affinitySize = () => chosen.size;
