import { useEffect, useMemo, useRef, useState } from "react";
import type { SystemLive } from "../api";
import { fmtBytes, fmtDuration, fmtGb } from "../format";
import { useApi } from "../hooks";
import { Badge, Card, Segmented, Table, Td, Th } from "./ui";

/**
 * The machine, live, every 2 seconds (GET /system/live): each core's load and its last five minutes, the cores as a
 * heatmap over time, the GPU, memory as macOS splits it, network and disk, and the processes using the most — with
 * mux's own model servers named. Performance cores in mux's accent, efficiency cores in violet; anything near full in
 * amber.
 */
const P = "var(--accent)", E = "var(--series-7)", HOT = "var(--warning)";
const rate = (b: number) => `${fmtBytes(b)}/s`;

/** A filled trend with no axes: values 0..max, newest on the right. */
function Spark({ values, max = 100, color = P, height = 26, fill = true }: { values: number[]; max?: number; color?: string; height?: number; fill?: boolean }) {
  const n = values.length;
  if (n < 2) return <div style={{ height }} />;
  const m = Math.max(max, ...values) || 1;
  const pts = values.map((v, i) => `${(i / (n - 1)) * 100},${height - (v / m) * (height - 1)}`);
  return (
    <svg viewBox={`0 0 100 ${height}`} preserveAspectRatio="none" className="block w-full" style={{ height }}>
      {fill && <polygon points={`0,${height} ${pts.join(" ")} 100,${height}`} fill={color} opacity={0.18} />}
      <polyline points={pts.join(" ")} fill="none" stroke={color} strokeWidth={1.2} vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

function CoreTile({ id, kind, pct, trend }: { id: number; kind: "P" | "E" | null; pct: number; trend: number[] }) {
  const color = pct >= 85 ? HOT : kind === "E" ? E : P;
  return (
    <div className="rounded-md border border-line bg-s2/40 px-1.5 pb-1 pt-1" title={`core ${id} · ${kind === "E" ? "efficiency" : kind === "P" ? "performance" : "core"} · ${pct.toFixed(0)}%`}>
      <div className="flex items-baseline justify-between text-[10px] leading-none">
        <span className="text-ink-3 num">{id}</span>
        <span className="font-semibold num" style={{ color: pct >= 5 ? color : undefined }}>{pct.toFixed(0)}</span>
      </div>
      <Spark values={trend} color={color} height={22} />
      <div className="mt-0.5 h-[3px] overflow-hidden rounded-full bg-line"><div className="h-full rounded-full transition-[width] duration-700" style={{ width: `${pct}%`, background: color }} /></div>
    </div>
  );
}

/** Rows are cores, columns are the last five minutes; the stronger the colour, the busier the core. */
function CoreHeatmap({ history, kinds }: { history: SystemLive["history"]; kinds: ("P" | "E" | null)[] }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current;
    if (!c || !history.length) return;
    const css = getComputedStyle(document.documentElement);
    const col = (v: string) => css.getPropertyValue(v).trim() || "#3987e5";
    const [p, e, hot] = [col("--accent"), col("--series-7"), col("--warning")];
    const rows = kinds.length, cols = 150;
    const w = c.clientWidth, h = rows * 7;
    const dpr = window.devicePixelRatio || 1;
    c.width = w * dpr; c.height = h * dpr; c.style.height = `${h}px`;
    const g = c.getContext("2d")!;
    g.scale(dpr, dpr);
    g.clearRect(0, 0, w, h);
    const cw = w / cols, rh = h / rows;
    const start = cols - history.length;
    history.forEach((pt, x) => pt.cores.forEach((v, y) => {
      if (v < 1) return;
      g.globalAlpha = Math.min(1, 0.12 + v / 100);
      g.fillStyle = v >= 85 ? hot : kinds[y] === "E" ? e : p;
      g.fillRect((start + x) * cw, y * rh, Math.ceil(cw), rh - 1);
    }));
    g.globalAlpha = 1;
  }, [history, kinds]);
  return <canvas ref={ref} className="block w-full" />;
}

function Tile({ label: l, value, sub, children }: { label: string; value: React.ReactNode; sub?: React.ReactNode; children?: React.ReactNode }) {
  return (
    <Card>
      <div className="text-[11px] uppercase tracking-wide text-ink-3">{l}</div>
      <div className="mt-1 text-lg font-semibold num">{value}</div>
      {sub && <div className="text-[11.5px] text-ink-3 num">{sub}</div>}
      {children && <div className="mt-2">{children}</div>}
    </Card>
  );
}

const MEM: { key: keyof NonNullable<SystemLive["memory"]>; label: string; color: string; hint: string }[] = [
  { key: "wired", label: "Wired", color: "var(--series-1)", hint: "kept in memory by macOS — models on the GPU live here" },
  { key: "apps", label: "Apps", color: "var(--series-3)", hint: "programs' own memory" },
  { key: "compressed", label: "Compressed", color: "var(--series-2)", hint: "squeezed by macOS instead of swapping" },
  { key: "cached", label: "Cached files", color: "var(--series-7)", hint: "files kept around; given back at once" },
  { key: "free", label: "Free", color: "var(--grid)", hint: "not used at all" },
];

export function SystemLivePanel({ models, machine }: { models: Record<number, string>; machine: string }) {
  const { data: l } = useApi<SystemLive>("/system/live", { machine }, 2_000);
  const [sort, setSort] = useState<"cpu" | "mem">("cpu");
  const kinds = useMemo(() => l?.cores.map((c) => c.kind) ?? [], [l?.cores.length, l?.cores[0]?.kind]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!l) return null;
  const h = l.history;
  const trend = (i: number) => h.map((p) => p.cores[i] ?? 0);
  const clusters = [...new Set(l.cores.map((c) => c.cluster))].map((k) => l.cores.filter((c) => c.cluster === k));
  const perf = l.cores.filter((c) => c.kind === "P"), eff = l.cores.filter((c) => c.kind === "E");
  const avg = (cs: typeof l.cores) => (cs.length ? cs.reduce((a, c) => a + c.pct, 0) / cs.length : 0);
  const busiest = [...l.cores].sort((a, b) => b.pct - a.pct)[0];
  const memTotal = l.memory ? Object.values(l.memory).reduce((a, b) => a + b, 0) : 0;
  const procs = [...l.processes].sort((a, b) => (sort === "cpu" ? b.cpu - a.cpu : b.rssGb - a.rssGb)).filter((p, i) => i < 14 || models[p.pid] || p.pid === l.pid);
  const cpuScale = Math.max(100, ...procs.map((p) => p.cpu));
  const gpuMax = Math.max(1, ...h.map((p) => p.gpu ?? 0));
  return (
    <>
      <div className="mb-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-6">
        <Tile label="CPU · all cores" value={`${l.cpu.toFixed(0)}%`} sub={perf.length ? `P ${avg(perf).toFixed(0)}% · E ${avg(eff).toFixed(0)}%` : `${l.cores.length} cores`}><Spark values={h.map((p) => p.cpu)} /></Tile>
        <Tile label="GPU" value={l.gpu ? `${l.gpu.pct}%` : "—"} sub={l.gpu ? `renderer ${l.gpu.renderer}% · tiler ${l.gpu.tiler}%` : "no GPU on this machine"}><Spark values={h.map((p) => p.gpu ?? 0)} color="var(--series-3)" /></Tile>
        <Tile label="GPU memory" value={l.gpu ? fmtGb(l.gpu.memGb) : "—"} sub={l.gpu ? "in use by Metal — model weights and caches" : "no GPU on this machine"} />
        <Tile label="Network" value={<span>↓ {rate(l.net.in)}</span>} sub={`↑ ${rate(l.net.out)}`}><Spark values={h.map((p) => p.netIn + p.netOut)} max={1} color="var(--series-4)" /></Tile>
        <Tile label="Disk" value={<span>R {rate(l.disk.read)}</span>} sub={`W ${rate(l.disk.write)}`}><Spark values={h.map((p) => p.diskR + p.diskW)} max={1} color="var(--series-5)" /></Tile>
        <Tile label="Load · thermal" value={l.load.map((x) => x.toFixed(1)).join(" · ")} sub={`1 · 5 · 15 min · ${l.thermal ?? "—"} · machine up ${fmtDuration(l.uptimeS)}`} />
      </div>

      <Card className="mb-4" title="Cores" subtitle={`${l.cores.length} cores${perf.length ? ` · ${perf.length} performance · ${eff.length} efficiency` : ""} · busiest core ${busiest?.id} at ${busiest?.pct.toFixed(0)}% · every 2 s, last 5 minutes`}
        actions={perf.length ? <div className="flex gap-3 text-[11.5px] text-ink-3"><span><i className="mr-1 inline-block h-2 w-2 rounded-full" style={{ background: P }} />performance</span><span><i className="mr-1 inline-block h-2 w-2 rounded-full" style={{ background: E }} />efficiency</span><span><i className="mr-1 inline-block h-2 w-2 rounded-full" style={{ background: HOT }} />≥ 85%</span></div> : undefined}>
        <div className="flex flex-wrap gap-4">
          {clusters.map((cs) => (
            <div key={cs[0].cluster} className="min-w-0">
              <div className="mb-1 text-[10.5px] uppercase tracking-wide text-ink-3">{cs[0].kind ? `${cs[0].kind === "E" ? "Efficiency" : "Performance"} · ${avg(cs).toFixed(0)}%` : "Cores"}</div>
              <div className="grid gap-1" style={{ gridTemplateColumns: `repeat(${cs[0].kind ? cs.length : Math.min(cs.length, 14)}, 52px)` }}>
                {cs.map((c) => <CoreTile key={c.id} id={c.id} kind={c.kind} pct={c.pct} trend={trend(c.id)} />)}
              </div>
            </div>
          ))}
        </div>
        <div className="mt-4 flex items-center justify-between text-[10.5px] uppercase tracking-wide text-ink-3"><span>Every core over time</span><span className="normal-case tracking-normal">5 minutes ago → now</span></div>
        <div className="mt-1 rounded-md border border-line bg-s2/30 p-1"><CoreHeatmap history={h} kinds={kinds} /></div>
      </Card>

      <div className="mb-4 grid gap-4 lg:grid-cols-[1fr_1fr]">
        <Card title="Memory, as macOS splits it" subtitle={l.memory ? `${fmtGb(memTotal, 0)} · live` : "not read on this machine"}>
          {l.memory && (
            <>
              <div className="flex h-5 overflow-hidden rounded-md">
                {MEM.map((m) => <div key={m.key} title={`${m.label}: ${fmtGb(l.memory![m.key])}`} className="h-full transition-[width] duration-700" style={{ width: `${(100 * l.memory![m.key]) / memTotal}%`, background: m.color }} />)}
              </div>
              <div className="mt-3 grid grid-cols-2 gap-x-6 gap-y-1.5 text-[12.5px]">
                {MEM.filter((m) => m.key === "free" || l.memory![m.key] > 0.01).map((m) => (
                  <div key={m.key} className="flex items-baseline gap-2" title={m.hint}>
                    <i className="inline-block h-2.5 w-2.5 shrink-0 rounded-sm" style={{ background: m.color }} />
                    <span className="text-ink-2">{m.label}</span><span className="ml-auto font-medium num">{fmtGb(l.memory![m.key])}</span>
                  </div>
                ))}
              </div>
            </>
          )}
        </Card>
        <Card title="GPU" subtitle={l.gpu ? `device ${l.gpu.pct}% · renderer ${l.gpu.renderer}% · tiler ${l.gpu.tiler}% · ${fmtGb(l.gpu.memGb)} in use` : "no GPU on this machine"}>
          {l.gpu ? <>
            <Spark values={h.map((p) => p.gpu ?? 0)} max={Math.max(100, gpuMax)} color="var(--series-3)" height={92} />
            <div className="mt-1 flex justify-between text-[10.5px] text-ink-3"><span>5 minutes ago</span><span>now</span></div>
          </> : <div className="py-6 text-center text-[12.5px] text-ink-3">Nothing to show: models run on the machines with GPUs.</div>}
        </Card>
      </div>

      <Card className="mb-4" pad={false} title="Processes" subtitle={`the busiest and the biggest right now · mux's own model servers named`} actions={<Segmented value={sort} onChange={setSort} options={[{ value: "cpu", label: "By CPU" }, { value: "mem", label: "By memory" }]} />}>
        <Table>
          <thead><tr><Th>Process</Th><Th right>PID</Th><Th right>CPU</Th><Th className="w-48" /><Th right>Memory</Th><Th className="w-48" /></tr></thead>
          <tbody>{procs.map((p) => (
            <tr key={p.pid}>
              <Td className="font-medium">{p.name}{models[p.pid] ? <Badge tone="accent" className="ml-2">{models[p.pid]}</Badge> : p.pid === l.pid ? <Badge tone="accent" className="ml-2">mux</Badge> : null}</Td>
              <Td right className="text-ink-3">{p.pid}</Td>
              <Td right>{p.cpu.toFixed(1)}%</Td>
              <Td><div className="h-1.5 overflow-hidden rounded-full bg-line"><div className="h-full rounded-full" style={{ width: `${(100 * p.cpu) / cpuScale}%`, minWidth: p.cpu > 0 ? 2 : 0, background: P }} /></div></Td>
              <Td right>{fmtGb(p.rssGb, p.rssGb < 1 ? 2 : 1)}</Td>
              <Td><div className="h-1.5 overflow-hidden rounded-full bg-line"><div className="h-full rounded-full" style={{ width: `${Math.min(100, (100 * p.rssGb) / Math.max(1, memTotal))}%`, minWidth: 2, background: "var(--series-3)" }} /></div></Td>
            </tr>
          ))}</tbody>
        </Table>
        <div className="border-t border-line px-4 py-2 text-[11.5px] text-ink-3">CPU is per core, as ps counts it: 100% is one core busy, {l.cores.length * 100}% all {l.cores.length}. A model's memory on the GPU shows as wired, not here.</div>
      </Card>
    </>
  );
}
