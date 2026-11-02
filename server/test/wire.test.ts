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

test("the loop: denials and copies of the old canned correction are left out of what the model reads", () => {
  const msgs = [
    { role: "user" as const, content: "Do you have a brain?" },
    { role: "assistant" as const, content: "No. I have no memory between sessions." },
    { role: "user" as const, content: "What's next" },
    { role: "assistant" as const, content: "Yes — I have a brain. My brain is GBrain 0.60.552.0, on the node Mac Studio: 9 pages so far." },
    { role: "user" as const, content: "Run all three" },
  ];
  const w = wireMessages(msgs, "", "");
  assert.deepEqual(w.map((m) => m.role), ["user", "user", "user"]);
  assert.equal(w[2].content, "Run all three");
});

test("speech: the form's model becomes the upstream's, the audio untouched", async () => {
  const { setFormField, formField } = await import("../src/router/audio.js");
  const b = "----x9";
  const audio = Buffer.from([0, 255, 13, 10, 45, 45, 1, 2]);
  const body = Buffer.concat([Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="model"\r\n\r\nwhisper-turbo\r\n--${b}\r\nContent-Disposition: form-data; name="file"; filename="a.wav"\r\nContent-Type: audio/wav\r\n\r\n`), audio, Buffer.from(`\r\n--${b}--\r\n`)]);
  const ct = `multipart/form-data; boundary=${b}`;
  const out = setFormField(body, ct, "model", "whisper-large-v3-turbo");
  assert.equal(formField(out, ct, "model"), "whisper-large-v3-turbo");
  assert.ok(out.includes(audio));
  const none = Buffer.concat([Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="file"; filename="a.wav"\r\n\r\n`), audio, Buffer.from(`\r\n--${b}--\r\n`)]);
  assert.equal(formField(setFormField(none, ct, "model", "w"), ct, "model"), "w");
});
