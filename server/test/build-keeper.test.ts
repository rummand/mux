import { test } from "node:test";
import assert from "node:assert/strict";

const { db } = await import("../src/db.js");
const { allowed } = await import("../src/buildKeeper.js");

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
