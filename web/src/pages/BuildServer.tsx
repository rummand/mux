import { useMemo, useState } from "react";
import { api } from "../api";
import { Markdown } from "../components/Assistant";
import { BarList, SERIES, TimeChart } from "../components/charts";
import { Badge, Button, Card, Empty, ErrorNote, Segmented, StatusDot, Table, Td, Th } from "../components/ui";
import { fmtAgo, fmtInt, fmtMs, fmtPct, fmtTime } from "../format";
import { useApi } from "../hooks";

/**
 * Services → Build server: the GitHub Actions runners on this Mac, which mux owns (server/src/build.ts). What each
 * runner is doing, how the builds go (pass rate, time, waiting, the steps where the minutes go and the ones that fail),
 * and what the builds cost the Mac the models run on. Charts drawn here in SVG follow Nexus's admin charts (hand-made,
 * theme colours): the runner timeline, the success ring, and the duration bars per job.
 */
type Step = { n: number; name: string; conclusion: string | null; status: string; start: number | null; end: number | null };
interface Runner {
  name: string; repo: string; dir: string; label: string; pid: number | null; lastExit: number | null; node: string | null; status: string; busy: boolean; labels: string[]; seen: number | null;
  utilisation: number | null; uptime: number | null; jobs: number; restartedAt: number | null;
  last: { name: string; conclusion: string | null; at: number | null; url: string } | null;
  current: { id: number; name: string; workflow: string; branch: string; started: number | null; url: string; steps: Step[] } | null;
  availability: { t: number; state: "stopped" | "offline" | "busy" | "idle" }[];
}
interface Build {
  range: string; bucket: number; dir: string; poll: { ts: number; ok: boolean; error: string | null; calls: number };
  runners: Runner[];
  repos: { repo: string; runners: number; jobs: number; passed: number; failed: number; minutes: number; p50: number | null; lastAt: number | null; last: string | null }[];
  kpis: { jobs: number; passed: number; failed: number; successRate: number | null; hostedJobs: number; durP50: number | null; durP95: number | null; queueP50: number | null; queueP95: number | null; buildMinutes: number; queuedNow: number; runs: number; utilisation: number | null };
  series: { t: number; passed: number; failed: number; other: number; busy: number | null; cpu: number | null; mem: number | null; swap: number | null }[];
  load: { building: { cpu: number | null; swap: number | null; samples: number }; idle: { cpu: number | null; swap: number | null; samples: number } };
  jobs: { repo: string; workflow: string; name: string; here: boolean; runs: number; passed: number; failed: number; p50: number | null; p95: number | null; queueP50: number | null; last: string | null; lastAt: number | null; trend: { ms: number; ok: boolean }[] }[];
  steps: { slowest: { repo: string; job: string; name: string; n: number; avgMs: number; p95: number | null; totalMs: number; failed: number }[]; failing: { repo: string; job: string; name: string; n: number; failed: number }[] };
  flaky: string[];
  timeline: { id: number; name: string; workflow: string; repo: string; runner: string | null; created: number; start: number | null; end: number | null; status: string; conclusion: string | null; url: string }[];
  queued: { id: number; name: string; workflow: string; repo: string; branch: string; created: number; labels: string[]; url: string }[];
  failures: { id: number; name: string; workflow: string; repo: string; branch: string; at: number | null; step: string | null; runner: string | null; attempt: number; url: string }[];
  recent: { id: number; repo: string; workflow: string; title: string; event: string; branch: string; sha: string; status: string; conclusion: string | null; attempt: number; actor: string; created: number; url: string; durationMs: number | null; here: boolean; jobs: { name: string; conclusion: string | null; status: string }[] }[];
}

const short = (repo: string) => repo.split("/")[1] ?? repo;
const wait = (ms: number | null) => (ms == null ? "—" : ms < 1000 ? "<1 s" : fmtMs(ms));
const minutes = (m: number) => (m < 60 ? `${Math.round(m)} min` : `${(m / 60).toFixed(1)} h`);
const COLOR = { success: "var(--good)", failure: "var(--critical)", cancelled: "var(--text-muted)", running: "var(--accent)" } as const;
const colorOf = (c: string | null, status?: string) => (status && status !== "completed" ? COLOR.running : c === "success" ? COLOR.success : c === "failure" || c === "timed_out" || c === "startup_failure" ? COLOR.failure : COLOR.cancelled);
const STATE = { busy: "var(--accent)", idle: "var(--good)", offline: "var(--warning)", stopped: "var(--critical)" } as const;

function Kpi({ label, value, sub, tone }: { label: string; value: React.ReactNode; sub?: React.ReactNode; tone?: "bad" | "warn" }) {
  return (
    <div className="min-w-[120px]">
      <div className="text-[11px] uppercase tracking-wide text-ink-3">{label}</div>
      <div className={`mt-0.5 text-lg font-semibold num ${tone === "bad" ? "text-bad" : tone === "warn" ? "text-warn" : ""}`}>{value}</div>
      {sub && <div className="text-[11.5px] text-ink-3 num">{sub}</div>}
    </div>
  );
}

/** A ring for a share (Nexus's benchmark gauge, smaller): green from 90%, amber from 70%, red below. */
function Ring({ value, size = 64 }: { value: number | null; size?: number }) {
  const r = size / 2 - 5, c = 2 * Math.PI * r, v = value ?? 0;
  const color = value == null ? "var(--text-muted)" : v >= 0.9 ? "var(--good)" : v >= 0.7 ? "var(--warning)" : "var(--critical)";
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} role="img" aria-label={`success rate ${fmtPct(value, 0)}`}>
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--surface-3)" strokeWidth={6} />
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={color} strokeWidth={6} strokeLinecap="round" strokeDasharray={`${c * v} ${c}`} transform={`rotate(-90 ${size / 2} ${size / 2})`} />
      <text x="50%" y="50%" dominantBaseline="central" textAnchor="middle" className="num" fontSize={size / 4.2} fontWeight={600} fill="var(--text-primary)">{value == null ? "—" : `${Math.round(v * 100)}%`}</text>
    </svg>
  );
}

export default function BuildServer() {
  const [range, setRange] = useState("24h");
  const [repo, setRepo] = useState("all");
  const { data, error, reload } = useApi<Build>("/build", { range }, 20_000, null);
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const act = async (what: string, path: string) => {
    setBusy(what); setNote(null);
    try { await api(path, { method: "POST", scope: null }); await reload(true); } catch (e) { setNote((e as Error).message); } finally { setBusy(null); }
  };
  if (error) return <ErrorNote error={error} />;
  if (!data) return <Empty>Asking GitHub about the runners…</Empty>;
  const pick = <T extends { repo: string }>(xs: T[]) => (repo === "all" ? xs : xs.filter((x) => x.repo === repo));
  const k = data.kpis;
  const online = data.runners.filter((r) => r.status === "online").length, working = data.runners.filter((r) => r.busy).length;
  return (
    <>
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <Segmented value={range} onChange={setRange} options={["6h", "24h", "7d", "30d"].map((v) => ({ value: v, label: v }))} />
        <Segmented value={repo} onChange={setRepo} options={[{ value: "all", label: "All repositories" }, ...data.repos.map((r) => ({ value: r.repo, label: short(r.repo) }))]} />
        <span className="ml-auto text-[11.5px] text-ink-3">
          {data.poll.ts ? <>GitHub read {fmtAgo(data.poll.ts)} · {data.poll.calls} calls</> : "first read of GitHub under way (reads 100 runs a repository)"}
          {!data.poll.ok && <span className="text-bad"> · {data.poll.error}</span>}
        </span>
        <Button size="sm" disabled={!!busy} onClick={() => void act("refresh", "/build/refresh")}>{busy === "refresh" ? "Reading…" : "Read now"}</Button>
      </div>
      <ErrorNote error={note} />

      <Card className="mb-4">
        <div className="flex flex-wrap items-center gap-x-8 gap-y-4">
          <div className="flex items-center gap-3">
            <Ring value={k.successRate} />
            <div>
              <div className="text-[16px] font-semibold">Build server</div>
              <div className="text-[12px] text-ink-2">{data.runners.length} runners on this Mac for {data.repos.length} repositories · jobs passed, this Mac, {data.range}</div>
            </div>
          </div>
          <Kpi label="Runners" value={`${online} of ${data.runners.length} online`} sub={`${working} building now`} tone={online < data.runners.length ? "bad" : undefined} />
          <Kpi label="Jobs here" value={fmtInt(k.jobs)} sub={<>{k.passed} passed · <span className={k.failed ? "text-bad" : ""}>{k.failed} failed</span></>} />
          <Kpi label="Job time p50 · p95" value={fmtMs(k.durP50)} sub={`p95 ${fmtMs(k.durP95)}`} />
          <Kpi label="Waiting p50 · p95" value={wait(k.queueP50)} sub={`p95 ${wait(k.queueP95)}`} tone={(k.queueP95 ?? 0) > 30 * 60_000 ? "warn" : undefined} />
          <Kpi label="Build time" value={minutes(k.buildMinutes)} sub={k.hostedJobs ? `+ ${k.hostedJobs} jobs on GitHub's machines` : "none on GitHub's machines"} />
          <Kpi label="Busy" value={fmtPct(k.utilisation, 0)} sub="of runner-minutes" />
          <Kpi label="Queued now" value={fmtInt(k.queuedNow)} tone={k.queuedNow ? "warn" : undefined} />
        </div>
      </Card>

      <Keeper repo={repo} />

      <Runners runners={pick(data.runners)} busy={busy} onRestart={(n) => void act(n, `/build/runners/${encodeURIComponent(n)}/restart`)} />

      <Card className="mb-4" title="Timeline" subtitle={`every job on each runner · ${data.range} · green passed, red failed, blue running, grey cancelled; hover for the job`}>
        <Timeline items={pick(data.timeline)} runners={pick(data.runners).map((r) => r.name)} range={data.range} />
      </Card>

      <div className="mb-4 grid gap-4 lg:grid-cols-2">
        <Card title="Jobs finished" subtitle="on this Mac, per bucket">
          <TimeChart data={data.series.map((p) => ({ t: p.t, passed: p.passed, failed: p.failed, other: p.other }))} bucketMs={data.bucket} kind="bar" stacked series={[
            { key: "passed", label: "Passed", color: "var(--good)" }, { key: "failed", label: "Failed", color: "var(--critical)" }, { key: "other", label: "Cancelled", color: "var(--text-muted)" },
          ]} />
        </Card>
        <Card title="Builds and the models" subtitle={<>the Mac's CPU and the share of runners busy · CPU while building {fmtPct((data.load.building.cpu ?? 0) / 100, 0)}, while not {fmtPct((data.load.idle.cpu ?? 0) / 100, 0)}{data.load.building.swap != null && data.load.idle.swap != null ? ` · swap ${data.load.building.swap.toFixed(1)} vs ${data.load.idle.swap.toFixed(1)} GB` : ""}</>}>
          <TimeChart data={data.series.map((p) => ({ t: p.t, cpu: p.cpu, busy: p.busy == null ? null : p.busy * 100 }))} bucketMs={data.bucket} yFormat={(v) => `${Math.round(v)}%`} series={[
            { key: "cpu", label: "CPU", color: SERIES[1], format: (v) => `${v.toFixed(0)}%` }, { key: "busy", label: "Runners busy", color: SERIES[0], format: (v) => `${v.toFixed(0)}%` },
          ]} />
        </Card>
      </div>

      <div className="mb-4 grid gap-4 lg:grid-cols-3">
        <Card title="By repository" subtitle="build time on this Mac">
          {data.repos.some((r) => r.jobs) ? <BarList format={(v) => minutes(v)} items={data.repos.filter((r) => r.jobs).sort((a, b) => b.minutes - a.minutes).map((r) => ({ label: <button className="hover:underline" onClick={() => setRepo(r.repo)}>{short(r.repo)}</button>, value: r.minutes, color: SERIES[0], sub: r.failed ? <span className="text-bad">{r.failed} failed</span> : <span>{r.jobs} jobs</span> }))} /> : <Empty>No jobs on this Mac in this range.</Empty>}
        </Card>
        <Card title="Where the minutes go" subtitle="steps by total time on this Mac">
          {pick(data.steps.slowest).length ? <BarList format={(v) => minutes(v / 60_000)} items={pick(data.steps.slowest).slice(0, 8).map((s) => ({ label: <span title={`${short(s.repo)} · ${s.job}`}>{s.name}</span>, value: s.totalMs, color: SERIES[3], sub: <span>×{s.n}</span> }))} /> : <Empty>No steps in this range.</Empty>}
        </Card>
        <Card title="What fails" subtitle="the step a failed job stopped at">
          {pick(data.steps.failing).length ? <BarList items={pick(data.steps.failing).map((s) => ({ label: <span title={`${short(s.repo)} · ${s.job}`}>{s.name}</span>, value: s.failed, color: "var(--critical)", sub: <span>of {s.n}</span> }))} /> : <Empty>Nothing failed in this range.</Empty>}
          {data.flaky.length > 0 && <div className="mt-3 border-t border-line pt-2 text-[11.5px] text-warn">Flaky (failed and passed on the same commit): {data.flaky.join(" · ")}</div>}
        </Card>
      </div>

      <Card className="mb-4" title="Jobs" subtitle="each job: how often, how often it passes, how long, and its last 20 runs (bar height is time, colour is result)" pad={false}>
        <JobsTable jobs={pick(data.jobs)} />
      </Card>

      <div className="mb-4 grid gap-4 lg:grid-cols-2">
        <Card title="Recent failures" subtitle="on this Mac" pad={false}>
          <Table>
            <thead><tr><Th>When</Th><Th>Job</Th><Th>Stopped at</Th><Th>Runner</Th></tr></thead>
            <tbody>
              {pick(data.failures).map((f) => (
                <tr key={f.id}>
                  <Td className="text-ink-3 num" title={f.at ? fmtTime(f.at, true) : undefined}>{fmtAgo(f.at)}</Td>
                  <Td><a className="hover:underline" href={f.url} target="_blank" rel="noreferrer">{short(f.repo)} · {f.workflow}/{f.name}</a>{f.attempt > 1 && <Badge tone="muted" className="ml-1">try {f.attempt}</Badge>}<div className="text-[11px] text-ink-3">{f.branch}</div></Td>
                  <Td className="text-[12px] text-bad">{f.step ?? "—"}</Td>
                  <Td className="text-[12px] text-ink-3">{f.runner}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
          {!pick(data.failures).length && <div className="p-4"><Empty>No failures in this range.</Empty></div>}
        </Card>
        <Card title="Waiting for a runner" subtitle="queued jobs for these repositories" pad={false}>
          <Table>
            <thead><tr><Th>Waiting</Th><Th>Job</Th><Th>Asks for</Th></tr></thead>
            <tbody>
              {pick(data.queued).map((q) => (
                <tr key={q.id}>
                  <Td className="num text-warn">{fmtMs(Date.now() - q.created)}</Td>
                  <Td><a className="hover:underline" href={q.url} target="_blank" rel="noreferrer">{short(q.repo)} · {q.workflow}/{q.name}</a><div className="text-[11px] text-ink-3">{q.branch}</div></Td>
                  <Td className="text-[12px] text-ink-3">{q.labels.join(", ")}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
          {!pick(data.queued).length && <div className="p-4"><Empty>Nothing is waiting.</Empty></div>}
        </Card>
      </div>

      <Card title="Recent runs" subtitle="every workflow run in these repositories, also those on GitHub's machines" pad={false}>
        <Table>
          <thead><tr><Th>When</Th><Th>Run</Th><Th>Jobs</Th><Th right>Time</Th><Th>Where</Th></tr></thead>
          <tbody>
            {pick(data.recent).map((r) => (
              <tr key={r.id}>
                <Td className="text-ink-3 num" title={fmtTime(r.created, true)}>{fmtAgo(r.created)}</Td>
                <Td>
                  <a className="hover:underline" href={r.url} target="_blank" rel="noreferrer"><span className="font-medium">{short(r.repo)} · {r.workflow}</span></a>
                  {r.attempt > 1 && <Badge tone="muted" className="ml-1">try {r.attempt}</Badge>}
                  <div className="text-[11px] text-ink-3">{r.branch} · {r.sha} · {r.event}{r.actor ? ` · ${r.actor}` : ""}</div>
                </Td>
                <Td><div className="flex flex-wrap gap-1">{r.jobs.map((j, i) => <span key={i} title={`${j.name}: ${j.status === "completed" ? j.conclusion : j.status}`} className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: colorOf(j.conclusion, j.status) }} />)}</div></Td>
                <Td right className="num">{fmtMs(r.durationMs)}</Td>
                <Td className="text-[12px] text-ink-3">{r.here ? "this Mac" : "GitHub"}</Td>
              </tr>
            ))}
          </tbody>
        </Table>
        {!pick(data.recent).length && <div className="p-4"><Empty>No runs in this range.</Empty></div>}
      </Card>
      <p className="mt-3 text-[11.5px] text-ink-3">mux finds every runner from its LaunchAgent and restarts one that stops (at most every 10 minutes). Add a runner with <code>./deploy/build-runner.sh &lt;owner/repo&gt;</code>; new ones go in {data.dir}.</p>
    </>
  );
}

function Runners({ runners, busy, onRestart }: { runners: Runner[]; busy: string | null; onRestart: (name: string) => void }) {
  return (
    <div className="mb-4 grid gap-3 md:grid-cols-2 xl:grid-cols-3">
      {runners.map((r) => {
        const state = !r.pid ? "stopped" : r.status !== "online" ? "offline" : r.busy ? "busy" : "idle";
        const tone = state === "busy" ? "accent" as const : state === "idle" ? "good" as const : "bad" as const;
        const cur = r.current;
        const doneSteps = cur?.steps.filter((s) => s.status === "completed").length ?? 0;
        const step = cur?.steps.find((s) => s.status === "in_progress");
        return (
          <Card key={r.name}>
            <div className="flex items-center gap-2">
              <span className="font-semibold">{r.name}</span>
              <Badge tone="muted">{short(r.repo)}</Badge>
              <StatusDot tone={tone} label={state === "busy" ? "building" : state} pulse={state === "busy"} />
              <Button size="sm" variant="ghost" className="ml-auto" disabled={busy === r.name || !r.label} title={r.label || "no LaunchAgent"} onClick={() => onRestart(r.name)}>{busy === r.name ? "…" : "Restart"}</Button>
            </div>
            {cur ? (
              <div className="mt-2 text-[12.5px]">
                <a className="font-medium hover:underline" href={cur.url} target="_blank" rel="noreferrer">{cur.workflow}/{cur.name}</a> <span className="text-ink-3">· {cur.branch} · {fmtMs(cur.started ? Date.now() - cur.started : null)}</span>
                <div className="mt-1 flex h-1.5 gap-px overflow-hidden rounded-full">{cur.steps.map((s) => <div key={s.n} className="flex-1" title={s.name} style={{ background: s.status === "completed" ? colorOf(s.conclusion) : s.status === "in_progress" ? "var(--accent)" : "var(--surface-3)" }} />)}</div>
                <div className="mt-0.5 text-[11.5px] text-ink-3">step {doneSteps + 1} of {cur.steps.length}{step ? `: ${step.name}` : ""}</div>
              </div>
            ) : (
              <div className="mt-2 text-[12px] text-ink-3">{r.last ? <>last: <a className="hover:underline" href={r.last.url} target="_blank" rel="noreferrer">{r.last.name}</a> <span style={{ color: colorOf(r.last.conclusion) }}>{r.last.conclusion}</span> · {fmtAgo(r.last.at)}</> : "no job in this range"}</div>
            )}
            <div className="mt-2 flex h-3 gap-px overflow-hidden rounded" aria-label="the last 24 hours, minute by minute">
              {r.availability.length ? r.availability.map((a) => <div key={a.t} className="flex-1" title={`${fmtTime(a.t)} · ${a.state}`} style={{ background: STATE[a.state], opacity: a.state === "idle" ? 0.35 : 1 }} />) : <div className="flex-1 bg-s3" />}
            </div>
            <div className="mt-1.5 flex flex-wrap gap-x-3 text-[11px] text-ink-3 num">
              <span>{r.jobs} jobs</span><span>busy {fmtPct(r.utilisation, 0)}</span><span>up {fmtPct(r.uptime, 1)}</span>
              {r.node && <span title={r.node}>node {r.node.includes("node@24") ? "24" : "Homebrew"}</span>}
              {r.restartedAt && <span className="text-warn">restarted {fmtAgo(r.restartedAt)}</span>}
            </div>
          </Card>
        );
      })}
    </div>
  );
}

/** One row per runner, one bar per job across the range (Nexus's day chart turned on its side). */
function Timeline({ items, runners, range }: { items: Build["timeline"]; runners: string[]; range: string }) {
  const span = { "6h": 6, "24h": 24, "7d": 168, "30d": 720 }[range] ?? 24;
  const [hover, setHover] = useState<Build["timeline"][number] | null>(null);
  const end = Date.now(), start = end - span * 3600_000;
  const W = 1000, row = 18, left = 150, H = runners.length * row + 22;
  const x = (t: number) => left + ((Math.max(start, t) - start) / (end - start)) * (W - left - 8);
  // Ticks on whole hours (days for a month), about six across.
  const ticks = useMemo(() => {
    const step = [1, 2, 3, 4, 6, 12, 24, 48, 96, 120].map((h) => h * 3600_000).find((s) => (end - start) / s <= 7) ?? 120 * 3600_000;
    const out: number[] = [];
    for (let t = Math.ceil(start / step) * step; t <= end; t += step) out.push(t);
    return out;
  }, [start, end]);
  if (!runners.length) return <Empty>No runners.</Empty>;
  return (
    <div className="relative">
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img" aria-label="jobs per runner over time">
        {ticks.map((t) => <g key={t}><line x1={x(t)} x2={x(t)} y1={0} y2={H - 18} stroke="var(--grid)" /><text x={x(t)} y={H - 5} fontSize={10} textAnchor="middle" fill="var(--text-muted)">{new Date(t).toLocaleString("en-GB", span > 48 ? { day: "numeric", month: "short" } : { hour: "2-digit", minute: "2-digit" })}</text></g>)}
        {runners.map((name, i) => (
          <g key={name}>
            <text x={0} y={i * row + 12} fontSize={11} fill="var(--text-secondary)">{name}</text>
            <rect x={left} y={i * row + 3} width={W - left - 8} height={row - 6} rx={2} fill="var(--surface-3)" opacity={0.5} />
            {items.filter((j) => j.runner === name && j.start).map((j) => {
              const x1 = x(j.start!), x2 = x(j.end ?? end);
              return <rect key={j.id} x={x1} y={i * row + 3} width={Math.max(2, x2 - x1)} height={row - 6} rx={2} fill={colorOf(j.conclusion, j.status)}
                onMouseEnter={() => setHover(j)} onMouseLeave={() => setHover(null)} onClick={() => window.open(j.url, "_blank")} style={{ cursor: "pointer" }} />;
            })}
          </g>
        ))}
      </svg>
      {hover && (
        <div className="pointer-events-none absolute right-2 top-0 rounded-md border border-line-strong bg-s1 px-3 py-2 text-[12px] shadow-xl">
          <div className="font-medium">{short(hover.repo)} · {hover.workflow}/{hover.name}</div>
          <div className="text-ink-3 num">{fmtTime(hover.start!, true)} · {fmtMs((hover.end ?? Date.now()) - hover.start!)} · waited {fmtMs(hover.start! - hover.created)}</div>
          <div style={{ color: colorOf(hover.conclusion, hover.status) }}>{hover.status === "completed" ? hover.conclusion : hover.status}</div>
        </div>
      )}
    </div>
  );
}

function JobsTable({ jobs }: { jobs: Build["jobs"] }) {
  return (
    <>
    <Table>
      <thead><tr><Th>Job</Th><Th right>Runs</Th><Th>Passes</Th><Th right>p50 · p95</Th><Th right>Waits</Th><Th>Last 20</Th><Th>Where</Th></tr></thead>
      <tbody>
        {jobs.map((j) => {
          const rate = j.runs ? j.passed / j.runs : 0;
          const max = Math.max(1, ...j.trend.map((t) => t.ms));
          return (
            <tr key={`${j.repo}/${j.workflow}/${j.name}`}>
              <Td><span className="font-medium">{j.name}</span><div className="text-[11px] text-ink-3">{short(j.repo)} · {j.workflow}</div></Td>
              <Td right className="num">{j.runs}</Td>
              <Td>
                <div className="flex items-center gap-2">
                  <div className="flex h-1.5 w-20 overflow-hidden rounded-full bg-s3" title={`${j.passed} passed · ${j.failed} failed · ${j.runs - j.passed - j.failed} cancelled`}>
                    <div style={{ width: `${rate * 100}%`, background: "var(--good)" }} /><div style={{ width: `${(j.failed / Math.max(1, j.runs)) * 100}%`, background: "var(--critical)" }} />
                  </div>
                  <span className="num text-[12px]">{fmtPct(rate, 0)}</span>
                </div>
              </Td>
              <Td right className="num text-[12px]">{fmtMs(j.p50)} · {fmtMs(j.p95)}</Td>
              <Td right className="num text-[12px] text-ink-3">{wait(j.queueP50)}</Td>
              <Td>
                <svg width={20 * 6} height={22} role="img" aria-label="time and result of the last runs">
                  {j.trend.map((t, i) => { const h = Math.max(2, (t.ms / max) * 20); return <rect key={i} x={i * 6} y={22 - h} width={4} height={h} rx={1} fill={t.ok ? "var(--good)" : "var(--critical)"}><title>{`${fmtMs(t.ms)} · ${t.ok ? "passed" : "did not pass"}`}</title></rect>; })}
                </svg>
              </Td>
              <Td className="text-[12px] text-ink-3">{j.here ? "this Mac" : "GitHub"}</Td>
            </tr>
          );
        })}
      </tbody>
    </Table>
    {!jobs.length && <div className="p-4"><Empty>No jobs in this range.</Empty></div>}
    </>
  );
}

interface Case {
  id: string; ts: number; updated_at: number; kind: string; repo: string | null; subject: string; status: "open" | "resolved"; title: string; detail: string | null; evidence: (string | number)[];
  actions: { ts: number; by: string; action: string; ok: boolean; detail?: string; proposal?: { function: { arguments: string } } }[]; report: string | null; said: { url: string }[]; looked_at: number | null; looks: number; fresh: boolean;
}

/** The build keeper's cases (server/src/buildKeeper.ts): what it is looking after, what it found, did and told the repositories. */
function Keeper({ repo }: { repo: string }) {
  const { data, reload } = useApi<{ busy: boolean; cases: Case[] }>("/build/cases", { limit: 40 }, 15_000, null);
  const [open, setOpen] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const call = async (k: string, path: string, body?: unknown) => { setBusy(k); try { await api(path, { method: "POST", body, scope: null }); await reload(true); } finally { setBusy(null); } };
  const cases = (data?.cases ?? []).filter((c) => repo === "all" || !c.repo || c.repo === repo);
  const live = cases.filter((c) => c.status === "open"), done = cases.filter((c) => c.status !== "open").slice(0, 6);
  const KIND: Record<string, string> = { failed: "failing job", runner: "runner down", queue: "waiting", disk: "disk", message: "message" };
  const row = (c: Case) => {
    const shown = open === c.id;
    return (
      <div key={c.id} className="border-t border-line py-2.5 first:border-t-0">
        <button className="flex w-full items-center gap-2 text-left" onClick={() => setOpen(shown ? null : c.id)}>
          <StatusDot tone={c.status !== "open" ? "good" : c.kind === "message" ? "accent" : "bad"} label="" pulse={data?.busy && c.fresh} />
          <span className="text-[13px] font-medium">{c.title}</span>
          <Badge tone="muted">{KIND[c.kind] ?? c.kind}</Badge>
          {c.evidence.length > 1 && <span className="text-[11.5px] text-ink-3">×{c.evidence.length}</span>}
          {c.said.length > 0 && <Badge tone="good">told the repository</Badge>}
          {c.actions.some((a) => a.proposal) && c.status === "open" && <Badge tone="warn">needs you</Badge>}
          <span className="ml-auto text-[11.5px] text-ink-3">{c.looked_at ? `looked ${fmtAgo(c.looked_at)}` : c.status === "open" ? "not looked at yet" : ""} · {fmtAgo(c.updated_at)}</span>
        </button>
        {shown && (
          <div className="mt-2 space-y-3 pl-5 text-[12.5px]">
            {c.detail && <pre className="whitespace-pre-wrap font-sans text-ink-2">{c.detail}</pre>}
            {c.report && <div className="rounded-md border border-line bg-s2 p-3"><Markdown text={c.report} /></div>}
            {c.said.length > 0 && <div className="text-ink-3">Wrote to the repository: {c.said.map((x, i) => <a key={i} className="mr-2 text-accent hover:underline" href={x.url} target="_blank" rel="noreferrer">comment {i + 1}</a>)}</div>}
            <div className="space-y-1">
              {c.actions.map((a, i) => (
                <div key={i} className="text-[12px]">
                  <span className="text-ink-3 num">{fmtTime(a.ts, true)}</span> <span className={a.ok ? "text-ink-2" : "text-bad"}>{a.by}: {a.action}</span>
                  {a.proposal && c.status === "open" && <Button size="sm" variant="primary" className="ml-2" disabled={!!busy} onClick={() => void call(`apply${i}`, `/build/cases/${c.id}/apply`, { index: i })}>{busy === `apply${i}` ? "…" : "Approve & run"}</Button>}
                </div>
              ))}
            </div>
            <div className="flex gap-2">
              <Button size="sm" disabled={!!busy || data?.busy} onClick={() => void call("work", `/build/cases/${c.id}/work`)}>{data?.busy ? "keeper busy" : "Look again"}</Button>
              {c.status === "open" && <Button size="sm" variant="ghost" disabled={!!busy} onClick={() => void call("resolve", `/build/cases/${c.id}/resolve`)}>Mark resolved</Button>}
            </div>
          </div>
        )}
      </div>
    );
  };
  return (
    <Card className="mb-4" title="Build keeper" subtitle={`the agent that runs the build server: ${live.length} open case(s)${data?.busy ? " · working on one now" : ""} · it fixes what is the build server's, tells the repositories what is theirs, and answers them in their “Build server (mux)” issue`}
      actions={<Button size="sm" disabled={!!busy} onClick={() => void call("look", "/build/keeper/run")}>{busy === "look" ? "…" : "Look now"}</Button>}>
      {live.length ? live.map(row) : <Empty>Nothing needs attention: every runner is up and nothing is failing.</Empty>}
      {done.length > 0 && <details className="mt-2"><summary className="cursor-pointer text-[11.5px] text-ink-3">Recently closed ({done.length})</summary>{done.map(row)}</details>}
    </Card>
  );
}
