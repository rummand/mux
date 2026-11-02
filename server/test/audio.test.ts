import { test } from "node:test";
import assert from "node:assert/strict";
import { formField } from "../src/router/audio.js";

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
