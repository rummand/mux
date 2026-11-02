import { useMemo, useState } from "react";
import type { Group, Overview } from "../api";
import { fmtCompact, fmtInt, fmtMs, fmtPct } from "../format";
import { useApi } from "../hooks";
import { ColumnChart, Heatmap, OTHER, SERIES, slotMap, TimeChart, type SeriesDef } from "./charts";
import { Card, Empty, Segmented, Stat, Table, Td, Th } from "./ui";

const axisMs = (v: number) => (v >= 1000 ? `${Math.round(v / 1000)}s` : `${Math.round(v)}ms`);

export const RANGE_OPTIONS = ["15m", "1h", "6h", "24h", "7d", "30d"].map((r) => ({ value: r, label: r }));

/** KPIs, the time charts and the breakdowns for a range, optionally one tenant/model/agent. Shared by Overview and a tenant's page. */
const TZ = -new Date().getTimezoneOffset();
type Breakdown = "tenant" | "provider" | "model" | "route" | "endpoint" | "agent" | "user" | "key" | "finish" | "status" | "error";

export function OverviewPanel({ range, tenant, model, agent, provider, route, showTenants = true, nameOf, scope = null }: {
  range: string; tenant?: string; model?: string; agent?: string; provider?: string; route?: string; showTenants?: boolean; nameOf?: (id: string) => string; scope?: string | null;
}) {
  const { data, error } = useApi<Overview>("/overview", { range, tenant, model, agent, provider, route, tz: TZ }, 15_000, scope);
  const [breakdown, setBreakdown] = useState<Breakdown>(tenant ? "model" : "provider");
  const colors = useMemo(() => slotMap(data?.tenants ?? []), [data?.tenants]);
  const modelColors = useMemo(() => slotMap(data?.models ?? []), [data?.models]);
  if (error) return <Empty>Could not load the overview: {error}</Empty>;
  if (!data) return <div className="h-96 animate-pulse rounded-lg bg-s1" />;
  const t = data.totals;
  const label = nameOf ?? ((id: string) => id);

  const tenantSeries: SeriesDef[] = showTenants && data.tenants.length
    ? data.tenants.slice().sort().map((tn) => ({ key: `tenant:${tn}`, label: label(tn), color: colors.get(tn) ?? OTHER }))
    : [{ key: "requests", label: "Requests", color: SERIES[0] }];
  const modelSeries: SeriesDef[] = data.models.slice().sort().map((m) => ({ key: `model:${m}`, label: m, color: modelColors.get(m) ?? OTHER }));
  const groups: Record<Breakdown, Group[]> = {
    tenant: data.byTenant, provider: data.byProvider ?? [], model: data.byModel, route: data.byRoute, endpoint: data.byEndpoint, agent: data.byAgent, user: data.byUser,
    key: data.byKey ?? [], finish: data.byFinish ?? [], status: data.byStatus ?? [], error: data.byError,
  };

  return (
    <div className="min-w-0 space-y-4">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 2xl:grid-cols-6">
        <Stat label="Requests" value={fmtCompact(t.requests)} sub={`${fmtPct(t.streamShare, 0)} streamed · ${fmtPct(t.toolShare, 0)} with tools`} />
        <Stat label="Error rate" value={fmtPct(t.errorRate)} sub={`${fmtInt(t.errors)} failed`} tone={t.errorRate > 0.05 ? "bad" : t.errorRate > 0.01 ? "warn" : undefined} />
        <Stat label="Tokens in/out" value={`${fmtCompact(t.promptTokens)} / ${fmtCompact(t.completionTokens)}`} sub={`${fmtCompact(t.cachedTokens)} from prompt cache`} />
        <Stat label="Latency p50" value={fmtMs(t.latencyP50)} sub={`p95 ${fmtMs(t.latencyP95)} · p99 ${fmtMs(t.latencyP99)}`} />
        <Stat label="First token p50" value={fmtMs(t.ttftP50)} sub={`p95 ${fmtMs(t.ttftP95)}`} />
        <Stat label="Tokens / second" value={t.tpsAvg == null ? "—" : `${t.tpsAvg}`} sub={`median ${t.tpsP50 ?? "—"} tok/s`} />
      </div>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 2xl:grid-cols-6">
        <Stat label="Gateway overhead p50" value={t.overheadP50 == null ? "—" : `${t.overheadP50} ms`} sub="mux's own time per call" />
        <Stat label="Gateway overhead p99" value={t.overheadP99 == null ? "—" : `${t.overheadP99} ms`} sub="excludes model + load time" />
        <Stat label="Cold starts" value={fmtInt(t.coldStarts)} sub="waited for a model to load" tone={t.coldStarts > 10 ? "warn" : undefined} />
        <Stat label="Fallbacks" value={fmtInt(t.fallbacks)} sub="answered by a later candidate" tone={t.fallbacks > 0 ? "warn" : undefined} />
        <Stat label="Avg latency" value={fmtMs(t.latencyAvg)} sub="successful requests" />
        <Stat label="Cloud spend" value={`$${(t.costUsd ?? 0).toFixed(2)}`} sub={`${(data.byProvider ?? []).filter((p) => p.key !== "local").length} providers used · ${data.byTenant.length} tenants`} />
      </div>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 2xl:grid-cols-6">
        <Stat label="Peak concurrency" value={fmtInt(t.peakConcurrency ?? null)} sub="most requests in flight at once" />
        <Stat label="Queue p95" value={fmtMs(t.queueP95 ?? null)} sub={`p50 ${fmtMs(t.queueP50 ?? null)} · waiting for a slot or load`} tone={(t.queueP95 ?? 0) > 2000 ? "warn" : undefined} />
        <Stat label="Prompt cache hits" value={fmtPct(t.cacheHitRate ?? null, 0)} sub="prompt tokens served from cache" />
        <Stat label="Tokens / request" value={fmtCompact(t.tokensPerRequest ?? null)} sub="prompt + completion, average" />
        <Stat label="Rate limited" value={fmtInt(t.rateLimited ?? 0)} sub="answered 429 (limits, budgets)" tone={(t.rateLimited ?? 0) > 0 ? "warn" : undefined} />
        <Stat label="Throughput peak" value={fmtCompact(Math.max(0, ...data.series.map((p) => p.tpm ?? 0)))} sub="tokens per minute, busiest bucket" />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card title={showTenants ? "Requests by tenant" : "Requests"} subtitle={`per ${fmtMs(data.bucketMs)} bucket`}>
          <TimeChart data={data.series} series={tenantSeries} kind="bar" stacked bucketMs={data.bucketMs} />
        </Card>
        <Card title="Latency" subtitle="p50 and p95 of successful requests, and time to first token (p50)">
          <TimeChart data={data.series} bucketMs={data.bucketMs} yFormat={axisMs} series={[
            { key: "latencyP50", label: "p50 latency", color: SERIES[0], format: fmtMs },
            { key: "latencyP95", label: "p95 latency", color: SERIES[1], format: fmtMs },
            { key: "ttftP50", label: "TTFT p50", color: SERIES[2], format: fmtMs },
          ]} />
        </Card>
        <Card title="Tokens" subtitle="prompt and completion tokens per bucket">
          <TimeChart data={data.series} bucketMs={data.bucketMs} kind="area" stacked series={[
            { key: "promptTokens", label: "Prompt", color: SERIES[0] },
            { key: "completionTokens", label: "Completion", color: SERIES[1] },
          ]} />
        </Card>
        <Card title="Requests by model" subtitle="which model answered">
          {modelSeries.length ? <TimeChart data={data.series} series={modelSeries} kind="bar" stacked bucketMs={data.bucketMs} /> : <Empty>No traffic in this range.</Empty>}
        </Card>
        <Card title="Errors" subtitle="failed requests per bucket">
          <TimeChart data={data.series} bucketMs={data.bucketMs} kind="bar" series={[{ key: "errors", label: "Errors", color: "var(--critical)" }]} />
        </Card>
        <Card title="Generation speed" subtitle="average tokens per second while generating">
          <TimeChart data={data.series} bucketMs={data.bucketMs} kind="area" yFormat={(v) => `${Math.round(v)}`} series={[{ key: "tps", label: "tok/s", color: SERIES[2], format: (v) => `${v.toFixed(1)} tok/s` }]} />
        </Card>
        <Card title="Latency distribution" subtitle="successful requests by total time">
          <ColumnChart data={data.latencyHistogram} x="bucket" y="count" label="requests" />
        </Card>
        <Card title="Gateway overhead" subtitle="p99 of mux's own time (total − model − load), ms">
          <TimeChart data={data.series} bucketMs={data.bucketMs} yFormat={(v) => `${v.toFixed(1)}`} series={[{ key: "overheadP99", label: "p99 overhead", color: SERIES[6], format: (v) => `${v.toFixed(2)} ms` }]} />
        </Card>
        <Card title="Concurrency" subtitle="peak requests in flight per bucket, and queue wait p95">
          <TimeChart data={data.series} bucketMs={data.bucketMs} series={[{ key: "concurrency", label: "In flight (peak)", color: SERIES[3], format: (v) => fmtInt(v) }]} kind="area" />
        </Card>
        <Card title="Throughput" subtitle="tokens per minute">
          <TimeChart data={data.series} bucketMs={data.bucketMs} kind="area" series={[{ key: "tpm", label: "tokens/min", color: SERIES[4], format: (v) => fmtCompact(v) }]} />
        </Card>
        <Card title="Error rate" subtitle="share of requests that failed, per bucket">
          <TimeChart data={data.series} bucketMs={data.bucketMs} yFormat={(v) => fmtPct(v, 0)} series={[{ key: "errorRate", label: "Error rate", color: "var(--critical)", format: (v) => fmtPct(v) }]} />
        </Card>
        <Card title="Cold starts & fallbacks" subtitle="requests that waited for a load, or were answered by a later candidate">
          <TimeChart data={data.series} bucketMs={data.bucketMs} kind="bar" series={[
            { key: "coldStarts", label: "Cold starts", color: SERIES[5] },
            { key: "fallbacks", label: "Fallbacks", color: SERIES[1] },
          ]} />
        </Card>
        <Card title="Queue wait" subtitle="p95 time waiting for a slot or a load, ms">
          <TimeChart data={data.series} bucketMs={data.bucketMs} yFormat={axisMs} series={[{ key: "queueP95", label: "Queue p95", color: SERIES[7], format: fmtMs }]} />
        </Card>
        <Card title="Prompt sizes" subtitle="requests by prompt tokens">
          {data.tokenHistogram ? <ColumnChart data={data.tokenHistogram} x="bucket" y="count" label="requests" color={SERIES[2]} /> : <Empty>—</Empty>}
        </Card>
      </div>

      {data.heatmap && (
        <Card title="When traffic comes" subtitle="requests by weekday and hour, your time zone">
          <Heatmap data={data.heatmap} />
        </Card>
      )}

      <Card title="Breakdown" pad={false} actions={
        <Segmented value={breakdown} onChange={setBreakdown} options={[
          ...(showTenants ? [{ value: "tenant" as const, label: "Tenant" }] : []),
          { value: "provider", label: "Provider" },
          { value: "model", label: "Model" }, { value: "route", label: "Route" }, { value: "endpoint", label: "Endpoint" },
          { value: "agent", label: "Agent" }, { value: "user", label: "End user" }, { value: "key", label: "Key" },
          { value: "finish", label: "Finish" }, { value: "status", label: "Status" }, { value: "error", label: "Errors" },
        ]} />
      }>
        <GroupTable rows={groups[breakdown]} />
      </Card>
    </div>
  );
}

export function GroupTable({ rows, label = "Key" }: { rows: Group[]; label?: string }) {
  if (!rows.length) return <div className="p-4"><Empty>Nothing in this range.</Empty></div>;
  return (
    <Table>
      <thead><tr><Th>{label}</Th><Th right>Requests</Th><Th right>Errors</Th><Th right>Tokens in</Th><Th right>Tokens out</Th><Th right>p50</Th><Th right>p95</Th><Th right>TTFT p50</Th><Th right>tok/s</Th><Th right>Cold</Th><Th right>Fallbacks</Th></tr></thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.key} className="hover:bg-s2">
            <Td className="max-w-64 truncate font-medium">{r.key}</Td>
            <Td right>{fmtInt(r.requests)}</Td>
            <Td right className={r.errors ? "text-bad" : ""}>{fmtInt(r.errors)} <span className="text-ink-3">{r.requests ? fmtPct(r.errorRate, 0) : ""}</span></Td>
            <Td right>{fmtCompact(r.promptTokens)}</Td>
            <Td right>{fmtCompact(r.completionTokens)}</Td>
            <Td right>{fmtMs(r.latencyP50)}</Td>
            <Td right>{fmtMs(r.latencyP95)}</Td>
            <Td right>{fmtMs(r.ttftP50)}</Td>
            <Td right>{r.tpsAvg ?? "—"}</Td>
            <Td right>{fmtInt(r.coldStarts)}</Td>
            <Td right>{fmtInt(r.fallbacks)}</Td>
          </tr>
        ))}
      </tbody>
    </Table>
  );
}
