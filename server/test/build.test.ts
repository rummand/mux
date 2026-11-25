import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "mux-build-"));
const agents = join(dir, "LaunchAgents"), runners = join(dir, "actions-runners");
process.env.MUX_LAUNCH_AGENTS = agents;
process.env.MUX_RUNNERS_DIR = runners;
const runner = (path: string, name: string, repo: string) => { mkdirSync(path, { recursive: true }); writeFileSync(join(path, ".runner"), `﻿${JSON.stringify({ agentName: name, gitHubUrl: `https://github.com/${repo}` })}`); };
mkdirSync(agents, { recursive: true });
runner(join(dir, "ci", "runner-1"), "mac-1", "o/app");
writeFileSync(join(agents, "com.app.ci-runner-1.plist"), `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict><key>Label</key><string>com.app.ci-runner-1</string><key>ProgramArguments</key><array><string>${join(dir, "ci", "runner-1", "run.sh")}</string></array></dict></plist>`);
runner(join(runners, "web"), "mac-web", "o/web"); // configured, no LaunchAgent
writeFileSync(join(agents, "com.other.plist"), "<plist><dict><key>Label</key><string>x</string></dict></plist>");

const { db } = await import("../src/db.js");
const { buildView, localRunners } = await import("../src/build.js");

test("runners are found from their LaunchAgents, and a configured folder without one is listed", { skip: process.platform !== "darwin" && "plutil is macOS's" }, async () => {
  const rs = await localRunners();
  assert.deepEqual(rs.map((r) => [r.name, r.repo, r.label]), [["mac-1", "o/app", "com.app.ci-runner-1"], ["mac-web", "o/web", ""]]);
});

test("the view counts only this Mac's jobs, finds the failing step, flaky jobs and where the minutes go", { skip: process.platform !== "darwin" && "plutil is macOS's" }, async () => {
  const t = Date.now() - 3600_000;
  const run = db.prepare("INSERT INTO build_runs(id, repo, workflow, title, event, branch, sha, status, conclusion, attempt, created_at, updated_at, url) VALUES(?, 'o/app', 'ci', 't', 'push', 'main', ?, 'completed', ?, 1, ?, ?, '')");
  const job = db.prepare("INSERT INTO build_jobs(id, run_id, repo, name, workflow, branch, status, conclusion, runner, labels, attempt, created_at, started_at, completed_at, steps, url) VALUES(?, ?, 'o/app', ?, 'ci', 'main', 'completed', ?, ?, '[]', 1, ?, ?, ?, ?, '')");
  const steps = (testOk: boolean) => JSON.stringify([{ n: 1, name: "install", conclusion: "success", status: "completed", start: t, end: t + 60_000 }, { n: 2, name: "test", conclusion: testOk ? "success" : "failure", status: "completed", start: t + 60_000, end: t + 180_000 }]);
  run.run(1, "aaa", "failure", t, t); run.run(2, "aaa", "success", t + 1, t + 1); run.run(3, "bbb", "success", t + 2, t + 2);
  job.run(11, 1, "checks", "failure", "mac-1", t, t + 10_000, t + 190_000, steps(false));
  job.run(12, 2, "checks", "success", "mac-1", t + 1, t + 20_000, t + 200_000, steps(true));
  job.run(13, 3, "checks", "success", "GitHub Actions 1", t + 2, t + 30_000, t + 210_000, steps(true)); // GitHub's machine
  const v = await buildView("24h");
  assert.equal(v.kpis.jobs, 2);
  assert.equal(v.kpis.hostedJobs, 1);
  assert.equal(v.kpis.successRate, 0.5);
  assert.equal(v.failures[0].step, "test");
  assert.deepEqual(v.flaky, ["app · checks"]);
  assert.deepEqual(v.steps.slowest.map((s) => [s.name, s.totalMs]), [["test", 240_000], ["install", 120_000]]);
  assert.deepEqual(v.steps.failing.map((s) => [s.name, s.failed]), [["test", 1]]);
  assert.equal(v.repos.find((r) => r.repo === "o/app")?.jobs, 2);
});
