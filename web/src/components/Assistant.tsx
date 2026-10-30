import { useEffect, useRef, useState, type ReactNode } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { getToken, type Model, type Route } from "../api";
import { useApi, usePersisted } from "../hooks";
import { Button, cx, Select, Spinner } from "./ui";

/**
 * The assistant: a chat beside every page that runs mux with mux. It reads the admin API, the logs and the system on
 * its own; a change it wants to make shows here with its method, path and body, and runs only when approved.
 */
interface Call { id: string; type: "function"; function: { name: string; arguments: string } }
interface Msg { role: "user" | "assistant" | "tool"; content: string | null; tool_calls?: Call[]; tool_call_id?: string; reasoning_content?: string; model?: string }
interface Meta { model: string | null; route: string | null; requestId: string | null }

const SUGGESTIONS = [
  "What is broken or unhealthy right now?",
  "Why did the last failed requests fail?",
  "Is the Mac Studio healthy, and what is loaded on it?",
  "Which models should the agent route use, and why?",
  "Set up a new tenant for a SaaS product, with a key",
  "How fast and how expensive was the last 24 hours?",
];

const args = (c: Call): Record<string, unknown> => { try { return JSON.parse(c.function.arguments || "{}"); } catch { return {}; } };
const isChange = (c: Call) => c.function.name === "mux_api" && String(args(c).method ?? "GET").toUpperCase() !== "GET" && !/\/routes\/explain$/.test(String(args(c).path ?? ""));

function label(c: Call): string {
  const a = args(c);
  switch (c.function.name) {
    case "mux_api": return `${String(a.method ?? "GET").toUpperCase()} ${a.path ?? ""}${a.query && Object.keys(a.query as object).length ? `?${new URLSearchParams(a.query as Record<string, string>)}` : ""}`;
    case "read_log": return `log ${a.source === "model" ? a.model : "mux"}${a.node ? ` on ${a.node}` : ""}${a.grep ? ` | grep ${a.grep}` : ""}`;
    case "test_request": return `test ${a.model ?? "auto"}: “${String(a.prompt ?? "").slice(0, 50)}”`;
    case "open_page": return `open ${a.path}`;
    default: return c.function.name;
  }
}

export function AssistantPanel({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [msgs, setMsgs] = usePersisted<Msg[]>("assistant.messages", []);
  const [convo, setConvo] = usePersisted<string>("assistant.conversation", "");
  const [model, setModel] = usePersisted<string>("assistant.model", "");
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [live, setLive] = useState<{ text: string; reasoning: string; meta: Meta | null }>({ text: "", reasoning: "", meta: null });
  const [pending, setPending] = useState<string[]>([]);
  const abort = useRef<AbortController | null>(null);
  const end = useRef<HTMLDivElement>(null);
  const nav = useNavigate();
  const loc = useLocation();
  const { data: routes } = useApi<Route[]>(open ? "/routes" : null, undefined, undefined, null);
  const { data: models } = useApi<Model[]>(open ? "/models" : null, undefined, undefined, null);

  useEffect(() => { end.current?.scrollIntoView({ block: "end" }); }, [msgs, live, open]);
  // A transcript that ended on a change the user has not answered: show its approval again.
  useEffect(() => {
    const last = [...msgs].reverse().find((m) => m.role !== "tool");
    if (!busy && last?.role === "assistant" && last.tool_calls?.length) {
      const done = new Set(msgs.filter((m) => m.role === "tool").map((m) => m.tool_call_id));
      setPending(last.tool_calls.filter((c) => !done.has(c.id) && isChange(c)).map((c) => c.id));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const run = async (messages: Msg[], approvals?: Record<string, boolean>) => {
    setBusy(true); setErr(null); setPending([]);
    setLive({ text: "", reasoning: "", meta: null });
    let shown = messages;
    setMsgs(shown);
    const ac = new AbortController();
    abort.current = ac;
    try {
      const res = await fetch("/api/admin/assistant", {
        method: "POST", signal: ac.signal,
        headers: { "content-type": "application/json", authorization: `Bearer ${getToken()}` },
        body: JSON.stringify({ messages, approvals, page: loc.pathname, model: model || undefined, conversation: convo || undefined }),
      });
      if (!res.ok) { const j = await res.json().catch(() => ({})); throw new Error(j.error ?? `${res.status}`); }
      const reader = res.body!.getReader();
      const dec = new TextDecoder();
      let buf = "";
      // Calls and results as they happen, so the transcript grows while the assistant works.
      const step: { text: string; reasoning: string; calls: Call[] } = { text: "", reasoning: "", calls: [] };
      const flush = () => {
        if (!step.text && !step.calls.length) return;
        shown = [...shown, { role: "assistant", content: step.text || null, ...(step.calls.length ? { tool_calls: step.calls } : {}), ...(step.reasoning ? { reasoning_content: step.reasoning } : {}) }];
        step.text = ""; step.reasoning = ""; step.calls = [];
      };
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let i: number;
        while ((i = buf.indexOf("\n\n")) >= 0) {
          const block = buf.slice(0, i); buf = buf.slice(i + 2);
          const type = /^event: (.+)$/m.exec(block)?.[1];
          const data = /^data: (.+)$/m.exec(block)?.[1];
          if (!type || !data) continue;
          const d = JSON.parse(data);
          if (type === "delta") { step.text += d.text; setLive((l) => ({ ...l, text: step.text })); }
          else if (type === "reasoning") { step.reasoning += d.text; setLive((l) => ({ ...l, reasoning: step.reasoning })); }
          else if (type === "meta") setLive((l) => ({ ...l, meta: d }));
          else if (type === "call") {
            step.calls.push({ id: d.id, type: "function", function: { name: d.name, arguments: JSON.stringify(d.args) } });
          } else if (type === "result") {
            flush();
            shown = [...shown, { role: "tool", tool_call_id: d.id, content: d.content }];
            setMsgs(shown); setLive({ text: "", reasoning: "", meta: null });
          } else if (type === "navigate") nav(d.path);
          else if (type === "pending") setPending(d.ids);
          else if (type === "error") setErr(d.message);
          else if (type === "messages") { setMsgs(d.messages); if (d.conversation) setConvo(d.conversation); }
        }
      }
    } catch (e) {
      if (!ac.signal.aborted) setErr((e as Error).message);
    } finally {
      setBusy(false);
      setLive({ text: "", reasoning: "", meta: null });
      abort.current = null;
    }
  };

  const send = (text = input) => {
    if (!text.trim() || busy) return;
    setInput("");
    void run([...msgs, { role: "user", content: text.trim() }]);
  };
  const answer = (approve: boolean, only?: string) => {
    const approvals = Object.fromEntries(pending.map((id) => [id, only ? id === only && approve : approve]));
    void run(msgs, approvals);
  };
  const reset = () => { abort.current?.abort(); setMsgs([]); setConvo(""); setPending([]); setErr(null); };

  const results = new Map(msgs.filter((m) => m.role === "tool").map((m) => [m.tool_call_id, m.content ?? ""]));
  const calls = new Map(msgs.flatMap((m) => m.tool_calls ?? []).map((c) => [c.id, c]));
  const chatModels = (models ?? []).filter((m) => m.kind === "chat" && m.enabled);

  return (
    <aside className={cx("fixed inset-y-0 right-0 z-50 flex w-full max-w-[460px] flex-col border-l border-line bg-s1 shadow-2xl transition-transform", open ? "translate-x-0" : "translate-x-full")} aria-hidden={!open}>
      <div className="flex h-12 shrink-0 items-center gap-2 border-b border-line px-3">
        <span className="text-accent">{sparkle}</span>
        <span className="text-[14px] font-semibold">Assistant</span>
        <Select className="ml-auto w-36" value={model} onChange={(e) => setModel(e.target.value)} title="The route or model the assistant thinks with">
          <option value="">Default (settings)</option>
          {(routes ?? []).filter((r) => r.kind === "chat").map((r) => <option key={r.name} value={r.name}>route: {r.name}</option>)}
          {chatModels.map((m) => <option key={m.id} value={m.id}>{m.id}</option>)}
        </Select>
        <Button size="sm" variant="ghost" onClick={reset} disabled={!msgs.length} title="Start a new conversation">New</Button>
        <button onClick={onClose} className="text-ink-3 hover:text-ink" aria-label="Close">✕</button>
      </div>

      <div className="flex-1 space-y-3 overflow-y-auto p-3 text-[13px]">
        {!msgs.length && (
          <div className="pt-6">
            <p className="mb-1 text-[15px] font-medium">Run mux with mux.</p>
            <p className="mb-4 text-ink-3 text-[12.5px]">The assistant reads everything — models, routes, tenants, providers, requests, logs, the system — on its own. Changes wait for your approval here.</p>
            <div className="grid gap-1.5">
              {SUGGESTIONS.map((s) => <button key={s} onClick={() => send(s)} className="rounded-md border border-line px-3 py-2 text-left text-ink-2 hover:bg-s2 hover:text-ink">{s}</button>)}
            </div>
          </div>
        )}
        {msgs.map((m, i) => {
          if (m.role === "user") return <div key={i} className="ml-8 rounded-lg bg-accent-soft px-3 py-2 whitespace-pre-wrap">{m.content}</div>;
          if (m.role === "tool") return null;
          return (
            <div key={i} className="space-y-1.5">
              {m.reasoning_content && <Thinking text={m.reasoning_content} />}
              {m.content && <Markdown text={m.content} />}
              {m.tool_calls?.map((c) => <CallRow key={c.id} call={c} result={results.get(c.id)} pending={pending.includes(c.id)} busy={busy} onAnswer={(a) => answer(a, pending.length > 1 ? c.id : undefined)} />)}
              {m.model && i === msgs.length - 1 && <div className="text-[10.5px] text-ink-3">{m.model}</div>}
            </div>
          );
        })}
        {busy && (
          <div className="space-y-1.5">
            {live.reasoning && <Thinking text={live.reasoning} open />}
            {live.text ? <Markdown text={live.text} /> : <div className="flex items-center gap-2 text-ink-3"><Spinner /> {live.meta?.model ? `thinking with ${live.meta.model}` : "working…"}</div>}
          </div>
        )}
        {pending.length > 1 && !busy && (
          <div className="flex gap-2">
            <Button size="sm" variant="primary" onClick={() => answer(true)}>Approve all {pending.length}</Button>
            <Button size="sm" onClick={() => answer(false)}>Decline all</Button>
          </div>
        )}
        {err && <div className="rounded-md border border-bad/40 bg-bad/10 px-3 py-2 text-[12px] text-bad">{err}</div>}
        <div ref={end} />
      </div>

      <form className="shrink-0 border-t border-line p-3" onSubmit={(e) => { e.preventDefault(); send(); }}>
        <div className="flex items-end gap-2">
          <textarea value={input} onChange={(e) => setInput(e.target.value)} rows={2} placeholder={pending.length ? "Or say what to do instead…" : "Ask about mux, or tell it what to fix…"}
            onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } }}
            className="min-h-[44px] flex-1 resize-none rounded-md border border-line bg-bg px-3 py-2 text-[13px] outline-none focus:border-accent" />
          {busy ? <Button onClick={() => abort.current?.abort()}>Stop</Button> : <Button variant="primary" type="submit" disabled={!input.trim()}>Send</Button>}
        </div>
        <div className="mt-1.5 text-[10.5px] text-ink-3">Enter sends · Shift+Enter for a new line · on {loc.pathname}{calls.size ? ` · ${calls.size} tool calls` : ""}</div>
      </form>
    </aside>
  );
}

function CallRow({ call, result, pending, busy, onAnswer }: { call: Call; result?: string; pending: boolean; busy: boolean; onAnswer: (approve: boolean) => void }) {
  const [open, setOpen] = useState(false);
  const change = isChange(call);
  const a = args(call);
  let status: ReactNode = <Spinner />;
  let failed = false;
  if (result !== undefined) {
    try {
      const r = JSON.parse(result);
      failed = !!r?.error || (typeof r?.status === "number" && r.status >= 400);
      if (r?.error === "the user declined this change" || String(r?.error ?? "").startsWith("not run")) status = <span className="text-ink-3">declined</span>;
      else status = <span className={failed ? "text-bad" : "text-good"}>{failed ? "✕" : "✓"}{typeof r?.status === "number" ? ` ${r.status}` : ""}</span>;
    } catch { status = <span className="text-good">✓</span>; }
  } else if (pending) status = <span className="text-warn">needs approval</span>;
  else if (!busy) status = <span className="text-ink-3">not run</span>;

  return (
    <div className={cx("rounded-md border text-[12px]", pending ? "border-warn/60 bg-warn/5" : "border-line bg-bg/40")}>
      <button onClick={() => setOpen(!open)} className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left">
        <span className={cx("font-mono truncate", change ? "text-ink" : "text-ink-2")}>{label(call)}</span>
        <span className="ml-auto shrink-0">{status}</span>
      </button>
      {pending && (
        <div className="space-y-2 border-t border-line px-2.5 py-2">
          {typeof a.why === "string" && <p className="text-ink-2">{a.why}</p>}
          {a.body !== undefined && <pre className="max-h-48 overflow-auto rounded bg-s2 p-2 font-mono text-[11px]">{JSON.stringify(a.body, null, 2)}</pre>}
          <div className="flex gap-2">
            <Button size="sm" variant="primary" disabled={busy} onClick={() => onAnswer(true)}>Approve</Button>
            <Button size="sm" disabled={busy} onClick={() => onAnswer(false)}>Decline</Button>
          </div>
        </div>
      )}
      {open && (
        <div className="space-y-1.5 border-t border-line px-2.5 py-2">
          <pre className="max-h-40 overflow-auto rounded bg-s2 p-2 font-mono text-[11px]">{JSON.stringify(a, null, 2)}</pre>
          {result !== undefined && <pre className="max-h-72 overflow-auto rounded bg-s2 p-2 font-mono text-[11px] whitespace-pre-wrap">{pretty(result)}</pre>}
        </div>
      )}
    </div>
  );
}

function Thinking({ text, open: initial }: { text: string; open?: boolean }) {
  const [open, setOpen] = useState(!!initial);
  return (
    <div className="text-[12px] text-ink-3">
      <button onClick={() => setOpen(!open)} className="hover:text-ink-2">{open ? "▾" : "▸"} thinking</button>
      {open && <div className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap border-l-2 border-line pl-2">{text}</div>}
    </div>
  );
}

const pretty = (s: string) => { try { return JSON.stringify(JSON.parse(s), null, 2); } catch { return s; } };

/** Enough Markdown for an assistant's answers: headings, lists, code, tables, bold, inline code and links. */
function Markdown({ text }: { text: string }) {
  const out: ReactNode[] = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (l.startsWith("```")) {
      const body: string[] = [];
      while (++i < lines.length && !lines[i].startsWith("```")) body.push(lines[i]);
      out.push(<pre key={i} className="overflow-auto rounded bg-s2 p-2 font-mono text-[11.5px]">{body.join("\n")}</pre>);
    } else if (/^\|.*\|\s*$/.test(l)) {
      const rows: string[][] = [];
      for (; i < lines.length && /^\|.*\|\s*$/.test(lines[i]); i++) if (!/^\|[\s:|-]+\|\s*$/.test(lines[i])) rows.push(lines[i].trim().slice(1, -1).split("|").map((c) => c.trim()));
      i--;
      out.push(
        <div key={i} className="overflow-auto"><table className="w-full text-[12px]"><tbody>
          {rows.map((r, j) => <tr key={j} className={cx("border-b border-line", j === 0 && "font-medium")}>{r.map((c, k) => <td key={k} className="px-1.5 py-1 align-top">{inline(c)}</td>)}</tr>)}
        </tbody></table></div>,
      );
    } else if (/^#{1,4} /.test(l)) out.push(<div key={i} className="pt-1 font-semibold">{inline(l.replace(/^#+ /, ""))}</div>);
    else if (/^\s*([-*]|\d+\.) /.test(l)) {
      const items: string[] = [];
      const ordered = /^\s*\d+\./.test(l);
      for (; i < lines.length && /^\s*([-*]|\d+\.) /.test(lines[i]); i++) items.push(lines[i].replace(/^\s*([-*]|\d+\.) /, ""));
      i--;
      const List = ordered ? "ol" : "ul";
      out.push(<List key={i} className={cx("space-y-0.5 pl-5", ordered ? "list-decimal" : "list-disc")}>{items.map((x, j) => <li key={j}>{inline(x)}</li>)}</List>);
    } else if (l.trim()) out.push(<p key={i}>{inline(l)}</p>);
  }
  return <div className="space-y-1.5 leading-relaxed">{out}</div>;
}

function inline(s: string): ReactNode[] {
  const parts = s.split(/(`[^`]+`|\*\*[^*]+\*\*|\[[^\]]+\]\([^)]+\))/g);
  return parts.map((p, i) => {
    if (p.startsWith("`") && p.endsWith("`") && p.length > 1) return <code key={i} className="rounded bg-s2 px-1 font-mono text-[11.5px]">{p.slice(1, -1)}</code>;
    if (p.startsWith("**") && p.endsWith("**")) return <strong key={i}>{p.slice(2, -2)}</strong>;
    const link = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(p);
    if (link) {
      const href = link[2];
      const internal = href.startsWith("/");
      return /^(https?:\/\/|\/)/.test(href) ? <a key={i} href={href} target={internal ? undefined : "_blank"} rel="noreferrer" className="text-accent underline">{link[1]}</a> : link[1];
    }
    return p;
  });
}

export const sparkle = <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8zM19 16l.8 2.2L22 19l-2.2.8L19 22l-.8-2.2L16 19l2.2-.8z" /></svg>;
