import { useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { askAssistant, Markdown } from "../components/Assistant";
import { Badge, Card, Empty, PageHeader, Select } from "../components/ui";
import { fmtAgo, fmtTime } from "../format";
import { useApi } from "../hooks";

/**
 * Journal: everything mux changed about itself — routes, models, settings, its brain, experiments, downloads,
 * benchmarks, repairs — who in mux did it, and what it was before and after (server/src/journal.ts). The owner's own
 * changes are not here: this is what mux decided.
 */
export interface JournalEntry { id: number; ts: number; actor: string; kind: string; title: string; detail: string | null; before: unknown; after: unknown; ref: string | null }

export const ACTORS: Record<string, string> = { autopilot: "Autopilot", experiments: "Experiments", doctor: "Doctor", healer: "Healer", "brain-keeper": "Brain keeper", assistant: "mux (approved by you)", lens: "Lens" };
export const actorTone = (a: string) => (a === "healer" || a === "doctor" ? "warn" : a === "brain-keeper" ? "accent" : a === "assistant" ? "muted" : "good") as "warn" | "accent" | "muted" | "good";

/** Where an entry's subject lives in the dashboard. */
const link = (e: JournalEntry) => e.kind === "brain" && e.ref ? `/brain?page=${encodeURIComponent(e.ref)}` : e.kind === "experiment" ? "/experiments" : e.kind === "route" ? "/routes" : e.kind === "model" && e.ref ? `/models/${e.ref}` : e.kind === "repair" ? "/health" : e.kind === "keeper" ? "/brain" : null;

export default function JournalPage() {
  const [params] = useSearchParams();
  const [actor, setActor] = useState(params.get("actor") ?? "");
  const [kind, setKind] = useState("");
  const { data } = useApi<JournalEntry[]>("/journal", { limit: 300, actor, kind }, 15_000);
  return (
    <>
      <PageHeader title="What mux changed" subtitle="Everything mux decided to change about itself, who in mux did it, and what it was before and after. Your own changes are not here — this is mux's doing, so you can always see it." />
      <div className="mb-4 flex flex-wrap gap-2">
        <Select className="w-56" value={actor} onChange={(e) => setActor(e.target.value)}><option value="">Everyone in mux</option>{Object.entries(ACTORS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</Select>
        <Select className="w-44" value={kind} onChange={(e) => setKind(e.target.value)}><option value="">Every kind</option>{["route", "model", "setting", "brain", "experiment", "download", "benchmark", "repair", "keeper"].map((k) => <option key={k} value={k}>{k}</option>)}</Select>
      </div>
      {!data?.length && <Empty>Nothing yet.</Empty>}
      <div className="space-y-2">{data?.map((e) => <Item key={e.id} e={e} />)}</div>
    </>
  );
}

function Item({ e }: { e: JournalEntry }) {
  const [open, setOpen] = useState(false);
  const to = link(e);
  return (
    <Card pad={false}>
      <button onClick={() => setOpen(!open)} className="flex w-full items-start gap-3 px-4 py-2.5 text-left hover:bg-s2">
        <Badge tone={actorTone(e.actor)}>{ACTORS[e.actor] ?? e.actor}</Badge>
        <div className="min-w-0 flex-1">
          <div className="text-[13px]">{e.title}</div>
          {e.detail && !open && <div className="truncate text-[12px] text-ink-3">{e.detail.split("\n")[0]}</div>}
        </div>
        <span className="shrink-0 text-[11.5px] text-ink-3" title={fmtTime(e.ts, true)}>{e.kind} · {fmtAgo(e.ts)}</span>
      </button>
      {open && (
        <div className="space-y-2 border-t border-line px-4 py-3 text-[12.5px]">
          {e.detail && (e.kind === "keeper" ? <Markdown text={e.detail} /> : <p className="whitespace-pre-wrap text-ink-2">{e.detail}</p>)}
          {(e.before != null || e.after != null) && (
            <div className="grid gap-2 sm:grid-cols-2">
              <div><div className="mb-1 text-[11px] uppercase tracking-wide text-ink-3">Before</div><pre className="max-h-48 overflow-auto rounded bg-s2 p-2 font-mono text-[11px]">{JSON.stringify(e.before, null, 2) ?? "—"}</pre></div>
              <div><div className="mb-1 text-[11px] uppercase tracking-wide text-ink-3">After</div><pre className="max-h-48 overflow-auto rounded bg-s2 p-2 font-mono text-[11px]">{JSON.stringify(e.after, null, 2) ?? "—"}</pre></div>
            </div>
          )}
          <div className="flex gap-3">
            {to && <Link to={to} className="text-accent hover:underline">Open</Link>}
            <button className="text-accent hover:underline" onClick={() => askAssistant(`Explain this change mux made to itself, and whether it was right: “${e.title}” (${e.actor}, ${new Date(e.ts).toISOString()}). ${e.detail ?? ""} Before: ${JSON.stringify(e.before)}. After: ${JSON.stringify(e.after)}.`)}>Ask why</button>
          </div>
        </div>
      )}
    </Card>
  );
}
