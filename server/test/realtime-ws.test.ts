import { test, after } from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import WebSocket from "ws";
import { db, saveSettings } from "../src/db.js";
import { createKey, upsertTenant } from "../src/tenants.js";
import { registerRealtime, keyOf, nodeSocketUrl } from "../src/realtime/server.js";
import { INPUT_RATE } from "../src/realtime/audio.js";
import { saveProvider, type Provider } from "../src/providers.js";
import { upsertModel, upsertRoute } from "../src/models.js";

/** A real socket against a real listener, with fake model stages (no model is needed). */
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
function tone(ms: number, level = 0.3): Buffer {
  const n = Math.round((INPUT_RATE * ms) / 1000);
  const b = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) b.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 220 * i) / INPUT_RATE) * level * 32767), i * 2);
  return b;
}

upsertTenant({ id: "rt-bloom", name: "bloom (test)" });
upsertTenant({ id: "rt-other", name: "someone else" });
upsertTenant({ id: "rt-gateway", name: "the gateway's tenant on the node" });
const bloomKey = createKey("rt-bloom", "test").key;
const otherKey = createKey("rt-other", "test").key;
const gwKey = createKey("rt-gateway", "test").key;
saveSettings({ realtimeTenants: ["rt-bloom", "rt-gateway"], realtimeMaxSessions: 10 });

const llmAsked: (string | undefined)[] = [];
const fakes = () => ({
  thinker: { stream: async (r: { model?: string }, _s: AbortSignal, onText: (d: string) => void) => { llmAsked.push(r.model); onText("Two meetings. "); onText("Both after lunch."); return { text: "Two meetings. Both after lunch.", toolCalls: [], usage: { prompt_tokens: 12, completion_tokens: 7 }, coldStart: false }; } },
  speaker: { speak: async () => ({ pcm: Buffer.alloc(4800), rate: 24_000 }) },
  transcriber: { transcribe: async (pcm: Buffer) => (pcm.length > 8000 ? "What is on today?" : "") },
  leadMs: 1e9,
});

const node = Fastify();
registerRealtime(node, { deps: fakes });
await node.listen({ port: 0, host: "127.0.0.1" });
const nodeUrl = `http://127.0.0.1:${(node.server.address() as { port: number }).port}`;

// A gateway in front of it, as Railway is in front of the Mac: it knows the node's models as mac/<model>, and its own
// route "agent" starts with a cloud model, then the node's qwen-test
saveProvider({ id: "mac", name: "mac-studio", kind: "mux", base_url: nodeUrl, api_key: gwKey, enabled: true, status: "online" });
upsertModel({ id: "cloud/big", backend: "external", kind: "chat", base_url: "https://example.invalid/v1", upstream_model: "big" });
upsertModel({ id: "mac/qwen-test", backend: "node", kind: "chat", provider_id: "mac", upstream_model: "qwen-test" });
upsertRoute({ name: "agent", kind: "chat", strategy: "priority", candidates: ["cloud/big", "mac/qwen-test"] });
const gateway = Fastify();
registerRealtime(gateway, { relayTo: () => ({ id: "mac", name: "mac-studio", kind: "mux", base_url: nodeUrl, api_key: gwKey, enabled: true, status: "online" } as Provider) });
await gateway.listen({ port: 0, host: "127.0.0.1" });
const gwUrl = `http://127.0.0.1:${(gateway.server.address() as { port: number }).port}`;
after(async () => { await node.close(); await gateway.close(); });

const sock = (base: string, headers: Record<string, string> = {}, protocols?: string[]) => new WebSocket(nodeSocketUrl(base), protocols, { headers });

/** Open a socket and collect what it is sent; resolves once open, or with the refusal's status. */
function open(ws: WebSocket): Promise<{ events: Record<string, unknown>[]; status?: number; body?: string }> {
  const events: Record<string, unknown>[] = [];
  ws.on("message", (d, binary) => { if (!binary) events.push(JSON.parse(String(d))); });
  return new Promise((res) => {
    ws.once("open", () => res({ events }));
    ws.once("unexpected-response", (_req, r) => { let body = ""; r.on("data", (c) => { body += c; }); r.on("end", () => res({ events, status: r.statusCode, body })); });
  });
}
async function until(events: Record<string, unknown>[], type: string, ms = 3000) {
  for (let t = 0; t < ms; t += 10) { const e = events.find((x) => x.type === type); if (e) return e; await wait(10); }
  throw new Error(`no ${type} within ${ms} ms; got ${events.map((e) => e.type).join(", ")}`);
}

/** A spoken turn as a browser sends it: 20 ms binary frames of speech, then silence (the energy VAD ends the turn). */
async function sayIt(ws: WebSocket) {
  const audio = Buffer.concat([Buffer.alloc(6400), tone(700), Buffer.alloc(32000)]);
  for (let o = 0; o < audio.length; o += 640) ws.send(audio.subarray(o, o + 640), { binary: true });
}

test("who may open a voice session: a key, of a tenant on the list; never a key in the address", async () => {
  const none = await open(sock(nodeUrl));
  assert.equal(none.status, 401);
  const other = await open(sock(nodeUrl, { authorization: `Bearer ${otherKey}` }));
  assert.equal(other.status, 403);
  assert.match(other.body!, /realtimeTenants/);
  const wrongPath = await open(new WebSocket(`${nodeUrl.replace("http", "ws")}/v1/realtime/x`, { headers: { authorization: `Bearer ${bloomKey}` } }));
  assert.equal(wrongPath.status, 404);
  // A browser cannot set headers: the key rides as a subprotocol, and the answer names only mux.realtime.v1
  const ws = sock(nodeUrl, {}, ["mux.realtime.v1", `mux-key.${bloomKey}`]);
  const ok = await open(ws);
  assert.equal(ok.status, undefined);
  assert.equal(ws.protocol, "mux.realtime.v1");
  ws.close();
  assert.equal(keyOf({ headers: { "sec-websocket-protocol": "mux.realtime.v1, mux-key.abc" } } as never), "abc");
  assert.equal(keyOf({ headers: { "x-api-key": "k2" } } as never), "k2");
});

test("a whole spoken turn over a real socket: binary audio in, words, text, speech and metrics out; the session is recorded", async () => {
  const ws = sock(nodeUrl, { authorization: `Bearer ${bloomKey}`, "x-mux-user": "anna" });
  const { events } = await open(ws);
  ws.send(JSON.stringify({ type: "session.start", instructions: "You are Bloom.", hearing: "energy" }));
  const created = await until(events, "session.created");
  assert.equal(created.hearing, "energy");
  await sayIt(ws);
  assert.equal((await until(events, "transcript.final")).text, "What is on today?");
  const done = await until(events, "response.done");
  assert.equal(done.status, "completed");
  assert.ok(events.some((e) => e.type === "response.audio.delta" && e.sample_rate === 24000));
  const m = await until(events, "metrics");
  assert.equal(typeof m.speech_end_to_first_audio_ms, "number");
  assert.equal(typeof m.speech_end_to_turn_ms, "number");
  ws.send(JSON.stringify({ type: "session.end" }));
  const ended = await until(events, "session.ended");
  assert.equal(ended.turns, 1);
  await wait(50);
  const row = db.prepare("SELECT * FROM realtime_sessions WHERE tenant_id = 'rt-bloom' AND turns = 1 ORDER BY ts DESC").get() as Record<string, unknown>;
  assert.equal(row.end_user, "anna");
  assert.equal(row.engine, "cascade");
  assert.ok((row.input_ms as number) > 1000);
  const req = db.prepare("SELECT * FROM requests WHERE tenant_id = 'rt-bloom' AND endpoint = 'realtime.session' ORDER BY ts DESC").get() as Record<string, unknown>;
  assert.equal(req.body_req, null, "nothing said in a session is kept");
});

test("one voice session per person: a second session of the same person ends the first; another person's is untouched", async () => {
  const a1 = sock(nodeUrl, { authorization: `Bearer ${bloomKey}` });
  const e1 = (await open(a1)).events;
  a1.send(JSON.stringify({ type: "session.start", user: "bo", hearing: "energy" }));
  await until(e1, "session.created");
  const c = sock(nodeUrl, { authorization: `Bearer ${bloomKey}` });
  const ec = (await open(c)).events;
  c.send(JSON.stringify({ type: "session.start", user: "cy", hearing: "energy" }));
  await until(ec, "session.created");
  const a2 = sock(nodeUrl, { authorization: `Bearer ${bloomKey}` });
  const e2 = (await open(a2)).events;
  a2.send(JSON.stringify({ type: "session.start", user: "bo", hearing: "energy" }));
  await until(e2, "session.created");
  assert.match(String((await until(e1, "session.ended")).reason), /replaced by a newer session/);
  await wait(50);
  assert.equal(ec.some((e) => e.type === "session.ended"), false);
  // Errors are events, and the session goes on
  c.send("not json");
  assert.equal((await until(ec, "error")).code, "invalid_json");
  for (const w of [a2, c]) w.close();
});

test("through a gateway: frames pass both ways, the person is named per tenant on the node, and tokens are metered at the gateway", async () => {
  const ws = sock(gwUrl, { authorization: `Bearer ${bloomKey}` });
  const { events } = await open(ws);
  ws.send(JSON.stringify({ type: "session.start", user: "dee", hearing: "energy", llm: "agent" }));
  await until(events, "session.created");
  await sayIt(ws);
  const done = await until(events, "response.done");
  assert.deepEqual(done.usage, { prompt_tokens: 12, completion_tokens: 7 });
  // The gateway chose bloom's LLM by its own route, and named it to the node as the node's model
  assert.equal(llmAsked.at(-1), "qwen-test");
  ws.close();
  await wait(150);
  // The node ran the session as the gateway's tenant, for "rt-bloom:dee"
  const onNode = db.prepare("SELECT * FROM realtime_sessions WHERE tenant_id = 'rt-gateway' ORDER BY ts DESC").get() as Record<string, unknown>;
  assert.equal(onNode.end_user, "rt-bloom:dee");
  // The gateway charged bloom's tenant for the turn's tokens, and kept the session's seconds
  const turn = db.prepare("SELECT * FROM requests WHERE tenant_id = 'rt-bloom' AND endpoint = 'realtime.turn' ORDER BY ts DESC").get() as Record<string, unknown>;
  assert.equal(turn.prompt_tokens, 12);
  assert.equal(turn.completion_tokens, 7);
  const atGw = db.prepare("SELECT * FROM realtime_sessions WHERE tenant_id = 'rt-bloom' AND node = 'mac-studio' ORDER BY ts DESC").get() as Record<string, unknown>;
  assert.equal(atGw.prompt_tokens, 12);
  assert.equal(typeof atGw.seconds, "number");
  assert.equal(atGw.engine, "cascade");
});

test("through a gateway: an LLM with no model on the node is refused before the session starts", async () => {
  upsertRoute({ name: "cloud-only", kind: "chat", strategy: "priority", candidates: ["cloud/big"] });
  const ws = sock(gwUrl, { authorization: `Bearer ${bloomKey}` });
  const { events } = await open(ws);
  ws.send(JSON.stringify({ type: "session.start", llm: "cloud-only" }));
  const err = await until(events, "error");
  assert.equal(err.code, "llm_unavailable");
  assert.match(String(err.message), /none of its models is on mac-studio/);
});

test("a gateway with no node online says so on the socket", async () => {
  const lonely = Fastify();
  registerRealtime(lonely, { relayTo: () => null });
  await lonely.listen({ port: 0, host: "127.0.0.1" });
  const url = `http://127.0.0.1:${(lonely.server.address() as { port: number }).port}`;
  const ws = sock(url, { authorization: `Bearer ${bloomKey}` });
  const { events } = await open(ws);
  assert.equal((await until(events, "error")).code, "realtime_unavailable");
  await lonely.close();
});
