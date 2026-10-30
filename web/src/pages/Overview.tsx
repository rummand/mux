import { useState } from "react";
import type { RequestRow, Tenant } from "../api";
import { OverviewPanel, RANGE_OPTIONS } from "../components/OverviewPanel";
import { RequestDrawer, statusTone } from "../components/RequestDrawer";
import { Badge, Card, Empty, PageHeader, Segmented, Select } from "../components/ui";
import { fmtInt, fmtMs, fmtTime } from "../format";
import { useApi, useLive, usePersisted } from "../hooks";

export default function OverviewPage() {
  const [range, setRange] = usePersisted("overview.range", "24h");
  const [tenant, setTenant] = usePersisted("overview.tenant", "");
  const { data: tenants } = useApi<Tenant[]>("/tenants");
  const names = new Map((tenants ?? []).map((t) => [t.id, t.name]));
  return (
    <>
      <PageHeader title="Overview" subtitle="Every SaaS that calls mux, every model that answers." />
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <Segmented value={range} onChange={setRange} options={RANGE_OPTIONS} />
        <Select className="w-48" value={tenant} onChange={(e) => setTenant(e.target.value)}>
          <option value="">All tenants</option>
          {tenants?.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
        </Select>
      </div>
      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_320px]">
        <OverviewPanel range={range} tenant={tenant || undefined} nameOf={(id) => names.get(id) ?? id} />
        <LiveFeed tenant={tenant} />
      </div>
    </>
  );
}

function LiveFeed({ tenant }: { tenant: string }) {
  const [rows, setRows] = useState<RequestRow[]>([]);
  const [open, setOpen] = useState<string | null>(null);
  useLive<RequestRow>("request", (r) => { if (!tenant || r.tenant_id === tenant) setRows((xs) => [r, ...xs].slice(0, 60)); });
  return (
    <Card title="Live" subtitle="requests as they finish" pad={false} className="xl:sticky xl:top-16 xl:self-start">
      <div className="max-h-[calc(100vh-140px)] overflow-y-auto">
        {!rows.length ? <div className="p-4"><Empty>Waiting for traffic…</Empty></div> : rows.map((r) => (
          <button key={r.id} onClick={() => setOpen(r.id)} className="flash block w-full border-b border-line px-3 py-2 text-left hover:bg-s2">
            <div className="flex items-center justify-between gap-2">
              <span className="flex min-w-0 items-center gap-1.5">
                <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: r.tenant_color ?? "var(--accent)" }} />
                <span className="truncate text-[12.5px] font-medium">{r.tenant_name ?? r.tenant_id}</span>
              </span>
              <Badge tone={statusTone(r.status)}>{r.status}</Badge>
            </div>
            <div className="mt-0.5 flex justify-between gap-2 text-[11.5px] text-ink-3 num">
              <span className="truncate">{r.model_id ?? r.requested_model ?? "—"}{r.route ? ` · ${r.route}` : ""}</span>
              <span className="shrink-0">{fmtMs(r.latency_ms)} · {fmtInt(r.prompt_tokens + r.completion_tokens)} tok · {fmtTime(r.ts)}</span>
            </div>
            {r.error && <div className="mt-0.5 truncate text-[11.5px] text-bad">{r.error}</div>}
          </button>
        ))}
      </div>
      <RequestDrawer id={open} onClose={() => setOpen(null)} />
    </Card>
  );
}
