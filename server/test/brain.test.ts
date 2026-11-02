import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// A brain of its own, and a gateway port nothing listens on: the brain must work on words alone.
const dir = mkdtempSync(join(tmpdir(), "mux-brain-"));
process.env.MUX_HOME = dir;
process.env.MUX_DB = join(dir, "mux.db");
process.env.MUX_PORT = "1";
const { forgetPage, getPage, recall, search, wordScore, writePage } = await import("../src/brain.js");

test("word score: the title counts more than the body, and every query word counts", () => {
  const p = { title: "Qwen crashes with a long context", subject: "qwen3.6-35b-a3b", tags: ["metal"], body: "The Mac Studio runs out of memory." };
  assert.equal(wordScore("qwen context", p), 1);
  assert.equal(wordScore("memory", p), 0.6);
  assert.equal(wordScore("banana", p), 0);
  assert.equal(wordScore("", p), 0);
  // A question's filler words do not dilute it, in English or Danish.
  assert.ok(wordScore("why does qwen crash with a long context?", p) > 0.9);
  assert.ok(wordScore("hvorfor crasher qwen?", p) >= 0.5);
});

test("pages are written, found, updated by title instead of copied, and forgotten", async () => {
  const a = await writePage({ title: "Nexus uses the agent route", kind: "decision", subject: "nexus", body: "Nexus's agents call `agent`, because it keeps tool calls on Qwen.", tags: ["routing"] });
  assert.equal(a.id, "nexus-uses-the-agent-route");
  assert.equal(a.embedded, false);
  await writePage({ title: "Rummand prefers Danish answers", kind: "preference", body: "Answer in Danish." });

  const hits = await search("which route does nexus use");
  assert.equal(hits[0].id, a.id);
  assert.ok(!(await search("danish", { kind: "decision" })).length);

  const b = await writePage({ title: "nexus uses the AGENT route", kind: "decision", body: "Changed: now `smart`." });
  assert.equal(b.id, a.id);
  assert.equal(getPage(a.id)!.body, "Changed: now `smart`.");
  assert.equal(b.created_at, a.created_at);

  const r = await recall("nexus agent route");
  assert.deepEqual(r.pages.map((p) => p.id), [a.id]);
  assert.match(r.block, /Changed: now `smart`/);
  assert.equal(getPage(a.id)!.recalls, 1);

  assert.equal(forgetPage(a.id), true);
  assert.equal(getPage(a.id), undefined);
  assert.match((await recall("nexus agent route")).block, /Nothing in the brain/);
});

test("a page needs a title; an unknown kind is a note", async () => {
  await assert.rejects(writePage({ title: " ", body: "x" }), /title/);
  assert.equal((await writePage({ title: "Odd", kind: "gossip", body: "x" })).kind, "note");
});
