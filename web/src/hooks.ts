import { useCallback, useEffect, useRef, useState } from "react";
import { api, getToken } from "./api";

/** GET an admin endpoint; `pollMs` refreshes it in the background. */
export function useApi<T>(path: string | null, query?: Record<string, string | number | boolean | undefined | null>, pollMs?: number, scope?: string | null) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const key = path ? path + JSON.stringify(query ?? {}) : null;
  const seq = useRef(0);
  const load = useCallback(async (quiet = false) => {
    if (!path) return;
    const n = ++seq.current;
    if (!quiet) setLoading(true);
    try {
      const d = await api<T>(path, { query, scope });
      if (n === seq.current) { setData(d); setError(null); }
    } catch (e) {
      if (n === seq.current) setError((e as Error).message);
    } finally {
      if (n === seq.current) setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    if (!pollMs) return;
    const t = setInterval(() => { if (!document.hidden) void load(true); }, pollMs);
    return () => clearInterval(t);
  }, [load, pollMs]);
  return { data, error, loading, reload: load, setData };
}

/* One EventSource for the whole app; pages subscribe to the event types they want. */
type Listener = (data: unknown) => void;
const listeners = new Map<string, Set<Listener>>();
let source: EventSource | null = null;
let connected = false;
const statusListeners = new Set<(c: boolean) => void>();
const setConnected = (c: boolean) => { connected = c; statusListeners.forEach((f) => f(c)); };

function ensureSource() {
  if (source || !getToken()) return;
  source = new EventSource(`/api/admin/live?token=${encodeURIComponent(getToken())}`);
  source.onopen = () => setConnected(true);
  source.onerror = () => {
    setConnected(false);
    source?.close();
    source = null;
    setTimeout(ensureSource, 3000);
  };
  for (const type of ["request", "download", "bench"]) {
    source.addEventListener(type, (ev) => {
      let d: unknown;
      try { d = JSON.parse((ev as MessageEvent).data); } catch { return; }
      listeners.get(type)?.forEach((f) => f(d));
    });
  }
}

export function useLive<T>(type: "request" | "download" | "bench", fn: (data: T) => void) {
  const ref = useRef(fn);
  ref.current = fn;
  useEffect(() => {
    ensureSource();
    const l: Listener = (d) => ref.current(d as T);
    if (!listeners.has(type)) listeners.set(type, new Set());
    listeners.get(type)!.add(l);
    return () => { listeners.get(type)!.delete(l); };
  }, [type]);
}

export function useLiveStatus() {
  const [c, setC] = useState(connected);
  useEffect(() => { ensureSource(); statusListeners.add(setC); return () => { statusListeners.delete(setC); }; }, []);
  return c;
}

/** State kept in localStorage; every component using the same key sees the same value (the assistant page and panel). */
const persisted = new Map<string, Set<(v: unknown) => void>>();
export function usePersisted<T>(key: string, initial: T): [T, (v: T) => void] {
  const [v, setV] = useState<T>(() => {
    try { const s = localStorage.getItem(`mux.${key}`); return s ? (JSON.parse(s) as T) : initial; } catch { return initial; }
  });
  useEffect(() => {
    const l = (x: unknown) => setV(x as T);
    if (!persisted.has(key)) persisted.set(key, new Set());
    persisted.get(key)!.add(l);
    return () => { persisted.get(key)!.delete(l); };
  }, [key]);
  const set = useCallback((x: T) => {
    persisted.get(key)?.forEach((f) => f(x));
    setV(x);
    try { localStorage.setItem(`mux.${key}`, JSON.stringify(x)); } catch { /* ignore */ }
  }, [key]);
  return [v, set];
}
