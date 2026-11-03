import type { FastifyInstance } from "fastify";
import { config } from "./config.js";
import { db, now, settings } from "./db.js";
import { lastPilot } from "./experiments.js";
import { healerState } from "./healer.js";
import { entries } from "./journal.js";
import { keeperRuns } from "./keeper.js";
import { listWatches } from "./lens.js";

/**
 * The agents that act on mux — its hands and feet — in one view: the healer and its doctor, the experiments autopilot,
 * Lens's watches and the brain keeper. For each: what it does, whether it is on, how often it runs, when it last ran
 * and what came of it, what it changed (from the journal), and how to run it now. The owner, 2026-11-03: "is there an
 * agent that does … the hands and feet?" — there are several; this shows them.
 */
export interface Agent {
  id: string; name: string; does: string; on: boolean; busy: boolean; schedule: string;
  last: { at: number | null; summary: string; ok: boolean | null } | null;
  next: number | null;
  changed: { ts: number; title: string; kind: string }[]; changed24h: number;
  actor: string[]; run: { label: string; path: string }[]; settings: string | null;
}

const changed = (actors: string[]) => {
  const list = actors.flatMap((a) => entries({ actor: a, limit: 5 })).sort((a, b) => b.ts - a.ts).slice(0, 4).map((e) => ({ ts: e.ts, title: e.title, kind: e.kind }));
  const n = (db.prepare(`SELECT COUNT(*) n FROM journal WHERE ts >= ? AND actor IN (${actors.map(() => "?").join(",")})`).get(now() - 86400_000, ...actors) as { n: number }).n;
  return { changed: list, changed24h: n };
};

export function agents(): Agent[] {
  const s = settings();
  const node = config.role !== "gateway";
  const h = healerState();
  const open = (db.prepare("SELECT COUNT(*) n FROM incidents WHERE status != 'resolved'").get() as { n: number }).n;
  const diagnosed = db.prepare("SELECT title, updated_at FROM incidents WHERE diagnosis IS NOT NULL ORDER BY updated_at DESC LIMIT 1").get() as { title: string; updated_at: number } | undefined;
  const fixes = (db.prepare("SELECT COUNT(*) n FROM events WHERE source = 'healer' AND level = 'info' AND ts >= ?").get(now() - 86400_000) as { n: number }).n;
  const p = lastPilot();
  const k = keeperRuns(1)[0];
  const watches = listWatches();
  const lastWatch = watches.filter((w) => w.last_run).sort((a, b) => (b.last_run ?? 0) - (a.last_run ?? 0))[0];
  const watchRun = lastWatch?.last_run_id ? db.prepare("SELECT status, findings FROM lens_runs WHERE id = ?").get(lastWatch.last_run_id) as { status: string; findings: string } | undefined : undefined;
  const watchFindings = watchRun ? (JSON.parse(watchRun.findings || "[]") as { status?: string; priority: string }[]) : [];
  const nextWatch = watches.filter((w) => w.enabled).map((w) => (w.last_run ?? 0) + w.every_hours * 3600_000).sort((a, b) => a - b)[0] ?? null;

  return [
    {
      id: "healer", name: "Healer & doctor", actor: ["healer", "doctor"], on: s.selfHeal, busy: h.doctorBusy,
      does: `Keeps mux running. Every 20 seconds the healer checks ${node ? "the model servers, pinned models, memory, disk, " : ""}error spikes, nodes, routes and the database, and fixes what it safely can: restarts a crashed model server, cools down a failing model, frees memory. What it cannot fix becomes an incident for the doctor, which reads the logs with a model${s.selfHealAi ? "" : " (switched off)"} and acts within a safe set.`,
      schedule: "every 20 s", next: s.selfHeal && h.lastTick ? h.lastTick + 20_000 : null,
      last: h.lastTick ? { at: h.lastTick, ok: !h.failing.length, summary: h.failing.length ? `${h.failing.length} of ${h.checks} checks failing: ${h.failing.map((f) => `${f.label} (${f.detail})`).join("; ").slice(0, 300)}` : `all ${h.checks} checks pass · ${fixes} fix(es) in 24 h · ${open} open incident(s)${diagnosed ? ` · last diagnosis: “${diagnosed.title}”` : ""}` } : null,
      ...changed(["healer", "doctor"]), run: [{ label: "Run the checks now", path: "/healer/run" }], settings: "/health",
    },
    {
      id: "autopilot", name: "Experiments autopilot", actor: ["autopilot", "experiments"], on: s.autoExperiments, busy: false,
      does: "Decides what to try, without waiting to be told. Once an hour it gives a route whose first model fails 10%+ an A/B test with the most reliable model, tries models the advisor ranks clearly above a route's champion on 10% of traffic, and downloads better models that fit. Experiments judge themselves and promote a winner — production stays up throughout.",
      schedule: "every hour", next: s.autoExperiments && p.at ? p.at + 3600_000 : null,
      last: p.at ? { at: p.at, ok: true, summary: [p.actions.length ? p.actions.join("; ") : "nothing to start", p.blocked.length ? `held back: ${p.blocked.join("; ")}` : ""].filter(Boolean).join(" — ").slice(0, 500) } : null,
      ...changed(["autopilot", "experiments"]), run: [{ label: "Run it now", path: "/experiments/autopilot/run" }], settings: "/experiments",
    },
    {
      id: "lens", name: "Lens watches", actor: ["lens"], on: watches.some((w) => w.enabled), busy: !!db.prepare("SELECT 1 FROM lens_runs WHERE status = 'running' AND watch_id IS NOT NULL").get(),
      does: `Investigates the traffic on a schedule: counts what can be counted (error clusters, storms, empty answers, full contexts, data-border breaches, budgets) and has a model look for the rest — every claim it makes checked against mux's own data. New findings that need attention raise a warning the healer and Ask mux see. ${watches.length} watch(es).`,
      schedule: !watches.length ? "no watches" : watches.length === 1 ? `every ${watches[0].every_hours} h${watches[0].enabled ? "" : " (off)"}` : watches.map((w) => `${w.title}: every ${w.every_hours} h${w.enabled ? "" : " (off)"}`).join(" · "), next: nextWatch,
      last: lastWatch ? { at: lastWatch.last_run, ok: !watchFindings.some((f) => f.priority === "high"), summary: watchRun?.status === "running" ? "running now" : `${lastWatch.title}: ${watchFindings.length} finding(s), ${watchFindings.filter((f) => f.status === "new").length} new, ${watchFindings.filter((f) => f.priority === "high").length} high` } : null,
      ...changed(["lens"]), run: watches.map((w) => ({ label: watches.length > 1 ? `Run “${w.title}”` : "Run it now", path: `/lens/watches/${w.id}/run` })), settings: "/lens",
    },
    {
      id: "keeper", name: "Brain keeper", actor: ["brain-keeper"], on: true, busy: k?.status === "running",
      does: "Looks after mux's memory. Every 15 minutes it reads the conversations, the doctor's diagnoses and Lens's new findings, writes down what matters, updates and merges pages, and forgets what is no longer true. It never rewrites your own pages, and changes nothing else about mux.",
      schedule: "every 15 min", next: k ? k.ts + 15 * 60_000 : null,
      last: k ? { at: k.ts, ok: k.status !== "error", summary: k.status === "error" ? `failed: ${k.error}` : k.status === "running" ? "running now" : (k.report ?? "").split("\n").find((l) => l.trim())?.replace(/^[#*\s-]+/, "").slice(0, 300) ?? "" } : null,
      ...changed(["brain-keeper"]), run: [{ label: "Run it now", path: "/brain/keeper/run" }], settings: "/brain",
    },
  ];
}

export function registerAgents(api: FastifyInstance) {
  api.get("/agents", async () => agents());
}
