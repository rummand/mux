import { test } from "node:test";
import assert from "node:assert/strict";
import { fromOpenAI, StreamTranslator, toOpenAI } from "../src/api/anthropic.js";
import { asToolCall, forcedTools, guarded } from "../src/router/toolguard.js";
import { features } from "../src/router/select.js";
import { checkSystemOne } from "../src/router/systemone.js";

test("Anthropic → OpenAI: system, tool_use, tool_result, images, tool_choice", () => {
  const o = toOpenAI({
    model: "claude-x", max_tokens: 100, system: [{ type: "text", text: "Be brief." }],
    tools: [{ name: "get", description: "d", input_schema: { type: "object", properties: {} } }], tool_choice: { type: "any" },
    messages: [
      { role: "user", content: [{ type: "text", text: "hi" }, { type: "image", source: { type: "base64", media_type: "image/png", data: "AAA" } }] },
      { role: "assistant", content: [{ type: "text", text: "calling" }, { type: "tool_use", id: "t1", name: "get", input: { a: 1 } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "42" }, { type: "text", text: "thanks" }] },
    ],
  });
  assert.equal(o.messages[0].content, "Be brief.");
  assert.deepEqual((o.messages[1].content as { type: string }[]).map((p) => p.type), ["text", "image_url"]);
  assert.equal((o.messages[2].tool_calls as { function: { arguments: string } }[])[0].function.arguments, '{"a":1}');
  assert.deepEqual([o.messages[3].role, o.messages[3].tool_call_id, o.messages[3].content], ["tool", "t1", "42"]);
  assert.equal(o.messages[4].content, "thanks");
  assert.equal(o.tool_choice, "required");
});

test("OpenAI → Anthropic: tool calls become tool_use with parsed input", () => {
  const a = fromOpenAI({ choices: [{ message: { content: null, tool_calls: [{ id: "c", function: { name: "f", arguments: '{"x":2}' } }] }, finish_reason: "tool_calls" }], usage: { prompt_tokens: 5, completion_tokens: 3 } }, "m");
  assert.equal(a.stop_reason, "tool_use");
  assert.deepEqual(a.content, [{ type: "tool_use", id: "c", name: "f", input: { x: 2 } }]);
});

test("stream translator opens and closes blocks in order", () => {
  const ev: string[] = [];
  const t = new StreamTranslator("m", (e) => ev.push(e));
  t.chunk({ choices: [{ delta: { content: "He" } }] });
  t.chunk({ choices: [{ delta: { content: "y" } }] });
  t.chunk({ choices: [{ delta: { tool_calls: [{ index: 0, id: "a", function: { name: "f", arguments: "{}" } }] }, finish_reason: "tool_calls" }] });
  t.end(1, 2);
  assert.deepEqual(ev, ["message_start", "content_block_start", "content_block_delta", "content_block_delta", "content_block_stop", "content_block_start", "content_block_delta", "content_block_stop", "message_delta", "message_stop"]);
});

test("tool guard: a named tool becomes a JSON schema answer and back", () => {
  const tools = [{ type: "function" as const, function: { name: "retire", parameters: { type: "object", properties: { name: { type: "string" } } } } }];
  const body = { messages: [{ role: "system", content: "S" }, { role: "user", content: "go" }], tools, tool_choice: { type: "function", function: { name: "retire" } } };
  const f = forcedTools(body)!;
  assert.equal(f.length, 1);
  const g = guarded(body, f);
  assert.equal((g.response_format as { type: string }).type, "json_schema");
  assert.equal(g.tools, undefined);
  const call = asToolCall({ choices: [{ message: { content: '{"name":"Maximo"}' } }] }, f);
  assert.equal(call.choices[0].finish_reason, "tool_calls");
  assert.equal((call.choices[0].message.tool_calls as { function: { name: string } }[])[0].function.name, "retire");
  assert.equal(forcedTools({ ...body, tool_choice: "auto" }), null);
});

test("features: Danish, code, tools", () => {
  assert.ok(features({ messages: [{ role: "user", content: "Hvordan nulstiller jeg min adgangskode?" }] }).danish);
  assert.ok(features({ messages: [{ role: "user", content: "Fix this:\n```py\ndef f(): pass\n```" }] }).code);
  const f = features({ messages: [{ role: "user", content: "hi" }], tools: [{}], tool_choice: "required" });
  assert.ok(f.tools && f.forcedTool && !f.simple);
});

test("System One requests are checked the one way", () => {
  assert.equal(checkSystemOne({ state: "s", questions: { q: { type: "choice", instructions: "i", criteria: { a: "", b: "" } } } }), null);
  assert.match(checkSystemOne({ state: "s", questions: [] }) ?? "", /keyed by question id/);
  assert.match(checkSystemOne({ state: "s", questions: { q: { type: "score", instructions: "i", criteria: ["x"] } } }) ?? "", /ordered levels/);
});
