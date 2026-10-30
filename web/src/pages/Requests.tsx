import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { api, type Model, type RequestRow, type Tenant } from "../api";
import { RequestDrawer } from "../components/RequestDrawer";
import { RequestTable } from "../components/RequestTable";
import { Button, Card, Empty, ErrorNote, Input, PageHeader, Segmented, Select, Spinner } from "../components/ui";
import { useApi } from "../hooks";

export default function RequestsPage() {
  const [params, setParams] = useSearchParams();
  const f = { tenant: params.get("tenant") ?? "", model: params.get("model") ?? "", status: params.get("status") ?? "", agent: params.get("agent") ?? "", trace: params.get("trace") ?? "", q: params.get("q") ?? "" };
  const set = (k: keyof typeof f, v: string) => { const p = new URLSearchParams(params); v ? p.set(k, v) : p.delete(k); setParams(p, { replace: true }); };
  const { data: tenants } = useApi<Tenant[]>("/tenants");
  const { data: models } = useApi<Model[]>("/models");
  const [rows, setRows] = useState<RequestRow[]>([]);
  const [more, setMore] = useState(true);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(params.get("open"));
  const [q, setQ] = useState(f.q);
  const key = JSON.stringify(f);

  const load = async (before?: number) => {
    setLoading(true);
    try {
      const r = await api<RequestRow[]>("/requests", { query: { ...f, limit: 100, before } });
      setRows((xs) => (before ? [...xs, ...r] : r));
      setMore(r.length === 100);
      setErr(null);
    } catch (e) { setErr((e as Error).message); } finally { setLoading(false); }
  };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { void load(); }, [key]);

  return (
    <>
      <PageHeader title="Requests" subtitle="Every call through mux, newest first." actions={<Button onClick={() => load()}>{loading ? <Spinner /> : "Refresh"}</Button>} />
      <div className="mb-3 flex flex-wrap gap-2">
        <Select className="w-44" value={f.tenant} onChange={(e) => set("tenant", e.target.value)}><option value="">All tenants</option>{tenants?.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</Select>
        <Select className="w-52" value={f.model} onChange={(e) => set("model", e.target.value)}><option value="">All models</option>{models?.map((m) => <option key={m.id} value={m.id}>{m.id}</option>)}</Select>
        <Segmented value={f.status || "all"} onChange={(v) => set("status", v === "all" ? "" : v)} options={[{ value: "all", label: "All" }, { value: "ok", label: "OK" }, { value: "error", label: "Errors" }]} />
        <Input className="w-36" placeholder="Agent" value={f.agent} onChange={(e) => set("agent", e.target.value)} />
        <Input className="w-44 font-mono" placeholder="Trace id" value={f.trace} onChange={(e) => set("trace", e.target.value)} />
        <form onSubmit={(e) => { e.preventDefault(); set("q", q); }}><Input className="w-64" placeholder="Search id, error, routing, model…" value={q} onChange={(e) => setQ(e.target.value)} /></form>
      </div>
      <ErrorNote error={err} />
      <Card pad={false}>
        {!rows.length && !loading ? <div className="p-4"><Empty>No requests match.</Empty></div> : <RequestTable rows={rows} onOpen={setOpen} />}
        {more && rows.length > 0 && <div className="p-3 text-center"><Button onClick={() => load(rows[rows.length - 1].ts)} disabled={loading}>Load more</Button></div>}
      </Card>
      <RequestDrawer id={open} onClose={() => setOpen(null)} />
    </>
  );
}
