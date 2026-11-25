import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync, spawn } from "node:child_process";

// A runners folder and a LaunchAgents folder of this test's own: nothing on the Mac is found, paused or restarted.
const tmp = mkdtempSync(join(tmpdir(), "mux-keeper-"));
process.env.MUX_RUNNERS_DIR = join(tmp, "runners");
process.env.MUX_LAUNCH_AGENTS = join(tmp, "agents");
mkdirSync(process.env.MUX_LAUNCH_AGENTS, { recursive: true });

const { db } = await import("../src/db.js");
const { allowed, runningSteps, signal } = await import("../src/buildKeeper.js");

const call = (method: string, path: string) => ({ id: "c", type: "function", function: { name: "mux_api", arguments: JSON.stringify({ method, path }) } }) as never;
const kase = (actions: { action: string; ts: number }[] = []) => ({ actions: actions.map((a) => ({ ...a, by: "agent", ok: true })) }) as never;

test("the build keeper runs the build server's own operations alone, and nothing else", () => {
  db.prepare("INSERT OR REPLACE INTO build_jobs(id, run_id, repo, name, attempt) VALUES(1, 1, 'o/r', 'checks', 1), (2, 2, 'o/r', 'checks', 2)").run();
  assert.equal(allowed(call("GET", "/models"), kase()), true);
  for (const p of ["/build/refresh", "/build/runners/mac-1/restart", "/build/runners/mac-1/clean", "/build/runners/mac-1/harden", "/build/say"]) assert.equal(allowed(call("POST", p), kase()), true, p);
  assert.equal(allowed(call("POST", "/build/jobs/1/rerun"), kase()), true);
  assert.match(String(allowed(call("POST", "/build/jobs/2/rerun"), kase())), /already re-run/);
  assert.match(String(allowed(call("PATCH", "/models/qwen3.6-35b-a3b"), kase())), /only the build server's own/);
  assert.match(String(allowed(call("POST", "/models/qwen3.6-35b-a3b/load"), kase())), /not one of the build server's/);
  const said = Array.from({ length: 3 }, () => ({ action: "POST /build/say", ts: Date.now() }));
  assert.match(String(allowed(call("POST", "/build/say"), kase(said))), /3 times/);
});

test("a CI step and everything under it is found, paused and resumed", { skip: process.platform !== "darwin" && "ps here is macOS's" }, async () => {
  const r = join(process.env.MUX_RUNNERS_DIR!, "steps");
  mkdirSync(join(r, "_work", "_temp"), { recursive: true });
  writeFileSync(join(r, ".runner"), JSON.stringify({ agentName: "mac-steps", gitHubUrl: "https://github.com/o/steps" }));
  const script = join(r, "_work", "_temp", "step.sh");
  writeFileSync(script, "sleep 30 & wait\n");
  const p = spawn("/bin/bash", ["-e", script], { stdio: "ignore" });
  try {
    await new Promise((res) => setTimeout(res, 400));
    const steps = await runningSteps();
    assert.deepEqual(steps.map((s) => s.runner), ["mac-steps"]);
    assert.ok(steps[0].procs.length >= 2, "the script and the sleep under it");
    const stat = (pid: number) => execFileSync("/bin/ps", ["-o", "stat=", "-p", String(pid)]).toString().trim();
    signal(steps[0].procs, "SIGSTOP");
    assert.match(stat(steps[0].procs[1]), /^T/);
    signal(steps[0].procs, "SIGCONT");
    assert.doesNotMatch(stat(steps[0].procs[1]), /^T/);
    for (const pid of steps[0].procs) try { process.kill(pid); } catch { /* gone */ }
  } finally { p.kill(); }
});
