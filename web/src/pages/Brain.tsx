import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { api, type BrainKind, type BrainPage, type BrainStats } from "../api";
import { Markdown } from "../components/Assistant";
import { Spinner } from "../components/ui";
import { Badge, Button, Card, cx, Empty, ErrorNote, Field, Input, PageHeader, Select, Textarea } from "../components/ui";
import { fmtAgo, fmtInt } from "../format";
import { useApi } from "../hooks";

/** mux's brain: what the assistant and the doctor remember across conversations. Read it, correct it, add to it. */
const KINDS: BrainKind[] = ["fact", "runbook", "decision", "preference", "incident", "note"];
const blank = { title: "", kind: "note" as BrainKind, subject: "", body: "", tags: "" };

export default function BrainPage() {
  const [params, setParams] = useSearchParams();
  const [q, setQ] = useState("");
  const [kind, setKind] = useState("");
  // Each search embeds the query through mux: wait for a pause in typing.
  const [dq, setDq] = useState("");
  useEffect(() => { const t = setTimeout(() => setDq(q.trim()), 300); return () => clearTimeout(t); }, [q]);
  const { data, error, reload } = useApi<{ pages: BrainPage[]; stats: BrainStats }>("/brain", { q: dq, kind, limit: 100 }, undefined, null);
  const selected = params.get("page");
  const select = (id: string | null) => setParams(id ? { page: id } : {});
  const s = data?.stats;
  return (
    <>
      <PageHeader title="Brain" subtitle="What the assistant and the doctor remember across conversations: how this mux is set up and why, decisions, preferences, and runbooks for problems already solved."
        actions={<Button variant="primary" onClick={() => select("new")}>New page</Button>} />
      {s?.backend === "gbrain" ? (
        <p className="mb-4 text-[12px] text-ink-3">
          <a href="https://github.com/garrytan/gbrain" target="_blank" rel="noreferrer" className="text-accent hover:underline">GBrain</a>
          {s.gbrain?.version ? ` ${s.gbrain.version}` : ""} at {s.gbrain?.url}{s.gbrain?.managed ? ", run by mux" : ""} · {fmtInt(s.pages)}{s.morePages ? "+" : ""} pages · embeddings through mux's embed route
          {s.gbrain && !s.gbrain.ok && <span className="text-bad"> · not answering{s.gbrain.error ? `: ${s.gbrain.error}` : ""}</span>}
        </p>
      ) : s && (
        <p className="mb-4 text-[12px] text-ink-3">
          {fmtInt(s.pages)} pages · {fmtInt(s.embedded)} embedded{s.models.length ? ` with ${s.models.map((m) => m.model).join(", ")}` : ""}
          {!s.embedding && " · the embed route is not answering, so search goes by words until it is"}
        </p>
      )}
      <ErrorNote error={error} />
      <Keeper onRan={() => void reload(true)} />
      <div className="grid gap-4 lg:grid-cols-[minmax(0,380px)_minmax(0,1fr)]">
        <Card pad={false}>
          <div className="flex gap-2 border-b border-line p-3">
            <Input placeholder="Search by meaning or words…" value={q} onChange={(e) => setQ(e.target.value)} />
            <Select className="w-32" value={kind} onChange={(e) => setKind(e.target.value)}>
              <option value="">All kinds</option>
              {KINDS.map((k) => <option key={k} value={k}>{k}</option>)}
            </Select>
          </div>
          <div className="max-h-[70vh] divide-y divide-line overflow-y-auto">
            {data && !data.pages.length && <div className="p-4"><Empty>{q ? "Nothing matches." : "Nothing remembered yet. The assistant writes here as it learns."}</Empty></div>}
            {data?.pages.map((p) => (
              <button key={p.id} onClick={() => select(p.id)} className={cx("block w-full px-3 py-2 text-left", p.id === selected ? "bg-accent-soft" : "hover:bg-s2")}>
                <div className="truncate text-[13px]">{p.title}</div>
                <div className="mt-0.5 flex items-center gap-1.5 text-[11px] text-ink-3">
                  <Badge>{p.kind}</Badge>{p.subject && <span className="truncate">{p.subject}</span>}
                  <span className="ml-auto shrink-0">{q && p.score != null ? `${p.score.toFixed(2)} · ` : ""}{fmtAgo(p.updated_at)}</span>
                </div>
              </button>
            ))}
          </div>
        </Card>
        {selected ? <Editor key={selected} id={selected} onSaved={(id) => { void reload(true); select(id); }} onDeleted={() => { void reload(true); select(null); }} />
          : <Card><Empty>Pick a page to read or correct it, or write a new one.</Empty></Card>}
      </div>
    </>
  );
}

function Editor({ id, onSaved, onDeleted }: { id: string; onSaved: (id: string) => void; onDeleted: () => void }) {
  const isNew = id === "new";
  const [page, setPage] = useState<BrainPage | null>(null);
  const [f, setF] = useState(blank);
  const [editing, setEditing] = useState(isNew);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (isNew) return;
    api<BrainPage>(`/brain/${encodeURIComponent(id)}`, { scope: null })
      .then((p) => { setPage(p); setF({ title: p.title, kind: p.kind, subject: p.subject, body: p.body, tags: p.tags.join(", ") }); })
      .catch((e) => setErr((e as Error).message));
  }, [id, isNew]);

  const save = async () => {
    setBusy(true); setErr(null);
    try {
      const body = { ...f, tags: f.tags.split(",").map((t) => t.trim()).filter(Boolean) };
      const p = await api<BrainPage>(isNew ? "/brain" : `/brain/${encodeURIComponent(id)}`, { method: isNew ? "POST" : "PUT", body, scope: null });
      setPage(p); setEditing(false); onSaved(p.id);
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };
  const remove = async () => {
    if (!confirm(`Forget “${page?.title}”?`)) return;
    await api(`/brain/${encodeURIComponent(id)}`, { method: "DELETE", scope: null }).catch((e) => setErr((e as Error).message));
    onDeleted();
  };

  if (!editing && page) return (
    <Card title={page.title} subtitle={<span className="flex flex-wrap items-center gap-1.5"><Badge>{page.kind}</Badge>{page.subject && <span>{page.subject}</span>}<span>· written by {page.source} · updated {fmtAgo(page.updated_at)} · recalled {fmtInt(page.recalls)}×{page.embedded ? "" : " · not embedded yet"}</span></span>}
      actions={<><Button size="sm" onClick={() => setEditing(true)}>Edit</Button><Button size="sm" variant="danger" onClick={() => void remove()}>Forget</Button></>}>
      <div className="text-[13px]"><Markdown text={page.body || "_(empty)_"} /></div>
      {!!page.tags.length && <div className="mt-3 flex flex-wrap gap-1">{page.tags.map((t) => <Badge key={t}>{t}</Badge>)}</div>}
      <ErrorNote error={err} />
    </Card>
  );
  return (
    <Card title={isNew ? "New page" : "Edit page"}>
      <div className="space-y-3">
        <Field label="Title"><Input value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} placeholder="e.g. The agent route keeps Qwen first for tool calls" /></Field>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Kind"><Select value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value as BrainKind })}>{KINDS.map((k) => <option key={k} value={k}>{k}</option>)}</Select></Field>
          <Field label="About" hint="A model, tenant, provider or route id"><Input value={f.subject} onChange={(e) => setF({ ...f, subject: e.target.value })} /></Field>
        </div>
        <Field label="Body" hint="Markdown"><Textarea rows={14} value={f.body} onChange={(e) => setF({ ...f, body: e.target.value })} /></Field>
        <Field label="Tags" hint="Comma separated"><Input value={f.tags} onChange={(e) => setF({ ...f, tags: e.target.value })} /></Field>
        <ErrorNote error={err} />
        <div className="flex gap-2">
          <Button variant="primary" disabled={busy || !f.title.trim()} onClick={() => void save()}>Save</Button>
          {!isNew && <Button onClick={() => setEditing(false)}>Cancel</Button>}
        </div>
      </div>
    </Card>
  );
}

interface KeeperRun { id: string; ts: number; status: string; read: { conversations: number; incidents: number; findings: number } | null; report: string | null; error: string | null; duration_ms: number | null }

/** The brain keeper: the agent that looks after mux's memory on its own, and what it did last. */
function Keeper({ onRan }: { onRan: () => void }) {
  const { data, reload } = useApi<{ busy: boolean; runs: KeeperRun[] }>("/brain/keeper", undefined, 10_000, null);
  const last = data?.runs.find((r) => r.status !== "running");
  const run = async () => { await api("/brain/keeper/run", { method: "POST", scope: null }); void reload(true); setTimeout(onRan, 60_000); };
  return (
    <Card className="mb-4" title="Brain keeper" subtitle="mux's agent for its own memory: every 6 hours it reads the conversations, the doctor's diagnoses and Lens's new findings, writes down what matters, updates and merges pages, and forgets what is no longer true. It changes nothing else about mux; what it changes is in “What mux changed”."
      actions={data?.busy ? <span className="flex items-center gap-1.5 text-[12px] text-ink-2"><Spinner /> keeping…</span> : <Button size="sm" onClick={() => void run()}>Run now</Button>}>
      {!last ? <p className="text-[12.5px] text-ink-3">It has not run yet; the first run is 10 minutes after mux starts.</p> : (
        <div className="text-[12.5px]">
          <div className="mb-1 text-ink-3">Last run {fmtAgo(last.ts)}{last.read ? ` · read ${last.read.conversations} conversation(s), ${last.read.incidents} incident(s), ${last.read.findings} finding(s)` : ""}</div>
          {last.error ? <p className="text-bad">{last.error}</p> : <Markdown text={last.report ?? ""} />}
        </div>
      )}
    </Card>
  );
}
