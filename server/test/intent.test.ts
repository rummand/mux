import { test } from "node:test";
import assert from "node:assert/strict";

const { parse, prompt, conversation, choices } = await import("../src/router/intent.js");
const { upsertRoute, upsertModel, getModel } = await import("../src/models.js");
const { isRouterModel } = await import("../src/router/select.js");

test("Arch-Router's answer: the named route, if it is one of ours", () => {
  const names = new Set(["code", "agent", "multilingual"]);
  assert.equal(parse('{"route": "code"}', names), "code");
  assert.equal(parse("{'route': 'agent'}", names), "agent");
  assert.equal(parse('```json\n{"route": "multilingual"}\n```', names), "multilingual");
  assert.equal(parse('{"route": "other"}', names), null);
  assert.equal(parse('{"route": "travel"}', names), null);
  assert.equal(parse("I think code", names), null);
});

test("the conversation it reads: user and assistant text, the last six, long ones kept as start and end", () => {
  const long = `${"a".repeat(2000)}MIDDLE${"z".repeat(2000)}`;
  const c = conversation([{ role: "system", content: "sys" }, ...Array.from({ length: 8 }, (_, i) => ({ role: i % 2 ? "assistant" : "user", content: `m${i}` })), { role: "tool", content: "x" }, { role: "user", content: long }]);
  assert.equal(c.length, 6);
  assert.ok(c.every((m) => m.role !== "system" && m.role !== "tool"));
  const last = c[c.length - 1].content;
  assert.ok(last.length < 1300 && last.startsWith("aaa") && last.endsWith("zzz") && !last.includes("MIDDLE"));
});

test("it chooses among described chat routes, not auto, System One or vision; the prompt carries them", () => {
  upsertRoute({ name: "auto", kind: "chat", strategy: "auto", candidates: [], description: "mux picks" });
  upsertRoute({ name: "code", kind: "chat", strategy: "priority", candidates: [], description: "Coding agents and code questions" });
  upsertRoute({ name: "multilingual", kind: "chat", strategy: "priority", candidates: [], description: "Danish and other languages" });
  upsertRoute({ name: "vision", kind: "chat", strategy: "priority", candidates: [], description: "Images" });
  upsertRoute({ name: "embed", kind: "embedding", strategy: "priority", candidates: [], description: "Embeddings" });
  const names = choices().map((r) => r.name);
  assert.deepEqual(names.sort(), ["code", "multilingual"]);
  const p = prompt(choices(), [{ role: "user", content: "fix my bug" }]);
  // the standard routes' intents stand in for their descriptions; a route's own intent wins
  assert.match(p, /"name":"code","description":"Programming: writing/);
  upsertRoute({ name: "code", kind: "chat", strategy: "priority", candidates: [], description: "Coding agents and code questions", intent: "Only Rust" });
  assert.match(prompt(choices(), [{ role: "user", content: "x" }]), /"name":"code","description":"Only Rust"/);
  assert.match(p, /fix my bug/);
  assert.match(p, /\{"route": "route_name"\}/);
});

test("Arch-Router answers no chat: it is left out of every pool, here or on a node", () => {
  upsertModel({ id: "arch-router", backend: "llamacpp", kind: "chat", path: "/x.gguf" });
  upsertModel({ id: "mac-studio/arch-router", backend: "node", kind: "chat", provider_id: "mac-studio", upstream_model: "arch-router" });
  upsertModel({ id: "qwen-x", backend: "llamacpp", kind: "chat", path: "/q.gguf" });
  assert.ok(isRouterModel(getModel("arch-router")!, ""));
  assert.ok(isRouterModel(getModel("mac-studio/arch-router")!, ""));
  assert.ok(!isRouterModel(getModel("qwen-x")!, "arch-router"));
});
