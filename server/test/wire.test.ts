import { test } from "node:test";
import assert from "node:assert/strict";

const { wireMessages } = await import("../src/assistant.js");

test("the model reads the same text turn after turn: context only on the latest question, old tool results cut", () => {
  const big = "x".repeat(5000);
  const msgs = [
    { role: "user" as const, content: "first" },
    { role: "assistant" as const, content: null, tool_calls: [{ id: "c1", type: "function" as const, function: { name: "mux_api", arguments: "{}" } }] },
    { role: "tool" as const, tool_call_id: "c1", content: big },
    { role: "assistant" as const, content: "answer one" },
    { role: "user" as const, content: "second" },
    { role: "assistant" as const, content: null, tool_calls: [{ id: "c2", type: "function" as const, function: { name: "mux_api", arguments: "{}" } }] },
    { role: "tool" as const, tool_call_id: "c2", content: big },
  ];
  const w = wireMessages(msgs, "", "\n\n---\nmux context");
  assert.equal(w[0].content, "first"); // no context on earlier questions: the prefix stays the same
  assert.ok((w[2].content as string).length < 1300); // an earlier turn's result: cut
  assert.equal(w[4].content, "second\n\n---\nmux context");
  assert.equal((w[6].content as string).length, 5000); // this turn's result: whole
});
