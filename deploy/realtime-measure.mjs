#!/usr/bin/env node
// Measure Talking to Bloom: N English turns through /v1/realtime, end of speech → first audio, p50 and p90.
//
//   MUX_KEY=… node deploy/realtime-measure.mjs [--url http://127.0.0.1:7070] [--turns 10] [--hearing auto|energy]
//                                              [--llm agent] [--engine cascade|haru-4b|minicpm-o-4.5] [--barge-in]
//                                              [--key-file path] [--json out.json]
//
// Each turn is a spoken English question, made with mux's own speak route (Kokoro af_heart), resampled to 16 kHz and
// sent at real time in 20 ms frames, then silence at real time until Bloom has answered — as a microphone would. Two
// clocks are reported:
//   client   the wall time from the last voiced sample sent to the first response.audio.delta received: what a person
//            would wait, minus the browser's playout buffer and the network to the browser (run it from the browser's
//            side of the network, e.g. on a laptop through Railway, for the whole path);
//   server   mux's own metrics event: speech end → turn decided → transcript → first LLM token → first audio.
// Cold starts (a model that had to load) are counted apart and left out of p50/p90. --barge-in adds one turn that
// speaks over Bloom's answer and reports how long Bloom took to stop (response.done interrupted; target ≤ 150 ms).
// The key is read from MUX_KEY or --key-file and never printed. Nothing said is kept.
import { readFileSync, writeFileSync } from "node:fs";
import WebSocket from "ws";

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, all) => {
  if (a.startsWith("--")) acc.push([a.slice(2), all[i + 1] && !all[i + 1].startsWith("--") ? all[i + 1] : "1"]);
  return acc;
}, []));
const BASE = (args.url ?? process.env.MUX_URL ?? "http://127.0.0.1:7070").replace(/\/$/, "");
const KEY = (args["key-file"] ? readFileSync(args["key-file"], "utf8") : process.env.MUX_KEY ?? "").trim();
const TURNS = Number(args.turns ?? 10);
if (!KEY) { console.error("MUX_KEY (or --key-file): a key of a tenant in settings.realtimeTenants that may use speak, transcribe and the chat route"); process.exit(2); }

const QUESTIONS = [
  "What is on my calendar this afternoon?", "How many invoices are overdue right now?", "Remind me who Anna Berg is.",
  "Draft a short thank you note to the plumber.", "What was our revenue last month?", "Can you move my three o'clock to Friday?",
  "Which customers have not paid this quarter?", "What should I focus on today?", "Summarise the email from the bank.",
  "How much did we spend on travel in October?", "Is there anything urgent in my inbox?", "Book a table for two on Thursday evening.",
];

const RATE = 16000;
const FRAME = RATE / 50; // 20 ms

function parseWav(buf) {
  let off = 12, fmt = null;
  while (off + 8 <= buf.length) {
    const id = buf.toString("ascii", off, off + 4);
    let size = buf.readUInt32LE(off + 4);
    if (id === "fmt ") fmt = { format: buf.readUInt16LE(off + 8), ch: buf.readUInt16LE(off + 10), rate: buf.readUInt32LE(off + 12), bits: buf.readUInt16LE(off + 22) };
    if (id === "data") {
      if (size === 0 || size === 0xffffffff || off + 8 + size > buf.length) size = buf.length - off - 8;
      const d = buf.subarray(off + 8, off + 8 + size);
      const n = Math.floor(d.length / (fmt.bits / 8) / fmt.ch);
      const out = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        let s = 0;
        for (let c = 0; c < fmt.ch; c++) { const at = (i * fmt.ch + c) * (fmt.bits / 8); s += fmt.format === 3 ? d.readFloatLE(at) : d.readInt16LE(at) / 32768; }
        out[i] = s / fmt.ch;
      }
      return { samples: out, rate: fmt.rate };
    }
    off += 8 + size + (size % 2);
  }
  throw new Error("the speak route did not answer a WAV");
}

function to16k({ samples, rate }) {
  const n = Math.floor(samples.length * RATE / rate);
  const out = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) {
    const x = i * rate / RATE, a = Math.floor(x), b = Math.min(samples.length - 1, a + 1), t = x - a;
    out.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round((samples[a] * (1 - t) + samples[b] * t) * 32767))), i * 2);
  }
  // Trim the quiet tail, so "end of speech" is the last voiced sample
  let end = n;
  while (end > 0 && Math.abs(out.readInt16LE((end - 1) * 2)) < 300) end--;
  return out.subarray(0, end * 2);
}

async function utterance(text) {
  const r = await fetch(`${BASE}/v1/audio/speech`, { method: "POST", headers: { authorization: `Bearer ${KEY}`, "content-type": "application/json" },
    body: JSON.stringify({ model: "speak", input: text, voice: "af_heart", response_format: "wav" }) });
  if (!r.ok) throw new Error(`speak answered ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return to16k(parseWav(Buffer.from(await r.arrayBuffer())));
}

const pct = (xs, p) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); return Math.round(s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]); };
const fmt = (v) => (v === null || v === undefined ? "–" : `${v} ms`);

async function main() {
  console.log(`→ ${TURNS} English turns through ${BASE}/v1/realtime (${args.engine ?? "cascade"}${args.llm ? `, LLM ${args.llm}` : ""}, hearing ${args.hearing ?? "auto"})`);
  const texts = Array.from({ length: TURNS + (args["barge-in"] ? 1 : 0) }, (_, i) => QUESTIONS[i % QUESTIONS.length]);
  const audio = [];
  for (const t of texts) audio.push(await utterance(t));
  console.log(`  ${audio.length} questions spoken by Kokoro (${Math.round(audio.reduce((a, b) => a + b.length, 0) / 2 / RATE)} s)`);

  const ws = new WebSocket(`${BASE.replace(/^http/, "ws")}/v1/realtime`, "mux.realtime.v1", { headers: { authorization: `Bearer ${KEY}`, "x-mux-user": "realtime-measure" } });
  const events = [];
  let waiter = null;
  ws.on("message", (d, binary) => {
    if (binary) return;
    const e = JSON.parse(String(d));
    e._at = performance.now();
    events.push(e);
    if (e.type === "error") console.log(`  ! ${e.code}: ${e.message}`);
    waiter?.(e);
  });
  await new Promise((res, rej) => { ws.once("open", res); ws.once("unexpected-response", (_q, r) => rej(new Error(`the socket was refused: ${r.statusCode}`))); ws.once("error", rej); });
  const next = (pred, ms) => new Promise((res, rej) => {
    const hit = events.find((e) => pred(e) && !e._seen);
    if (hit) { hit._seen = true; return res(hit); }
    const t = setTimeout(() => { waiter = null; rej(new Error(`timed out after ${ms} ms`)); }, ms);
    waiter = (e) => { if (pred(e) && !e._seen) { e._seen = true; clearTimeout(t); waiter = null; res(e); } };
  });
  ws.send(JSON.stringify({ type: "session.start", model: args.engine, llm: args.llm, hearing: args.hearing ?? "auto",
    instructions: "You are Bloom, a business assistant. This is a latency test: answer every question in one short, plausible sentence." }));
  const created = await next((e) => e.type === "session.created" || e.type === "session.ended", 200_000);
  if (created.type === "session.ended") { console.error(`✗ the session did not start: ${created.reason}`); process.exit(1); }
  console.log(`  session ${created.session_id}: engine ${created.engine}, hearing ${created.hearing}, LLM ${created.llm ?? "(tenant default)"}`);

  // A microphone: real-time 20 ms frames, speech when there is some queued, silence otherwise
  let queue = Buffer.alloc(0);
  let lastVoiced = null;
  let sent = 0;
  const t0 = performance.now();
  const mic = setInterval(() => {
    const due = Math.floor((performance.now() - t0) / 20);
    while (sent < due) {
      let f;
      if (queue.length) { f = queue.subarray(0, FRAME * 2); queue = queue.subarray(FRAME * 2); if (!queue.length) lastVoiced = performance.now(); }
      else f = Buffer.alloc(FRAME * 2);
      if (f.length < FRAME * 2) f = Buffer.concat([f, Buffer.alloc(FRAME * 2 - f.length)]);
      if (ws.readyState === WebSocket.OPEN) ws.send(f, { binary: true });
      sent++;
    }
  }, 10);

  const rows = [];
  for (let i = 0; i < TURNS; i++) {
    for (const e of events) e._seen = true; // only this turn's events count
    queue = audio[i]; lastVoiced = null;
    try {
      const firstAudio = await next((e) => e.type === "response.audio.delta", 60_000);
      const done = await next((e) => e.type === "response.done", 120_000);
      const m = await next((e) => e.type === "metrics", 5_000);
      const client = lastVoiced === null ? null : Math.round(firstAudio._at - lastVoiced);
      rows.push({ turn: i + 1, client, ...m, status: done.status, heard: events.filter((e) => e.type === "transcript.final").at(-1)?.text });
      console.log(`  ${String(i + 1).padStart(2)}. client ${fmt(client)} · server ${fmt(m.speech_end_to_first_audio_ms)} (turn ${fmt(m.speech_end_to_turn_ms)}, words ${fmt(m.speech_end_to_transcript_ms)}, token ${fmt(m.speech_end_to_first_token_ms)})${m.cold_start ? " · cold start" : ""} · ${JSON.stringify(rows.at(-1).heard ?? "")}`);
      // Let the answer play out before the next question
      await new Promise((r) => setTimeout(r, 1500));
    } catch (e) {
      rows.push({ turn: i + 1, error: e.message });
      console.log(`  ${String(i + 1).padStart(2)}. ✗ ${e.message}`);
    }
  }

  let bargeIn = null;
  if (args["barge-in"]) {
    // Ask, and once Bloom's voice starts, speak over it: how long until Bloom stops?
    for (const e of events) e._seen = true;
    queue = audio[TURNS];
    try {
      await next((e) => e.type === "response.audio.delta", 60_000);
      const resp = events.filter((e) => e.type === "response.created").at(-1)?.response_id;
      await new Promise((r) => setTimeout(r, 300));
      const t = performance.now();
      queue = audio[0];
      const done = await next((e) => e.type === "response.done" && e.response_id === resp, 10_000);
      bargeIn = { status: done.status, ms: Math.round(done._at - t) };
      console.log(`  barge-in: Bloom ${done.status} ${bargeIn.ms} ms after the caller started speaking (includes the VAD's ~120 ms start delay)`);
    } catch (e) { console.log(`  barge-in: ✗ ${e.message}`); }
  }
  clearInterval(mic);
  ws.send(JSON.stringify({ type: "session.end" }));
  await next((e) => e.type === "session.ended", 5_000).catch(() => null);
  ws.close();

  const warm = rows.filter((r) => !r.error && !r.cold_start);
  const col = (k) => warm.map((r) => r[k]).filter((v) => typeof v === "number");
  console.log(`\nEnd of speech → first audio, ${warm.length} warm turns (${rows.filter((r) => r.cold_start).length} cold, ${rows.filter((r) => r.error).length} failed):`);
  for (const [label, k] of [["client (wall)", "client"], ["server: first audio", "speech_end_to_first_audio_ms"], ["server: turn decided", "speech_end_to_turn_ms"], ["server: transcript", "speech_end_to_transcript_ms"], ["server: first LLM token", "speech_end_to_first_token_ms"]]) {
    console.log(`  ${label.padEnd(24)} p50 ${fmt(pct(col(k), 50)).padStart(8)}   p90 ${fmt(pct(col(k), 90)).padStart(8)}`);
  }
  console.log("  target (proposal): p50 ≤ 1100 ms through Railway; stretch 600 ms. Barge-in ≤ 150 ms.");
  if (args.json) writeFileSync(args.json, JSON.stringify({ base: BASE, rows, bargeIn }, null, 2));
  process.exit(rows.some((r) => r.error) ? 1 : 0);
}
main().catch((e) => { console.error(`✗ ${e.message}`); process.exit(1); });
