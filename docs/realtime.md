# Talking to Bloom: `/v1/realtime`

A WebSocket on mux that holds one person's voice conversation with Bloom: it hears, decides when the person is done,
writes down what they said, asks Bloom's LLM through mux's chat route, and speaks the answer one sentence at a time,
stopping the moment the person speaks over it. Built 27 November 2026 for bloom for business's proposal *Talking to
Bloom* (Parts E–G of its deck; research in its `research/voice-research.md`).

The owner's decisions (accepted 27 November 2026): **cascade first, duplex as a trial; WebSocket first; everything
hosted on mux; English only now; one voice session per person.**

Code: `server/src/realtime/` (protocol, session, stages, adapters, server), the sidecars in `server/realtime/`, the
deploys `deploy/realtime.sh`, `deploy/haru.sh`, `deploy/minicpm-o.sh`, `deploy/face.sh`, the measurement
`deploy/realtime-measure.mjs`. Model notes: [`haru.md`](haru.md), [`minicpm-o.md`](minicpm-o.md); the face: [`face.md`](face.md).

## The path

```
Browser ──(Bloom's server on Railway: the conversation, tools, rights, the masking gate)──►
   mux gateway (Railway)  wss://…/v1/realtime  ── relays every frame, meters bloom's tokens and seconds ──►
   Tailscale Funnel (TCP; HTTP upgrade passes through) ──► Mac Studio mux :7070 /v1/realtime
        cascade:  hearing ──► words ──► Bloom's LLM ──► speech
                  energy VAD           (transcribe)     (chat route)   (speak: Kokoro af_heart, by sentence)
                  or the hear sidecar: Silero VAD + Smart Turn v3 + parakeet-mlx streaming (com.mux.hear :8326)
        duplex (trials): haru-4b (com.mux.haru :8327), minicpm-o-4.5 (com.mux.minicpm-o :8322)
```

Bloom stays in the middle: it opens the socket from its server with its mux key, sends the conversation (`messages`),
its instructions and its tools, runs the tools itself, and keeps the transcript. mux holds the audio models and the
session; it keeps nothing of what was said after the session (every inner call is metered with no body).

## Who may, and limits

- A mux key: `Authorization: Bearer mux-sk-…` or `x-api-key` from a server. A browser cannot set headers on a
  WebSocket, so it may offer the subprotocols `["mux.realtime.v1", "mux-key.<key>"]`; mux answers `mux.realtime.v1`.
  **Never put the key in the address** (proxies log it); mux does not read it from there.
- The tenant must be in `settings.realtimeTenants`: `bloom-for-business` (Railway), `bloom-design-composer-test` (the
  Mac), `gateway-railway` (Railway's sessions arrive on the Mac as it). Otherwise 403 before the upgrade.
- The tenant's own limits and budgets hold at the upgrade and on every inner call. A session does not hold a slot of
  `max_parallel`; `settings.realtimeMaxSessions` (4) caps sessions per mux (503 `realtime_busy`), and
  `settings.realtimeMaxMinutes` (30) ends one (`session.ended` reason `time limit`).
- **One voice session per person:** a `session.start` with the same `user` (or the upgrade's `x-mux-user`) for the same
  tenant ends the older session (`session.ended` reason `replaced by a newer session of the same person`). No `user`,
  no de-duplication. Through the gateway the person is named `<tenant>:<user>` on the Mac.
- The tenant needs the routes a session uses in its `allowed` list (or an empty list): `transcribe`, `speak`, its chat
  route, and for a duplex trial the model (`haru-4b`, `minicpm-o-4.5`).
- Inner calls keep the tenant's budgets and tokens a minute but not its requests a minute (one spoken answer is a
  transcription, an LLM call and a speech call per sentence; the session was counted when it opened). Through the
  gateway, bloom's budget there is checked when the session opens and each turn's tokens are charged as it ends, so a
  long session can run past a budget by up to one session's worth before the next one is refused.
- **What a person says stays on our machines:** every inner call runs inside the data border `own` (or `servers` if
  the tenant has that), so no cloud model and no free-tier rescue answers it, whatever the tenant's own border.
- **Through Railway, Bloom's `llm` is Railway's choice:** the gateway resolves `llm` (or a `model` that is not a duplex
  engine, or bloom's default route) with its own routes, aliases and bloom's allowed list, takes the first candidate
  that is on the node running the session, and names it to the node as the node's model (`agent` → `inkling-2-mini`).
  If none is on that node the session is refused with `error` `llm_unavailable`.

## Protocol `mux.realtime.v1`

Text frames are JSON events with a `type`. The caller's microphone is **pcm16, 16 kHz, mono, little-endian**, sent as
**binary frames** (20 ms = 640 bytes recommended; any length works) or as `input.audio` with base64. Opus is not
accepted: decoding it would need a native codec in both muxes, and 16 kHz pcm16 is 32 kB/s, which TCP carries.
Speech comes back as pcm16 at the rate in each `response.audio.delta` (24 kHz for Kokoro, Haru and MiniCPM-o).

### Client → mux

| Event | Fields | |
| --- | --- | --- |
| `session.start` | `model?` (`"cascade"` default, `"haru-4b"`, `"minicpm-o-4.5"`, `"realtime"`, or a chat model = the LLM), `llm?` (chat route or model; default the tenant's default route), `voice?` (`af_heart`), `instructions?`, `tools?` (OpenAI chat tools), `tool_choice?`, `messages?` (the conversation so far, no system message), `auto_response?` (default true), `barge_in?` (default true), `user?`, `input_audio_format?` (`"pcm16"` only), `turn_silence_ms?` (300–3000), `hearing?` (`auto` · `energy` · `sidecar`), `face?` (`true`, or `{size 256–512, fps 10–30, format "jpeg"\|"webp"}`: Bloom's talking face, [`face.md`](face.md); off by default) | First, once |
| binary frame / `input.audio` | pcm16 16 kHz / `{audio: base64}` | The microphone |
| `input.text` | `text` | Typing mid-call: a user turn (interrupts Bloom if it is speaking) |
| `response.create` | `messages?` (replaces the history: Bloom's masked conversation), `instructions?`, `say?` (speak this sentence, no LLM) | Ask for an answer now; with `auto_response: false` this is how every answer starts |
| `response.cancel` | | Stop: the LLM and the speech stop now |
| `tool.result` | `call_id`, `output` (any JSON) | The answer to a `tool.call` |
| `session.update` | `instructions?`, `tools?`, `tool_choice?`, `messages?`, `voice?`, `auto_response?`, `barge_in?` | Change the session; answers `session.updated` |
| `session.end` | | Ends it; `session.ended` follows and the socket closes |

### mux → client

| Event | Fields |
| --- | --- |
| `session.created` | `session_id`, `protocol`, `engine`, `llm`, `voice`, `hearing`, `auto_response`, `barge_in`, `input_audio {format, sample_rate, channels, frame_ms, binary_frames}`, `output_audio {format, sample_rate (null until the first sentence for the cascade), channels}`, `face` (`"starting"` when asked for and this mux has one, else null) |
| `vad.start` / `vad.end` | `at_ms` on the session's input clock (ms of audio received) |
| `turn.end` | `at_ms` (the end of the last voiced audio), `confidence` (Smart Turn's probability; 0.5 for a silence) |
| `transcript.partial` / `transcript.final` | `text` (+ `turn` on final) |
| `response.created` | `response_id`, `turn` |
| `response.text.delta` | `response_id`, `delta` (the LLM's words as they stream) |
| `response.audio.delta` | `response_id`, `audio` (base64 pcm16), `sample_rate`, `ms` |
| `tool.call` | `response_id`, `call_id`, `name`, `arguments` (JSON text): run it, answer `tool.result` |
| `response.done` | `response_id`, `status` (`completed` · `interrupted` · `cancelled` · `failed`), `text` (all the LLM wrote), `spoken_text` (what was heard), `usage {prompt_tokens, completion_tokens}` |
| `metrics` | per response: `speech_end_to_turn_ms`, `speech_end_to_transcript_ms`, `speech_end_to_first_token_ms`, `speech_end_to_first_audio_ms`, `first_token_to_first_audio_ms`, `cold_start`, `engine`, `hearing`, `status` (all from the end of the last voiced frame, so the hangover is counted; null for a typed turn) |
| `face.ready` | `fps`, `width`, `height`, `format`, `identity`, `model`: the face's frames begin ([`face.md`](face.md)) |
| `face.frame` | `response_id` (null for idle and listening), `index`, `pts_ms` (speaking: on that response's audio clock, the ms of its `response.audio.delta` before the frame's moment; else ms since session.start), `mode` (`idle` · `listening` · `speaking`), `format`, `image` (base64) |
| `face.metrics` | per response, after its `response.done`: `status`, `frames`, `audio_ms`, `first_frame_ms` (first audio sent → first frame sent), `fps` (frames per second of audio), `lag_p50_ms`, `lag_max_ms` (a frame's send time minus its audio's), `lead_ms` |
| `error` | `code`, `message`: the session goes on (a fatal one is followed by `session.ended`); `face_unavailable`, `face_unsupported` (a duplex engine) and `face_error` never end it |
| `session.ended` | `reason`, `seconds`, `turns`, `usage`, `input_ms`, `output_ms`, `face_frames` (when the face was asked for) |

The deck's draft names map to these: `audio.append` → binary frame / `input.audio`; `text.send` → `input.text`;
`vad {speaking}` → `vad.start` / `vad.end`; `turn.end` = `turn.end`; `text.delta` / `audio.delta` →
`response.text.delta` / `response.audio.delta`; `barge_in` and `interrupted` → `response.done` with status
`interrupted`; `done` → `response.done`; `run.step` stays Bloom's own event (mux does not know Bloom's steps).

### Barge-in, and what the client does

When the person starts speaking while Bloom speaks (`vad.start` during a response), mux aborts the LLM stream and the
speech at once and sends `response.done` with `status: "interrupted"` in the same tick. **The client stops its
playout on that event** and drops queued audio. mux sends speech at most 400 ms ahead of real time (`leadMs`), so
little is queued anywhere; the history keeps as Bloom's answer only the sentences whose audio had started playing
(`spoken_text`), and a tool call left waiting gets the result `interrupted`, so the next turn is valid for the LLM.
Use the browser's echo cancellation (`getUserMedia({audio: {echoCancellation: true}})`) or Bloom will interrupt itself.

### Tools

`tools` go to the LLM as they came. A tool call (its arguments streamed in fragments are put together) comes to the
caller as `tool.call`; the LLM continues once every call of that round has a `tool.result` (60 s each, then the result
is an error the LLM sees). A short sentence the LLM writes before calling ("Let me pull your invoices.") is spoken
while the tool runs. At most 8 rounds per answer. The duplex trials have no tools (an `error` `tools_unsupported`).

### Bloom keeps the conversation

`messages` at `session.start` (or `session.update`) is the conversation so far; each spoken turn and answer is added
in the session. To keep the masking gate on Bloom's side for every turn, start with `auto_response: false`: mux sends
`transcript.final` and waits; Bloom masks, then sends `response.create {messages}` with the conversation it wants the
LLM to see. `response.create {say}` speaks a sentence Bloom wrote, with no LLM call.

### Examples

```js
// From Bloom's server (Node, ws): the key in a header
const ws = new WebSocket("wss://mux-production-0b55.up.railway.app/v1/realtime", "mux.realtime.v1",
  { headers: { authorization: `Bearer ${MUX_KEY}`, "x-mux-user": person.id } });
ws.send(JSON.stringify({ type: "session.start", llm: "agent", voice: "af_heart", user: person.id,
  instructions: bloomSystemPrompt, tools: bloomTools, messages: thread.messages }));
mic.on("pcm16", (frame) => ws.send(frame));            // 20 ms, 16 kHz, mono
ws.on("message", (d, binary) => { const e = JSON.parse(d); /* vad.start → orb listening; response.audio.delta → play;
  tool.call → run, then ws.send({type:"tool.result", call_id, output}); response.done interrupted → stop playout */ });
```

```js
// In a browser, to try it (a test key only: a browser holds the key in memory)
const ws = new WebSocket("ws://127.0.0.1:7070/v1/realtime", ["mux.realtime.v1", `mux-key.${testKey}`]);
const ctx = new AudioContext({ sampleRate: 16000 });   // capture at 16 kHz; convert Float32 → Int16 in an AudioWorklet
```

## The cascade's stages

| Stage | What | Where | Notes |
| --- | --- | --- | --- |
| Hearing | **energy VAD** (`vad.ts`): adaptive noise floor; speech after 120 ms voiced; ends after 250 ms quiet; the turn ends after `turn_silence_ms` (700) | in mux | Always there; a person pausing to think for > 700 ms is cut off |
| Hearing | **hear sidecar**: Silero VAD (32 ms windows) + **Smart Turn v3** on every pause (P(complete) > 0.5 ends the turn; else 1.5 s of silence) + **parakeet-mlx** streaming (partials every 320 ms, the final at the turn's end) | `server/realtime/hear_server.py`, com.mux.hear :8326 | `hearing: "auto"` uses it when it answers within 800 ms, else the energy VAD. It stays resident (PyTorch for Silero + parakeet, roughly 2.5–3 GB) **outside mux's memory budget**, like Nexus's audio service |
| Words | the `transcribe` route (whisper large-v3-turbo, `language=en`), the turn's audio with 300 ms before speech began | mux route | Only with the energy VAD; the sidecar transcribes as it listens |
| Think | Bloom's chat route through `runChat`, streamed, tools passed through | mux route | `x-mux-affinity` = the session, so its turns stay on one model and its prompt cache |
| Speak | the `speak` route, one sentence at a time, `voice` (af_heart → Kokoro), WAV; each sentence synthesised as soon as it is complete and sent in order, 100 ms pieces, ≤ 400 ms ahead of real time | mux route | Markdown is not spoken; "e.g." and "9.30" do not end sentences |

Inner calls are metered as the session's tenant, endpoints `realtime.chat`, `realtime.transcription`,
`realtime.speech`, with tag `realtime`, trace id = the session id, end user = the person, and no bodies. The session
itself is a row in `requests` (`realtime.session`, its duration as latency) and in `realtime_sessions` (seconds,
turns, tokens, input and output audio ms, engine, LLM, hearing, node, why it ended). Through the gateway, the
gateway writes a `realtime.turn` row per `response.done` with its tokens to bloom's tenant (budgets and spend there),
and its own `realtime_sessions` row with the node's name.

## Duplex engines (trials)

A model of kind `realtime` (route `realtime`) whose `base_url` is a wrapper on the Mac. mux admits a session like any
local service (presence, and the **memory floor**: the wrapper's `GET /v1/models` says `need_gb` until its model is
loaded, and mux unloads idle models or answers 503 `memory_busy` when it would not fit). The wrapper speaks one
protocol on `ws://127.0.0.1:<port>/duplex`:

```
mux → engine   {"type":"start","instructions":…,"voice":null|"/path.wav","input_sample_rate":16000}
               binary pcm16 16 kHz (the caller, as it comes)
               {"type":"speak","text":…}      forced text (Haru only, experimental)   ·   {"type":"end"}
engine → mux   {"type":"ready","sample_rate":24000,"frame_ms":…,"can_speak":bool}
               binary pcm16 at sample_rate (silence included)  ·  {"type":"text","text":…}  ·  {"type":"error",…}
```

mux turns the engine's voiced stretches into responses (a response ends after 1 s of silence from the model), its
text into `response.text.delta`, and keeps running the energy VAD on the caller for `vad.*`, `turn.end` and the
metrics. `response.create {say}` sends `speak` (the hybrid experiment). The engines load on their first session and
let go of their memory after 15 idle minutes.

## Through Railway and Tailscale Funnel

- **Gateway → node:** the gateway opens `wss://<node base_url>/v1/realtime` (`https://lv426.tail134047.ts.net/mux` →
  `wss://lv426.tail134047.ts.net/mux/v1/realtime`) with the node key it already holds, subprotocol `mux.realtime.v1`,
  no compression (audio does not compress and deflate adds delay), a 15 s handshake timeout. Frames are relayed as
  they come, both ways; a refusal on the node comes back as an `error` event and a close.
- **Keep-alive:** both muxes ping every 20 s and drop a peer that missed a pong (the session ends `the caller stopped
  answering`). That keeps idle sessions open through proxies that close quiet connections.
- **What is not proven yet:** that Tailscale Funnel passes the upgrade on its `/mux` path (Funnel's HTTP proxy is Go's
  reverse proxy, which supports upgrades, but this path has not carried a WebSocket before), and Railway's limits on
  long-lived WebSocket connections. `deploy/realtime.sh --railway` measures through both; if Funnel refuses the
  upgrade, the gateway's `error` says `… could not be reached` / `refused the session (…)`.
- **WebRTC later:** media over UDP needs a TURN relay or a direct path; the Funnel is TCP. Decide after the numbers.

## Latency budget (cascade, English)

The proposal's budget (reasoned from vendor figures), and where each part is measured:

| Stage | Budget | Measured by |
| --- | --- | --- |
| Network browser → Railway → Funnel → Mac, one way | 30–80 ms | the client clock minus the server clock in `realtime-measure.mjs` through Railway |
| End-of-turn decision | 200–300 ms (Smart Turn); **700 ms with the energy VAD** | `speech_end_to_turn_ms` |
| Final transcript | < 100 ms (streaming) | `speech_end_to_transcript_ms` − turn |
| LLM first sentence | 200–400 ms | `speech_end_to_first_token_ms` − transcript, and `first_token_to_first_audio_ms` |
| First audio (Kokoro) | < 150 ms | `first_token_to_first_audio_ms` (includes waiting for the first full sentence) |
| Network back | 30–80 ms | as above |
| **End of speech → first audio** | **0.8–1.1 s**, stretch 0.6 s; Haru ~0.2 s + network | `speech_end_to_first_audio_ms`, and the client's own clock |

Targets: reply p50 ≤ 1.1 s through Railway; Bloom silent ≤ 150 ms after the person starts speaking; < 5 false
cut-offs per 100 turns with thinking pauses.

With fake stages on a laptop (200 ms LLM, 80 ms STT, 60 ms TTS) the measurement script reads p50 1045 ms, 700 of
them the energy VAD's silence: the turn decision is the biggest part of the budget, which is what Smart Turn is for.

## How to test

- **Here, against fakes (no models):** the hear sidecar's `Listener` with a stand-in Silero VAD and STT (two turns:
  Smart Turn's "not yet" carries a pause over, the second turn's times stay on the session clock); `haru_server.py`
  with a stand-in `haru_mlx`, through mux's `/v1/realtime` (the memory floor refused it with 7 GB free, then admitted
  it; a spoken turn came back as a response; `response.create {say}` came back as forced words); and
  `realtime-measure.mjs` against mux with fake stages (p50 1045 ms, 700 of them the energy VAD's silence; barge-in
  112 ms). `minicpm_o_server.py` has not run at all.
- **Here (no models):** `npm test` runs `server/test/realtime.test.ts` (the session with fake stages: a whole turn,
  the metrics' order, barge-in, tools, timeouts, cancel, Bloom's own `response.create`, a transcribing hearing, a
  duplex engine, pacing; WAV, the sentence splitter, the energy VAD) and `realtime-ws.test.ts` (a real socket: who may
  connect, a spoken turn as binary frames, one session per person, a gateway relaying to a node and metering there).
- **On the Mac:** `./deploy/realtime.sh` measures 5 turns on the Mac with a one-day key; `--railway` deploys Railway
  and measures 5 through it. By hand: `MUX_KEY=… node deploy/realtime-measure.mjs --url <mux> --turns 20 --barge-in`
  prints each turn (client and server clocks, what was heard) and p50/p90, leaving cold starts out.
- **From a browser:** the snippet above with a test key, or Bloom's Talk mode once it is built.
- **From Bloom:** Bloom's server opens the socket with `bloom-for-business`'s key on Railway.

## Measured

2026-11-27, cascade engine, hearing Silero VAD + Smart Turn v3 + parakeet-tdt-0.6b-v3 (com.mux.hear on :8326), LLM
qwen3.6-35b-a3b (warm), voice Kokoro af_heart; 5 English turns each, spoken by Kokoro; end of speech → first audio:

| Through | Client p50 · p90 | Server p50 · p90 | Turn decided p50 | Transcript p50 | First LLM token p50 | Barge-in |
| --- | --- | --- | --- | --- | --- | --- |
| The Mac (127.0.0.1:7070), first run | 827 · 885 ms | 798 · 861 ms | 264 ms | 347 ms | 487 ms | 373 ms |
| The Mac, second run | 904 · 1071 ms | 859 · 1003 ms | 277 ms | 367 ms | 506 ms | 415 ms |
| Railway (bloom-for-business) | **1250 · 3598 ms** | 1081 · 3457 ms | 282 ms | 413 ms | 559 ms | 470 ms |

- On the Mac it is inside the 1.1 s target; through Railway the client's p50 (1250 ms) is just over it, ~170 ms of it
  the trip to Railway and back. One Railway turn waited 2.9 s for the first LLM token (qwen3.6 busy with other work):
  that is the p90.
- Barge-in (373–470 ms, the VAD's ~120 ms start delay included) is well over the 150 ms target.
- Loaded on the Mac at the time: qwen3.6 (pinned), bge-m3, arch-router; Record's speech-da and speakers services; the
  9 CI runners.

## Licences

| Piece | Licence | Source read 2026-11-27 |
| --- | --- | --- |
| Silero VAD | MIT (Silero Team) | github.com/snakers4/silero-vad LICENSE |
| Smart Turn v3.x | BSD-2-Clause (Daily); keep the copyright notice | github.com/pipecat-ai/smart-turn LICENSE; the HF card says bsd-2-clause |
| parakeet-tdt-0.6b-v3 | CC-BY-4.0 (NVIDIA): credit NVIDIA where the words are shown as a feature | huggingface.co/nvidia/parakeet-tdt-0.6b-v3 and the mlx-community card |
| parakeet-mlx | Apache-2.0 | github.com/senstella/parakeet-mlx LICENSE |
| Whisper large-v3-turbo (fallback) | MIT (already on mux) | |
| Kokoro-82M, voice af_heart | Apache-2.0 (already on mux) | huggingface.co/hexgrad/Kokoro-82M |
| Haru-4B, haru_mlx | Apache-2.0 | [`haru.md`](haru.md) |
| MiniCPM-o 4.5, llama.cpp-omni, the Comni demo | Apache-2.0, MIT, no licence file | [`minicpm-o.md`](minicpm-o.md) |
| The face: MuseTalk 1.5, its MLX port, sd-vae-ft-mse, whisper-tiny, OpenCV | MIT, MIT (stated; no LICENSE file), MIT, Apache-2.0, Apache-2.0 | [`face.md`](face.md) |
| `ws` (Node WebSocket) | MIT | npm |
