import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import type { Provider, ProviderStats } from "../api";
import { SERIES, TimeChart } from "../components/charts";
import { OverviewPanel, RANGE_OPTIONS } from "../components/OverviewPanel";
import { Badge, Button, Card, Empty, ErrorNote, PageHeader, Segmented, Stat, StatusDot, Table, Td, Th } from "../components/ui";
import { fmtAgo, fmtCompact, fmtDuration, fmtGb, fmtInt, fmtMs, fmtPct, fmtTime } from "../format";
import { useApi } from "../hooks";

const DAY = 86400_000;
const usd = (x: number | null | undefined) => `$${(x ?? 0).toFixed(2)}`;

/** One provider: for a node, whether it answered, how fast, and its memory over time; for any, its models' traffic and spend. */
export default function ProviderDetailPage() {
  const id = useParams()["*"] ?? "";
  const [range, setRange] = useState("24h");
  const { data: list } = useApi<Provider[]>("/providers", undefined, 15_000, null);
  const { data: st, error } = useApi<ProviderStats>(`/stats/provider/${id}`, { range }, 30_000, null);
  const p = list?.find((x) => x.id === id);
  if (error) return <ErrorNote error={error} />;
  const node = (st?.kind ?? p?.kind) === "mux";
  const sys = p?.info?.system;
  const tone = p?.status === "online" ? "good" : p?.status === "unknown" ? "muted" : "bad";
  const spend = (st?.daily ?? []).map((d) => ({ t: d.day, usd: d.usd ?? 0, tokens: d.tokens ?? 0, requests: d.n }));

  return (
    <>
      <PageHeader
        title={p?.name ?? id}
        subtitle={<span className="flex flex-wrap items-center gap-2"><span className="font-mono">{id}</span>{p && <span>· {p.kind} · {p.base_url}</span>}</span>}
        actions={<>
          {p && <StatusDot tone={tone} label={p.status} pulse={p.status === "online"} />}
          {p && !p.enabled && <Badge tone="muted">not routed to</Badge>}
          <Link to="/providers"><Button variant="ghost">All providers</Button></Link>
        </>}
      />
      <div className="mb-4"><Segmented value={range} onChange={setRange} options={RANGE_OPTIONS} /></div>

      {!st ? <div className="h-64 animate-pulse rounded-lg bg-s1" /> : (
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 2xl:grid-cols-6">
            {node ? <>
              <Stat label="Uptime" value={st.uptime == null ? "—" : fmtPct(st.uptime, 2)} sub={`${st.outages.length} outages in ${range}`} tone={st.uptime != null && st.uptime < 0.99 ? "warn" : undefined} />
              <Stat label="Round trip p50" value={fmtMs(st.latencyP50)} sub={`p95 ${fmtMs(st.latencyP95)}`} />
              <Stat label="Free memory" value={fmtGb(sys?.memFreeGb)} sub={sys ? `of ${sys.memTotalGb.toFixed(0)} GB · ${sys.chip}` : ""} />
              <Stat label="Swap" value={fmtGb(sys?.swapGb)} sub={`pressure ${sys?.pressure === 4 ? "critical" : sys?.pressure === 2 ? "warn" : "normal"}`} tone={(sys?.swapGb ?? 0) > 20 ? "warn" : undefined} />
              <Stat label="Model memory" value={p?.info?.budget ? `${p.info.budget.usedGb.toFixed(1)} GB` : "—"} sub={p?.info?.budget ? `of a ${p.info.budget.budgetGb} GB budget` : ""} />
              <Stat label="Loaded" value={fmtInt((p?.info?.instances ?? []).filter((i) => i.state === "ready").length)} sub={`${st.models} models routable · seen ${fmtAgo(p?.last_seen)}`} />
            </> : <>
              <Stat label="Models" value={fmtInt(st.models)} sub="added from this API" />
              <Stat label="Requests" value={fmtCompact(st.byModel.reduce((a, x) => a + x.n, 0))} sub={`in ${range}`} />
              <Stat label="Tokens" value={fmtCompact(st.byModel.reduce((a, x) => a + (x.pin ?? 0) + (x.pout ?? 0), 0))} sub={`in ${range}`} />
              <Stat label="Spend" value={usd(st.byModel.reduce((a, x) => a + (x.usd ?? 0), 0))} sub={`in ${range}`} />
              <Stat label="Spend, 30 days" value={usd(spend.reduce((a, x) => a + x.usd, 0))} sub="all models" />
              <Stat label="Errors" value={fmtInt(st.byModel.reduce((a, x) => a + (x.errors ?? 0), 0))} sub={`in ${range}`} />
            </>}
          </div>

          {node && (st.sampled ? (
            <div className="grid gap-4 lg:grid-cols-2">
              <Card title="Reachable" subtitle="share of syncs (every 15 s) the node answered">
                <TimeChart data={st.series} bucketMs={st.bucketMs} kind="area" yFormat={(v) => fmtPct(v, 0)} series={[{ key: "online", label: "Online", color: SERIES[2], format: (v) => fmtPct(v, 1) }]} height={150} />
              </Card>
              <Card title="Round trip" subtitle="gateway → node admin API, average and peak">
                <TimeChart data={st.series} bucketMs={st.bucketMs} yFormat={(v) => `${Math.round(v)}`} series={[
                  { key: "latency_ms", label: "Average", color: SERIES[0], format: fmtMs },
                  { key: "latency_msMax", label: "Peak", color: SERIES[1], format: fmtMs },
                ]} height={150} />
              </Card>
              <Card title="Node memory" subtitle="free memory and swap, GB">
                <TimeChart data={st.series} bucketMs={st.bucketMs} yFormat={(v) => `${v.toFixed(0)}`} series={[
                  { key: "mem_free_gb", label: "Free", color: SERIES[2], format: (v) => fmtGb(v) },
                  { key: "swap_gb", label: "Swap", color: "var(--warning)", format: (v) => fmtGb(v) },
                ]} height={150} />
              </Card>
              <Card title="mux on the node" subtitle="model memory used against its budget, and models loaded">
                <TimeChart data={st.series} bucketMs={st.bucketMs} yFormat={(v) => `${v.toFixed(0)}`} series={[
                  { key: "used_gb", label: "Used GB", color: SERIES[0], format: (v) => fmtGb(v) },
                  { key: "budget_gb", label: "Budget GB", color: "var(--text-muted)", format: (v) => fmtGb(v, 0) },
                  { key: "loaded", label: "Loaded", color: SERIES[3], format: (v) => v.toFixed(1) },
                ]} height={150} />
              </Card>
            </div>
          ) : <Card><Empty>No samples yet in {range}: they are taken at every sync (15 s) from now on.</Empty></Card>)}

          <div className="grid gap-4 lg:grid-cols-2">
            <Card title="Last 30 days" subtitle={node ? "requests and tokens per day" : "spend per day (USD)"}>
              {spend.length ? (node
                ? <TimeChart data={spend} bucketMs={DAY} kind="bar" series={[{ key: "tokens", label: "Tokens", color: SERIES[0] }]} height={170} />
                : <TimeChart data={spend} bucketMs={DAY} kind="bar" yFormat={(v) => `$${v.toFixed(2)}`} series={[{ key: "usd", label: "USD", color: SERIES[4], format: usd }]} height={170} />)
                : <Empty>No traffic in 30 days.</Empty>}
            </Card>
            {node ? (
              <Card title="Outages" subtitle={`runs of missed syncs in ${range}`} pad={false}>
                {st.outages.length ? (
                  <Table>
                    <thead><tr><Th>From</Th><Th>To</Th><Th right>Lasted</Th></tr></thead>
                    <tbody>{[...st.outages].reverse().map((o) => (
                      <tr key={o.from}><Td>{fmtTime(o.from, true)}</Td><Td>{o.to ? fmtTime(o.to, true) : <Badge tone="bad">ongoing</Badge>}</Td><Td right>{fmtDuration(((o.to ?? Date.now()) - o.from) / 1000)}</Td></tr>
                    ))}</tbody>
                  </Table>
                ) : <div className="p-4"><Empty>No outages in {range}.</Empty></div>}
              </Card>
            ) : (
              <Card title="Spend by model" subtitle={`in ${range}`}>
                {st.byModel.length ? (
                  <div className="space-y-2">{st.byModel.map((x) => (
                    <div key={x.model_id} className="flex justify-between text-[12px]"><span className="truncate text-ink-2">{x.model_id}</span><span className="num">{usd(x.usd)}</span></div>
                  ))}</div>
                ) : <Empty>No traffic.</Empty>}
              </Card>
            )}
          </div>

          <Card title="Models" subtitle={`traffic per model in ${range}`} pad={false}>
            {st.byModel.length ? (
              <Table>
                <thead><tr><Th>Model</Th><Th right>Requests</Th><Th right>Tokens in</Th><Th right>Tokens out</Th><Th right>Errors</Th><Th right>Avg latency</Th><Th right>tok/s</Th><Th right>USD</Th></tr></thead>
                <tbody>{st.byModel.map((x) => (
                  <tr key={x.model_id} className="hover:bg-s2">
                    <Td><Link className="font-medium hover:text-accent" to={`/models/${x.model_id}`}>{x.model_id}</Link></Td>
                    <Td right>{fmtInt(x.n)}</Td><Td right>{fmtCompact(x.pin)}</Td><Td right>{fmtCompact(x.pout)}</Td>
                    <Td right className={x.errors ? "text-bad" : ""}>{fmtInt(x.errors)}</Td><Td right>{fmtMs(x.lat)}</Td>
                    <Td right>{x.tps == null ? "—" : x.tps.toFixed(1)}</Td><Td right>{usd(x.usd)}</Td>
                  </tr>
                ))}</tbody>
              </Table>
            ) : <div className="p-4"><Empty>No traffic in {range}.</Empty></div>}
          </Card>

          <Card title="Incidents" subtitle="what the healer saw on this provider and its models" pad={false}>
            {st.incidents.length ? (
              <Table>
                <thead><tr><Th>When</Th><Th>What</Th><Th>Kind</Th><Th>Severity</Th><Th>Status</Th></tr></thead>
                <tbody>{st.incidents.map((i) => (
                  <tr key={i.id}><Td>{fmtAgo(i.ts)}</Td><Td>{i.title}</Td><Td mono>{i.kind}</Td>
                    <Td><Badge tone={i.severity === "critical" ? "bad" : i.severity === "warning" ? "warn" : "muted"}>{i.severity}</Badge></Td>
                    <Td><Badge tone={i.status === "resolved" ? "good" : "warn"}>{i.status}{i.resolved_at ? ` · ${fmtAgo(i.resolved_at)}` : ""}</Badge></Td></tr>
                ))}</tbody>
              </Table>
            ) : <div className="p-4"><Empty>No incidents.</Empty></div>}
          </Card>
        </div>
      )}

      <h2 className="mt-8 mb-3 text-[15px] font-semibold">Traffic</h2>
      <OverviewPanel range={range} provider={id} scope={null} />
    </>
  );
}
