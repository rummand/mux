import { execFile } from "node:child_process";
import { existsSync, readdirSync, readFileSync, rmSync, statfsSync } from "node:fs";
import { dirname, join } from "node:path";
import type { FastifyInstance } from "fastify";
import { config } from "./config.js";
import { db, event, now } from "./db.js";
import { RANGES } from "./admin/stats.js";

/**
 * The build server: the GitHub Actions runners on this Mac, owned by mux (owner, 2026-11-25: "mux takes over all
 * responsibility for the build server"). A runner is a configured runner folder run by a LaunchAgent (localRunners);
 * new ones are made by deploy/build-runner.sh under ~/actions-runners/. Every minute mux asks GitHub (through `gh`,
 * logged in as the owner) for each runner's state and its repository's recent runs and jobs, keeps them in
 * build_runs/build_jobs and a per-minute busy sample in build_samples, and keeps the runners up: a runner whose
 * LaunchAgent is not running, or that GitHub has seen offline for 5 minutes while it runs, is started again (at most
 * every 10 minutes). The Services page's Build server tab shows it all, with the Mac's own load (system_samples) beside
 * it: builds share this Mac with the models.
 */
db.exec(`
CREATE TABLE IF NOT EXISTS build_runs (
  id INTEGER PRIMARY KEY, repo TEXT NOT NULL, workflow TEXT, title TEXT, event TEXT, branch TEXT, sha TEXT, status TEXT, conclusion TEXT,
  attempt INTEGER, actor TEXT, created_at INTEGER, started_at INTEGER, updated_at INTEGER, url TEXT
);
CREATE INDEX IF NOT EXISTS build_runs_created ON build_runs(created_at);
CREATE TABLE IF NOT EXISTS build_jobs (
  id INTEGER PRIMARY KEY, run_id INTEGER NOT NULL, repo TEXT NOT NULL, name TEXT, workflow TEXT, branch TEXT, status TEXT, conclusion TEXT,
  runner TEXT, labels TEXT, attempt INTEGER, created_at INTEGER, started_at INTEGER, completed_at INTEGER, steps TEXT, url TEXT
);
CREATE INDEX IF NOT EXISTS build_jobs_created ON build_jobs(created_at);
CREATE TABLE IF NOT EXISTS build_samples (ts INTEGER NOT NULL, runner TEXT NOT NULL, online INTEGER, busy INTEGER, running INTEGER, PRIMARY KEY (runner, ts));
`);

export const RUNNERS_DIR = process.env.MUX_RUNNERS_DIR ?? join(process.env.HOME ?? "", "actions-runners");
const AGENTS = process.env.MUX_LAUNCH_AGENTS ?? join(process.env.HOME ?? "", "Library/LaunchAgents");
const GH = process.env.MUX_GH_BIN ?? "/opt/homebrew/bin/gh";

interface Local { name: string; repo: string; dir: string; label: string; pid: number | null; lastExit: number | null; path: string | null; node: string | null }
interface Remote { id: number; status: string; busy: boolean; labels: string[]; os: string }
export const remote = new Map<string, Remote & { seen: number; offlineSince: number | null }>();
const restarted = new Map<string, number>();
const fetchedJobs = new Map<number, number>(); // run id → its updated_at when its jobs were last read
let lastPoll: { ts: number; ok: boolean; error: string | null; calls: number } = { ts: 0, ok: true, error: null, calls: 0 };

const sh = (cmd: string, args: string[], timeout = 30_000) => new Promise<string>((res, rej) =>
  execFile(cmd, args, { timeout, maxBuffer: 32 << 20, env: { ...process.env, PATH: `/opt/homebrew/bin:/usr/bin:/bin:${process.env.PATH ?? ""}` } }, (e, out, err) => (e ? rej(new Error((err || e.message).trim().slice(0, 300))) : res(out))));
let calls = 0;
const gh = async <T>(path: string): Promise<T> => { calls++; return JSON.parse(await sh(GH, ["api", "-H", "Accept: application/vnd.github+json", path])) as T; };
const ms = (s: string | null | undefined) => (s ? Date.parse(s) : null);

/**
 * The runners on this Mac: every LaunchAgent whose working folder holds a configured runner (a .runner file), however it
 * was installed: the runner's own svc.sh (actions.runner.*), Nexus's, Blip's and Record's own plists (com.*.ci-runner*),
 * or deploy/build-runner.sh. A configured folder under ~/actions-runners without a LaunchAgent is listed too, not running.
 */
export async function localRunners(): Promise<Local[]> {
  let list = "";
  try { list = await sh("/bin/launchctl", ["list"], 10_000); } catch { /* not macOS */ }
  const dirs = new Map<string, string | null>(); // folder → LaunchAgent label
  if (existsSync(AGENTS)) {
    for (const f of readdirSync(AGENTS).filter((f) => f.endsWith(".plist"))) {
      try {
        const p = JSON.parse(await sh("/usr/bin/plutil", ["-convert", "json", "-o", "-", join(AGENTS, f)], 5_000)) as { Label?: string; WorkingDirectory?: string; ProgramArguments?: string[] };
        const dir = p.WorkingDirectory ?? (p.ProgramArguments?.[0] ? dirname(p.ProgramArguments[0]) : null);
        if (p.Label && dir && existsSync(join(dir, ".runner"))) dirs.set(dir, p.Label);
      } catch { /* not a plist plutil reads */ }
    }
  }
  if (existsSync(RUNNERS_DIR)) for (const d of readdirSync(RUNNERS_DIR, { withFileTypes: true })) if (d.isDirectory() && !dirs.has(join(RUNNERS_DIR, d.name)) && existsSync(join(RUNNERS_DIR, d.name, ".runner"))) dirs.set(join(RUNNERS_DIR, d.name), null);
  const out: Local[] = [];
  for (const [dir, label] of dirs) {
    try {
      const r = JSON.parse(readFileSync(join(dir, ".runner"), "utf8").replace(/^﻿/, "")) as { agentName: string; gitHubUrl: string };
      const repo = r.gitHubUrl.replace(/^https:\/\/github\.com\//, "").replace(/\/$/, "");
      const line = label ? list.split("\n").find((l) => l.endsWith(`\t${label}`)) : undefined;
      const [pid, exit] = line ? line.split("\t") : [];
      const path = existsSync(join(dir, ".path")) ? readFileSync(join(dir, ".path"), "utf8").trim() : null;
      const node = path?.split(":").find((p) => existsSync(join(p, "node"))) ?? null;
      out.push({ name: r.agentName, repo, dir, label: label ?? "", pid: pid && pid !== "-" ? Number(pid) : null, lastExit: exit != null && exit !== "" ? Number(exit) : null, path, node: node ? join(node, "node") : null });
    } catch { /* a .runner we cannot read */ }
  }
  return out.sort((a, b) => a.repo.localeCompare(b.repo) || a.name.localeCompare(b.name));
}

interface GhRun { id: number; name: string; display_title: string; event: string; head_branch: string; head_sha: string; status: string; conclusion: string | null; run_attempt: number; actor?: { login: string }; created_at: string; run_started_at?: string; updated_at: string; html_url: string; path?: string }
interface GhJob { id: number; run_id: number; name: string; workflow_name?: string; head_branch?: string; status: string; conclusion: string | null; runner_name: string | null; labels: string[]; run_attempt?: number; created_at: string; started_at: string | null; completed_at: string | null; html_url: string; steps?: { name: string; number: number; conclusion: string | null; status: string; started_at: string | null; completed_at: string | null }[] }

const putRun = db.prepare(`INSERT OR REPLACE INTO build_runs(id, repo, workflow, title, event, branch, sha, status, conclusion, attempt, actor, created_at, started_at, updated_at, url) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
const putJob = db.prepare(`INSERT OR REPLACE INTO build_jobs(id, run_id, repo, name, workflow, branch, status, conclusion, runner, labels, attempt, created_at, started_at, completed_at, steps, url) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
const putSample = db.prepare("INSERT OR REPLACE INTO build_samples(ts, runner, online, busy, running) VALUES(?,?,?,?,?)");

/** The workflow's own name: a run's name may carry a run number and branch ("#40 · ci · main · push"). */
const workflowOf = (r: GhRun) => (r.path ? r.path.replace(/^\.github\/workflows\//, "").replace(/\.ya?ml(@.*)?$/, "") : r.name);

async function pollRepo(repo: string, first: boolean) {
  const runs = (await gh<{ workflow_runs: GhRun[] }>(`repos/${repo}/actions/runs?per_page=${first ? 100 : 30}`)).workflow_runs;
  for (const r of runs) {
    const updated = ms(r.updated_at) ?? 0;
    putRun.run(r.id, repo, workflowOf(r), r.display_title, r.event, r.head_branch, r.head_sha, r.status, r.conclusion, r.run_attempt, r.actor?.login ?? null, ms(r.created_at), ms(r.run_started_at), updated, r.html_url);
    // A run's jobs are read again only when the run changed (or is still going).
    if (fetchedJobs.get(r.id) === updated && r.status === "completed") continue;
    const have = db.prepare("SELECT COUNT(*) n FROM build_jobs WHERE run_id = ? AND status = 'completed'").get(r.id) as { n: number };
    if (r.status === "completed" && have.n > 0 && first) { fetchedJobs.set(r.id, updated); continue; }
    const jobs = (await gh<{ jobs: GhJob[] }>(`repos/${repo}/actions/runs/${r.id}/jobs?filter=all&per_page=100`)).jobs;
    for (const j of jobs) {
      putJob.run(j.id, r.id, repo, j.name, workflowOf(r), j.head_branch ?? r.head_branch, j.status, j.conclusion, j.runner_name, JSON.stringify(j.labels ?? []), j.run_attempt ?? r.run_attempt,
        ms(j.created_at), ms(j.started_at), ms(j.completed_at),
        JSON.stringify((j.steps ?? []).map((s) => ({ n: s.number, name: s.name, conclusion: s.conclusion, status: s.status, start: ms(s.started_at), end: ms(s.completed_at) }))), j.html_url);
    }
    fetchedJobs.set(r.id, updated);
  }
}

const afterPoll: (() => Promise<void>)[] = [];
/** Run after every look at GitHub (the build keeper looks for problems then). */
export const onPolled = (f: () => Promise<void>) => { afterPoll.push(f); };
const polledOnce = new Set<string>();
let polling: Promise<void> | null = null;
/** One look at every runner and its repository; keeps the runners up. The first look reads 100 runs a repository. */
export function pollBuild(): Promise<void> {
  polling ??= poll().then(async () => { for (const f of afterPoll) await f().catch((e) => event("warn", "build", `after the poll: ${(e as Error).message}`)); }).finally(() => { polling = null; });
  return polling;
}

async function poll() {
  const locals = await localRunners();
  if (!locals.length) return;
  calls = 0;
  const t = now();
  try {
    for (const repo of [...new Set(locals.map((l) => l.repo))]) {
      const rs = (await gh<{ runners: (Omit<Remote, "labels"> & { name: string; labels: { name: string }[] })[] }>(`repos/${repo}/actions/runners`)).runners;
      for (const r of rs) {
        const prev = remote.get(r.name);
        remote.set(r.name, { id: r.id, status: r.status, busy: r.busy, labels: r.labels.map((l) => l.name), os: r.os, seen: t, offlineSince: r.status === "online" ? null : prev?.offlineSince ?? t });
      }
      await pollRepo(repo, !polledOnce.has(repo));
      polledOnce.add(repo);
    }
    lastPoll = { ts: t, ok: true, error: null, calls };
  } catch (e) {
    lastPoll = { ts: t, ok: false, error: (e as Error).message, calls };
  }
  const bucket = Math.floor(t / 60_000) * 60_000;
  for (const l of locals) {
    const r = remote.get(l.name);
    putSample.run(bucket, l.name, r ? (r.status === "online" ? 1 : 0) : null, r ? (r.busy ? 1 : 0) : null, l.pid ? 1 : 0);
    // Keep it up: its LaunchAgent stopped, or GitHub has not seen it for 5 minutes although it runs.
    const down = !l.pid || (r && r.offlineSince != null && t - r.offlineSince > 5 * 60_000);
    if (down && t - (restarted.get(l.name) ?? 0) > 10 * 60_000) {
      restarted.set(l.name, t);
      await restartRunner(l, !l.pid ? "its LaunchAgent was not running" : "GitHub saw it offline for 5 minutes");
    }
  }
}

async function restartRunner(l: Local, why: string) {
  if (!l.label) { event("warn", "build", `runner ${l.name} (${l.repo}) has no LaunchAgent: install it with deploy/build-runner.sh`); return; }
  try {
    await sh("/bin/launchctl", ["kickstart", "-k", `gui/${process.getuid?.() ?? 501}/${l.label}`], 20_000);
    event("warn", "build", `restarted runner ${l.name} (${l.repo}): ${why}`);
  } catch (e) {
    event("error", "build", `could not restart runner ${l.name} (${l.repo}): ${why}; ${(e as Error).message}`);
  }
}

export function startBuild() {
  if (config.role === "gateway" || process.env.MUX_NO_BUILD) return;
  void pollBuild();
  setInterval(() => void pollBuild(), 60_000).unref();
  setInterval(() => db.prepare("DELETE FROM build_samples WHERE ts < ?").run(now() - 90 * 86400_000), 3600_000).unref();
}

// ── What the Build server tab shows ─────────────────────────────────────────────────────────────────────────────────
type Step = { n: number; name: string; conclusion: string | null; status: string; start: number | null; end: number | null };
export type JobRow = { id: number; run_id: number; repo: string; name: string; workflow: string; branch: string; status: string; conclusion: string | null; runner: string | null; labels: string; attempt: number; created_at: number; started_at: number | null; completed_at: number | null; steps: string; url: string };
const pct = (xs: number[], p: number) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
export const parse = <T>(s: string | null): T[] => { try { return s ? (JSON.parse(s) as T[]) : []; } catch { return []; } };
const ok = (c: string | null) => c === "success";
export const failed = (c: string | null) => c === "failure" || c === "timed_out" || c === "startup_failure";

export async function buildView(range: string) {
  const R = RANGES[range] ?? RANGES["24h"];
  const t = now(), since = t - R.ms, bucket = R.bucket;
  const locals = await localRunners();
  const mine = new Set(locals.map((l) => l.name));
  const jobs = (db.prepare("SELECT * FROM build_jobs WHERE created_at >= ? ORDER BY created_at DESC").all(since) as JobRow[]).map((j) => ({ ...j, stepsList: parse<Step>(j.steps), labelList: parse<string>(j.labels) }));
  const runs = db.prepare("SELECT * FROM build_runs WHERE created_at >= ? ORDER BY created_at DESC").all(since) as { id: number; repo: string; workflow: string; title: string; event: string; branch: string; sha: string; status: string; conclusion: string | null; attempt: number; actor: string; created_at: number; started_at: number | null; updated_at: number; url: string }[];
  // Finished jobs a runner ran: a job skipped or cancelled before any runner took it has no time of its own.
  const done = jobs.filter((j) => j.status === "completed" && j.runner && j.started_at && j.completed_at && j.conclusion !== "skipped");
  const here = done.filter((j) => j.runner && mine.has(j.runner));
  const dur = (j: { started_at: number | null; completed_at: number | null }) => (j.completed_at! - j.started_at!);
  const queue = (j: { created_at: number; started_at: number | null }) => Math.max(0, j.started_at! - j.created_at);
  const samples = db.prepare("SELECT ts, runner, online, busy, running FROM build_samples WHERE ts >= ? ORDER BY ts").all(since) as { ts: number; runner: string; online: number | null; busy: number | null; running: number }[];
  const sys = db.prepare("SELECT ts, cpu_pct, mem_used_gb, swap_gb FROM system_samples WHERE ts >= ? ORDER BY ts").all(since) as { ts: number; cpu_pct: number | null; mem_used_gb: number | null; swap_gb: number | null }[];

  // Per bucket: jobs on this Mac finished (passed / failed / other), runners busy, and the Mac's load.
  const series = new Map<number, { t: number; passed: number; failed: number; other: number; busyMin: number; samples: number; cpu: number[]; mem: number[]; swap: number[] }>();
  const at = (ts: number) => { const k = Math.floor(ts / bucket) * bucket; let b = series.get(k); if (!b) series.set(k, (b = { t: k, passed: 0, failed: 0, other: 0, busyMin: 0, samples: 0, cpu: [], mem: [], swap: [] })); return b; };
  for (let k = Math.floor(since / bucket) * bucket; k <= t; k += bucket) at(k);
  for (const j of here) { const b = at(j.completed_at!); if (ok(j.conclusion)) b.passed++; else if (failed(j.conclusion)) b.failed++; else b.other++; }
  for (const s of samples) { const b = at(s.ts); b.samples++; if (s.busy) b.busyMin++; }
  for (const s of sys) { const b = at(s.ts); if (s.cpu_pct != null) b.cpu.push(s.cpu_pct); if (s.mem_used_gb != null) b.mem.push(s.mem_used_gb); if (s.swap_gb != null) b.swap.push(s.swap_gb); }
  const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

  // The Mac while a build runs, and while none does: what builds cost the models.
  const busyAt = new Set(samples.filter((s) => s.busy).map((s) => s.ts));
  const load = { building: { cpu: [] as number[], swap: [] as number[] }, idle: { cpu: [] as number[], swap: [] as number[] } };
  for (const s of sys) { const side = busyAt.has(Math.floor(s.ts / 60_000) * 60_000) ? load.building : load.idle; if (s.cpu_pct != null) side.cpu.push(s.cpu_pct); if (s.swap_gb != null) side.swap.push(s.swap_gb); }

  // By workflow and job: how often, how long, how often it fails, and its trend.
  const byJob = new Map<string, typeof done>();
  for (const j of done) { const k = `${j.repo}\u0000${j.workflow}\u0000${j.name}`; byJob.set(k, [...(byJob.get(k) ?? []), j]); }
  const jobsSummary = [...byJob].map(([k, js]) => {
    const [repo, workflow, name] = k.split("\u0000");
    const ds = js.map(dur);
    return { repo, workflow, name, here: js.some((j) => j.runner && mine.has(j.runner)), runs: js.length, passed: js.filter((j) => ok(j.conclusion)).length, failed: js.filter((j) => failed(j.conclusion)).length,
      p50: pct(ds, 0.5), p95: pct(ds, 0.95), queueP50: pct(js.map(queue), 0.5), last: js[0].conclusion, lastAt: js[0].completed_at,
      trend: js.slice(0, 20).reverse().map((j) => ({ ms: dur(j), ok: ok(j.conclusion) })) };
  }).sort((a, b) => b.runs - a.runs);

  // Steps on this Mac: where the minutes go, and which step fails.
  const steps = new Map<string, { repo: string; job: string; name: string; n: number; total: number; times: number[]; failed: number }>();
  for (const j of here) for (const s of j.stepsList) {
    if (!s.start || !s.end || s.conclusion === "skipped") continue;
    const k = `${j.repo}\u0000${j.name}\u0000${s.name}`;
    const e = steps.get(k) ?? { repo: j.repo, job: j.name, name: s.name, n: 0, total: 0, times: [], failed: 0 };
    e.n++; e.total += s.end - s.start; e.times.push(s.end - s.start); if (failed(s.conclusion)) e.failed++;
    steps.set(k, e);
  }
  const stepRows = [...steps.values()].map((s) => ({ repo: s.repo, job: s.job, name: s.name, n: s.n, avgMs: s.total / s.n, p95: pct(s.times, 0.95), totalMs: s.total, failed: s.failed }));

  // Flaky: the same commit and job both failed and passed.
  const runById = new Map(runs.map((r) => [r.id, r]));
  const bySha = new Map<string, Set<string>>();
  for (const j of done) { const run = runById.get(j.run_id); if (!run) continue; const k = `${j.repo}\u0000${run.sha}\u0000${j.name}`; bySha.set(k, (bySha.get(k) ?? new Set()).add(ok(j.conclusion) ? "ok" : failed(j.conclusion) ? "bad" : "other")); }
  const flaky = [...bySha].filter(([, s]) => s.has("ok") && s.has("bad")).map(([k]) => { const [repo, , name] = k.split("\u0000"); return `${repo.split("/")[1]} · ${name}`; });

  const busySamples = samples.filter((s) => s.busy != null);
  const runnersOut = locals.map((l) => {
    const r = remote.get(l.name);
    const mineS = busySamples.filter((s) => s.runner === l.name);
    const current = jobs.find((j) => j.runner === l.name && j.status === "in_progress");
    const last = here.find((j) => j.runner === l.name);
    return { name: l.name, repo: l.repo, dir: l.dir, label: l.label, pid: l.pid, lastExit: l.lastExit, node: l.node, status: r?.status ?? "unknown", busy: r?.busy ?? false, labels: r?.labels ?? [], seen: r?.seen ?? null,
      utilisation: mineS.length ? mineS.filter((s) => s.busy).length / mineS.length : null, uptime: mineS.length ? mineS.filter((s) => s.online).length / mineS.length : null,
      jobs: here.filter((j) => j.runner === l.name).length, restartedAt: restarted.get(l.name) ?? null,
      last: last ? { name: last.name, conclusion: last.conclusion, at: last.completed_at, url: last.url } : null,
      current: current ? { id: current.id, name: current.name, workflow: current.workflow, branch: current.branch, started: current.started_at, url: current.url, steps: current.stepsList } : null,
      availability: samples.filter((s) => s.runner === l.name).slice(-24 * 60).map((s) => ({ t: s.ts, state: !s.running ? "stopped" : s.online === 0 ? "offline" : s.busy ? "busy" : "idle" })) };
  });

  const repos = [...new Set(locals.map((l) => l.repo))].map((repo) => {
    const js = here.filter((j) => j.repo === repo);
    return { repo, runners: locals.filter((l) => l.repo === repo).length, jobs: js.length, passed: js.filter((j) => ok(j.conclusion)).length, failed: js.filter((j) => failed(j.conclusion)).length,
      minutes: js.reduce((a, j) => a + dur(j), 0) / 60_000, p50: pct(js.map(dur), 0.5), lastAt: js[0]?.completed_at ?? null, last: js[0]?.conclusion ?? null };
  });
  const queued = jobs.filter((j) => j.status === "queued" || j.status === "waiting" || j.status === "pending");
  return {
    range, bucket, poll: lastPoll, dir: RUNNERS_DIR,
    runners: runnersOut, repos,
    kpis: {
      jobs: here.length, passed: here.filter((j) => ok(j.conclusion)).length, failed: here.filter((j) => failed(j.conclusion)).length,
      successRate: here.length ? here.filter((j) => ok(j.conclusion)).length / here.length : null, hostedJobs: done.length - here.length,
      durP50: pct(here.map(dur), 0.5), durP95: pct(here.map(dur), 0.95), queueP50: pct(here.map(queue), 0.5), queueP95: pct(here.map(queue), 0.95),
      buildMinutes: here.reduce((a, j) => a + dur(j), 0) / 60_000, queuedNow: queued.length, runs: runs.length,
      utilisation: busySamples.length ? busySamples.filter((s) => s.busy).length / busySamples.length : null,
    },
    series: [...series.values()].sort((a, b) => a.t - b.t).map((b) => ({ t: b.t, passed: b.passed, failed: b.failed, other: b.other, busy: b.samples ? b.busyMin / b.samples : null, cpu: avg(b.cpu), mem: avg(b.mem), swap: avg(b.swap) })),
    load: { building: { cpu: avg(load.building.cpu), swap: avg(load.building.swap), samples: load.building.cpu.length }, idle: { cpu: avg(load.idle.cpu), swap: avg(load.idle.swap), samples: load.idle.cpu.length } },
    jobs: jobsSummary,
    steps: { slowest: [...stepRows].sort((a, b) => b.totalMs - a.totalMs).slice(0, 12), failing: stepRows.filter((s) => s.failed).sort((a, b) => b.failed - a.failed).slice(0, 8) },
    flaky: [...new Set(flaky)],
    timeline: jobs.filter((j) => j.started_at && j.runner && mine.has(j.runner)).slice(0, 400).map((j) => ({ id: j.id, name: j.name, workflow: j.workflow, repo: j.repo, runner: j.runner, created: j.created_at, start: j.started_at, end: j.completed_at, status: j.status, conclusion: j.conclusion, url: j.url })),
    queued: queued.map((j) => ({ id: j.id, name: j.name, workflow: j.workflow, repo: j.repo, branch: j.branch, created: j.created_at, labels: j.labelList, url: j.url })),
    failures: here.filter((j) => failed(j.conclusion)).slice(0, 15).map((j) => {
      const step = j.stepsList.find((s) => failed(s.conclusion));
      return { id: j.id, name: j.name, workflow: j.workflow, repo: j.repo, branch: j.branch, at: j.completed_at, step: step?.name ?? null, runner: j.runner, attempt: j.attempt, url: j.url };
    }),
    recent: runs.slice(0, 40).map((r) => {
      const js = jobs.filter((j) => j.run_id === r.id);
      const start = Math.min(...js.map((j) => j.started_at ?? Infinity)), end = Math.max(...js.map((j) => j.completed_at ?? 0));
      return { id: r.id, repo: r.repo, workflow: r.workflow, title: r.title, event: r.event, branch: r.branch, sha: r.sha?.slice(0, 7), status: r.status, conclusion: r.conclusion, attempt: r.attempt, actor: r.actor, created: r.created_at, url: r.url,
        durationMs: Number.isFinite(start) && end > start ? end - start : null, here: js.some((j) => j.runner && mine.has(j.runner)), jobs: js.map((j) => ({ name: j.name, conclusion: j.conclusion, status: j.status })) };
    }),
  };
}

// ── What the runners have to work with, and what can be done to them ──────────────────────────────────────────────
/** Bytes a folder holds (du), or null. */
const duBytes = async (dir: string) => { try { return Number((await sh("/usr/bin/du", ["-sk", dir], 120_000)).split("\t")[0]) * 1024; } catch { return null; } };
let resCache: { at: number; value: Awaited<ReturnType<typeof readResources>> } | null = null;

async function readResources() {
  const fs = statfsSync(process.env.HOME ?? "/");
  const locals = await localRunners();
  const runners = await Promise.all(locals.map(async (l) => {
    let plist: Record<string, unknown> = {};
    if (l.label) try { plist = JSON.parse(await sh("/usr/bin/plutil", ["-convert", "json", "-o", "-", join(AGENTS, `${l.label}.plist`)], 5_000)); } catch { /* not a file of that name */ }
    let node: string | null = null;
    if (l.node) try { node = (await sh(l.node, ["-v"], 5_000)).trim(); } catch { /* none */ }
    return { name: l.name, repo: l.repo, workBytes: await duBytes(join(l.dir, "_work")), node,
      keepAlive: plist.KeepAlive != null && plist.KeepAlive !== false, background: plist.ProcessType === "Background", nice: typeof plist.Nice === "number" ? plist.Nice : null };
  }));
  const sys = db.prepare("SELECT mem_used_gb, mem_total_gb, swap_gb, cpu_pct, disk_free_gb FROM system_samples ORDER BY ts DESC LIMIT 1").get() as Record<string, number | null> | undefined;
  let xcode: string | null = null;
  try { xcode = (await sh("/usr/bin/xcodebuild", ["-version"], 15_000)).split("\n")[0]; } catch { /* no Xcode */ }
  return { diskFreeGb: (fs.bavail * fs.bsize) / 1e9, diskTotalGb: (fs.blocks * fs.bsize) / 1e9, memUsedGb: sys?.mem_used_gb ?? null, memTotalGb: sys?.mem_total_gb ?? null, swapGb: sys?.swap_gb ?? null, cpuPct: sys?.cpu_pct ?? null, xcode, runners };
}

/** Disk, memory, toolchains and each runner's work folder and launchd settings (work folder sizes kept 10 minutes). */
export async function resources(fresh = false) {
  if (!fresh && resCache && Date.now() - resCache.at < 10 * 60_000) return resCache.value;
  resCache = { at: Date.now(), value: await readResources() };
  return resCache.value;
}

/** Empty an idle runner's work folder (checkouts, temp files, downloaded actions); its tool cache (_tool) is kept. */
export async function cleanRunner(name: string): Promise<{ freedBytes: number; removed: string[] }> {
  const l = (await localRunners()).find((x) => x.name === name);
  if (!l) throw Object.assign(new Error("no such runner on this Mac"), { status: 404 });
  if (remote.get(name)?.busy) throw Object.assign(new Error(`${name} is running a job: clean it when it is idle`), { status: 409 });
  const work = join(l.dir, "_work");
  const before = (await duBytes(work)) ?? 0;
  const removed: string[] = [];
  if (existsSync(work)) for (const e of readdirSync(work)) if (e !== "_tool") { rmSync(join(work, e), { recursive: true, force: true }); removed.push(e); }
  const freedBytes = before - ((await duBytes(work)) ?? 0);
  resCache = null;
  event("info", "build", `cleaned ${name}'s work folder: ${(freedBytes / 1e9).toFixed(1)} GB freed`);
  return { freedBytes, removed };
}

/**
 * Give a runner's LaunchAgent what every runner here should have (Nexus's settings): launchd restarts it if it stops
 * (KeepAlive), and it runs at background priority (ProcessType Background, Nice 10, LowPriorityIO), so the models keep
 * the Mac's attention. Reloads it, so only while it is idle.
 */
export async function hardenRunner(name: string): Promise<{ changed: string[] }> {
  const l = (await localRunners()).find((x) => x.name === name);
  if (!l?.label) throw Object.assign(new Error(l ? `${name} has no LaunchAgent` : "no such runner on this Mac"), { status: 404 });
  if (remote.get(name)?.busy) throw Object.assign(new Error(`${name} is running a job: harden it when it is idle`), { status: 409 });
  const plist = join(AGENTS, `${l.label}.plist`);
  const want: [string, string, string][] = [["KeepAlive", "bool", "true"], ["ProcessType", "string", "Background"], ["Nice", "integer", "10"], ["LowPriorityIO", "bool", "true"]];
  const cur = JSON.parse(await sh("/usr/bin/plutil", ["-convert", "json", "-o", "-", plist], 5_000)) as Record<string, unknown>;
  const changed: string[] = [];
  for (const [k, type, v] of want) {
    if (String(cur[k]) === v) continue;
    await sh("/usr/libexec/PlistBuddy", ["-c", `Delete :${k}`, plist]).catch(() => undefined);
    await sh("/usr/libexec/PlistBuddy", ["-c", `Add :${k} ${type} ${v}`, plist]);
    changed.push(`${k}=${v}`);
  }
  if (changed.length) {
    const uid = process.getuid?.() ?? 501;
    await sh("/bin/launchctl", ["bootout", `gui/${uid}/${l.label}`], 30_000).catch(() => undefined);
    await sh("/bin/launchctl", ["bootstrap", `gui/${uid}`, plist], 30_000);
    resCache = null;
    event("info", "build", `hardened runner ${name}: ${changed.join(", ")}`);
  }
  return { changed };
}

const jobRow = (id: number) => db.prepare("SELECT * FROM build_jobs WHERE id = ?").get(id) as JobRow | undefined;

/** A job's log from GitHub, timestamps cut; with grep only matching lines (and 2 around), else the last `lines`. */
export async function jobLog(id: number, o: { grep?: string; lines?: number } = {}) {
  const j = jobRow(id);
  if (!j) throw Object.assign(new Error("no such job in mux's build data"), { status: 404 });
  calls++;
  // Logs carry terminal colours: gh refuses to print them unless told, and they are cut here.
  const raw = await sh(GH, ["api", "--allow-escape-sequences", `repos/${j.repo}/actions/jobs/${id}/logs`], 60_000);
  const lines = raw.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").split("\n").map((l) => l.replace(/^\uFEFF?\d{4}-\d\d-\d\dT[\d:.]+Z /, ""));
  let out: string[];
  if (o.grep) {
    const re = new RegExp(o.grep, "i"), keep = new Set<number>();
    lines.forEach((l, i) => { if (re.test(l)) for (let k = i - 2; k <= i + 2; k++) keep.add(k); });
    out = [...keep].filter((i) => i >= 0 && i < lines.length).sort((a, b) => a - b).map((i) => lines[i]);
  } else out = lines.slice(-(o.lines ?? 200));
  return { job: { id, repo: j.repo, name: j.name, workflow: j.workflow, branch: j.branch, conclusion: j.conclusion, runner: j.runner, url: j.url }, lines: lines.length, log: out.join("\n").slice(-24_000) };
}

/** Run a failed job again (GitHub re-runs it with the same commit). */
export async function rerunJob(id: number) {
  const j = jobRow(id);
  if (!j) throw Object.assign(new Error("no such job in mux's build data"), { status: 404 });
  calls++;
  await sh(GH, ["api", "-X", "POST", `repos/${j.repo}/actions/jobs/${id}/rerun`], 30_000);
  event("info", "build", `asked GitHub to re-run ${j.repo} ${j.workflow}/${j.name} (job ${id})`);
  return { ok: true, url: j.url };
}

/**
 * Where a repository talks with its build server: one open issue per repository titled THREAD, opened by mux when it
 * first has something to say. The repository (people, and agents working in it) writes there; mux reads new comments
 * every few minutes and answers (buildKeeper.ts).
 */
export const THREAD = "Build server (mux)";
const SIGN = "\n\n— mux build server (automated; reply here, mux reads this thread)";

export async function threadOf(repo: string, create: boolean): Promise<{ number: number; url: string } | null> {
  const found = (await gh<{ number: number; title: string; html_url: string; pull_request?: unknown }[]>(`repos/${repo}/issues?state=open&creator=@me&per_page=50`)).find((i) => i.title === THREAD && !i.pull_request);
  if (found || !create) return found ? { number: found.number, url: found.html_url } : null;
  calls++;
  const body = `mux runs this repository's self-hosted GitHub Actions runners on the Mac Studio. It keeps them up, looks into every failed job on them, and writes here what it found and did.\n\nWrite here to ask it something (a re-run, why a job waits, a tool the runner lacks); it answers within a few minutes.${SIGN}`;
  const r = JSON.parse(await sh(GH, ["api", "-X", "POST", `repos/${repo}/issues`, "-f", `title=${THREAD}`, "-f", `body=${body}`], 30_000)) as { number: number; html_url: string };
  event("info", "build", `opened the build server thread in ${repo}: ${r.html_url}`);
  return { number: r.number, url: r.html_url };
}

/**
 * Say something to a repository: in its build server thread, or about a job (on the job's pull request if it has one,
 * else on its commit). With `comment`, that comment (one mux wrote) is edited instead of adding another.
 */
export async function say(o: { repo: string; body: string; job?: number; comment?: string }) {
  const text = o.body.trim().slice(0, 60_000) + SIGN;
  calls++;
  if (o.comment) {
    const kind = o.comment.includes("/comments/") ? o.comment : null;
    if (!kind) throw Object.assign(new Error("comment must be the API url of a comment mux wrote"), { status: 400 });
    const r = JSON.parse(await sh(GH, ["api", "-X", "PATCH", o.comment.replace("https://api.github.com/", ""), "-f", `body=${text}`], 30_000)) as { html_url: string; url: string };
    return { url: r.html_url, comment: r.url };
  }
  let path: string;
  if (o.job != null) {
    const j = jobRow(o.job);
    if (!j) throw Object.assign(new Error("no such job in mux's build data"), { status: 404 });
    const run = db.prepare("SELECT sha, branch FROM build_runs WHERE id = ?").get(j.run_id) as { sha: string; branch: string } | undefined;
    const prs = run ? await gh<{ number: number }[]>(`repos/${j.repo}/commits/${run.sha}/pulls`).catch(() => []) : [];
    path = prs[0] ? `repos/${j.repo}/issues/${prs[0].number}/comments` : `repos/${j.repo}/commits/${run?.sha}/comments`;
  } else {
    const t = await threadOf(o.repo, true);
    path = `repos/${o.repo}/issues/${t!.number}/comments`;
  }
  const r = JSON.parse(await sh(GH, ["api", "-X", "POST", path, "-f", `body=${text}`], 30_000)) as { html_url: string; url: string };
  event("info", "build", `wrote to ${o.repo}: ${r.html_url}`);
  return { url: r.html_url, comment: r.url };
}

export { gh, calls as ghCalls };

export function registerBuild(api: FastifyInstance) {
  api.get("/build", async (req) => buildView((req.query as { range?: string }).range ?? "24h"));
  api.post("/build/refresh", async () => { await pollBuild(); return { ok: lastPoll.ok, poll: lastPoll }; });
  const fail = (reply: { code: (n: number) => { send: (b: unknown) => unknown } }, e: unknown) => reply.code((e as { status?: number }).status ?? 502).send({ error: (e as Error).message });
  api.get("/build/resources", async (req) => resources((req.query as { fresh?: string }).fresh === "1"));
  api.get("/build/jobs/:id/log", async (req, reply) => { const q = req.query as { grep?: string; lines?: string }; try { return await jobLog(Number((req.params as { id: string }).id), { grep: q.grep, lines: q.lines ? Number(q.lines) : undefined }); } catch (e) { return fail(reply, e); } });
  api.post("/build/jobs/:id/rerun", async (req, reply) => { try { return await rerunJob(Number((req.params as { id: string }).id)); } catch (e) { return fail(reply, e); } });
  api.post("/build/runners/:name/harden", async (req, reply) => { try { return await hardenRunner((req.params as { name: string }).name); } catch (e) { return fail(reply, e); } });
  api.post("/build/runners/:name/clean", async (req, reply) => { try { return await cleanRunner((req.params as { name: string }).name); } catch (e) { return fail(reply, e); } });
  api.post("/build/say", async (req, reply) => { try { return await say(req.body as { repo: string; body: string; job?: number; comment?: string }); } catch (e) { return fail(reply, e); } });
  api.post("/build/runners/:name/restart", async (req, reply) => {
    const l = (await localRunners()).find((x) => x.name === (req.params as { name: string }).name);
    if (!l) return reply.code(404).send({ error: "no such runner on this Mac" });
    restarted.set(l.name, now());
    await restartRunner(l, "restarted from the dashboard");
    return { ok: true };
  });
}
