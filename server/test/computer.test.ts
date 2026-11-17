import { test } from "node:test";
import assert from "node:assert/strict";

test("computer: each action becomes Peekaboo's own arguments, passed as they are (no shell)", async () => {
  const { actionArgs } = await import("../src/computer.js");
  assert.deepEqual(actionArgs({ action: "click", element: "elem_12", snapshot_id: "ps1_" + "a".repeat(32), app: "Safari" }), ["click", "--on", "elem_12", "--snapshot", "ps1_" + "a".repeat(32), "--app", "Safari"]);
  assert.deepEqual(actionArgs({ action: "click", text: "Address and search bar", app: "Safari", window_id: "12345" }), ["click", "Address and search bar", "--app", "Safari", "--window-id", "12345"]);
  assert.deepEqual(actionArgs({ action: "double_click", at: "100,200", snapshot_id: "ps1_x" }), ["click", "--at", "100,200", "--snapshot", "ps1_x", "--double"]);
  assert.deepEqual(actionArgs({ action: "type", text: "hello; rm -rf ~", app: "TextEdit", foreground: true }), ["type", "hello; rm -rf ~", "--app", "TextEdit", "--foreground"]);
  assert.deepEqual(actionArgs({ action: "hotkey", keys: "cmd, shift, t", app: "Safari", foreground: true }), ["press", "cmd+shift+t", "--app", "Safari", "--foreground"]);
  assert.deepEqual(actionArgs({ action: "press", key: "return", app: "Safari", foreground: true }), ["press", "return", "--app", "Safari", "--foreground"]);
  assert.deepEqual(actionArgs({ action: "scroll", direction: "down", element: "table_1", snapshot_id: "ps1_x" }), ["scroll", "--direction", "down", "--amount", "3", "--on", "table_1", "--snapshot", "ps1_x"]);
  assert.deepEqual(actionArgs({ action: "scroll", direction: "sideways", amount: 999 }), ["scroll", "--direction", "down", "--amount", "50", "--foreground"]);
  assert.deepEqual(actionArgs({ action: "menu", app: "Safari", path: "File > New Window" }), ["menu", "click", "--app", "Safari", "--path", "File > New Window"]);
  assert.deepEqual(actionArgs({ action: "launch", app: "Notes" }), ["app", "launch", "Notes", "--foreground", "--wait-ready"]);
  assert.deepEqual(actionArgs({ action: "open_url", url: "https://github.com" }), ["app", "launch", "Safari", "--open", "https://github.com", "--foreground"]);
  assert.match(String(actionArgs({ action: "open_url", url: "file:///etc/passwd" })), /http\(s\)/);
  assert.match(String(actionArgs({ action: "click" })), /needs element/);
  assert.match(String(actionArgs({ action: "shell", text: "ls" })), /no action shell/);
});

test("computer: a UI map keeps ids, roles and labels of what can be acted on", async () => {
  const { compactSee } = await import("../src/computer.js");
  const out = compactSee({ success: true, data: { snapshot_id: "ps1_1", application_name: "Safari", window_title: "GitHub", ui_elements: [
    { id: "elem_1", role: "AXButton", label: "Back", is_actionable: true, bounds: { x: 1 }, extra: "dropped" },
    { id: "elem_2", role: "AXStaticText", label: "Hello", is_actionable: false },
  ] } }) as { snapshot_id: string; app: string; elements: Record<string, unknown>[] };
  assert.equal(out.snapshot_id, "ps1_1");
  assert.equal(out.app, "Safari");
  assert.deepEqual(out.elements, [{ id: "elem_1", role: "AXButton", label: "Back", is_actionable: true, bounds: { x: 1 } }]);
});

test("computer: looking runs at once, acting waits for the owner; only Ask mux gets the tools, never the doctor or the keeper", async () => {
  const { isChange, toolsFor, runTool } = await import("../src/assistant.js");
  assert.equal(isChange("computer_act", { action: "click" }), true);
  assert.equal(isChange("computer_look", {}), false);
  assert.equal(isChange("computer_list", {}), false);
  const names = (agent: string) => toolsFor(agent).map((t) => t.function.name);
  for (const agent of ["doctor", "brain-keeper"]) assert.ok(!names(agent).some((n) => n.startsWith("computer_")), agent);
  // Even a call that names the tool is refused for an agent that runs on its own
  const call = { id: "1", type: "function" as const, function: { name: "computer_look", arguments: "{}" } };
  for (const source of ["doctor", "brain-keeper"]) {
    const out = JSON.parse(await runTool({} as never, call, () => undefined, source));
    assert.match(out.error, /only for the owner's Ask mux/);
  }
  // Ask mux on a machine without Peekaboo (this test runs on Linux): a plain refusal, nothing run
  const out = JSON.parse(await runTool({} as never, call, () => undefined, "assistant"));
  assert.match(out.error, /Peekaboo is not installed|gateway/);
});
