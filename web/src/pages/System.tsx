import { useEffect, useState } from "react";
import { api, type MuxEvent, type Settings, type SystemInfo } from "../api";
import { SERIES, TimeChart } from "../components/charts";
import { Badge, Button, Card, ErrorNote, Field, Input, Meter, PageHeader, Segmented, StatusDot, Table, Td, Th, Toggle } from "../components/ui";
import { fmtAgo, fmtDuration, fmtGb, fmtTime } from "../format";
import { useApi } from "../hooks";

export default function SystemPage() {
  const [range, setRange] = useState("6h");
  const { data, error } = useApi<SystemInfo>("/system", { range }, 10_000);
  const events = useApi<MuxEvent[]>("/events", { limit: 150 }, 10_000);
  const [level, setLevel] = useState<"all" | MuxEvent["level"]>("all");
  if (error) return <ErrorNote error={error} />;
  if (!data) return null;
  const s = data.system;
  const series = data.series.map((p) => ({ t: p.ts, used: p.mem_used_gb, free: p.mem_free_gb, swap: p.swap_gb, mux: p.mux_gb, disk: p.disk_free_gb, load: p.cpu }));
  const bucket = range === "1h" ? 60_000 : range === "24h" ? 900_000 : 300_000;
  const pressure = s.pressure === 4 ? { tone: "bad" as const, label: "critical" } : s.pressure === 2 ? { tone: "warn" as const, label: "warn" } : { tone: "good" as const, label: "normal" };
  return (
    <>
      <PageHeader title="System" subtitle={`${s.chip} · ${s.cores} cores · ${s.memTotalGb.toFixed(0)} GB unified memory · mux up ${fmtDuration(data.uptimeS)}`} actions={<Segmented value={range} onChange={setRange} options={[{ value: "1h", label: "1h" }, { value: "6h", label: "6h" }, { value: "24h", label: "24h" }]} />} />
      <div className="mb-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        <Card><div className="text-[11px] uppercase tracking-wide text-ink-3">Memory pressure</div><div className="mt-2"><StatusDot tone={pressure.tone} label={pressure.label} /></div><div className="mt-1 text-[11.5px] text-ink-3">macOS's own reading; mux unloads idle models above normal</div></Card>
        <Card><div className="text-[11px] uppercase tracking-wide text-ink-3">Free memory</div><div className="mt-1 text-lg font-semibold num">{fmtGb(s.memFreeGb)}</div><Meter value={s.memUsedGb} max={s.memTotalGb} /></Card>
        <Card><div className="text-[11px] uppercase tracking-wide text-ink-3">Swap</div><div className={`mt-1 text-lg font-semibold num ${s.swapGb > 20 ? "text-warn" : ""}`}>{fmtGb(s.swapGb)}</div><div className="text-[11.5px] text-ink-3">high swap slows every model</div></Card>
        <Card><div className="text-[11px] uppercase tracking-wide text-ink-3">mux model budget</div><div className="mt-1 text-lg font-semibold num">{data.budget.usedGb.toFixed(1)} / {data.budget.budgetGb} GB</div><Meter value={data.budget.usedGb} max={data.budget.budgetGb} /></Card>
        <Card><div className="text-[11px] uppercase tracking-wide text-ink-3">Disk free · load</div><div className="mt-1 text-lg font-semibold num">{s.diskFreeGb.toFixed(0)} GB</div><div className="text-[11.5px] text-ink-3 num">load avg {s.load1.toFixed(2)}</div></Card>
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Memory" subtitle="GB: used by the Mac, free for new work, and mux's model servers">
          <TimeChart data={series} bucketMs={bucket} yFormat={(v) => `${Math.round(v)}`} series={[
            { key: "used", label: "Used", color: SERIES[0], format: (v) => fmtGb(v) },
            { key: "free", label: "Free", color: SERIES[2], format: (v) => fmtGb(v) },
            { key: "mux", label: "mux models", color: SERIES[6], format: (v) => fmtGb(v) },
          ]} />
        </Card>
        <Card title="Swap" subtitle="GB in use">
          <TimeChart data={series} bucketMs={bucket} kind="area" yFormat={(v) => `${Math.round(v)}`} series={[{ key: "swap", label: "Swap", color: SERIES[1], format: (v) => fmtGb(v) }]} />
        </Card>
      </div>
      <Card title="Model servers" className="mt-4" pad={false}>
        <Table>
          <thead><tr><Th>Model</Th><Th>Backend</Th><Th>State</Th><Th right>Port</Th><Th right>PID</Th><Th right>Estimate</Th><Th right>RSS</Th><Th right>In flight</Th><Th right>Served</Th><Th>Last used</Th><Th>Health</Th></tr></thead>
          <tbody>{data.instances.map((i) => {
            const h = data.health[i.id];
            return (
              <tr key={i.id}><Td className="font-medium">{i.id}</Td><Td>{i.backend}</Td><Td><StatusDot tone={i.state === "ready" ? "good" : i.state === "loading" ? "accent" : "warn"} label={i.state} pulse={i.state === "loading"} /></Td>
                <Td right>{i.port}</Td><Td right>{i.pid}</Td><Td right>{fmtGb(i.estimateGb)}</Td><Td right>{i.rssGb != null ? fmtGb(i.rssGb) : "—"}</Td><Td right>{i.inflight}</Td><Td right>{i.requests}</Td>
                <Td className="text-ink-2">{fmtAgo(i.lastUsed)}</Td><Td>{h?.cooldown ? <Badge tone="bad">cooling down</Badge> : h ? <span className="text-[11.5px] text-ink-3 num">{h.ok} ok · {h.err} err{h.tps ? ` · ${h.tps.toFixed(0)} tok/s` : ""}</span> : "—"}</Td></tr>
            );
          })}
          {!data.instances.length && <tr><Td className="text-ink-3">No model loaded — models load on their first request.</Td></tr>}</tbody>
        </Table>
        {Object.keys(data.failures).length > 0 && <div className="border-t border-line p-4 text-[12px]">{Object.entries(data.failures).map(([id, f]) => <div key={id} className="text-bad"><b>{id}</b> failed {fmtAgo(f.at)}: {f.error.split("\n")[0]}</div>)}</div>}
      </Card>
      <div className="mt-4 grid gap-4 lg:grid-cols-[1fr_420px]">
        <Card title="Events" pad={false} actions={<Segmented value={level} onChange={setLevel} options={[{ value: "all", label: "All" }, { value: "info", label: "Info" }, { value: "warn", label: "Warn" }, { value: "error", label: "Error" }]} />}>
          <div className="max-h-[520px] overflow-y-auto">
            {(events.data ?? []).filter((e) => level === "all" || e.level === level).map((e) => (
              <div key={e.id} className="grid grid-cols-[120px_60px_80px_1fr] gap-2 border-b border-line px-4 py-1.5 text-[12px]">
                <span className="text-ink-3 num">{fmtTime(e.ts, true)}</span>
                <span>{e.level === "error" ? <Badge tone="bad">error</Badge> : e.level === "warn" ? <Badge tone="warn">warn</Badge> : <Badge tone="muted">info</Badge>}</span>
                <span className="text-ink-3">{e.source}</span><span className="text-ink-2 break-words">{e.message}</span>
              </div>
            ))}
          </div>
        </Card>
        <SettingsCard />
      </div>
    </>
  );
}

function SettingsCard() {
  const { data, reload } = useApi<Settings>("/settings");
  const [s, setS] = useState<Settings | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  useEffect(() => { if (data) setS(data); }, [data]);
  if (!s) return null;
  const num = (k: keyof Settings, label: string, hint: string) => (
    <Field label={label} hint={hint}><Input type="number" value={s[k] as number} onChange={(e) => setS({ ...s, [k]: Number(e.target.value) })} /></Field>
  );
  const save = async () => { try { await api("/settings", { method: "PATCH", body: s }); setSaved(true); setTimeout(() => setSaved(false), 1500); void reload(true); } catch (e) { setErr((e as Error).message); } };
  return (
    <Card title="Settings">
      <ErrorNote error={err} />
      <div className="grid grid-cols-2 gap-3">
        {num("memoryBudgetGb", "Model memory budget (GB)", "what mux's models may take together")}
        {num("memoryHeadroomGb", "Headroom (GB)", "free memory kept for everything else")}
        {num("maxLoaded", "Max models loaded", "LRU unload beyond it")}
        {num("keepAliveMin", "Keep alive (min)", "idle time before unload")}
        {num("diskReserveGb", "Disk reserve (GB)", "downloads refuse below it")}
        {num("retentionDays", "Retention (days)", "request history kept")}
      </div>
      <div className="mt-3 space-y-2">
        <Toggle checked={s.pressureGuard} onChange={(v) => setS({ ...s, pressureGuard: v })} label="Unload idle models under memory pressure" />
        <Toggle checked={s.logBodies} onChange={(v) => setS({ ...s, logBodies: v })} label="Keep bodies for every request (all tenants)" />
      </div>
      <Button variant="primary" className="mt-4" onClick={save}>{saved ? "Saved" : "Save settings"}</Button>
    </Card>
  );
}
