import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { api, getPageScope, type CatalogEntry, type Download, type LocalFile, type Model, type SystemInfo } from "../api";
import { Badge, Button, Card, Empty, ErrorNote, Field, Input, Meter, Modal, PageHeader, Segmented, Select, Spinner, StatusDot, Table, Tabs, Td, Textarea, Th, Toggle } from "../components/ui";
import { fmtAgo, fmtBytes, fmtCompact, fmtGb, fmtInt, fmtPct } from "../format";
import { useApi, useLive } from "../hooks";

type Tab = "installed" | "library" | "local" | "hf" | "add";

export default function ModelsPage() {
  const [tab, setTab] = useState<Tab>("installed");
  const models = useApi<Model[]>("/models", undefined, 5000);
  const downloads = useApi<Download[]>("/downloads", undefined, 4000);
  useLive<Download>("download", (d) => downloads.setData((xs) => {
    const list = xs ?? [];
    const i = list.findIndex((x) => x.id === d.id);
    if (d.status === "done") void models.reload(true);
    return i >= 0 ? list.map((x) => (x.id === d.id ? d : x)) : [d, ...list];
  }));
  const active = (downloads.data ?? []).filter((d) => d.status === "running" || d.status === "queued");
  return (
    <>
      <PageHeader title="Models" subtitle="What mux can serve: models on this Mac, models it can fetch, and providers elsewhere." />
      {active.length > 0 && <DownloadsPanel downloads={active} onChange={() => downloads.reload(true)} />}
      <Tabs value={tab} onChange={setTab} tabs={[
        { value: "installed", label: "Installed", count: models.data?.length },
        { value: "library", label: "Library" },
        { value: "local", label: "Files on this Mac" },
        { value: "hf", label: "Hugging Face" },
        { value: "add", label: "External / Jev" },
      ]} />
      {tab === "installed" && <Installed models={models.data} error={models.error} reload={() => models.reload(true)} />}
      {tab === "library" && <Library downloads={downloads.data ?? []} onStarted={() => { void downloads.reload(true); }} />}
      {tab === "local" && <LocalFiles onImported={() => { void models.reload(true); setTab("installed"); }} />}
      {tab === "hf" && <HfSearch onStarted={() => void downloads.reload(true)} />}
      {tab === "add" && <AddExternal onAdded={() => { void models.reload(true); setTab("installed"); }} />}
      {tab === "library" && <RecentDownloads downloads={(downloads.data ?? []).filter((d) => d.status !== "running" && d.status !== "queued")} />}
    </>
  );
}

function DownloadsPanel({ downloads, onChange }: { downloads: Download[]; onChange: () => void }) {
  return (
    <Card title="Downloading" className="mb-4">
      <div className="space-y-3">
        {downloads.map((d) => {
          const pct = d.total_bytes ? d.done_bytes / d.total_bytes : 0;
          const eta = d.bps > 0 ? (d.total_bytes - d.done_bytes) / d.bps : null;
          return (
            <div key={d.id}>
              <div className="mb-1 flex items-center justify-between gap-2 text-[12.5px]">
                <span className="truncate"><b>{d.model_id}</b> <span className="text-ink-3">{d.repo} · {d.quant}</span></span>
                <span className="flex items-center gap-3 text-ink-2 num">
                  {fmtBytes(d.done_bytes)} / {fmtBytes(d.total_bytes)} · {d.bps ? `${fmtBytes(d.bps)}/s` : d.status}{eta != null && ` · ${Math.ceil(eta / 60)} min left`}
                  <Button size="sm" variant="ghost" onClick={async () => { await api(`/downloads/${d.id}`, { method: "DELETE" }); onChange(); }}>Cancel</Button>
                </span>
              </div>
              <Meter value={pct} max={1} />
            </div>
          );
        })}
      </div>
    </Card>
  );
}

function RecentDownloads({ downloads }: { downloads: Download[] }) {
  if (!downloads.length) return null;
  return (
    <Card title="Recent downloads" className="mt-4" pad={false}>
      <Table>
        <thead><tr><Th>Model</Th><Th>Repo</Th><Th right>Size</Th><Th>Status</Th><Th>When</Th></tr></thead>
        <tbody>{downloads.slice(0, 15).map((d) => (
          <tr key={d.id}><Td className="font-medium">{d.model_id}</Td><Td mono className="text-ink-3">{d.repo}</Td><Td right>{fmtBytes(d.total_bytes)}</Td>
            <Td>{d.status === "done" ? <Badge tone="good">done</Badge> : d.status === "error" ? <Badge tone="bad" title={d.error ?? ""}>error</Badge> : <Badge tone="muted">{d.status}</Badge>}{d.error && <div className="mt-0.5 text-[11.5px] text-bad">{d.error}</div>}</Td>
            <Td className="text-ink-3">{fmtAgo(d.finished_at ?? d.started_at)}</Td></tr>
        ))}</tbody>
      </Table>
    </Card>
  );
}

function modelState(m: Model, failures?: SystemInfo["failures"]): { tone: "good" | "accent" | "bad" | "muted" | "warn"; label: string; pulse?: boolean } {
  if (!m.enabled) return { tone: "muted", label: "disabled" };
  if (m.backend === "external" || m.backend === "jev") return { tone: "good", label: "remote" };
  const st = m.instance?.state;
  if (st === "ready") return { tone: "good", label: "loaded" };
  if (st === "loading") return { tone: "accent", label: "loading", pulse: true };
  if (st === "unloading") return { tone: "warn", label: "unloading" };
  if (failures?.[m.id]) return { tone: "bad", label: "failed" };
  if (m.onDisk === false) return { tone: "bad", label: "missing file" };
  return { tone: "muted", label: "unloaded" };
}

function Installed({ models, error, reload }: { models: Model[] | null; error: string | null; reload: () => void }) {
  const { data: sys } = useApi<SystemInfo>("/system", { range: "15m" }, 5000);
  const [kind, setKind] = useState<"all" | Model["kind"]>("all");
  const [edit, setEdit] = useState<Model | null>(null);
  const [log, setLog] = useState<string | null>(null);
  const [del, setDel] = useState<Model | null>(null);
  const [busy, setBusy] = useState<Record<string, string>>({});
  const [err, setErr] = useState<string | null>(null);
  const act = async (m: Model, what: string, fn: () => Promise<unknown>) => {
    setBusy((b) => ({ ...b, [m.id]: what })); setErr(null);
    try { await fn(); } catch (e) { setErr(`${m.id}: ${(e as Error).message}`); } finally { setBusy((b) => { const { [m.id]: _, ...rest } = b; return rest; }); reload(); }
  };
  const list = (models ?? []).filter((m) => kind === "all" || m.kind === kind);
  return (
    <>
      <ErrorNote error={error ?? err} />
      {sys && (
        <div className="mb-4 grid gap-3 md:grid-cols-3">
          <Card><div className="text-[11px] uppercase tracking-wide text-ink-3">Model memory budget</div>
            <div className="mt-1 mb-2 text-lg font-semibold num">{sys.budget.usedGb.toFixed(1)} <span className="text-ink-3 text-sm">/ {sys.budget.budgetGb} GB</span></div>
            <Meter value={sys.budget.usedGb} max={sys.budget.budgetGb} tone={sys.budget.usedGb / sys.budget.budgetGb > 0.85 ? "warn" : "accent"} /></Card>
          <Card><div className="text-[11px] uppercase tracking-wide text-ink-3">Mac memory free</div>
            <div className="mt-1 mb-2 text-lg font-semibold num">{sys.system.memFreeGb.toFixed(1)} <span className="text-ink-3 text-sm">of {sys.system.memTotalGb.toFixed(0)} GB · swap {sys.system.swapGb.toFixed(1)} GB</span></div>
            <Meter value={sys.system.memTotalGb - sys.system.memFreeGb} max={sys.system.memTotalGb} marker={sys.system.memTotalGb - sys.budget.headroomGb} tone={sys.system.pressure > 1 ? "bad" : "accent"} /></Card>
          <Card><div className="text-[11px] uppercase tracking-wide text-ink-3">Disk free for models</div>
            <div className="mt-1 mb-2 text-lg font-semibold num">{sys.system.diskFreeGb.toFixed(0)} <span className="text-ink-3 text-sm">of {sys.system.diskTotalGb.toFixed(0)} GB</span></div>
            <Meter value={sys.system.diskTotalGb - sys.system.diskFreeGb} max={sys.system.diskTotalGb} tone={sys.system.diskFreeGb < 40 ? "warn" : "accent"} /></Card>
        </div>
      )}
      <div className="mb-3"><Segmented value={kind} onChange={setKind} options={[{ value: "all", label: "All" }, { value: "chat", label: "Chat" }, { value: "embedding", label: "Embedding" }, { value: "rerank", label: "Rerank" }, { value: "systemone", label: "System One" }]} /></div>
      {!list.length ? <Empty>No models yet — download one from the Library, or import a GGUF already on this Mac.</Empty> : (
        <div className="grid gap-3 xl:grid-cols-2">
          {list.map((m) => {
            const st = modelState(m, sys?.failures);
            const inst = m.instance;
            const met = inst?.metrics;
            const bench = m.bench;
            const local = m.backend === "llamacpp" || m.backend === "mlx" || m.backend === "laya";
            return (
              <Card key={m.id} title={<Link to={`/models/${getPageScope() ? `${getPageScope()}/` : ""}${m.id}`} className="flex items-center gap-2 hover:text-accent" title="Statistics and resources">{m.display_name}<span className="font-mono text-[11px] font-normal text-ink-3">{m.id}</span></Link>}
                subtitle={`${m.backend} · ${m.kind}${m.size_bytes ? ` · ${fmtBytes(m.size_bytes)}` : ""}${local ? ` · ~${m.estimateGb} GB loaded · ctx ${fmtCompact(m.ctx)}` : m.base_url ? ` · ${m.base_url}` : ""}`}
                actions={<StatusDot tone={st.tone} label={busy[m.id] ?? st.label} pulse={st.pulse || !!busy[m.id]} />}>
                <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-[12px] sm:grid-cols-4">
                  <Metric k="Requests 24h" v={fmtInt(m.usage24h?.n ?? 0)} />
                  <Metric k="Errors 24h" v={fmtInt(m.usage24h?.errors ?? 0)} bad={!!m.usage24h?.errors} />
                  <Metric k="Tokens 24h" v={fmtCompact(m.usage24h?.tokens ?? 0)} />
                  <Metric k="Avg tok/s" v={m.usage24h?.tps ? m.usage24h.tps.toFixed(1) : "—"} />
                  {inst && <>
                    <Metric k="Memory (RSS)" v={inst.rssGb != null ? fmtGb(inst.rssGb) : "—"} />
                    <Metric k="In flight" v={String(inst.inflight)} />
                    <Metric k="Served" v={fmtInt(inst.requests)} />
                    <Metric k="Idle" v={`${inst.idleMin.toFixed(0)} min`} />
                  </>}
                  {met && <>
                    {met.kv_cache_usage_ratio != null && <Metric k="KV cache" v={fmtPct(met.kv_cache_usage_ratio, 0)} />}
                    {met.requests_processing != null && <Metric k="Processing" v={String(met.requests_processing)} />}
                    {met.predicted_tokens_seconds != null && <Metric k="Gen tok/s" v={met.predicted_tokens_seconds.toFixed(1)} />}
                    {met.prompt_tokens_seconds != null && <Metric k="Prompt tok/s" v={fmtCompact(met.prompt_tokens_seconds)} />}
                  </>}
                  {bench && bench.status === "done" && <Metric k="Benchmark" v={`${fmtPct(bench.score ?? 0, 0)} · ${bench.tps} tok/s`} />}
                </div>
                {sys?.failures[m.id] && <div className="mt-2 rounded bg-[var(--critical-soft)] px-2 py-1 text-[11.5px] text-bad">{sys.failures[m.id].error.split("\n")[0]}</div>}
                {m.notes && <p className="mt-2 text-[11.5px] text-ink-3 line-clamp-2">{m.notes}</p>}
                <div className="mt-3 flex flex-wrap items-center gap-1.5">
                  {local && (inst?.state === "ready" || inst?.state === "loading"
                    ? <Button size="sm" onClick={() => act(m, "unloading", () => api(`/models/${m.id}/unload`, { body: {} }))}>Unload</Button>
                    : <Button size="sm" variant="primary" disabled={!m.enabled} onClick={() => act(m, "loading", () => api(`/models/${m.id}/load`, { body: {} }))}>Load</Button>)}
                  <Button size="sm" onClick={() => act(m, "benchmarking", () => api("/benchmarks", { body: { model: m.id } }))}>Benchmark</Button>
                  <Button size="sm" onClick={() => setEdit(m)}>Edit</Button>
                  {local && <Button size="sm" variant="ghost" onClick={async () => setLog((await api<{ log: string }>(`/models/${m.id}/log`)).log || "(empty)")}>Log</Button>}
                  <div className="flex-1" />
                  {local && <Toggle checked={m.pinned} onChange={(v) => act(m, v ? "pinning" : "unpinning", () => api(`/models/${m.id}`, { method: "PATCH", body: { pinned: v } }))} label="Pinned" />}
                  <Toggle checked={m.enabled} onChange={(v) => act(m, v ? "enabling" : "disabling", () => api(`/models/${m.id}`, { method: "PATCH", body: { enabled: v } }))} label="Enabled" />
                  <Button size="sm" variant="ghost" onClick={() => setDel(m)}>Delete</Button>
                </div>
              </Card>
            );
          })}
        </div>
      )}
      {edit && <EditModel model={edit} onClose={() => setEdit(null)} onSaved={() => { setEdit(null); reload(); }} />}
      <Modal open={log !== null} onClose={() => setLog(null)} title="Model server log" wide><pre className="code max-h-[65vh] overflow-auto rounded bg-s2 p-3 text-[11px] text-ink-2">{log}</pre></Modal>
      {del && <DeleteModel model={del} onClose={() => setDel(null)} onDone={() => { setDel(null); reload(); }} />}
    </>
  );
}

const Metric = ({ k, v, bad }: { k: string; v: string; bad?: boolean }) => (
  <div className="min-w-0"><div className="text-[10.5px] uppercase tracking-wide text-ink-3">{k}</div><div className={`num truncate ${bad ? "text-bad" : "text-ink"}`}>{v}</div></div>
);

const CAP_KEYS = ["quality", "speed", "tools", "code", "reasoning", "multilingual", "vision", "context"] as const;

function EditModel({ model, onClose, onSaved }: { model: Model; onClose: () => void; onSaved: () => void }) {
  const [m, setM] = useState<Model>(model);
  const [args, setArgs] = useState(model.extra_args.join(" "));
  const [err, setErr] = useState<string | null>(null);
  const set = <K extends keyof Model>(k: K, v: Model[K]) => setM((x) => ({ ...x, [k]: v }));
  const local = m.backend === "llamacpp" || m.backend === "mlx";
  const save = async () => {
    try {
      await api(`/models/${m.id}`, { method: "PATCH", body: {
        display_name: m.display_name, ctx: m.ctx, parallel: m.parallel, keep_alive_min: m.keep_alive_min, reasoning: m.reasoning, caps: m.caps, notes: m.notes,
        extra_args: args.trim() ? args.trim().split(/\s+/) : [], base_url: m.base_url, upstream_model: m.upstream_model, kind: m.kind,
        ...(m.api_key !== model.api_key ? { api_key: m.api_key } : {}),
      } });
      onSaved();
    } catch (e) { setErr((e as Error).message); }
  };
  return (
    <Modal open onClose={onClose} title={`Edit ${model.id}`} wide footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" onClick={save}>Save</Button></>}>
      <ErrorNote error={err} />
      <p className="mb-3 text-[12px] text-ink-3">Changes to context, slots, reasoning or arguments restart the model server on its next request.</p>
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="Display name" className="sm:col-span-2"><Input value={m.display_name} onChange={(e) => set("display_name", e.target.value)} /></Field>
        <Field label="Kind"><Select value={m.kind} onChange={(e) => set("kind", e.target.value as Model["kind"])}>{["chat", "embedding", "rerank", "systemone", "transcription", "speech"].map((k) => <option key={k}>{k}</option>)}</Select></Field>
        {local && <>
          <Field label="Context (tokens)" hint="KV cache costs memory: ~0.06 GB per 1k"><Input type="number" value={m.ctx} onChange={(e) => set("ctx", Number(e.target.value))} /></Field>
          <Field label="Parallel slots"><Input type="number" min={1} value={m.parallel} onChange={(e) => set("parallel", Number(e.target.value))} /></Field>
          <Field label="Keep alive (min)" hint="Empty: the default; 0: never unload"><Input type="number" min={0} value={m.keep_alive_min ?? ""} onChange={(e) => set("keep_alive_min", e.target.value === "" ? null : Number(e.target.value))} /></Field>
          <Field label="Reasoning"><Segmented value={m.reasoning} onChange={(v) => set("reasoning", v)} options={[{ value: "off", label: "Off" }, { value: "auto", label: "Auto" }, { value: "on", label: "On" }]} /></Field>
          <Field label="Extra llama-server arguments" className="sm:col-span-2" hint="e.g. --pooling cls, --cache-ram 8192, --spec-type draft-mtp"><Input value={args} onChange={(e) => setArgs(e.target.value)} className="font-mono" /></Field>
        </>}
        {!local && <>
          <Field label="Base URL" className="sm:col-span-2"><Input value={m.base_url ?? ""} onChange={(e) => set("base_url", e.target.value)} className="font-mono" /></Field>
          <Field label="Upstream model name"><Input value={m.upstream_model ?? ""} onChange={(e) => set("upstream_model", e.target.value)} className="font-mono" /></Field>
          <Field label="API key" hint="Leave as •••• to keep"><Input type="password" value={m.api_key ?? ""} onChange={(e) => set("api_key", e.target.value)} /></Field>
        </>}
      </div>
      <h4 className="mt-5 mb-2 text-[12px] font-semibold text-ink-2">Capabilities (0–10) — what the auto router weighs</h4>
      <div className="grid gap-x-6 gap-y-2 sm:grid-cols-2">
        {CAP_KEYS.map((k) => (
          <label key={k} className="grid grid-cols-[90px_1fr_32px] items-center gap-2 text-[12px]">
            <span className="capitalize text-ink-2">{k}</span>
            <input type="range" min={0} max={10} step={0.5} value={m.caps[k] ?? 0} onChange={(e) => set("caps", { ...m.caps, [k]: Number(e.target.value) })} className="accent-[var(--accent)]" />
            <span className="num text-right">{m.caps[k] ?? 0}</span>
          </label>
        ))}
      </div>
      <Field label="Notes" className="mt-4"><Textarea rows={2} value={m.notes} onChange={(e) => set("notes", e.target.value)} /></Field>
    </Modal>
  );
}

function DeleteModel({ model, onClose, onDone }: { model: Model; onClose: () => void; onDone: () => void }) {
  const [files, setFiles] = useState(false);
  return (
    <Modal open onClose={onClose} title={`Delete ${model.id}?`} footer={<><Button onClick={onClose}>Cancel</Button><Button variant="danger" onClick={async () => { await api(`/models/${model.id}`, { method: "DELETE", query: { files: files ? "1" : undefined } }); onDone(); }}>Delete</Button></>}>
      <p className="text-[12.5px] text-ink-2">The model is unloaded and removed from every route.</p>
      {model.path && <div className="mt-3"><Toggle checked={files} onChange={setFiles} label="Also delete its files from mux's models folder" /><p className="mt-1 text-[11.5px] text-ink-3">An imported model is a link: only the link goes, never the original file.</p></div>}
    </Modal>
  );
}

function Library({ downloads, onStarted }: { downloads: Download[]; onStarted: () => void }) {
  const { data, error, reload } = useApi<CatalogEntry[]>("/catalog");
  const [kind, setKind] = useState<"all" | CatalogEntry["kind"]>("all");
  const [q, setQ] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [starting, setStarting] = useState<string | null>(null);
  const busy = new Set(downloads.filter((d) => d.status === "running" || d.status === "queued").map((d) => d.catalog_id));
  const list = useMemo(() => (data ?? []).filter((c) => (kind === "all" || c.kind === kind) && (!q || `${c.name} ${c.family} ${c.routes.join(" ")} ${c.notes}`.toLowerCase().includes(q.toLowerCase()))), [data, kind, q]);
  const start = async (c: CatalogEntry) => {
    setStarting(c.id); setErr(null);
    try { await api("/downloads", { body: { catalogId: c.id } }); onStarted(); } catch (e) { setErr((e as Error).message); } finally { setStarting(null); void reload(); }
  };
  return (
    <>
      <ErrorNote error={error ?? err} />
      <div className="mb-3 flex flex-wrap gap-2">
        <Segmented value={kind} onChange={setKind} options={[{ value: "all", label: "All" }, { value: "chat", label: "Chat" }, { value: "embedding", label: "Embedding" }, { value: "rerank", label: "Rerank" }, { value: "systemone", label: "System One" }]} />
        <Input className="w-64" placeholder="Search name, route, notes…" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      <Card pad={false}>
        <Table>
          <thead><tr><Th>Model</Th><Th>Kind</Th><Th>Routes</Th><Th right>Size</Th><Th>Params</Th><Th>Context</Th><Th>License</Th><Th /></tr></thead>
          <tbody>
            {list.map((c) => (
              <tr key={c.id} className="hover:bg-s2 align-top">
                <Td>
                  <div className="font-medium">{c.name} <span className="ml-1 text-[11px] text-ink-3">{c.released}</span></div>
                  <div className="mt-0.5 max-w-[46ch] text-[11.5px] text-ink-3">{c.notes}</div>
                  <div className="mt-0.5 font-mono text-[10.5px] text-ink-3">{c.repo} · {c.file}</div>
                </Td>
                <Td><Badge>{c.kind}</Badge></Td>
                <Td><div className="flex max-w-40 flex-wrap gap-1">{c.routes.map((r) => <Badge key={r} tone="muted">{r}</Badge>)}</div></Td>
                <Td right>{c.sizeGb.toFixed(1)} GB</Td>
                <Td className="whitespace-nowrap">{c.params}{c.activeParams && <div className="text-[11px] text-ink-3">{c.activeParams} active</div>}</Td>
                <Td className="num">{fmtCompact(c.ctx)}</Td>
                <Td className="text-[11.5px]">{c.license}{c.minLlama && <div className="text-[11px] text-ink-3">llama.cpp ≥ {c.minLlama}</div>}</Td>
                <Td right>
                  {c.installed ? <Badge tone="good">installed</Badge>
                    : busy.has(c.id) ? <Badge tone="accent">downloading</Badge>
                    : <Button size="sm" variant="primary" disabled={starting === c.id} onClick={() => start(c)}>{starting === c.id ? <Spinner /> : "Download"}</Button>}
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
      </Card>
    </>
  );
}

function LocalFiles({ onImported }: { onImported: () => void }) {
  const { data, error, loading } = useApi<LocalFile[]>("/local");
  const { data: catalog } = useApi<CatalogEntry[]>("/catalog");
  const [pick, setPick] = useState<LocalFile | null>(null);
  return (
    <>
      <ErrorNote error={error} />
      <p className="mb-3 text-[12.5px] text-ink-3">GGUFs already on disk (Nexus's Hugging Face cache, LM Studio, llama.cpp's cache). Importing links them into mux; nothing is copied or downloaded.</p>
      <Card pad={false}>
        {loading && !data ? <div className="p-4"><Spinner /></div> : !data?.length ? <div className="p-4"><Empty>No GGUF files found in the scanned folders.</Empty></div> : (
          <Table>
            <thead><tr><Th>File</Th><Th>Repo</Th><Th right>Size</Th><Th>Vision</Th><Th>In mux</Th><Th /></tr></thead>
            <tbody>{data.map((f) => (
              <tr key={f.path}><Td className="font-medium">{f.name}<div className="max-w-[60ch] truncate font-mono text-[10.5px] text-ink-3">{f.path}</div></Td>
                <Td mono className="text-ink-3">{f.repo ?? "—"}</Td><Td right>{f.sizeGb.toFixed(2)} GB</Td><Td>{f.mmproj ? <Badge tone="muted">mmproj</Badge> : "—"}</Td>
                <Td>{f.registeredAs ? <Badge tone="good">{f.registeredAs}</Badge> : "—"}</Td>
                <Td right>{!f.registeredAs && <Button size="sm" variant="primary" onClick={() => setPick(f)}>Import</Button>}</Td></tr>
            ))}</tbody>
          </Table>
        )}
      </Card>
      {pick && <ImportModal file={pick} catalog={catalog ?? []} onClose={() => setPick(null)} onDone={() => { setPick(null); onImported(); }} />}
    </>
  );
}

function ImportModal({ file, catalog, onClose, onDone }: { file: LocalFile; catalog: CatalogEntry[]; onClose: () => void; onDone: () => void }) {
  const guess = catalog.find((c) => c.file === file.name || (file.repo && c.repo === file.repo && c.file === file.name));
  const [catalogId, setCatalogId] = useState(guess?.id ?? "");
  const [id, setId] = useState(guess?.id ?? file.name.replace(/\.gguf$/i, "").toLowerCase().replace(/[^a-z0-9.]+/g, "-"));
  const [kind, setKind] = useState<Model["kind"]>(guess?.kind ?? "chat");
  const [mm, setMm] = useState(!!file.mmproj);
  const [err, setErr] = useState<string | null>(null);
  const go = async () => {
    try { await api("/local/import", { body: { path: file.path, id, kind, catalogId: catalogId || undefined, mmproj: mm ? file.mmproj : null } }); onDone(); } catch (e) { setErr((e as Error).message); }
  };
  return (
    <Modal open onClose={onClose} title={`Import ${file.name}`} footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" onClick={go}>Import</Button></>}>
      <ErrorNote error={err} />
      <div className="space-y-3">
        <Field label="Catalog entry" hint="Gives the model its capabilities, default context and notes."><Select value={catalogId} onChange={(e) => { setCatalogId(e.target.value); const c = catalog.find((x) => x.id === e.target.value); if (c) { setId(c.id); setKind(c.kind); } }}>
          <option value="">none</option>{catalog.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </Select></Field>
        <Field label="Model id"><Input value={id} onChange={(e) => setId(e.target.value)} className="font-mono" /></Field>
        <Field label="Kind"><Select value={kind} onChange={(e) => setKind(e.target.value as Model["kind"])}>{["chat", "embedding", "rerank", "systemone", "transcription", "speech"].map((k) => <option key={k}>{k}</option>)}</Select></Field>
        {file.mmproj && <Toggle checked={mm} onChange={setMm} label="Use the vision projector found beside it" />}
      </div>
    </Modal>
  );
}

function HfSearch({ onStarted }: { onStarted: () => void }) {
  const [q, setQ] = useState("");
  const [results, setResults] = useState<{ repo: string; downloads: number; likes: number; updated?: string; arch?: string; ctx?: number; params?: number }[] | null>(null);
  const [repo, setRepo] = useState<string | null>(null);
  const [files, setFiles] = useState<{ path: string; size: number }[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  const search = async () => { setBusy(true); setErr(null); try { setResults(await api("/hf/search", { query: { q } })); } catch (e) { setErr((e as Error).message); } finally { setBusy(false); } };
  const open = async (r: string) => { setRepo(r); setFiles(null); try { setFiles(await api("/hf/files", { query: { repo: r } })); } catch (e) { setErr((e as Error).message); } };
  const get = async (f: string, kind: Model["kind"]) => {
    setErr(null);
    try {
      const id = f.split("/").pop()!.replace(/\.gguf$/i, "").replace(/-\d{5}-of-\d{5}$/, "").toLowerCase().replace(/[^a-z0-9.]+/g, "-");
      await api("/downloads", { body: { repo, file: f, modelId: id, kind } }); setDone(id); onStarted();
    } catch (e) { setErr((e as Error).message); }
  };
  const ggufs = (files ?? []).filter((f) => !/mmproj/i.test(f.path) && !/-0000[2-9]-of-|-000[1-9]\d-of-/.test(f.path));
  return (
    <>
      <ErrorNote error={err} />
      {done && <div className="mb-3 rounded-md bg-accent-soft px-3 py-2 text-[12.5px]">Downloading as <b>{done}</b> — progress shows at the top of this page.</div>}
      <form className="mb-3 flex gap-2" onSubmit={(e) => { e.preventDefault(); void search(); }}>
        <Input className="max-w-md" placeholder="Search GGUF repos, e.g. qwen3.8, gemma-4, clef…" value={q} onChange={(e) => setQ(e.target.value)} />
        <Button variant="primary" type="submit" disabled={!q || busy}>{busy ? <Spinner /> : "Search"}</Button>
      </form>
      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Repositories" pad={false}>
          {!results ? <div className="p-4"><Empty>Search Hugging Face for any GGUF the catalog doesn't have.</Empty></div> : (
            <Table><thead><tr><Th>Repo</Th><Th>Arch</Th><Th right>Params</Th><Th right>Downloads</Th></tr></thead>
              <tbody>{results.map((r) => (
                <tr key={r.repo} onClick={() => open(r.repo)} className={`cursor-pointer hover:bg-s2 ${repo === r.repo ? "bg-s2" : ""}`}>
                  <Td className="font-medium">{r.repo}<div className="text-[11px] text-ink-3">{r.updated?.slice(0, 10)}</div></Td><Td mono className="text-ink-3">{r.arch ?? "—"}</Td>
                  <Td right>{r.params ? `${(r.params / 1e9).toFixed(1)}B` : "—"}</Td><Td right>{fmtCompact(r.downloads)}</Td></tr>
              ))}</tbody></Table>
          )}
        </Card>
        <Card title={repo ?? "Files"} pad={false}>
          {!repo ? <div className="p-4"><Empty>Pick a repository.</Empty></div> : !files ? <div className="p-4"><Spinner /></div> : (
            <Table><thead><tr><Th>File</Th><Th right>Size</Th><Th /></tr></thead>
              <tbody>{ggufs.map((f) => {
                const split = /-00001-of-(\d{5})/.exec(f.path);
                const total = split ? (files ?? []).filter((x) => x.path.startsWith(f.path.replace(/-00001-of-\d{5}\.gguf$/, ""))).reduce((a, x) => a + x.size, 0) : f.size;
                return (
                  <tr key={f.path}><Td mono className="text-[11.5px]">{f.path}{split && <span className="ml-1 text-ink-3">({Number(split[1])} parts)</span>}</Td><Td right>{fmtBytes(total)}</Td>
                    <Td right><span className="inline-flex gap-1"><Button size="sm" onClick={() => get(f.path, "chat")}>Chat</Button><Button size="sm" variant="ghost" onClick={() => get(f.path, "embedding")}>Embed</Button><Button size="sm" variant="ghost" onClick={() => get(f.path, "systemone")}>Sys1</Button></span></Td></tr>
                );
              })}</tbody></Table>
          )}
        </Card>
      </div>
    </>
  );
}

function AddExternal({ onAdded }: { onAdded: () => void }) {
  const [backend, setBackend] = useState<"external" | "jev">("external");
  const [f, setF] = useState({ id: "", display_name: "", base_url: "", api_key: "", upstream_model: "", kind: "chat" as Model["kind"], ctx: 131072 });
  const [err, setErr] = useState<string | null>(null);
  const set = (k: keyof typeof f, v: string | number) => setF((x) => ({ ...x, [k]: v }));
  const add = async () => {
    try {
      await api("/models", { body: { ...f, backend, kind: backend === "jev" ? "systemone" : f.kind, display_name: f.display_name || f.id, api_key: f.api_key || null, upstream_model: f.upstream_model || null, caps: { quality: 7, speed: 7 } } });
      onAdded();
    } catch (e) { setErr((e as Error).message); }
  };
  return (
    <div className="grid gap-4 lg:grid-cols-[1fr_360px]">
      <Card title="Add a provider">
        <ErrorNote error={err} />
        <div className="mb-4"><Segmented value={backend} onChange={setBackend} options={[{ value: "external", label: "OpenAI-compatible endpoint" }, { value: "jev", label: "Jev (System One, hosted)" }]} /></div>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Model id (what tenants name)"><Input value={f.id} onChange={(e) => set("id", e.target.value)} className="font-mono" placeholder={backend === "jev" ? "jev" : "openai-gpt-5"} /></Field>
          <Field label="Display name"><Input value={f.display_name} onChange={(e) => set("display_name", e.target.value)} /></Field>
          <Field label="Base URL" className="sm:col-span-2" hint={backend === "jev" ? "Jev's API base; mux posts to <base>/v1/systemone" : "e.g. http://127.0.0.1:8000/v1 (omlx, LM Studio, Ollama, vLLM) or a hosted API"}><Input value={f.base_url} onChange={(e) => set("base_url", e.target.value)} className="font-mono" /></Field>
          <Field label="API key"><Input type="password" value={f.api_key} onChange={(e) => set("api_key", e.target.value)} /></Field>
          <Field label="Upstream model name"><Input value={f.upstream_model} onChange={(e) => set("upstream_model", e.target.value)} className="font-mono" placeholder="as the provider names it" /></Field>
          {backend === "external" && <>
            <Field label="Kind"><Select value={f.kind} onChange={(e) => set("kind", e.target.value)}>{["chat", "embedding", "rerank", "systemone", "transcription", "speech"].map((k) => <option key={k}>{k}</option>)}</Select></Field>
            <Field label="Context"><Input type="number" value={f.ctx} onChange={(e) => set("ctx", Number(e.target.value))} /></Field>
          </>}
        </div>
        <Button variant="primary" className="mt-4" disabled={!f.id || !f.base_url} onClick={add}>Add provider</Button>
      </Card>
      <Card title="When to use this">
        <ul className="list-disc space-y-2 pl-4 text-[12.5px] text-ink-2">
          <li>A second engine on this Mac (omlx / MLX, LM Studio, Ollama) — mux routes to it and meters it like its own models.</li>
          <li>A hosted fallback (OpenAI, Anthropic via an OpenAI-compatible proxy, LiteLLM) placed last on a route.</li>
          <li>Jev: TypeSafe's hosted System One. Put it after Laya / Clef on the <span className="font-mono">systemone</span> route for a hosted second opinion — not for sovereign tenants.</li>
        </ul>
      </Card>
    </div>
  );
}
