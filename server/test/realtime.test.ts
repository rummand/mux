import { test } from "node:test";
import assert from "node:assert/strict";
import { INPUT_RATE, parseWav, resample, rms, wavOf } from "../src/realtime/audio.js";
import { SentenceSplitter, clean } from "../src/realtime/sentences.js";
import { EnergyVad, type HearEvent, type Hearing } from "../src/realtime/vad.js";
import { Session, type SessionDeps } from "../src/realtime/session.js";
import { ProtocolError, parseClient, type ServerEvent } from "../src/realtime/protocol.js";
import { gatherCalls } from "../src/realtime/adapters.js";
import type { DuplexEvent, Message, Thinker, ToolCall } from "../src/realtime/stages.js";

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** pcm16 at 16 kHz: a tone (speech, for the energy VAD) or silence. */
function tone(ms: number, rate = INPUT_RATE, level = 0.3): Buffer {
  const n = Math.round((rate * ms) / 1000);
  const b = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) b.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 220 * i) / rate) * level * 32767), i * 2);
  return b;
}
const silence = (ms: number, rate = INPUT_RATE) => Buffer.alloc(Math.round((rate * ms) / 1000) * 2);

/* ---------------------------------------------------------------- the pieces */

test("sentences: cut as they stream, not at abbreviations or decimals; markdown is not spoken", () => {
  const s = new SentenceSplitter();
  assert.deepEqual(s.push("You have two meet"), []);
  assert.deepEqual(s.push("ings today. The first, e.g. the stand-up, is at 9.30 "), ["You have two meetings today."]);
  assert.deepEqual(s.push("sharp! Then **lunch**"), ["The first, e.g. the stand-up, is at 9.30 sharp!"]);
  assert.deepEqual(s.flush(), ["Then lunch"]);
  assert.deepEqual(s.flush(), []);
  // A newline ends a sentence too (a list); a long clause may end at a colon
  assert.deepEqual(new SentenceSplitter().push("- first item\n- second"), ["first item"]);
  const long = new SentenceSplitter(20);
  assert.deepEqual(long.push("Here is what I found in your invoices: three are overdue "), ["Here is what I found in your invoices:"]);
  assert.equal(clean("See [the plan](https://x.y) and `code` ## now"), "See the plan and code now");
});

test("WAV: written and read back; a streamed header (size unknown), float32 and stereo are read", () => {
  const pcm = tone(100, 24_000);
  const w = wavOf(pcm, 24_000);
  const back = parseWav(w);
  assert.equal(back.rate, 24_000);
  assert.deepEqual(back.pcm, pcm);
  // A server that streams writes 0xFFFFFFFF (or 0) as the data size: the data runs to the end
  const streamed = Buffer.from(w);
  streamed.writeUInt32LE(0xffffffff, 40);
  assert.equal(parseWav(streamed).pcm.length, pcm.length);
  // A LIST chunk before data, float32 stereo
  const frames = 4;
  const fmt = Buffer.alloc(24); fmt.write("fmt ", 0); fmt.writeUInt32LE(16, 4); fmt.writeUInt16LE(3, 8); fmt.writeUInt16LE(2, 10); fmt.writeUInt32LE(8000, 12); fmt.writeUInt32LE(8000 * 8, 16); fmt.writeUInt16LE(8, 20); fmt.writeUInt16LE(32, 22);
  const list = Buffer.alloc(12); list.write("LIST", 0); list.writeUInt32LE(4, 4); list.write("INFO", 8);
  const data = Buffer.alloc(8 + frames * 8); data.write("data", 0); data.writeUInt32LE(frames * 8, 4);
  for (let i = 0; i < frames; i++) { data.writeFloatLE(0.5, 8 + i * 8); data.writeFloatLE(-0.5, 12 + i * 8); }
  const head = Buffer.alloc(12); head.write("RIFF", 0); head.write("WAVE", 8);
  const f = parseWav(Buffer.concat([head, fmt, list, data]));
  assert.equal(f.rate, 8000);
  assert.equal(f.pcm.length, frames * 2);
  assert.equal(f.pcm.readInt16LE(0), 0); // left and right cancel
  assert.throws(() => parseWav(Buffer.from("not a wav file at all")), /not a WAV/);
  assert.equal(resample(tone(1000, 24_000), 24_000, 16_000).length, 16_000 * 2);
  assert.ok(rms(tone(20)) > 0.2 && rms(silence(20)) === 0);
});

test("energy VAD: speech starts after its start delay, ends at the last voiced frame, and the turn ends after the silence", () => {
  const ev: HearEvent[] = [];
  const v = new EnergyVad((e) => ev.push(e), { turnMs: 600 });
  v.push(silence(500));
  v.push(tone(30)); // a click: too short to be speech
  v.push(silence(300));
  v.push(tone(800));
  // In odd-sized pieces, as a network delivers them
  const tail = silence(1000);
  for (let o = 0; o < tail.length; o += 998) v.push(tail.subarray(o, o + 998));
  assert.deepEqual(ev.map((e) => e.type), ["speech_start", "speech_end", "turn_end"]);
  const start = ev[0] as { atMs: number }, end = ev[1] as { atMs: number }, turn = ev[2] as { atMs: number };
  assert.ok(Math.abs(start.atMs - 840) <= 20, `speech starts at the tone (840 ms), not when it was decided: ${start.atMs}`);
  assert.ok(Math.abs(end.atMs - 1640) <= 20, `speech ends at the tone's end (1640 ms): ${end.atMs}`);
  assert.equal(turn.atMs, end.atMs);
});

test("protocol: events are checked and refused in the caller's terms", () => {
  assert.equal(parseClient('{"type":"session.start","voice":"af_heart"}').type, "session.start");
  assert.throws(() => parseClient("nope"), (e: unknown) => e instanceof ProtocolError && e.code === "invalid_json");
  assert.throws(() => parseClient('{"type":"audio.append"}'), (e: unknown) => e instanceof ProtocolError && e.code === "unknown_event");
  assert.throws(() => parseClient('{"type":"session.start","input_audio_format":"opus"}'), (e: unknown) => e instanceof ProtocolError && e.code === "unsupported_audio_format");
  assert.throws(() => parseClient('{"type":"tool.result","output":1}'), /call_id/);
  assert.throws(() => parseClient('{"type":"input.text","text":"  "}'), /needs text/);
});

test("tool calls streamed in fragments are put together by index, several in one answer", () => {
  const g = gatherCalls("rt_x");
  g.add([{ index: 0, id: "call_a", function: { name: "find_", arguments: '{"q":' } }]);
  g.add([{ index: 1, function: { name: "send", arguments: "" } }, { index: 0, function: { name: "invoice", arguments: '"late"}' } }]);
  assert.deepEqual(g.list(), [{ id: "call_a", name: "find_invoice", arguments: '{"q":"late"}' }, { id: "call_rt_x_1", name: "send", arguments: "{}" }]);
});

/* ---------------------------------------------------------------- the session, with fakes */

class FakeHearing implements Hearing {
  readonly name = "fake";
  emit!: (e: HearEvent) => void;
  pushed = 0;
  constructor(readonly transcribes = false) {}
  push(pcm: Buffer) { this.pushed += pcm.length; }
  close() {}
}

interface Script { deltas: string[]; toolCalls?: ToolCall[]; gapMs?: number }
class FakeThinker implements Thinker {
  calls: { messages: Message[]; aborted: () => boolean }[] = [];
  constructor(private scripts: Script[]) {}
  async stream(req: { messages: Message[] }, signal: AbortSignal, onText: (d: string) => void) {
    this.calls.push({ messages: structuredClone(req.messages), aborted: () => signal.aborted });
    const s = this.scripts.shift() ?? { deltas: ["Okay."] };
    let text = "";
    for (const d of s.deltas) {
      if (s.gapMs) await wait(s.gapMs);
      if (signal.aborted) throw Object.assign(new Error("aborted"), { name: "AbortError" });
      text += d;
      onText(d);
    }
    return { text, toolCalls: s.toolCalls ?? [], usage: { prompt_tokens: 10, completion_tokens: 5 }, coldStart: false };
  }
}

function harness(o: { scripts?: Script[]; transcript?: string; hearing?: FakeHearing; speakMs?: number; deps?: Partial<SessionDeps> } = {}) {
  const events: ServerEvent[] = [];
  const hearing = o.hearing ?? new FakeHearing();
  const thinker = new FakeThinker(o.scripts ?? []);
  const spoken: string[] = [];
  let closed = "";
  const s = new Session({
    send: (e) => events.push(e),
    close: (r) => { closed = r; },
    thinker,
    speaker: { speak: async (text, _voice, signal) => {
      spoken.push(text);
      if (o.speakMs) await wait(o.speakMs);
      if (signal.aborted) throw new Error("aborted");
      return { pcm: tone(300, 24_000), rate: 24_000 };
    } },
    transcriber: { transcribe: async () => o.transcript ?? "What is on my calendar today?" },
    hearing: () => (emit) => { hearing.emit = emit; return hearing; },
    leadMs: 1e9, // no pacing in these tests: speech is sent as fast as it is made
    ...o.deps,
  });
  const of = (type: string) => events.filter((e) => e.type === type);
  return { s, events, of, hearing, thinker, spoken, closed: () => closed };
}

/** The caller says something: audio, then the hearing's events for it. */
async function speak(h: ReturnType<typeof harness>, ms = 600) {
  h.s.audio(tone(ms));
  h.hearing.emit({ type: "speech_start", atMs: h.s.inputMs - ms });
  h.hearing.emit({ type: "speech_end", atMs: h.s.inputMs });
  await wait(5);
  h.s.audio(silence(100));
  h.hearing.emit({ type: "turn_end", atMs: h.s.inputMs - 100, confidence: 0.9 });
}

test("a spoken turn: words, the LLM's text, its speech sentence by sentence, done, and the metrics in order", async () => {
  const h = harness({ scripts: [{ deltas: ["You have two ", "meetings. ", "The first is at nine."], gapMs: 3 }] });
  await h.s.handle({ type: "session.start", instructions: "You are Bloom.", messages: [{ role: "user", content: "Hi" }, { role: "assistant", content: "Hello!" }] });
  const created = h.of("session.created")[0];
  assert.equal(created.engine, "cascade");
  assert.deepEqual(created.input_audio, { format: "pcm16", sample_rate: 16000, channels: 1, frame_ms: 20, binary_frames: true });
  await speak(h);
  await h.s.settled();
  assert.deepEqual(h.of("transcript.final").map((e) => e.text), ["What is on my calendar today?"]);
  assert.equal(h.of("response.text.delta").map((e) => e.delta).join(""), "You have two meetings. The first is at nine.");
  assert.deepEqual(h.spoken, ["You have two meetings.", "The first is at nine."]);
  assert.ok(h.of("response.audio.delta").length >= 6, "each sentence's speech in 100 ms pieces");
  const a = h.of("response.audio.delta")[0];
  assert.equal(a.sample_rate, 24000);
  assert.equal(Buffer.from(a.audio as string, "base64").length, 4800);
  const done = h.of("response.done")[0];
  assert.equal(done.status, "completed");
  assert.deepEqual(done.usage, { prompt_tokens: 10, completion_tokens: 5 });
  // The LLM saw Bloom's instructions, the conversation so far and the new turn
  assert.deepEqual(h.thinker.calls[0].messages.map((m) => m.role), ["system", "user", "assistant", "user"]);
  const m = h.of("metrics")[0] as Record<string, number | null | boolean>;
  for (const k of ["speech_end_to_turn_ms", "speech_end_to_transcript_ms", "speech_end_to_first_token_ms", "speech_end_to_first_audio_ms"]) assert.equal(typeof m[k], "number", k);
  assert.ok((m.speech_end_to_turn_ms as number) >= 5, "the turn is decided after the speech ended (the hangover is not hidden)");
  assert.ok((m.speech_end_to_turn_ms as number) <= (m.speech_end_to_transcript_ms as number));
  assert.ok((m.speech_end_to_transcript_ms as number) <= (m.speech_end_to_first_token_ms as number));
  assert.ok((m.speech_end_to_first_token_ms as number) <= (m.speech_end_to_first_audio_ms as number));
  assert.equal(m.cold_start, false);
  // The order a caller sees
  const order = h.events.map((e) => e.type).filter((t) => !t.endsWith(".delta"));
  assert.deepEqual(order, ["session.created", "vad.start", "vad.end", "turn.end", "transcript.final", "response.created", "response.done", "metrics"]);
});

test("barge-in: the caller's speech stops the LLM and the speech at once; the history keeps only what was heard", async () => {
  const h = harness({ scripts: [{ deltas: ["First sentence here. ", "Second one ", "is long ", "and slow. ", "Third."], gapMs: 25 }, { deltas: ["Sure."] }] });
  await h.s.handle({ type: "session.start" });
  await speak(h);
  // Wait until the first sentence is being spoken
  for (let i = 0; i < 100 && !h.of("response.audio.delta").length; i++) await wait(2);
  assert.ok(h.of("response.audio.delta").length, "speech started");
  const before = h.of("response.audio.delta").length;
  h.hearing.emit({ type: "speech_start", atMs: h.s.inputMs });
  // At once, in the same tick: the response is done, interrupted
  const done = h.of("response.done")[0];
  assert.equal(done.status, "interrupted");
  assert.equal(done.spoken_text, "First sentence here.");
  assert.equal(h.thinker.calls[0].aborted(), true, "the LLM stream is aborted");
  await wait(120);
  assert.equal(h.of("response.audio.delta").length, before, "no speech after the barge-in");
  assert.deepEqual(h.spoken, ["First sentence here."], "later sentences are never synthesised");
  assert.equal(h.of("metrics")[0].status, "interrupted");
  // The next turn builds on what was heard, not on what the LLM had planned
  h.s.audio(tone(300));
  h.hearing.emit({ type: "speech_end", atMs: h.s.inputMs });
  h.hearing.emit({ type: "turn_end", atMs: h.s.inputMs, confidence: 1 });
  await h.s.settled();
  const msgs = h.thinker.calls[1].messages;
  assert.deepEqual(msgs.slice(-3).map((m) => [m.role, m.content]), [["user", "What is on my calendar today?"], ["assistant", "First sentence here."], ["user", "What is on my calendar today?"]]);
});

test("barge-in can be turned off: the caller's speech then does not stop Bloom", async () => {
  const h = harness({ scripts: [{ deltas: ["One. ", "Two."], gapMs: 15 }] });
  await h.s.handle({ type: "session.start", barge_in: false });
  await speak(h);
  for (let i = 0; i < 100 && !h.of("response.created").length; i++) await wait(2);
  h.hearing.emit({ type: "speech_start", atMs: h.s.inputMs });
  await h.s.settled();
  assert.equal(h.of("response.done")[0].status, "completed");
});

test("tool calls go to the caller; its tool.result continues the answer", async () => {
  const call: ToolCall = { id: "call_1", name: "find_invoices", arguments: '{"status":"late"}' };
  const h = harness({ scripts: [{ deltas: ["Let me look. "], toolCalls: [call] }, { deltas: ["Three are late."] }] });
  await h.s.handle({ type: "session.start", tools: [{ type: "function", function: { name: "find_invoices", parameters: {} } }] });
  await h.s.handle({ type: "input.text", text: "Any late invoices?" });
  for (let i = 0; i < 100 && !h.of("tool.call").length; i++) await wait(2);
  const tc = h.of("tool.call")[0];
  assert.deepEqual([tc.call_id, tc.name, tc.arguments], ["call_1", "find_invoices", '{"status":"late"}']);
  await h.s.handle({ type: "tool.result", call_id: "call_1", output: { count: 3 } });
  await h.s.settled();
  const second = h.thinker.calls[1].messages;
  assert.deepEqual(second.slice(-2).map((m) => m.role), ["assistant", "tool"]);
  assert.deepEqual((second.at(-2)!.tool_calls as unknown[])[0], { id: "call_1", type: "function", function: { name: "find_invoices", arguments: '{"status":"late"}' } });
  assert.equal(second.at(-1)!.content, '{"count":3}');
  assert.equal(h.of("response.done")[0].text, "Let me look. Three are late.");
  assert.deepEqual(h.spoken, ["Let me look.", "Three are late."], "the short sentence before the tool is spoken while it runs");
  assert.deepEqual(h.of("response.done")[0].usage, { prompt_tokens: 20, completion_tokens: 10 });
  const m = h.of("metrics")[0];
  assert.equal(m.speech_end_to_first_audio_ms, null, "a typed turn has no speech end");
});

test("a tool that never answers times out into the conversation; a barge-in while waiting closes the call", async () => {
  const call: ToolCall = { id: "c9", name: "slow", arguments: "{}" };
  const h = harness({ scripts: [{ deltas: [], toolCalls: [call] }, { deltas: ["It did not answer."] }], deps: { toolTimeoutMs: 20 } });
  await h.s.handle({ type: "session.start" });
  await h.s.handle({ type: "input.text", text: "go" });
  await h.s.settled();
  assert.match(String(h.thinker.calls[1].messages.at(-1)!.content), /did not answer within/);

  const b = harness({ scripts: [{ deltas: [], toolCalls: [call] }, { deltas: ["Yes?"] }] });
  await b.s.handle({ type: "session.start" });
  await b.s.handle({ type: "input.text", text: "go" });
  for (let i = 0; i < 100 && !b.of("tool.call").length; i++) await wait(2);
  b.hearing.emit({ type: "speech_start", atMs: 0 });
  assert.equal(b.of("response.done")[0].status, "interrupted");
  await b.s.handle({ type: "input.text", text: "never mind" });
  await b.s.settled();
  const roles = b.thinker.calls[1].messages.map((m) => m.role);
  assert.deepEqual(roles, ["user", "assistant", "tool", "user"], "the open call got its result before the next turn");
  assert.match(String(b.thinker.calls[1].messages[2].content), /interrupted/);
  assert.equal(b.of("error").length, 0);
});

test("response.cancel stops the answer; auto_response false waits for Bloom's response.create with its own conversation", async () => {
  const h = harness({ scripts: [{ deltas: ["A ", "b ", "c ", "d."], gapMs: 20 }] });
  await h.s.handle({ type: "session.start" });
  await h.s.handle({ type: "input.text", text: "talk" });
  await wait(10);
  await h.s.handle({ type: "response.cancel" });
  assert.equal(h.of("response.done")[0].status, "cancelled");
  await h.s.settled();
  assert.equal(h.of("response.done").length, 1);

  const b = harness({ scripts: [{ deltas: ["Masked answer."] }] });
  await b.s.handle({ type: "session.start", auto_response: false });
  await speak(b);
  await b.s.settled();
  assert.equal(b.of("transcript.final").length, 1);
  assert.equal(b.of("response.created").length, 0, "no answer until Bloom asks");
  await b.s.handle({ type: "response.create", messages: [{ role: "user", content: "What is on my calendar for [PERSON_1]?" }] });
  await b.s.settled();
  assert.deepEqual(b.thinker.calls[0].messages, [{ role: "user", content: "What is on my calendar for [PERSON_1]?" }]);
  assert.equal(b.of("response.done")[0].status, "completed");
});

test("response.create say speaks Bloom's own sentence, with no LLM call", async () => {
  const h = harness();
  await h.s.handle({ type: "session.start" });
  await h.s.handle({ type: "response.create", say: "Let me pull your last *invoices*." });
  await h.s.settled();
  assert.equal(h.thinker.calls.length, 0);
  assert.deepEqual(h.spoken, ["Let me pull your last invoices."]);
  assert.equal(h.of("response.done")[0].status, "completed");
});

test("a hearing that transcribes as it listens: partial captions, then its final turn", async () => {
  const hearing = new FakeHearing(true);
  const h = harness({ hearing, scripts: [{ deltas: ["Noted."] }] });
  await h.s.handle({ type: "session.start" });
  h.s.audio(tone(400));
  hearing.emit({ type: "speech_start", atMs: 0 });
  hearing.emit({ type: "partial", text: "book a" });
  hearing.emit({ type: "speech_end", atMs: 400 });
  hearing.emit({ type: "turn_end", atMs: 400, confidence: 0.97 });
  hearing.emit({ type: "final", text: "Book a room." });
  await h.s.settled();
  assert.deepEqual(h.of("transcript.partial").map((e) => e.text), ["book a"]);
  assert.deepEqual(h.of("transcript.final").map((e) => e.text), ["Book a room."]);
  assert.equal(hearing.pushed, tone(400).length);
});

test("a duplex engine: its words and voice stream back as responses; vad events and metrics still come from the session", async () => {
  let push = 0;
  let onEvent!: (e: DuplexEvent) => void;
  const h = harness({ deps: { duplex: (name) => name === "haru-4b" ? async (_o, on) => { onEvent = on; return { name, rate: 24_000, canSpeak: true, push: () => { push++; }, speak: (t) => on({ type: "text", text: `[${t}]` }), close: () => undefined }; } : null } });
  await h.s.handle({ type: "session.start", model: "haru-4b", tools: [{ type: "function", function: { name: "x" } }] });
  assert.equal(h.of("session.created")[0].engine, "haru-4b");
  assert.deepEqual(h.of("session.created")[0].output_audio, { format: "pcm16", sample_rate: 24000, channels: 1 });
  assert.equal(h.of("error")[0].code, "tools_unsupported");
  // The caller speaks (the session's own energy VAD hears it), then the model answers
  h.s.audio(silence(300)); h.s.audio(tone(600)); h.s.audio(silence(1000));
  assert.ok(push >= 3, "every frame goes to the engine");
  assert.deepEqual(h.of("vad.start").length, 1);
  onEvent({ type: "audio", pcm: silence(133, 24_000), rate: 24_000 });
  assert.equal(h.of("response.created").length, 0, "silence from the model is not a response");
  onEvent({ type: "text", text: "Hi" });
  onEvent({ type: "audio", pcm: tone(133, 24_000), rate: 24_000 });
  for (let i = 0; i < 8; i++) onEvent({ type: "audio", pcm: silence(133, 24_000), rate: 24_000 });
  const done = h.of("response.done");
  assert.equal(done.length, 1);
  assert.equal(done[0].text, "Hi");
  assert.equal(typeof h.of("metrics")[0].speech_end_to_first_audio_ms, "number");
  // The forced-text experiment's door: response.create say
  await h.s.handle({ type: "response.create", say: "Three invoices are late." });
  assert.ok(h.of("response.text.delta").some((e) => e.delta === "[Three invoices are late.]"));
  h.s.stop("done");
  assert.equal(h.of("session.ended")[0].reason, "done");
});

test("a session that has not started refuses audio; session.end ends it with what it used", async () => {
  const h = harness({ scripts: [{ deltas: ["Fine."] }] });
  assert.throws(() => h.s.audio(tone(20)), /session.start/);
  await assert.rejects(h.s.handle({ type: "input.text", text: "x" }), /session.start/);
  await h.s.handle({ type: "session.start" });
  await h.s.handle({ type: "input.text", text: "hello" });
  await h.s.settled();
  await h.s.handle({ type: "session.end" });
  const end = h.of("session.ended")[0];
  assert.equal(end.reason, "ended by the caller");
  assert.equal(end.turns, 1);
  assert.deepEqual(end.usage, { prompt_tokens: 10, completion_tokens: 5 });
  assert.equal(h.closed(), "ended by the caller");
});

test("speech is paced: never more than leadMs ahead of real time, so a barge-in throws little away", async () => {
  let clock = 0;
  const slept: number[] = [];
  const h = harness({
    scripts: [{ deltas: ["One sentence of speech."] }],
    deps: { leadMs: 200, now: () => clock, sleep: async (ms) => { slept.push(ms); clock += ms; } },
  });
  await h.s.handle({ type: "session.start" });
  await h.s.handle({ type: "input.text", text: "go" });
  await h.s.settled();
  // 300 ms of speech in 100 ms pieces with a 200 ms lead: the third piece waits 100 ms
  assert.equal(h.of("response.audio.delta").length, 3);
  assert.deepEqual(slept, [100]);
});
