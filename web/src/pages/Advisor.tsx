import { useState } from "react";
import { api, type Advice, type Route } from "../api";
import { Badge, Button, Card, Empty, ErrorNote, Meter, PageHeader, Segmented, Spinner, Table, Td, Th } from "../components/ui";
import { fmtGb, fmtPct } from "../format";
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
      <PageHeader title="Model advisor" subtitle="Which model to run for what, on this Mac: the job's needs, mux's memory budget, the disk, and what benchmarks measured here." />
      <ErrorNote error={error ?? err} />
      {msg && <div className="mb-3 rounded-md bg-accent-soft px-3 py-2 text-[12.5px]">{msg}</div>}
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
            actions={<><Badge tone={a.fit === "fits" ? "good" : a.fit === "tight" ? "warn" : "bad"}>{a.fit === "fits" ? "fits" : a.fit === "tight" ? "tight" : "too big"}</Badge>{a.installed && <Badge tone="accent">installed</Badge>}</>}>
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
            {a.measured && <div className="mb-2 text-[12px] text-ink-2 num">Measured here: <b>{a.measured.tps} tok/s</b>, {fmtPct(a.measured.score, 0)} of checks, first token {Math.round(a.measured.ttftMs)} ms</div>}
            <ul className="mb-2 space-y-0.5 text-[11.5px] text-ink-2">{a.reasons.map((r) => <li key={r}>· {r}</li>)}</ul>
            <p className="text-[11.5px] text-ink-3">{a.notes}</p>
            <div className="mt-3 flex flex-wrap gap-1.5">
              {!a.installed ? <Button size="sm" variant="primary" disabled={!a.diskOk || a.fit === "too-big"} onClick={() => download(a)}>Download {a.sizeGb.toFixed(1)} GB</Button>
                : a.routes.map((r) => routes.data?.some((x) => x.name === r) && <Button key={r} size="sm" onClick={() => useIn(a, r)}>Put first on {r}</Button>)}
            </div>
          </Card>
        ))}
      </div>
      {data && !data.ranked.length && <Empty>No catalog models for this use case.</Empty>}

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
