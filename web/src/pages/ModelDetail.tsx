import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import type { Model, ModelStats } from "../api";
import { SERIES, TimeChart } from "../components/charts";
import { OverviewPanel, RANGE_OPTIONS } from "../components/OverviewPanel";
import { Badge, Button, Card, Empty, ErrorNote, KeyValue, PageHeader, Segmented, Stat, Table, Td, Th } from "../components/ui";
import { fmtAgo, fmtBytes, fmtCompact, fmtGb, fmtInt, fmtMs, fmtPct, fmtTime } from "../format";
import { useApi } from "../hooks";

/** One model: what it held and did (memory, slots, speed, loads), and its traffic. Data is the gateway's own. */
export default function ModelDetailPage() {
  const id = useParams()["*"] ?? "";
  const [range, setRange] = useState("24h");
  const { data: models } = useApi<Model[]>("/models", undefined, 15_000, null);
  const { data: st, error } = useApi<ModelStats>(`/stats/model/${id}`, { range }, 30_000, null);
  const m = models?.find((x) => x.id === id);
  if (error) return <ErrorNote error={error} />;

  return (
    <>
      <PageHeader
        title={m?.display_name ?? id}
        subtitle={<span className="flex flex-wrap items-center gap-2"><span className="font-mono">{id}</span>{m && <><span>· {m.kind} · {m.backend}</span>{m.provider && <span>· on {m.provider}</span>}</>}</span>}
        actions={<>
          {m?.pinned && <Badge tone="accent">pinned</Badge>}
          {m && <Badge tone={m.enabled ? "good" : "muted"}>{m.enabled ? "enabled" : "disabled"}</Badge>}
          {m?.instance && <Badge tone={m.instance.state === "ready" ? "good" : m.instance.state === "failed" ? "bad" : "warn"}>{m.instance.state}</Badge>}
          <Link to="/models"><Button variant="ghost">All models</Button></Link>
        </>}
      />
      <div className="mb-4"><Segmented value={range} onChange={setRange} options={RANGE_OPTIONS} /></div>

      {!st ? <div className="h-64 animate-pulse rounded-lg bg-s1" /> : (
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 2xl:grid-cols-6">
            <Stat label="Loaded" value={st.loadedShare == null ? "—" : fmtPct(st.loadedShare, 0)} sub={st.loadedHours != null ? `${st.loadedHours} h in ${range}` : "no samples yet"} />
            <Stat label="GB-hours" value={st.gbHours ?? "—"} sub="memory held × time loaded" />
            <Stat label="Tokens / loaded hour" value={fmtCompact(st.tokensPerLoadedHour)} sub={`${fmtCompact(st.usage.tokens)} tokens served`} />
            <Stat label="Requests" value={fmtCompact(st.usage.requests)} sub={`${fmtInt(st.usage.tenants)} tenants · ${fmtInt(st.usage.errors)} errors`} tone={st.usage.errors > 0 ? "warn" : undefined} />
            <Stat label="Loads" value={fmtInt(st.loads)} sub={`${fmtInt(st.unloads)} unloads · ${fmtInt(st.failures)} problems`} tone={st.failures > 0 ? "warn" : undefined} />
            <Stat label="Load time" value={st.loadSecondsP50 == null ? "—" : `${st.loadSecondsP50} s`} sub={st.loadSecondsMax != null ? `max ${st.loadSecondsMax} s` : "p50 of loads"} />
          </div>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 2xl:grid-cols-6">
            <Stat label="Memory estimate" value={fmtGb(m?.estimateGb)} sub={m ? `${fmtBytes(m.size_bytes)} weights · ctx ${fmtCompact(m.ctx)}` : ""} />
            <Stat label="Peak in flight" value={fmtInt(st.peakInflight)} sub={`deferred peak ${fmtInt(st.peakDeferred)}`} />
            <Stat label="Cold starts" value={fmtInt(st.usage.coldStarts)} sub="requests that waited for a load" />
            <Stat label="Measured TTFT" value={fmtMs(st.health?.ttftMs ?? null)} sub="moving average (router)" />
            <Stat label="Measured speed" value={st.health?.tps == null ? "—" : `${st.health.tps.toFixed(1)} tok/s`} sub={st.health ? `${fmtInt(st.health.ok)} ok · ${fmtInt(st.health.err)} failed` : "since mux started"} />
            <Stat label="Health" value={st.health?.cooldown ? "cooldown" : st.health ? "ok" : "—"} sub={st.health?.fails.length ? `${st.health.fails.length} recent failures` : "circuit closed"} tone={st.health?.cooldown ? "bad" : undefined} />
          </div>

          {!st.sampled && <Card><Empty>No resource samples for this model in {range}: it has not been loaded (samples are taken every 30 s while it is).</Empty></Card>}
          {st.sampled && (
            <div className="grid gap-4 lg:grid-cols-2">
              <Card title="Loaded" subtitle="share of each bucket the model was ready">
                <TimeChart data={st.series} bucketMs={st.bucketMs} kind="area" yFormat={(v) => fmtPct(v, 0)} series={[{ key: "ready", label: "Loaded", color: SERIES[2], format: (v) => fmtPct(v, 0) }]} height={160} />
              </Card>
              <Card title="Memory" subtitle="mux's estimate and the process's resident memory (RSS; Metal buffers are not counted in RSS)">
                <TimeChart data={st.series} bucketMs={st.bucketMs} yFormat={(v) => `${v.toFixed(0)}`} series={[
                  { key: "estimate_gb", label: "Estimate GB", color: SERIES[0], format: (v) => fmtGb(v) },
                  { key: "rss_gb", label: "RSS GB", color: SERIES[1], format: (v) => fmtGb(v, 2) },
                ]} height={160} />
              </Card>
              <Card title="Slots" subtitle="requests in flight (peak) and deferred (waiting for a slot)">
                <TimeChart data={st.series} bucketMs={st.bucketMs} kind="bar" series={[
                  { key: "inflightMax", label: "In flight (peak)", color: SERIES[3] },
                  { key: "deferredMax", label: "Deferred (peak)", color: "var(--warning)" },
                ]} height={160} />
              </Card>
              <Card title="Server speed" subtitle="llama.cpp's own tokens per second (generation and prompt)">
                <TimeChart data={st.series} bucketMs={st.bucketMs} yFormat={(v) => `${Math.round(v)}`} series={[
                  { key: "gen_tps", label: "Generation tok/s", color: SERIES[4], format: (v) => `${v.toFixed(1)} tok/s` },
                  { key: "prompt_tps", label: "Prompt tok/s", color: SERIES[5], format: (v) => `${v.toFixed(0)} tok/s` },
                ]} height={160} />
              </Card>
            </div>
          )}

          <div className="grid gap-4 lg:grid-cols-2">
            <Card title="Benchmarks" subtitle="history: score, speed and time to first token" pad={!st.benchmarks.length}>
              {st.benchmarks.length ? (
                <>
                  <div className="p-4 pb-0">
                    <TimeChart data={[...st.benchmarks].reverse().map((b) => ({ t: b.ts, tps: b.tps, score: b.score == null ? null : b.score * 100 }))} bucketMs={86400_000} series={[
                      { key: "tps", label: "tok/s", color: SERIES[0], format: (v) => `${v.toFixed(1)} tok/s` },
                      { key: "score", label: "Score %", color: SERIES[2], format: (v) => `${v.toFixed(0)}%` },
                    ]} height={140} />
                  </div>
                  <Table>
                    <thead><tr><Th>When</Th><Th right>Score</Th><Th right>tok/s</Th><Th right>Prompt tok/s</Th><Th right>TTFT</Th><Th right>Load</Th><Th>Status</Th></tr></thead>
                    <tbody>{st.benchmarks.slice(0, 10).map((b) => (
                      <tr key={b.ts}><Td>{fmtAgo(b.ts)}</Td><Td right>{b.score == null ? "—" : fmtPct(b.score, 0)}</Td><Td right>{b.tps ?? "—"}</Td><Td right>{b.prompt_tps ?? "—"}</Td><Td right>{fmtMs(b.ttft_ms)}</Td><Td right>{fmtMs(b.load_ms)}</Td><Td>{b.status}</Td></tr>
                    ))}</tbody>
                  </Table>
                </>
              ) : <Empty>No benchmarks{m?.provider ? " here (a node's benchmarks are on the node)" : ""}.</Empty>}
            </Card>
            <Card title="Lifecycle" subtitle="loads, unloads, failures and repairs in this range" pad={false}>
              {st.events.length ? (
                <div className="max-h-[340px] overflow-y-auto divide-y divide-line">
                  {st.events.map((e, i) => (
                    <div key={i} className="flex gap-3 px-4 py-1.5 text-[12px]">
                      <span className="shrink-0 text-ink-3 num">{fmtTime(e.ts, true)}</span>
                      <span className={e.level === "error" ? "text-bad" : e.level === "warn" ? "text-warn" : "text-ink-2"}>{e.message}</span>
                    </div>
                  ))}
                </div>
              ) : <div className="p-4"><Empty>No lifecycle events{m?.provider ? " here (a node keeps its own)" : ""}.</Empty></div>}
            </Card>
          </div>

          {m && (
            <Card title="Configuration">
              <KeyValue items={[
                ["Context", fmtInt(m.ctx)], ["Parallel slots", fmtInt(m.parallel)], ["Reasoning", m.reasoning], ["Keep alive", m.keep_alive_min == null ? "default" : `${m.keep_alive_min} min`],
                ["Upstream", m.upstream_model ?? "—"], ["Price in/out", m.cost_in || m.cost_out ? `$${m.cost_in ?? 0} / $${m.cost_out ?? 0} per M` : "free (local)"],
                ["Path", <span key="p" className="font-mono text-[11px] break-all">{m.path ?? m.base_url ?? "—"}</span>],
              ]} />
            </Card>
          )}
        </div>
      )}

      <h2 className="mt-8 mb-3 text-[15px] font-semibold">Traffic</h2>
      <OverviewPanel range={range} model={id} scope={null} />
    </>
  );
}
