import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { api, type ApiKey, type Model, type RequestRow, type Route, type Tenant } from "../api";
import { OverviewPanel, RANGE_OPTIONS } from "../components/OverviewPanel";
import { RequestDrawer } from "../components/RequestDrawer";
import { RequestTable } from "../components/RequestTable";
import { Badge, Button, Card, CopyButton, Empty, ErrorNote, Field, Input, Meter, Modal, PageHeader, Segmented, Select, Table, Tabs, Td, Th, Toggle } from "../components/ui";
import { fmtAgo, fmtCompact, fmtTime } from "../format";
import { useApi } from "../hooks";

type Detail = Tenant & { keys: ApiKey[] };

export default function TenantDetailPage() {
  const { id = "" } = useParams();
  const { data, error, reload } = useApi<Detail>(`/tenants/${id}`);
  const [tab, setTab] = useState<"usage" | "settings" | "keys" | "integrate" | "requests">("usage");
  const [range, setRange] = useState("24h");
  if (error) return <ErrorNote error={error} />;
  if (!data) return null;
  return (
    <>
      <PageHeader
        title={data.name}
        subtitle={<span className="flex items-center gap-2"><span className="h-2.5 w-2.5 rounded-full" style={{ background: data.color }} /><span className="font-mono">{data.id}</span>{data.description && <span>· {data.description}</span>}</span>}
        actions={<><Badge tone={data.status === "active" ? "good" : "warn"}>{data.status}</Badge><Link to="/tenants"><Button variant="ghost">All tenants</Button></Link></>}
      />
      <Tabs value={tab} onChange={setTab} tabs={[
        { value: "usage", label: "Usage" }, { value: "settings", label: "Settings & limits" }, { value: "keys", label: "API keys", count: data.keys.filter((k) => !k.revoked_at).length },
        { value: "integrate", label: "Integrate" }, { value: "requests", label: "Requests" },
      ]} />
      {tab === "usage" && <>
        <div className="mb-4"><Segmented value={range} onChange={setRange} options={RANGE_OPTIONS} /></div>
        <OverviewPanel range={range} tenant={data.id} showTenants={false} />
      </>}
      {tab === "settings" && <Settings tenant={data} onSaved={reload} />}
      {tab === "keys" && <Keys tenant={data} onChange={reload} />}
      {tab === "integrate" && <Integrate tenant={data} />}
      {tab === "requests" && <Recent tenant={data.id} />}
    </>
  );
}

function Settings({ tenant, onSaved }: { tenant: Detail; onSaved: () => void }) {
  const nav = useNavigate();
  const { data: routes } = useApi<Route[]>("/routes");
  const { data: models } = useApi<Model[]>("/models");
  const { data: list } = useApi<Tenant[]>("/tenants");
  const month = list?.find((t) => t.id === tenant.id)?.monthTokens ?? 0;
  const [t, setT] = useState<Tenant>(tenant);
  const [aliases, setAliases] = useState<[string, string][]>(Object.entries(tenant.aliases));
  const [err, setErr] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  useEffect(() => { setT(tenant); setAliases(Object.entries(tenant.aliases)); }, [tenant]);
  const set = <K extends keyof Tenant>(k: K, v: Tenant[K]) => setT((x) => ({ ...x, [k]: v }));
  const chatRoutes = (routes ?? []).filter((r) => r.kind === "chat");
  const names = [...(routes ?? []).map((r) => r.name), ...(models ?? []).map((m) => m.id)];
  const save = async () => {
    setErr(null);
    try {
      const { keys: _k, usage24h: _u, monthTokens: _m, ...body } = t as Detail;
      await api(`/tenants/${tenant.id}`, { method: "PUT", body: { ...body, aliases: Object.fromEntries(aliases.filter(([a, b]) => a && b)) } });
      setSaved(true); setTimeout(() => setSaved(false), 1500); onSaved();
    } catch (e) { setErr((e as Error).message); }
  };
  const remove = async () => {
    if (!confirm(`Delete ${tenant.name}, its keys and access? Its request history stays.`)) return;
    await api(`/tenants/${tenant.id}`, { method: "DELETE" });
    nav("/tenants");
  };
  const num = (k: "rpm_limit" | "tpm_limit" | "monthly_token_budget" | "max_parallel") => (
    <Input type="number" min={0} value={t[k] || ""} placeholder="0 = no limit" onChange={(e) => set(k, Number(e.target.value) || 0)} className="num" />
  );
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card title="Identity">
        <ErrorNote error={err} />
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Name"><Input value={t.name} onChange={(e) => set("name", e.target.value)} /></Field>
          <Field label="Color"><div className="flex gap-2"><input type="color" value={t.color} onChange={(e) => set("color", e.target.value)} className="h-8 w-10 rounded border border-line-strong bg-s2" /><Input value={t.color} onChange={(e) => set("color", e.target.value)} className="font-mono" /></div></Field>
          <Field label="Description" className="sm:col-span-2"><Input value={t.description} onChange={(e) => set("description", e.target.value)} placeholder="What this SaaS does" /></Field>
          <Field label="Status"><Segmented value={t.status} onChange={(v) => set("status", v)} options={[{ value: "active", label: "Active" }, { value: "paused", label: "Paused" }]} /></Field>
          <Field label="Body logging" hint="Keep request and response bodies (truncated) for every call, not only failures."><Toggle checked={t.log_bodies} onChange={(v) => set("log_bodies", v)} label={t.log_bodies ? "On" : "Off"} /></Field>
        </div>
      </Card>
      <Card title="Limits & budget" subtitle="0 means no limit. A breach answers 429 with retry-after.">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Requests per minute">{num("rpm_limit")}</Field>
          <Field label="Tokens per minute">{num("tpm_limit")}</Field>
          <Field label="Max requests in flight">{num("max_parallel")}</Field>
          <Field label="Monthly token budget">{num("monthly_token_budget")}</Field>
        </div>
        <div className="mt-4">
          <div className="mb-1 flex justify-between text-[12px] text-ink-2 num"><span>This month</span><span>{fmtCompact(month)}{t.monthly_token_budget ? ` of ${fmtCompact(t.monthly_token_budget)}` : " (no cap)"}</span></div>
          <Meter value={month} max={t.monthly_token_budget || Math.max(month, 1)} tone={t.monthly_token_budget && month / t.monthly_token_budget > 0.9 ? "bad" : "accent"} />
        </div>
      </Card>
      <Card title="Routing" subtitle="What a request naming no mux route or model goes to — so a SaaS written for gpt-4o or Claude works unchanged.">
        <div className="space-y-3">
          <Field label="Default route"><Select value={t.default_route} onChange={(e) => set("default_route", e.target.value)}>{chatRoutes.map((r) => <option key={r.name} value={r.name}>{r.name} — {r.strategy}</option>)}</Select></Field>
          <Field label="Allowed routes and models" hint="Empty: everything. Otherwise this key may use only these.">
            <div className="flex flex-wrap gap-1.5 rounded-md border border-line-strong bg-s2 p-2">
              {names.map((n) => {
                const on = t.allowed.includes(n);
                return <button key={n} type="button" onClick={() => set("allowed", on ? t.allowed.filter((x) => x !== n) : [...t.allowed, n])} className={`rounded border px-1.5 py-px text-[11.5px] font-mono ${on ? "border-accent bg-accent-soft text-ink" : "border-line text-ink-3 hover:text-ink"}`}>{n}</button>;
              })}
            </div>
          </Field>
        </div>
      </Card>
      <Card title="Model aliases" subtitle="Map the names this SaaS sends to mux routes or models.">
        <div className="space-y-2">
          {aliases.map(([a, b], i) => (
            <div key={i} className="grid grid-cols-[1fr_auto_1fr_auto] items-center gap-2">
              <Input value={a} onChange={(e) => setAliases(aliases.map((x, j) => (j === i ? [e.target.value, x[1]] : x)))} placeholder="claude-sonnet-4-5" className="font-mono" />
              <span className="text-ink-3">→</span>
              <Select value={b} onChange={(e) => setAliases(aliases.map((x, j) => (j === i ? [x[0], e.target.value] : x)))}>
                <option value="">choose…</option>{names.map((n) => <option key={n} value={n}>{n}</option>)}
              </Select>
              <Button size="sm" variant="ghost" onClick={() => setAliases(aliases.filter((_, j) => j !== i))}>Remove</Button>
            </div>
          ))}
          <Button size="sm" onClick={() => setAliases([...aliases, ["", ""]])}>Add alias</Button>
        </div>
      </Card>
      <div className="flex items-center gap-2 lg:col-span-2">
        <Button variant="primary" onClick={save}>{saved ? "Saved" : "Save changes"}</Button>
        <div className="flex-1" />
        <Button variant="danger" onClick={remove}>Delete tenant</Button>
      </div>
    </div>
  );
}

function Keys({ tenant, onChange }: { tenant: Detail; onChange: () => void }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("production");
  const [days, setDays] = useState(0);
  const [rpm, setRpm] = useState(0);
  const [budget, setBudget] = useState(0);
  const [value, setValue] = useState("");
  const [made, setMade] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const create = async () => {
    try {
      const r = await api<{ key: string }>(`/tenants/${tenant.id}/keys`, { body: { name, expiresInDays: days || undefined, rpmLimit: rpm || undefined, monthlyTokenBudget: budget || undefined, value: value || undefined } });
      setMade(r.key); setOpen(false); onChange();
    } catch (e) { setErr((e as Error).message); }
  };
  const revoke = async (k: ApiKey) => { if (confirm(`Revoke ${k.name} (${k.prefix})? Calls with it will be refused at once.`)) { await api(`/keys/${k.id}`, { method: "DELETE" }); onChange(); } };
  return (
    <Card title="API keys" subtitle="Keys are stored hashed; the full key is shown once, when it is made." actions={<Button variant="primary" size="sm" onClick={() => setOpen(true)}>New key</Button>} pad={false}>
      {made && (
        <div className="m-4 rounded-md border border-accent bg-accent-soft p-3">
          <div className="mb-1 text-[12px] font-medium">Copy this key now — mux will not show it again.</div>
          <div className="flex items-center gap-2"><code className="flex-1 break-all rounded bg-s1 px-2 py-1.5 font-mono text-[12px]">{made}</code><CopyButton text={made} /><Button size="sm" variant="ghost" onClick={() => setMade(null)}>Done</Button></div>
        </div>
      )}
      {!tenant.keys.length ? <div className="p-4"><Empty>No keys yet.</Empty></div> : (
        <Table>
          <thead><tr><Th>Name</Th><Th>Key</Th><Th>Created</Th><Th>Last used</Th><Th>Expires</Th><Th>Limits</Th><Th>Status</Th><Th /></tr></thead>
          <tbody>
            {tenant.keys.map((k) => (
              <tr key={k.id} className={k.revoked_at ? "opacity-50" : ""}>
                <Td className="font-medium">{k.name}</Td>
                <Td mono>{k.prefix}</Td>
                <Td className="text-ink-2">{fmtTime(k.created_at, true)}</Td>
                <Td className="text-ink-2">{fmtAgo(k.last_used_at)}</Td>
                <Td className="text-ink-2">{k.expires_at ? fmtTime(k.expires_at, true) : "never"}</Td>
                <Td className="text-[11.5px] text-ink-3 num">{[k.rpm_limit && `${k.rpm_limit} rpm`, k.monthly_token_budget && `${fmtCompact(k.monthly_token_budget)} tok/mo`].filter(Boolean).join(" · ") || "tenant's"}</Td>
                <Td>{k.revoked_at ? <Badge tone="bad">revoked</Badge> : k.expires_at && k.expires_at < Date.now() ? <Badge tone="warn">expired</Badge> : <Badge tone="good">active</Badge>}</Td>
                <Td right>{!k.revoked_at && <Button size="sm" variant="danger" onClick={() => revoke(k)}>Revoke</Button>}</Td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
      <Modal open={open} onClose={() => setOpen(false)} title={`New key for ${tenant.name}`} footer={<><Button onClick={() => setOpen(false)}>Cancel</Button><Button variant="primary" onClick={create}>Create key</Button></>}>
        <ErrorNote error={err} />
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Name" className="sm:col-span-2"><Input value={name} onChange={(e) => setName(e.target.value)} /></Field>
          <Field label="Expires in (days)" hint="0 = never"><Input type="number" min={0} value={days || ""} onChange={(e) => setDays(Number(e.target.value))} /></Field>
          <Field label="Requests per minute" hint="0 = the tenant's limit"><Input type="number" min={0} value={rpm || ""} onChange={(e) => setRpm(Number(e.target.value))} /></Field>
          <Field label="Monthly token budget" hint="0 = the tenant's budget"><Input type="number" min={0} value={budget || ""} onChange={(e) => setBudget(Number(e.target.value))} /></Field>
          <Field label="Import an existing key" hint="Optional: keep a key the SaaS already has (e.g. from a previous gateway)."><Input value={value} onChange={(e) => setValue(e.target.value)} className="font-mono" placeholder="leave empty to generate" /></Field>
        </div>
      </Modal>
    </Card>
  );
}

function Integrate({ tenant }: { tenant: Detail }) {
  const host = window.location.hostname;
  const base = `http://${host}:7070`;
  const route = tenant.default_route || "auto";
  const snippets: [string, string][] = [
    ["OpenAI SDK (Python)", `from openai import OpenAI\n\nclient = OpenAI(base_url="${base}/v1", api_key="mux-sk-…")\nr = client.chat.completions.create(\n    model="${route}",  # a mux route or model; any other name goes to ${tenant.id}'s default\n    messages=[{"role": "user", "content": "Hej!"}],\n    extra_headers={"x-mux-agent": "support-bot", "x-mux-trace-id": "conv-123"},\n)\nprint(r.choices[0].message.content)`],
    ["OpenAI SDK (TypeScript)", `import OpenAI from "openai";\n\nconst client = new OpenAI({ baseURL: "${base}/v1", apiKey: process.env.MUX_API_KEY });\nconst r = await client.chat.completions.create({\n  model: "${route}",\n  messages: [{ role: "user", content: "Hej!" }],\n}, { headers: { "x-mux-agent": "support-bot", "x-mux-trace-id": "conv-123" } });`],
    ["Anthropic SDK (Python)", `import anthropic\n\nclient = anthropic.Anthropic(base_url="${base}", api_key="mux-sk-…")\nmsg = client.messages.create(\n    model="claude-sonnet-4-5",  # alias it on Settings, or mux uses ${route}\n    max_tokens=1024,\n    messages=[{"role": "user", "content": "Hej!"}],\n)\nprint(msg.content[0].text)`],
    ["curl", `curl ${base}/v1/chat/completions \\\n  -H "Authorization: Bearer $MUX_API_KEY" \\\n  -H "Content-Type: application/json" \\\n  -H "x-mux-agent: support-bot" -H "x-mux-trace-id: conv-123" \\\n  -d '{"model":"${route}","messages":[{"role":"user","content":"Hej!"}]}'`],
    ["Embeddings & System One", `# Embeddings (route "embed")\ncurl ${base}/v1/embeddings -H "Authorization: Bearer $MUX_API_KEY" \\\n  -H "Content-Type: application/json" -d '{"model":"embed","input":["hej verden"]}'\n\n# System One — Jev's shape, fast closed decisions\ncurl ${base}/v1/systemone -H "Authorization: Bearer $MUX_API_KEY" -H "Content-Type: application/json" \\\n  -d '{"state":"Customer: cancel my plan now","questions":{"intent":{"type":"choice","instructions":"What do they want?","criteria":{"cancel":"cancel","upgrade":"upgrade"}}}}'`],
  ];
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      {snippets.map(([title, code]) => (
        <Card key={title} title={title} actions={<CopyButton text={code} />}><pre className="code rounded-md bg-s2 p-3 text-ink-2">{code}</pre></Card>
      ))}
      <Card title="Headers mux reads">
        <Table><tbody>
          {[
            ["Authorization: Bearer / x-api-key", "the tenant's key"],
            ["x-mux-trace-id", "groups calls into one agent run (Traces, Lens)"],
            ["x-mux-agent", "which agent made the call (breakdowns, Lens filters)"],
            ["x-mux-tags", "comma-separated tags kept with the request"],
            ["x-mux-user", "the end user (OpenAI's user field and Anthropic's metadata.user_id work too)"],
            ["x-mux-no-fallback: 1", "fail instead of trying the route's next model"],
          ].map(([h, d]) => <tr key={h}><Td mono className="whitespace-nowrap">{h}</Td><Td className="text-ink-2">{d}</Td></tr>)}
        </tbody></Table>
        <p className="mt-3 text-[12px] text-ink-3">Every response carries x-mux-request-id, x-mux-model, x-mux-route, x-mux-fallbacks and x-mux-cold-start.</p>
      </Card>
    </div>
  );
}

function Recent({ tenant }: { tenant: string }) {
  const { data } = useApi<RequestRow[]>("/requests", { tenant, limit: 100 }, 10_000);
  const [open, setOpen] = useState<string | null>(null);
  return (
    <Card pad={false}>
      {!data?.length ? <div className="p-4"><Empty>No requests yet.</Empty></div> : <RequestTable rows={data} onOpen={setOpen} showTenant={false} />}
      <RequestDrawer id={open} onClose={() => setOpen(null)} />
    </Card>
  );
}
