import { useNavigate } from "react-router-dom";
import type { Tenant, TraceRow } from "../api";
import { RANGE_OPTIONS } from "../components/OverviewPanel";
import { Badge, Card, Empty, PageHeader, Segmented, Select, Table, Td, Th } from "../components/ui";
import { fmtCompact, fmtInt, fmtMs, fmtTime } from "../format";
import { useApi, usePersisted } from "../hooks";

export default function TracesPage() {
  const [range, setRange] = usePersisted("traces.range", "24h");
  const [tenant, setTenant] = usePersisted("traces.tenant", "");
  const { data: tenants } = useApi<Tenant[]>("/tenants");
  const { data } = useApi<TraceRow[]>("/traces", { range, tenant: tenant || undefined }, 15_000);
  const nav = useNavigate();
  return (
    <>
      <PageHeader title="Traces" subtitle={<>Agent runs: calls sharing an <span className="font-mono">x-mux-trace-id</span>. Click one for its requests.</>} />
      <div className="mb-3 flex flex-wrap gap-2">
        <Segmented value={range} onChange={setRange} options={RANGE_OPTIONS} />
        <Select className="w-48" value={tenant} onChange={(e) => setTenant(e.target.value)}><option value="">All tenants</option>{tenants?.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</Select>
      </div>
      <Card pad={false}>
        {!data?.length ? <div className="p-4"><Empty>No traces in this range. Send <span className="mx-1 font-mono">x-mux-trace-id</span> with each call of an agent run to see them here.</Empty></div> : (
          <Table>
            <thead><tr><Th>Trace</Th><Th>Tenant</Th><Th>Agent</Th><Th>Started</Th><Th right>Calls</Th><Th right>Tool calls</Th><Th right>Tokens</Th><Th right>Model time</Th><Th right>Wall time</Th><Th>Errors</Th><Th>Models</Th></tr></thead>
            <tbody>{data.map((t) => (
              <tr key={t.trace_id} className="cursor-pointer hover:bg-s2" onClick={() => nav(`/requests?trace=${encodeURIComponent(t.trace_id)}`)}>
                <Td mono className="max-w-56 truncate">{t.trace_id}</Td><Td>{t.tenant_id}</Td><Td>{t.agent ?? "—"}</Td><Td className="text-ink-2 num">{fmtTime(t.started, true)}</Td>
                <Td right>{fmtInt(t.calls)}</Td><Td right>{fmtInt(t.tool_calls)}</Td><Td right>{fmtCompact(t.prompt_tokens + t.completion_tokens)}</Td>
                <Td right>{fmtMs(t.total_ms)}</Td><Td right>{fmtMs(t.ended - t.started)}</Td>
                <Td>{t.errors ? <Badge tone="bad">{t.errors}</Badge> : <Badge tone="good">0</Badge>}</Td><Td className="max-w-48 truncate text-[11.5px] text-ink-3">{t.models}</Td>
              </tr>
            ))}</tbody>
          </Table>
        )}
      </Card>
    </>
  );
}
