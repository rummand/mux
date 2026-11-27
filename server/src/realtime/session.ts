import { randomBytes } from "node:crypto";
import { INPUT_RATE, msOf, resample, rms } from "./audio.js";
import { ProtocolError, type ClientEvent, type ServerEvent, type SessionStart } from "./protocol.js";
import { SentenceSplitter, clean } from "./sentences.js";
import type { ChatTool, DuplexEngine, DuplexEvent, DuplexFactory, Face, FaceEvent, FaceFactory, FaceFrame, FaceOptions, Message, Speaker, Thinker, ToolCall, Transcriber, Usage } from "./stages.js";
import { EnergyVad, type HearEvent, type Hearing, type HearingFactory } from "./vad.js";

/**
 * One person's voice conversation, with no socket in it: events in (`handle`, `audio`), events out (`deps.send`).
 *
 * The cascade (the product): hearing (VAD + turn) → words (STT) → the LLM through mux's chat route → speech through
 * mux's speak route, one sentence at a time, the first sentence spoken while the LLM writes the rest. Barge-in: the
 * caller's speech while Bloom speaks aborts the LLM stream and the speech at once, and the history keeps only what was
 * spoken by then. Tool calls go to the caller (tool.call), whose tool.result continues the answer.
 *
 * A duplex engine (Haru-4B, MiniCPM-o 4.5; trials): the audio goes to the model as it comes and its voice back as it
 * comes; the energy VAD still runs on the caller's audio, for vad.* events and the metrics.
 */

export interface SessionDeps {
  send: (e: ServerEvent) => void;
  /** The socket is to close (session.end, a fatal error, the time limit). */
  close: (reason: string) => void;
  thinker: Thinker;
  speaker: Speaker;
  transcriber: Transcriber;
  /** The hearing for a session that asked for `hearing` (auto, energy or sidecar); the energy VAD when not given. */
  hearing?: (want: SessionStart["hearing"], opts: { turnMs?: number }) => HearingFactory;
  /** A duplex engine by name, when the model names one (null: the name is not a duplex engine). */
  duplex?: (model: string) => DuplexFactory | null;
  /** The talking face, for a session that asks for it (session.start face): null or absent when this mux has none. */
  face?: FaceFactory | null;
  /** Wall clock, ms; and a wait that the tests can make instant. */
  now?: () => number;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  /** How far ahead of real time speech is sent (ms): what the caller's playout buffer holds, and what a barge-in throws away. */
  leadMs?: number;
  toolTimeoutMs?: number;
  maxToolRounds?: number;
  /** The first clause of an answer is spoken once it has this many characters (0: whole sentences only; default 24). */
  firstClauseChars?: number;
  defaultLlm?: string;
  defaultVoice?: string;
}

interface Response {
  id: string; turn: number; ac: AbortController; status: "in_progress" | "completed" | "interrupted" | "cancelled" | "failed";
  text: string; usage: Usage; coldStart: boolean;
  /** Sentences sent as speech, with the wall time each starts playing at the caller. */
  spoken: { text: string; playsAt: number }[];
  /** Metrics, wall ms. */
  speechEnd: number | null; turnAt: number | null; sttAt: number | null; firstToken: number | null; firstAudio: number | null;
  done: Promise<void>;
  toolsWaiting: Map<string, (output: unknown) => void>;
}

/** A response's speech as the face follows it: what was sent when, and what came back. */
interface FaceTrack {
  /** ms of this response's audio sent to the caller so far (the speaking frames' clock). */
  audioMs: number;
  /** [audio clock at the end of a delta, wall ms it was sent]: how far behind its audio a frame comes. */
  sent: [number, number][];
  firstAudioAt: number | null; firstFrameAt: number | null; frames: number; lags: number[];
  /** Frames that came before the audio they show (a face must never run ahead of the voice): held until it is sent. */
  early: FaceFrame[];
  dropped: boolean; reported: boolean;
}

const DEFAULT_SLEEP =(ms: number, signal: AbortSignal) => new Promise<void>((res) => {
  if (signal.aborted || ms <= 0) return res();
  const t = setTimeout(res, ms);
  signal.addEventListener("abort", () => { clearTimeout(t); res(); }, { once: true });
});

export class Session {
  readonly id = `rt_${randomBytes(9).toString("hex")}`;
  started = false;
  ended = false;
  engine = "cascade";
  llm: string | undefined;
  voice = "af_heart";
  hearingName = "";
  turns = 0;
  usage: Usage = { prompt_tokens: 0, completion_tokens: 0 };
  /** Input audio received, ms: the session's own clock, which the hearing's `atMs` are on. */
  inputMs = 0;
  outputMs = 0;
  readonly t0: number;

  private cfg!: SessionStart;
  private history: Message[] = [];
  private tools: ChatTool[] | undefined;
  private toolChoice: unknown;
  private instructions = "";
  private autoResponse = true;
  private bargeIn = true;
  private hearing: Hearing | null = null;
  private duplex: DuplexEngine | null = null;
  private current: Response | null = null;
  private arrivals: [number, number][] = []; // [input clock at the frame's end, wall ms it arrived]
  private turnAudio: Buffer[] = [];
  private preroll: Buffer[] = [];
  private capturing = false;
  private speechEndAt: number | null = null; // wall
  private turnAt: number | null = null;
  private pendingTurn: Promise<void> | null = null;
  private playEnd = 0; // wall ms the last speech sent ends playing at the caller
  private duplexSilentMs = 0;
  private face: Face | null = null;
  private faceTracks = new Map<string, FaceTrack>();
  private faceMissed = new Set<string>();
  /** Face frames sent in this session (session.ended). */
  faceFrames = 0;
  private readonly now: () => number;
  private readonly sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  private readonly end = new AbortController();

  constructor(private deps: SessionDeps) {
    this.now = deps.now ?? (() => performance.now());
    this.sleep = deps.sleep ?? DEFAULT_SLEEP;
    this.t0 = this.now();
  }

  private send(e: ServerEvent) { if (!this.ended || e.type === "session.ended") this.deps.send(e); }
  private error(code: string, message: string) { this.send({ type: "error", code, message }); }

  /** A text frame from the caller, parsed. */
  async handle(e: ClientEvent): Promise<void> {
    if (this.ended) return;
    if (e.type !== "session.start" && !this.started) throw new ProtocolError("not_started", "send session.start first");
    switch (e.type) {
      case "session.start": return this.start(e);
      case "input.audio": return this.audio(Buffer.from(e.audio, "base64"));
      case "input.text": this.userText(e.text); return;
      case "response.create": this.create(e); return;
      case "response.cancel": if (this.current) this.interrupt(this.current, "cancelled"); return;
      case "tool.result": {
        const r = this.current;
        const done = r?.toolsWaiting.get(e.call_id);
        if (!done) return this.error("unknown_call", `no tool.call ${e.call_id} is waiting`);
        r!.toolsWaiting.delete(e.call_id);
        done(e.output);
        return;
      }
      case "session.update":
        if (e.instructions !== undefined) this.instructions = e.instructions;
        if (e.tools !== undefined) this.tools = e.tools.length ? e.tools : undefined;
        if (e.tool_choice !== undefined) this.toolChoice = e.tool_choice;
        if (e.messages !== undefined) this.history = [...e.messages];
        if (e.voice !== undefined) this.voice = e.voice;
        if (e.auto_response !== undefined) this.autoResponse = e.auto_response;
        if (e.barge_in !== undefined) this.bargeIn = e.barge_in;
        this.send({ type: "session.updated" });
        return;
      case "session.end": return this.stop("ended by the caller");
    }
  }

  private async start(e: SessionStart) {
    if (this.started) throw new ProtocolError("already_started", "this session has started; send session.update to change it");
    this.started = true;
    this.cfg = e;
    this.instructions = e.instructions ?? "";
    this.tools = e.tools?.length ? e.tools : undefined;
    this.toolChoice = e.tool_choice;
    this.history = [...(e.messages ?? [])];
    this.autoResponse = e.auto_response !== false;
    this.bargeIn = e.barge_in !== false;
    this.voice = e.voice ?? this.deps.defaultVoice ?? "af_heart";
    const turnMs = e.turn_silence_ms === undefined ? undefined : Math.max(300, Math.min(3000, Number(e.turn_silence_ms) || 700));
    const name = (e.model ?? "").trim();
    const duplex = name && name !== "cascade" ? this.deps.duplex?.(name) ?? null : null;
    const onHear = (h: HearEvent) => this.heard(h);
    if (duplex) {
      this.engine = name;
      this.hearing = new EnergyVad(onHear, { turnMs });
      this.hearingName = this.hearing.name;
      try {
        this.duplex = await duplex({ model: name, instructions: this.instructions, voice: e.voice }, (d) => this.fromDuplex(d), this.end.signal);
      } catch (err) {
        this.error("engine_unavailable", `${name}: ${(err as Error).message}`);
        return this.stop("engine unavailable");
      }
      if (this.tools) this.error("tools_unsupported", `${name} is a duplex trial with no tool use; the tools are ignored`);
    } else {
      this.engine = "cascade";
      this.llm = e.llm ?? (name && name !== "cascade" ? name : this.deps.defaultLlm);
      const factory = this.deps.hearing?.(e.hearing ?? "auto", { turnMs }) ?? ((emit) => new EnergyVad(emit, { turnMs }));
      this.hearing = await factory(onHear);
      this.hearingName = this.hearing.name;
    }
    // The face is opt-in, and never holds the session up: it starts beside it (its model may have to load) and says
    // face.ready when its frames begin; if it cannot, the conversation goes on with voice alone
    const wantFace = !!e.face;
    const faceStarting = wantFace && this.engine === "cascade" && !!this.deps.face;
    this.send({
      type: "session.created", session_id: this.id, protocol: "mux.realtime.v1", engine: this.engine, llm: this.llm ?? null, voice: this.voice,
      hearing: this.hearingName, auto_response: this.autoResponse, barge_in: this.bargeIn,
      input_audio: { format: "pcm16", sample_rate: INPUT_RATE, channels: 1, frame_ms: 20, binary_frames: true },
      output_audio: { format: "pcm16", sample_rate: this.duplex?.rate ?? null, channels: 1 },
      face: faceStarting ? "starting" : null,
    });
    if (!wantFace) return;
    if (this.engine !== "cascade") return this.error("face_unsupported", `${this.engine} is a duplex trial; the face follows the cascade's speech only`);
    if (!this.deps.face) return this.error("face_unavailable", "this mux has no talking face (docs/face.md); the session goes on with voice alone");
    const opts: FaceOptions = typeof e.face === "object" ? e.face : {};
    this.track(this.deps.face(opts, (ev) => this.fromFace(ev), this.end.signal).then((f) => {
      if (this.ended) { f.close(); return; }
      this.face = f;
      this.send({ type: "face.ready", ...f.info });
    }, (err) => {
      if (!this.ended) this.error("face_unavailable", `the face did not start: ${(err as Error).message}; the session goes on with voice alone`);
    }));
  }

  /** The face's frames and reports. A speaking frame is sent only for a response whose speech is still wanted, and
   *  never before the audio it shows has been sent. */
  private fromFace(ev: FaceEvent) {
    if (this.ended) return;
    if (ev.type === "error") return this.error("face_error", ev.message);
    if (ev.type === "closed") {
      this.face = null;
      return this.error("face_unavailable", `the face stopped: ${ev.reason}; the session goes on with voice alone`);
    }
    if (ev.type === "speech.done") {
      const t = this.faceTracks.get(ev.done.responseId);
      if (!t || t.dropped) return;
      for (const f of t.early.splice(0)) this.sendFrame(f, t); // the end of the speech: nothing is ahead of it now
      this.faceReport(ev.done.responseId, t, "completed", ev.done.frames);
      return;
    }
    const f = ev.frame;
    if (f.responseId === null) return this.sendFrame(f, null);
    const t = this.faceTracks.get(f.responseId);
    if (!t || t.dropped) return; // a barge-in or a cancel: its frames stop at once, even those already on the way
    if (f.ptsMs >= t.audioMs) { t.early.push(f); return; }
    this.sendFrame(f, t);
  }

  private sendFrame(f: FaceFrame, t: FaceTrack | null) {
    const now = this.now();
    if (t) {
      if (t.firstFrameAt === null) t.firstFrameAt = now;
      t.frames++;
      const covering = t.sent.find(([end]) => end > f.ptsMs);
      if (covering) t.lags.push(now - covering[1]);
    }
    this.faceFrames++;
    this.send({
      type: "face.frame", response_id: f.responseId, index: f.index, mode: f.mode, format: f.format,
      // speaking: on the response's audio clock; idle and listening: ms since session.start
      pts_ms: t ? Math.round(f.ptsMs) : Math.round(now - this.t0), image: f.image.toString("base64"),
    });
  }

  /** face.metrics for a response: how soon the face moved after its voice began, the frame rate it kept, and how far
   *  its frames came behind their audio (compare with lead_ms, what the caller's audio buffer holds). */
  private faceReport(responseId: string, t: FaceTrack, status: string, faceSaid?: number) {
    if (t.reported) return;
    t.reported = true;
    const lags = [...t.lags].sort((a, b) => a - b);
    const pct = (p: number) => (lags.length ? Math.round(lags[Math.min(lags.length - 1, Math.floor(p * lags.length))]) : null);
    this.send({
      type: "face.metrics", response_id: responseId, status, frames: t.frames, face_frames: faceSaid ?? null, audio_ms: Math.round(t.audioMs),
      first_frame_ms: t.firstFrameAt !== null && t.firstAudioAt !== null ? Math.round(t.firstFrameAt - t.firstAudioAt) : null,
      fps: t.audioMs > 0 ? Math.round((t.frames / (t.audioMs / 1000)) * 10) / 10 : null,
      lag_p50_ms: pct(0.5), lag_max_ms: lags.length ? Math.round(lags[lags.length - 1]) : null, lead_ms: this.deps.leadMs ?? 400,
    });
    this.faceTracks.delete(responseId);
  }

  /** Barge-in or cancel: the face drops the response's frames, and so does mux, for those already on the way. */
  private faceStop(r: Response, status: string) {
    const t = this.faceTracks.get(r.id);
    if (!t) return;
    t.dropped = true;
    t.early = [];
    this.face?.cancel(r.id);
    t.reported = false;
    this.faceReport(r.id, t, status);
  }

  /** The caller's microphone: pcm16 at 16 kHz, any length. */
  audio(pcm: Buffer) {
    if (this.ended) return;
    if (!this.started) throw new ProtocolError("not_started", "send session.start first");
    if (pcm.length % 2) pcm = pcm.subarray(0, pcm.length - 1);
    this.inputMs += msOf(pcm.length, INPUT_RATE);
    this.arrivals.push([this.inputMs, this.now()]);
    if (this.arrivals.length > 3000) this.arrivals.splice(0, 1000);
    if (this.capturing) this.turnAudio.push(pcm);
    else {
      this.preroll.push(pcm);
      // ~300 ms before speech starts is kept, so the first syllable is not lost to the VAD's start delay
      let ms = this.preroll.reduce((a, b) => a + msOf(b.length, INPUT_RATE), 0);
      while (ms > 300 && this.preroll.length > 1) ms -= msOf(this.preroll.shift()!.length, INPUT_RATE);
    }
    this.hearing?.push(pcm);
    this.duplex?.push(pcm);
  }

  /** The wall time the input audio at `atMs` (on the input clock) arrived. */
  private wallAt(atMs: number): number {
    for (const [end, wall] of this.arrivals) if (end >= atMs) return wall;
    return this.now();
  }

  private heard(h: HearEvent) {
    if (this.ended) return;
    switch (h.type) {
      case "speech_start":
        this.send({ type: "vad.start", at_ms: Math.round(h.atMs) });
        if (!this.capturing) {
          this.capturing = true;
          this.turnAudio = [...this.preroll];
          this.preroll = [];
        }
        this.speechEndAt = null;
        this.turnAt = null;
        if (this.current && this.bargeIn && this.engine === "cascade") this.interrupt(this.current, "interrupted");
        // The face turns to listening unless Bloom goes on speaking over the person (barge_in false)
        if (!this.current) this.face?.state("listening");
        return;
      case "speech_end":
        this.speechEndAt = this.wallAt(h.atMs);
        this.send({ type: "vad.end", at_ms: Math.round(h.atMs) });
        return;
      case "partial":
        if (h.text) this.send({ type: "transcript.partial", text: h.text });
        return;
      case "turn_end": {
        this.turnAt = this.now();
        if (this.speechEndAt === null) this.speechEndAt = this.wallAt(h.atMs);
        this.send({ type: "turn.end", at_ms: Math.round(h.atMs), confidence: h.confidence });
        if (!this.current) this.face?.state("idle"); // the person is done: the face rests (thinking) until Bloom speaks
        if (this.engine !== "cascade") { this.endCapture(); this.turns++; return; }
        if (this.hearing?.transcribes) return; // its final follows
        const audio = Buffer.concat(this.endCapture());
        const marks = { speechEnd: this.speechEndAt, turnAt: this.turnAt };
        const prev = this.pendingTurn ?? Promise.resolve();
        this.pendingTurn = prev.then(() => this.transcribe(audio, marks)).catch((e) => { if (!this.ended) this.error("transcription_failed", (e as Error).message); });
        this.track(this.pendingTurn);
        return;
      }
      case "final":
        if (this.engine !== "cascade") return;
        this.endCapture();
        this.track(this.userTurn(h.text, { speechEnd: this.speechEndAt, turnAt: this.turnAt, sttAt: this.now() }));
        return;
    }
  }

  private endCapture(): Buffer[] {
    const a = this.turnAudio;
    this.turnAudio = [];
    this.capturing = false;
    return a;
  }

  private async transcribe(audio: Buffer, marks: { speechEnd: number | null; turnAt: number | null }) {
    if (!audio.length || this.ended) return;
    const text = (await this.deps.transcriber.transcribe(audio, this.end.signal)).trim();
    await this.userTurn(text, { ...marks, sttAt: this.now() });
  }

  private async userTurn(text: string, marks: { speechEnd: number | null; turnAt: number | null; sttAt: number | null }) {
    text = text.trim();
    // Whisper says these on silence and breath; they are not a turn
    if (!text || /^\[?(blank_audio|silence|music|noise|inaudible)\]?$/i.test(text) || /^[.…,!?\s-]+$/.test(text)) return;
    this.turns++;
    this.send({ type: "transcript.final", text, turn: this.turns });
    this.history.push({ role: "user", content: text });
    if (this.autoResponse) this.track(this.respond({ ...marks }));
  }

  private userText(text: string) {
    if (this.current) this.interrupt(this.current, "interrupted");
    this.turns++;
    this.history.push({ role: "user", content: text });
    if (this.duplex) return this.error("text_unsupported", `${this.engine} hears audio only; input.text is kept in the history`);
    this.track(this.respond({ speechEnd: null, turnAt: null, sttAt: null }));
  }

  /** Work that runs on after the event that started it (a response, a transcription), so the next event is not held. */
  private running = new Set<Promise<unknown>>();
  private track(p: Promise<unknown>) {
    const q = p.catch((e) => this.error("internal_error", (e as Error).message)).finally(() => this.running.delete(q));
    this.running.add(q);
  }
  /** Resolves when nothing the session started is still running (the tests wait on it). */
  async settled(): Promise<void> {
    while (this.running.size) await Promise.all([...this.running]);
  }

  private create(e: Extract<ClientEvent, { type: "response.create" }>) {
    if (this.current) this.interrupt(this.current, "interrupted");
    if (e.messages) this.history = [...e.messages];
    if (e.instructions !== undefined) this.instructions = e.instructions;
    if (this.duplex) {
      if (!e.say) return this.error("not_supported", `${this.engine} answers by itself; response.create takes only say`);
      if (!this.duplex.canSpeak) return this.error("not_supported", `${this.engine} cannot be made to say a given sentence`);
      this.duplex.speak(e.say);
      return;
    }
    this.track(this.respond({ speechEnd: null, turnAt: null, sttAt: null }, e.say));
  }

  /** One response of the cascade: the LLM (with tool rounds) and its speech, or a given sentence (`say`) spoken. */
  private async respond(marks: { speechEnd: number | null; turnAt: number | null; sttAt: number | null }, say?: string) {
    if (this.ended) return;
    let finish!: () => void;
    const r: Response = {
      id: `resp_${randomBytes(6).toString("hex")}`, turn: this.turns, ac: new AbortController(), status: "in_progress", text: "", usage: { prompt_tokens: 0, completion_tokens: 0 },
      coldStart: false, spoken: [], speechEnd: marks.speechEnd, turnAt: marks.turnAt, sttAt: marks.sttAt, firstToken: null, firstAudio: null,
      done: new Promise<void>((res) => { finish = res; }), toolsWaiting: new Map(),
    };
    this.current = r;
    this.send({ type: "response.created", response_id: r.id, turn: r.turn });
    const signal = AbortSignal.any([r.ac.signal, this.end.signal]);
    // Speech: each sentence is synthesised as soon as it is complete, and sent in order
    let speaking = Promise.resolve();
    const speak = (sentence: string) => {
      const audio = this.deps.speaker.speak(sentence, this.voice, signal);
      audio.catch(() => undefined);
      speaking = speaking.then(() => this.play(r, sentence, audio, signal)).catch((e) => {
        if (!signal.aborted) this.error("speech_failed", (e as Error).message);
      });
    };
    try {
      if (say) {
        r.text = say;
        this.send({ type: "response.text.delta", response_id: r.id, delta: say });
        speak(clean(say));
        this.history.push({ role: "assistant", content: say });
      } else {
        const rounds = this.deps.maxToolRounds ?? 8;
        for (let round = 0; ; round++) {
          // The first round may speak its first clause at once (sentences.ts); later rounds go by sentences
          const split = new SentenceSplitter(80, round === 0 ? (this.deps.firstClauseChars ?? 24) : 0);
          const messages: Message[] = [...(this.instructions ? [{ role: "system", content: this.instructions }] : []), ...this.history];
          const out = await this.deps.thinker.stream({ model: this.llm, messages, tools: this.tools, tool_choice: this.toolChoice }, signal, (delta) => {
            if (signal.aborted || !delta) return;
            if (r.firstToken === null) r.firstToken = this.now();
            r.text += delta;
            this.send({ type: "response.text.delta", response_id: r.id, delta });
            for (const s of split.push(delta)) speak(s);
          });
          for (const s of split.flush()) speak(s);
          r.usage.prompt_tokens += out.usage.prompt_tokens;
          r.usage.completion_tokens += out.usage.completion_tokens;
          r.coldStart ||= out.coldStart;
          if (signal.aborted) break;
          if (!out.toolCalls.length) {
            this.history.push({ role: "assistant", content: out.text });
            break;
          }
          if (round >= rounds) {
            this.history.push({ role: "assistant", content: out.text });
            this.error("too_many_tool_rounds", `stopped after ${rounds} rounds of tool calls`);
            break;
          }
          this.history.push({ role: "assistant", content: out.text || null, tool_calls: out.toolCalls.map((c) => ({ id: c.id, type: "function", function: { name: c.name, arguments: c.arguments } })) });
          const results = await this.callTools(r, out.toolCalls, signal);
          if (signal.aborted) break; // interrupt() has closed the open calls in the history
          for (const [id, output] of results) this.history.push({ role: "tool", tool_call_id: id, content: typeof output === "string" ? output : JSON.stringify(output ?? null) });
        }
      }
      await speaking;
      if (r.status === "in_progress") r.status = "completed";
    } catch (e) {
      if (!signal.aborted && r.status === "in_progress") {
        r.status = "failed";
        this.error("response_failed", (e as Error).message);
      }
    } finally {
      this.usage.prompt_tokens += r.usage.prompt_tokens;
      this.usage.completion_tokens += r.usage.completion_tokens;
      // An interrupted response has already said it is done (interrupt); the others say so now
      if (r.status !== "interrupted" && r.status !== "cancelled") {
        this.done(r);
        // The face finishes the frames of this speech (they lag the audio) and reports them in face.metrics
        if (this.faceTracks.has(r.id)) this.face?.speechEnd(r.id);
      }
      if (this.current === r) this.current = null;
      finish();
    }
  }

  private async callTools(r: Response, calls: ToolCall[], signal: AbortSignal): Promise<[string, unknown][]> {
    const timeout = this.deps.toolTimeoutMs ?? 60_000;
    return Promise.all(calls.map((c) => new Promise<[string, unknown]>((res) => {
      let t: ReturnType<typeof setTimeout> | undefined;
      const settle = (output: unknown) => { if (t) clearTimeout(t); r.toolsWaiting.delete(c.id); res([c.id, output]); };
      r.toolsWaiting.set(c.id, settle);
      t = setTimeout(() => settle({ error: `the tool ${c.name} did not answer within ${Math.round(timeout / 1000)} s` }), timeout);
      signal.addEventListener("abort", () => settle({ error: "interrupted" }), { once: true });
      this.send({ type: "tool.call", response_id: r.id, call_id: c.id, name: c.name, arguments: c.arguments });
    })));
  }

  /** One sentence's speech, sent in 100 ms pieces no further ahead of real time than leadMs. */
  private async play(r: Response, sentence: string, audio: Promise<{ pcm: Buffer; rate: number; coldStart?: boolean }>, signal: AbortSignal) {
    const a = await audio;
    if (signal.aborted) return;
    if (a.coldStart) r.coldStart = true;
    const piece = Math.round(a.rate / 10) * 2;
    const lead = this.deps.leadMs ?? 400;
    for (let off = 0; off < a.pcm.length; off += piece) {
      if (signal.aborted) return;
      const chunk = a.pcm.subarray(off, off + piece);
      const ms = msOf(chunk.length, a.rate);
      const now = this.now();
      if (this.playEnd < now) this.playEnd = now;
      const ahead = this.playEnd + ms - now;
      if (ahead > lead) {
        await this.sleep(ahead - lead, signal);
        if (signal.aborted) return;
      }
      if (off === 0) r.spoken.push({ text: sentence, playsAt: this.playEnd });
      if (r.firstAudio === null) r.firstAudio = this.now();
      this.playEnd += ms;
      this.outputMs += ms;
      this.send({ type: "response.audio.delta", response_id: r.id, audio: chunk.toString("base64"), sample_rate: a.rate, ms: Math.round(ms) });
      this.toFace(r, chunk, a.rate, ms);
    }
  }

  /** The face hears exactly what the caller was sent, when it was sent (so it is paced by leadMs as the voice is). */
  private toFace(r: Response, chunk: Buffer, rate: number, ms: number) {
    // An answer whose voice began before the face was ready is not shown: its frames would start at audio time 0
    // while the caller had already played part of it (Bloom's greeting while MuseTalk loads)
    if (!this.face) { if (this.cfg.face) this.faceMissed.add(r.id); return; }
    if (this.faceMissed.has(r.id)) return;
    let t = this.faceTracks.get(r.id);
    if (!t) {
      t = { audioMs: 0, sent: [], firstAudioAt: null, firstFrameAt: null, frames: 0, lags: [], early: [], dropped: false, reported: false };
      this.faceTracks.set(r.id, t);
    }
    const now = this.now();
    if (t.firstAudioAt === null) t.firstAudioAt = now;
    t.audioMs += ms;
    t.sent.push([t.audioMs, now]);
    this.face.speech(r.id, chunk, rate);
    // Frames that waited for this audio go now, in order
    if (t.early.length) {
      const ready = t.early.filter((f) => f.ptsMs < t!.audioMs);
      t.early = t.early.filter((f) => f.ptsMs >= t!.audioMs);
      for (const f of ready) this.sendFrame(f, t);
    }
  }

  /** Barge-in (the caller spoke) or response.cancel: the LLM and the speech stop now; the history keeps what was heard. */
  private interrupt(r: Response, status: "interrupted" | "cancelled") {
    if (r.status !== "in_progress") return;
    r.status = status;
    r.ac.abort();
    const now = this.now();
    const heard = r.spoken.filter((s) => s.playsAt <= now).map((s) => s.text).join(" ");
    this.playEnd = now; // whatever was queued at the caller is thrown away (the caller stops its playout on this event)
    // The answer in the history becomes what the caller heard, so the next turn does not build on unheard words
    this.closeOpenCalls();
    const last = this.history[this.history.length - 1];
    if (last?.role === "assistant" && !last.tool_calls) last.content = heard;
    else if (heard) this.history.push({ role: "assistant", content: heard });
    this.done(r, heard);
    this.faceStop(r, status); // same tick: no frame of this response is sent after its response.done
    if (this.current === r) this.current = null;
  }

  /** Tool calls in the history with no result yet get one ("interrupted"): a chat model refuses a call left open. */
  private closeOpenCalls() {
    const answered = new Set(this.history.filter((m) => m.role === "tool").map((m) => m.tool_call_id));
    for (let i = this.history.length - 1; i >= 0; i--) {
      const m = this.history[i];
      if (m.role !== "assistant" || !Array.isArray(m.tool_calls)) continue;
      const open = (m.tool_calls as { id: string }[]).filter((c) => !answered.has(c.id));
      this.history.splice(i + 1, 0, ...open.map((c) => ({ role: "tool", tool_call_id: c.id, content: JSON.stringify({ error: "interrupted: the caller spoke before the tool answered" }) })));
      break;
    }
  }

  private done(r: Response, heard?: string) {
    this.send({
      type: "response.done", response_id: r.id, status: r.status, text: r.text,
      spoken_text: heard ?? r.spoken.map((s) => s.text).join(" "), usage: r.usage,
    });
    const rel = (t: number | null) => (t === null || r.speechEnd === null ? null : Math.round(t - r.speechEnd));
    this.send({
      type: "metrics", response_id: r.id, turn: r.turn, engine: this.engine, hearing: this.hearingName, cold_start: r.coldStart, status: r.status,
      // From the end of the caller's speech (the last voiced frame, not when the turn was decided); null for a typed turn
      speech_end_to_turn_ms: rel(r.turnAt), speech_end_to_transcript_ms: rel(r.sttAt),
      speech_end_to_first_token_ms: rel(r.firstToken), speech_end_to_first_audio_ms: rel(r.firstAudio),
      first_token_to_first_audio_ms: r.firstToken !== null && r.firstAudio !== null ? Math.round(r.firstAudio - r.firstToken) : null,
    });
  }

  /** A duplex engine's voice and words: each stretch of its speech is one response. */
  private fromDuplex(d: DuplexEvent) {
    if (this.ended) return;
    if (d.type === "error") return this.error("engine_error", d.message);
    if (d.type === "closed") { this.error("engine_closed", d.reason); return this.stop(`engine closed: ${d.reason}`); }
    let r = this.current;
    const open = () => {
      if (r) return r;
      r = {
        id: `resp_${randomBytes(6).toString("hex")}`, turn: this.turns, ac: new AbortController(), status: "in_progress", text: "", usage: { prompt_tokens: 0, completion_tokens: 0 },
        coldStart: false, spoken: [], speechEnd: this.speechEndAt, turnAt: this.speechEndAt !== null && this.turnAt !== null && this.turnAt >= this.speechEndAt ? this.turnAt : null,
        sttAt: null, firstToken: null, firstAudio: null, done: Promise.resolve(), toolsWaiting: new Map(),
      };
      this.current = r;
      this.speechEndAt = null;
      this.send({ type: "response.created", response_id: r.id, turn: r.turn });
      return r;
    };
    if (d.type === "text") {
      if (!d.text.trim() && !r) return;
      const x = open();
      if (x.firstToken === null) x.firstToken = this.now();
      x.text += d.text;
      this.send({ type: "response.text.delta", response_id: x.id, delta: d.text });
      return;
    }
    // Audio: a duplex model sends a frame every step, silence included; a response is its voiced stretch
    const pcm = d.rate === this.duplex?.rate ? d.pcm : resample(d.pcm, d.rate, this.duplex?.rate ?? d.rate);
    const ms = msOf(pcm.length, d.rate);
    const voiced = rms(pcm) > 0.01;
    if (voiced) this.duplexSilentMs = 0; else this.duplexSilentMs += ms;
    if (voiced) open();
    const x = r ?? this.current;
    if (x) {
      if (voiced && x.firstAudio === null) x.firstAudio = this.now();
      this.outputMs += ms;
      this.send({ type: "response.audio.delta", response_id: x.id, audio: pcm.toString("base64"), sample_rate: d.rate, ms: Math.round(ms) });
      if (this.duplexSilentMs >= 1000) {
        x.status = "completed";
        x.spoken.push({ text: x.text.trim(), playsAt: this.now() });
        this.done(x);
        this.current = null;
      }
    }
  }

  /** The end: whatever is running stops, and session.ended says what the session used. */
  stop(reason: string) {
    if (this.ended) return;
    if (this.current) this.interrupt(this.current, "cancelled");
    this.ended = true;
    this.end.abort();
    this.hearing?.close();
    this.duplex?.close();
    this.face?.close();
    this.face = null;
    this.faceTracks.clear();
    this.send({
      type: "session.ended", reason, seconds: Math.round((this.now() - this.t0) / 100) / 10, turns: this.turns, usage: this.usage, input_ms: Math.round(this.inputMs), output_ms: Math.round(this.outputMs),
      ...(this.cfg?.face ? { face_frames: this.faceFrames } : {}),
    });
    this.deps.close(reason);
  }
}
