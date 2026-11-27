import { useState } from "react";
import { api } from "../api";
import { SERIES, TimeChart } from "../components/charts";
import { Badge, Card, Drawer, Empty, ErrorNote, KeyValue, PageHeader, Segmented, Select, Stat, Table, Td, Th, Toggle, cx } from "../components/ui";
import { fmtAgo, fmtCompact, fmtInt, fmtMs, fmtPct, fmtTime } from "../format";
import { useApi, usePersisted } from "../hooks";

type Prio = "interactive" | "normal" | "background";
interface Dist { p50: number | null; p90: number | null; p99: number | null; n: number }
interface Stat_ { n: number; errors: number; cold: number; queue: Dist; slotWait: Dist; ttft: Dist; reasoning: Dist; tps: Dist; total: Dist; prefill: Dist; cacheShare: number | null }
interface Turn {
  id: string; ts: number; started: number; node: string; tenant_id: string; user_hash: string | null; endpoint: string; route: string | null; model_id: string | null;
  priority: Prio; priority_why: string | null; trace: string | null; status: number; error_type: string | null; cold: number; fallbacks: number;
  queue_ms: number | null; admit_ms: number | null; load_ms: number | null; slot_wait_ms: number | null; queue_reasons: string[]; concurrent: number | null; ahead: number | null;
  prompt_tokens: number | null; cached_tokens: number | null; prefill_ms: number | null; reasoning_ms: number | null; ttft_ms: number | null; gen_tokens: number | null; tps: number | null; total_ms: number | null; upstream_ms: number | null;
  loaded: number | null; running: number | null; waiting: number | null; voice: number | null; ci_running: number | null; ci_paused: number | null; record_busy: number | null; tenants_inflight: number | null;
  stages: Record<string, number> | null; realtime: Record<string, unknown> | null;
}
interface Summary {
  window: string; since: number; node: string; role: string; bucketMs: number; priority: { enabled: boolean; reserveSlots: number; backgroundMaxWaitMs: number };
  totals: Stat_; byPriority: Record<Prio, Stat_>; groups: (Stat_ & { tenant: string; route: string | null; model: string | null; priority: Prio; endpoint: string })[];
  series: Record<string, number | null>[]; slowest: Turn[];
}
interface Hot { id: string; pinned: boolean; state: string; hot: boolean; loadedSince: number | null; lastUnload: { at: number; why: string; upMs: number | null } | null; unloads24h: number; slots: number | null; inflight: number }
interface Live {
  node: string; slots: Record<string, { capacity: number; reserve: number; running: Record<Prio, number>; waiting: Record<Prio, number>; oldestWaitMs: number }>;
  hot: Hot[]; voice: number; keeper: { recordBusy: boolean; ciPaused: number; ciRunning: number | null };
  priority: { enabled: boolean; reserveSlots: number; backgroundMaxWaitMs: number };
}
interface TurnDetail {
  turn: Turn; window: { start: number; end: number };
  others: { id: string; started: number; ended: number; tenant_id: string; endpoint: string; model_id: string | null; status: number; latency_ms: number; agent: string | null; priority: Prio | null }[];
  ci: { id: number; repo: string; name: string; runner: string; started_at: number; completed_at: number | null }[];
  samples: { ts: number; cpu_pct: number | null; gpu_pct: number | null; mem_free_gb: number | null }[];
  trace: Turn[];
}

const TONE: Record<Prio, "good" | "neutral" | "muted"> = { interactive: "good", normal: "neutral", background: "muted" };
const PrioBadge = ({ p }: { p: Prio }) => <Badge tone={TONE[p]}>{p}</Badge>;
const trio = (d: Dist | undefined, f: (n: number | null) => string = fmtMs) => d ? <span className="num">{f(d.p50)} <span className="text-ink-3">· {f(d.p90)} · {f(d.p99)}</span></span> : "—";

/** Speed: where each turn's time goes, by tenant, route, model and class, and what competed when one was slow. */
export default function SpeedPage() {
  const [win, setWin] = usePersisted("speed.window", "day");
  const [prio, setPrio] = usePersisted("speed.priority", "");
  const [tenant, setTenant] = usePersisted("speed.tenant", "");
  const [open, setOpen] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const sum = useApi<Summary>("/speed", { window: win, priority: prio || undefined, tenant: tenant || undefined }, 15_000);
  const live = useApi<Live>("/speed/live", undefined, 5_000);
  const s = sum.data, l = live.data;
  const toggle = async (v: boolean) => { try { await api("/settings", { method: "PATCH", body: { priorityEnabled: v } }); void live.reload(true); void sum.reload(true); } catch (e) { setErr((e as Error).message); } };
  const tenants = [...new Set((s?.groups ?? []).map((g) => g.tenant))];
  return (
    <>
      <PageHeader title="Speed" subtitle={<>Every chat, messages and voice turn on {s?.node ?? "this mux"}: queue wait, prompt read, first token, tokens/s and total, by class. Bloom joins its own numbers with <span className="font-mono">x-mux-trace</span> and <span className="font-mono">x-mux-stage</span>; the same as JSON at <span className="font-mono">/api/admin/speed</span>.</>}
        actions={l && <Toggle checked={l.priority.enabled} onChange={(v) => void toggle(v)} label={l.priority.enabled ? `Priority on · ${l.priority.reserveSlots} slot kept for a person` : "Priority off (first come, first served)"} />} />
      <ErrorNote error={err ?? sum.error ?? null} />
      <div className="mb-3 flex flex-wrap gap-2">
        <Segmented value={win} onChange={setWin} options={[{ value: "15m", label: "15 min" }, { value: "hour", label: "Hour" }, { value: "day", label: "Day" }, { value: "week", label: "Week" }]} />
        <Select className="w-40" value={prio} onChange={(e) => setPrio(e.target.value)}><option value="">Every class</option><option value="interactive">interactive</option><option value="normal">normal</option><option value="background">background</option></Select>
        <Select className="w-48" value={tenant} onChange={(e) => setTenant(e.target.value)}><option value="">Every tenant</option>{tenants.map((t) => <option key={t} value={t}>{t}</option>)}</Select>
      </div>

      <div className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-4">
        {(["interactive", "normal", "background"] as Prio[]).map((p) => {
          const b = s?.byPriority[p];
          return <Stat key={p} label={`${p} · first token p50 / p90`} value={b?.ttft.n ? `${fmtMs(b.ttft.p50)} / ${fmtMs(b.ttft.p90)}` : "—"} sub={b ? `${fmtInt(b.n)} turns · queue p90 ${fmtMs(b.queue.p90)}` : ""} tone={p === "interactive" && (b?.ttft.p90 ?? 0) > 1500 ? "warn" : undefined} />;
        })}
        <Stat label="Now" value={l ? `${l.voice} voice · ${Object.values(l.slots).reduce((a, x) => a + x.waiting.interactive + x.waiting.normal + x.waiting.background, 0)} waiting` : "—"}
          sub={l ? `CI ${l.keeper.ciRunning ?? "—"} running, ${l.keeper.ciPaused} paused${l.keeper.recordBusy ? " · Record busy" : ""}` : ""} />
      </div>

      <div className="mb-4 grid gap-4 xl:grid-cols-2">
        <Card title="Hot models" subtitle="A model a person talks to should never be cold: loaded since, and the last time it went and why.">
          {!l?.hot.length ? <Empty>No model mux runs here.</Empty> : (
            <Table>
              <thead><tr><Th>Model</Th><Th>State</Th><Th>Loaded since</Th><Th>Slots</Th><Th>Last unload</Th><Th right>Unloads 24 h</Th></tr></thead>
              <tbody>{l.hot.map((h) => {
                const sl = l.slots[h.id];
                return (
                  <tr key={h.id}>
                    <Td mono>{h.id}{h.pinned && <Badge tone="neutral" className="ml-1.5">pinned</Badge>}</Td>
                    <Td><Badge tone={h.hot ? "good" : h.pinned ? "bad" : "muted"}>{h.hot ? "hot" : h.state}</Badge></Td>
                    <Td className="num text-ink-2">{h.loadedSince ? `${fmtTime(h.loadedSince, true)} (${fmtAgo(h.loadedSince)})` : "—"}</Td>
                    <Td className="num text-[11.5px]">{sl ? `${sl.running.interactive}i ${sl.running.normal}n ${sl.running.background}b of ${sl.capacity}${sl.reserve ? ` (${sl.reserve} kept)` : ""}${sl.waiting.interactive + sl.waiting.normal + sl.waiting.background ? ` · ${sl.waiting.interactive + sl.waiting.normal + sl.waiting.background} waiting` : ""}` : h.slots ?? "—"}</Td>
                    <Td className="text-[11.5px] text-ink-2">{h.lastUnload ? `${fmtAgo(h.lastUnload.at)}: ${h.lastUnload.why}` : "never"}</Td>
                    <Td right>{h.unloads24h ? <Badge tone={h.pinned ? "bad" : "warn"}>{h.unloads24h}</Badge> : "0"}</Td>
                  </tr>
                );
              })}</tbody>
            </Table>
          )}
        </Card>
        <Card title="First token, by class" subtitle="p50 and p90 per bucket">
          {s ? <TimeChart data={s.series} bucketMs={s.bucketMs} yFormat={(v) => fmtMs(v)} series={[
            { key: "interactive_ttft_p50", label: "interactive p50", color: SERIES[0] }, { key: "interactive_ttft_p90", label: "interactive p90", color: SERIES[1] },
            { key: "normal_ttft_p90", label: "normal p90", color: SERIES[2] }, { key: "background_ttft_p90", label: "background p90", color: SERIES[3] },
          ]} /> : <Empty>Loading…</Empty>}
        </Card>
      </div>

      <Card title="By tenant, route, model and class" subtitle="p50 · p90 · p99" pad={false} className="mb-4">
        {!s?.groups.length ? <div className="p-4"><Empty>No turns in this window.</Empty></div> : (
          <Table>
            <thead><tr><Th>Tenant</Th><Th>Route</Th><Th>Model</Th><Th>Class</Th><Th right>Turns</Th><Th>Queue wait</Th><Th>First token</Th><Th>Tokens/s</Th><Th>Total</Th><Th right>Prompt cache</Th><Th right>Cold</Th><Th right>Errors</Th></tr></thead>
            <tbody>{s.groups.map((g) => (
              <tr key={[g.tenant, g.route, g.model, g.priority, g.endpoint].join("|")}>
                <Td>{g.tenant}</Td><Td mono>{g.route ?? "—"}</Td><Td mono className="max-w-48 truncate">{g.model ?? "—"}</Td><Td><PrioBadge p={g.priority} /></Td>
                <Td right>{fmtInt(g.n)}</Td><Td>{trio(g.queue)}</Td><Td>{trio(g.ttft)}</Td><Td>{trio(g.tps, (n) => (n == null ? "—" : fmtCompact(n)))}</Td><Td>{trio(g.total)}</Td>
                <Td right>{fmtPct(g.cacheShare, 0)}</Td><Td right>{g.cold || "—"}</Td><Td right>{g.errors ? <Badge tone="bad">{g.errors}</Badge> : "—"}</Td>
              </tr>
            ))}</tbody>
          </Table>
        )}
      </Card>

      <Card title="Slowest turns" subtitle="By first token. Click one for its breakdown and what competed with it." pad={false}>
        {!s?.slowest.length ? <div className="p-4"><Empty>No turns in this window.</Empty></div> : (
          <Table>
            <thead><tr><Th>When</Th><Th>Tenant</Th><Th>Class</Th><Th>Model</Th><Th right>Queue</Th><Th>Why it waited</Th><Th right>Prefill</Th><Th right>First token</Th><Th right>Total</Th><Th>Alongside</Th></tr></thead>
            <tbody>{s.slowest.map((t) => (
              <tr key={t.id} className="cursor-pointer hover:bg-s2" onClick={() => setOpen(t.id)}>
                <Td className="num text-ink-2">{fmtTime(t.ts, true)}</Td><Td>{t.tenant_id}</Td><Td><PrioBadge p={t.priority} /></Td><Td mono className="max-w-40 truncate">{t.model_id ?? "—"}</Td>
                <Td right>{fmtMs(t.queue_ms)}</Td><Td className="max-w-56 truncate text-[11.5px] text-ink-3">{t.queue_reasons.join(", ") || "—"}</Td>
                <Td right>{fmtMs(t.prefill_ms)}</Td><Td right className={cx((t.ttft_ms ?? 0) > 1500 && "text-warn")}>{fmtMs(t.ttft_ms)}</Td><Td right>{fmtMs(t.total_ms)}</Td>
                <Td className="text-[11.5px] text-ink-3">{alongside(t)}</Td>
              </tr>
            ))}</tbody>
          </Table>
        )}
      </Card>
      <TurnDrawer id={open} onClose={() => setOpen(null)} />
    </>
  );
}

const alongside = (t: Turn) => [
  t.running != null ? `${t.running} running` : null, t.waiting ? `${t.waiting} waiting` : null, t.voice ? `${t.voice} voice` : null,
  t.ci_running ? `CI ${t.ci_running}${t.ci_paused ? ` (${t.ci_paused} paused)` : ""}` : null, t.record_busy ? "Record busy" : null, t.loaded != null ? `${t.loaded} loaded` : null,
].filter(Boolean).join(" · ");

function TurnDrawer({ id, onClose }: { id: string | null; onClose: () => void }) {
  const { data: d } = useApi<TurnDetail>(id ? `/speed/turns/${encodeURIComponent(id)}` : null);
  const t = d?.turn;
  const span = d ? Math.max(1, d.window.end - d.window.start) : 1;
  const bar = (a: number, b: number | null) => {
    if (!d) return null;
    const from = Math.max(0, (a - d.window.start) / span), to = Math.min(1, ((b ?? d.window.end) - d.window.start) / span);
    return <div className="relative h-2 rounded bg-s2"><div className="absolute h-2 rounded bg-accent" style={{ left: `${from * 100}%`, width: `${Math.max(1, (to - from) * 100)}%` }} /></div>;
  };
  return (
    <Drawer open={!!id} onClose={onClose} title={t ? `${t.endpoint} · ${t.model_id ?? ""}` : "Turn"}>
      {!t ? <Empty>Loading…</Empty> : (
        <div className="space-y-5 text-[12.5px]">
          <KeyValue items={[
            ["Class", <span key="c"><PrioBadge p={t.priority} /> <span className="text-ink-3">{t.priority_why}</span></span>], ["Tenant", t.tenant_id], ["Route", t.route ?? "—"], ["Trace", <span key="tr" className="font-mono">{t.trace ?? "—"}</span>],
            ["Waiting to be admitted", `${fmtMs(t.queue_ms)} (presence ${fmtMs(t.admit_ms)}, cold load ${fmtMs(t.load_ms)}, slot ${fmtMs(t.slot_wait_ms)})`],
            ["Why it waited", t.queue_reasons.join(", ") || "it did not"], ["At admission", `${t.concurrent ?? "—"} running on this model, ${t.ahead ?? "—"} ahead in its queue`],
            ["Prompt", `${fmtInt(t.prompt_tokens)} tokens, ${fmtInt(t.cached_tokens)} from the prompt cache, read in ${fmtMs(t.prefill_ms)}`],
            ["First answer token", `${fmtMs(t.ttft_ms)}${t.reasoning_ms != null ? ` (it began thinking at ${fmtMs(t.reasoning_ms)})` : ""}`], ["Generated", `${fmtInt(t.gen_tokens)} tokens at ${t.tps ?? "—"} tok/s`], ["Total", fmtMs(t.total_ms)],
            ["Caller's stages", t.stages ? Object.entries(t.stages).map(([k, v]) => `${k} ${fmtMs(v)}`).join(", ") : "—"],
            ...(t.realtime ? [["Voice", Object.entries(t.realtime).filter(([k]) => k.endsWith("_ms")).map(([k, v]) => `${k.replace(/_ms$/, "").replace(/_/g, " ")} ${fmtMs(v as number)}`).join(" · ")] as [string, string]] : []),
            ["Alongside", alongside(t) || "—"],
          ]} />
          <div>
            <div className="mb-2 font-medium">What competed ({d.others.length} calls, {d.ci.length} CI jobs)</div>
            <div className="space-y-1.5">
              <div className="grid grid-cols-[180px_1fr] items-center gap-2"><span className="truncate font-medium">this turn</span>{bar(t.started, t.ts)}</div>
              {d.ci.map((j) => <div key={`ci${j.id}`} className="grid grid-cols-[180px_1fr] items-center gap-2"><span className="truncate text-warn" title={`${j.repo} ${j.name}`}>CI {j.runner}: {j.name}</span>{bar(j.started_at, j.completed_at)}</div>)}
              {d.others.slice(0, 60).map((o) => <div key={o.id} className="grid grid-cols-[180px_1fr] items-center gap-2"><span className="truncate text-ink-2" title={`${o.endpoint} ${o.model_id ?? ""} ${o.agent ?? ""}`}>{o.tenant_id} · {o.priority ?? o.endpoint}</span>{bar(o.started, o.ended)}</div>)}
            </div>
            {d.samples.length > 0 && <div className="mt-2 text-[11.5px] text-ink-3">Machine around it: CPU {d.samples.map((x) => x.cpu_pct == null ? "—" : `${Math.round(x.cpu_pct)}%`).join(" → ")}; GPU {d.samples.map((x) => x.gpu_pct == null ? "—" : `${Math.round(x.gpu_pct)}%`).join(" → ")}</div>}
          </div>
          {d.trace.length > 1 && <div><div className="mb-1 font-medium">The same trace</div>{d.trace.map((x) => <div key={x.id} className="text-[11.5px] text-ink-2">{fmtTime(x.ts)} {x.endpoint} {x.model_id ?? ""}: first token {fmtMs(x.ttft_ms)}, total {fmtMs(x.total_ms)}</div>)}</div>}
        </div>
      )}
    </Drawer>
  );
}
