import { forceCenter, forceCollide, forceLink, forceManyBody, forceSimulation, forceX, forceY, type Simulation, type SimulationLinkDatum, type SimulationNodeDatum } from "d3-force";
import { useEffect, useMemo, useRef, useState } from "react";

/**
 * mux's brain, drawn: a force-directed graph on a dark field, after the memory viewers out there (Obsidian's graph
 * view, AutoMem, PiSovereign, Nowledge Mem) — pages and facts glow in their kind's colour, mux's own body (models,
 * routes, tenants, machines) sits among them in quieter tones, edges carry travelling sparks like signals, memories fade
 * as they age, the owner's own pages wear a ring, and what mux changed in the last day pulses. A timeline replays how
 * the brain grew. Click a page to open it.
 */
export interface GNode { id: string; type: string; label: string; kind?: string; ts?: number; weight?: number; owner?: boolean; text?: string }
export interface GEdge { source: string; target: string; type: string }
type N = GNode & SimulationNodeDatum & { r: number; color: string; degree: number };
type L = SimulationLinkDatum<N> & { type: string; phase: number };

const KIND: Record<string, string> = { decision: "#a78bfa", runbook: "#f59e0b", preference: "#f472b6", fact: "#34d399", incident: "#f87171", note: "#60a5fa" };
const TYPE: Record<string, string> = { fact: "#2dd4bf", entity: "#e2e8f0", model: "#38bdf8", route: "#818cf8", tenant: "#fbbf24", node: "#22c55e", tag: "#94a3b8" };
const colorOf = (n: GNode) => (n.type === "page" ? KIND[n.kind ?? "note"] ?? "#60a5fa" : TYPE[n.type] ?? "#cbd5e1");
const DAY = 86400_000;

export default function BrainGraph({ nodes, edges, changed, onOpen, height = 620 }: { nodes: GNode[]; edges: GEdge[]; changed: Set<string>; onOpen: (n: GNode) => void; height?: number }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const wrap = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<N | null>(null);
  const times = useMemo(() => nodes.map((n) => n.ts).filter((t): t is number => !!t).sort((a, b) => a - b), [nodes]);
  const [until, setUntil] = useState<number | null>(null); // the timeline: the brain as it was then (null = now)
  const sim = useRef<Simulation<N, L> | null>(null);
  const data = useRef<{ nodes: N[]; links: L[] }>({ nodes: [], links: [] });
  const view = useRef({ x: 0, y: 0, k: 1 });

  // Build the simulation when the graph changes (positions of nodes that stay are kept).
  useEffect(() => {
    const prev = new Map(data.current.nodes.map((n) => [n.id, n]));
    const degree = new Map<string, number>();
    for (const e of edges) { degree.set(e.source, (degree.get(e.source) ?? 0) + 1); degree.set(e.target, (degree.get(e.target) ?? 0) + 1); }
    const ns: N[] = nodes.map((n) => {
      const d = degree.get(n.id) ?? 0;
      const base = n.type === "page" ? 7 : n.type === "fact" ? 4.5 : n.type === "tag" ? 3 : 5;
      return { ...prev.get(n.id), ...n, degree: d, r: base + Math.sqrt(d) * 1.6 + Math.min(6, Math.sqrt(n.weight ?? 0) * 2), color: colorOf(n) } as N;
    });
    const byId = new Map(ns.map((n) => [n.id, n]));
    const ls: L[] = edges.filter((e) => byId.has(e.source) && byId.has(e.target)).map((e) => ({ source: e.source, target: e.target, type: e.type, phase: Math.random() })) as unknown as L[];
    data.current = { nodes: ns, links: ls };
    sim.current?.stop();
    sim.current = forceSimulation(ns)
      .force("link", forceLink<N, L>(ls).id((d) => d.id).distance((l) => (l.type === "tag" ? 70 : l.type === "route" ? 55 : 90)).strength(0.35))
      .force("charge", forceManyBody<N>().strength((d) => (d.type === "page" ? -260 : -120)))
      .force("collide", forceCollide<N>().radius((d) => d.r + 6))
      .force("center", forceCenter(0, 0))
      .force("x", forceX(0).strength(0.03)).force("y", forceY(0).strength(0.03))
      .alphaDecay(0.02);
    return () => { sim.current?.stop(); };
  }, [nodes, edges]);

  // Draw, every frame: glow, fading with age, travelling sparks, pulses.
  useEffect(() => {
    const c = canvas.current!;
    const ctx = c.getContext("2d")!;
    let raf = 0;
    const draw = (t: number) => {
      const w = wrap.current!.clientWidth, h = height, dpr = window.devicePixelRatio || 1;
      if (c.width !== w * dpr) { c.width = w * dpr; c.height = h * dpr; c.style.width = `${w}px`; c.style.height = `${h}px`; }
      const v = view.current;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      // A deep field with a faint nebula.
      const g = ctx.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, Math.max(w, h) * 0.7);
      g.addColorStop(0, "#0d1024"); g.addColorStop(1, "#04050c");
      ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);
      ctx.translate(w / 2 + v.x, h / 2 + v.y); ctx.scale(v.k, v.k);
      const cutoff = until ?? Infinity;
      const visible = (n: N) => !n.ts || n.ts <= cutoff;
      const now = Date.now();
      const age = (n: N) => (n.ts ? Math.min(1, (now - n.ts) / (30 * DAY)) : 0.3); // 0 new … 1 a month old
      ctx.globalCompositeOperation = "lighter";
      // Edges, and the sparks running along them.
      for (const l of data.current.links) {
        const a = l.source as N, b = l.target as N;
        if (a.x == null || b.x == null || !visible(a) || !visible(b)) continue;
        ctx.strokeStyle = `${a.color}${l.type === "route" ? "22" : "33"}`;
        ctx.lineWidth = l.type === "about" || l.type === "fact" ? 1.2 : 0.7;
        ctx.beginPath(); ctx.moveTo(a.x, a.y!); ctx.lineTo(b.x, b.y!); ctx.stroke();
        const p = (t / 2600 + l.phase) % 1;
        const sx = a.x + (b.x - a.x) * p, sy = a.y! + (b.y! - a.y!) * p;
        ctx.fillStyle = `${a.color}cc`; ctx.beginPath(); ctx.arc(sx, sy, 1.4, 0, Math.PI * 2); ctx.fill();
      }
      // Nodes: a halo, a core; brighter when young, pulsing when changed in the last day.
      for (const n of data.current.nodes) {
        if (n.x == null || !visible(n)) continue;
        const fade = 1 - age(n) * 0.55;
        const pulse = changed.has(n.id) ? 1 + 0.35 * Math.sin(t / 260) : 1;
        const halo = ctx.createRadialGradient(n.x, n.y!, 0, n.x, n.y!, n.r * 3.2 * pulse);
        halo.addColorStop(0, `${n.color}${Math.round(110 * fade).toString(16).padStart(2, "0")}`); halo.addColorStop(1, `${n.color}00`);
        ctx.fillStyle = halo; ctx.beginPath(); ctx.arc(n.x, n.y!, n.r * 3.2 * pulse, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = `${n.color}${Math.round(235 * fade).toString(16).padStart(2, "0")}`;
        ctx.beginPath(); ctx.arc(n.x, n.y!, n.r * (n.type === "page" ? 0.55 : 0.45), 0, Math.PI * 2); ctx.fill();
        if (n.owner) { ctx.strokeStyle = "#fde68acc"; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.arc(n.x, n.y!, n.r * 0.95, 0, Math.PI * 2); ctx.stroke(); }
      }
      ctx.globalCompositeOperation = "source-over";
      // Labels for pages and the busiest things.
      ctx.font = "11px ui-sans-serif, system-ui"; ctx.textAlign = "center";
      for (const n of data.current.nodes) {
        if (n.x == null || !visible(n)) continue;
        if (!(n.type === "page" || n.degree >= 3 || n === hover)) continue;
        ctx.fillStyle = n === hover ? "#ffffff" : `rgba(226,232,240,${n.type === "page" ? 0.75 : 0.5})`;
        const label = n.label.length > 42 ? `${n.label.slice(0, 40)}…` : n.label;
        ctx.fillText(label, n.x, n.y! + n.r + 13);
      }
      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [height, until, changed, hover]);

  // Pan, zoom, hover, click, drag.
  useEffect(() => {
    const c = canvas.current!;
    let drag: { x: number; y: number; vx: number; vy: number; node: N | null } | null = null;
    const toWorld = (e: MouseEvent) => { const r = c.getBoundingClientRect(), v = view.current; return { x: (e.clientX - r.left - r.width / 2 - v.x) / v.k, y: (e.clientY - r.top - r.height / 2 - v.y) / v.k }; };
    const pick = (e: MouseEvent) => { const p = toWorld(e); return data.current.nodes.find((n) => n.x != null && Math.hypot(n.x - p.x, n.y! - p.y) < Math.max(n.r, 8)) ?? null; };
    const down = (e: MouseEvent) => { const node = pick(e); drag = { x: e.clientX, y: e.clientY, vx: view.current.x, vy: view.current.y, node }; if (node) { node.fx = node.x; node.fy = node.y; sim.current?.alphaTarget(0.2).restart(); } };
    const move = (e: MouseEvent) => {
      if (drag?.node) { const p = toWorld(e); drag.node.fx = p.x; drag.node.fy = p.y; return; }
      if (drag) { view.current.x = drag.vx + e.clientX - drag.x; view.current.y = drag.vy + e.clientY - drag.y; return; }
      setHover(pick(e));
    };
    const up = (e: MouseEvent) => {
      if (drag?.node) { const moved = Math.hypot(e.clientX - drag.x, e.clientY - drag.y) > 4; drag.node.fx = null; drag.node.fy = null; sim.current?.alphaTarget(0); if (!moved) onOpen(drag.node); }
      drag = null;
    };
    const wheel = (e: WheelEvent) => { e.preventDefault(); view.current.k = Math.min(4, Math.max(0.25, view.current.k * (e.deltaY < 0 ? 1.1 : 0.9))); };
    c.addEventListener("mousedown", down); window.addEventListener("mousemove", move); window.addEventListener("mouseup", up); c.addEventListener("wheel", wheel, { passive: false });
    return () => { c.removeEventListener("mousedown", down); window.removeEventListener("mousemove", move); window.removeEventListener("mouseup", up); c.removeEventListener("wheel", wheel); };
  }, [onOpen]);

  const first = times[0], last = times[times.length - 1];
  return (
    <div ref={wrap} className="relative overflow-hidden rounded-lg border border-line" style={{ height }}>
      <canvas ref={canvas} className="block cursor-grab" />
      {hover && (
        <div className="pointer-events-none absolute left-3 top-3 max-w-sm rounded-md bg-black/70 px-3 py-2 text-[12px] text-slate-100 backdrop-blur">
          <div className="font-medium">{hover.label}</div>
          <div className="text-[11px] text-slate-400">{hover.type}{hover.kind ? ` · ${hover.kind}` : ""}{hover.owner ? " · the owner's words" : ""} · {hover.degree} connection{hover.degree === 1 ? "" : "s"}{hover.ts ? ` · ${new Date(hover.ts).toISOString().slice(0, 10)}` : ""}</div>
          {hover.text && <div className="mt-1 text-[11.5px] text-slate-300">{hover.text}</div>}
        </div>
      )}
      <div className="absolute right-3 top-3 space-y-0.5 rounded-md bg-black/50 px-2.5 py-2 text-[10.5px] text-slate-300 backdrop-blur">
        {Object.entries(KIND).map(([k, c]) => <div key={k} className="flex items-center gap-1.5"><span className="h-2 w-2 rounded-full" style={{ background: c, boxShadow: `0 0 6px ${c}` }} />{k}</div>)}
        {(["fact", "model", "route", "tenant", "node", "entity"] as const).map((k) => <div key={k} className="flex items-center gap-1.5"><span className="h-2 w-2 rounded-full" style={{ background: TYPE[k] }} />{k === "node" ? "machine" : k}</div>)}
        <div className="flex items-center gap-1.5"><span className="h-2 w-2 rounded-full border border-amber-200" />the owner's words</div>
      </div>
      {first && last && first < last && (
        <div className="absolute inset-x-3 bottom-3 flex items-center gap-3 rounded-md bg-black/50 px-3 py-1.5 text-[11px] text-slate-300 backdrop-blur">
          <span>Timeline</span>
          <input type="range" min={first} max={last} step={60_000} value={until ?? last} onChange={(e) => setUntil(Number(e.target.value) >= last ? null : Number(e.target.value))} className="flex-1 accent-violet-400" />
          <span className="w-36 text-right font-mono">{until ? new Date(until).toISOString().slice(0, 16).replace("T", " ") : "now"}</span>
        </div>
      )}
    </div>
  );
}
