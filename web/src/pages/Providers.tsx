import { useState } from "react";
import { Link } from "react-router-dom";
import { api, type Presets, type Provider, type QuotaRow, type Settings } from "../api";
import { Badge, Button, Card, Empty, ErrorNote, Field, Input, Meter, Modal, PageHeader, Select, StatusDot, Table, Td, Th, Toggle } from "../components/ui";
import { fmtAgo, fmtCompact, fmtGb, fmtInt } from "../format";
import { useApi } from "../hooks";

/**
 * Where compute comes from: mux nodes (a Mac running mux) and cloud APIs. Routes mix them; a node going offline takes
 * its models out of every route until it is back.
 */
export default function ProvidersPage() {
  const { data, error, reload } = useApi<Provider[]>("/providers", undefined, 10_000, null);
  const [adding, setAdding] = useState<"mux" | "cloud" | null>(null);
  const [models, setModels] = useState<Provider | null>(null);
  const nodes = (data ?? []).filter((p) => p.kind === "mux");
  const clouds = (data ?? []).filter((p) => p.kind !== "mux");
  return (
    <>
      <PageHeader title="Providers" subtitle="Compute mux routes to: machines running mux (nodes) and paid cloud APIs. Routes can mix them — local first, cloud as the fallback."
        actions={<><Button onClick={() => setAdding("cloud")}>Add cloud API</Button><Button variant="primary" onClick={() => setAdding("mux")}>Add node</Button></>} />
      <ErrorNote error={error} />
      <h2 className="mb-2 text-[12px] font-semibold uppercase tracking-wider text-ink-3">Nodes</h2>
      {!nodes.length ? <Card className="mb-6"><Empty>No nodes yet. Add the Mac Studio: its mux URL (over Tailscale Funnel) and its admin token.</Empty></Card> : (
        <div className="mb-6 grid gap-3 lg:grid-cols-2">
          {nodes.map((p) => <NodeCard key={p.id} p={p} onChange={reload} />)}
        </div>
      )}
      <h2 className="mb-2 text-[12px] font-semibold uppercase tracking-wider text-ink-3">Cloud APIs</h2>
      <Card pad={false}>
        {!clouds.length ? <div className="p-4"><Empty>No cloud APIs. Add one (OpenAI, Anthropic, OpenRouter, Groq…) to use as a fallback or for what the Mac cannot run.</Empty></div> : (
          <Table>
            <thead><tr><Th>Provider</Th><Th>Base URL</Th><Th right>Models</Th><Th right>Requests 24h</Th><Th right>Tokens 24h</Th><Th right>Spend 24h</Th><Th>Enabled</Th><Th /></tr></thead>
            <tbody>
              {clouds.map((p) => (
                <tr key={p.id} className="hover:bg-s2">
                  <Td><Link to={`/providers/${p.id}`} className="font-medium hover:text-accent">{p.name}</Link>
                    {p.plan === "free" && <Badge tone="good" className="ml-1.5">free tier</Badge>}
                    {p.plan === "free" && p.trains_on_data === 1 && <Badge tone="warn" className="ml-1" title="Its free tier may train on the prompts: mux uses it as a rescue only with “free tiers that train” allowed">trains on prompts</Badge>}
                    <div className="font-mono text-[11px] text-ink-3">{p.id} · {p.kind}</div></Td>
                  <Td mono className="max-w-72 truncate text-ink-2">{p.base_url}</Td>
                  <Td right>{p.models.length}</Td>
                  <Td right>{fmtInt(p.usage24h?.n ?? 0)}</Td>
                  <Td right>{fmtCompact(p.usage24h?.tokens ?? 0)}</Td>
                  <Td right>${(p.usage24h?.usd ?? 0).toFixed(2)}</Td>
                  <Td><Toggle checked={p.enabled} onChange={async (v) => { await api(`/providers/${p.id}`, { method: "PUT", body: { ...p, enabled: v }, scope: null }); reload(true); }} /></Td>
                  <Td right><div className="flex justify-end gap-1.5">
                    <Button size="sm" onClick={() => setModels(p)}>Models</Button>
                    <Button size="sm" variant="ghost" onClick={async () => { if (confirm(`Remove ${p.name} and its ${p.models.length} models?`)) { await api(`/providers/${p.id}`, { method: "DELETE", scope: null }); reload(true); } }}>Remove</Button>
                  </div></Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>
      <FreeTiers />
      {adding && <AddProvider kind={adding} onClose={() => setAdding(null)} onDone={() => { setAdding(null); reload(true); }} />}
      {models && <CloudModels p={models} onClose={() => { setModels(null); reload(true); }} />}
    </>
  );
}

function NodeCard({ p, onChange }: { p: Provider; onChange: () => void }) {
  const s = p.info?.system;
  const b = p.info?.budget;
  const loaded = (p.info?.instances ?? []).filter((i) => i.state === "ready");
  const tone = p.status === "online" ? "good" : p.status === "unknown" ? "muted" : "bad";
  return (
    <Card title={<Link to={`/providers/${p.id}`} className="flex items-center gap-2 hover:text-accent" title="Statistics and resources">{p.name}<span className="font-mono text-[11px] font-normal text-ink-3">{p.id}</span></Link>}
      subtitle={p.base_url}
      actions={<><StatusDot tone={tone} label={p.status} pulse={p.status === "online"} />
        <Button size="sm" onClick={async () => { await api(`/providers/${p.id}/sync`, { method: "POST", scope: null }); onChange(); }}>Sync</Button></>}>
      {p.error && p.status !== "online" && <p className="mb-3 text-[12px] text-bad">{p.error}</p>}
      {p.info?.presence && p.status === "online" && <PresenceRow p={p} onChange={onChange} />}
      <div className="grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-4 text-[12px]">
        <div><div className="text-ink-3">Machine</div><div className="font-medium">{s?.chip ?? "—"}</div><div className="text-ink-3 num">{s ? `${s.cores} cores · ${s.memTotalGb.toFixed(0)} GB` : ""}</div></div>
        <div><div className="text-ink-3">Free memory</div><div className="font-medium num">{fmtGb(s?.memFreeGb)}</div><div className={`num ${(s?.swapGb ?? 0) > 20 ? "text-warn" : "text-ink-3"}`}>swap {fmtGb(s?.swapGb)}</div></div>
        <div><div className="text-ink-3">Round trip</div><div className="font-medium num">{p.info?.latencyMs != null ? `${p.info.latencyMs} ms` : "—"}</div><div className="text-ink-3">seen {fmtAgo(p.last_seen)}</div></div>
        <div><div className="text-ink-3">Traffic 24h</div><div className="font-medium num">{fmtInt(p.usage24h?.n ?? 0)} req</div><div className="text-ink-3 num">{fmtCompact(p.usage24h?.tokens ?? 0)} tokens</div></div>
      </div>
      {b && (
        <div className="mt-4">
          <div className="mb-1 flex justify-between text-[11px] text-ink-3 num"><span>Model memory</span><span>{b.usedGb.toFixed(1)} / {b.budgetGb} GB</span></div>
          <Meter value={b.usedGb} max={b.budgetGb} tone={b.usedGb / b.budgetGb > 0.9 ? "bad" : "accent"} />
        </div>
      )}
      <div className="mt-3 flex flex-wrap gap-1.5">
        {loaded.length ? loaded.map((i) => <Badge key={i.id} tone="good">{i.id} · {i.estimateGb} GB{i.inflight ? ` · ${i.inflight} busy` : ""}</Badge>) : <span className="text-[12px] text-ink-3">Nothing loaded</span>}
        <span className="text-[12px] text-ink-3">· {p.models.length} models routable</span>
      </div>
      <p className="mt-3 text-[11.5px] text-ink-3">Manage its models, downloads, benchmarks and memory: pick <b>{p.name}</b> at the top of Models, Advisor, Benchmarks or System.</p>
      <div className="mt-2 flex gap-1.5">
        <Toggle checked={p.enabled} onChange={async (v) => { await api(`/providers/${p.id}`, { method: "PUT", body: { enabled: v }, scope: null }); onChange(); }} label="Route to it" />
        <div className="flex-1" />
        <Button size="sm" variant="ghost" onClick={async () => { if (confirm(`Remove node ${p.name}? Its models leave every route.`)) { await api(`/providers/${p.id}`, { method: "DELETE", scope: null }); onChange(); } }}>Remove</Button>
      </div>
    </Card>
  );
}

function AddProvider({ kind, onClose, onDone }: { kind: "mux" | "cloud"; onClose: () => void; onDone: () => void }) {
  const presets = useApi<Presets>("/providers/presets", undefined, undefined, null);
  const [preset, setPreset] = useState(kind === "mux" ? "mux" : "openai");
  const [f, setF] = useState({ id: kind === "mux" ? "mac-studio" : "openai", name: kind === "mux" ? "Mac Studio" : "OpenAI", base_url: "", api_key: "", admin_token: "" });
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const pr = presets.data?.[preset];
  const save = async () => {
    setBusy(true); setErr("");
    try {
      await api(`/providers/${f.id}`, { method: "PUT", scope: null, body: kind === "mux"
        ? { kind: "mux", name: f.name, base_url: f.base_url, admin_token: f.admin_token }
        : { kind: preset, name: f.name, base_url: f.base_url || pr?.base_url, api_key: f.api_key } });
      onDone();
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };
  return (
    <Modal open onClose={onClose} title={kind === "mux" ? "Add a node" : "Add a cloud API"}
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" disabled={busy || !f.id} onClick={save}>{busy ? "Connecting…" : "Add"}</Button></>}>
      <div className="grid gap-3">
        {kind === "cloud" && (
          <Field label="Provider">
            <Select value={preset} onChange={(e) => { const k = e.target.value; setPreset(k); setF({ ...f, id: k, name: presets.data?.[k]?.name ?? k, base_url: "" }); }}>
              {Object.entries(presets.data ?? {}).map(([k, v]) => <option key={k} value={k}>{v.name}</option>)}
            </Select>
          </Field>
        )}
        <div className="grid grid-cols-2 gap-3">
          <Field label="Id" hint="models are named <id>/<model>"><Input value={f.id} onChange={(e) => setF({ ...f, id: e.target.value.toLowerCase() })} /></Field>
          <Field label="Name"><Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
        </div>
        <Field label="Base URL" hint={kind === "mux" ? "the node's mux, e.g. https://lv426.tail134047.ts.net/mux" : `default ${pr?.base_url ?? ""}`}>
          <Input value={f.base_url} placeholder={kind === "mux" ? "https://…" : pr?.base_url} onChange={(e) => setF({ ...f, base_url: e.target.value })} />
        </Field>
        {kind === "mux"
          ? <Field label="Node admin token" hint="MUX_ADMIN_TOKEN in the node's ~/.mux/mux.env. The gateway becomes a tenant on the node with a key of its own."><Input type="password" value={f.admin_token} onChange={(e) => setF({ ...f, admin_token: e.target.value })} /></Field>
          : <Field label="API key" hint={pr?.keyUrl ? <a className="text-accent" href={pr.keyUrl} target="_blank" rel="noreferrer">get a key</a> : undefined}><Input type="password" value={f.api_key} onChange={(e) => setF({ ...f, api_key: e.target.value })} /></Field>}
        {err && <p className="text-[12px] text-bad">{err}</p>}
      </div>
    </Modal>
  );
}

function CloudModels({ p, onClose }: { p: Provider; onClose: () => void }) {
  const remote = useApi<{ id: string; owned_by?: string; context_length?: number }[]>(`/providers/${p.id}/remote-models`, undefined, undefined, null);
  const [q, setQ] = useState("");
  const [price, setPrice] = useState<Record<string, { in: string; out: string }>>({});
  const [added, setAdded] = useState<string[]>(p.models);
  const add = async (model: string, ctx?: number) => {
    const pr = price[model] ?? { in: "0", out: "0" };
    await api(`/providers/${p.id}/models`, { scope: null, body: { model, cost_in: Number(pr.in) || 0, cost_out: Number(pr.out) || 0, ctx: ctx ?? 128000 } });
    setAdded((xs) => [...xs, `${p.id}/${model}`]);
  };
  const list = (remote.data ?? []).filter((m) => m.id.toLowerCase().includes(q.toLowerCase())).slice(0, 200);
  return (
    <Modal open wide onClose={onClose} title={`${p.name} models`} footer={<Button onClick={onClose}>Done</Button>}>
      <p className="mb-3 text-[12px] text-ink-3">Add the models mux may route to, with their price per million tokens (USD), so spend shows per tenant and USD budgets hold. Added models can then be put in routes.</p>
      <Input placeholder="Filter" value={q} onChange={(e) => setQ(e.target.value)} className="mb-3" />
      <ErrorNote error={remote.error} />
      <div className="max-h-[50vh] overflow-auto">
        <Table>
          <thead><tr><Th>Model</Th><Th right>Context</Th><Th right>$ in / 1M</Th><Th right>$ out / 1M</Th><Th /></tr></thead>
          <tbody>
            {list.map((m) => {
              const isAdded = added.includes(`${p.id}/${m.id}`);
              return (
                <tr key={m.id}>
                  <Td mono>{m.id}</Td>
                  <Td right>{m.context_length ? fmtCompact(m.context_length) : "—"}</Td>
                  <Td right><Input className="w-20 text-right" value={price[m.id]?.in ?? ""} placeholder="0" onChange={(e) => setPrice({ ...price, [m.id]: { in: e.target.value, out: price[m.id]?.out ?? "" } })} /></Td>
                  <Td right><Input className="w-20 text-right" value={price[m.id]?.out ?? ""} placeholder="0" onChange={(e) => setPrice({ ...price, [m.id]: { in: price[m.id]?.in ?? "", out: e.target.value } })} /></Td>
                  <Td right>{isAdded ? <Badge tone="good">added</Badge> : <Button size="sm" onClick={() => void add(m.id, m.context_length)}>Add</Button>}</Td>
                </tr>
              );
            })}
          </tbody>
        </Table>
      </div>
    </Modal>
  );
}

/** A node's presence: free, polite, busy or away, why, and when it takes work (its owner can set it here too). */
function PresenceRow({ p, onChange }: { p: Provider; onChange: () => void }) {
  const pr = p.info!.presence!;
  const tone = pr.state === "free" ? "good" : pr.state === "polite" ? "accent" : pr.state === "busy" ? "warn" : "bad";
  const set = async (mode: string) => { await api(`/providers/${p.id}/proxy/presence`, { method: "PUT", body: { mode }, scope: null }); onChange(); };
  return (
    <div className="mb-3 flex flex-wrap items-center gap-2 rounded-md bg-s2 px-3 py-2 text-[12px]">
      <Badge tone={tone}>{pr.state}</Badge>
      <span className="text-ink-2">{pr.reasons.join(", ")}</span>
      <span className="text-ink-3">· {pr.class}</span>
      <Select className="ml-auto w-44" value={pr.mode} onChange={(e) => void set(e.target.value)} title="When this machine takes work">
        <option value="available">Available</option><option value="away-only">When nobody's there</option><option value="off">Off</option>
      </Select>
    </div>
  );
}

/** Free tiers: what each free model has used of its limits, and whether they rescue traffic when ours is down. */
function FreeTiers() {
  const { data: rows } = useApi<QuotaRow[]>("/quota", undefined, 15_000, null);
  const { data: s, reload } = useApi<Settings & { freeRescue?: boolean; freeRescueTraining?: boolean }>("/settings", undefined, undefined, null);
  const set = async (patch: Record<string, boolean>) => { await api("/settings", { method: "PATCH", body: patch, scope: null }); void reload(true); };
  const lim = (n: number, of?: number) => (of ? `${fmtInt(n)} / ${fmtInt(of)}` : fmtInt(n));
  return (
    <Card className="mt-6" title="Free tiers" subtitle="Free cloud models: never part of a route's normal choice unless named; counted against their limits, and taken out just before one. As a rescue they answer last, when every model of ours failed or is out — inside each tenant's data border."
      actions={<><Toggle checked={!!s?.freeRescue} onChange={(v) => void set({ freeRescue: v })} label="Rescue with free tiers" /><Toggle checked={!!s?.freeRescueTraining} onChange={(v) => void set({ freeRescueTraining: v })} label="Also tiers that train on prompts" /></>} pad={false}>
      {!rows?.length ? <div className="p-4"><Empty>No free-tier models yet. Add a provider on its free plan (Groq, Cerebras, Gemini…) and its models.</Empty></div> : (
        <Table>
          <thead><tr><Th>Model</Th><Th right>This minute</Th><Th right>Today</Th><Th right>Tokens today</Th><Th>Trains on prompts</Th><Th>Now</Th></tr></thead>
          <tbody>{rows.map((r) => (
            <tr key={r.id}><Td mono>{r.id}</Td><Td right>{lim(r.minute, r.limits.rpm)}</Td><Td right>{lim(r.day, r.limits.rpd)}</Td><Td right>{lim(r.tokensToday, r.limits.tpd)}</Td>
              <Td>{r.trainsOnData === false ? "no" : r.trainsOnData ? <span className="text-warn">yes</span> : <span className="text-ink-3">unknown</span>}</Td>
              <Td>{r.blocked ? <span className="text-warn">{r.blocked}</span> : <span className="text-good">available</span>}</Td></tr>
          ))}</tbody>
        </Table>
      )}
    </Card>
  );
}
