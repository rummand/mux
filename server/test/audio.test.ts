import { test } from "node:test";
import assert from "node:assert/strict";
import { byVoice, formField, voicesOf } from "../src/router/audio.js";

test("the model of a transcription is read from the form, as OpenAI's clients send it", () => {
  const b = "----x1";
  const part = (head: string, value: string) => `--${b}\r\n${head}\r\n\r\n${value}\r\n`;
  const body = Buffer.concat([
    Buffer.from(part('Content-Disposition: form-data; name="language"', "da") + part('Content-Disposition: form-data; name="model"', "roest-v3")),
    Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="file"; filename="a.wav"\r\nContent-Type: audio/wav\r\n\r\n`),
    Buffer.from([0, 255, 13, 10, 13, 10, 1]),
    Buffer.from(`\r\n--${b}--\r\n`),
  ]);
  assert.equal(formField(body, `multipart/form-data; boundary=${b}`, "model"), "roest-v3");
  assert.equal(formField(body, `multipart/form-data; boundary="${b}"`, "language"), "da");
  assert.equal(formField(body, `multipart/form-data; boundary=${b}`, "file"), undefined);
  assert.equal(formField(body, `multipart/form-data; boundary=${b}`, "prompt"), undefined);
  assert.equal(formField(body, "application/json", "model"), undefined);
});

test("a voice asked for by name goes to the model that has it; models listing other voices are left out", () => {
  const piper = { id: "piper-da", caps: { speed: 10, voices: ["da_DK-talesyntese-medium"] } };
  const kokoro = { id: "bloom-kokoro-en", caps: { voices: ["af_heart"] } };
  const other = { id: "other", caps: {} };
  const route = [piper, kokoro, other];
  assert.deepEqual(byVoice(route, "af_heart").map((m) => m.id), ["bloom-kokoro-en", "other"]);
  assert.deepEqual(byVoice(route, "da_DK-talesyntese-medium").map((m) => m.id), ["piper-da", "other"]);
  // No voice, or one no model lists (OpenAI's "alloy"): the route's own order, unchanged
  assert.equal(byVoice(route, undefined), route);
  assert.equal(byVoice(route, "alloy"), route);
  assert.equal(byVoice(route, ""), route);
  assert.deepEqual(voicesOf(other), null);
  assert.deepEqual(voicesOf({ caps: { voices: ["a", 3] } as never }), ["a"]);
});
