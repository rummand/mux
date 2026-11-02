import { forceCenter, forceCollide, forceLink, forceManyBody, forceSimulation, forceX, forceY, type Simulation, type SimulationLinkDatum, type SimulationNodeDatum } from "d3-force";
import { useEffect, useMemo, useRef, useState } from "react";

/**
 * mux's brain, drawn in mux's own colours (after the memory viewers out there: Obsidian's graph view, AutoMem,
 * PiSovereign, Nowledge Mem): memory as light in shades of mux's accent, mux's body as the graphite skeleton under it,
 * curved connections with comets running along them, memories fading as they age, the owner's words in warm white,
 * ripples where mux changed something in the last day, and a hovered node lighting its neighbourhood. A timeline replays how
 * the brain grew. Click a page to open it.
 */
export interface GNode { id: string; type: string; label: string; kind?: string; ts?: number; weight?: number; owner?: boolean; text?: string }
export interface GEdge { source: string; target: string; type: string }
type N = GNode & SimulationNodeDatum & { r: number; color: string; degree: number };
type L = SimulationLinkDatum<N> & { type: string; phase: number };

/**
 * mux's own palette, read from its interface (index.css): the graphite ground, the one accent blue, warm white, and red
 * only for trouble. Memory is light — shades of the accent; mux's body (models, routes, tenants, machines) is the
 * graphite skeleton it lives on.
 */
interface Palette { bg: string; surface: string; line: string; ink: string; ink2: string; muted: string; accent: string; bad: string; dark: boolean }
/** Always mux's dark console tokens (index.css's own default): a brain made of light needs a dark ground, in either theme. */
function palette(): Palette {
  return { bg: "#0f0f0e", surface: "#1a1a19", line: "#46463f", ink: "#f0efec", ink2: "#c3c2b7", muted: "#8c8b83", accent: "#3987e5", bad: "#d03b3b", dark: true };
}
/** A shade of a hex colour: t > 0 towards white, t < 0 towards black. */
function shade(hex: string, t: number) {
  const n = parseInt(hex.slice(1), 16), r = n >> 16, g = (n >> 8) & 255, b = n & 255;
  const f = (c: number) => Math.round(t >= 0 ? c + (255 - c) * t : c * (1 + t));
  return `#${[f(r), f(g), f(b)].map((x) => x.toString(16).padStart(2, "0")).join("")}`;
}
const KINDS = ["decision", "runbook", "preference", "note", "incident"] as const;
function colorOf(n: GNode, p: Palette): string {
  if (n.owner) return p.ink;
  if (n.type === "page") return n.kind === "incident" ? p.bad : shade(p.accent, { decision: 0, runbook: 0.35, preference: 0.6, fact: -0.1, note: 0.15 }[n.kind ?? "note"] ?? 0.15);
  if (n.type === "fact") return shade(p.accent, 0.5);
  return p.muted; // mux's body
}
const memory = (n: GNode) => n.type === "page" || n.type === "fact";
const alpha = (hex: string, a: number) => `${hex}${Math.round(Math.max(0, Math.min(1, a)) * 255).toString(16).padStart(2, "0")}`;
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
  const pal = useRef<Palette>(palette());
  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: light)");
    const update = () => { pal.current = palette(); for (const n of data.current.nodes) n.color = colorOf(n, pal.current); };
    mq.addEventListener("change", update);
    return () => mq.removeEventListener("change", update);
  }, []);

  // Build the simulation when the graph changes (positions of nodes that stay are kept).
  useEffect(() => {
    const prev = new Map(data.current.nodes.map((n) => [n.id, n]));
    const degree = new Map<string, number>();
    for (const e of edges) { degree.set(e.source, (degree.get(e.source) ?? 0) + 1); degree.set(e.target, (degree.get(e.target) ?? 0) + 1); }
    const ns: N[] = nodes.map((n) => {
      const d = degree.get(n.id) ?? 0;
      const base = n.type === "page" ? 7 : n.type === "fact" ? 4.5 : n.type === "tag" ? 3 : 5;
      return { ...prev.get(n.id), ...n, degree: d, r: base + Math.sqrt(d) * 1.6 + Math.min(6, Math.sqrt(n.weight ?? 0) * 2), color: colorOf(n, pal.current) } as N;
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
      const p = pal.current;
      const w = wrap.current!.clientWidth, h = height, dpr = window.devicePixelRatio || 1;
      if (c.width !== w * dpr) { c.width = w * dpr; c.height = h * dpr; c.style.width = `${w}px`; c.style.height = `${h}px`; }
      const v = view.current;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      // The ground: mux's background, a soft accent glow, and the console's dot grid drifting slowly.
      ctx.fillStyle = p.bg; ctx.fillRect(0, 0, w, h);
      const glow = ctx.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, Math.max(w, h) * 0.6);
      glow.addColorStop(0, alpha(p.accent, p.dark ? 0.10 : 0.07)); glow.addColorStop(1, alpha(p.accent, 0));
      ctx.fillStyle = glow; ctx.fillRect(0, 0, w, h);
      const grid = 26 * v.k, ox = ((v.x + t * 0.004) % grid + grid) % grid, oy = ((v.y + t * 0.002) % grid + grid) % grid;
      ctx.fillStyle = alpha(p.muted, p.dark ? 0.18 : 0.22);
      for (let x = ox; x < w; x += grid) for (let y = oy; y < h; y += grid) ctx.fillRect(x, y, 1, 1);
      ctx.translate(w / 2 + v.x, h / 2 + v.y); ctx.scale(v.k, v.k);
      const cutoff = until ?? Infinity;
      const visible = (n: N) => !n.ts || n.ts <= cutoff;
      const now = Date.now();
      const age = (n: N) => (n.ts ? Math.min(1, (now - n.ts) / (30 * DAY)) : 0.3);
      // Focus: hovering a node lights its neighbourhood; the rest steps back.
      const near = new Set<string>();
      if (hover) { near.add(hover.id); for (const l of data.current.links) { const a = l.source as N, b = l.target as N; if (a.id === hover.id) near.add(b.id); if (b.id === hover.id) near.add(a.id); } }
      const dim = (n: N) => (hover && !near.has(n.id) ? 0.12 : 1);
      ctx.globalCompositeOperation = p.dark ? "lighter" : "source-over";
      // Connections: gentle curves, fading at their ends; a comet runs along each.
      for (const l of data.current.links) {
        const a = l.source as N, b = l.target as N;
        if (a.x == null || b.x == null || !visible(a) || !visible(b)) continue;
        const f = Math.min(dim(a), dim(b));
        const mx = (a.x + b.x) / 2, my = (a.y! + b.y!) / 2, dx = b.x - a.x, dy = b.y! - a.y!;
        const cx = mx - dy * 0.12, cy = my + dx * 0.12;
        const col = memory(a) ? a.color : memory(b) ? b.color : p.muted;
        const grad = ctx.createLinearGradient(a.x, a.y!, b.x, b.y!);
        grad.addColorStop(0, alpha(col, 0.04 * f)); grad.addColorStop(0.5, alpha(col, (l.type === "route" ? 0.18 : 0.32) * f)); grad.addColorStop(1, alpha(col, 0.04 * f));
        ctx.strokeStyle = grad; ctx.lineWidth = l.type === "about" || l.type === "fact" ? 1.1 : 0.7;
        ctx.beginPath(); ctx.moveTo(a.x, a.y!); ctx.quadraticCurveTo(cx, cy, b.x, b.y!); ctx.stroke();
        if (l.type === "route") continue;
        const q = (t / 3200 + l.phase) % 1;
        for (let k = 0; k < 6; k++) { // the comet and its tail
          const u = q - k * 0.018;
          if (u < 0) break;
          const x = (1 - u) * (1 - u) * a.x + 2 * (1 - u) * u * cx + u * u * b.x, y = (1 - u) * (1 - u) * a.y! + 2 * (1 - u) * u * cy + u * u * b.y!;
          ctx.fillStyle = alpha(p.accent, (0.85 - k * 0.14) * f); ctx.beginPath(); ctx.arc(x, y, 1.5 - k * 0.18, 0, Math.PI * 2); ctx.fill();
        }
      }
      // Nodes. Memory: a halo of light and a bright core. mux's body: a hollow graphite ring.
      for (const n of data.current.nodes) {
        if (n.x == null || !visible(n)) continue;
        const f = dim(n), fade = (1 - age(n) * 0.5) * f;
        if (memory(n)) {
          const halo = ctx.createRadialGradient(n.x, n.y!, 0, n.x, n.y!, n.r * 3);
          halo.addColorStop(0, alpha(n.color, 0.38 * fade)); halo.addColorStop(1, alpha(n.color, 0));
          ctx.fillStyle = halo; ctx.beginPath(); ctx.arc(n.x, n.y!, n.r * 3, 0, Math.PI * 2); ctx.fill();
          ctx.fillStyle = alpha(n.color, 0.95 * fade); ctx.beginPath(); ctx.arc(n.x, n.y!, n.r * (n.type === "page" ? 0.5 : 0.38), 0, Math.PI * 2); ctx.fill();
          if (n.owner) { ctx.strokeStyle = alpha(p.accent, 0.9 * f); ctx.lineWidth = 1.6; ctx.beginPath(); ctx.arc(n.x, n.y!, n.r * 0.85, 0, Math.PI * 2); ctx.stroke(); }
        } else {
          ctx.strokeStyle = alpha(p.muted, (n.type === "tag" ? 0.35 : 0.6) * f); ctx.lineWidth = 1;
          ctx.beginPath(); ctx.arc(n.x, n.y!, n.r * 0.45, 0, Math.PI * 2); ctx.stroke();
        }
        // What mux changed in the last day: ripples spreading from it.
        if (changed.has(n.id)) for (let k = 0; k < 2; k++) {
          const ph = ((t / 1800) + k * 0.5) % 1;
          ctx.strokeStyle = alpha(p.accent, (1 - ph) * 0.7 * f); ctx.lineWidth = 1.2;
          ctx.beginPath(); ctx.arc(n.x, n.y!, n.r * (0.7 + ph * 2.6), 0, Math.PI * 2); ctx.stroke();
        }
      }
      ctx.globalCompositeOperation = "source-over";
      // Labels: mux's secondary ink, for pages and the busiest things; the hovered one in full.
      ctx.textAlign = "center";
      for (const n of data.current.nodes) {
        if (n.x == null || !visible(n)) continue;
        if (!(n.type === "page" || n.degree >= 3 || n === hover || (hover && near.has(n.id)))) continue;
        ctx.font = `${n === hover ? 600 : 400} ${n.type === "page" ? 11 : 10}px ui-sans-serif, system-ui`;
        ctx.fillStyle = alpha(n === hover ? p.ink : n.type === "page" ? p.ink2 : p.muted, (n === hover ? 1 : 0.8) * dim(n));
        const label = n === hover ? n.label : n.label.length > 38 ? `${n.label.slice(0, 36)}…` : n.label;
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
    <div ref={wrap} className="relative overflow-hidden rounded-lg border border-[#33332f]" style={{ height }}>
      <canvas ref={canvas} className="block cursor-grab" />
      {hover && (
        <div className="pointer-events-none absolute left-3 top-3 max-w-sm rounded-md border border-[#33332f] bg-[#1a1a19]/90 px-3 py-2 text-[12px] text-[#f0efec] backdrop-blur">
          <div className="font-medium">{hover.label}</div>
          <div className="text-[11px] text-[#8c8b83]">{hover.type}{hover.kind ? ` · ${hover.kind}` : ""}{hover.owner ? " · the owner's words" : ""} · {hover.degree} connection{hover.degree === 1 ? "" : "s"}{hover.ts ? ` · ${new Date(hover.ts).toISOString().slice(0, 10)}` : ""}</div>
          {hover.text && <div className="mt-1 text-[11.5px] text-[#c3c2b7]">{hover.text}</div>}
        </div>
      )}
      <div className="absolute right-3 top-3 space-y-1 rounded-md border border-[#33332f] bg-[#1a1a19]/85 px-2.5 py-2 text-[10.5px] text-[#c3c2b7] backdrop-blur">
        {KINDS.map((k) => { const c = colorOf({ id: "", type: "page", label: "", kind: k }, pal.current); return <div key={k} className="flex items-center gap-1.5"><span className="h-2 w-2 rounded-full" style={{ background: c, boxShadow: `0 0 6px ${c}` }} />{k}</div>; })}
        <div className="flex items-center gap-1.5"><span className="h-2 w-2 rounded-full" style={{ background: shade(pal.current.accent, 0.5) }} />fact</div>
        <div className="flex items-center gap-1.5"><span className="h-2 w-2 rounded-full border-[1.5px]" style={{ background: pal.current.ink, borderColor: pal.current.accent }} />your own words</div>
        <div className="flex items-center gap-1.5"><span className="h-2 w-2 rounded-full border" style={{ borderColor: pal.current.muted }} />mux itself: models, routes, tenants, machines</div>
      </div>
      {first && last && first < last && (
        <div className="absolute inset-x-3 bottom-3 flex items-center gap-3 rounded-md border border-[#33332f] bg-[#1a1a19]/85 px-3 py-1.5 text-[11px] text-[#c3c2b7] backdrop-blur">
          <span>Timeline</span>
          <input type="range" min={first} max={last} step={60_000} value={until ?? last} onChange={(e) => setUntil(Number(e.target.value) >= last ? null : Number(e.target.value))} className="flex-1 accent-[var(--accent)]" />
          <span className="w-36 text-right font-mono">{until ? new Date(until).toISOString().slice(0, 16).replace("T", " ") : "now"}</span>
        </div>
      )}
    </div>
  );
}
