import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import Fastify from "fastify";

// Turn stats and priority (server/src/speed.ts, priority.ts, runtime/slots.ts), with fakes: no model runs.
const { classify, parseStages, parsePriority, shouldPauseCi } = await import("../src/priority.js");
const { SlotGate, QueueTimeout } = await import("../src/runtime/slots.js");
const { slotsOf } = await import("../src/runtime/manager.js");
const { shapeFor } = await import("../src/router/chat.js");
const { db, settings } = await import("../src/db.js");
const { pruneTurns, registerSpeed, pct } = await import("../src/speed.js");
const { upsertTenant, createKey } = await import("../src/tenants.js");
const { upsertModel } = await import("../src/models.js");
const { saveProvider } = await import("../src/providers.js");
const { registerGateway } = await import("../src/api/gateway.js");

const rules = settings().priorityRules;

test("priority: the caller's header first, then the rules (Bloom's live and batch agents, Record live and batch, voice), else normal", () => {
  const c = (w: Partial<Parameters<typeof classify>[0]>) => classify({ tenant: "x", endpoint: "openai.chat", ...w }, rules).priority;
  assert.equal(c({ tenant: "bloom-for-business", agent: "bloom-for-business" }), "interactive");
  assert.equal(c({ tenant: "bloom-for-business", agent: "bloom-library-ask" }), "interactive");
  assert.equal(c({ tenant: "bloom-for-business", agent: "bloom-note-writer-3" }), "background");
  assert.equal(c({ tenant: "bloom-for-business", agent: "bloom-library-index-2", endpoint: "openai.embeddings" }), "background");
  assert.equal(c({ tenant: "bloom-for-business", agent: "bloom-desk-research" }), "normal");
  assert.equal(c({ tenant: "bloom-for-business", agent: "bloom-note-writer-1", header: "interactive" }), "interactive"); // the header wins
  assert.equal(c({ tenant: "bloom-for-business", header: "background" }), "background");
  assert.equal(c({ tenant: "rec", agent: "record", tags: ["record", "live-pins"] }), "interactive");
  assert.equal(c({ tenant: "rec", agent: "record", tags: ["record", "summarise"] }), "background");
  assert.equal(c({ tenant: "gateway-railway", endpoint: "realtime.chat" }), "interactive");
  assert.equal(c({ tenant: "nexus", tags: ["ci"] }), "background");
  assert.equal(c({ tenant: "opencode" }), "normal");
  assert.equal(parsePriority("LOW"), "background");
  assert.equal(parsePriority("whatever"), null);
});

test("x-mux-stage: Server-Timing, pairs or JSON; junk is dropped", () => {
  assert.deepEqual(parseStages("prompt_build;dur=120.44, retrieval;desc=\"r\";dur=40"), { prompt_build: 120.4, retrieval: 40 });
  assert.deepEqual(parseStages("prompt_build=120;retrieval=40"), { prompt_build: 120, retrieval: 40 });
  assert.deepEqual(parseStages('{"prompt_build": 7, "bad": "x"}'), { prompt_build: 7 });
  assert.equal(parseStages("nothing here"), null);
  assert.equal(parseStages(undefined), null);
});

test("CI pauses for an open voice session (when set) and for Record's live work", () => {
  assert.deepEqual(shouldPauseCi({ recordBusy: false, voiceSessions: 0, pauseForVoice: true }), { pause: false, why: "" });
  assert.equal(shouldPauseCi({ recordBusy: false, voiceSessions: 1, pauseForVoice: true }).pause, true);
  assert.equal(shouldPauseCi({ recordBusy: false, voiceSessions: 1, pauseForVoice: false }).pause, false);
  assert.equal(shouldPauseCi({ recordBusy: true, voiceSessions: 0, pauseForVoice: true }).why, "Record's live work");
});

function fakeGate(enabled = true, opts: { maxWait?: number; timeout?: number } = {}) {
  let now = 0;
  const g = new SlotGate({ enabled: () => enabled, backgroundMaxWaitMs: () => opts.maxWait ?? 60_000, timeoutMs: () => opts.timeout ?? 0, now: () => now });
  return { g, advance: (ms: number) => { now += ms; } };
}
const settled = async <T>(p: Promise<T>) => { let done = false; void p.then(() => { done = true; }, () => { done = true; }); await new Promise((r) => setImmediate(r)); return done; };

test("slots: on a 2-slot model one slot is kept for a person; batch waits for the reserve, a person takes it at once", async () => {
  const { g } = fakeGate();
  const b1 = await g.take("qwen", 2, 1, "background");
  assert.equal(b1.waitMs, 0);
  const b2 = g.take("qwen", 2, 1, "background");
  assert.equal(await settled(b2), false); // the second slot is reserved
  const i1 = await g.take("qwen", 2, 1, "interactive");
  assert.equal(i1.concurrent, 1);
  g.give("qwen", "interactive");
  assert.equal(await settled(b2), false); // still only one slot for batch while b1 runs
  g.give("qwen", "background");
  const b2g = await b2;
  assert.ok(b2g.reasons.includes("slot reserved for interactive"));
});

test("slots: a queued person goes before queued batch and normal work; background yields while a person's turn runs, then ages in", async () => {
  const { g, advance } = fakeGate(true, { maxWait: 5_000 });
  await g.take("m", 2, 0, "normal");
  await g.take("m", 2, 0, "normal");
  const order: string[] = [];
  const n = g.take("m", 2, 0, "normal").then(() => order.push("normal"));
  const b = g.take("m", 2, 0, "background").then(() => order.push("background"));
  const i = g.take("m", 2, 0, "interactive").then(() => order.push("interactive"));
  g.give("m", "normal");
  await i;
  assert.deepEqual(order, ["interactive"]);
  g.give("m", "normal");
  await n;
  assert.deepEqual(order, ["interactive", "normal"]);
  // One slot is free now, but a person's turn runs: background yields...
  g.give("m", "normal");
  assert.equal(await settled(b), false);
  assert.deepEqual(g.snapshot().m.waiting, { interactive: 0, normal: 0, background: 1 });
  // ...until it has waited its most, then it goes as normal (never starves)
  advance(6_000);
  g.poke(); // the gate looks again each second on its own; here, at once
  await b;
  assert.deepEqual(order, ["interactive", "normal", "background"]);
});

test("slots: a caller that hangs up leaves the queue; a queue timeout is refused; priority off is first come, first served", async () => {
  const { g } = fakeGate(true, { timeout: 30 });
  await g.take("x", 1, 0, "normal");
  const ac = new AbortController();
  const gone = g.take("x", 1, 0, "normal", ac.signal);
  ac.abort();
  await assert.rejects(gone, (e: Error) => e.name === "AbortError");
  await assert.rejects(g.take("x", 1, 0, "interactive"), (e: Error) => e instanceof QueueTimeout);
  assert.equal(g.snapshot().x.waiting.interactive, 0);

  const off = fakeGate(false).g;
  await off.take("y", 2, 1, "background");
  await off.take("y", 2, 1, "background"); // no reserve when priority is off
  const order: string[] = [];
  const b = off.take("y", 2, 1, "background").then(() => order.push("background"));
  const i = off.take("y", 2, 1, "interactive").then(() => order.push("interactive"));
  off.give("y", "background");
  await b;
  off.give("y", "background");
  await i;
  assert.deepEqual(order, ["background", "interactive"]);
});

test("slots measured: a person's first wait under a background load, priority on vs off (fakes, real timers)", async () => {
  // Two slots, a background load that keeps both busy with 120 ms jobs; a person asks every 50 ms.
  async function run(enabled: boolean) {
    const g = new SlotGate({ enabled: () => enabled, backgroundMaxWaitMs: () => 60_000, timeoutMs: () => 0 });
    let stop = false;
    const worker = async () => { while (!stop) { await g.take("q", 2, 1, "background"); await new Promise((r) => setTimeout(r, 120)); g.give("q", "background"); } };
    const workers = [worker(), worker(), worker(), worker()];
    const waits: number[] = [];
    for (let k = 0; k < 6; k++) {
      await new Promise((r) => setTimeout(r, 50));
      const t = await g.take("q", 2, 1, "interactive");
      waits.push(t.waitMs);
      await new Promise((r) => setTimeout(r, 30));
      g.give("q", "interactive");
    }
    stop = true;
    await Promise.all(workers);
    return pct(waits, 0.9)!;
  }
  const on = await run(true), off = await run(false);
  assert.ok(on < 15, `priority on: a person waits ~0 ms (p90 ${on})`);
  assert.ok(off > 40, `priority off: a person waits behind batch (p90 ${off})`);
});

test("slots of a model: its parallel, or the --parallel / -np in its own flags", () => {
  const m = { parallel: 2, extra_args: [] as string[] } as never;
  assert.equal(slotsOf(m), 2);
  assert.equal(slotsOf({ parallel: 2, extra_args: ["-np", "4"] } as never), 4);
  assert.equal(slotsOf({ parallel: 0, extra_args: [] } as never), 1);
});

test("an interactive turn to a reasoning model is asked not to think; batch keeps thinking; a caller's own say is kept", () => {
  const body = { messages: [{ role: "user", content: "hi" }] };
  const m = { backend: "llamacpp", reasoning: "auto" } as const;
  assert.deepEqual(shapeFor({ priority: "interactive" }, m, body).chat_template_kwargs, { enable_thinking: false });
  assert.equal(shapeFor({ priority: "interactive" }, m, body).cache_prompt, true);
  assert.equal(shapeFor({ priority: "background" }, m, body).chat_template_kwargs, undefined);
  assert.deepEqual(shapeFor({ priority: "interactive" }, m, { ...body, chat_template_kwargs: { enable_thinking: true } }).chat_template_kwargs, { enable_thinking: true });
  assert.equal(shapeFor({ priority: "interactive" }, { backend: "llamacpp", reasoning: "off" }, body).chat_template_kwargs, undefined);
  assert.equal(shapeFor({ priority: "interactive" }, { backend: "external", reasoning: "auto" }, body), body);
});

/* ── A whole turn through the gateway, against a fake model server ─────────────────────────────────────────── */

const seen: { headers: IncomingMessage["headers"]; body: Record<string, unknown> }[] = [];
const upstream = createServer(async (req, res) => {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const body = JSON.parse(Buffer.concat(chunks).toString() || "{}");
  seen.push({ headers: req.headers, body });
  res.writeHead(200, { "content-type": "text/event-stream" });
  const ev = (o: unknown) => res.write(`data: ${JSON.stringify(o)}\n\n`);
  await new Promise((r) => setTimeout(r, 15));
  ev({ choices: [{ index: 0, delta: { role: "assistant", content: "Hello" } }] });
  ev({ choices: [{ index: 0, delta: { content: " there" }, finish_reason: "stop" }] });
  ev({ choices: [], usage: { prompt_tokens: 120, completion_tokens: 2, prompt_tokens_details: { cached_tokens: 100 } }, timings: { prompt_n: 20, prompt_ms: 33.3, cache_n: 100, predicted_n: 2, predicted_per_second: 80 } });
  res.end("data: [DONE]\n\n");
});
await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", r));
const upUrl = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
after(() => upstream.close());

upsertTenant({ id: "bloom-for-business", name: "bloom (speed test)" });
upsertTenant({ id: "speed-other", name: "another tenant" });
upsertModel({ id: "fake-chat", backend: "external", kind: "chat", base_url: `${upUrl}/v1`, upstream_model: "fake" });
saveProvider({ id: "speed-node", name: "the mac (fake)", kind: "mux", base_url: upUrl, api_key: "node-key", enabled: true, status: "online" });
upsertModel({ id: "speed-node/qwen", backend: "node", kind: "chat", provider_id: "speed-node", upstream_model: "qwen" });
const app = Fastify();
registerGateway(app);
const admin = Fastify();
registerSpeed(admin);
after(() => { void app.close(); void admin.close(); });
const bloomKey = createKey("bloom-for-business", "t").key;
const otherKey = createKey("speed-other", "t").key;

test("a turn's row: class, trace, stages, the person hashed, the breakdown (prompt cache, prefill, TTFT, tokens/s); no words kept", async () => {
  const r = await app.inject({
    method: "POST", url: "/v1/chat/completions",
    headers: { authorization: `Bearer ${bloomKey}`, "x-mux-trace": "bloom-turn-1", "x-mux-stage": "prompt_build;dur=42", "x-mux-user": "anna@example.test", "x-mux-agent": "bloom-for-business" },
    payload: { model: "fake-chat", stream: true, messages: [{ role: "user", content: "a secret question" }] },
  });
  assert.equal(r.statusCode, 200);
  assert.equal(r.headers["x-mux-priority"], "interactive");
  const row = db.prepare("SELECT * FROM turn_stats WHERE trace = ?").get("bloom-turn-1") as Record<string, unknown>;
  assert.equal(row.priority, "interactive");
  assert.equal(row.tenant_id, "bloom-for-business");
  assert.equal(row.model_id, "fake-chat");
  assert.equal(row.prompt_tokens, 120);
  assert.equal(row.cached_tokens, 100);
  assert.equal(row.prefill_ms, 33.3);
  assert.equal(row.tps, 80);
  assert.ok(Number(row.ttft_ms) >= 10 && Number(row.total_ms) >= Number(row.ttft_ms));
  assert.deepEqual(JSON.parse(String(row.stages)), { prompt_build: 42 });
  assert.match(String(row.user_hash), /^[0-9a-f]{16}$/);
  assert.ok(!JSON.stringify(row).includes("secret") && !JSON.stringify(row).includes("anna"));
  assert.equal(typeof row.loaded, "number"); // what else was going on
});

test("a gateway tells the node the class and the trace (its request id when the caller sent none), and passes the stages on", async () => {
  seen.length = 0;
  const r = await app.inject({
    method: "POST", url: "/v1/chat/completions",
    headers: { authorization: `Bearer ${otherKey}`, "x-mux-priority": "background", "x-mux-stage": "prep=5" },
    payload: { model: "speed-node/qwen", stream: true, messages: [{ role: "user", content: "hi" }] },
  });
  assert.equal(r.statusCode, 200);
  const h = seen[0].headers;
  assert.equal(h["x-mux-priority"], "background");
  assert.equal(h["x-mux-trace"], r.headers["x-mux-request-id"]);
  assert.equal(h["x-mux-stage"], "prep=5");
  assert.equal(seen[0].body.chat_template_kwargs, undefined); // a node shapes for its own models
});

test("the Speed API: percentiles per tenant/route/model/class, the slowest turns, one turn with what competed, a trace, live slots", async () => {
  for (let k = 0; k < 3; k++) await app.inject({ method: "POST", url: "/v1/chat/completions", headers: { authorization: `Bearer ${otherKey}` }, payload: { model: "fake-chat", stream: true, messages: [{ role: "user", content: "x" }] } });
  const s = (await admin.inject({ url: "/speed?window=hour" })).json();
  assert.ok(s.totals.n >= 4);
  assert.ok(s.byPriority.interactive.n >= 1 && s.byPriority.normal.n >= 3);
  const g = s.groups.find((x: { tenant: string; priority: string }) => x.tenant === "speed-other" && x.priority === "normal");
  assert.ok(g.ttft.p50 > 0 && g.ttft.p90 >= g.ttft.p50 && g.ttft.p99 >= g.ttft.p90);
  assert.ok(s.slowest.length >= 4 && Array.isArray(s.series));
  const id = s.slowest[0].id;
  const one = (await admin.inject({ url: `/speed/turns/${id}` })).json();
  assert.equal(one.turn.id, id);
  assert.ok(Array.isArray(one.others) && Array.isArray(one.ci) && Array.isArray(one.samples));
  const tr = (await admin.inject({ url: "/speed/trace/bloom-turn-1" })).json();
  assert.equal(tr.length, 1);
  const live = (await admin.inject({ url: "/speed/live" })).json();
  assert.ok("slots" in live && Array.isArray(live.hot) && live.priority.enabled === false); // off until a node turns it on (deploy/speed.sh)
  assert.equal((await admin.inject({ url: "/speed/turns/nope" })).statusCode, 404);
});

test("turn stats are kept 30 days", () => {
  db.prepare("INSERT INTO turn_stats(id, ts, started, endpoint, priority) VALUES(?, ?, ?, 'openai.chat', 'normal')").run("old-turn", Date.now() - 31 * 86400_000, Date.now() - 31 * 86400_000);
  db.prepare("INSERT INTO turn_stats(id, ts, started, endpoint, priority) VALUES(?, ?, ?, 'openai.chat', 'normal')").run("new-turn", Date.now() - 29 * 86400_000, Date.now() - 29 * 86400_000);
  assert.ok(pruneTurns(30) >= 1);
  assert.equal((db.prepare("SELECT COUNT(*) n FROM turn_stats WHERE id = 'old-turn'").get() as { n: number }).n, 0);
  assert.equal((db.prepare("SELECT COUNT(*) n FROM turn_stats WHERE id = 'new-turn'").get() as { n: number }).n, 1);
});

test("a voice turn's own marks are a row: interactive, its session as the trace, end of speech → first token and first audio", async () => {
  const { recordRealtimeTurn } = await import("../src/speed.js");
  recordRealtimeTurn({ tenant: "bloom-for-business", user: "u1", session: "rt_test", llm: "qwen", via: "node", metrics: { response_id: "resp_1", turn: 1, status: "completed", speech_end_to_turn_ms: 280, speech_end_to_first_token_ms: 560, speech_end_to_first_audio_ms: 900 } });
  const row = db.prepare("SELECT * FROM turn_stats WHERE id = 'rt_test:resp_1'").get() as Record<string, unknown>;
  assert.equal(row.endpoint, "realtime.turn");
  assert.equal(row.priority, "interactive");
  assert.equal(row.trace, "rt_test");
  assert.equal(row.ttft_ms, 560);
  assert.equal(row.total_ms, 900);
  assert.equal(JSON.parse(String(row.realtime)).speech_end_to_turn_ms, 280);
});

test("voice: the answer's first clause is spoken at once; later ones wait for whole sentences; 1,200 is not cut", async () => {
  const { SentenceSplitter } = await import("../src/realtime/sentences.js");
  const s = new SentenceSplitter(80, 24);
  assert.deepEqual(s.push("You have two meetings today, "), ["You have two meetings today,"]);
  assert.deepEqual(s.push("one at ten, one after lunch. And"), ["one at ten, one after lunch."]);
  const n = new SentenceSplitter(80, 10);
  assert.deepEqual(n.push("Revenue was 1,200 euros, "), ["Revenue was 1,200 euros,"]);
  assert.deepEqual(new SentenceSplitter().push("You have two meetings today, one at ten"), []);
});

test("the first answer token is the TTFT; a model's thinking before it is counted apart", async () => {
  seen.length = 0;
  const think = createServer(async (req, res) => {
    for await (const _ of req) { /* the body */ }
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { reasoning_content: "hmm" } }] })}\n\n`);
    await new Promise((r) => setTimeout(r, 60));
    res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "Yes." }, finish_reason: "stop" }] })}\n\n`);
    res.end("data: [DONE]\n\n");
  });
  await new Promise<void>((r) => think.listen(0, "127.0.0.1", r));
  upsertModel({ id: "fake-thinker", backend: "external", kind: "chat", base_url: `http://127.0.0.1:${(think.address() as AddressInfo).port}/v1`, upstream_model: "t" });
  await app.inject({ method: "POST", url: "/v1/chat/completions", headers: { authorization: `Bearer ${otherKey}`, "x-mux-trace": "thinker-1" }, payload: { model: "fake-thinker", stream: true, messages: [{ role: "user", content: "?" }] } });
  think.close();
  const row = db.prepare("SELECT reasoning_ms, ttft_ms FROM turn_stats WHERE trace = 'thinker-1'").get() as { reasoning_ms: number; ttft_ms: number };
  assert.ok(row.reasoning_ms < 50 && row.ttft_ms >= 55, `thinking at ${row.reasoning_ms} ms, the answer at ${row.ttft_ms} ms`);
});
