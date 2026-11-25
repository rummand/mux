import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { API_REFERENCE, converse, isChange, parse as parseArgs, runTool, snapshot, type Call, type Msg } from "./assistant.js";
import { recall } from "./brain.js";
import { cleanRunner, failed, gh, hardenRunner, localRunners, onPolled, parse, remote, resources, THREAD, threadOf, type JobRow } from "./build.js";
import { config } from "./config.js";
import { db, event, now, settings } from "./db.js";
import { asActor, journal } from "./journal.js";

/**
 * The build keeper: the agent that runs the build server (owner, 2026-11-25: "it's your task to secure that the build
 * server is running all time … keep it alive 24-7 and secure it has the right resources … You're taking over all issues
 * and commands for the build service. Failed builds and everything like that … communicate back and forth with the
 * repos"). After every look at GitHub (build.ts, each minute) it:
 *
 * - applies rules that need no model: a runner whose LaunchAgent lacks KeepAlive or background priority is hardened
 *   (when idle); when the disk has under 20 GB free, idle runners' work folders are emptied, largest first;
 * - opens a case for each problem, one per problem, with every new piece of evidence added to it: a job failing on this
 *   Mac (per job and failing step), a runner still down after build.ts restarted it, a job waiting over 20 minutes for a
 *   runner, the disk under 30 GB, and each message written in a repository's "Build server (mux)" issue;
 * - hands open cases, one at a time, to an agent: the assistant run headless with mux's tools and brain, like the
 *   healer's doctor. It reads the job's log, finds the cause, fixes what is the build server's (restart, clean, harden,
 *   one re-run of a job that failed for the server's reasons), tells the repository what is the repository's (on the
 *   job's pull request or commit, or in its thread), answers messages, and writes runbooks into the brain. Any other
 *   change is kept as a proposal for the owner. Cases close themselves when the problem is gone.
 */
db.exec(`
CREATE TABLE IF NOT EXISTS build_cases (
  id TEXT PRIMARY KEY, ts INTEGER NOT NULL, updated_at INTEGER NOT NULL, kind TEXT NOT NULL, repo TEXT, subject TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open', title TEXT NOT NULL, detail TEXT, evidence TEXT DEFAULT '[]', actions TEXT DEFAULT '[]',
  report TEXT, said TEXT DEFAULT '[]', looked_at INTEGER, looks INTEGER DEFAULT 0, fresh INTEGER DEFAULT 1, resolved_at INTEGER
);
CREATE INDEX IF NOT EXISTS build_cases_open ON build_cases(status, kind, subject);
CREATE TABLE IF NOT EXISTS build_state (key TEXT PRIMARY KEY, value TEXT);
`);

type Kind = "failed" | "runner" | "queue" | "disk" | "message";
interface Action { ts: number; by: "rules" | "agent" | "user"; action: string; ok: boolean; detail?: string; proposal?: Call }
export interface Case {
  id: string; ts: number; updated_at: number; kind: Kind; repo: string | null; subject: string; status: "open" | "resolved"; title: string; detail: string | null;
  evidence: (string | number)[]; actions: Action[]; report: string | null; said: { url: string; comment: string; job?: number }[]; looked_at: number | null; looks: number; fresh: boolean; resolved_at: number | null;
}
type Row = Omit<Case, "evidence" | "actions" | "said" | "fresh"> & { evidence: string; actions: string; said: string; fresh: number };
const fromRow = (r: Row): Case => ({ ...r, evidence: parse(r.evidence), actions: parse(r.actions), said: parse(r.said), fresh: !!r.fresh });
export const getCase = (id: string) => { const r = db.prepare("SELECT * FROM build_cases WHERE id = ?").get(id) as Row | undefined; return r && fromRow(r); };
const findOpen = (kind: Kind, subject: string) => { const r = db.prepare("SELECT * FROM build_cases WHERE status = 'open' AND kind = ? AND subject = ?").get(kind, subject) as Row | undefined; return r && fromRow(r); };
const save = (c: Case) => db.prepare("UPDATE build_cases SET updated_at = ?, status = ?, title = ?, detail = ?, evidence = ?, actions = ?, report = ?, said = ?, looked_at = ?, looks = ?, fresh = ?, resolved_at = ? WHERE id = ?")
  .run(now(), c.status, c.title, c.detail, JSON.stringify(c.evidence.slice(-50)), JSON.stringify(c.actions.slice(-60)), c.report, JSON.stringify(c.said), c.looked_at, c.looks, c.fresh ? 1 : 0, c.resolved_at, c.id);
const state = (k: string) => (db.prepare("SELECT value FROM build_state WHERE key = ?").get(k) as { value: string } | undefined)?.value;
const setState = (k: string, v: string) => db.prepare("INSERT OR REPLACE INTO build_state(key, value) VALUES(?, ?)").run(k, v);

/** Open a case, or add new evidence to the open one; new evidence asks for another look. */
function open(kind: Kind, subject: string, repo: string | null, title: string, detail: string, evidence?: string | number): Case {
  const c = findOpen(kind, subject);
  if (c) {
    const isNew = evidence != null && !c.evidence.includes(evidence);
    if (isNew) c.evidence.push(evidence!);
    save({ ...c, title, detail, fresh: c.fresh || isNew });
    return getCase(c.id)!;
  }
  const id = `bc_${randomBytes(6).toString("hex")}`;
  db.prepare("INSERT INTO build_cases(id, ts, updated_at, kind, repo, subject, title, detail, evidence) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run(id, now(), now(), kind, repo, subject, title, detail, JSON.stringify(evidence != null ? [evidence] : []));
  event("warn", "build", title, { case: id });
  return getCase(id)!;
}
function close(kind: Kind, subject: string, note: string) {
  const c = findOpen(kind, subject);
  if (!c) return;
  c.status = "resolved"; c.resolved_at = now(); c.fresh = false;
  c.actions.push({ ts: now(), by: "rules", action: note, ok: true });
  save(c);
}
function act(c: Case, by: Action["by"], action: string, ok: boolean, detail?: string, extra: Partial<Action> = {}) {
  const fresh = getCase(c.id) ?? c;
  fresh.actions.push({ ts: now(), by, action, ok, ...(detail ? { detail: detail.slice(0, 2000) } : {}), ...extra });
  save(fresh);
  if (by !== "user") journal({ who: "build-keeper", kind: "build", ref: c.id, title: `Build keeper: ${action}${ok ? "" : " (failed)"}`, detail: `${c.title}${detail ? `\n${detail.slice(0, 600)}` : ""}` });
  return fresh;
}

// ── Looking for problems ────────────────────────────────────────────────────────────────────────────────────────────
const key = (j: { workflow: string; name: string }) => `${j.workflow}/${j.name}`;
const hardenTried = new Map<string, number>();

async function look() {
  const locals = await localRunners();
  const mine = new Set(locals.map((l) => l.name));
  const t = now();

  // Failed jobs on this Mac since the last look (on the very first look: the last 3 hours).
  const since = Number(state("failedSince") ?? t - 3 * 3600_000);
  const jobs = db.prepare("SELECT * FROM build_jobs WHERE completed_at > ? ORDER BY completed_at").all(since) as JobRow[];
  for (const j of jobs) {
    if (!j.runner || !mine.has(j.runner)) continue;
    const subject = `${j.repo} ${key(j)}`;
    if (failed(j.conclusion)) {
      const step = parse<{ name: string; conclusion: string | null }>(j.steps).find((s) => failed(s.conclusion))?.name ?? "(no step)";
      open("failed", subject, j.repo, `${j.repo.split("/")[1]} · ${key(j)} failed at “${step}”`, `job ${j.id} on ${j.runner}, branch ${j.branch}, attempt ${j.attempt}: ${j.url}`, j.id);
    } else if (j.conclusion === "success") close("failed", subject, `passed again: job ${j.id} on ${j.branch}`);
  }
  if (jobs.length) setState("failedSince", String(Math.max(...jobs.map((j) => j.completed_at ?? 0))));
  else if (!state("failedSince")) setState("failedSince", String(since));

  // Runners still down after build.ts restarted them (it restarts within a minute or two).
  for (const l of locals) {
    const r = remote.get(l.name);
    const down = !l.pid || (r && r.offlineSince != null && t - r.offlineSince > 15 * 60_000);
    if (down) open("runner", l.name, l.repo, `runner ${l.name} (${l.repo}) is ${!l.pid ? "not running" : "offline on GitHub"}`, `LaunchAgent ${l.label || "(none)"}, pid ${l.pid ?? "none"}, last exit ${l.lastExit ?? "?"}, GitHub ${r?.status ?? "unknown"}`, Math.floor(t / 3600_000));
    else close("runner", l.name, "online again");
  }

  // Jobs waiting for a runner over 20 minutes.
  const waiting = db.prepare("SELECT * FROM build_jobs WHERE status IN ('queued', 'waiting', 'pending') AND created_at < ?").all(t - 20 * 60_000) as JobRow[];
  for (const repo of new Set(locals.map((l) => l.repo))) {
    const w = waiting.filter((j) => j.repo === repo);
    if (w.length) open("queue", repo, repo, `${w.length} job(s) in ${repo} waiting over 20 minutes for a runner`, w.map((j) => `job ${j.id} ${key(j)} (${j.branch}) asks for ${parse<string>(j.labels).join(",")}, waiting ${Math.round((t - j.created_at) / 60_000)} min: ${j.url}`).join("\n"), w[0].id);
    else close("queue", repo, "nothing waits over 20 minutes");
  }

  // Resources: harden runners, keep disk free.
  const res = await resources();
  for (const r of res.runners) {
    if ((r.keepAlive && r.background) || remote.get(r.name)?.busy || t - (hardenTried.get(r.name) ?? 0) < 3600_000) continue;
    hardenTried.set(r.name, t);
    try { const h = await hardenRunner(r.name); if (h.changed.length) event("info", "build", `rules: hardened ${r.name} (${h.changed.join(", ")})`); } catch (e) { event("warn", "build", `could not harden ${r.name}: ${(e as Error).message}`); }
  }
  if (res.diskFreeGb < 20) {
    const idle = res.runners.filter((r) => !remote.get(r.name)?.busy && (r.workBytes ?? 0) > 1e9).sort((a, b) => (b.workBytes ?? 0) - (a.workBytes ?? 0));
    for (const r of idle.slice(0, 3)) {
      try { const c = await cleanRunner(r.name); event("warn", "build", `rules: disk under 20 GB free, emptied ${r.name}'s work folder (${(c.freedBytes / 1e9).toFixed(1)} GB)`); } catch { /* busy now */ }
    }
  }
  if (res.diskFreeGb < 30) open("disk", "disk", null, `the Mac has ${res.diskFreeGb.toFixed(0)} GB of disk free`, `runners' work folders: ${res.runners.map((r) => `${r.name} ${((r.workBytes ?? 0) / 1e9).toFixed(1)} GB`).join(", ")}`, Math.floor(t / (6 * 3600_000)));
  else if (res.diskFreeGb > 35) close("disk", "disk", `${res.diskFreeGb.toFixed(0)} GB free`);

  // Messages in each repository's build server thread (every 3 minutes).
  if (t - Number(state("threadsAt") ?? 0) > 3 * 60_000) {
    setState("threadsAt", String(t));
    for (const repo of new Set(locals.map((l) => l.repo))) {
      const thread = await threadOf(repo, false).catch(() => null);
      if (!thread) continue;
      const after = state(`thread:${repo}`) ?? new Date(t - 3600_000).toISOString();
      const comments = await gh<{ id: number; body: string; created_at: string; html_url: string; user: { login: string } }[]>(`repos/${repo}/issues/${thread.number}/comments?since=${encodeURIComponent(after)}&per_page=50`).catch(() => []);
      for (const m of comments) {
        if (m.body.includes("— mux build server (automated")) continue; // mux's own
        open("message", `${repo}#${m.id}`, repo, `${repo.split("/")[1]}: message in the build server thread`, `${m.user.login} wrote (${m.html_url}):\n\n${m.body.slice(0, 4000)}`, m.id);
      }
      if (comments.length) setState(`thread:${repo}`, comments[comments.length - 1].created_at);
    }
  }
}

// ── The agent ───────────────────────────────────────────────────────────────────────────────────────────────────────
let app: FastifyInstance | null = null;
let busy = false, lastRun = 0;
const runsLastHour: number[] = [];

/** What the agent may do on its own: read anything, and the build server's own operations. */
export function allowed(c: Call, kase: Case): true | string {
  const a = parseArgs(c.function.arguments);
  if (!isChange(c.function.name, a)) return true;
  const method = String(a.method).toUpperCase(), path = String(a.path ?? "");
  if (method !== "POST") return "only the build server's own operations run without a person";
  if (path === "/build/refresh" || /^\/build\/runners\/[^/]+\/(restart|clean|harden)$/.test(path)) return true;
  if (path === "/build/say") {
    const said = kase.actions.filter((x) => x.by === "agent" && x.action.startsWith("POST /build/say") && x.ts > now() - 3600_000).length;
    return said < 3 ? true : "already wrote 3 times about this case in the last hour";
  }
  const rerun = /^\/build\/jobs\/(\d+)\/rerun$/.exec(path);
  if (rerun) {
    const j = db.prepare("SELECT attempt FROM build_jobs WHERE id = ?").get(Number(rerun[1])) as { attempt: number } | undefined;
    if (!j) return "no such job";
    if (j.attempt >= 2) return "this job was already re-run; a third try needs a person";
    return true;
  }
  return "not one of the build server's own operations";
}

const BRIEF = `You are mux's build keeper: you run the build server, the GitHub Actions self-hosted runners on the owner's Mac Studio, which also runs mux's models. The owner gave you this job: keep the runners up around the clock with what they need to run (disk, memory, toolchains), take over every build-server problem and failed build, and talk with the repositories (the people and agents working in them) about what concerns them.

Your operations (call them with mux_api; they run at once):
- GET /build?range=24h — runners, jobs, failures, queue, timeline, load. GET /build/resources?fresh=1 — disk, memory, Xcode, each runner's work folder, Node and launchd settings.
- GET /build/jobs/{id}/log?grep=<regex>&lines=<n> — a job's log from GitHub (grep keeps matching lines and 2 around; else the last n lines). Read it before you say anything about a failure. Logs run to thousands of lines and passing tests often have \"error\" in their names: grep for what fails, e.g. grep=##\\[error\\]|✖|not ok|FAIL|Error:|error TS|exit code [1-9] first, then read around what you find.
- POST /build/runners/{name}/restart · /clean (empties an idle runner's work folder; the tool cache stays) · /harden (KeepAlive and background priority, idle only).
- POST /build/jobs/{id}/rerun — once per job, and only when the failure was the build server's (the runner died, the disk filled, a network fetch failed, a tool on the Mac was missing or wrong) or plainly flaky (it passed on the same commit before). Never re-run a real test or build failure.
- POST /build/say {repo, body, job?, comment?} — write to a repository: with job, on that job's pull request (or its commit if it has none); without, in the repository's "${THREAD}" issue, where it writes to you. With comment (the API url of a comment you wrote, listed in the case), edit that comment instead of writing a new one. Plain, short, specific: what failed, the error lines (quoted from the log), the cause, and what you did or what the repository should change. Sign nothing: mux adds its signature.
Anything else (models, routes, settings, the Mac) is recorded as a proposal for the owner; call it with a clear "why" if it is the right fix.

How to work: evidence first — the log, the runner's state, the resources. Decide whose problem it is. The build server's (environment, runner, disk, tools, Node version, network, a LaunchAgent): fix it, check the fix, and if a job failed because of it, re-run that job once. The repository's (its tests, its code, its workflow file asking for something wrong): do not change it; tell the repository once per case, on the job's pull request or commit, and edit that same comment when there is news. A message in the thread: answer it in the thread; do what it asks if it is one of your operations, else say what you did instead or that it needs the owner. Do not repeat yourself: the case lists what you already did and wrote. Write what you learn into the brain (brain_write, kind runbook, subject the repository or runner: symptom, cause, fix, how to check) and recall it before you start. Do not ask questions: nobody reads until you are done. Finish with a short report in Markdown: **Cause**, **What I did**, **What I told the repository**, **What the owner should do** (if anything).`;

export async function work(id: string, force = false): Promise<Case | undefined> {
  const s = settings();
  const kase = getCase(id);
  if (!kase || !app) return kase;
  if (busy) return kase;
  if (!force && !s.selfHealAi) return kase;
  busy = true; lastRun = Date.now(); runsLastHour.push(Date.now());
  const proposals: Call[] = [];
  try {
    act(kase, "agent", kase.looks ? "looked again (new evidence)" : "started", true);
    const sys = `${BRIEF}

${API_REFERENCE}

Now: ${new Date().toISOString()}. This mux: role ${config.role}, name "${config.name}".
${await snapshot()}

## From the brain
${(await recall(`build server ${kase.repo ?? ""} ${kase.subject} ${kase.title}`)).block}`;
    const user = `Case ${kase.id} (${kase.kind} · ${kase.subject}${kase.repo ? ` · ${kase.repo}` : ""}): ${kase.title}

Detail:
${(kase.detail ?? "").slice(0, 5000)}

Evidence (job ids, comment ids or hours, newest last): ${kase.evidence.slice(-10).join(", ") || "none"}

What was done so far:
${kase.actions.map((a) => `- ${new Date(a.ts).toISOString()} ${a.by}: ${a.action}${a.ok ? "" : " (failed)"}${a.detail ? ` — ${a.detail.split("\n")[0].slice(0, 200)}` : ""}`).join("\n") || "- nothing yet"}

What you wrote to the repository already: ${kase.said.map((x) => `${x.url} (comment ${x.comment}${x.job ? `, about job ${x.job}` : ""})`).join("; ") || "nothing"}
${kase.report ? `\nYour last report:\n${kase.report.slice(0, 2000)}` : ""}`;
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 10 * 60_000);
    let msgs: Msg[] = [{ role: "user", content: user }];
    try {
      msgs = await asActor("build-keeper", () => converse(app!, {
        msgs, sys, model: s.assistantModel || "auto", convo: `build_${kase.id}`, signal: ac.signal, agent: "build-keeper",
        emit: (type, data) => {
          if (type !== "result") return;
          // Keep the links of what was written, so the next look edits instead of repeating.
          const d = data as { content?: string };
          try { const r = JSON.parse(d.content ?? "{}") as { data?: { url?: string; comment?: string } }; if (r.data?.url && r.data?.comment) { const f = getCase(kase.id)!; f.said.push({ url: r.data.url, comment: r.data.comment }); save(f); } } catch { /* not a say */ }
        },
        decide: (c) => {
          const ok = allowed(c, getCase(kase.id) ?? kase);
          if (ok === true) {
            if (isChange(c.function.name, parseArgs(c.function.arguments))) {
              const a = parseArgs(c.function.arguments);
              act(kase, "agent", `${String(a.method).toUpperCase()} ${a.path}${a.why ? ` — ${a.why}` : ""}`, true, a.body ? JSON.stringify(a.body).slice(0, 1500) : undefined);
            }
            return "run";
          }
          proposals.push(c);
          return { skip: `recorded as a proposal for the owner (${ok}); not run. Go on as if it is pending.` };
        },
      }));
    } finally { clearTimeout(timer); }
    const report = [...msgs].reverse().find((m) => m.role === "assistant" && m.content)?.content ?? "(no report)";
    const f = getCase(kase.id)!;
    f.report = report; f.looked_at = now(); f.looks++; f.fresh = false;
    if (f.kind === "message") { f.status = "resolved"; f.resolved_at = now(); }
    for (const p of proposals) { const a = parseArgs(p.function.arguments); f.actions.push({ ts: now(), by: "agent", action: `proposes ${String(a.method).toUpperCase()} ${a.path}${a.why ? ` — ${a.why}` : ""}`, ok: true, proposal: p }); }
    save(f);
    event("info", "build", `build keeper finished ${kase.id}${proposals.length ? ` with ${proposals.length} proposal(s)` : ""}`, { case: kase.id });
    return getCase(kase.id);
  } catch (e) {
    act(kase, "agent", "look", false, (e as Error).message);
    const f = getCase(kase.id)!; f.fresh = false; f.looked_at = now(); save(f);
    return getCase(kase.id);
  } finally { busy = false; }
}

/** After each poll: look for problems, then hand the most pressing fresh case to the agent (one at a time, ≤ 20 an hour). */
async function afterPoll() {
  await look();
  while (runsLastHour.length && runsLastHour[0] < Date.now() - 3600_000) runsLastHour.shift();
  if (busy || runsLastHour.length >= 20 || Date.now() - lastRun < 60_000 || !settings().selfHealAi) return;
  const order = ["runner", "message", "disk", "queue", "failed"];
  const next = (db.prepare("SELECT * FROM build_cases WHERE status = 'open' AND fresh = 1").all() as Row[]).map(fromRow)
    // A failing job is looked at again at most every 30 minutes, however often it fails.
    .filter((c) => !c.looked_at || c.kind !== "failed" || now() - c.looked_at > 30 * 60_000)
    .sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind) || a.ts - b.ts)[0];
  if (next) void work(next.id);
}

// ── Record first ─────────────────────────────────────────────────────────────────────────────────────────────────
/*
 * Record's own work runs on this Mac too (speech-da on :8798, the speakers service), on the same GPU and cores as the
 * builds. On 2026-11-25 a 43-minute recording stuck at 74 of 91 parts: Røst and the speakers service timed out while
 * Record's CI ran its diarization check over the whole corpus on mac-studio-record. Record's trainer already steps
 * aside for live work (record_training: a live meeting, or parts waiting); now the builds do too. Every 15 s: when a
 * live meeting streams through speech-da (/live/status) or Record has parts waiting to be written down
 * (/api/training/busy), every CI step running on this Mac is paused (SIGSTOP to the step's script and all under it;
 * the runner itself keeps talking to GitHub), and resumed (SIGCONT) when Record is clear — or after 20 minutes, so a
 * job's own time limit is not reached; a job resumed that way is not paused again for 10 minutes.
 */
const RECORD_ETC = process.env.RECORD_ETC ?? join(process.env.HOME ?? "", ".record", "etc");
const run = (cmd: string, args: string[], timeout = 10_000) => new Promise<string>((res, rej) => execFile(cmd, args, { timeout, maxBuffer: 8 << 20 }, (e, out) => (e ? rej(e) : res(out))));
const paused = new Map<number, { pid: number; runner: string; since: number; procs: number[] }>(); // step script pid →
const spared = new Map<number, number>(); // step script pid → when it was resumed after the 20-minute limit
let recordState: { checked: number; streams: number; waiting: number; error: string | null } = { checked: 0, streams: 0, waiting: 0, error: null };

/** Record's key and address, from its env files on this Mac (the trainer reads the same ones). */
function recordAccess(): { key: string; url: string } | null {
  const env: Record<string, string> = {};
  for (const f of ["speech-da.env", "training.env"]) {
    const p = join(RECORD_ETC, f);
    if (!existsSync(p)) continue;
    for (const line of readFileSync(p, "utf8").split("\n")) { const m = /^\s*([A-Z_]+)=(.*)$/.exec(line); if (m) env[m[1]] = m[2].trim().replace(/^["']|["']$/g, ""); }
  }
  return env.SPEECH_DA_KEY ? { key: env.SPEECH_DA_KEY, url: (env.RECORD_URL ?? "https://record-web-production.up.railway.app").replace(/\/$/, "") } : null;
}

async function recordBusy(): Promise<boolean> {
  const a = recordAccess();
  if (!a) { recordState = { checked: now(), streams: 0, waiting: 0, error: "no Record key on this Mac" }; return false; }
  const get = async (url: string) => { const r = await fetch(url, { headers: { authorization: `Bearer ${a.key}` }, signal: AbortSignal.timeout(8_000) }); if (!r.ok) throw new Error(`${url.replace(/\?.*/, "")} answered ${r.status}`); return r.json() as Promise<Record<string, unknown>>; };
  const [live, busyR] = await Promise.allSettled([get(`${process.env.SPEECH_LOCAL_URL ?? "http://127.0.0.1:8798"}/live/status`), get(`${a.url}/api/training/busy`)]);
  const streams = live.status === "fulfilled" ? ((live.value.streams as unknown[]) ?? []).length : 0;
  const waiting = busyR.status === "fulfilled" ? Number(busyR.value.waiting ?? 0) : 0;
  const errs = [live, busyR].filter((x): x is PromiseRejectedResult => x.status === "rejected").map((x) => (x.reason as Error).message);
  recordState = { checked: now(), streams, waiting, error: errs.join("; ") || null };
  return streams > 0 || waiting > 0;
}

/** The CI steps running on this Mac: each step's script (under a runner's _work/_temp) and every process under it. */
export async function runningSteps(): Promise<{ pid: number; runner: string; procs: number[] }[]> {
  const locals = await localRunners();
  const rows = (await run("/bin/ps", ["-Ao", "pid=,ppid=,command="])).split("\n").map((l) => /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(l)).filter((m): m is RegExpExecArray => !!m).map((m) => ({ pid: Number(m[1]), ppid: Number(m[2]), cmd: m[3] }));
  const kids = new Map<number, number[]>();
  for (const r of rows) kids.set(r.ppid, [...(kids.get(r.ppid) ?? []), r.pid]);
  const under = (pid: number): number[] => [pid, ...(kids.get(pid) ?? []).flatMap(under)];
  const out: { pid: number; runner: string; procs: number[] }[] = [];
  for (const r of rows) {
    const l = locals.find((x) => r.cmd.includes(`${x.dir}/_work/_temp/`) && /\.sh\b/.test(r.cmd));
    if (l) out.push({ pid: r.pid, runner: l.name, procs: under(r.pid) });
  }
  return out;
}

export const signal = (pids: number[], sig: "SIGSTOP" | "SIGCONT") => { for (const p of pids) try { process.kill(p, sig); } catch { /* gone */ } };

async function recordFirst() {
  const busyNow = await recordBusy().catch(() => false);
  const t = now();
  // Resume what should run again: Record is clear, the step has waited 20 minutes, or it ended.
  for (const [pid, p] of paused) {
    const over = t - p.since > 20 * 60_000;
    if (!busyNow || over) {
      signal(p.procs, "SIGCONT");
      paused.delete(pid);
      if (over) spared.set(pid, t);
      event("info", "build", `resumed the CI step on ${p.runner} after ${Math.round((t - p.since) / 1000)} s${over ? " (20-minute limit; Record still busy)" : ": Record is clear"}`);
    }
  }
  if (!busyNow) return;
  for (const s of await runningSteps()) {
    if (paused.has(s.pid) || t - (spared.get(s.pid) ?? 0) < 10 * 60_000) continue;
    signal(s.procs, "SIGSTOP");
    paused.set(s.pid, { ...s, since: t });
    event("warn", "build", `paused the CI step on ${s.runner} (${s.procs.length} processes): Record has ${recordState.streams ? `${recordState.streams} live meeting(s)` : `${recordState.waiting} part(s) waiting to be written down`}`);
    journal({ who: "build-keeper", kind: "build", ref: s.runner, title: `Build keeper: paused a CI step on ${s.runner} for Record's live work` });
  }
  for (const [pid, at] of spared) if (t - at > 3600_000) spared.delete(pid);
}

/** Resume every paused step (mux is stopping — index.ts — or the owner asks): a build is never left stopped behind. */
export function resumeAll() { for (const [pid, p] of paused) { signal(p.procs, "SIGCONT"); paused.delete(pid); } }
export const recordFirstState = () => ({ ...recordState, paused: [...paused.values()].map((p) => ({ runner: p.runner, since: p.since, processes: p.procs.length })) });

export function startBuildKeeper(a: FastifyInstance) {
  app = a;
  if (config.role === "gateway" || process.env.MUX_NO_BUILD) return;
  onPolled(afterPoll);
  // A mux that was killed outright (no stop()) may have left steps paused: wake every running step once at start.
  void runningSteps().then((steps) => { for (const st of steps) signal(st.procs, "SIGCONT"); }).catch(() => undefined);
  setInterval(() => void recordFirst().catch((e) => event("warn", "build", `record first: ${(e as Error).message}`)), 15_000).unref();
}

/** For the Agents page. */
export const keeperState = () => {
  const openN = (db.prepare("SELECT COUNT(*) n FROM build_cases WHERE status = 'open'").get() as { n: number }).n;
  const last = db.prepare("SELECT title, looked_at, report FROM build_cases WHERE looked_at IS NOT NULL ORDER BY looked_at DESC LIMIT 1").get() as { title: string; looked_at: number; report: string } | undefined;
  return { busy, lastRun, open: openN, last, recordFirst: recordFirstState() };
};

export function registerBuildKeeper(api: FastifyInstance) {
  api.get("/build/cases", async (req) => {
    const q = req.query as { status?: string; limit?: string };
    const rows = db.prepare(`SELECT * FROM build_cases ${q.status === "open" ? "WHERE status = 'open'" : ""} ORDER BY updated_at DESC LIMIT ?`).all(Math.min(Number(q.limit) || 50, 200)) as Row[];
    return { busy, cases: rows.map(fromRow), recordFirst: recordFirstState() };
  });
  api.post("/build/record-first/resume", async () => { resumeAll(); return recordFirstState(); });
  api.get("/build/cases/:id", async (req, reply) => getCase((req.params as { id: string }).id) ?? reply.code(404).send({ error: "no such case" }));
  api.post("/build/keeper/run", async () => { await look(); return { ok: true, open: keeperState().open }; });
  api.post("/build/cases/:id/work", async (req, reply) => {
    const c = getCase((req.params as { id: string }).id);
    if (!c) return reply.code(404).send({ error: "no such case" });
    if (busy) return reply.code(409).send({ error: "the build keeper is busy with another case" });
    void work(c.id, true);
    return { ok: true };
  });
  api.post("/build/cases/:id/resolve", async (req, reply) => {
    const c = getCase((req.params as { id: string }).id);
    if (!c) return reply.code(404).send({ error: "no such case" });
    c.status = "resolved"; c.resolved_at = now(); c.fresh = false;
    c.actions.push({ ts: now(), by: "user", action: "marked resolved", ok: true });
    save(c);
    return getCase(c.id);
  });
  // A proposal, approved by the owner: run it.
  api.post("/build/cases/:id/apply", async (req, reply) => {
    const c = getCase((req.params as { id: string }).id);
    const i = Number((req.body as { index?: number })?.index);
    const p = c?.actions[i]?.proposal;
    if (!c || !p) return reply.code(404).send({ error: "no such proposal" });
    const out = await runTool(app!, p, () => undefined);
    c.actions.push({ ts: now(), by: "user", action: `approved: ${c.actions[i].action.replace(/^proposes /, "")}`, ok: !/"status":\s*[45]\d\d/.test(out), detail: out.slice(0, 1000) });
    save(c);
    return getCase(c.id);
  });
}
