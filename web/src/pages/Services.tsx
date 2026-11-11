import { useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api";
import { BarList, SERIES, TimeChart } from "../components/charts";
import { Badge, Button, Card, Empty, ErrorNote, Input, PageHeader, Segmented, StatusDot, Table, Td, Th } from "../components/ui";
import { fmtAgo, fmtBytes, fmtInt, fmtMs, fmtPct, fmtTime } from "../format";
import { useApi } from "../hooks";

/**
 * mux's shared services — not models, but what every product calls through mux with its key: web search (SearXNG
 * beside mux) and the page reader (server/src/services.ts). Their health, their traffic, who uses them, which search
 * engines answer and which fail, and a box to try them.
 */
type Count = { name: string; n: number };
interface Service {
  id: string; name: string; engine: string; model: string; endpoint: string; about: string; configured: boolean;
  health: {
    up: boolean | null; latencyMs: number | null; checked: number | null; error: string | null; version: string | null; uptime24h: number | null;
    engines: { name: string; categories: string[]; enabled: boolean }[]; errors: Record<string, { message: string; percentage: number }[]>; checks: { t: number; ok: boolean; ms: number | null }[];
  } | null;
  stats: {
    calls: number; errors: number; errorRate: number; p50: number | null; p95: number | null; avgResults: number | null; empty: number; avgChars: number | null;
    bytes: number; avgBytes: number | null; kinds: Count[];
    series: { t: number; calls: number; errors: number; p50: number | null }[]; tenants: { id: string; name: string; calls: number; errors: number }[];
    engines: { name: string; answered: number; failed: number; avgS: number | null; reasons: { reason: string; n: number }[] }[]; hosts: Count[]; errorKinds: Count[];
    recent: { id: string; ts: number; tenant: string; status: number; latencyMs: number; error: string | null; results: number | null; engines: string[]; missing: string[]; host: string | null; chars: number | null; bytes: number | null; mime: string | null }[];
  };
}

const BUCKET: Record<string, number> = { "1h": 60_000, "24h": 900_000, "7d": 7_200_000, "30d": 43_200_000 };

export default function ServicesPage() {
  const [range, setRange] = useState("24h");
  const { data, error } = useApi<{ services: Service[] }>("/services", { range }, 15_000, null);
  if (error) return <ErrorNote error={error} />;
  return (
    <>
      <PageHeader title="Services" subtitle="Shared services every product calls through mux with its key — not models, but metered and limited the same way."
        actions={<Segmented value={range} onChange={setRange} options={["1h", "24h", "7d", "30d"].map((v) => ({ value: v, label: v }))} />} />
      {data?.services.map((s) => <ServiceView key={s.id} s={s} bucket={BUCKET[range]} />)}
    </>
  );
}

function Kpi({ label, value, sub, tone }: { label: string; value: React.ReactNode; sub?: React.ReactNode; tone?: "bad" | "warn" }) {
  return (
    <div className="min-w-[110px]">
      <div className="text-[11px] uppercase tracking-wide text-ink-3">{label}</div>
      <div className={`mt-0.5 text-lg font-semibold num ${tone === "bad" ? "text-bad" : tone === "warn" ? "text-warn" : ""}`}>{value}</div>
      {sub && <div className="text-[11.5px] text-ink-3 num">{sub}</div>}
    </div>
  );
}

function ServiceView({ s, bucket }: { s: Service; bucket: number }) {
  const h = s.health, st = s.stats;
  const search = s.id === "web.search";
  const status = !s.configured ? { tone: "muted" as const, label: "not set up here" } : !h ? { tone: "good" as const, label: "built in" } : h.up == null ? { tone: "muted" as const, label: "checking" } : h.up ? { tone: "good" as const, label: "up" } : { tone: "bad" as const, label: "down" };
  return (
    <section className="mb-8">
      <Card className="mb-4">
        <div className="flex flex-wrap items-start gap-x-8 gap-y-4">
          <div className="min-w-[260px] flex-1">
            <div className="flex items-center gap-2">
              <span className="text-[16px] font-semibold">{s.name}</span>
              <Badge tone="muted">{s.engine}{h?.version ? ` ${h.version.split("+")[0]}` : ""}</Badge>
              <StatusDot tone={status.tone} label={status.label} pulse={status.label === "checking"} />
            </div>
            <p className="mt-1 max-w-xl text-[12.5px] text-ink-2">{s.about}</p>
            <div className="mt-1.5 font-mono text-[11.5px] text-ink-3">{s.endpoint} · metered as model <span className="text-ink-2">{s.model}</span>, route <Link className="text-accent hover:underline" to={`/requests?model=${s.model}`}>{s.id}</Link></div>
            {h?.error && <div className="mt-1 text-[12px] text-bad">SearXNG: {h.error}</div>}
          </div>
          <Kpi label="Calls" value={fmtInt(st.calls)} sub={`${st.errors} failed`} />
          <Kpi label="Error rate" value={fmtPct(st.errorRate)} tone={st.errorRate > 0.1 ? "bad" : st.errorRate > 0.02 ? "warn" : undefined} />
          <Kpi label="Latency p50 · p95" value={fmtMs(st.p50)} sub={`p95 ${fmtMs(st.p95)}`} />
          {search ? <Kpi label="Results per search" value={st.avgResults == null ? "—" : st.avgResults.toFixed(1)} sub={`${st.empty} came back empty`} tone={st.empty > 0 ? "warn" : undefined} />
            : <Kpi label="Text per page" value={st.avgChars == null ? "—" : `${fmtInt(st.avgChars)} chars`} sub={st.avgChars == null ? undefined : `≈ ${fmtInt(st.avgChars / 4)} tokens`} />}
          {!search && <Kpi label="Bytes read" value={fmtBytes(st.bytes)} sub={st.avgBytes == null ? undefined : `${fmtBytes(st.avgBytes)} per call`} />}
          {h && <Kpi label="Uptime · 24 h" value={h.uptime24h == null ? "—" : fmtPct(h.uptime24h)} sub={h.latencyMs != null ? `health check ${fmtMs(h.latencyMs)} · ${fmtAgo(h.checked)}` : undefined} tone={h.uptime24h != null && h.uptime24h < 0.99 ? "warn" : undefined} />}
        </div>
        {h && h.checks.length > 0 && (
          <div className="mt-4">
            <div className="mb-1 flex justify-between text-[10.5px] uppercase tracking-wide text-ink-3"><span>Health checks, every minute · last 24 h</span><span className="normal-case tracking-normal">{h.checks.filter((c) => !c.ok).length} failed</span></div>
            <div className="flex h-5 gap-px overflow-hidden rounded">
              {h.checks.slice(-288).map((c) => <div key={c.t} title={`${fmtTime(c.t, true)} · ${c.ok ? `up, ${c.ms} ms` : "down"}`} className="flex-1" style={{ background: c.ok ? "var(--good)" : "var(--critical)", opacity: c.ok ? 0.35 + Math.min(0.65, (c.ms ?? 0) / 1500) : 1 }} />)}
            </div>
          </div>
        )}
      </Card>

      <div className="mb-4 grid gap-4 lg:grid-cols-2">
        <Card title="Calls" subtitle="per bucket — failed in red">
          <TimeChart data={st.series.map((p) => ({ t: p.t, ok: p.calls - p.errors, errors: p.errors }))} bucketMs={bucket} kind="bar" stacked series={[
            { key: "ok", label: "Answered", color: SERIES[0] }, { key: "errors", label: "Failed", color: "var(--critical)" },
          ]} />
        </Card>
        <Card title="Latency" subtitle="median per bucket, answered calls">
          <TimeChart data={st.series.map((p) => ({ t: p.t, p50: p.p50 }))} bucketMs={bucket} yFormat={(v) => fmtMs(v)} series={[{ key: "p50", label: "p50", color: SERIES[2], format: (v) => fmtMs(v) }]} />
        </Card>
      </div>

      <div className="mb-4 grid gap-4 lg:grid-cols-3">
        <Card title="Who calls it" subtitle="tenants, by calls">
          {st.tenants.length ? <BarList items={st.tenants.map((t) => ({ label: <Link className="hover:underline" to={`/tenants/${t.id}`}>{t.name}</Link>, value: t.calls, sub: t.errors ? <span className="text-bad">{t.errors} failed</span> : undefined }))} /> : <Empty>No calls in this range.</Empty>}
        </Card>
        {search ? <Engines h={h} st={st} /> : (
          <Card title="Sites read" subtitle="by calls">
            {st.hosts.length ? <BarList items={st.hosts.map((x) => ({ label: x.name, value: x.n }))} /> : <Empty>No pages read in this range.</Empty>}
            {st.kinds.length > 0 && <div className="mt-3 border-t border-line pt-2 text-[11.5px] text-ink-3">What was read: {st.kinds.map((k) => `${k.name} ${k.n}`).join(" · ")}</div>}
          </Card>
        )}
        <Card title="What failed" subtitle="errors, grouped">
          {st.errorKinds.length ? <BarList items={st.errorKinds.map((x) => ({ label: <span className="text-[12px]">{x.name}</span>, value: x.n, color: "var(--critical)" }))} /> : <Empty>Nothing failed in this range.</Empty>}
        </Card>
      </div>

      <div className="grid gap-4 lg:grid-cols-[1fr_420px]">
        <Card title="Recent calls" pad={false}>
          <Table>
            <thead><tr><Th>When</Th><Th>Tenant</Th><Th>Status</Th><Th right>Latency</Th><Th>{search ? "Results · engines" : "Site · text"}</Th></tr></thead>
            <tbody>
              {st.recent.map((r) => (
                <tr key={r.id}>
                  <Td className="text-ink-3 num" title={fmtTime(r.ts, true)}><Link className="hover:underline" to={`/requests?open=${r.id}`}>{fmtAgo(r.ts)}</Link></Td>
                  <Td>{r.tenant}</Td>
                  <Td>{r.status < 400 ? <Badge tone="good">{r.status}</Badge> : <Badge tone="bad" title={r.error ?? undefined}>{r.status}</Badge>}</Td>
                  <Td right>{fmtMs(r.latencyMs)}</Td>
                  <Td className="text-[12px] text-ink-2">{r.status >= 400 ? <span className="text-bad">{r.error}</span> : search ? <>{r.results ?? "—"} results{r.engines.length ? ` · ${r.engines.join(", ")}` : ""}{r.missing.length ? <span className="text-warn"> · no answer: {r.missing.join(", ")}</span> : null}</> : <>{r.host ?? "—"}{r.mime ? ` · ${r.mime}` : ""}{r.bytes != null ? ` · ${fmtBytes(r.bytes)}` : ""}{r.chars != null ? ` · ${fmtInt(r.chars)} chars` : ""}</>}</Td>
                </tr>
              ))}
              {!st.recent.length && <tr><Td className="text-ink-3">No calls in this range.</Td></tr>}
            </tbody>
          </Table>
        </Card>
        <TryIt s={s} />
      </div>
    </section>
  );
}

function Engines({ h, st }: { h: Service["health"]; st: Service["stats"] }) {
  const enabled = (h?.engines ?? []).filter((e) => e.enabled);
  const seen = new Set(st.engines.map((e) => e.name));
  // Engines SearXNG reports errors for that no search in this range asked
  const quiet = Object.keys(h?.errors ?? {}).filter((n) => !seen.has(n));
  return (
    <Card title="Search engines" subtitle={`${enabled.length || "—"} switched on in SearXNG · per engine: how often it answered, how fast, and why it failed`}>
      {!st.engines.length && !quiet.length && <Empty>No search in this range yet.</Empty>}
      <div className="space-y-2">
        {st.engines.map((e) => {
          const total = e.answered + e.failed;
          const failing = h?.errors[e.name];
          return (
            <div key={e.name} className="text-[12.5px]">
              <div className="flex items-center gap-2">
                <span className="font-medium">{e.name}</span>
                {e.avgS != null && <span className="text-[11.5px] text-ink-3 num">{e.avgS.toFixed(2)} s</span>}
                <span className="ml-auto text-ink-3 num">{e.answered}/{total} answered</span>
              </div>
              <div className="mt-0.5 flex h-1.5 overflow-hidden rounded-full bg-line">
                <div style={{ width: `${(100 * e.answered) / total}%`, background: "var(--good)" }} />
                <div style={{ width: `${(100 * e.failed) / total}%`, background: "var(--critical)" }} />
              </div>
              {e.reasons.length > 0 && <div className="mt-0.5 text-[11.5px] text-bad">{e.reasons.map((r) => `${r.reason} ×${r.n}`).join(" · ")}</div>}
              {!e.reasons.length && failing && <div className="mt-0.5 text-[11.5px] text-warn">SearXNG logs errors: {failing[0].message}</div>}
            </div>
          );
        })}
        {quiet.map((n) => <div key={n} className="text-[12px]"><span className="font-medium">{n}</span> <span className="text-bad">— SearXNG: {h!.errors[n].map((x) => `${x.message} (${x.percentage}%)`).join(" · ")}</span></div>)}
      </div>
      {enabled.length > 0 && <details className="mt-3 text-[11.5px] text-ink-3"><summary className="cursor-pointer">All {enabled.length} engines switched on</summary><div className="mt-1 leading-relaxed">{enabled.map((e) => e.name).join(" · ")}</div></details>}
    </Card>
  );
}

function TryIt({ s }: { s: Service }) {
  const search = s.id === "web.search";
  const [q, setQ] = useState(search ? "mux model router" : "https://docs.searxng.org/");
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState<{ ms: number; out: { results?: { title: string; url: string; snippet: string; engine: string | null }[]; title?: string; text?: string } } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const go = async () => {
    setBusy(true); setErr(null); setRes(null);
    try { setRes(await api(`/services/${s.id}/test`, { method: "POST", body: search ? { query: q, limit: 8 } : { url: q, max_chars: 4000 }, scope: null })); } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };
  return (
    <Card title="Try it" subtitle="your own call from here — not counted for a tenant">
      <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); void go(); }}>
        <Input className="flex-1" value={q} onChange={(e) => setQ(e.target.value)} placeholder={search ? "search the web" : "https://…"} />
        <Button variant="primary" disabled={busy || !s.configured}>{busy ? "…" : search ? "Search" : "Read"}</Button>
      </form>
      <ErrorNote error={err} />
      {res && (
        <div className="mt-3 max-h-[420px] space-y-2 overflow-y-auto text-[12.5px]">
          <div className="text-[11.5px] text-ink-3">{fmtMs(res.ms)}{res.out.results ? ` · ${res.out.results.length} results` : res.out.text ? ` · ${fmtInt(res.out.text.length)} chars` : ""}</div>
          {res.out.results?.map((r) => (
            <div key={r.url}>
              <a href={r.url} target="_blank" rel="noreferrer" className="font-medium text-accent hover:underline">{r.title}</a>
              <div className="truncate text-[11px] text-ink-3">{r.url}{r.engine ? ` · ${r.engine}` : ""}</div>
              <div className="text-ink-2">{r.snippet}</div>
            </div>
          ))}
          {res.out.text != null && <><div className="font-medium">{res.out.title}</div><pre className="whitespace-pre-wrap font-sans text-ink-2">{res.out.text}</pre></>}
        </div>
      )}
    </Card>
  );
}
