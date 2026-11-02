import { test } from "node:test";
import assert from "node:assert/strict";

const { asActor, entries, journal } = await import("../src/journal.js");
const { upsertRoute } = await import("../src/models.js");
const { writePage } = await import("../src/brain.js");

test("the owner's own changes are not journaled; mux's are, with before and after", async () => {
  upsertRoute({ name: "agent", kind: "chat", strategy: "priority", candidates: ["a"] }); // the owner, from the dashboard
  assert.equal(entries().length, 0);
  asActor("experiments", () => upsertRoute({ name: "agent", candidates: ["b", "a"] }));
  const [e] = entries();
  assert.equal(e.actor, "experiments");
  assert.equal(e.kind, "route");
  assert.match(e.title, /Route agent: b first/);
  assert.deepEqual((e.before as { candidates: string[] }).candidates, ["a"]);
  assert.deepEqual((e.after as { candidates: string[] }).candidates, ["b", "a"]);
});

test("an actor carries through async work, and brain writes say who wrote them", async () => {
  await asActor("brain-keeper", async () => { await new Promise((r) => setTimeout(r, 5)); await writePage({ title: "Nexus stays local", kind: "decision", body: "Owner's rule." }); });
  const e = entries({ kind: "brain" })[0];
  assert.equal(e.actor, "brain-keeper");
  assert.match(e.title, /wrote “Nexus stays local”/);
  journal({ kind: "x", title: "no actor" });
  assert.equal(entries({ kind: "x" }).length, 0);
  assert.equal(entries({ actor: "brain-keeper" }).length, 1);
});
