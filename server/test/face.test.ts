import { test } from "node:test";
import assert from "node:assert/strict";
import { WebSocketServer } from "ws";
import { INPUT_RATE } from "../src/realtime/audio.js";
import { Session, type SessionDeps } from "../src/realtime/session.js";
import { ProtocolError, parseClient, type ServerEvent } from "../src/realtime/protocol.js";
import { connectFace, parseFaceFrame } from "../src/realtime/adapters.js";
import type { Face, FaceEvent, FaceFactory, FaceMode, FaceOptions } from "../src/realtime/stages.js";

/* The talking face with a fake face stage: no model, no sidecar (docs/face.md). */

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
function tone(ms: number, rate = INPUT_RATE, level = 0.3): Buffer {
  const n = Math.round((rate * ms) / 1000);
  const b = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) b.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 220 * i) / rate) * level * 32767), i * 2);
  return b;
}

/**
 * A face that behaves as the sidecar does: a frame every 1000/fps ms of a response's audio, made once its 80 ms of
 * lookahead has arrived (after `lagMs`, as a renderer takes time), the rest at speech.end, then speech.done.
 */
class FakeFace implements Face {
  readonly info = { fps: 25, width: 384, height: 384, format: "jpeg" as const, identity: "bloom-test", model: "fake-face" };
  states: FaceMode[] = [];
  cancelled: string[] = [];
  closed = false;
  private heard = new Map<string, number>();
  private made = new Map<string, number>();
  private index = 0;
  constructor(public emit: (e: FaceEvent) => void, private lagMs = 5, private auto = true) {}
  state(mode: FaceMode) { this.states.push(mode); }
  speech(id: string, pcm: Buffer, rate: number) {
    this.heard.set(id, (this.heard.get(id) ?? 0) + (pcm.length / 2 / rate) * 1000);
    if (this.auto) setTimeout(() => this.render(id, false), this.lagMs);
  }
  speechEnd(id: string) {
    setTimeout(() => {
      this.render(id, true);
      if (!this.cancelled.includes(id)) this.emit({ type: "speech.done", done: { responseId: id, frames: this.made.get(id) ?? 0, audioMs: this.heard.get(id) ?? 0 } });
    }, this.lagMs);
  }
  cancel(id: string) { this.cancelled.push(id); }
  close() { this.closed = true; }
  frame(responseId: string | null, ptsMs: number, mode: FaceMode = responseId ? "speaking" : "idle") {
    this.emit({ type: "frame", frame: { responseId, index: this.index++, ptsMs, mode, format: "jpeg", image: Buffer.from([0xff, 0xd8, 0xff, 0xd9]) } });
  }
  private render(id: string, flush: boolean) {
    if (this.cancelled.includes(id)) return;
    const audio = this.heard.get(id) ?? 0;
    let n = this.made.get(id) ?? 0;
    while (n * 40 + (flush ? 0 : 80) < audio) { this.frame(id, n * 40); n++; }
    this.made.set(id, n);
  }
}

function harness(o: { face?: FaceFactory | null; sentences?: string[]; speakMs?: number; deps?: Partial<SessionDeps> } = {}) {
  const events: ServerEvent[] = [];
  let face: FakeFace | null = null;
  let factoryCalls = 0;
  const s = new Session({
    send: (e) => events.push(e),
    close: () => undefined,
    thinker: { stream: async (_r, signal, onText) => {
      let text = "";
      for (const d of o.sentences ?? ["You have two meetings. ", "The first is at nine."]) { await wait(3); if (signal.aborted) break; text += d; onText(d); }
      return { text, toolCalls: [], usage: { prompt_tokens: 1, completion_tokens: 1 }, coldStart: false };
    } },
    speaker: { speak: async (_t, _v, signal) => { if (o.speakMs) await wait(o.speakMs); if (signal.aborted) throw new Error("aborted"); return { pcm: tone(600, 24_000), rate: 24_000 }; } },
    transcriber: { transcribe: async () => "Hello?" },
    hearing: () => (emit) => { hear = emit; return { transcribes: false, name: "fake", push: () => undefined, close: () => undefined }; },
    face: o.face === undefined ? async (_opts, onEvent) => { factoryCalls++; face = new FakeFace(onEvent); return face; } : o.face,
    leadMs: 1e9,
    ...o.deps,
  });
  let hear!: (e: import("../src/realtime/vad.js").HearEvent) => void;
  return { s, events, of: (t: string) => events.filter((e) => e.type === t), face: () => face!, calls: () => factoryCalls, hear: (e: import("../src/realtime/vad.js").HearEvent) => hear(e) };
}

test("protocol: face is true, false or {size 256–512, fps 10–30, format jpeg|webp}", () => {
  assert.equal(parseClient('{"type":"session.start","face":true}').type, "session.start");
  assert.equal(parseClient('{"type":"session.start","face":{"size":384,"fps":25,"format":"webp"}}').type, "session.start");
  for (const bad of ['"yes"', '{"size":1024}', '{"fps":60}', '{"format":"png"}', "[]", "null"]) {
    assert.throws(() => parseClient(`{"type":"session.start","face":${bad}}`), (e: unknown) => e instanceof ProtocolError && e.code === "invalid_event", bad);
  }
});

test("opt-in only: without face the face is never started and no face event is sent", async () => {
  const h = harness();
  await h.s.handle({ type: "session.start" });
  await h.s.handle({ type: "input.text", text: "hi" });
  await h.s.settled();
  assert.equal(h.calls(), 0);
  assert.equal(h.of("session.created")[0].face, null);
  assert.equal(h.events.filter((e) => e.type.startsWith("face.")).length, 0);
  assert.ok(h.of("response.audio.delta").length > 0);
  h.s.stop("done");
  assert.equal("face_frames" in h.of("session.ended")[0], false);
});

test("a spoken answer with the face: face.ready, then speaking frames in order, never ahead of their audio, and face.metrics", async () => {
  const h = harness();
  await h.s.handle({ type: "session.start", face: { size: 384 } });
  assert.equal(h.of("session.created")[0].face, "starting");
  await h.s.settled();
  const ready = h.of("face.ready")[0];
  assert.deepEqual([ready.fps, ready.width, ready.format, ready.identity], [25, 384, "jpeg", "bloom-test"]);
  // The caller's audio clock per response, at the moment each event is sent
  await h.s.handle({ type: "input.text", text: "What is on today?" });
  await h.s.settled();
  await wait(30);
  const sent = new Map<string, number>();
  let lastPts = -1;
  const rid = h.of("response.created")[0].response_id as string;
  for (const e of h.events) {
    if (e.type === "response.audio.delta") sent.set(e.response_id as string, (sent.get(e.response_id as string) ?? 0) + (e.ms as number));
    if (e.type === "face.frame" && e.response_id) {
      assert.equal(e.response_id, rid);
      assert.equal(e.mode, "speaking");
      assert.ok((e.pts_ms as number) < (sent.get(rid) ?? 0), `frame at ${e.pts_ms} ms came before its audio (${sent.get(rid)} ms sent)`);
      assert.ok((e.pts_ms as number) > lastPts, "pts rises");
      lastPts = e.pts_ms as number;
      assert.deepEqual(Buffer.from(e.image as string, "base64"), Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
    }
  }
  const frames = h.of("face.frame").filter((e) => e.response_id === rid);
  assert.equal(frames.length, 30, "1.2 s of speech at 25 fps");
  const m = h.of("face.metrics")[0];
  assert.equal(m.response_id, rid);
  assert.equal(m.status, "completed");
  assert.equal(m.frames, 30);
  assert.equal(m.audio_ms, 1200);
  assert.equal(m.fps, 25);
  assert.equal(typeof m.first_frame_ms, "number");
  assert.ok((m.lag_max_ms as number) >= 0 && m.lead_ms === 1e9);
  // face.metrics comes after its response's own response.done (the face lags the voice)
  const types = h.events.map((e) => e.type);
  assert.ok(types.indexOf("face.metrics") > types.indexOf("response.done"));
  h.s.stop("done");
  assert.equal(h.of("session.ended")[0].face_frames, 30);
  assert.equal(h.face().closed, true);
});

test("barge-in: the face is told at once, and no frame of the interrupted answer is sent, even one already on its way", async () => {
  const h = harness({ sentences: ["First sentence here. ", "Second one ", "is long ", "and slow. ", "Third."], speakMs: 1 });
  await h.s.handle({ type: "session.start", face: true });
  await h.s.settled();
  await h.s.handle({ type: "input.text", text: "Tell me everything." });
  for (let i = 0; i < 200 && !h.of("face.frame").length; i++) await wait(2);
  const rid = h.of("response.created")[0].response_id as string;
  assert.ok(h.of("face.frame").length > 0, "the face was speaking");
  h.hear({ type: "speech_start", atMs: 0 });
  // Same tick: the response is done, the face was told, and the face's report says interrupted
  assert.equal(h.of("response.done")[0].status, "interrupted");
  assert.deepEqual(h.face().cancelled, [rid]);
  assert.equal(h.of("face.metrics")[0].status, "interrupted");
  const before = h.of("face.frame").length;
  h.face().frame(rid, 0); // a frame the face had already made
  h.face().frame(rid, 2000);
  await h.s.settled();
  await wait(20);
  assert.equal(h.of("face.frame").length, before, "no frame after the barge-in");
  // The face listens (the person is speaking) and its listening frames go through
  assert.equal(h.face().states.at(-1), "listening");
  h.face().frame(null, 0, "listening");
  const last = h.of("face.frame").at(-1)!;
  assert.deepEqual([last.response_id, last.mode], [null, "listening"]);
  assert.ok(typeof last.pts_ms === "number");
});

test("idle and listening: the face follows the person's speech (vad.start → listening, turn.end → idle) and its frames pass", async () => {
  const h = harness({ deps: { transcriber: { transcribe: async () => "" } } });
  await h.s.handle({ type: "session.start", face: true });
  await h.s.settled();
  h.face().frame(null, 0, "idle");
  h.s.audio(tone(400));
  h.hear({ type: "speech_start", atMs: 0 });
  h.face().frame(null, 0, "listening");
  h.hear({ type: "speech_end", atMs: 400 });
  h.hear({ type: "turn_end", atMs: 400, confidence: 0.9 });
  await h.s.settled();
  assert.deepEqual(h.face().states, ["listening", "idle"]);
  assert.deepEqual(h.of("face.frame").map((e) => e.mode), ["idle", "listening"]);
  assert.ok(h.of("face.frame").every((e) => e.response_id === null));
});

test("a face that cannot start: face_unavailable, and the conversation goes on with voice alone", async () => {
  const h = harness({ face: async () => { throw new Error("the Mac is short of memory"); } });
  await h.s.handle({ type: "session.start", face: true });
  await h.s.handle({ type: "input.text", text: "hi" });
  await h.s.settled();
  const err = h.of("error")[0];
  assert.equal(err.code, "face_unavailable");
  assert.match(String(err.message), /short of memory/);
  assert.equal(h.of("response.done")[0].status, "completed");
  assert.equal(h.of("face.ready").length, 0);

  const none = harness({ face: null });
  await none.s.handle({ type: "session.start", face: true });
  assert.equal(none.of("session.created")[0].face, null);
  assert.equal(none.of("error")[0].code, "face_unavailable");

  const duplex = harness({ deps: { duplex: (n) => n === "haru-4b" ? async () => ({ name: n, rate: 24_000, canSpeak: false, push: () => undefined, speak: () => undefined, close: () => undefined }) : null } });
  await duplex.s.handle({ type: "session.start", model: "haru-4b", face: true });
  assert.equal(duplex.calls(), 0);
  assert.equal(duplex.of("error")[0].code, "face_unsupported");
});

test("a face that gets ready mid-answer shows nothing of that answer (its clock had started), and all of the next", async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  let face: FakeFace | null = null;
  const h = harness({ face: async (_o, onEvent) => { await gate; face = new FakeFace(onEvent); return face; }, sentences: ["Hello, I am Bloom. ", "How can I help? ", "Ask me anything."], speakMs: 15 });
  await h.s.handle({ type: "session.start", face: true });
  await h.s.handle({ type: "response.create", say: "Hello, I am Bloom. How can I help? Ask me anything." });
  for (let i = 0; i < 100 && !h.of("response.audio.delta").length; i++) await wait(2);
  release(); // the face is ready while the greeting is being spoken
  await h.s.settled();
  await wait(20);
  const greeting = h.of("response.created")[0].response_id;
  assert.equal(h.of("face.ready").length, 1);
  assert.equal(h.of("face.frame").filter((e) => e.response_id === greeting).length, 0);
  await h.s.handle({ type: "input.text", text: "What is on today?" });
  await h.s.settled();
  await wait(30);
  const next = h.of("response.created")[1].response_id;
  const frames = h.of("face.frame").filter((e) => e.response_id === next);
  assert.equal(frames.length, 45, "three sentences of 600 ms at 25 fps");
  assert.equal(frames[0].pts_ms, 0);
  assert.ok(face);
});

test("a face that stops mid-session: face_unavailable, the voice goes on", async () => {
  const h = harness();
  await h.s.handle({ type: "session.start", face: true });
  await h.s.settled();
  h.face().emit({ type: "closed", reason: "the face went away" });
  await h.s.handle({ type: "input.text", text: "still there?" });
  await h.s.settled();
  assert.equal(h.of("error")[0].code, "face_unavailable");
  assert.equal(h.of("response.done")[0].status, "completed");
  assert.equal(h.of("face.frame").length, 0);
});

/* The adapter against a stand-in sidecar on a real socket */

async function sidecar(onConn: (ws: import("ws").WebSocket, first: Record<string, unknown>) => void) {
  const wss = new WebSocketServer({ port: 0, host: "127.0.0.1", path: "/face" });
  wss.on("connection", (ws) => ws.once("message", (d) => onConn(ws, JSON.parse(String(d)))));
  await new Promise((r) => wss.once("listening", r));
  const port = (wss.address() as { port: number }).port;
  return { base: `http://127.0.0.1:${port}/v1`, close: () => new Promise((r) => wss.close(r)) };
}
const packed = (h: object, img: Buffer) => { const j = Buffer.from(JSON.stringify(h)); const n = Buffer.alloc(4); n.writeUInt32BE(j.length); return Buffer.concat([n, j, img]); };

test("the face sidecar's protocol: start, ready, binary frames with a JSON header, speech and speech.done", async () => {
  const got: Record<string, unknown>[] = [];
  const sc = await sidecar((ws, first) => {
    got.push(first);
    ws.send(JSON.stringify({ type: "ready", fps: 25, width: 320, height: 320, format: "jpeg", identity: "bloom", model: "musetalk-1.5-mlx" }));
    ws.on("message", (d) => {
      const m = JSON.parse(String(d));
      got.push(m);
      if (m.type === "speech") ws.send(packed({ response_id: m.response_id, index: 0, pts_ms: 0, mode: "speaking", format: "jpeg" }, Buffer.from("JPG")));
      if (m.type === "speech.end") ws.send(JSON.stringify({ type: "speech.done", response_id: m.response_id, frames: 1, audio_ms: 100 }));
    });
  });
  const events: FaceEvent[] = [];
  let released = 0;
  const face = await connectFace("musetalk-1.5-mlx", sc.base, { size: 320 } as FaceOptions, (e) => events.push(e), new AbortController().signal, () => { released++; });
  assert.deepEqual(face.info, { fps: 25, width: 320, height: 320, format: "jpeg", identity: "bloom", model: "musetalk-1.5-mlx" });
  face.state("listening");
  face.speech("resp_1", Buffer.alloc(4800), 24_000);
  face.speechEnd("resp_1");
  for (let i = 0; i < 100 && events.length < 2; i++) await wait(5);
  assert.deepEqual(got[0], { type: "start", size: 320, fps: 25, format: "jpeg" });
  assert.deepEqual(got.slice(1).map((m) => m.type), ["state", "speech", "speech.end"]);
  assert.equal(Buffer.from(got[2].audio as string, "base64").length, 4800);
  const f = events[0] as Extract<FaceEvent, { type: "frame" }>;
  assert.deepEqual([f.frame.responseId, f.frame.ptsMs, f.frame.mode, f.frame.image.toString()], ["resp_1", 0, "speaking", "JPG"]);
  assert.deepEqual(events[1], { type: "speech.done", done: { responseId: "resp_1", frames: 1, audioMs: 100 } });
  face.close();
  await wait(20);
  assert.equal(released, 1, "the model is released once");
  assert.equal(parseFaceFrame(Buffer.from([0, 0, 0, 9, 1])), null, "a short frame is refused");
  await sc.close();
});

test("a sidecar that is in another session refuses before ready: the factory fails (the session says face_unavailable)", async () => {
  const sc = await sidecar((ws) => { ws.send(JSON.stringify({ type: "error", message: "the face is in another conversation (one at a time)" })); });
  let released = 0;
  await assert.rejects(connectFace("m", sc.base, {}, () => undefined, new AbortController().signal, () => { released++; }), /another conversation/);
  await wait(20);
  assert.equal(released, 1);
  await sc.close();
});
