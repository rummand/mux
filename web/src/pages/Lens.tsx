import { useState } from "react";
import { api, type Finding, type LensRun, type Model, type Tenant } from "../api";
import { RequestDrawer } from "../components/RequestDrawer";
import { Badge, Button, Card, Empty, ErrorNote, Field, Input, PageHeader, Select, Spinner, Textarea, Toggle } from "../components/ui";
import { fmtAgo, fmtInt, fmtMs } from "../format";
import { useApi } from "../hooks";

export default function LensPage() {
  const runs = useApi<LensRun[]>("/lens", undefined, 4000);
  const [sel, setSel] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const run = runs.data?.find((r) => r.id === sel) ?? runs.data?.[0] ?? null;
  return (
    <>
      <PageHeader title="Lens" subtitle="Investigations of real traffic: rules count what fails and what's slow, then a local model reads samples against your criteria. Every finding links to its requests. Nothing leaves the Mac." />
      <div className="grid gap-4 xl:grid-cols-[380px_1fr]">
        <div className="space-y-4">
          <NewInvestigation onStarted={(id) => { setSel(id); void runs.reload(true); }} />
          <Card title="Investigations" pad={false}>
            {!runs.data?.length ? <div className="p-4"><Empty>None yet.</Empty></div> : runs.data.map((r) => (
              <button key={r.id} onClick={() => setSel(r.id)} className={`block w-full border-b border-line px-4 py-2.5 text-left hover:bg-s2 ${run?.id === r.id ? "bg-s2" : ""}`}>
                <div className="flex items-center justify-between gap-2"><span className="truncate text-[12.5px] font-medium">{r.title}</span>
                  {r.status === "running" ? <Badge tone="accent"><Spinner /> running</Badge> : r.status === "error" ? <Badge tone="bad">error</Badge> : <Badge tone="muted">{r.findings.length} findings</Badge>}</div>
                <div className="mt-0.5 text-[11.5px] text-ink-3">{fmtAgo(r.ts)} · {Object.entries(r.filters).filter(([, v]) => v).map(([k, v]) => `${k} ${v}`).join(" · ")}</div>
              </button>
            ))}
          </Card>
        </div>
        <div>{run ? <RunView run={run} onOpen={setOpen} /> : <Empty>Start an investigation to see findings.</Empty>}</div>
      </div>
      <RequestDrawer id={open} onClose={() => setOpen(null)} />
    </>
  );
}

function NewInvestigation({ onStarted }: { onStarted: (id: string) => void }) {
  const { data: tenants } = useApi<Tenant[]>("/tenants");
  const { data: models } = useApi<Model[]>("/models");
  const [f, setF] = useState({ title: "Daily check", tenantId: "", agent: "", model: "", hours: 24, sample: 100, criteria: "Is every tenant served well? What fails, what is slow, what wastes tokens or loops?", useModel: true, modelId: "" });
  const [err, setErr] = useState<string | null>(null);
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => setF((x) => ({ ...x, [k]: v }));
  const start = async () => {
    setErr(null);
    try {
      const r = await api<{ id: string }>("/lens", { body: { title: f.title, criteria: f.criteria, useModel: f.useModel, modelId: f.modelId || undefined,
        filters: { tenantId: f.tenantId || undefined, agent: f.agent || undefined, model: f.model || undefined, hours: f.hours, sample: f.sample } } });
      onStarted(r.id);
    } catch (e) { setErr((e as Error).message); }
  };
  return (
    <Card title="New investigation">
      <ErrorNote error={err} />
      <div className="grid grid-cols-2 gap-3">
        <Field label="Title" className="col-span-2"><Input value={f.title} onChange={(e) => set("title", e.target.value)} /></Field>
        <Field label="Tenant"><Select value={f.tenantId} onChange={(e) => set("tenantId", e.target.value)}><option value="">all</option>{tenants?.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</Select></Field>
        <Field label="Model"><Select value={f.model} onChange={(e) => set("model", e.target.value)}><option value="">all</option>{models?.map((m) => <option key={m.id} value={m.id}>{m.id}</option>)}</Select></Field>
        <Field label="Agent"><Input value={f.agent} onChange={(e) => set("agent", e.target.value)} placeholder="any" /></Field>
        <Field label="Review the last (hours)"><Input type="number" min={1} value={f.hours} onChange={(e) => set("hours", Number(e.target.value))} /></Field>
        <Field label="Sample (%)"><Input type="number" min={1} max={100} value={f.sample} onChange={(e) => set("sample", Number(e.target.value))} /></Field>
        <Field label="Analysis model"><Select value={f.modelId} onChange={(e) => set("modelId", e.target.value)} disabled={!f.useModel}><option value="">smart / auto route</option>{models?.filter((m) => m.kind === "chat").map((m) => <option key={m.id} value={m.id}>{m.id}</option>)}</Select></Field>
        <Field label="What should the agents be doing?" className="col-span-2"><Textarea rows={3} value={f.criteria} onChange={(e) => set("criteria", e.target.value)} /></Field>
        <div className="col-span-2 flex items-center justify-between"><Toggle checked={f.useModel} onChange={(v) => set("useModel", v)} label="Ask a local model too" /><Button variant="primary" onClick={start}>Run now</Button></div>
      </div>
    </Card>
  );
}

function RunView({ run, onOpen }: { run: LensRun; onOpen: (id: string) => void }) {
  const attention = run.findings.filter((f) => f.kind === "needs-attention");
  const patterns = run.findings.filter((f) => f.kind === "pattern");
  return (
    <div className="space-y-4">
      <Card title={run.title} subtitle={run.criteria}>
        <div className="flex flex-wrap gap-4 text-[12.5px] text-ink-2 num">
          <span>Status <b className="text-ink">{run.status}</b></span>
          {run.coverage && <><span>Eligible <b className="text-ink">{fmtInt(run.coverage.eligible)}</b></span><span>Screened <b className="text-ink">{fmtInt(run.coverage.screened)}</b></span><span>Failed <b className="text-ink">{fmtInt(run.coverage.errors)}</b></span></>}
          {run.model_id && <span>Model <b className="text-ink">{run.model_id}</b></span>}
          {run.duration_ms != null && <span>Took <b className="text-ink">{fmtMs(run.duration_ms)}</b></span>}
        </div>
        {run.error && <div className="mt-2 text-[12.5px] text-bad">{run.error}</div>}
      </Card>
      {run.status === "running" ? <Card><div className="flex items-center gap-2 text-[12.5px] text-ink-2"><Spinner /> Reading the traffic…</div></Card> : <>
        <Section title="Needs attention" findings={attention} onOpen={onOpen} />
        <Section title="Patterns" findings={patterns} onOpen={onOpen} />
        {!run.findings.length && <Empty>Nothing found — the slice looks healthy.</Empty>}
      </>}
    </div>
  );
}

function Section({ title, findings, onOpen }: { title: string; findings: Finding[]; onOpen: (id: string) => void }) {
  if (!findings.length) return null;
  return (
    <div>
      <h3 className="mb-2 text-[12px] font-semibold uppercase tracking-wide text-ink-3">{title} · {findings.length}</h3>
      <div className="space-y-3">
        {findings.map((f, i) => (
          <Card key={i} title={f.title} actions={<><Badge tone={f.priority === "high" ? "bad" : f.priority === "medium" ? "warn" : "muted"}>{f.priority}</Badge><Badge tone="muted">{f.source === "model" ? "model" : "rules"}</Badge></>}>
            <p className="text-[12.5px] text-ink-2">{f.description}</p>
            {f.suggestion && <p className="mt-2 rounded-md bg-accent-soft px-3 py-2 text-[12.5px]"><b>Next step:</b> {f.suggestion}</p>}
            {f.evidence.length > 0 && (
              <div className="mt-3">
                <div className="mb-1 text-[11px] font-medium uppercase tracking-wide text-ink-3">Evidence</div>
                <ul className="space-y-1">{f.evidence.map((e) => (
                  <li key={e.request_id} className="flex gap-2 text-[12px]"><button className="shrink-0 font-mono text-accent hover:underline" onClick={() => onOpen(e.request_id)}>{e.request_id.slice(0, 16)}</button><span className="truncate text-ink-3">{e.quote}</span></li>
                ))}</ul>
              </div>
            )}
          </Card>
        ))}
      </div>
    </div>
  );
}
