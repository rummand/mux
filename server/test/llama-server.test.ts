import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const { config } = await import("../src/config.js");
const { llamaServerFor } = await import("../src/runtime/manager.js");
const model = (server_bin?: string) => ({ id: "m", server_bin: server_bin ?? null }) as never;

test("a model's own llama-server: only one under ~/.mux/llama.cpp/, else the shared build", () => {
  const dir = join(config.home, "llama.cpp", "b1");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "llama-server"), "");
  assert.equal(llamaServerFor(model()), config.llamaServer);
  assert.equal(llamaServerFor(model(join(dir, "llama-server"))), join(dir, "llama-server"));
  assert.throws(() => llamaServerFor(model("/bin/sh")), /must be under/);
  assert.throws(() => llamaServerFor(model(join(dir, "..", "..", "llama-server"))), /must be under/);
  assert.throws(() => llamaServerFor(model(join(config.home, "llama.cpp", "b2", "llama-server"))), /not on disk/);
});
