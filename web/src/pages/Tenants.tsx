import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api, type Tenant } from "../api";
import { Badge, Button, Card, Empty, ErrorNote, Field, Input, Meter, Modal, PageHeader, Table, Td, Th } from "../components/ui";
import { fmtAgo, fmtCompact, fmtInt, fmtPct } from "../format";
import { useApi } from "../hooks";

export default function TenantsPage() {
  const { data, error, reload } = useApi<Tenant[]>("/tenants", undefined, 15_000);
  const [creating, setCreating] = useState(false);
  return (
    <>
      <PageHeader title="Tenants" subtitle="Each SaaS (or agent fleet) that calls mux has its own keys, limits, routing and numbers."
        actions={<Button variant="primary" onClick={() => setCreating(true)}>New tenant</Button>} />
      <ErrorNote error={error} />
      <Card pad={false}>
        {!data?.length ? <div className="p-4"><Empty>No tenants yet. Create one, then give its SaaS a key.</Empty></div> : (
          <Table>
            <thead><tr><Th>Tenant</Th><Th>Status</Th><Th>Default route</Th><Th right>Keys</Th><Th right>Requests 24h</Th><Th right>Errors 24h</Th><Th right>Tokens 24h</Th><Th>Month budget</Th><Th>Limits</Th><Th right>Last call</Th></tr></thead>
            <tbody>
              {data.map((t) => {
                const n = t.usage24h?.n ?? 0, e = t.usage24h?.errors ?? 0;
                return (
                  <tr key={t.id} className="hover:bg-s2">
                    <Td>
                      <Link to={`/tenants/${t.id}`} className="flex items-center gap-2 font-medium hover:text-accent">
                        <span className="h-2.5 w-2.5 rounded-full" style={{ background: t.color }} />{t.name}
                        <span className="font-mono text-[11px] text-ink-3">{t.id}</span>
                      </Link>
                      {t.description && <div className="mt-0.5 max-w-80 truncate text-[11.5px] text-ink-3">{t.description}</div>}
                    </Td>
                    <Td><Badge tone={t.status === "active" ? "good" : "warn"}>{t.status}</Badge></Td>
                    <Td mono>{t.default_route}</Td>
                    <Td right>{typeof t.keys === "number" ? t.keys : "—"}</Td>
                    <Td right>{fmtInt(n)}</Td>
                    <Td right className={e ? "text-bad" : ""}>{fmtInt(e)} {n ? <span className="text-ink-3">{fmtPct(e / n, 0)}</span> : null}</Td>
                    <Td right>{fmtCompact(t.usage24h?.tokens ?? 0)}</Td>
                    <Td className="w-40">
                      {t.monthly_token_budget ? (
                        <div><Meter value={t.monthTokens ?? 0} max={t.monthly_token_budget} tone={(t.monthTokens ?? 0) / t.monthly_token_budget > 0.9 ? "bad" : "accent"} />
                          <div className="mt-0.5 text-[11px] text-ink-3 num">{fmtCompact(t.monthTokens ?? 0)} / {fmtCompact(t.monthly_token_budget)}</div></div>
                      ) : <span className="text-[11.5px] text-ink-3 num">{fmtCompact(t.monthTokens ?? 0)} · no cap</span>}
                    </Td>
                    <Td className="text-[11.5px] text-ink-3 num">{[t.rpm_limit && `${t.rpm_limit} rpm`, t.tpm_limit && `${fmtCompact(t.tpm_limit)} tpm`, t.max_parallel && `${t.max_parallel} parallel`].filter(Boolean).join(" · ") || "none"}</Td>
                    <Td right className="text-ink-3">{fmtAgo(t.usage24h?.last)}</Td>
                  </tr>
                );
              })}
            </tbody>
          </Table>
        )}
      </Card>
      <NewTenant open={creating} onClose={() => setCreating(false)} onDone={reload} />
    </>
  );
}

function NewTenant({ open, onClose, onDone }: { open: boolean; onClose: () => void; onDone: () => void }) {
  const nav = useNavigate();
  const [name, setName] = useState("");
  const [id, setId] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const slug = id || name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  const save = async () => {
    try {
      await api(`/tenants/${slug}`, { method: "PUT", body: { name } });
      onDone(); onClose(); nav(`/tenants/${slug}`);
    } catch (e) { setErr((e as Error).message); }
  };
  return (
    <Modal open={open} onClose={onClose} title="New tenant" footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" disabled={!slug || !name} onClick={save}>Create</Button></>}>
      <ErrorNote error={err} />
      <div className="space-y-3">
        <Field label="Name"><Input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="Acme Support Bot" /></Field>
        <Field label="Id" hint="Lowercase letters, digits and dashes; it appears in logs and URLs."><Input value={slug} onChange={(e) => setId(e.target.value)} className="font-mono" /></Field>
      </div>
    </Modal>
  );
}
