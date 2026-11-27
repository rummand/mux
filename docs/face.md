# Bloom's face: a talking face on `/v1/realtime`

Phase 4a of bloom for business's proposal *Talking to Bloom* (Part D and Part E, "The path to a face"; research in its
`research/voice-research.md` §6): the orb now, **a lip-synced face on the Mac next**, a face that listens later. The
owner (27 November 2026): *"We want to have an agent that really looks and feels just as real as"* Emma from Nuance Labs,
*"for now it's just going to be the animation, but in the future"* a person. Decision accepted the same day: **MuseTalk
on MLX first; decide on an NVIDIA node after measuring.**

Built 27 November 2026. **Nothing here has run on the Mac yet**: what is proven and what is not is at the end.

## What it is

A session that asks for it (`session.start {face: true}`) gets, beside Bloom's voice, a stream of pictures of one face:

- **speaking:** the lower half of Bloom's face regenerated from Bloom's own speech by **MuseTalk 1.5** (single-step
  latent inpainting: one UNet pass per frame, no denoising loop) on Apple's MLX, pasted back into the still portrait;
- **idle**, between answers: blinks every 2.5–6 s, a slow small sway of the head (sums of incommensurate sines, so no
  loop the eye catches);
- **listening**, while the person talks (from mux's `vad.start`; back to idle at `turn.end`): the same, plus a small nod
  every 1.6–3.8 s and a glance aside and back every 3–7 s;
- the head motion goes on while it speaks too, a little livelier with the voice's loudness;
- **a pause mid-answer** (a tool running after "Let me pull your invoices.", a slow sentence): after 250 ms with no new
  speech the mouth finishes what it has heard and closes, and the face idles (`response_id: null` frames) until the
  voice comes back; the answer's frames then go on from where they were. So the face is never frozen.

The motion is **procedural 2D**: an affine warp of the whole picture and a blink blended over the eyes from a second
picture of the same face with closed eyes. It is not a model of how a person listens. That is AVTR-1 or Avatar Forcing,
both CUDA-only today (below).

```
Bloom's LLM → speak (Kokoro af_heart, 24 kHz) → response.audio.delta ──────────────────────────────► caller
                                                 │ the same pieces, as they are sent (≤ leadMs ahead)
                                                 ▼
          com.mux.face :8324  (server/realtime/face_server.py, one session at a time)
             16 kHz → whisper-tiny encoder → MuseTalk UNet (t=0) → VAE decode → 256² mouth crop
             → paste back (feathered ellipse) → blink → head pose → 256–512 px JPEG/WebP
                                                 │ binary frames: header {response_id, index, pts_ms, mode}
                                                 ▼
          mux session: drops frames of an interrupted answer; holds a frame until its audio has been sent ──► face.frame
```

## Protocol additions (mux.realtime.v1, opt-in)

`session.start` takes **`face`**: `true`, or `{size, fps, format}` (size 256–512 px, default 384; fps 10–30, default 25;
`"jpeg"` (default) or `"webp"`). Without it nothing changes: no face is started and no `face.*` event is sent.

| mux → client | Fields |
| --- | --- |
| `session.created` | adds `face`: `"starting"` when asked for and this mux has a face, else `null` |
| `face.ready` | `fps`, `width`, `height`, `format`, `identity`, `model`. The face never holds the session up: it may still be loading MuseTalk when `session.created` is sent, and its frames begin here |
| `face.frame` | `response_id`, `index`, `pts_ms`, `mode` (`idle` · `listening` · `speaking`), `format`, `image` (base64) |
| `face.metrics` | per answer, after its `response.done` (the face lags the voice): `status`, `frames`, `audio_ms`, `first_frame_ms`, `fps`, `lag_p50_ms`, `lag_max_ms`, `lead_ms` |
| `error` | `face_unavailable` (no face on this mux, it could not start, it went away, the Mac is short of memory, another session holds it), `face_unsupported` (a duplex engine: the face follows the cascade's speech only), `face_error`. **None of them ends the session**: it goes on with voice alone |
| `session.ended` | adds `face_frames` when the face was asked for |

**How a client keeps the face in sync.** A speaking frame's `pts_ms` is on its answer's own audio clock: the
milliseconds of that answer's `response.audio.delta` before the frame's moment (frame *n* shows the audio at *n*·40 ms
at 25 fps). The client counts how many ms of each answer it has played and shows the latest frame whose `pts_ms` is
at or before that. Idle and listening frames (`response_id: null`, `pts_ms` = ms since session.start) are shown as they
come. On `response.done` with `status: "interrupted"`, drop that answer's frames along with its audio: mux sends none
after it.

What mux guarantees, and the tests hold it to:

1. **Opt-in only:** without `face`, the face stage is never asked for anything.
2. **No frame before its audio:** a speaking frame is sent only after the audio it shows has been sent to the client
   (one that comes early is held until it has).
3. **In order:** a response's frames come with rising `pts_ms`.
4. **Barge-in stops frames at once:** in the same tick as `response.done interrupted`, mux tells the face to drop the
   answer and drops any frame of it already on its way.
5. **The face follows the person:** `vad.start` → listening; `turn.end` → idle; Bloom's speech → speaking.
6. **A face that gets ready mid-answer** (Bloom's greeting while MuseTalk loads) shows nothing of that answer, whose
   audio clock had already started at the client, and all of the next.

**The lead.** mux sends speech at most `leadMs` (400 ms) ahead of real time. A frame for audio at *t* can only be made
once MuseTalk's window, about 120 ms past *t*, has arrived, and then takes the render time. If a frame comes later than
its audio *plays*, the face is behind the voice. `face.metrics.lag_max_ms` measures this: the time from when the audio
covering a frame was sent to when the frame was sent. **While the worst lag stays under the lead, the client can show
every frame on time.** Past it, the client must hold its audio back by the difference, or `leadMs` must grow when the
face is on. The measurement says which.

**Bandwidth.** At 384 px JPEG (quality 82) a frame is roughly 15–25 kB, so 25 fps is about 0.4–0.6 MB/s on top of
48 kB/s of speech, through Railway and the Funnel. This is reasoned, not measured. 256 px or WebP halve it.

## The face sidecar (`server/realtime/face_server.py`, `com.mux.face`, :8324)

- **mux → face** (`ws://127.0.0.1:8324/face`):
  - `{"type":"start","size","fps","format"}`;
  - `{"type":"state","mode":"idle"|"listening"}`;
  - `{"type":"speech","response_id","sample_rate","audio": base64 pcm16}` (each piece as the caller got it);
  - `{"type":"speech.end","response_id"}`;
  - `{"type":"cancel","response_id"}`;
  - `{"type":"end"}`.
- **face → mux:**
  - `{"type":"ready",…}`;
  - binary frames: 4 bytes of big-endian header length, the JSON header `{response_id, index, pts_ms, mode, format}`,
    then the picture;
  - `{"type":"speech.done","response_id","frames","audio_ms"}`;
  - `{"type":"error","message"}`.
- **One session at a time.** The vendor's ~34 faces/s covers one real-time stream. A second session is refused before
  `ready`, and that session gets `face_unavailable`.
- **Admission is mux's, as for every local service.** The face is model `musetalk-1.5-mlx`, kind `face`, route `face`
  (`backend: external`, `base_url http://127.0.0.1:8324/v1`, `size_bytes` 9 GB). `acquire` checks presence and the
  **memory floor**: `GET /v1/models` says `need_gb` 9 until MuseTalk is loaded (the vendor gives ~7 GB peak at batch
  8), and mux unloads idle models or refuses with `memory_busy`, which the session turns into `face_unavailable`. The
  tenant needs `face` in its allowed routes. The inner admission runs inside the data border `own`, as every
  realtime inner call does.
- **MLX rules learned here:**
  - every MLX call runs on one thread;
  - the buffer cache is capped (`--cache-gb` 1) and emptied after each answer and session;
  - MuseTalk loads on the first session, and the process exits after 15 idle minutes (launchd starts it again, unloaded).
- **The work per frame:** one still reference, so its masked and reference latents are computed once at load. Each
  frame is then one UNet pass and one VAE decode. Audio comes in at 24 kHz and is resampled to 16 kHz. The whisper-tiny
  encoder runs over the batch's audio plus 1 s of left context. Frames are made once their ~80 ms lookahead has
  arrived, 2 for the first batch (latency) and then up to 8 (throughput). At `speech.end` the rest are made with
  silence after the speech.
- **Simplifications against upstream MuseTalk:**
  - the face box is found once at deploy with OpenCV's Haar cascades, instead of S3FD and DWPose per frame (a still,
    frontal portrait);
  - the mouth is pasted back with a feathered ellipse over the jaw, instead of BiSeNet face parsing;
  - the crop keeps upstream 1.5's 10 px extra margin below the chin.
- **The picture work per frame** runs at about 1.25× the output size, not at the identity's 1024², which is cut down
  once at the session's start. Measured on this 4-core Linux container: at 1024² the compose (blend, blink, warp,
  resize, JPEG) took 22–34 ms a frame, most of a 25 fps frame; at the working size it is **4.4 ms (256 px), 7.9 ms
  (384 px) and 11.6 ms (512 px)**. It runs outside the MLX thread, beside the next batch's render.

## Bloom's identity

**One consistent face, and never a real person's likeness without consent.** Bloom's face is a **synthetic person made
once for Bloom with mux's own `image` route** (FLUX.2 [klein] 4B on the Mac, Apache-2.0). `deploy/face.sh` makes it on
its first run:

- **The prompt** asks for a fictional woman in her early thirties who is "not any real or famous individual": frontal,
  eyes to the lens, mouth closed, plain background, 1024×1024. The text is in `deploy/face.sh`.
- **The seed** is 20261127.
- **The blink picture:** the same picture with the eyes closed, made with `image-edit` and used only over the eye region.
- **Provenance** goes to `~/.mux/face/bloom/identity.json`: prompt, seed, the model that answered, the date and the
  picture's SHA-256.
- **The face and eye boxes** are added to `identity.json` by `face_server.py --setup-identity`.
- **A copy for the repository:** `docs/face/bloom-face.jpg`, `bloom-blink.jpg` and `identity.json`.
- **It is never regenerated** unless `--new-identity` is passed, which is the owner's call. The old face is then kept
  as `face-<date>.png`.

**For the owner, before the first run:** the prompt fixes Bloom's look for good: a woman in her early thirties,
light-brown hair, freckles, a dark-teal top. Changing it later means `--new-identity`. This is a persona decision, not
a technical one. The research notes the criticism Emma's persona drew ("digital blackface", §2), so choose it on
purpose: edit `PROMPT` in `deploy/face.sh` before the first run if Bloom should look different.

**After the first run:** look at `docs/face/bloom-face.jpg`. If you approve the face, commit `docs/face/`,
and it is Bloom's one identity from then on. A stock picture with a clear licence, or a consented, licensed actor (as
Emma is), can replace it. Put it in `~/.mux/face/bloom/face.png` with its licence in `identity.json`, then run
`--setup-identity`. Never use a picture of a real person who has not consented.

## Licences (read 27 November 2026)

| Piece | Licence | Source |
| --- | --- | --- |
| MuseTalk 1.5 code and weights (TMElyralab, Tencent Music) | **MIT**, "Copyright (c) 2024 Tencent Music Entertainment Group". The card: code MIT, "the trained model are available for any purpose, even commercially"; other models keep their own licences; the test data is non-commercial research only (we use none) | github.com/TMElyralab/MuseTalk `LICENSE`; huggingface.co/TMElyralab/MuseTalk @ `c9ac4cdc` |
| musetalk-mlx (the MLX port, MVS Collective / xocialize) @ `c6eb30eb` | **MIT as stated** in `pyproject.toml` and its README. **The repository has no LICENSE file**, so the grant is the statement alone | github.com/xocialize/musetalk-mlx |
| mlx-community/MuseTalk-1.5-q8 @ `e5bb4364` (UNet int8, VAE and whisper encoder fp16) | MIT (card: "mirrors upstream MuseTalk") | its card; SHA-256 of the three safetensors pinned in `deploy/face.sh` |
| sd-vae-ft-mse (Stability AI) | MIT | huggingface.co/stabilityai/sd-vae-ft-mse @ `31f26fde` |
| whisper-tiny encoder (OpenAI) | Apache-2.0 | huggingface.co/openai/whisper-tiny @ `169d4a43` |
| OpenCV 4.x | Apache-2.0. Its Haar cascades (used once at deploy for the face box) carry the Intel License Agreement, a BSD-style licence: keep the notice | `cv2/data/haarcascade_*.xml` headers. OpenCV 5 drops `CascadeClassifier`, hence `opencv-python<5` |
| MLX (Apple) | MIT | ml-explore/mlx |
| Bloom's face | Our output of FLUX.2 [klein] 4B (Apache-2.0) through mux's `image` route; a synthetic person | `identity.json` |

None is non-commercial. Attribution: credit TMElyralab's MuseTalk wherever the face is shown as a feature.

## How to run it (on the Mac)

```sh
git pull --ff-only && npm ci && npm run build && launchctl kickstart -k gui/$(id -u)/com.mux.server
./deploy/face.sh             # MuseTalk MLX, weights (1.6 GB, SHA-256 checked), Bloom's face, com.mux.face, model and route
open docs/face/bloom-face.jpg   # the owner approves the face, then: git add docs/face && git commit
./deploy/face.sh --measure   # the numbers below
```

`--measure` runs two measurements and writes them to `~/.mux/logs/face-bench.log`.

1. **The face alone:** `face_server.py --bench speech.wav`. It stops `com.mux.face` while it runs, and it can be run by
   hand with any WAV. It sends 12 s of Kokoro's speech as mux sends it (100 ms pieces, ≤ 400 ms ahead) and prints:
   - the **first-frame latency** (first audio in → first frame out);
   - **frames per second** (wall) and per second of audio;
   - the lag behind the audio, p50, p90 and max, against the lead;
   - MLX's peak memory;
   - "keeps up" or "DOES NOT keep up";

   at 384 px, then 256 and 512. The first run is GPU warm-up.
2. **Through `/v1/realtime`:** `realtime-measure.mjs --face` runs 5 turns and prints, per turn, mux's
   `face.metrics` and the client's own first-frame delay, then the idle frame rate and a summary.

`./deploy/face.sh --still` serves the same path without MuseTalk (the reference's own mouth), to try the pipeline and
the motion before the model.

## Tests (no model)

- **`server/test/face.test.ts`** (`npm test`), with a fake face stage that behaves as the sidecar does:
  - the `face` field's validation;
  - opt-in only;
  - a spoken answer's frames: count, order, none ahead of its audio, `face.metrics` after `response.done`,
    `session.ended.face_frames`;
  - barge-in: the face told in the same tick, no frame after it even one already made, then listening;
  - a face that gets ready mid-answer: nothing of that answer, all of the next from pts 0;
  - idle and listening following `vad.start` and `turn.end`;
  - `face_unavailable` when the face cannot start or stops mid-session, with the voice going on;
  - `face_unsupported` for a duplex engine;
  - the sidecar protocol against a stand-in sidecar on a real socket (binary frame header, `speech.done`, the model
    released once);
  - a busy sidecar's refusal.
- **`server/test/realtime-ws.test.ts`**: a face session through a gateway relay, `face.*` passing through.
- **`server/realtime/test_face_server.py`** (Python with numpy, `opencv-python<5` and websockets; no MLX), with the
  no-model renderer:
  - idle and listening frames at ~25 fps in real time, most of them different pictures (the head moves);
  - a pause mid-answer: the mouth finishes the 300 ms it heard, ~25 idle frames a second follow, and the answer's
    frames go on after it;
  - speaking frames one per 40 ms of speech, made only once their lookahead has arrived, a small first batch;
  - barge-in mid-batch;
  - the blink and the mouth paste-back;
  - the motion (sway, blinks, nods);
  - one session at a time;
  - the memory floor's `need_gb`.
- **Checked here by hand:** mux's Node adapter against the real `face_server.py --renderer still` on a socket. `ready`
  came in 59 ms; 27 idle then listening frames; 25 speaking frames for 1 s of speech, pts 0…960; the first frame
  125 ms after the first audio (the lookahead, with no model); `speech.done` 25 frames, 1000 ms.

## Measured

2026-11-27, MuseTalk 1.5 q8 on MLX, 384 px JPEG at 25 fps, the face made with flux2-klein-4b-q4 (seed 20261127;
awaiting the owner's approval, `docs/face/` not committed yet). Loaded at the time: qwen3.6, Haru (idle), Record's
services, the CI runners.

- **The bench (`face_server.py --bench`, 13.6 s of speech, 3 runs):** first frame 190–193 ms after the first audio
  (2.1 s on the cold first run); **13–15 frames/s of wall time** against the 25 needed; lag behind its audio p50
  5.3–8.9 s, max 10–15 s against mux's 400 ms lead; peak MLX memory 5.3 GB; load 1.7 s. **It does not keep up with
  real time**: every answer longer than a second or two drifts out of lip sync.
- **Through `/v1/realtime` (5 turns, face on):** voice unchanged (end of speech → first audio p50 878 ms, p90 1052 ms);
  first frame p50 201 ms, p90 209 ms after the first audio; 25 frames per audio second delivered, but lag p50 2.4 s,
  worst 4.2 s.
- So: the first frame is fast enough; the frame rate is not. Next: fewer frames (12.5 fps with each shown twice),
  a smaller face (256 px), or `--still` (the reference's mouth, motion only) until MuseTalk is faster here.

## What is unproven, and what comes next

- **Everything that needs the Mac:**
  - that `musetalk-mlx` installs and imports at that commit;
  - the vendor's ~34 faces/s and ~7 GB at batch 8 (a vendor figure);
  - the first-frame latency;
  - whether frames keep within the 400 ms lead next to Kokoro and the LLM on the same GPU;
  - the whisper windowing this server does (a ~1.5 s slice padded to 30 s per batch; written from the port's own
    `get_whisper_chunk`, parity with upstream's whole-clip features not checked);
  - the look of the paste-back and of the procedural motion.
- **The identity:** that FLUX.2 klein makes a usable frontal face from the prompt; that the Haar cascades find it and
  both eyes; that `image-edit` closes the eyes without changing the face. If it does not, blinks are off and the face
  still moves.
- **Through Railway:** the frame bandwidth through the gateway and the Funnel.
- **A face that listens with its face**, not with procedural nods: AVTR-1 (speech plus listening track, LivePortrait
  renderer; community licence, InsightFace parts non-commercial, streamer PolyForm NC) and Avatar Forcing (CVPR 2026)
  are the closest, and both need CUDA. The decision after measuring: if MuseTalk keeps up here, port a listening motion
  model to MLX. If it does not, or for the listening face, an NVIDIA machine joins as a mux node (`deploy/join-node.sh`),
  which keeps "everything hosted on mux".
- **Emma-grade** (one duplex audio-visual model for one consented actor) is a research programme, not an install.
