/**
 * PCM helpers for /v1/realtime: everything is 16-bit signed little-endian mono PCM ("pcm16"). The caller's microphone
 * comes in at 16 kHz; speech goes out at whatever rate the voice has (Kokoro and the duplex models: 24 kHz), said in
 * every response.audio.delta. No codec: Opus would need a native decoder on the Mac and in the gateway (docs/realtime.md).
 */

export const INPUT_RATE = 16_000;
/** 20 ms of input audio at 16 kHz, in bytes: the frame size the protocol recommends (any length is accepted). */
export const INPUT_FRAME_BYTES = (INPUT_RATE / 50) * 2;

/** Milliseconds of pcm16 audio in `bytes` at `rate`. */
export const msOf = (bytes: number, rate: number) => (bytes / 2 / rate) * 1000;

/** Samples of a pcm16 buffer, without copying when it is aligned. */
export function samples(pcm: Buffer): Int16Array {
  const n = Math.floor(pcm.length / 2);
  if (pcm.byteOffset % 2 === 0) return new Int16Array(pcm.buffer, pcm.byteOffset, n);
  const out = new Int16Array(n);
  for (let i = 0; i < n; i++) out[i] = pcm.readInt16LE(i * 2);
  return out;
}

/** Root mean square of pcm16, 0..1. */
export function rms(pcm: Buffer): number {
  const s = samples(pcm);
  if (!s.length) return 0;
  let acc = 0;
  for (let i = 0; i < s.length; i++) acc += s[i] * s[i];
  return Math.sqrt(acc / s.length) / 32768;
}

/** A WAV file (RIFF, PCM 16-bit mono) around pcm16: what the transcription route takes. */
export function wavOf(pcm: Buffer, rate: number): Buffer {
  const h = Buffer.alloc(44);
  h.write("RIFF", 0, "ascii");
  h.writeUInt32LE(36 + pcm.length, 4);
  h.write("WAVE", 8, "ascii");
  h.write("fmt ", 12, "ascii");
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20); // PCM
  h.writeUInt16LE(1, 22); // mono
  h.writeUInt32LE(rate, 24);
  h.writeUInt32LE(rate * 2, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write("data", 36, "ascii");
  h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}

export class WavError extends Error {}

/**
 * The pcm16 inside a WAV, mixed down to mono, and its rate. Tolerant of what streaming servers write: a data chunk
 * whose size is 0 or 0xFFFFFFFF (unknown when the header went out) runs to the end of the file, and chunks before
 * `data` (LIST, fact) are skipped. Float32 WAVs (format 3) are converted.
 */
export function parseWav(buf: Buffer): { pcm: Buffer; rate: number } {
  if (buf.length < 12 || buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WAVE") throw new WavError("not a WAV file");
  let off = 12;
  let fmt: { format: number; channels: number; rate: number; bits: number } | null = null;
  while (off + 8 <= buf.length) {
    const id = buf.toString("ascii", off, off + 4);
    let size = buf.readUInt32LE(off + 4);
    const body = off + 8;
    if (id === "fmt ") {
      fmt = { format: buf.readUInt16LE(body), channels: buf.readUInt16LE(body + 2), rate: buf.readUInt32LE(body + 4), bits: buf.readUInt16LE(body + 14) };
      // WAVE_FORMAT_EXTENSIBLE: the real format is the first two bytes of the sub-format GUID
      if (fmt.format === 0xfffe && size >= 26) fmt.format = buf.readUInt16LE(body + 24);
    } else if (id === "data") {
      if (!fmt) throw new WavError("WAV data before its format");
      if (size === 0 || size === 0xffffffff || body + size > buf.length) size = buf.length - body;
      return { pcm: toMonoPcm16(buf.subarray(body, body + size), fmt), rate: fmt.rate };
    }
    off = body + size + (size % 2);
  }
  throw new WavError("WAV without a data chunk");
}

function toMonoPcm16(data: Buffer, f: { format: number; channels: number; bits: number }): Buffer {
  const ch = Math.max(1, f.channels);
  const bytes = f.bits / 8;
  if (!((f.format === 1 && f.bits === 16) || (f.format === 3 && f.bits === 32))) throw new WavError(`WAV format ${f.format}/${f.bits} bit is not supported (pcm16 or float32)`);
  const frames = Math.floor(data.length / (bytes * ch));
  const out = Buffer.alloc(frames * 2);
  for (let i = 0; i < frames; i++) {
    let acc = 0;
    for (let c = 0; c < ch; c++) {
      const at = (i * ch + c) * bytes;
      acc += f.format === 1 ? data.readInt16LE(at) / 32768 : data.readFloatLE(at);
    }
    out.writeInt16LE(clamp16((acc / ch) * 32767), i * 2);
  }
  return out;
}

const clamp16 = (v: number) => Math.max(-32768, Math.min(32767, Math.round(v)));

/** Linear resampling of pcm16 (speech only: no anti-aliasing filter beyond the interpolation). */
export function resample(pcm: Buffer, from: number, to: number): Buffer {
  if (from === to) return pcm;
  const s = samples(pcm);
  const n = Math.floor((s.length * to) / from);
  const out = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) {
    const x = (i * from) / to;
    const a = Math.floor(x);
    const b = Math.min(s.length - 1, a + 1);
    const t = x - a;
    out.writeInt16LE(clamp16(s[a] * (1 - t) + s[b] * t), i * 2);
  }
  return out;
}
