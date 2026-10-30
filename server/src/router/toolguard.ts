import { randomBytes } from "node:crypto";
import type { Completion } from "./chat.js";

/**
 * Forced tools, kept as a promise (ported from Nexus's tool guard, ~/.nexus/tool-guard.py). A caller that forces a tool
 * — `tool_choice: {type: "function", function: {name}}` or `"required"` — counts on getting a call back. Measured on
 * this Mac with Qwen3.6, neither llama.cpp nor mlx-lm keeps that promise on its own (0/5 and 3/5), but llama.cpp's
 * JSON-schema output is a grammar the sampler cannot leave (6/6). So a forced request is asked as a JSON answer — the
 * tool's parameters for a named tool, one of {name, arguments} per tool for `required` — and the answer is handed back
 * as an ordinary OpenAI `tool_calls` message.
 */
export interface Tool { type: "function"; function: { name: string; description?: string; parameters?: Record<string, unknown> } }
interface Body { messages?: { role: string; content?: unknown }[]; tools?: Tool[]; tool_choice?: unknown; [k: string]: unknown }

export function forcedTools(body: Body): Tool[] | null {
  const tools = (body.tools ?? []).filter((t) => t?.type === "function" && t.function?.name);
  const choice = body.tool_choice;
  if (!tools.length || choice == null || choice === "auto" || choice === "none") return null;
  if (typeof choice === "object") {
    const name = (choice as { function?: { name?: string }; name?: string }).function?.name ?? (choice as { name?: string }).name;
    const named = tools.filter((t) => t.function.name === name);
    return named.length ? named : null;
  }
  return choice === "required" ? tools : null;
}

const paramsOf = (t: Tool) => (t.function.parameters && typeof t.function.parameters === "object" ? t.function.parameters : { type: "object", properties: {} });

function schemaFor(tools: Tool[]) {
  if (tools.length === 1) return paramsOf(tools[0]);
  return { anyOf: tools.map((t) => ({ type: "object", properties: { name: { const: t.function.name }, arguments: paramsOf(t) }, required: ["name", "arguments"], additionalProperties: false })) };
}

/** The tool list last seen for a system prompt: a round that forces one tool keeps the same note, so the prompt cache holds. */
const lists = new Map<string, string>();

export function guarded(body: Body, tools: Tool[]): Body {
  const names = tools.map((t) => `\`${t.function.name}\``).join(", ");
  const how = tools.length === 1 ? `Answer by calling ${names}: reply with only its arguments as JSON.`
    : `Answer by calling one of ${names}: reply with only JSON of the form {"name": ..., "arguments": {...}}.`;
  const messages = [...(body.messages ?? [])];
  const system = messages[0]?.role === "system" && typeof messages[0].content === "string" ? messages[0].content : null;
  const every = (body.tools ?? []).filter((t) => t?.type === "function" && t.function?.name);
  let listed = "Tools:\n" + every.map((t) => `- ${t.function.name}: ${t.function.description ?? ""}`.trimEnd()).join("\n");
  if (system !== null) {
    if (every.length > 1) {
      lists.set(system, listed);
      if (lists.size > 32) lists.delete(lists.keys().next().value!);
    } else listed = lists.get(system) ?? listed;
  }
  messages.splice(system !== null ? 1 : 0, 0, { role: "system", content: listed });
  messages.push({ role: "user", content: how });
  const { tools: _t, tool_choice: _c, parallel_tool_calls: _p, stream: _s, stream_options: _o, ...rest } = body;
  return { ...rest, messages, response_format: { type: "json_schema", json_schema: { name: "tool", schema: schemaFor(tools), strict: true } } };
}


/** The JSON answer, as the tool call that was asked for. Throws when it does not fit. */
export function asToolCall(answer: Completion, tools: Tool[]): Completion {
  const choice = answer.choices?.[0] ?? { message: {} };
  const data = JSON.parse(String(choice.message?.content ?? "").trim());
  const [name, args] = tools.length === 1 ? [tools[0].function.name, data] : [data.name, data.arguments];
  if (!tools.some((t) => t.function.name === name)) throw new Error(`the answer named a tool that was not offered: ${name}`);
  return {
    ...answer,
    choices: [{ ...choice, finish_reason: "tool_calls", message: { role: "assistant", content: null, tool_calls: [{ id: `call_${randomBytes(12).toString("hex")}`, type: "function", function: { name, arguments: JSON.stringify(args) } }] } }],
  };
}

/** A native answer that is a real call to an offered tool, with arguments that parse. */
export function isGoodNativeCall(answer: Completion, tools: Tool[]): boolean {
  const calls = (answer.choices?.[0]?.message?.tool_calls ?? []) as { function?: { name?: string; arguments?: string } }[];
  if (!calls.length) return false;
  const offered = new Set(tools.map((t) => t.function.name));
  try { return calls.every((c) => offered.has(c.function?.name ?? "") && (JSON.parse(c.function?.arguments || "{}"), true)); } catch { return false; }
}
