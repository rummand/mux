import { useEffect, useRef } from "react";
import { Link } from "react-router-dom";
import { api, type BrainPage, type BrainStats, type Conversation, type Incident, type LensRun, type Overview, type SystemInfo } from "../api";
import { AssistantChat, brainIcon, sparkle, SUGGESTIONS, useConversation } from "../components/Assistant";
import { Button, cx } from "../components/ui";
import { fmtAgo, fmtInt, fmtPct } from "../format";
import { useApi } from "../hooks";

/**
 * Home: the assistant in the middle of mux. Its conversations on the left; on the right, mux right now and what its brain
 * remembers — each a question away.
 */
export default function HomePage() {
  const ask = useRef<((text: string) => void) | null>(null);
  const put = (q: string) => ask.current?.(q);
  return (
    <div className="-m-4 grid h-[calc(100dvh-3rem)] md:-m-6 lg:grid-cols-[240px_minmax(0,1fr)] xl:grid-cols-[240px_minmax(0,1fr)_300px]">
      <Conversations />
      <div className="flex min-h-0 flex-col">
        <AssistantChat layout="page" ask={ask} empty={(send) => <Welcome send={send} />} />
      </div>
      <aside className="hidden min-h-0 space-y-5 overflow-y-auto border-l border-line p-4 xl:block">
        <Now ask={put} />
        <Brain ask={put} />
      </aside>
    </div>
  );
}

function Welcome({ send }: { send: (text: string) => void }) {
  const { data: inc } = useApi<Incident[]>("/incidents", { status: "open", limit: 3 }, 30_000, null);
  const { data: ov } = useApi<Overview>("/overview", { range: "1h" }, 30_000, null);
  const errors = ov?.totals.errors ?? 0;
  const now = [
    ...(inc ?? []).map((i) => `Incident “${i.title}” is open: what caused it, and fix it`),
    ...(errors ? [`Why did ${errors} requests fail in the last hour?`] : []),
  ];
  return (
    <div className="pt-[8vh]">
      <div className="mb-1 flex items-center gap-2 text-accent">{sparkle}<span className="text-[12px] font-medium uppercase tracking-wider">mux assistant</span></div>
      <h1 className="mb-2 text-2xl font-semibold tracking-tight">What should mux do?</h1>
      <p className="mb-6 max-w-xl text-[13px] text-ink-3">Ask about anything mux runs — tenants, models, routes, providers, requests, the machines — or tell it what to set up or fix. It reads on its own, remembers what it learns in mux's brain, and asks you before it changes anything.</p>
      {!!now.length && (
        <div className="mb-4 grid gap-2">
          {now.map((q) => <button key={q} onClick={() => send(q)} className="rounded-lg border border-warn/50 bg-warn/5 px-3 py-2.5 text-left text-[13px] hover:bg-warn/10">{q}</button>)}
        </div>
      )}
      <div className="grid gap-2 sm:grid-cols-2">
        {SUGGESTIONS.map((q) => <button key={q} onClick={() => send(q)} className="rounded-lg border border-line px-3 py-2.5 text-left text-[13px] text-ink-2 hover:bg-s2 hover:text-ink">{q}</button>)}
      </div>
    </div>
  );
}

function Conversations() {
  const { msgs, setMsgs, convo, setConvo } = useConversation();
  const { data, reload } = useApi<Conversation[]>("/assistant/conversations", { limit: 60 }, 30_000, null);
  // A conversation is kept when an answer ends: refresh the list then.
  const turns = msgs.filter((m) => m.role === "assistant").length;
  useEffect(() => { void reload(true); }, [convo, turns, reload]);
  const open = async (id: string) => {
    const c = await api<{ id: string; messages: typeof msgs }>(`/assistant/conversations/${encodeURIComponent(id)}`, { scope: null });
    setMsgs(c.messages); setConvo(c.id);
  };
  const remove = async (id: string) => {
    await api(`/assistant/conversations/${encodeURIComponent(id)}`, { method: "DELETE", scope: null });
    if (id === convo) { setMsgs([]); setConvo(""); }
    void reload(true);
  };
  return (
    <aside className="hidden min-h-0 flex-col border-r border-line lg:flex">
      <div className="flex h-12 shrink-0 items-center px-3">
        <Button size="sm" className="w-full" onClick={() => { setMsgs([]); setConvo(""); }}>+ New conversation</Button>
      </div>
      <div className="flex-1 space-y-0.5 overflow-y-auto px-2 pb-3">
        {!data?.length && <p className="px-2 pt-2 text-[12px] text-ink-3">Conversations are kept here, on every device that signs in.</p>}
        {data?.map((c) => (
          <div key={c.id} className={cx("group flex items-center rounded-md", c.id === convo ? "bg-accent-soft" : "hover:bg-s2")}>
            <button onClick={() => void open(c.id)} className="min-w-0 flex-1 px-2.5 py-1.5 text-left">
              <div className={cx("truncate text-[12.5px]", c.id === convo ? "text-ink font-medium" : "text-ink-2")}>{c.title}</div>
              <div className="text-[10.5px] text-ink-3">{fmtAgo(c.updated_at)}</div>
            </button>
            <button onClick={() => void remove(c.id)} className="hidden px-2 text-ink-3 hover:text-bad group-hover:block" aria-label="Delete conversation" title="Delete">✕</button>
          </div>
        ))}
      </div>
    </aside>
  );
}

function Now({ ask }: { ask: (q: string) => void }) {
  const { data: sys } = useApi<SystemInfo>("/system", { range: "15m" }, 10_000, null);
  const { data: ov } = useApi<Overview>("/overview", { range: "1h" }, 30_000, null);
  const { data: inc } = useApi<Incident[]>("/incidents", { status: "open", limit: 20 }, 30_000, null);
  const { data: lens } = useApi<LensRun[]>("/lens", undefined, 60_000, null);
  const last = lens?.find((r) => r.status === "done");
  const fresh = last?.findings.filter((f) => f.status === "new" && f.kind === "needs-attention").length ?? 0;
  const t = ov?.totals;
  const loaded = sys?.instances.filter((i) => i.state === "ready").length;
  const pressure = sys?.system.pressure ?? 1;
  const rows: { label: string; value: string; tone?: "warn" | "bad"; q: string }[] = [
    { label: "Requests, last hour", value: fmtInt(t?.requests), q: "Summarise the last hour of traffic: who called, which models answered, how fast and how much it cost." },
    { label: "Errors", value: t ? `${fmtInt(t.errors)} · ${fmtPct(t.errorRate)}` : "—", tone: t?.errors ? "bad" : undefined, q: "Why did requests fail in the last hour? Find the causes and propose fixes." },
    { label: "Open incidents", value: fmtInt(inc?.length), tone: inc?.length ? "warn" : undefined, q: "Go through the open incidents: what happened, and what should we do?" },
    { label: "Lens", value: last ? (fresh ? `${fresh} new · ${fmtAgo(last.ts)}` : `${last.findings.length} findings · ${fmtAgo(last.ts)}`) : "—", tone: fresh ? "warn" : undefined,
      q: last ? `Go through Lens's latest investigation (${last.id}, “${last.title}”): what matters most, and what should we fix?` : "Run a Lens investigation of the last 24 hours and tell me what it finds." },
    { label: "Models loaded", value: sys?.role === "gateway" ? "on nodes" : fmtInt(loaded), q: "What is loaded, on which machine, and is that the right set for the traffic we get?" },
    { label: "Memory pressure", value: pressure === 4 ? "critical" : pressure === 2 ? "warn" : "normal", tone: pressure > 1 ? "bad" : undefined, q: "How is memory on the machines that run models? Is anything at risk?" },
  ];
  return (
    <section>
      <h2 className="mb-2 text-[10.5px] font-semibold uppercase tracking-wider text-ink-3">mux now</h2>
      <div className="divide-y divide-line rounded-lg border border-line">
        {rows.map((r) => (
          <button key={r.label} onClick={() => ask(r.q)} title={`Ask: ${r.q}`} className="flex w-full items-center justify-between px-3 py-2 text-left text-[12.5px] hover:bg-s2">
            <span className="text-ink-2">{r.label}</span>
            <span className={cx("num", r.tone === "bad" ? "text-bad" : r.tone === "warn" ? "text-warn" : "text-ink")}>{r.value}</span>
          </button>
        ))}
      </div>
    </section>
  );
}

function Brain({ ask }: { ask: (q: string) => void }) {
  const { data } = useApi<{ pages: BrainPage[]; stats: BrainStats }>("/brain", { limit: 6 }, 30_000, null);
  const s = data?.stats;
  return (
    <section>
      <div className="mb-2 flex items-center justify-between">
        <h2 className="flex items-center gap-1.5 text-[10.5px] font-semibold uppercase tracking-wider text-ink-3">{brainIcon} Brain</h2>
        <Link to="/brain" className="text-[11px] text-accent hover:underline">Open</Link>
      </div>
      <p className="mb-2 text-[11.5px] text-ink-3">
        {s ? `${fmtInt(s.pages)} pages${s.pages ? ` · ${fmtInt(s.embedded)} embedded` : ""}${s.embedding ? "" : " · embeddings unavailable, searching by words"}` : "…"}
      </p>
      {s && !s.pages && <p className="text-[12px] text-ink-2">Empty so far. The assistant and the doctor write here as they learn how this mux is set up and what fixed what.</p>}
      <div className="space-y-1">
        {data?.pages.map((p) => (
          <div key={p.id} className="rounded-md border border-line px-2.5 py-1.5">
            <Link to={`/brain?page=${encodeURIComponent(p.id)}`} className="block truncate text-[12.5px] hover:text-accent" title={p.title}>{p.title}</Link>
            <div className="text-[10.5px] text-ink-3">{p.kind}{p.subject ? ` · ${p.subject}` : ""} · {fmtAgo(p.updated_at)}</div>
          </div>
        ))}
      </div>
      {!!s?.pages && <button onClick={() => ask("Look through your brain: is anything there out of date or wrong compared with how mux is now? Fix what is.")} className="mt-2 text-[11.5px] text-accent hover:underline">Ask it to tidy its brain</button>}
    </section>
  );
}
