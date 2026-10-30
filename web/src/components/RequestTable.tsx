import type { RequestRow } from "../api";
import { fmtInt, fmtMs, fmtTime } from "../format";
import { statusTone } from "./RequestDrawer";
import { Badge, Table, Td, Th } from "./ui";

export function RequestTable({ rows, onOpen, showTenant = true }: { rows: RequestRow[]; onOpen: (id: string) => void; showTenant?: boolean }) {
  return (
    <Table>
      <thead><tr>
        <Th>Time</Th>{showTenant && <Th>Tenant</Th>}<Th>Endpoint</Th><Th>Asked → answered</Th><Th>Route</Th><Th>Status</Th>
        <Th right>Tokens</Th><Th right>Latency</Th><Th right>TTFT</Th><Th right>tok/s</Th><Th>Flags</Th>
      </tr></thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.id} onClick={() => onOpen(r.id)} className="cursor-pointer hover:bg-s2">
            <Td className="whitespace-nowrap text-ink-2 num">{fmtTime(r.ts, true)}</Td>
            {showTenant && <Td className="whitespace-nowrap">{r.tenant_id}</Td>}
            <Td className="whitespace-nowrap text-ink-3">{r.endpoint}</Td>
            <Td className="max-w-72 truncate"><span className="text-ink-3 font-mono text-[11.5px]">{r.requested_model || "∅"}</span> → <b className="font-medium">{r.model_id ?? "—"}</b></Td>
            <Td mono className="text-ink-2">{r.route ?? "—"}</Td>
            <Td><Badge tone={statusTone(r.status)} title={r.error ?? undefined}>{r.status}{r.error_type ? ` ${r.error_type}` : ""}</Badge></Td>
            <Td right>{fmtInt(r.prompt_tokens)} / {fmtInt(r.completion_tokens)}</Td>
            <Td right>{fmtMs(r.latency_ms)}</Td>
            <Td right>{fmtMs(r.ttft_ms)}</Td>
            <Td right>{r.tps ?? "—"}</Td>
            <Td className="whitespace-nowrap">
              <span className="inline-flex gap-1">
                {r.stream ? <Badge tone="muted">stream</Badge> : null}
                {r.tools ? <Badge tone="muted">{r.forced_tool ? "forced" : "tools"}</Badge> : null}
                {r.cold_start ? <Badge tone="warn">cold</Badge> : null}
                {r.fallbacks ? <Badge tone="warn">fallback</Badge> : null}
                {r.agent ? <Badge tone="accent">{r.agent}</Badge> : null}
              </span>
            </Td>
          </tr>
        ))}
      </tbody>
    </Table>
  );
}
