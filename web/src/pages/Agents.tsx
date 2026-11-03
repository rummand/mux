import { useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api";
import { askAssistant } from "../components/Assistant";
import { Badge, Button, Card, ErrorNote, PageHeader, StatusDot } from "../components/ui";
import { fmtAgo, fmtTime } from "../format";
import { useApi } from "../hooks";

/**
 * The agents that act on mux — its hands and feet: the healer and its doctor, the experiments autopilot, Lens's
 * watches and the brain keeper (server/src/agents.ts). What each does, whether it is on, when it last ran and what
 * came of it, what it changed, and a button to run it now.
 */
interface Agent {
  id: string; name: string; does: string; on: boolean; busy: boolean; schedule: string;
  last: { at: number | null; summary: string; ok: boolean | null } | null; next: number | null;
  changed: { ts: number; title: string; kind: string }[]; changed24h: number;
  actor: string[]; run: { label: string; path: string }[]; settings: string | null;
}

export default function AgentsPage() {
  const { data, reload } = useApi<Agent[]>("/agents", undefined, 10_000, null);
  return (
    <>
      <PageHeader title="Agents" subtitle="The parts of mux that act on their own — its hands and feet. Everything they change is in “What mux changed”." />
      <div className="grid gap-4 lg:grid-cols-2">{data?.map((a) => <AgentCard key={a.id} a={a} onRan={() => void reload(true)} />)}</div>
    </>
  );
}

const until = (ts: number) => {
  const s = Math.round((ts - Date.now()) / 1000);
  return s <= 0 ? "due now" : s < 60 ? `in ${s} s` : s < 3600 ? `in ${Math.round(s / 60)} min` : `in ${(s / 3600).toFixed(1)} h`;
};

function AgentCard({ a, onRan }: { a: Agent; onRan: () => void }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const run = async (r: Agent["run"][number]) => {
    setBusy(r.path); setErr(null); setNote(null);
    try { await api(r.path, { method: "POST", body: {}, scope: null }); setNote(`Started ${fmtTime(Date.now())}. It shows here when it has run.`); onRan(); setTimeout(onRan, 15_000); }
    catch (e) { setErr((e as Error).message); } finally { setBusy(null); }
  };
  const state = a.busy ? { tone: "accent" as const, label: "working now" } : !a.on ? { tone: "muted" as const, label: "off" } : a.last?.ok === false ? { tone: "warn" as const, label: "on · last run found trouble" } : { tone: "good" as const, label: "on" };
  return (
    <Card title={<span className="flex items-center gap-2">{a.name}<StatusDot tone={state.tone} label={state.label} pulse={a.busy} /></span>}
      subtitle={<span>{a.schedule}{a.on && a.next ? ` · next ${until(a.next)}` : ""}</span>}
      actions={a.settings ? <Link to={a.settings} className="text-[12px] text-accent hover:underline">Open</Link> : undefined}>
      <p className="text-[12.5px] text-ink-2">{a.does}</p>

      <div className="mt-3 rounded-md bg-s2 px-3 py-2 text-[12.5px]">
        <div className="mb-0.5 text-[11px] font-medium uppercase tracking-wide text-ink-3">Last run{a.last?.at ? <span className="normal-case tracking-normal"> · {fmtAgo(a.last.at)}</span> : ""}</div>
        {a.last ? <div className={a.last.ok === false ? "text-warn" : "text-ink-2"}>{a.last.summary || "—"}</div> : <div className="text-ink-3">Not run yet.</div>}
      </div>

      <div className="mt-3">
        <div className="mb-1 flex items-baseline justify-between text-[11px] font-medium uppercase tracking-wide text-ink-3">
          <span>What it changed</span>
          <Link to={`/journal?actor=${a.actor[0]}`} className="normal-case tracking-normal text-accent hover:underline">{a.changed24h} in 24 h · all</Link>
        </div>
        {a.changed.length ? (
          <ul className="space-y-1">{a.changed.map((c, i) => (
            <li key={i} className="flex gap-2 text-[12px]"><Badge tone="muted">{c.kind}</Badge><span className="min-w-0 flex-1 truncate text-ink-2" title={c.title}>{c.title}</span><span className="shrink-0 text-ink-3">{fmtAgo(c.ts)}</span></li>
          ))}</ul>
        ) : <div className="text-[12px] text-ink-3">Nothing yet.</div>}
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-line pt-3">
        {a.run.map((r) => <Button key={r.path} size="sm" variant="primary" disabled={!!busy || a.busy} onClick={() => void run(r)}>{busy === r.path ? "Running…" : r.label}</Button>)}
        <Button size="sm" variant="ghost" onClick={() => askAssistant(`Tell me about your agent “${a.name}”: what has it done lately, was it right, and should anything about it change? Its last run (${a.last?.at ? new Date(a.last.at).toISOString() : "never"}): ${a.last?.summary ?? "—"}`)}>Ask mux</Button>
        {note && <span className="text-[12px] text-ink-3">{note}</span>}
      </div>
      <ErrorNote error={err} />
    </Card>
  );
}
