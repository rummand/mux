import { INPUT_RATE, msOf, rms } from "./audio.js";

/**
 * Hearing: what the session learns from the caller's audio. Times (`atMs`) are on the input audio's own clock, the
 * milliseconds of audio received since session.start, so they do not depend on when a frame happened to arrive.
 * - speech_start: the first voiced frame of a stretch of speech (a barge-in starts here);
 * - speech_end: the end of the last voiced frame, once a short silence says the stretch is over;
 * - turn_end: the caller is done (the silence went on, or a turn model said so), with a confidence 0..1;
 * - partial / final: words, from a hearing that transcribes as it listens (the hear sidecar's parakeet-mlx).
 */
export type HearEvent =
  | { type: "speech_start"; atMs: number }
  | { type: "speech_end"; atMs: number }
  | { type: "turn_end"; atMs: number; confidence: number }
  | { type: "partial"; text: string }
  | { type: "final"; text: string };

export interface Hearing {
  /** True when it sends `final` itself (streaming STT); otherwise the session transcribes the turn's audio. */
  readonly transcribes: boolean;
  /** Name for the metrics and the session record ("energy", "silero+smart-turn+parakeet"). */
  readonly name: string;
  push(pcm: Buffer): void;
  close(): void;
}
export type HearingFactory = (onEvent: (e: HearEvent) => void) => Hearing | Promise<Hearing>;

export interface EnergyOptions {
  /** Voiced this long before speech_start (ms): a click or a cough is not speech. */
  startMs?: number;
  /** Silence this long ends a stretch of speech (vad.end). */
  endMs?: number;
  /** Silence this long after speech ends the turn: the "tuned silence" of a hearing with no turn model. */
  turnMs?: number;
  /** Levels (RMS 0..1) below this are never speech; above it, a frame is voiced when it is `ratio` × the noise floor. */
  minLevel?: number;
  ratio?: number;
}

/**
 * The hearing that needs nothing installed: an energy VAD with an adaptive noise floor and a silence that ends the
 * turn. It is the fallback when the hear sidecar (Silero VAD + Smart Turn v3 + parakeet-mlx) is not running; the
 * session then transcribes each turn through the `transcribe` route (whisper). Its turn decision is the silence alone,
 * so a person who pauses to think for longer than `turnMs` is cut off: Smart Turn is what fixes that.
 */
export class EnergyVad implements Hearing {
  readonly transcribes = false;
  readonly name = "energy";
  private o: Required<EnergyOptions>;
  private clockMs = 0;
  private floor = 0.003;
  private voicedRun = 0;
  private silentRun = 0;
  private runStart = 0;
  private inSpeech = false;
  private lastVoicedEnd = 0;
  private ended = false; // speech_end sent for the current stretch, turn_end not yet
  private carry = Buffer.alloc(0);

  constructor(private emit: (e: HearEvent) => void, o: EnergyOptions = {}) {
    const given = Object.fromEntries(Object.entries(o).filter(([, v]) => typeof v === "number" && Number.isFinite(v)));
    this.o = { startMs: 120, endMs: 250, turnMs: 700, minLevel: 0.012, ratio: 3, ...given };
  }

  push(pcm: Buffer) {
    // 20 ms frames, whatever length the caller sends
    const frame = (INPUT_RATE / 50) * 2;
    let buf = this.carry.length ? Buffer.concat([this.carry, pcm]) : pcm;
    while (buf.length >= frame) {
      this.frame(buf.subarray(0, frame));
      buf = buf.subarray(frame);
    }
    this.carry = Buffer.from(buf);
  }

  private frame(f: Buffer) {
    const ms = msOf(f.length, INPUT_RATE);
    const level = rms(f);
    const voiced = level >= this.o.minLevel && level >= this.floor * this.o.ratio;
    // The floor follows the quiet frames quickly and the loud ones slowly, so speech does not raise it much
    if (!voiced) this.floor = this.floor * 0.95 + level * 0.05;
    else this.floor = this.floor * 0.999 + level * 0.001;
    const start = this.clockMs;
    this.clockMs += ms;
    if (voiced) {
      if (this.voicedRun === 0) this.runStart = start;
      this.voicedRun += ms;
      this.silentRun = 0;
      this.lastVoicedEnd = this.clockMs;
      if (!this.inSpeech && this.voicedRun >= this.o.startMs) {
        this.inSpeech = true;
        this.ended = false;
        this.emit({ type: "speech_start", atMs: this.runStart });
      }
      return;
    }
    this.voicedRun = 0;
    this.silentRun += ms;
    if (this.inSpeech && this.silentRun >= this.o.endMs) {
      this.inSpeech = false;
      this.ended = true;
      this.emit({ type: "speech_end", atMs: this.lastVoicedEnd });
    }
    if (this.ended && this.silentRun >= this.o.turnMs) {
      this.ended = false;
      this.emit({ type: "turn_end", atMs: this.lastVoicedEnd, confidence: 0.5 });
    }
  }

  close() { /* nothing held */ }
}
