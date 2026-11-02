import { useState } from "react";
import { api, type Advice, type Insight, type Route, type Trending, type UsageRow } from "../api";
import { askAssistant } from "../components/Assistant";
import { Badge, Button, Card, cx, Empty, ErrorNote, Meter, PageHeader, Segmented, Spinner, Table, Td, Th } from "../components/ui";
import { fmtAgo, fmtCompact, fmtGb, fmtInt, fmtMs, fmtPct } from "../format";
import { useApi, usePersisted } from "../hooks";

interface AdviceResult { useCase: string; budgetGb: number; diskFreeGb: number; memTotalGb: number; ranked: Advice[] }
interface Stack { budgetGb: number; residentGb: number; plan: { lane: string; pick: Advice | null; alwaysOn: boolean }[] }

const CAPS = ["quality", "speed", "tools", "code", "reasoning", "multilingual", "vision"] as const;

export default function AdvisorPage() {
  const { data: cases } = useApi<{ id: string; label: string }[]>("/advisor/use-cases");
  const [uc, setUc] = usePersisted("advisor.uc", "agent");
  const [priority, setPriority] = usePersisted<"quality" | "balanced" | "speed">("advisor.priority", "balanced");
  const { data, error, loading } = useApi<AdviceResult>("/advisor", { useCase: uc, priority });
  const stack = useApi<Stack>("/advisor/stack");
  const routes = useApi<Route[]>("/routes");
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const download = async (a: Advice) => {
    setErr(null);
    try { await api("/downloads", { body: { catalogId: a.id } }); setMsg(`Downloading ${a.name} — follow it on Models.`); } catch (e) { setErr((e as Error).message); }
  };
  const useIn = async (a: Advice, routeName: string) => {
    const r = routes.data?.find((x) => x.name === routeName);
    if (!r || !a.modelId) return;
    await api(`/routes/${r.name}`, { method: "PUT", body: { ...r, candidates: [a.modelId, ...r.candidates.filter((c) => c !== a.modelId)] } });
    setMsg(`${a.modelId} is now first on ${r.name}.`); void routes.reload(true);
  };
  return (
    <>
      <PageHeader title="Model advisor" subtitle="Which model to run for what, on this Mac. What mux measures itself counts most — its own traffic and benchmarks — then the published results behind each estimate, and least what the world downloads." />
      <ErrorNote error={error ?? err} />
      {msg && <div className="mb-3 rounded-md bg-accent-soft px-3 py-2 text-[12.5px]">{msg}</div>}
      <WhatToDo onDone={(m) => { setMsg(m); void routes.reload(true); }} />
      <div className="mb-4 flex flex-wrap items-center gap-2">
        {cases?.map((c) => (
          <button key={c.id} onClick={() => setUc(c.id)} className={`rounded-full border px-3 py-1 text-[12.5px] ${uc === c.id ? "border-accent bg-accent-soft text-ink" : "border-line-strong text-ink-2 hover:text-ink"}`}>{c.label}</button>
        ))}
        <div className="flex-1" />
        <Segmented value={priority} onChange={setPriority} options={[{ value: "speed", label: "Speed" }, { value: "balanced", label: "Balanced" }, { value: "quality", label: "Quality" }]} />
      </div>
      {data && <p className="mb-3 text-[12px] text-ink-3 num">Budget {data.budgetGb} GB of {data.memTotalGb.toFixed(0)} GB · {data.diskFreeGb.toFixed(0)} GB disk free {loading && <Spinner />}</p>}
      <div className="grid gap-3 lg:grid-cols-2 2xl:grid-cols-3">
        {data?.ranked.slice(0, 12).map((a, i) => (
          <Card key={a.id} className={i === 0 ? "border-accent" : ""} title={<span className="flex items-center gap-2"><span className="text-ink-3 num">#{i + 1}</span>{a.name}</span>}
            subtitle={`${a.params}${a.activeParams ? ` (${a.activeParams} active)` : ""} · ${a.sizeGb.toFixed(1)} GB · ${a.license} · ${a.released}`}
            actions={<><Badge tone={a.fit === "fits" ? "good" : a.fit === "tight" ? "warn" : "bad"}>{a.fit === "fits" ? "fits" : a.fit === "tight" ? "tight" : "too big"}</Badge>{a.installed && <Badge tone="accent">installed</Badge>}{a.supersededBy && <Badge tone="muted" title={`Superseded by ${a.supersededBy}`}>superseded</Badge>}{a.experimental && <Badge tone="warn" title={a.experimental}>experimental</Badge>}</>}>
            <div className="mb-3 grid grid-cols-[70px_1fr_64px] items-center gap-2 text-[12px] whitespace-nowrap">
              <span className="text-ink-3">Score</span><Meter value={a.score} max={10} /><span className="num text-right font-semibold">{a.score.toFixed(1)}</span>
              <span className="text-ink-3">Memory</span><Meter value={a.needGb} max={data.budgetGb} tone={a.fit === "fits" ? "good" : a.fit === "tight" ? "warn" : "bad"} /><span className="num text-right">{a.needGb} GB</span>
            </div>
            <div className="mb-3 grid grid-cols-2 gap-x-4 gap-y-1">
              {CAPS.filter((k) => a.caps[k] != null).map((k) => (
                <div key={k} className="grid grid-cols-[78px_1fr_22px] items-center gap-2 text-[11.5px]">
                  <span className="capitalize text-ink-3">{k}</span><Meter value={a.caps[k] ?? 0} max={10} height={4} /><span className="num text-right text-ink-2">{a.caps[k]}</span>
                </div>
              ))}
            </div>
            {a.measured && <div className="mb-2 text-[12px] text-ink-2 num">Benchmarked here: <b>{a.measured.tps?.toFixed(0)} tok/s</b>, {fmtPct(a.measured.score, 0)} of checks, first token {Math.round(a.measured.ttftMs)} ms</div>}
            {a.usage && <div className="mb-2 text-[12px] text-ink-2 num">In use here: <b>{fmtInt(a.usage.requests)} requests</b> in 30 days from {a.usage.tenants} tenant{a.usage.tenants === 1 ? "" : "s"}, <span className={a.usage.errorRate > 0.02 ? "text-bad" : ""}>{fmtPct(a.usage.errorRate, 1)} failed</span>{a.usage.tps ? `, ${a.usage.tps.toFixed(0)} tok/s` : ""}</div>}
            {!!a.onRoutes?.length && <div className="mb-2 flex flex-wrap gap-1">{a.onRoutes.map((o) => <Badge key={o.route} tone={o.position === 1 ? "accent" : "muted"}>{o.route} #{o.position}</Badge>)}</div>}
            {a.web && !a.web.error && <div className="mb-2 text-[11.5px] text-ink-3 num">Hugging Face: {fmtCompact((a.web.downloads ?? 0) + (a.web.baseDownloads ?? 0))} downloads in 30 days · {fmtInt((a.web.likes ?? 0) + (a.web.baseLikes ?? 0))} likes{a.web.popularity != null ? ` · popularity ${a.web.popularity}/10` : ""} · <a className="text-accent hover:underline" href={`https://huggingface.co/${a.web.baseRepo ?? a.web.repo}`} target="_blank" rel="noreferrer">model page</a></div>}
            <ul className="mb-2 space-y-0.5 text-[11.5px] text-ink-2">{a.reasons.filter((r) => !/on Hugging Face|requests here in 30 days|benchmarked here|measured here/.test(r)).map((r) => <li key={r}>· {r}</li>)}</ul>
            {!!a.benchmarks?.length && (
              <div className="mb-2 flex flex-wrap gap-1 text-[11px]">
                {a.benchmarks.slice(0, 5).map((b) => b.url
                  ? <a key={b.name} href={b.url} target="_blank" rel="noreferrer" className="rounded border border-line px-1.5 py-px text-ink-2 hover:border-accent hover:text-ink" title="Published result (mostly the maker's own)">{b.name} <b className="num">{b.value}</b></a>
                  : <span key={b.name} className="rounded border border-line px-1.5 py-px text-ink-2">{b.name} <b className="num">{b.value}</b></span>)}
              </div>
            )}
            {a.supersededBy && <p className="mb-1 text-[11.5px] text-ink-2">Superseded by <b>{a.supersededBy}</b>.</p>}
            {a.experimental && <p className="mb-1 text-[11.5px] text-warn">Experimental: {a.experimental}.</p>}
            <p className="text-[11.5px] text-ink-3">{a.notes}</p>
            {a.research && <p className="mt-1 text-[11.5px] text-ink-3"><span className="text-ink-2">Research, Nov 2026:</span> {a.research}</p>}
            <div className="mt-3 flex flex-wrap gap-1.5">
              {!a.installed ? <Button size="sm" variant="primary" disabled={!a.diskOk || a.fit === "too-big"} onClick={() => download(a)}>Download {a.sizeGb.toFixed(1)} GB</Button>
                : a.routes.map((r) => routes.data?.some((x) => x.name === r) && <Button key={r} size="sm" onClick={() => useIn(a, r)}>Put first on {r}</Button>)}
            </div>
          </Card>
        ))}
      </div>
      {data && !data.ranked.length && <Empty>No catalog models for this use case.</Empty>}

      <MeasuredHere />
      <TrendingCard />

      <Card className="mt-6" title="Recommended setup for this Mac" subtitle={stack.data ? `Always-on lanes take ~${fmtGb(stack.data.residentGb)} of the ${stack.data.budgetGb} GB budget; the rest load on demand and unload when idle.` : undefined} pad={false}>
        {stack.data && (
          <>
            <div className="px-4 pt-3"><Meter value={stack.data.residentGb} max={stack.data.budgetGb} /></div>
            <Table>
              <thead><tr><Th>Lane</Th><Th>Model</Th><Th>Residency</Th><Th right>Memory</Th><Th right>Score</Th><Th>Status</Th></tr></thead>
              <tbody>{stack.data.plan.map((p) => (
                <tr key={p.lane}><Td mono className="font-medium">{p.lane}</Td><Td>{p.pick?.name ?? <span className="text-ink-3">nothing fits</span>}</Td>
                  <Td>{p.alwaysOn ? <Badge tone="accent">always loaded</Badge> : <Badge tone="muted">on demand</Badge>}</Td>
                  <Td right>{p.pick ? `${p.pick.needGb} GB` : "—"}</Td><Td right>{p.pick?.score.toFixed(1) ?? "—"}</Td>
                  <Td>{p.pick ? (p.pick.installed ? <Badge tone="good">installed</Badge> : <Button size="sm" onClick={() => download(p.pick!)}>Download</Button>) : null}</Td></tr>
              ))}</tbody>
            </Table>
          </>
        )}
      </Card>
    </>
  );
}

/** The ranking turned into things to do, each applied with one click (or handed to the assistant). */
function WhatToDo({ onDone }: { onDone: (msg: string) => void }) {
  const { data, reload, loading } = useApi<{ insights: Insight[]; trending: Trending[]; generated: number; signalsAt: number | null }>("/advisor/insights");
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const apply = async (i: Insight) => {
    if (!i.action) return;
    setBusy(i.title); setErr(null);
    try { await api(i.action.path, { method: i.action.method, body: i.action.body }); onDone(`Done: ${i.title}.`); await reload(true); }
    catch (e) { setErr((e as Error).message); } finally { setBusy(null); }
  };
  const refresh = async () => { setBusy("signals"); try { await api("/advisor/signals", { method: "POST" }); await reload(true); } finally { setBusy(null); } };
  const tone = (p: Insight["priority"]) => (p === "high" ? "bad" : p === "medium" ? "warn" : "muted");
  return (
    <Card className="mb-5" title="What to do" subtitle={data ? `From mux's own measurements, the catalog and Hugging Face${data.signalsAt ? ` (read ${fmtAgo(data.signalsAt)})` : " (not read yet)"}` : undefined}
      actions={<Button size="sm" variant="ghost" disabled={busy === "signals"} onClick={() => void refresh()}>{busy === "signals" ? "Reading…" : "Re-read Hugging Face"}</Button>} pad={false}>
      <ErrorNote error={err} />
      {loading && !data && <div className="p-4"><Spinner /></div>}
      {data && !data.insights.length && <div className="p-4"><Empty>Nothing to change: the models on each route are the best this Mac has measured.</Empty></div>}
      {data?.insights.map((i) => (
        <div key={i.title} className="flex flex-wrap items-start gap-3 border-b border-line px-4 py-3 last:border-0">
          <Badge tone={tone(i.priority)}>{i.kind}</Badge>
          <div className="min-w-0 flex-1">
            <div className="text-[13px] font-medium">{i.title}</div>
            <div className="text-[12px] text-ink-2">{i.detail}</div>
          </div>
          <div className="flex shrink-0 gap-1.5">
            {i.action && <Button size="sm" variant="primary" disabled={!!busy} onClick={() => void apply(i)}>{busy === i.title ? "…" : i.action.label}</Button>}
            <Button size="sm" variant="ghost" onClick={() => askAssistant(`The model advisor suggests: “${i.title}”. ${i.detail}\n\nCheck it against what you can see (traffic, benchmarks, logs) and tell me whether to do it.`)}>Ask</Button>
          </div>
        </div>
      ))}
    </Card>
  );
}

/** mux measuring itself: every model's last 30 days, whatever its kind. */
function MeasuredHere() {
  const { data } = useApi<UsageRow[]>("/advisor/usage");
  const rows = (data ?? []).filter((r) => r.requests || r.routes.length);
  return (
    <Card className="mt-6" title="Measured here" subtitle="Every model's last 30 days on this mux: real traffic, failures, speed, who used it, its last benchmark and the routes it is on." pad={false}>
      {!rows.length ? <div className="p-4"><Empty>No traffic yet.</Empty></div> : (
        <Table>
          <thead><tr><Th>Model</Th><Th>Kind</Th><Th right>Requests</Th><Th right>Failed</Th><Th right>Latency</Th><Th right>Tok/s</Th><Th right>Tenants</Th><Th right>Cost</Th><Th>Benchmark</Th><Th>Routes</Th></tr></thead>
          <tbody>{rows.map((r) => (
            <tr key={r.id} className={cx(!r.enabled && "opacity-50")}>
              <Td mono>{r.id}</Td><Td>{r.kind ?? "—"}</Td><Td right>{fmtInt(r.requests)}</Td>
              <Td right className={r.errorRate >= 0.1 ? "text-bad font-medium" : r.errorRate > 0.02 ? "text-warn" : ""}>{r.requests ? fmtPct(r.errorRate, 1) : "—"}</Td>
              <Td right>{r.latencyMs != null ? fmtMs(r.latencyMs) : "—"}</Td><Td right>{r.tps != null ? r.tps.toFixed(0) : "—"}</Td><Td right>{r.tenants || "—"}</Td>
              <Td right>{r.costUsd ? `$${r.costUsd.toFixed(2)}` : "—"}</Td>
              <Td>{r.bench ? <span className="num">{fmtPct(r.bench.score, 0)} · {r.bench.tps?.toFixed(0)} tok/s <span className="text-ink-3">{fmtAgo(r.bench.ts)}</span></span> : <span className="text-ink-3">none</span>}</Td>
              <Td>{r.routes.join(" ") || <span className="text-ink-3">none</span>}</Td>
            </tr>
          ))}</tbody>
        </Table>
      )}
    </Card>
  );
}

/** What is rising on Hugging Face that the catalog does not have: worth a look, not a recommendation. */
function TrendingCard() {
  const { data } = useApi<Trending[]>("/advisor/trending");
  if (!data?.length) return null;
  return (
    <Card className="mt-6" title="Trending on Hugging Face, not in the catalog" subtitle="GGUF models rising now, one row per model (its most downloaded upload), safety-stripped re-uploads left out. Ask the assistant to look into one before downloading it." pad={false}>
      <Table>
        <thead><tr><Th>Model</Th><Th>Kind</Th><Th right>Downloads</Th><Th right>Likes</Th><Th>Since</Th><Th></Th></tr></thead>
        <tbody>{data.slice(0, 15).map((t) => (
          <tr key={t.repo}>
            <Td><a href={`https://huggingface.co/${t.repo}`} target="_blank" rel="noreferrer" className="font-mono text-accent hover:underline">{t.repo}</a>{t.uploads > 1 && <span className="ml-1 text-[11px] text-ink-3">+{t.uploads - 1} more upload{t.uploads > 2 ? "s" : ""}</span>}</Td>
            <Td>{t.pipeline ?? "—"}</Td><Td right>{fmtCompact(t.downloads)}</Td><Td right>{fmtInt(t.likes)}</Td><Td>{t.created_at ? t.created_at.slice(0, 10) : "—"}</Td>
            <Td><Button size="sm" variant="ghost" onClick={() => askAssistant(`Look into ${t.repo} (trending on Hugging Face, ${t.downloads} downloads): what model is it, what is it good for, which GGUF file would fit this Mac's memory budget, and should we add it for any route? Use the Hugging Face search and file listing.`)}>Ask</Button></Td>
          </tr>
        ))}</tbody>
      </Table>
    </Card>
  );
}
