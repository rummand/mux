import type { ReactNode } from "react";
import type { TenantStats } from "../api";
import { fmtAgo, fmtCompact, fmtInt } from "../format";
import { useApi } from "../hooks";
import { SERIES, TimeChart } from "./charts";
import { Badge, Card, Empty, Meter, Table, Td, Th } from "./ui";

const DAY = 86400_000;
const usd = (x: number | null | undefined) => `$${(x ?? 0).toFixed(2)}`;

/** How close a tenant runs to its limits and budgets: peaks against limits, the month against its budget. */
export function TenantLimits({ tenant, range }: { tenant: string; range: string }) {
  const { data, error } = useApi<TenantStats>(`/stats/tenant/${encodeURIComponent(tenant)}`, { range }, 30_000, null);
  if (error) return <Empty>Could not load limits: {error}</Empty>;
  if (!data) return <div className="h-48 animate-pulse rounded-lg bg-s1" />;
  const { limits: l, month: m } = data;
  const daily = data.daily.map((d) => ({ t: d.day, tokens: d.tokens ?? 0, usd: d.usd ?? 0, requests: d.n, errors: d.errors ?? 0 }));
  const limited = data.rateLimited.reduce((a, x) => a + x.n, 0);
  return (
    <div className="space-y-4">
      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Limits" subtitle={`busiest minute in ${range} against the tenant's limits · ${fmtInt(l.activeMinutes)} active minutes`}>
          <div className="space-y-4">
            <Gauge label="Requests per minute" value={l.rpmPeak} limit={l.rpmLimit} fmt={fmtInt} />
            <Gauge label="Tokens per minute" value={l.tpmPeak} limit={l.tpmLimit} fmt={fmtCompact} />
            <div className="flex flex-wrap items-center gap-2 text-[12px] text-ink-2">
              <span>Max parallel: <span className="num text-ink">{l.maxParallel || "no limit"}</span></span>
              <span className="text-ink-3">·</span>
              <span>Rate limited in range: <span className={limited ? "text-warn num" : "num text-ink"}>{fmtInt(limited)}</span></span>
              {data.rateLimited.map((x) => <Badge key={x.type} tone="warn">{x.type} · {x.n}</Badge>)}
            </div>
          </div>
        </Card>
        <Card title="This month" subtitle={`day ${m.dayOfMonth} of ${m.daysInMonth} · ${fmtInt(m.requests)} requests · projection at the month's pace so far`}>
          <div className="space-y-4">
            <Gauge label="Tokens" value={m.tokens} limit={m.tokenBudget} fmt={fmtCompact} projected={m.projectedTokens} />
            <Gauge label="Spend (USD)" value={m.usd ?? 0} limit={m.usdBudget} fmt={usd} projected={m.projectedUsd ?? 0} />
          </div>
        </Card>
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Last 30 days · tokens" subtitle="per day">
          {daily.length ? <TimeChart data={daily} bucketMs={DAY} kind="bar" series={[{ key: "tokens", label: "Tokens", color: SERIES[0] }]} height={170} /> : <Empty>No traffic in 30 days.</Empty>}
        </Card>
        <Card title="Last 30 days · requests and spend" subtitle="requests and errors per day; spend in USD">
          {daily.length ? (
            <div className="space-y-2">
              <TimeChart data={daily} bucketMs={DAY} kind="bar" stacked series={[{ key: "requests", label: "Requests", color: SERIES[1] }, { key: "errors", label: "Errors", color: "var(--critical)" }]} height={110} />
              <TimeChart data={daily} bucketMs={DAY} kind="area" yFormat={(v) => `$${v.toFixed(2)}`} series={[{ key: "usd", label: "USD", color: SERIES[4], format: usd }]} height={90} />
            </div>
          ) : <Empty>No traffic in 30 days.</Empty>}
        </Card>
      </div>
      <Card title="Keys" subtitle={`usage per key in ${range}`} pad={false}>
        {data.keys.length ? (
          <Table>
            <thead><tr><Th>Key</Th><Th>Prefix</Th><Th right>Requests</Th><Th right>Tokens</Th><Th right>Errors</Th><Th right>RPM limit</Th><Th>Last request</Th><Th>State</Th></tr></thead>
            <tbody>
              {data.keys.map((k) => (
                <tr key={k.id} className="hover:bg-s2">
                  <Td className="font-medium">{k.name}</Td>
                  <Td mono>{k.prefix}</Td>
                  <Td right>{fmtInt(k.usage?.n ?? 0)}</Td>
                  <Td right>{fmtCompact(k.usage?.tokens ?? 0)}</Td>
                  <Td right className={k.usage?.errors ? "text-bad" : ""}>{fmtInt(k.usage?.errors ?? 0)}</Td>
                  <Td right>{k.rpm_limit || "—"}</Td>
                  <Td>{k.usage?.last ? fmtAgo(k.usage.last) : "—"}</Td>
                  <Td>{k.revoked ? <Badge tone="muted">revoked</Badge> : k.expires_at && k.expires_at < Date.now() ? <Badge tone="warn">expired</Badge> : <Badge tone="good">active</Badge>}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        ) : <div className="p-4"><Empty>No keys.</Empty></div>}
      </Card>
    </div>
  );
}

function Gauge({ label, value, limit, fmt, projected }: { label: string; value: number; limit: number; fmt: (v: number) => string; projected?: number }) {
  const has = limit > 0;
  const ratio = has ? value / limit : 0;
  const tone = ratio > 0.9 ? "bad" : ratio > 0.7 ? "warn" : "accent";
  const over = has && projected !== undefined && projected > limit;
  let note: ReactNode = has ? `${Math.round(ratio * 100)}% of ${fmt(limit)}` : "no limit set";
  if (projected !== undefined) note = <>{note} · month end ≈ <span className={over ? "text-bad" : "text-ink-2"}>{fmt(projected)}</span></>;
  return (
    <div>
      <div className="mb-1 flex items-baseline justify-between gap-2 text-[12px]">
        <span className="text-ink-2">{label}</span>
        <span className="num"><span className="text-[15px] font-semibold text-ink">{fmt(value)}</span> <span className="text-ink-3">{note}</span></span>
      </div>
      <Meter value={has ? value : 0} max={has ? limit : 1} tone={tone} marker={has && projected !== undefined ? Math.min(projected, limit * 1.5) : undefined} />
    </div>
  );
}
