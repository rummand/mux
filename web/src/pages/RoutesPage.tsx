import { useState } from "react";
import { api, type IntentRouting, type Model, type Route, type Tenant } from "../api";
import { Badge, Button, Card, Empty, ErrorNote, Field, Input, KeyValue, Modal, PageHeader, Select, StatusDot, Textarea, Toggle } from "../components/ui";
import { useApi } from "../hooks";

const STRATEGIES: { value: Route["strategy"]; label: string; hint: string }[] = [
  { value: "priority", label: "Priority", hint: "the first candidate that can take it; the next on failure" },
  { value: "auto", label: "Auto", hint: "scores each candidate on the request: tools, code, reasoning, Danish, images, length, loaded" },
  { value: "fastest", label: "Fastest", hint: "highest measured tok/s, loaded models first" },
  { value: "quality", label: "Quality", hint: "highest quality capability first" },
];

export default function RoutesPage() {
  const routes = useApi<Route[]>("/routes");
  const { data: models } = useApi<Model[]>("/models", undefined, 10_000);
  const [creating, setCreating] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const save = async (r: Route) => {
    setErr(null);
    try { await api(`/routes/${r.name}`, { method: "PUT", body: r }); void routes.reload(true); } catch (e) { setErr((e as Error).message); }
  };
  return (
    <>
      <PageHeader title="Routes" subtitle="The names a SaaS asks for. Each route is an ordered set of models and a strategy for choosing among them; failures fall through to the next."
        actions={<Button variant="primary" onClick={() => setCreating(true)}>New route</Button>} />
      <ErrorNote error={routes.error ?? err} />
      <div className="grid gap-4 xl:grid-cols-[1fr_400px]">
        <div className="grid gap-3 lg:grid-cols-2">
          {routes.data?.map((r) => <RouteCard key={r.name} route={r} models={models ?? []} onSave={save} onDelete={async () => { if (confirm(`Delete route ${r.name}?`)) { await api(`/routes/${r.name}`, { method: "DELETE" }); void routes.reload(true); } }} />)}
        </div>
        <div className="space-y-4 xl:sticky xl:top-16 xl:self-start">
          <IntentCard routes={routes.data ?? []} onSave={save} />
          <Explain routes={routes.data ?? []} />
        </div>
      </div>
      <NewRoute open={creating} onClose={() => setCreating(false)} onSave={async (r) => { await save(r); setCreating(false); }} />
    </>
  );
}

function RouteCard({ route, models, onSave, onDelete }: { route: Route; models: Model[]; onSave: (r: Route) => void; onDelete: () => void }) {
  const [add, setAdd] = useState("");
  const same = models.filter((m) => m.kind === route.kind);
  const byId = new Map(models.map((m) => [m.id, m]));
  const move = (i: number, d: number) => {
    const c = [...route.candidates];
    const j = i + d;
    if (j < 0 || j >= c.length) return;
    [c[i], c[j]] = [c[j], c[i]];
    onSave({ ...route, candidates: c });
  };
  return (
    <Card title={<span className="font-mono">{route.name}</span>} subtitle={route.description} actions={<><Badge>{route.kind}</Badge><Button size="sm" variant="ghost" onClick={onDelete}>Delete</Button></>}>
      <Field label="Strategy" hint={STRATEGIES.find((s) => s.value === route.strategy)?.hint}>
        <Select value={route.strategy} onChange={(e) => onSave({ ...route, strategy: e.target.value as Route["strategy"] })}>{STRATEGIES.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}</Select>
      </Field>
      <div className="mt-3">
        <div className="mb-1 text-[11.5px] font-medium text-ink-2">Candidates, in order</div>
        {!route.candidates.length ? (
          <p className="rounded-md border border-dashed border-line px-3 py-2 text-[12px] text-ink-3">None listed: every {route.kind} model is a candidate ({same.length}).</p>
        ) : (
          <ol className="space-y-1">
            {route.candidates.map((id, i) => {
              const m = byId.get(id);
              const loaded = m?.instance?.state === "ready" || m?.backend === "external" || m?.backend === "jev";
              return (
                <li key={id} className="flex items-center gap-2 rounded-md border border-line bg-s2 px-2 py-1.5 text-[12.5px]">
                  <span className="w-4 text-ink-3 num">{i + 1}</span>
                  <span className="flex-1 truncate font-mono">{id}</span>
                  {!m ? <Badge tone="bad">missing</Badge> : !m.enabled ? <Badge tone="muted">disabled</Badge> : <StatusDot tone={loaded ? "good" : "muted"} label={loaded ? "ready" : "cold"} />}
                  <button className="px-1 text-ink-3 hover:text-ink" onClick={() => move(i, -1)} aria-label="Up">↑</button>
                  <button className="px-1 text-ink-3 hover:text-ink" onClick={() => move(i, 1)} aria-label="Down">↓</button>
                  <button className="px-1 text-ink-3 hover:text-bad" onClick={() => onSave({ ...route, candidates: route.candidates.filter((c) => c !== id) })} aria-label="Remove">×</button>
                </li>
              );
            })}
          </ol>
        )}
        <div className="mt-2 flex gap-2">
          <Select value={add} onChange={(e) => setAdd(e.target.value)}>
            <option value="">Add a {route.kind} model…</option>
            {same.filter((m) => !route.candidates.includes(m.id)).map((m) => <option key={m.id} value={m.id}>{m.id}</option>)}
          </Select>
          <Button size="sm" disabled={!add} onClick={() => { onSave({ ...route, candidates: [...route.candidates, add] }); setAdd(""); }}>Add</Button>
        </div>
      </div>
    </Card>
  );
}

function NewRoute({ open, onClose, onSave }: { open: boolean; onClose: () => void; onSave: (r: Route) => void }) {
  const [r, setR] = useState<Route>({ name: "", description: "", kind: "chat", strategy: "priority", candidates: [], created_at: 0 });
  return (
    <Modal open={open} onClose={onClose} title="New route" footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" disabled={!/^[a-z0-9][a-z0-9._-]*$/i.test(r.name)} onClick={() => onSave(r)}>Create</Button></>}>
      <div className="space-y-3">
        <Field label="Name" hint="What a SaaS puts in model: e.g. support-da"><Input value={r.name} onChange={(e) => setR({ ...r, name: e.target.value })} className="font-mono" /></Field>
        <Field label="Description"><Input value={r.description} onChange={(e) => setR({ ...r, description: e.target.value })} /></Field>
        <Field label="Kind"><Select value={r.kind} onChange={(e) => setR({ ...r, kind: e.target.value as Route["kind"] })}>{["chat", "embedding", "rerank", "systemone", "transcription", "speech"].map((k) => <option key={k}>{k}</option>)}</Select></Field>
        <Field label="Strategy"><Select value={r.strategy} onChange={(e) => setR({ ...r, strategy: e.target.value as Route["strategy"] })}>{STRATEGIES.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}</Select></Field>
      </div>
    </Modal>
  );
}

interface Explanation { tenant: string; features: Record<string, number | boolean>; route: string | null; reason: string; candidates: { id: string; backend: string; loaded: boolean }[] }

function Explain({ routes }: { routes: Route[] }) {
  const { data: tenants } = useApi<Tenant[]>("/tenants");
  const [tenant, setTenant] = useState("");
  const [model, setModel] = useState("auto");
  const [text, setText] = useState("Skriv en Python-funktion, der beregner moms på 25% af et beløb.");
  const [tools, setTools] = useState(false);
  const [out, setOut] = useState<Explanation | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const run = async () => {
    setErr(null);
    try {
      setOut(await api<Explanation>("/routes/explain", { body: {
        tenant: tenant || undefined, model, messages: [{ role: "user", content: text }],
        ...(tools ? { tools: [{ type: "function", function: { name: "lookup_order", parameters: { type: "object", properties: { id: { type: "string" } } } } }] } : {}),
      } }));
    } catch (e) { setErr((e as Error).message); }
  };
  return (
    <Card title="Explain a decision" subtitle="What the router would do with a request — nothing is sent.">
      <ErrorNote error={err} />
      <div className="space-y-3">
        <div className="grid grid-cols-2 gap-2">
          <Field label="As tenant"><Select value={tenant} onChange={(e) => setTenant(e.target.value)}><option value="">playground</option>{tenants?.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</Select></Field>
          <Field label="model"><Input list="route-names" value={model} onChange={(e) => setModel(e.target.value)} className="font-mono" /><datalist id="route-names">{routes.map((r) => <option key={r.name} value={r.name} />)}<option value="gpt-4o" /><option value="claude-sonnet-4-5" /></datalist></Field>
        </div>
        <Field label="Last user message"><Textarea rows={4} value={text} onChange={(e) => setText(e.target.value)} /></Field>
        <div className="flex items-center justify-between gap-3">
          <Toggle checked={tools} onChange={setTools} label="Request offers a tool" />
          <Button variant="primary" onClick={run}>Explain</Button>
        </div>
      </div>
      {out && (
        <div className="mt-4 space-y-3 border-t border-line pt-4">
          <KeyValue items={[["Route", out.route ?? "(model by name)"], ["Tenant", out.tenant]]} />
          <div className="flex flex-wrap gap-1">{Object.entries(out.features).map(([k, v]) => (typeof v === "boolean" ? v && <Badge key={k} tone="accent">{k}</Badge> : <Badge key={k} tone="muted">{k} {v}</Badge>))}</div>
          <pre className="code rounded-md bg-s2 p-2 text-ink-2">{out.reason}</pre>
          <ol className="space-y-1 text-[12.5px]">{out.candidates.map((c, i) => <li key={c.id} className="flex items-center gap-2"><span className="w-4 text-ink-3 num">{i + 1}</span><span className="flex-1 font-mono">{c.id}</span><StatusDot tone={c.loaded ? "good" : "muted"} label={c.loaded ? "loaded" : "cold"} /></li>)}</ol>
          {!out.candidates.length && <Empty>No candidate.</Empty>}
        </div>
      )}
    </Card>
  );
}

/** Arch-Router on auto routes: whether it is on, what it decided, and the words it matches requests against. */
function IntentCard({ routes, onSave }: { routes: Route[]; onSave: (r: Route) => void }) {
  const { data } = useApi<IntentRouting>("/routes/intent", undefined, 10_000);
  const [editing, setEditing] = useState<string | null>(null);
  const [text, setText] = useState("");
  if (!data) return null;
  const total = data.routed + data.other + data.failed;
  return (
    <Card title="Intent router" subtitle={data.model ? `${data.model} picks the route for requests on auto routes, from what the conversation is about — once per user turn. When it says “other” or is slow, the auto route's own scoring decides.` : "Off: auto routes score models by the request's features. Set intentRouterModel to turn Arch-Router on."}
      actions={<StatusDot tone={data.model ? "good" : "muted"} label={data.model ? "on" : "off"} />}>
      {data.model && (
        <div className="mb-3 grid grid-cols-4 gap-2 text-[12px]">
          <div><div className="text-[10.5px] uppercase tracking-wide text-ink-3">Decided</div><div className="text-[15px] font-semibold num">{data.routed}</div></div>
          <div><div className="text-[10.5px] uppercase tracking-wide text-ink-3">Other</div><div className="text-[15px] font-semibold num">{data.other}</div></div>
          <div><div className="text-[10.5px] uppercase tracking-wide text-ink-3">Failed</div><div className={`text-[15px] font-semibold num ${data.failed ? "text-warn" : ""}`}>{data.failed}</div></div>
          <div><div className="text-[10.5px] uppercase tracking-wide text-ink-3">p50 · p95</div><div className="text-[15px] font-semibold num">{data.p50Ms ?? "—"}<span className="text-[11px] text-ink-3"> · {data.p95Ms ?? "—"} ms</span></div></div>
        </div>
      )}
      {data.lastError && <div className="mb-2 truncate text-[11.5px] text-warn" title={data.lastError}>Last failure: {data.lastError}</div>}
      <div className="space-y-2">
        {data.routes.map((r) => {
          const route = routes.find((x) => x.name === r.name);
          return (
            <div key={r.name} className="text-[12px]">
              <div className="flex items-center gap-2">
                <span className="font-mono font-medium">{r.name}</span>
                {total > 0 && <span className="text-ink-3 num">{data.byRoute[r.name] ?? 0}×</span>}
                {!r.own && <Badge tone="muted" title="mux's built-in words for this route; write your own to replace them">default</Badge>}
                {route && editing !== r.name && <button className="ml-auto text-accent hover:underline" onClick={() => { setEditing(r.name); setText(route.intent || r.intent); }}>Edit</button>}
              </div>
              {editing === r.name && route ? (
                <div className="mt-1 space-y-1">
                  <Textarea rows={3} value={text} onChange={(e) => setText(e.target.value)} />
                  <div className="flex gap-2">
                    <Button size="sm" variant="primary" onClick={() => { onSave({ ...route, intent: text.trim() }); setEditing(null); }}>Save</Button>
                    {r.own && <Button size="sm" onClick={() => { onSave({ ...route, intent: "" }); setEditing(null); }}>Use the default</Button>}
                    <Button size="sm" variant="ghost" onClick={() => setEditing(null)}>Cancel</Button>
                  </div>
                </div>
              ) : <div className="text-ink-2">{r.intent}</div>}
            </div>
          );
        })}
      </div>
    </Card>
  );
}
