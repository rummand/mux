import { useEffect, useRef, useState, useCallback } from "react";
import { type Model, type SystemInfo } from "../api";
import { Badge, Card, Meter, StatusDot } from "../components/ui";
import { fmtGb } from "../format";
import { useApi } from "../hooks";

interface NodeData {
  id: string;
  display_name: string;
  kind: string;
  state: "ready" | "loading" | "unloading" | "failed" | "unloaded";
  estimateGb: number;
  rssGb: number | null;
  backend: string;
  pinned: boolean;
  enabled: boolean;
  x: number;
  y: number;
  r: number;
}

const KIND_COLORS: Record<string, string> = {
  chat: "var(--series-1)",
  embedding: "var(--series-2)",
  rerank: "var(--series-3)",
  systemone: "var(--series-4)",
  transcription: "var(--series-5)",
  image: "var(--series-6)",
  video: "var(--series-7)",
  "video-camera": "var(--series-8)",
  "video-subject": "var(--text-muted)",
  depth: "var(--text-muted)",
  reconstruct: "var(--text-muted)",
  backdrop: "var(--text-muted)",
  document: "var(--text-muted)",
  speech: "var(--text-muted)",
};

const STATE_BG: Record<string, string> = {
  ready: "var(--good-soft)",
  loading: "var(--accent-soft)",
  unloading: "var(--warning-soft)",
  failed: "var(--critical-soft)",
  unloaded: "var(--s2)",
};

const STATE_STROKE: Record<string, string> = {
  ready: "var(--good)",
  loading: "var(--accent)",
  unloading: "var(--warn)",
  failed: "var(--bad)",
  unloaded: "var(--line-strong)",
};

export function ModelMap({ sys }: { sys: SystemInfo | undefined }) {
  const { data: models } = useApi<Model[]>("/models", undefined, 5000);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [dimensions, setDimensions] = useState({ w: 800, h: 400 });

  // Mutable node pool — the simulation mutates x/y on these objects
  const nodesRef = useRef<NodeData[]>([]);
  const simRef = useRef<any>(null);
  const [displayNodes, setDisplayNodes] = useState<NodeData[]>([]);
  const mountedRef = useRef(true);

  const selected = displayNodes.find((n) => n.id === selectedId) ?? null;
  const loadedCount = displayNodes.filter((n) => n.state === "ready").length;
  const totalRss = displayNodes.reduce((sum, n) => sum + (n.rssGb ?? 0), 0);
  const totalEstimate = displayNodes.reduce((sum, n) => sum + n.estimateGb, 0);

  const initSim = useCallback((currentNodes: NodeData[], width: number, height: number) => {
    if (currentNodes.length === 0) return;
    (simRef.current as any)?.stop();

    import("d3-force").then((d3f: any) => {
      if (!mountedRef.current) return;

      const sim = d3f.forceSimulation(currentNodes)
        .force("charge", d3f.forceManyBody().strength(-400))
        .force("center", d3f.forceCenter(width / 2, height / 2).strength(0.01))
        .force("collision", d3f.forceCollide().radius((n: NodeData) => n.r + 3))
        .on("tick", () => {
          if (mountedRef.current) {
            setDisplayNodes(currentNodes.map((n) => ({ ...n })));
          }
        })
        .alpha(1)
        .restart();

      simRef.current = sim;
    }).catch((err: any) => {
      console.error("[ModelMap] failed to load d3-force:", err);
    });
  }, []);

  // Resize observer
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const observer = new ResizeObserver(() => {
      const rect = container.getBoundingClientRect();
      setDimensions({ w: rect.width, h: Math.max(500, window.innerHeight - 340) });
    });
    observer.observe(container);
    return () => observer.disconnect();
  }, []);

  // Main effect: sync models → nodes → simulation
  useEffect(() => {
    mountedRef.current = true;

    if (!models || models.length === 0) {
      nodesRef.current = [];
      setDisplayNodes([]);
      return;
    }

    const existingMap = new Map(nodesRef.current.map((n) => [n.id, n]));
    const newNodes: NodeData[] = [];
    const w = dimensions.w;
    const h = dimensions.h;

    for (const m of models) {
      const existing = existingMap.get(m.id);
      if (existing) {
        // Update non-physics properties only
        existing.display_name = m.display_name || m.id;
        existing.kind = m.kind;
        existing.state = (m.instance?.state ?? "unloaded") as NodeData["state"];
        existing.estimateGb = m.estimateGb;
        existing.rssGb = m.instance?.rssGb ?? null;
        existing.backend = m.backend;
        existing.pinned = m.pinned;
        existing.enabled = m.enabled;
        existing.r = Math.max(10, Math.sqrt(m.estimateGb) * 6);
      } else {
        // New node — use a grid layout to guarantee no clipping
        const totalModels = models.length;
        const cols = Math.ceil(Math.sqrt(totalModels * (w / h)));
        const row = newNodes.length % cols;
        const col = Math.floor(newNodes.length / cols);
        const cellW = w * 0.85 / cols;
        const cellH = h * 0.85 / (Math.ceil(totalModels / cols));
        const nn: NodeData = {
          id: m.id,
          display_name: m.display_name || m.id,
          kind: m.kind,
          state: (m.instance?.state ?? "unloaded") as NodeData["state"],
          estimateGb: m.estimateGb,
          rssGb: m.instance?.rssGb ?? null,
          backend: m.backend,
          pinned: m.pinned,
          enabled: m.enabled,
          x: w / 2 - w * 0.425 + col * cellW + cellW / 2,
          y: h / 2 - h * 0.425 + row * cellH + cellH / 2,
          r: Math.max(10, Math.sqrt(m.estimateGb) * 6),
        };
        newNodes.push(nn);
      }
    }

    // Remove removed models
    const modelIds = new Set(models.map((m) => m.id));
    nodesRef.current = nodesRef.current.filter((n) => modelIds.has(n.id));
    nodesRef.current.push(...newNodes);

    // Update display
    setDisplayNodes(nodesRef.current.map((n) => ({ ...n })));

    if (simRef.current) {
      // Nodes already exist — just reheat
      simRef.current.alpha(0.5).restart();
    } else {
      // First time — initialize simulation
      initSim(nodesRef.current, w, h);
    }

    return () => {
      mountedRef.current = false;
      (simRef.current as any)?.stop();
    };
  }, [models, dimensions.w, dimensions.h, initSim]);

  const hasDetail = sys && displayNodes.length > 0;

  return (
    <Card title="Model Map" subtitle="Every model as a circle: bigger = more RAM. Green = loaded, dashed = not pinned, colored dot above = kind." pad={false}
      actions={hasDetail ? (
        <div className="flex items-center gap-3 text-[11px] text-ink-3">
          <span>{loadedCount} loaded</span>
          <span>{fmtGb(totalRss)} actual RSS</span>
          <span>{fmtGb(totalEstimate)} estimated</span>
        </div>
      ) : undefined}
    >
      {displayNodes.length === 0 ? (
        <div className="flex h-[300px] items-center justify-center text-ink-3">
          No models installed yet.
        </div>
      ) : (
        <div className="flex">
          <div
            ref={containerRef}
            className="relative flex-1 overflow-hidden select-none"
            style={{ cursor: "grab", minHeight: 500 }}
          >
            {displayNodes.map((n) => (
              <div
                key={n.id}
                onClick={() => setSelectedId(selectedId === n.id ? null : n.id)}
                className="absolute flex flex-col items-center transition-none"
                style={{
                  left: (n.x ?? 0) - n.r,
                  top: (n.y ?? 0) - n.r - 18,
                  width: n.r * 2,
                  height: n.r * 2 + 36,
                  transform: "translate(-50%, -50%)",
                }}
              >
                {/* Outer glow ring */}
                <div
                  className="absolute rounded-full"
                  style={{
                    inset: 0,
                    border: `3px solid ${STATE_STROKE[n.state]}`,
                    opacity: 0.15,
                  }}
                />
                {/* Main circle */}
                <div
                  className="relative flex items-center justify-center rounded-full"
                  style={{
                    width: n.r * 2,
                    height: n.r * 2,
                    background: STATE_BG[n.state],
                    border: `2px solid ${STATE_STROKE[n.state]}`,
                    borderStyle: n.pinned ? "solid" : "dashed",
                    borderWidth: n.pinned ? 3 : 2,
                  }}
                >
                  {/* Size label (GB) */}
                  <span
                    className="num pointer-events-none font-semibold"
                    style={{
                      fontSize: "10px",
                      color: n.state === "ready" ? "var(--good)" : "var(--ink-2)",
                    }}
                  >
                    {n.state === "unloaded" && n.enabled ? "" : fmtGb(n.estimateGb)}
                  </span>
                </div>

                {/* Kind dot above */}
                <div
                  className="absolute -top-1 left-1/2 -translate-x-1/2 rounded-full"
                  style={{
                    width: 8,
                    height: 8,
                    background: KIND_COLORS[n.kind] ?? "var(--text-muted)",
                  }}
                />

                {/* Name below */}
                <div
                  className="pointer-events-none text-center"
                  style={{ fontSize: "9px", fontWeight: 500, color: "var(--ink-2)" }}
                >
                  {n.display_name.length > 16 ? n.display_name.slice(0, 15) + "…" : n.display_name}
                </div>
              </div>
            ))}

            {/* Legend overlay */}
            <div className="absolute top-2 left-2 rounded-md border border-line bg-bg p-1.5 text-[10px]">
              <div className="mb-0.5 font-medium text-ink-3">Size = memory</div>
              <div className="mb-0.5 flex items-center gap-1"><span className="inline-block h-2 w-2 rounded-full bg-good" /> loaded</div>
              <div className="mb-0.5 flex items-center gap-1"><span className="inline-block h-2 w-2 rounded-full bg-accent" /> loading</div>
              <div className="mb-0.5 flex items-center gap-1"><span className="inline-block h-2 w-2 rounded-full bg-bad" /> failed</div>
              <div className="mb-0.5 flex items-center gap-1"><span className="inline-block h-2 w-2 rounded-full bg-ink-3" /> unloaded</div>
              <div className="mt-0.5 pt-0.5 border-t border-line font-medium text-ink-3">Kind</div>
              {Object.entries(KIND_COLORS).slice(0, 6).map(([k, v]) => (
                <div key={k} className="mt-0.5 flex items-center gap-1"><span className="inline-block h-1.5 w-1.5 rounded-full" style={{ background: v }} />{k}</div>
              ))}
            </div>
          </div>

          {/* RAM budget bar */}
          {sys && displayNodes.length > 0 && (
            <div className="w-64 shrink-0 border-l border-line p-3">
              <div className="mb-1 text-[11px] font-medium text-ink-3">RAM budget</div>
              <div className="mb-1 text-xs num">
                {fmtGb(totalRss)} / {fmtGb(sys.budget.budgetGb)}
              </div>
              <Meter value={totalRss} max={sys.budget.budgetGb} tone={totalRss / sys.budget.budgetGb > 0.9 ? "bad" : totalRss / sys.budget.budgetGb > 0.7 ? "warn" : "accent"} />
              <div className="mt-2 mb-0.5 text-[10px] font-medium text-ink-3">By model</div>
              <div className="space-y-0.5">
                {displayNodes
                  .filter((n) => n.rssGb != null && n.rssGb > 0)
                  .sort((a, b) => (b.rssGb ?? 0) - (a.rssGb ?? 0))
                  .slice(0, 8)
                  .map((n) => (
                    <div key={n.id} className="flex items-center gap-1.5 text-[10px]">
                      <span className="w-3 text-right font-mono num" style={{ color: STATE_STROKE[n.state] }}>{fmtGb(n.rssGb!, 0)}GB</span>
                      <div className="h-2 flex-1 rounded-sm bg-s3">
                        <div className="h-full rounded-sm" style={{ width: `${Math.min(100, (n.rssGb! / sys.budget.budgetGb) * 100)}%`, background: STATE_STROKE[n.state] }} />
                      </div>
                      <span className="w-20 truncate text-ink-2">{n.display_name.length > 18 ? n.display_name.slice(0, 17) + "…" : n.display_name}</span>
                    </div>
                  ))}
              </div>
              {displayNodes.length > 8 && (
                <div className="mt-0.5 text-[10px] text-ink-3">+{displayNodes.length - 8} more</div>
              )}
              <div className="mt-2 text-[11px] num">
                <span style={{ color: totalRss < sys.budget.budgetGb ? "var(--good)" : "var(--bad)" }}>
                  {sys.budget.budgetGb - totalRss >= 0 ? `+${fmtGb(sys.budget.budgetGb - totalRss)} left` : `${fmtGb(totalRss - sys.budget.budgetGb)} over`}
                </span>
              </div>
            </div>
          )}

          {/* Detail panel — only shown when clicked */}
          {selectedId && (() => {
            const s = selected!;
            return (
            <div className="w-[260px] shrink-0 border-l border-line p-3">
              <Card
                title={
                  <div className="flex items-center gap-2">
                    <StatusDot tone={s.state === "ready" ? "good" : s.state === "loading" ? "accent" : s.state === "failed" ? "bad" : "muted"} label={s.state} />
                    <span className="truncate">{s.display_name}</span>
                  </div>
                }
                pad={false}
              >
                <div className="space-y-1.5 text-[11.5px]">
                  <div className="flex justify-between"><span className="text-ink-3">ID</span><span className="font-mono">{s.id}</span></div>
                  <div className="flex justify-between"><span className="text-ink-3">Kind</span><Badge>{s.kind}</Badge></div>
                  <div className="flex justify-between"><span className="text-ink-3">Backend</span><span>{s.backend}</span></div>
                  <div className="flex justify-between"><span className="text-ink-3">Pinned</span><span>{s.pinned ? "yes" : "no"}</span></div>
                  <hr className="border-line" />
                  <div className="flex justify-between"><span className="text-ink-3">Est. RAM</span><span className="num">{fmtGb(s.estimateGb)}</span></div>
                  {s.rssGb != null && (
                    <>
                      <div className="flex justify-between"><span className="text-ink-3">Actual RSS</span><span className="num">{fmtGb(s.rssGb)}</span></div>
                      {sys && (
                        <div>
                          <div className="mb-0.5 text-[10px] text-ink-3">RAM budget share</div>
                          <Meter value={s.rssGb} max={sys.budget.budgetGb} />
                        </div>
                      )}
                    </>
                  )}
                </div>
              </Card>
            </div>
            );
          })()}
        </div>
      )}
    </Card>
  );
}
