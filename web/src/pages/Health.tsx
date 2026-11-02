import { useState } from "react";
import { api, type Settings } from "../api";
import { Markdown } from "../components/Assistant";
import { Badge, Button, Card, Empty, ErrorNote, PageHeader, Segmented, Spinner, Toggle, cx } from "../components/ui";
import { fmtAgo, fmtTime } from "../format";
import { useApi } from "../hooks";

interface Check { id: string; label: string; ok: boolean; detail: string; at: number | null; fixes: number }
interface HealerInfo { enabled: boolean; ai: boolean; lastTick: number; ticks: number; doctorBusy: boolean; checks: Check[]; counts: { status: string; n: number }[]; actions24h: number }
interface Action { ts: number; by: "healer" | "doctor" | "user"; action: string; ok: boolean; detail?: string; proposal?: { id: string; function: { name: string; arguments: string } } }
interface Incident {
  id: string; ts: number; updated_at: number; kind: string; subject: string; severity: "low" | "medium" | "high"; status: "open" | "escalated" | "resolved";
  title: string; detail: string | null; actions: Action[]; attempts: number; diagnosis: string | null; resolved_at: number | null;
}

const sevTone = { low: "muted", medium: "warn", high: "bad" } as const;

/** Self-healing: what the watchdog checks, what it fixed, and the incidents it and the doctor are working on. */
export default function HealthPage() {
  const info = useApi<HealerInfo>("/healer", undefined, 10_000);
  const settings = useApi<Settings>("/settings");
  const [show, setShow] = useState<"open" | "resolved">("open");
  const incidents = useApi<Incident[]>("/incidents", { status: show, limit: 100 }, 10_000);
  const [running, setRunning] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const h = info.data;
  const s = settings.data;

  const setFlag = async (k: "selfHeal" | "selfHealAi", v: boolean) => {
    try { await api("/settings", { method: "PATCH", body: { [k]: v } }); void settings.reload(true); void info.reload(true); } catch (e) { setErr((e as Error).message); }
  };
  const runNow = async () => { setRunning(true); try { await api("/healer/run", { method: "POST", body: {} }); await info.reload(true); await incidents.reload(true); } catch (e) { setErr((e as Error).message); } finally { setRunning(false); } };
  const open = h?.counts.filter((c) => c.status !== "resolved").reduce((a, c) => a + c.n, 0) ?? 0;
  const failing = h?.checks.filter((c) => !c.ok).length ?? 0;

  return (
    <>
      <PageHeader title="Health" subtitle="mux watches itself every 20 s, repairs what it can, and hands the rest to the doctor."
        actions={<Button onClick={runNow} disabled={running}>{running ? <Spinner /> : "Run checks now"}</Button>} />
      <ErrorNote error={err ?? info.error} />
      <div className="mb-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Card>
          <div className="text-[12px] text-ink-3">Status</div>
          <div className={cx("mt-1 text-xl font-semibold", !h?.enabled ? "text-ink-3" : failing ? "text-warn" : "text-good")}>
            {!h ? "…" : !h.enabled ? "Self-healing off" : failing ? `${failing} check${failing > 1 ? "s" : ""} failing` : "Healthy"}
          </div>
          <div className="mt-1 text-[12px] text-ink-3">{h?.lastTick ? `checked ${fmtAgo(h.lastTick)}` : "first check 30 s after start"}</div>
        </Card>
        <Card>
          <div className="text-[12px] text-ink-3">Open incidents</div>
          <div className={cx("mt-1 text-xl font-semibold", open ? "text-warn" : "")}>{open}</div>
          <div className="mt-1 text-[12px] text-ink-3">{h?.counts.find((c) => c.status === "resolved")?.n ?? 0} resolved in all</div>
        </Card>
        <Card>
          <div className="text-[12px] text-ink-3">Healer actions, 24 h</div>
          <div className="mt-1 text-xl font-semibold">{h?.actions24h ?? "—"}</div>
          <div className="mt-1 text-[12px] text-ink-3">restarts, reloads, unloads, prunes, re-joins</div>
        </Card>
        <Card>
          <div className="space-y-2">
            <Toggle checked={!!s?.selfHeal} onChange={(v) => void setFlag("selfHeal", v)} label="Repair automatically" />
            <Toggle checked={!!s?.selfHealAi} onChange={(v) => void setFlag("selfHealAi", v)} label="Doctor (AI) for what the rules can't fix" />
            {h?.doctorBusy && <div className="flex items-center gap-2 text-[12px] text-accent"><Spinner /> the doctor is working</div>}
          </div>
        </Card>
      </div>

      <Card title="Checks" subtitle="each with what it last saw and how often it repaired something" className="mb-4">
        {!h?.checks.length ? <Empty>No checks have run yet.</Empty> : (
          <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-3">
            {h.checks.map((c) => (
              <div key={c.id} className="rounded-md border border-line p-3">
                <div className="flex items-center gap-2">
                  <span className={cx("h-2 w-2 shrink-0 rounded-full", c.ok ? "bg-good" : "bg-bad")} />
                  <span className="text-[13px] font-medium">{c.label}</span>
                  {c.fixes > 0 && <Badge tone="accent" className="ml-auto">{c.fixes} fixed</Badge>}
                </div>
                <div className="mt-1 text-[12px] text-ink-2">{c.detail}</div>
                <div className="mt-0.5 text-[11px] text-ink-3">{c.at ? fmtAgo(c.at) : ""}</div>
              </div>
            ))}
          </div>
        )}
      </Card>

      <Card title="Incidents" actions={<Segmented value={show} onChange={setShow} options={[{ value: "open", label: "Open" }, { value: "resolved", label: "Resolved" }]} />}>
        {!incidents.data ? <Spinner /> : !incidents.data.length ? <Empty>{show === "open" ? "Nothing open. mux is fine." : "No incidents yet."}</Empty> : (
          <div className="space-y-2">{incidents.data.map((i) => <IncidentRow key={i.id} inc={i} onChange={() => void incidents.reload(true)} />)}</div>
        )}
      </Card>
    </>
  );
}

function IncidentRow({ inc, onChange }: { inc: Incident; onChange: () => void }) {
  const [open, setOpen] = useState(inc.status !== "resolved" && inc.severity === "high");
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const call = async (what: string, path: string, body: unknown = {}) => {
    setBusy(what); setErr(null);
    try { await api(`/incidents/${inc.id}${path}`, { method: "POST", body }); onChange(); } catch (e) { setErr((e as Error).message); } finally { setBusy(null); }
  };
  return (
    <div className={cx("rounded-md border", inc.status === "escalated" ? "border-bad/50" : "border-line")}>
      <button onClick={() => setOpen(!open)} className="flex w-full flex-wrap items-center gap-2 px-3 py-2 text-left">
        <Badge tone={sevTone[inc.severity]}>{inc.severity}</Badge>
        <span className="text-[13px] font-medium">{inc.title}</span>
        <span className="font-mono text-[11.5px] text-ink-3">{inc.kind} · {inc.subject}</span>
        <span className="ml-auto text-[11.5px] text-ink-3">
          {inc.status === "resolved" ? `resolved ${fmtAgo(inc.resolved_at)}` : inc.status === "escalated" ? "escalated" : "open"} · {inc.actions.length} actions · since {fmtAgo(inc.ts)}
        </span>
      </button>
      {open && (
        <div className="space-y-3 border-t border-line px-3 py-3 text-[12.5px]">
          {inc.detail && <pre className="max-h-48 overflow-auto rounded bg-s2 p-2 font-mono text-[11px] whitespace-pre-wrap">{inc.detail}</pre>}
          {inc.diagnosis && (
            <div className="rounded-md border border-accent/40 bg-accent-soft/40 p-3">
              <div className="mb-1 text-[11px] font-semibold uppercase tracking-wider text-accent">Doctor's report</div>
              <Markdown text={inc.diagnosis} />
            </div>
          )}
          <ol className="space-y-1.5">
            {inc.actions.map((a, idx) => (
              <li key={idx} className="flex gap-2">
                <span className="w-32 shrink-0 text-[11px] text-ink-3 num">{fmtTime(a.ts, true)}</span>
                <Badge tone={a.by === "doctor" ? "accent" : a.by === "user" ? "neutral" : "muted"}>{a.by}</Badge>
                <div className="min-w-0 flex-1">
                  <span className={a.ok ? "" : "text-bad"}>{a.action}</span>
                  {a.detail && <div className="truncate font-mono text-[11px] text-ink-3" title={a.detail}>{a.detail}</div>}
                  {a.proposal && inc.status !== "resolved" && (
                    <div className="mt-1 flex gap-2">
                      <Button size="sm" variant="primary" disabled={!!busy} onClick={() => void call(`apply${idx}`, "/apply", { index: idx })}>{busy === `apply${idx}` ? <Spinner /> : "Approve & run"}</Button>
                      <code className="self-center truncate text-[11px] text-ink-3">{a.proposal.function.arguments.slice(0, 160)}</code>
                    </div>
                  )}
                </div>
              </li>
            ))}
          </ol>
          <ErrorNote error={err} />
          {inc.status !== "resolved" && (
            <div className="flex gap-2">
              <Button size="sm" disabled={!!busy} onClick={() => void call("doctor", "/doctor")}>{busy === "doctor" ? <Spinner /> : "Ask the doctor"}</Button>
              <Button size="sm" variant="ghost" disabled={!!busy} onClick={() => void call("resolve", "/resolve")}>Mark resolved</Button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
