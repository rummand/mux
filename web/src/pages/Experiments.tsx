import { useState } from "react";
import { api, type Model, type Route } from "../api";
import { askAssistant } from "../components/Assistant";
import { Badge, Button, Card, Empty, ErrorNote, Field, Input, PageHeader, Select, Table, Td, Th, Toggle } from "../components/ui";
import { fmtAgo, fmtInt, fmtPct } from "../format";
import { useApi } from "../hooks";

/**
 * Experiments: mux trying changes on live traffic, A/B, with production always served (server/src/experiments.ts).
 * The autopilot picks what to try; the guardrails roll a worse challenger back at once; winners are promoted.
 */
interface Arm { requests: number; firstChoiceFailed: number; failRate: number; userErrors: number; p50: number | null; p95: number | null; ttft: number | null; tps: number | null; bench: number | null }
interface Experiment {
  id: string; route: string; champion: string; challenger: string; share: number; status: "running" | "promoted" | "kept" | "rolled_back" | "stopped";
  reason: string | null; min_requests: number; max_hours: number; auto_promote: boolean; started_by: string | null; started_at: number; ended_at: number | null;
  verdict: string | null; stats: { A: Arm; B: Arm; at: number } | null;
}
interface Pilot { on: boolean; at: number; actions: string[]; blocked: string[] }

const TONE = { running: "accent", promoted: "good", kept: "muted", rolled_back: "bad", stopped: "muted" } as const;

export default function ExperimentsPage() {
  const list = useApi<Experiment[]>("/experiments", undefined, 10_000);
  const pilot = useApi<Pilot>("/experiments/autopilot", undefined, 30_000);
  const [err, setErr] = useState<string | null>(null);
  const running = (list.data ?? []).filter((e) => e.status === "running");
  const done = (list.data ?? []).filter((e) => e.status !== "running");
  const stop = async (e: Experiment) => { setErr(null); try { await api(`/experiments/${e.id}/stop`, { method: "POST" }); void list.reload(true); } catch (x) { setErr((x as Error).message); } };
  const runPilot = async () => { setErr(null); try { await api("/experiments/autopilot/run", { method: "POST" }); void pilot.reload(true); void list.reload(true); } catch (x) { setErr((x as Error).message); } };
  const setAuto = async (on: boolean) => { await api("/experiments/auto", { method: "PUT", body: { on } }); void pilot.reload(true); };
  return (
    <>
      <PageHeader title="Experiments" subtitle="mux trying changes on live traffic, A/B: a share of a route's requests goes to a challenger, the rest to the champion, and each arm keeps the other model behind it — production is always served. Guardrails roll back a worse challenger at once; a winner is promoted, and every verdict goes into the brain." />
      <ErrorNote error={err} />
      <Card className="mb-4" title="Autopilot" subtitle={pilot.data?.at ? `Last decided ${fmtAgo(pilot.data.at)}; runs every hour` : "Runs every hour"}
        actions={<><Toggle checked={!!pilot.data?.on} onChange={(v) => void setAuto(v)} label={pilot.data?.on ? "mux decides" : "off"} /><Button size="sm" onClick={() => void runPilot()}>Decide now</Button></>}>
        <p className="mb-2 text-[12.5px] text-ink-2">It fixes reliability first (a route whose model fails gets an A/B test with a reliable one), tries better models it has (benchmarking them first), and downloads better ones it has not — only when they fit in memory beside the champion. It never raises its own memory budget.</p>
        {!!pilot.data?.actions.length && <ul className="mb-2 space-y-0.5 text-[12.5px]">{pilot.data.actions.map((a) => <li key={a}>✓ {a}</li>)}</ul>}
        {!!pilot.data?.blocked.length && (
          <div className="rounded-md bg-s2 px-3 py-2 text-[12px] text-ink-2">
            <div className="mb-1 font-medium text-ink">What it could not try</div>
            <ul className="space-y-0.5">{pilot.data.blocked.map((b) => <li key={b}>· {b}</li>)}</ul>
          </div>
        )}
        {pilot.data && !pilot.data.actions.length && !pilot.data.blocked.length && <p className="text-[12px] text-ink-3">Nothing to try right now: every route's first model is the best mux has measured.</p>}
      </Card>

      <h3 className="mb-2 text-[12px] font-semibold uppercase tracking-wide text-ink-3">Running · {running.length}</h3>
      {!running.length && <div className="mb-4"><Empty>No experiment runs now.</Empty></div>}
      <div className="mb-6 space-y-3">{running.map((e) => <Running key={e.id} e={e} onStop={() => void stop(e)} />)}</div>

      <StartForm onStarted={() => void list.reload(true)} />

      <Card className="mt-6" title="Verdicts" pad={false}>
        {!done.length ? <div className="p-4"><Empty>None yet.</Empty></div> : (
          <Table>
            <thead><tr><Th>Route</Th><Th>Challenger vs champion</Th><Th>Outcome</Th><Th>Why</Th><Th>Ended</Th></tr></thead>
            <tbody>{done.map((e) => (
              <tr key={e.id}><Td mono>{e.route}</Td><Td mono>{e.challenger} <span className="text-ink-3">vs</span> {e.champion}</Td>
                <Td><Badge tone={TONE[e.status]}>{e.status.replace("_", " ")}</Badge></Td><Td className="max-w-[520px] whitespace-normal text-[12px]">{e.verdict ?? e.reason}</Td><Td>{fmtAgo(e.ended_at)}</Td></tr>
            ))}</tbody>
          </Table>
        )}
      </Card>
    </>
  );
}

function Running({ e, onStop }: { e: Experiment; onStop: () => void }) {
  const s = e.stats;
  const row = (label: string, a: string, b: string) => <tr><Td className="text-ink-3">{label}</Td><Td right>{a}</Td><Td right>{b}</Td></tr>;
  const ms = (x: number | null) => (x != null ? `${Math.round(x)} ms` : "—");
  return (
    <Card title={<span className="font-mono">{e.route}: {e.challenger} vs {e.champion}</span>}
      subtitle={`${Math.round(e.share * 100)}% to the challenger · started ${fmtAgo(e.started_at)} by ${e.started_by ?? "?"} · verdict after ${e.min_requests} requests per arm or ${e.max_hours} h · ${e.auto_promote ? "promotes a winner itself" : "suggests a winner"}`}
      actions={<><Badge tone="accent">running</Badge><Button size="sm" variant="ghost" onClick={() => askAssistant(`How is experiment ${e.id} on ${e.route} (${e.challenger} vs ${e.champion}) going? Read GET /experiments/${e.id} and the requests of each arm, and tell me what you expect the verdict to be.`)}>Ask</Button><Button size="sm" onClick={onStop}>Stop</Button></>} pad={false}>
      {s && (
        <Table>
          <thead><tr><Th></Th><Th right>A · {e.champion}</Th><Th right>B · {e.challenger}</Th></tr></thead>
          <tbody>
            {row("requests", fmtInt(s.A.requests), fmtInt(s.B.requests))}
            {row("first-try failures", fmtPct(s.A.failRate, 1), fmtPct(s.B.failRate, 1))}
            {row("errors to callers", fmtInt(s.A.userErrors), fmtInt(s.B.userErrors))}
            {row("median latency", ms(s.A.p50), ms(s.B.p50))}
            {row("p95 latency", ms(s.A.p95), ms(s.B.p95))}
            {row("tokens / s", s.A.tps?.toFixed(0) ?? "—", s.B.tps?.toFixed(0) ?? "—")}
            {row("benchmark", s.A.bench != null ? fmtPct(s.A.bench, 0) : "—", s.B.bench != null ? fmtPct(s.B.bench, 0) : "—")}
          </tbody>
        </Table>
      )}
    </Card>
  );
}

function StartForm({ onStarted }: { onStarted: () => void }) {
  const { data: routes } = useApi<Route[]>("/routes");
  const { data: models } = useApi<Model[]>("/models");
  const [f, setF] = useState({ route: "", challenger: "", share: 10 });
  const [err, setErr] = useState<string | null>(null);
  const route = routes?.find((r) => r.name === f.route);
  const start = async () => {
    setErr(null);
    try { await api("/experiments", { body: { route: f.route, challenger: f.challenger, share: f.share / 100 } }); onStarted(); setF({ ...f, challenger: "" }); }
    catch (e) { setErr((e as Error).message); }
  };
  return (
    <Card title="Start one yourself">
      <ErrorNote error={err} />
      <div className="grid gap-3 sm:grid-cols-[1fr_1fr_120px_auto] sm:items-end">
        <Field label="Route"><Select value={f.route} onChange={(e) => setF({ ...f, route: e.target.value, challenger: "" })}><option value="">pick a route</option>{routes?.filter((r) => r.kind !== "embedding" && r.candidates.length).map((r) => <option key={r.name} value={r.name}>{r.name} (first: {r.candidates[0]})</option>)}</Select></Field>
        <Field label="Challenger"><Select value={f.challenger} onChange={(e) => setF({ ...f, challenger: e.target.value })} disabled={!route}><option value="">pick a model</option>{models?.filter((m) => route && m.kind === route.kind && m.enabled && m.id !== route.candidates[0]).map((m) => <option key={m.id} value={m.id}>{m.id}</option>)}</Select></Field>
        <Field label="Share (%)"><Input type="number" min={1} max={50} value={f.share} onChange={(e) => setF({ ...f, share: Number(e.target.value) })} /></Field>
        <Button variant="primary" disabled={!f.route || !f.challenger} onClick={() => void start()}>Start</Button>
      </div>
    </Card>
  );
}
