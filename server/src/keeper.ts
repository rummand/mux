import { randomBytes } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { converse, isChange, parse, type Msg } from "./assistant.js";
import { brainLine, API_REFERENCE } from "./assistant.js";
import { brainNode, search } from "./brain.js";
import { db, event, json, now, settings } from "./db.js";
import { asActor, journal } from "./journal.js";

/**
 * The brain keeper: the part of mux that looks after its memory, on its own — the owner gave mux its brain to run.
 * Every 15 minutes (or when asked) it reads what happened since it last ran — the assistant's conversations, incidents the
 * doctor diagnosed, Lens's new findings — and keeps the brain: writes down what will matter later, updates pages
 * instead of adding near-copies, records facts about tenants, models and machines, merges duplicates and forgets what
 * is no longer true. It changes nothing else about mux: it reads mux, and writes only its brain. What it changes is in
 * the journal, and its report is shown to the owner.
 *
 * Every mux keeps its own material (a gateway holds its own conversations); all of them write into the one brain.
 * Tidying the whole brain is done where the brain lives.
 */
db.exec("CREATE TABLE IF NOT EXISTS keeper_runs (id TEXT PRIMARY KEY, ts INTEGER NOT NULL, status TEXT NOT NULL, since INTEGER NOT NULL, read TEXT, report TEXT, error TEXT, duration_ms INTEGER, tidied INTEGER DEFAULT 0)");
try { db.exec("ALTER TABLE keeper_runs ADD COLUMN tidied INTEGER DEFAULT 0"); } catch { /* there already */ }

export interface KeeperRun { id: string; ts: number; status: "running" | "done" | "error"; since: number; read: { conversations: number; incidents: number; findings: number } | null; report: string | null; error: string | null; duration_ms: number | null }
const fromRow = (r: Record<string, unknown>): KeeperRun => ({ ...(r as unknown as KeeperRun), read: json(r.read as string, null) });
export const keeperRuns = (limit = 20) => (db.prepare("SELECT * FROM keeper_runs ORDER BY ts DESC LIMIT ?").all(limit) as Record<string, unknown>[]).map(fromRow);

let app: FastifyInstance | null = null;
let busy = false;

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);

/** What happened since `since`, as the keeper reads it. */
function material(since: number) {
  const convs = (db.prepare("SELECT id, title, messages, updated_at FROM assistant_conversations WHERE updated_at > ? ORDER BY updated_at DESC LIMIT 8").all(since) as { id: string; title: string; messages: string; updated_at: number }[])
    .map((c) => {
      const msgs = json<Msg[]>(c.messages, []).filter((m) => (m.role === "user" || m.role === "assistant") && m.content);
      return `### Conversation “${c.title}” (${new Date(c.updated_at).toISOString().slice(0, 16)})\n${clip(msgs.map((m) => `${m.role === "user" ? "Owner" : "Assistant"}: ${clip(String(m.content), 700)}`).join("\n"), 6000)}`;
    });
  const incidents = (db.prepare("SELECT title, kind, subject, diagnosis, status FROM incidents WHERE updated_at > ? AND diagnosis IS NOT NULL ORDER BY updated_at DESC LIMIT 6").all(since) as { title: string; kind: string; subject: string; diagnosis: string; status: string }[])
    .map((i) => `### Incident: ${i.title} (${i.kind} · ${i.subject} · ${i.status})\n${clip(i.diagnosis, 1500)}`);
  const findings = (db.prepare("SELECT title, findings, ts FROM lens_runs WHERE ts > ? AND status = 'done' ORDER BY ts DESC LIMIT 4").all(since) as { title: string; findings: string; ts: number }[])
    .flatMap((r) => json<{ title: string; status?: string; priority: string; description: string }[]>(r.findings, []).filter((f) => f.status === "new" && f.priority !== "low").map((f) => `- Lens (${r.title}): ${f.title} — ${clip(f.description, 300)}`));
  return { convs, incidents, findings };
}

export async function runKeeper(trigger = "schedule"): Promise<KeeperRun> {
  if (!app) throw new Error("the keeper has not started");
  if (busy) throw new Error("the keeper is already running");
  busy = true;
  const last = (db.prepare("SELECT MAX(ts) t FROM keeper_runs WHERE status = 'done'").get() as { t: number | null }).t;
  const since = last ?? now() - 7 * 86400_000;
  const id = `keep_${randomBytes(5).toString("hex")}`;
  const t0 = Date.now();
  db.prepare("INSERT INTO keeper_runs(id, ts, status, since) VALUES(?, ?, 'running', ?)").run(id, now(), since);
  try {
    const m = material(since);
    const read = { conversations: m.convs.length, incidents: m.incidents.length, findings: m.findings.length };
    const index = await search("", { limit: 100 }).catch(() => []);
    const lastTidy = (db.prepare("SELECT MAX(ts) t FROM keeper_runs WHERE status = 'done' AND tidied = 1").get() as { t: number | null }).t ?? 0;
    const local = !brainNode() && (trigger === "owner" || now() - lastTidy > 6 * 3600_000);
    if (!m.convs.length && !m.incidents.length && !m.findings.length && !(local && index.length > 1)) {
      const report = "Nothing new to remember since the last run.";
      db.prepare("UPDATE keeper_runs SET status = 'done', read = ?, report = ?, duration_ms = ? WHERE id = ?").run(JSON.stringify(read), report, Date.now() - t0, id);
      return keeperRuns(1)[0];
    }
    const sys = `You are mux's brain keeper: the part of mux that looks after its own memory. The owner gave mux its brain and said mux controls it; you keep it. ${await brainLine()}

Your job now: read what happened since your last run (below) and keep the brain so the assistant and the doctor start from what matters.
- Write down what will matter later and is not visible in mux's API: why something is set up as it is, decisions and their reasons, what the owner wants and prefers, what worked and what did not, the cause and fix of problems (as runbooks: symptom, cause, fix, how to check). Short, concrete pages.
- The list below shows titles only, not the pages' text: read a page (brain_search) before you update it — never assume one is empty.
- Pages marked "by the owner" are the owner's own words: never rewrite or forget them (the brain refuses); write another page that refers to one if needed.
- Update a page that already covers it (brain_write with its id) rather than adding a near-copy. Facts about one tenant, model or machine: brain_remember with the entity.
- Do not write chit-chat, secrets, or what the API already shows (model lists, current settings).
${local ? "- Tidy the whole brain: merge pages that say the same (write the merged one, then brain_forget the others), fix or forget what is no longer true (check it against mux's API with GET calls)." : "- The brain lives on another machine; tidying it is done there. Only add and update from what you read here."}
- You may read mux (mux_api GET) to check a fact. You change nothing about mux except its brain.
Finish with a short report for the owner, in Markdown: what you wrote, updated, merged or forgot, and why — one line each. If nothing deserved remembering, say so.

${API_REFERENCE.split("\n").filter((l) => l.startsWith("- GET") || l.startsWith("Admin API")).join("\n")}

## The brain now (${index.length} pages)
${index.map((p) => `- ${p.id}: ${p.title} (${p.kind}${p.source === "user" ? ", by the owner" : ""})`).join("\n") || "(empty)"}`;
    const user = [m.convs.length ? `## Conversations\n${m.convs.join("\n\n")}` : "", m.incidents.length ? `## Incidents the doctor diagnosed\n${m.incidents.join("\n\n")}` : "", m.findings.length ? `## New Lens findings\n${m.findings.join("\n")}` : ""].filter(Boolean).join("\n\n") || "Nothing new happened; tidy the brain.";
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 10 * 60_000);
    let out: Msg[] = [];
    try {
      out = await asActor("brain-keeper", () => converse(app!, {
        msgs: [{ role: "user", content: user }], sys, model: settings().assistantModel || "auto", convo: `keeper_${id}`, signal: ac.signal, agent: "brain-keeper", emit: () => undefined,
        // Its own brain, freely; mux itself, only to read.
        decide: (c) => (c.function.name.startsWith("brain_") || !isChange(c.function.name, parse(c.function.arguments)) ? "run" : { skip: "the brain keeper changes nothing but the brain" }),
      }));
    } finally { clearTimeout(timer); }
    const report = [...out].reverse().find((x) => x.role === "assistant" && x.content)?.content ?? "(no report)";
    db.prepare("UPDATE keeper_runs SET status = 'done', read = ?, report = ?, duration_ms = ?, tidied = ? WHERE id = ?").run(JSON.stringify(read), report, Date.now() - t0, local ? 1 : 0, id);
    journal({ who: "brain-keeper", kind: "keeper", ref: id, title: `Brain keeper read ${read.conversations} conversation(s), ${read.incidents} incident(s), ${read.findings} finding(s)`, detail: report });
    event("info", "brain", `keeper ${id} (${trigger}): done`);
    return keeperRuns(1)[0];
  } catch (e) {
    db.prepare("UPDATE keeper_runs SET status = 'error', error = ?, duration_ms = ? WHERE id = ?").run((e as Error).message, Date.now() - t0, id);
    event("warn", "brain", `keeper ${id}: ${(e as Error).message}`);
    return keeperRuns(1)[0];
  } finally { busy = false; }
}

export function startKeeper(server: FastifyInstance) {
  app = server;
  db.prepare("UPDATE keeper_runs SET status = 'error', error = 'mux restarted during the run' WHERE status = 'running'").run();
  // Every 15 minutes, as the owner asked: what happened since. The model works only when something did, and tidies the
  // whole brain at most every 6 hours.
  setTimeout(() => void runKeeper().catch(() => undefined), 5 * 60_000).unref();
  setInterval(() => void runKeeper().catch(() => undefined), 15 * 60_000).unref();
}

export function registerKeeper(api: FastifyInstance) {
  api.get("/brain/keeper", async () => ({ busy, runs: keeperRuns() }));
  api.post("/brain/keeper/run", async (_req, reply) => { if (busy) return reply.code(409).send({ error: "the keeper is already running" }); void runKeeper("owner").catch(() => undefined); return { ok: true }; });
}
