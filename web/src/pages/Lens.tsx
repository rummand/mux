import { useState } from "react";
import { api, type Finding, type LensMetrics, type LensMute, type LensRun, type LensWatch, type Model, type Tenant } from "../api";
import { askAssistant } from "../components/Assistant";
import { RequestDrawer } from "../components/RequestDrawer";
import { Badge, Button, Card, cx, Empty, ErrorNote, Field, Input, PageHeader, Select, Spinner, Tabs, Textarea, Toggle } from "../components/ui";
import { fmtAgo, fmtDuration, fmtInt, fmtMs, fmtPct } from "../format";
import { useApi } from "../hooks";

/**
 * Lens: investigations of real traffic. Rules count what fails, what is slow and what costs; a local model reads samples
 * against your criteria and what mux's brain says should hold. Each run is compared with the one before; watches repeat
 * an investigation on a schedule; every finding can go to the assistant, into the brain, or be muted.
 */
export default function LensPage() {
  const [tab, setTab] = useState<"runs" | "watches" | "muted">("runs");
  const runs = useApi<LensRun[]>("/lens", undefined, 4000);
  const watches = useApi<LensWatch[]>("/lens/watches", undefined, 15_000);
  const mutes = useApi<LensMute[]>("/lens/mutes");
  const [sel, setSel] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const run = runs.data?.find((r) => r.id === sel) ?? runs.data?.[0] ?? null;
  const names = new Map((watches.data ?? []).map((w) => [w.id, w.title]));
  const show = (id: string) => { setSel(id); setTab("runs"); void runs.reload(true); };
  return (
    <>
      <PageHeader title="Lens" subtitle="Investigations of real traffic: rules count what fails, what is slow and what costs; a local model reads samples against your criteria and against what mux's brain says should hold. Each run is compared with the one before. Nothing leaves the Mac." />
      <div className="mb-4">
        <Tabs value={tab} onChange={setTab} tabs={[
          { value: "runs", label: "Investigations", count: runs.data?.length },
          { value: "watches", label: "Watches", count: watches.data?.filter((w) => w.enabled).length },
          { value: "muted", label: "Muted", count: mutes.data?.length },
        ]} />
      </div>
      {tab === "runs" && (
        <div className="grid gap-4 xl:grid-cols-[380px_minmax(0,1fr)]">
          <div className="space-y-4">
            <NewInvestigation onStarted={(id) => { show(id); void watches.reload(true); }} />
            <Card title="Investigations" pad={false}>
              {!runs.data?.length ? <div className="p-4"><Empty>None yet.</Empty></div> : runs.data.map((r) => {
                const fresh = r.findings.filter((f) => f.status === "new" && f.kind === "needs-attention").length;
                return (
                  <button key={r.id} onClick={() => setSel(r.id)} className={cx("block w-full border-b border-line px-4 py-2.5 text-left hover:bg-s2", run?.id === r.id && "bg-s2")}>
                    <div className="flex items-center justify-between gap-2"><span className="truncate text-[12.5px] font-medium">{r.title}</span>
                      {r.status === "running" ? <Badge tone="accent"><Spinner /> running</Badge> : r.status === "error" ? <Badge tone="bad">error</Badge>
                        : <span className="flex shrink-0 gap-1">{fresh > 0 && <Badge tone="bad">{fresh} new</Badge>}<Badge tone="muted">{r.findings.length} findings</Badge></span>}</div>
                    <div className="mt-0.5 truncate text-[11.5px] text-ink-3">{fmtAgo(r.ts)}{r.watch_id ? ` · watch ${names.get(r.watch_id) ?? r.watch_id}` : ""} · {scope(r.filters)}</div>
                  </button>
                );
              })}
            </Card>
          </div>
          <div>{run ? <RunView run={run} onOpen={setOpen} onMuted={() => { void mutes.reload(true); }} /> : <Empty>Start an investigation to see findings.</Empty>}</div>
        </div>
      )}
      {tab === "watches" && <Watches watches={watches.data ?? []} reload={() => void watches.reload(true)} onShow={show} />}
      {tab === "muted" && <Muted mutes={mutes.data ?? []} reload={() => void mutes.reload(true)} />}
      <RequestDrawer id={open} onClose={() => setOpen(null)} />
    </>
  );
}

const scope = (f: LensRun["filters"]) => [f.tenantId && `tenant ${f.tenantId}`, f.agent && `agent ${f.agent}`, f.model && `model ${f.model}`, `last ${f.hours ?? 24}h`, f.sample && f.sample < 100 && `${f.sample}% sample`].filter(Boolean).join(" · ");
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "watch";

function NewInvestigation({ onStarted }: { onStarted: (id: string) => void }) {
  const { data: tenants } = useApi<Tenant[]>("/tenants");
  const { data: models } = useApi<Model[]>("/models");
  const [f, setF] = useState({ title: "Daily check", tenantId: "", agent: "", model: "", hours: 24, sample: 100, every: 0, criteria: "Is every tenant served well and as the brain says it should be? What fails, what is slow, what wastes tokens or money, what loops?", useModel: true, modelId: "" });
  const [err, setErr] = useState<string | null>(null);
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => setF((x) => ({ ...x, [k]: v }));
  const start = async () => {
    setErr(null);
    const filters = { tenantId: f.tenantId || undefined, agent: f.agent || undefined, model: f.model || undefined, hours: f.hours, sample: f.sample };
    try {
      if (f.every) {
        // A watch: kept, run now and then every so often.
        const id = slug(f.title);
        await api(`/lens/watches/${id}`, { method: "PUT", body: { title: f.title, filters, criteria: f.criteria, every_hours: f.every, use_model: f.useModel, model_id: f.modelId || null, enabled: true } });
        onStarted((await api<{ id: string }>(`/lens/watches/${id}/run`, { method: "POST" })).id);
      } else {
        onStarted((await api<{ id: string }>("/lens", { body: { title: f.title, criteria: f.criteria, useModel: f.useModel, modelId: f.modelId || undefined, filters } })).id);
      }
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
        <Field label="Repeat"><Select value={f.every} onChange={(e) => set("every", Number(e.target.value))}>
          <option value={0}>once</option><option value={1}>every hour</option><option value={6}>every 6 hours</option><option value={24}>every day</option><option value={168}>every week</option>
        </Select></Field>
        <Field label="Analysis model" className="col-span-2"><Select value={f.modelId} onChange={(e) => set("modelId", e.target.value)} disabled={!f.useModel}><option value="">smart / auto route</option>{models?.filter((m) => m.kind === "chat").map((m) => <option key={m.id} value={m.id}>{m.id}</option>)}</Select></Field>
        <Field label="What should the agents be doing?" className="col-span-2"><Textarea rows={3} value={f.criteria} onChange={(e) => set("criteria", e.target.value)} /></Field>
        <div className="col-span-2 flex items-center justify-between"><Toggle checked={f.useModel} onChange={(v) => set("useModel", v)} label="Ask a local model too" /><Button variant="primary" onClick={start}>{f.every ? "Watch" : "Run now"}</Button></div>
      </div>
    </Card>
  );
}

function RunView({ run, onOpen, onMuted }: { run: LensRun; onOpen: (id: string) => void; onMuted: () => void }) {
  const attention = run.findings.filter((f) => f.kind === "needs-attention");
  const patterns = run.findings.filter((f) => f.kind === "pattern");
  const fresh = run.findings.filter((f) => f.status === "new");
  return (
    <div className="space-y-4">
      <Card title={run.title} subtitle={run.criteria}
        actions={run.status === "done" && run.findings.length > 0 && <Button size="sm" onClick={() => askAssistant(`Lens investigation ${run.id} (“${run.title}”, ${scope(run.filters)}) found ${run.findings.length} things${fresh.length ? `, ${fresh.length} of them new` : ""}. Read it (GET /lens/runs/${run.id}), work out which matter most and why, and propose the fixes.`)}>Ask mux</Button>}>
        <div className="flex flex-wrap gap-4 text-[12.5px] text-ink-2 num">
          <span>Status <b className="text-ink">{run.status}</b></span>
          {run.coverage && <><span>Eligible <b className="text-ink">{fmtInt(run.coverage.eligible)}</b></span><span>Screened <b className="text-ink">{fmtInt(run.coverage.screened)}</b></span><span>Failed <b className="text-ink">{fmtInt(run.coverage.errors)}</b></span></>}
          {run.model_id && <span>Model <b className="text-ink">{run.model_id}</b></span>}
          {run.duration_ms != null && <span>Took <b className="text-ink">{fmtMs(run.duration_ms)}</b></span>}
          {!!run.muted && <span>Muted <b className="text-ink">{run.muted}</b></span>}
        </div>
        {run.error && <div className="mt-2 text-[12.5px] text-bad">{run.error}</div>}
        {run.baseline && <Baseline now={run.baseline.now} before={run.baseline.before} hours={run.filters.hours ?? 24} />}
      </Card>
      {run.status === "running" ? <Card><div className="flex items-center gap-2 text-[12.5px] text-ink-2"><Spinner /> Reading the traffic…</div></Card> : <>
        <Section title="Needs attention" findings={attention} run={run} onOpen={onOpen} onMuted={onMuted} />
        <Section title="Patterns" findings={patterns} run={run} onOpen={onOpen} onMuted={onMuted} />
        {!run.findings.length && run.status === "done" && <Empty>Nothing found — the slice looks healthy.</Empty>}
        {!!run.resolved?.length && (
          <div>
            <h3 className="mb-2 text-[12px] font-semibold uppercase tracking-wide text-ink-3">Resolved since the last run · {run.resolved.length}</h3>
            <Card><ul className="space-y-1 text-[12.5px]">{run.resolved.map((r) => <li key={r.key} className="flex gap-2"><span className="text-good">✓</span><span className="text-ink-2">{r.title}</span></li>)}</ul></Card>
          </div>
        )}
      </>}
    </div>
  );
}

/** This window against the one before it: what got better and what got worse. */
function Baseline({ now, before, hours }: { now: LensMetrics; before: LensMetrics; hours: number }) {
  const cells: { label: string; a: number | null; b: number | null; fmt: (x: number) => string; worseUp?: boolean }[] = [
    { label: "Requests", a: now.requests, b: before.requests, fmt: fmtInt },
    { label: "Error rate", a: now.errorRate, b: before.errorRate, fmt: (x) => fmtPct(x), worseUp: true },
    { label: "Latency p95", a: now.latencyP95, b: before.latencyP95, fmt: fmtMs, worseUp: true },
    { label: "First token p50", a: now.ttftP50, b: before.ttftP50, fmt: fmtMs, worseUp: true },
    { label: "Tokens / request", a: now.tokensPerRequest, b: before.tokensPerRequest, fmt: fmtInt, worseUp: true },
    { label: "Spend", a: now.costUsd, b: before.costUsd, fmt: (x) => `$${x.toFixed(2)}`, worseUp: true },
  ];
  return (
    <div className="mt-3 border-t border-line pt-3">
      <div className="mb-2 text-[11px] text-ink-3">These {hours} hours against the {hours} before</div>
      <div className="grid grid-cols-[repeat(auto-fill,minmax(120px,1fr))] gap-3">
        {cells.map((c) => {
          const d = c.a != null && c.b != null && c.b > 0 ? (c.a - c.b) / c.b : null;
          const worse = d != null && Math.abs(d) >= 0.1 && c.worseUp !== undefined && (d > 0) === c.worseUp;
          const better = d != null && Math.abs(d) >= 0.1 && c.worseUp !== undefined && !worse;
          return (
            <div key={c.label}>
              <div className="text-[10.5px] uppercase tracking-wide text-ink-3">{c.label}</div>
              <div className="num text-[14px]">{c.a != null ? c.fmt(c.a) : "—"}</div>
              <div className={cx("num text-[11px]", worse ? "text-bad" : better ? "text-good" : "text-ink-3")}>
                {d == null ? (c.b ? "" : "no earlier data") : `${d > 0 ? "▲" : d < 0 ? "▼" : "="} ${Math.abs(d * 100).toFixed(0)}% · was ${c.b != null ? c.fmt(c.b) : "—"}`}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function Section({ title, findings, run, onOpen, onMuted }: { title: string; findings: Finding[]; run: LensRun; onOpen: (id: string) => void; onMuted: () => void }) {
  if (!findings.length) return null;
  return (
    <div>
      <h3 className="mb-2 text-[12px] font-semibold uppercase tracking-wide text-ink-3">{title} · {findings.length}</h3>
      <div className="space-y-3">{findings.map((f) => <FindingCard key={f.key} f={f} run={run} onOpen={onOpen} onMuted={onMuted} />)}</div>
    </div>
  );
}

function FindingCard({ f, run, onOpen, onMuted }: { f: Finding; run: LensRun; onOpen: (id: string) => void; onMuted: () => void }) {
  const [note, setNote] = useState<string | null>(null);
  const evidence = f.evidence.map((e) => `- ${e.request_id}: ${e.quote}`).join("\n");
  const remember = async () => {
    try {
      await api("/brain", { body: { title: f.title, kind: "incident", subject: run.filters.tenantId ?? run.filters.model ?? "", tags: ["lens", f.priority],
        body: `Found by Lens (“${run.title}”, ${new Date(run.ts).toISOString().slice(0, 10)}, ${scope(run.filters)}).\n\n${f.description}\n\n**Next step:** ${f.suggestion}${evidence ? `\n\nEvidence:\n${evidence}` : ""}` } });
      setNote("Remembered in the brain.");
    } catch (e) { setNote((e as Error).message); }
  };
  const mute = async (days?: number) => {
    await api("/lens/mutes", { body: { key: f.key, title: f.title, days } }).catch((e) => setNote((e as Error).message));
    setNote(days ? `Muted for ${days} days: later runs leave it out.` : "Muted: later runs leave it out.");
    onMuted();
  };
  const ask = () => askAssistant(`Lens found this (${f.priority}, ${f.kind}, ${f.status ?? "new"}) in “${run.title}” (${scope(run.filters)}):\n\n**${f.title}**\n${f.description}\n\nIts suggestion: ${f.suggestion}${evidence ? `\n\nEvidence:\n${evidence}` : ""}\n\nFind the cause and propose the fix.`);
  return (
    <Card title={f.title} actions={<>
      {f.status && <Badge tone={f.status === "new" ? "accent" : "muted"}>{f.status}</Badge>}
      <Badge tone={f.priority === "high" ? "bad" : f.priority === "medium" ? "warn" : "muted"}>{f.priority}</Badge>
      <Badge tone="muted">{f.source === "model" ? "model" : "rules"}</Badge>
    </>}>
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
      <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-line pt-3">
        <Button size="sm" variant="primary" onClick={ask}>Ask mux</Button>
        <Button size="sm" onClick={() => void remember()}>Remember</Button>
        <Button size="sm" variant="ghost" onClick={() => void mute(7)}>Mute 7 days</Button>
        <Button size="sm" variant="ghost" onClick={() => void mute()}>Mute</Button>
        {note && <span className="text-[11.5px] text-ink-3">{note}</span>}
      </div>
    </Card>
  );
}

function Watches({ watches, reload, onShow }: { watches: LensWatch[]; reload: () => void; onShow: (runId: string) => void }) {
  const [err, setErr] = useState<string | null>(null);
  const put = (w: LensWatch, patch: Partial<LensWatch>) => api(`/lens/watches/${encodeURIComponent(w.id)}`, { method: "PUT", body: patch }).then(reload).catch((e) => setErr((e as Error).message));
  const run = async (w: LensWatch) => { try { onShow((await api<{ id: string }>(`/lens/watches/${encodeURIComponent(w.id)}/run`, { method: "POST" })).id); reload(); } catch (e) { setErr((e as Error).message); } };
  const remove = async (w: LensWatch) => { if (confirm(`Stop and delete the watch “${w.title}”?`)) { await api(`/lens/watches/${encodeURIComponent(w.id)}`, { method: "DELETE" }).catch((e) => setErr((e as Error).message)); reload(); } };
  return (
    <div className="space-y-3">
      <p className="text-[12.5px] text-ink-3">A watch repeats an investigation on its own. When a run finds something new that needs attention, mux logs a warning — mux (when you ask it) and the healer see it. Make one with “Repeat” on a new investigation.</p>
      <ErrorNote error={err} />
      {!watches.length && <Empty>No watches.</Empty>}
      {watches.map((w) => (
        <Card key={w.id} title={w.title} subtitle={`${scope(w.filters)}${w.use_model ? ` · with ${w.model_id ?? "a local model"}` : " · rules only"}`}
          actions={<><Toggle checked={w.enabled} onChange={(v) => void put(w, { enabled: v })} label={w.enabled ? "on" : "off"} /><Button size="sm" onClick={() => void run(w)}>Run now</Button><Button size="sm" variant="ghost" onClick={() => void remove(w)}>Delete</Button></>}>
          <div className="flex flex-wrap items-center gap-4 text-[12.5px] text-ink-2">
            <label className="flex items-center gap-2">Every
              <Select className="w-32" value={w.every_hours} onChange={(e) => void put(w, { every_hours: Number(e.target.value) })}>
                {[...new Set([1, 6, 24, 168, w.every_hours])].sort((a, b) => a - b).map((h) => <option key={h} value={h}>{h === 168 ? "week" : h === 24 ? "day" : h === 1 ? "hour" : `${h} hours`}</option>)}
              </Select>
            </label>
            <span>Last run {w.last_run ? (w.last_run_id ? <button className="text-accent hover:underline" onClick={() => onShow(w.last_run_id!)}>{fmtAgo(w.last_run)}</button> : fmtAgo(w.last_run)) : "never"}</span>
            {w.enabled && <span>Next {w.next_run && w.next_run > Date.now() ? `in ${fmtDuration((w.next_run - Date.now()) / 1000)}` : "within a minute"}</span>}
          </div>
          {w.criteria && <p className="mt-2 text-[12px] text-ink-3">{w.criteria}</p>}
        </Card>
      ))}
    </div>
  );
}

function Muted({ mutes, reload }: { mutes: LensMute[]; reload: () => void }) {
  const unmute = async (m: LensMute) => { await api(`/lens/mutes/${encodeURIComponent(m.key)}`, { method: "DELETE" }); reload(); };
  return (
    <Card title="Muted findings" subtitle="Later investigations leave these out (they still count how many they hid)." pad={false}>
      {!mutes.length ? <div className="p-4"><Empty>Nothing muted.</Empty></div> : mutes.map((m) => (
        <div key={m.key} className="flex items-center gap-3 border-b border-line px-4 py-2.5 text-[12.5px]">
          <div className="min-w-0 flex-1"><div className="truncate">{m.title}</div><div className="truncate font-mono text-[11px] text-ink-3">{m.key}</div></div>
          <span className="shrink-0 text-[11.5px] text-ink-3">{m.until ? `until ${new Date(m.until).toISOString().slice(0, 10)}` : "for good"}</span>
          <Button size="sm" onClick={() => void unmute(m)}>Unmute</Button>
        </div>
      ))}
    </Card>
  );
}
