/**
 * Live health per model, in memory: failures in a sliding window put a model in cooldown (LiteLLM's allowed_fails /
 * cooldown_time), and moving averages of latency and speed feed the "fastest" strategy.
 */
const FAIL_WINDOW_MS = 60_000;
const FAILS_ALLOWED = 3;
const COOLDOWN_MS = 30_000;

interface Health { fails: number[]; cooldownUntil: number; ttftMs: number | null; tps: number | null; ok: number; err: number }
const health = new Map<string, Health>();
const get = (id: string) => {
  let h = health.get(id);
  if (!h) health.set(id, (h = { fails: [], cooldownUntil: 0, ttftMs: null, tps: null, ok: 0, err: 0 }));
  return h;
};
const ewma = (prev: number | null, x: number, a = 0.2) => (prev === null ? x : prev * (1 - a) + x * a);

export function recordSuccess(id: string, ttftMs: number | null, tps: number | null) {
  const h = get(id);
  h.ok++;
  if (ttftMs !== null && ttftMs >= 0) h.ttftMs = ewma(h.ttftMs, ttftMs);
  if (tps !== null && tps > 0 && Number.isFinite(tps)) h.tps = ewma(h.tps, tps);
}

/** A failure that is the model's (5xx, unreachable, load failed), not the caller's. */
export function recordFailure(id: string) {
  const h = get(id);
  const t = Date.now();
  h.err++;
  h.fails = h.fails.filter((x) => x > t - FAIL_WINDOW_MS);
  h.fails.push(t);
  if (h.fails.length >= FAILS_ALLOWED) { h.cooldownUntil = t + COOLDOWN_MS; h.fails = []; }
}

export const inCooldown = (id: string) => get(id).cooldownUntil > Date.now();
export const measuredTps = (id: string) => get(id).tps;
export const snapshot = () => Object.fromEntries([...health].map(([id, h]) => [id, { ...h, cooldown: h.cooldownUntil > Date.now() }]));
