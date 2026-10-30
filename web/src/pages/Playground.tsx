import { useEffect, useRef, useState } from "react";
import { api, type Model, type Route } from "../api";
import { Badge, Button, Card, ErrorNote, Field, Input, Meter, PageHeader, Segmented, Select, Spinner, Tabs, Textarea, Toggle } from "../components/ui";
import { fmtMs } from "../format";
import { useApi } from "../hooks";

interface Msg { role: "user" | "assistant"; content: string; meta?: Meta }
interface Meta { model: string; route: string; fallbacks: string; cold: string; ttftMs: number | null; totalMs: number; tokens: number; tps: number | null; requestId: string }

export default function PlaygroundPage() {
  const [tab, setTab] = useState<"chat" | "systemone">("chat");
  const { data: key } = useApi<{ key: string }>("/playground-key");
  return (
    <>
      <PageHeader title="Playground" subtitle="Talk to mux the way a SaaS does — through the gateway, metered as the Playground tenant." />
      <Tabs value={tab} onChange={setTab} tabs={[{ value: "chat", label: "Chat" }, { value: "systemone", label: "System One" }]} />
      {key && (tab === "chat" ? <Chat apiKey={key.key} /> : <SystemOne apiKey={key.key} />)}
    </>
  );
}

function Chat({ apiKey }: { apiKey: string }) {
  const { data: routes } = useApi<Route[]>("/routes");
  const { data: models } = useApi<Model[]>("/models");
  const [model, setModel] = useState("auto");
  const [system, setSystem] = useState("You are a helpful assistant for a Danish SaaS company. Answer briefly.");
  const [flavour, setFlavour] = useState<"openai" | "anthropic">("openai");
  const [stream, setStream] = useState(true);
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const abort = useRef<AbortController | null>(null);
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => { end.current?.scrollIntoView({ behavior: "smooth", block: "end" }); }, [msgs]);

  const send = async () => {
    if (!input.trim() || busy) return;
    const history: Msg[] = [...msgs, { role: "user", content: input.trim() }];
    setMsgs([...history, { role: "assistant", content: "" }]);
    setInput(""); setBusy(true); setErr(null);
    const ac = new AbortController();
    abort.current = ac;
    const t0 = performance.now();
    let first: number | null = null, text = "", tokens = 0;
    const update = (meta?: Meta) => setMsgs([...history, { role: "assistant", content: text, meta }]);
    try {
      const isA = flavour === "anthropic";
      const body = isA
        ? { model, max_tokens: 1024, stream, system, messages: history.map(({ role, content }) => ({ role, content })) }
        : { model, stream, stream_options: stream ? { include_usage: true } : undefined, messages: [{ role: "system", content: system }, ...history.map(({ role, content }) => ({ role, content }))] };
      const res = await fetch(isA ? "/v1/messages" : "/v1/chat/completions", { method: "POST", signal: ac.signal, headers: { "content-type": "application/json", ...(isA ? { "x-api-key": apiKey } : { authorization: `Bearer ${apiKey}` }), "x-mux-agent": "playground" }, body: JSON.stringify(body) });
      const h = (k: string) => res.headers.get(k) ?? "";
      const meta = (): Meta => {
        const total = performance.now() - t0;
        return { model: h("x-mux-model"), route: h("x-mux-route"), fallbacks: h("x-mux-fallbacks"), cold: h("x-mux-cold-start"), ttftMs: first ? first - t0 : null, totalMs: total, tokens, tps: first && tokens > 1 ? tokens / ((performance.now() - first) / 1000) : null, requestId: h("x-mux-request-id") };
      };
      if (!res.ok) { const j = await res.json().catch(() => ({})); throw new Error(j.error?.message ?? `${res.status}`); }
      if (!stream) {
        const j = await res.json();
        first = performance.now();
        text = isA ? (j.content ?? []).map((b: { type: string; text?: string; name?: string; input?: unknown }) => (b.type === "text" ? b.text : `[tool_use ${b.name} ${JSON.stringify(b.input)}]`)).join("") : j.choices?.[0]?.message?.content ?? JSON.stringify(j.choices?.[0]?.message?.tool_calls);
        tokens = isA ? j.usage?.output_tokens : j.usage?.completion_tokens;
        update(meta());
        return;
      }
      const reader = res.body!.getReader();
      const dec = new TextDecoder();
      let buf = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let i: number;
        while ((i = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
          if (!line.startsWith("data:")) continue;
          const d = line.slice(5).trim();
          if (d === "[DONE]") continue;
          let j; try { j = JSON.parse(d); } catch { continue; }
          const piece = isA ? (j.type === "content_block_delta" && j.delta?.type === "text_delta" ? j.delta.text : "") : j.choices?.[0]?.delta?.content ?? "";
          if (j.error) throw new Error(j.error.message ?? "stream error");
          if (piece) { first ??= performance.now(); text += piece; tokens++; update(); }
          if (!isA && j.usage?.completion_tokens) tokens = j.usage.completion_tokens;
          if (isA && j.type === "message_delta" && j.usage?.output_tokens) tokens = j.usage.output_tokens;
        }
      }
      update(meta());
    } catch (e) {
      if ((e as Error).name !== "AbortError") setErr((e as Error).message);
      setMsgs(history);
    } finally { setBusy(false); abort.current = null; }
  };

  return (
    <div className="grid gap-4 lg:grid-cols-[300px_1fr]">
      <Card title="Setup">
        <div className="space-y-3">
          <Field label="Route or model">
            <Select value={model} onChange={(e) => setModel(e.target.value)}>
              <optgroup label="Routes">{routes?.filter((r) => r.kind === "chat").map((r) => <option key={r.name} value={r.name}>{r.name}</option>)}</optgroup>
              <optgroup label="Models">{models?.filter((m) => m.kind === "chat").map((m) => <option key={m.id} value={m.id}>{m.id}</option>)}</optgroup>
              <optgroup label="Hosted names (go to the default)"><option value="gpt-4o">gpt-4o</option><option value="claude-sonnet-4-5">claude-sonnet-4-5</option></optgroup>
            </Select>
          </Field>
          <Field label="API shape"><Segmented value={flavour} onChange={setFlavour} options={[{ value: "openai", label: "OpenAI" }, { value: "anthropic", label: "Anthropic" }]} /></Field>
          <Toggle checked={stream} onChange={setStream} label="Stream" />
          <Field label="System prompt"><Textarea rows={6} value={system} onChange={(e) => setSystem(e.target.value)} /></Field>
          <Button variant="ghost" onClick={() => setMsgs([])}>Clear conversation</Button>
        </div>
      </Card>
      <Card pad={false} className="flex min-h-[560px] flex-col">
        <div className="flex-1 space-y-4 overflow-y-auto p-4" style={{ maxHeight: "65vh" }}>
          {!msgs.length && <p className="pt-16 text-center text-[12.5px] text-ink-3">Ask something. Try Danish, code, or a reasoning question and watch which model the auto route picks.</p>}
          {msgs.map((m, i) => (
            <div key={i} className={m.role === "user" ? "flex justify-end" : ""}>
              <div className={`max-w-[85%] rounded-lg px-3.5 py-2.5 text-[13px] leading-relaxed whitespace-pre-wrap ${m.role === "user" ? "bg-accent text-white" : "bg-s2 text-ink"}`}>
                {m.content || (busy && i === msgs.length - 1 ? <Spinner /> : "")}
                {m.meta && (
                  <div className="mt-2 flex flex-wrap gap-1 border-t border-line pt-2">
                    <Badge tone="accent">{m.meta.model}</Badge>{m.meta.route && <Badge tone="muted">route {m.meta.route}</Badge>}
                    {m.meta.cold === "1" && <Badge tone="warn">cold start</Badge>}{m.meta.fallbacks !== "0" && m.meta.fallbacks && <Badge tone="warn">{m.meta.fallbacks} fallback</Badge>}
                    <Badge tone="muted">first token {fmtMs(m.meta.ttftMs)}</Badge><Badge tone="muted">total {fmtMs(m.meta.totalMs)}</Badge>
                    {m.meta.tps && <Badge tone="muted">{m.meta.tps.toFixed(1)} tok/s</Badge>}<Badge tone="muted">{m.meta.tokens} tokens</Badge>
                  </div>
                )}
              </div>
            </div>
          ))}
          <div ref={end} />
        </div>
        <ErrorNote error={err} />
        <form className="flex gap-2 border-t border-line p-3" onSubmit={(e) => { e.preventDefault(); void send(); }}>
          <Input value={input} onChange={(e) => setInput(e.target.value)} placeholder="Message…" className="h-9" />
          {busy ? <Button type="button" onClick={() => abort.current?.abort()}>Stop</Button> : <Button variant="primary" type="submit" disabled={!input.trim()}>Send</Button>}
        </form>
      </Card>
    </div>
  );
}

const SAMPLE = JSON.stringify({
  state: "Customer message: \"Jeg vil gerne opsige mit abonnement med det samme, det er alt for dyrt.\"",
  questions: {
    intent: { type: "choice", instructions: "What does the customer want?", criteria: { cancel: "cancel the subscription", downgrade: "move to a cheaper plan", question: "ask a question", complaint: "complain without a request" } },
    urgency: { type: "score", instructions: "How urgent is it?", criteria: ["low", "medium", "high"] },
    price_sensitive: { type: "noul", instructions: "Is price the reason?" },
  },
}, null, 2);

function SystemOne({ apiKey }: { apiKey: string }) {
  const { data: routes } = useApi<Route[]>("/routes");
  const { data: models } = useApi<Model[]>("/models");
  const [model, setModel] = useState("systemone");
  const [body, setBody] = useState(SAMPLE);
  const [out, setOut] = useState<{ answers?: Record<string, { type: string; choice?: string; score?: number; probabilities?: Record<string, number>; confidence?: number; legend?: Record<string, string>; noul?: unknown }>; model?: string; ms?: number } | null>(null);
  const [meta, setMeta] = useState<{ ms: number; model: string } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const run = async () => {
    setErr(null); setBusy(true);
    try {
      const parsed = JSON.parse(body);
      const t0 = performance.now();
      const res = await fetch("/v1/systemone", { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` }, body: JSON.stringify({ ...parsed, model }) });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error?.message ?? res.statusText);
      setOut(j); setMeta({ ms: performance.now() - t0, model: res.headers.get("x-mux-model") ?? "" });
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };
  void api;
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card title="Request" subtitle="Jev's System One shape: a state and typed questions, answered with probabilities in one pass.">
        <div className="mb-3 flex gap-2">
          <Select value={model} onChange={(e) => setModel(e.target.value)}>
            {routes?.filter((r) => r.kind === "systemone").map((r) => <option key={r.name} value={r.name}>route {r.name}</option>)}
            {models?.filter((m) => m.kind === "systemone").map((m) => <option key={m.id} value={m.id}>{m.id}</option>)}
          </Select>
          <Button variant="primary" onClick={run} disabled={busy}>{busy ? <Spinner /> : "Ask"}</Button>
        </div>
        <ErrorNote error={err} />
        <Textarea rows={22} value={body} onChange={(e) => setBody(e.target.value)} />
      </Card>
      <Card title="Answers" subtitle={meta ? `${meta.model} · ${fmtMs(meta.ms)} round trip${out?.ms != null ? ` · ${out.ms} ms model` : ""}` : undefined}>
        {!out?.answers ? <p className="text-[12.5px] text-ink-3">The first call loads the model (Laya downloads ~1.7 GB once).</p> : (
          <div className="space-y-5">
            {Object.entries(out.answers).map(([id, a]) => (
              <div key={id}>
                <div className="mb-1.5 flex items-center justify-between">
                  <span className="font-mono text-[12.5px] font-semibold">{id}</span>
                  <span className="text-[12px] text-ink-2">{a.type === "choice" ? <>→ <b>{a.choice}</b></> : a.type === "score" ? <>score <b>{a.score?.toFixed(2)}</b></> : <>→ <b>{String(a.noul)}</b></>}{a.confidence != null && <span className="ml-2 text-ink-3">confidence {(a.confidence * 100).toFixed(0)}%</span>}</span>
                </div>
                <div className="space-y-1">
                  {Object.entries(a.probabilities ?? {}).sort((x, y) => y[1] - x[1]).map(([k, p]) => (
                    <div key={k} className="grid grid-cols-[110px_1fr_48px] items-center gap-2 text-[12px]">
                      <span className="truncate text-ink-2">{a.legend?.[k] ?? k}</span><Meter value={p} max={1} height={8} /><span className="num text-right">{(p * 100).toFixed(1)}%</span>
                    </div>
                  ))}
                </div>
              </div>
            ))}
            <details><summary className="cursor-pointer text-[12px] text-ink-3">Raw response</summary><pre className="code mt-2 rounded bg-s2 p-2">{JSON.stringify(out, null, 2)}</pre></details>
          </div>
        )}
      </Card>
    </div>
  );
}
