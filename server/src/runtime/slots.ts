import { RANK, type Priority } from "../priority.js";

/**
 * The slots of the models mux runs, handed out by priority (owner, 27 November 2026). llama-server queues requests over
 * its `--parallel` slots first come, first served, so a person's turn could wait behind a batch (one voice turn waited
 * 2.9 s for qwen3.6's first token on 27 November). mux now holds the queue itself, one entry per request, and gives a
 * model's next free slot to:
 *
 *   1. interactive, any free slot — on a model with 2+ slots, `reserve` of them are for interactive only;
 *   2. normal, a slot outside the reserve, when no interactive request is waiting for this model;
 *   3. background, as normal, and only while no interactive request is running on this model (it yields), unless it
 *      has waited `backgroundMaxWaitMs` (then it goes as normal, so it never starves).
 *
 * With priority off it is one first-come queue over all the slots (what llama-server did), still measured.
 */
export interface Grant { waitMs: number; reasons: string[]; concurrent: number; position: number }

interface Waiter {
  priority: Priority; at: number; seq: number; reasons: Set<string>;
  grant: (g: Grant) => void; fail: (e: Error) => void; done: boolean; position: number;
}
interface Pool { granted: Record<Priority, number>; waiting: Waiter[]; capacity: number; reserve: number }

export interface GateOptions {
  enabled: () => boolean;
  backgroundMaxWaitMs: () => number;
  timeoutMs: () => number;
  now?: () => number;
}

export class QueueTimeout extends Error { constructor(message: string) { super(message); this.name = "QueueTimeout"; } }

export class SlotGate {
  private pools = new Map<string, Pool>();
  private seq = 0;
  private timer: NodeJS.Timeout | null = null;
  private readonly now: () => number;
  constructor(private opts: GateOptions) { this.now = opts.now ?? (() => performance.now()); }

  private pool(id: string): Pool {
    let p = this.pools.get(id);
    if (!p) { p = { granted: { interactive: 0, normal: 0, background: 0 }, waiting: [], capacity: 1, reserve: 0 }; this.pools.set(id, p); }
    return p;
  }
  private used = (p: Pool) => p.granted.interactive + p.granted.normal + p.granted.background;

  /** Why `w` may not take a slot now, or null when it may. */
  private blocked(p: Pool, w: Waiter, interactiveWaiting: boolean): string | null {
    const used = this.used(p);
    if (used >= p.capacity) return "model busy";
    if (!this.opts.enabled()) return null;
    if (w.priority === "interactive") return null;
    if (used >= p.capacity - p.reserve) return "slot reserved for interactive";
    if (interactiveWaiting) return "interactive first";
    if (w.priority === "background" && p.granted.interactive > 0 && this.now() - w.at < this.opts.backgroundMaxWaitMs()) return "yielding to interactive";
    return null;
  }

  private pump(id: string) {
    const p = this.pool(id);
    const order = this.opts.enabled()
      ? [...p.waiting].sort((a, b) => RANK[a.priority] - RANK[b.priority] || a.seq - b.seq)
      : [...p.waiting].sort((a, b) => a.seq - b.seq);
    for (const w of order) {
      const interactiveWaiting = p.waiting.some((x) => x !== w && x.priority === "interactive");
      const why = this.blocked(p, w, interactiveWaiting);
      if (why) { w.reasons.add(why); continue; }
      p.waiting.splice(p.waiting.indexOf(w), 1);
      const concurrent = this.used(p);
      p.granted[w.priority]++;
      w.done = true;
      w.grant({ waitMs: this.now() - w.at, reasons: [...w.reasons], concurrent, position: w.position });
    }
    this.tick();
  }

  /** A background waiter that ages past its yield is let in by a timer, not only when a slot frees. */
  private tick() {
    const any = [...this.pools.values()].some((p) => p.waiting.some((w) => w.priority === "background"));
    if (any && !this.timer) this.timer = setTimeout(() => { this.timer = null; for (const id of this.pools.keys()) this.pump(id); }, 1000).unref?.() ?? null;
  }

  /**
   * Wait for a slot of `id` (capacity = its llama-server slots). Resolves with how long it waited and why; rejects when
   * the signal aborts or the queue timeout passes. Pair every resolved take with `give(id, priority)`.
   */
  take(id: string, capacity: number, reserve: number, priority: Priority, signal?: AbortSignal): Promise<Grant> {
    const p = this.pool(id);
    p.capacity = Math.max(1, capacity);
    p.reserve = Math.max(0, Math.min(reserve, p.capacity - 1));
    if (signal?.aborted) return Promise.reject(Object.assign(new Error("the caller went away while waiting for a slot"), { name: "AbortError" }));
    return new Promise<Grant>((resolve, reject) => {
      let to: NodeJS.Timeout | null = null;
      const onAbort = () => drop(Object.assign(new Error("the caller went away while waiting for a slot"), { name: "AbortError" }));
      const cleanup = () => { if (to) clearTimeout(to); signal?.removeEventListener("abort", onAbort); };
      const w: Waiter = {
        priority, at: this.now(), seq: ++this.seq, reasons: new Set(), done: false, position: p.waiting.length,
        grant: (g) => { cleanup(); resolve(g); }, fail: (e) => { cleanup(); reject(e); },
      };
      const drop = (e: Error) => {
        if (w.done) return;
        w.done = true;
        const i = p.waiting.indexOf(w);
        if (i >= 0) p.waiting.splice(i, 1);
        w.fail(e);
        this.pump(id); // someone behind it may go now
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      const ms = this.opts.timeoutMs();
      if (ms > 0) { to = setTimeout(() => drop(new QueueTimeout(`waited ${Math.round(ms / 1000)} s for a slot of ${id}`)), ms); to.unref?.(); }
      p.waiting.push(w);
      this.pump(id);
    });
  }

  /** A slot back. Never below zero: a stray give cannot open a slot that does not exist. */
  give(id: string, priority: Priority) {
    const p = this.pools.get(id);
    if (!p) return;
    if (p.granted[priority] > 0) p.granted[priority]--;
    else { const k = (["background", "normal", "interactive"] as Priority[]).find((x) => p.granted[x] > 0); if (k) p.granted[k]--; }
    this.pump(id);
  }

  /** Look at every queue again now (a background waiter may have aged into its turn). */
  poke() { for (const id of this.pools.keys()) this.pump(id); }

  /** Per model: slots, reserve, and running and waiting by class. */
  snapshot() {
    return Object.fromEntries([...this.pools.entries()].filter(([, p]) => this.used(p) || p.waiting.length).map(([id, p]) => [id, {
      capacity: p.capacity, reserve: this.opts.enabled() ? p.reserve : 0, running: { ...p.granted },
      waiting: { interactive: p.waiting.filter((w) => w.priority === "interactive").length, normal: p.waiting.filter((w) => w.priority === "normal").length, background: p.waiting.filter((w) => w.priority === "background").length },
      oldestWaitMs: p.waiting.length ? Math.round(this.now() - Math.min(...p.waiting.map((w) => w.at))) : 0,
    }]));
  }
  running(id: string) { const p = this.pools.get(id); return p ? { ...p.granted } : { interactive: 0, normal: 0, background: 0 }; }
  totals() {
    let running = 0, waiting = 0;
    for (const p of this.pools.values()) { running += this.used(p); waiting += p.waiting.length; }
    return { running, waiting };
  }
}
