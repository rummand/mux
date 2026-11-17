# Camera video on mux (2026-11-17)

The owner approved Thread's proposal (`docs/proposals/2026-11-17-world-models-for-sets.html` in Thread, decision 2):
*"Prototype a long-take engine on mux: port LingBot-World v2 1.3B causal-fast … to Apple Silicon behind mux's video job
API as a new route `video-camera`, Matrix-Game 3.0 as the fallback … Measure seconds per chunk, memory, drift over
20–60 s."* Sets' camera path (a pose per frame) and a first frame become a long take, made chunk by chunk with a KV
cache, so a take can run past Wan2.1-VACE's 5–10 s. It runs on the Mac Studio through mux, on no cloud provider.

## The choice: LingBot-World v2 1.3B causal-fast, ported to PyTorch MPS

| | |
|---|---|
| Model | **LingBot-World v2 1.3B causal-fast** (Robbyant Team, Ant Group; "Infinite Worlds with Versatile Interactions", arXiv:2607.07534) |
| Code | [`robbyant/lingbot-world-v2`](https://github.com/robbyant/lingbot-world-v2) at `1895d300d8ac936401689b26389f51cbd36530eb` (2026-09-10, "Fix README for causal_fast 1.3B command details"), cloned to `~/.mux/lingbot-world-v2`; `LICENSE.txt` SHA-256 `9e502ba75fd0fd30cea5497b438a4bc12f07f02bc932a7a6041fd6a18b8f46a0` |
| DiT weights | [`robbyant/lingbot-world-v2-1.3b-causal-fast`](https://huggingface.co/robbyant/lingbot-world-v2-1.3b-causal-fast) at `7e36a5f919f86cb4255cc9bfc30adb44963fbde1`, 6 shards, 6 838 008 064 bytes of float32 (1 709 502 016 parameters: Wan2.1 1.3B, 30 layers × 12 heads × 128, plus the camera layers). SHA-256 per shard in `deploy/video-camera.sh` (from the Hub's LFS records, not downloaded here) |
| VAE | `Wan2.1_VAE.pth` from [`Wan-AI/Wan2.1-T2V-1.3B`](https://huggingface.co/Wan-AI/Wan2.1-T2V-1.3B) at `37ec512624d61f7aa208f7ea8140a131f93afc9a`, 507 609 880 bytes, SHA-256 `38071ab59bd94681c686fa51d75a1968f64e470262043be31f7a094e442fd981` — **the same bytes** as the copy in LingBot's 14B repo (whose README says to take the VAE and T5 from there), so it comes from Wan under Apache-2.0 |
| Text encoder | umT5-XXL (bf16). By default the diffusers copy already on the Mac for Wan2.1-VACE (`~/.mux/models/wan2.1-vace-1.3b-diffusers/text_encoder`, transformers' `UMT5EncoderModel`), so 11 GB are not stored twice; without it, Wan's own `models_t5_umt5-xxl-enc-bf16.pth` (11 361 920 418 bytes, SHA-256 `7cace0da…fd81d`, again identical in LingBot's 14B repo and Wan-AI's) through LingBot's own T5 class |
| Runtime | PyTorch 2.14.1 on **MPS**, one process (`server/video/camera_server.py`, :8315, launchd `com.mux.video-camera`), the port in `server/video/lingbot_mps.py`. DiT float32 by default (`MUX_CAMERA_DTYPE=bf16` for bfloat16), attention and KV cache bfloat16 |
| Sampling | As the README's 1.3B command: 832×480, chunks of 4 latent frames (one second of video), 4 steps per chunk (timesteps index 0/250/500/750 of a shift-5 flow schedule), no CFG, KV window 18 latent frames with 6 sink frames |
| Disk | 7.3 GB new (DiT 6.8 GB, VAE 0.5 GB) with the VACE folder there; 18.7 GB without it |

### Why its own process

The Wan server (`video_server.py`) is proven on the Mac; this port is new, imports a non-commercial share-alike
checkout and patches it at run time. Kept apart, a crash here cannot take Wan down, the licences stay in separate
files and processes, and either redeploys alone. They share one lock, `~/.mux/run/video-gpu.lock`
(`video_server.gpu_lock`, an `flock` each job holds while it runs), so only one video job uses the GPU at a time
across both; a job waiting for it stays `queued`.

### The fallback: Matrix-Game 3.0 (not ported yet)

[`Skywork/Matrix-Game-3.0`](https://huggingface.co/Skywork/Matrix-Game-3.0) weights at
`d4c84ef2b8e9028a00a5d58b6be2df04f1cb6042`, code [`SkyworkAI/Matrix-Game`](https://github.com/SkyworkAI/Matrix-Game) at
`51913b2bfa78a6d54de912b8348b1d318f4d36e2` (`Matrix-Game-3/`). A Wan2.2-TI2V-5B-based, memory-augmented interactive
world model, 720p, distilled to few steps. Files: `base_distilled_model` 25.9 GB (float32), `Wan2.2_VAE.pth` 2.8 GB,
umT5-XXL 11.4 GB (same SHA-256 as Wan's), MG-LightVAE 0.8–2.7 GB. Its pipeline (`pipeline/inference_pipeline.py`) takes
per-frame camera-to-world matrices (Plücker rays, `build_plucker_from_c2ws`) **and** keyboard and mouse conditions, and
uses past poses to pick memory frames, so Sets' path maps to its extrinsics directly and to its actions by deriving
them (translation direction → keys, rotation → mouse). It needs flash-attn (FA3 in the README command) and was shown
on multi-GPU; a port is the same kind of work as this one at ~4× the weights. Do it if LingBot's takes do not hold the
camera or the set.

**Hy-Nomas** (Tencent, [`tencent/Hy-Nomas`](https://huggingface.co/tencent/Hy-Nomas) at
`621df1570098aa1ebf916dac3ac72ae3cbe25caa`, code [`Tencent-Hunyuan/Hy-Nomas`](https://github.com/Tencent-Hunyuan/Hy-Nomas)
at `5ecf99c981432d40a3e6b8788432f007f7acc28b`) is newer and takes `c2ws [N,4,4]` and intrinsics directly, segment by
segment with a KV cache, 720p at 24 fps. Not chosen now: its distilled DiT is 34 GB in float32 (54 MMDiT blocks), its text
encoder is Qwen2.5-VL-7B and its decoder a 36-layer, 4096-wide PixelUMM transformer, which together will not sit beside
the chat models in 48 GB; its documented inference is text and camera (no first frame mentioned), and its kernels are
CUDA 13 builds (FA2, FA3, MagiAttention).

## Licences, read from the files on 2026-11-17

**LingBot-World v2 (code and every v2 weight): CC BY-NC-SA 4.0.** `LICENSE.txt` in the repo is the full *Creative
Commons Attribution-NonCommercial-ShareAlike 4.0 International* text; the 1.3B weight card is tagged
`license: cc-by-nc-sa-4.0` and its README says *"available for non-commercial use only: you may share and adapt it with
proper attribution, but derivative works must be distributed under the same license"* (the weight repo itself has no
licence file). What the licence says:

- **NonCommercial** (§1 k): *"not primarily intended for or directed towards commercial advantage or monetary
  compensation."* Allowed under the owner's rule (2026-11-17: *"we are not commercial … we are also research and our
  location is the world"*). **If a tenant starts charging money for output from this route, raise it with the owner
  first** (CLAUDE.md).
- **Attribution** (§3 a): when shared, keep the creator's identification, the copyright and licence notices and a link
  to the licence, and say if it was modified. mux credits *the Robbyant Team (Ant Group), LingBot-World v2,
  arXiv:2607.07534* here, in `server/video/lingbot_mps.py`'s header, and in `NOTICE` and `LICENSE.txt` that
  `deploy/video-camera.sh` puts beside the weights.
- **ShareAlike** (§3 b): adapted material we share must carry the same licence (or a BY-NC-SA compatible one).
  `server/video/lingbot_mps.py` is adapted from upstream's code and is therefore **CC BY-NC-SA 4.0**, said in its first
  lines; mux's public repo shares it under that licence. No upstream file is copied into mux; the checkout is imported at
  run time. The rest of mux (the server, the pose mapping, the router) is written for mux and not adapted from it. The
  weights are used unchanged; **changed weights we publish would keep CC BY-NC-SA 4.0** and the credit.
- No territory is excluded.

**Wan2.1 VAE and umT5-XXL** (`Wan-AI/Wan2.1-T2V-1.3B`, `Wan-AI/Wan2.1-VACE-1.3B-diffusers`): **Apache-2.0**
(`LICENSE.txt` in the repo), patent licence included. umT5 is Google's, Apache-2.0.

**Matrix-Game 3.0 (fallback):** weights tagged `apache-2.0`; `Matrix-Game-3/LICENSE.txt` is the Apache License 2.0
(SHA-256 `cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30`); the repository's top-level `LICENSE` is MIT
(*"Copyright (c) 2025 SkyworkAI and contributors"*). **Hy-Nomas (candidate):** *"licensed under Apache-2.0, except for
the third-party components listed below"*; one listed component is under the Tencent Hunyuan Community License (which
excludes the EU — no longer a bar, per the owner's rule), others BSD-3, MIT, HPND.

This is a reading of the licence texts, not legal advice.

## The contract (Thread is built against it)

Base: `MUX_BASE_URL` (the Railway gateway, `…/v1`) with `Authorization: Bearer $MUX_API_KEY` (tenant `thread`).

```
POST /v1/videos/generations
{ model: "video-camera", prompt, negative_prompt?, seed?, fps (8–24), size ("832x480" | "1280x720"), seconds (1–60),
  image_b64,                       // the first frame, PNG/JPEG, at `size` (another size is cropped to fill, with a note)
  camera: { convention: "sets",    // metres, y up, a camera with no turn looks down −z; quat [x, y, z, w]
            sensorMm: [w, h], aspect: "16:9" | "2.39:1" | "1.85:1" | "4:3" | "1:1" | "4:5" | "9:16",
            principal?: [0.5, 0.5],                                   // (mux) as Sets' intrinsics.principal; default centre
            frames: [{ t, pos: [x, y, z], quat: [x, y, z, w], focalMm }] },   // up to 4000; sorted by t
  anchors?: [{ t, image_b64 }] }   // up to 60, 1 s apart, from 1 s to seconds − 1
→ 202 { id, object: "video", status: "queued", model: "lingbot-world-v2-1.3b" }

GET  /v1/videos/{id}          → { id, status: queued | running | succeeded | failed | cancelled, progress 0..1, model,
                                  seconds, size, fps, error?: {type, message}, notes?: [string],
                                  stats?: { … see below } }
GET  /v1/videos/{id}/content  → video/mp4 (H.264, yuv420p), exactly round(seconds × fps) frames, kept 1 hour
POST /v1/videos/{id}/cancel   → { id, status }       (a running take stops at its next step, within seconds)
```

- Same job API, ids, body limit (200 MB), metering and presence as `video` (`docs/video.md`): each mux in the way gives
  its own id per tenant; polls are not metered; nothing about the prompt or a picture is logged.
- **400** names the field: `camera.frames[3].quat must be a unit quaternion …`, `anchors[0].t …`, `seconds must be from 1
  to 60`. The gateway refuses a `video-camera` request without `camera.frames` or `image_b64` before asking any machine.
- **503** when no camera model can take it now — the Mac busy or away, the model off. The type is `no_capable_model`
  when the route's models are all resting (that is what mux answers for `video` too), `all_models_failed` when one was
  tried and failed. Treat both as "try again later". 429 `queue_full` beyond 6 waiting or running.
- **Its own kind.** `video-camera` is a route of kind `video-camera`, and the camera model is of that kind: a route that
  lists no models takes every model of its kind, so without this a Wan model could make a "camera" take ignoring the
  camera, or the camera model refuse a plain `video` request. A request goes to the camera route when `model` names it
  (also through a tenant alias or as `mux/video-camera`) or names a camera model; `model: "video"` with a `camera`
  still goes to Wan, which ignores it.
- **`notes`** (mux): what was done that the caller may not expect — a picture cropped, fps not 16, a lens change, a
  camera standing still, anchors, `negative_prompt` unused.
- **`stats`** (mux) while running `{chunks_done, chunk_s}`; when done `{load_s, encode_s, total_s, chunks,
  chunk_s_median, chunk_s_max, seconds_per_video_second, peak_gb, segments, frames, drift: [{t, luma, contrast,
  sharpness}]}` — the numbers the prototype is for. `drift` has one entry per chunk (each second): the mean luma, its
  spread and the variance of a Laplacian (sharpness) of the chunk's last frame. A take drifting shows as luma or
  contrast walking away and sharpness falling; it is no measure of whether the set stayed the set (watch the video).

## The pose mapping

Sets (Thread `src/sets/setDoc.ts`): camera to world, metres, y up, quaternion `[x, y, z, w]`, the camera's axes those of
three.js: x right, y up, looking down −z. LingBot-World v2 (`wan/image2video.py`, `wan/utils/cam_utils.py`): OpenCV
camera-to-world (x right, y down, looking down +z) plus `fx fy cx cy` in pixels. In `server/video/camera_poses.py`:

1. **Time.** The model makes 16 frames a second and reads one pose per latent frame: video frame 4j, t = j/4 s. The
   path is sampled there — position and focal length linearly, rotation by slerp, between the two given frames around
   t; before the first and after the last frame the camera holds. **Send the path already sampled at fps as Sets plays
   it** (Catmull-Rom, eases and shake included); mux then only fills between frames and never re-curves the path.
2. **Axes.** `R_cv = R_sets · diag(1, −1, −1)`, position unchanged: the camera's y and z axes flip, the world stays as
   it is. A camera with no turn becomes one looking down the world's −z with its image "down" along the world's −y.
3. **Relative, frame by frame.** Each pose in the camera frame of the one before (`inv(c2w[j−1]) · c2w[j]`, the first the
   identity) — upstream's `compute_relative_poses(framewise=True)`. The world's own axes cancel here, so Sets' y-up world
   needs no conversion. A dolly forward is +z, a pan left turns the forward to −x, a tilt up to −y (tested).
4. **Scale.** The steps' translations are divided by the take's largest step (upstream: *"scale the coordinate inputs to
   roughly 1 standard deviation"*). Metres never reach the model, only the shape of the move and its speeds relative
   to each other. One scale for the whole take, anchors included. **mux's change:** below 1 cm per latent frame
   (4 cm/s) the take counts as standing, and its steps are divided by 1 cm instead, so a locked-off or handheld shot
   does not have its millimetres of shake blown up into full steps (`MUX_CAMERA_MIN_STEP_M`; 0 is upstream's way).
5. **Lens.** `fx = focalMm / frameW · width`, `fy = focalMm / frameH · height`, `cx, cy = principal · size`, where the
   frame is the sensor cut to the aspect (`sw/sh ≥ a ? [sh·a, sh] : [sw, sw/a]`) — exactly Sets' `pinholeOf`. The model
   takes **one lens per take** (upstream reads `Ks[0]`), the first frame's; a zoom is noted, not followed.
6. **Rays.** Plücker rays per pixel (origin = the step's translation, direction = its rotation of the pixel ray), folded
   8 × 8 into 384 channels per latent pixel, as upstream (`get_plucker_embeddings` and its rearranges; tested equal).
7. **Frames out.** The model's 16 fps frames go to the mp4 at the asked fps by nearest frame (8 fps drops every other,
   24 fps repeats every second one). **Ask for 16 fps**; other rates are noted.
8. **Anchors** (prototype). The take is cut at each anchor's time; from there the model starts again from the anchor's
   picture with a fresh KV cache, along the same path. That is exactly how the model was trained to start (so it is in
   its comfort zone) and stops drift at each anchor, but **the cut can show**: the frame before is the model's, the frame
   after is the anchor. Injecting anchors into a running take (re-encoding them into the KV cache) would be smoother and
   is not tried.

## What was ported for MPS (`server/video/lingbot_mps.py`)

- **flash-attn → PyTorch SDPA.** Upstream's `attention()` already falls back to SDPA, but the cross-attention calls
  `flash_attention` directly, which asserts a CUDA device. Both now use SDPA in bfloat16 (as flash-attn computes), split
  over the queries so the score matrix stays under `MUX_CAMERA_ATTN_MB` (1 GB; at 720p it would otherwise be ~22 GB).
- **No float64 on MPS.** The 3D RoPE is applied in float32 real arithmetic (its cos/sin table computed in float64 first)
  instead of complex128; the timestep embedding is computed in float64 on the CPU and moved over as float32.
- **A silent MPS bug, found by the parity tests:** `tensor.to("cpu", torch.float64)` of an MPS int64 tensor returned
  **zeros** (PyTorch 2.14.1). The timestep embedding then saw t = 0 at every step and the tiny test model came out
  11.5 % off the CPU; done in two steps (to the CPU, then to float64) it is 7·10⁻⁵ off.
- **Imports without CUDA.** `wan/modules/t5.py` evaluates `torch.cuda.current_device()` as a default argument at import;
  `wan/__init__.py` pulls in the distributed code, torchvision and scipy. The modules are imported one by one under stub
  packages, and the T5 import is given a stand-in for `current_device`.
- **Precision without CUDA autocast.** Upstream wraps parts in `torch.amp.autocast('cuda', float32)`, a no-op on a Mac,
  and an MPS matmul of float32 by bfloat16 **aborts the process** (a Metal assertion, not an exception). So the DiT runs
  in float32 by default: on this M3 Ultra float32 matmuls ran at 17.6 TFLOPS against bfloat16's 19.0 (measured here at
  the 1.3B's shapes), so it costs ~7 % in speed and 3.4 GB of memory, and every upstream float32 region stays float32.
  `MUX_CAMERA_DTYPE=bf16` runs it in bfloat16 under MPS autocast (untested).
- **One device, no torchrun:** no NCCL, FSDP or Ulysses; every PyTorch call on one worker thread.
- **The loop as a stream.** `_generate_causal_fast` rewritten as a generator: the first-frame condition is VAE-encoded
  and the latents decoded **chunk by chunk** (the Wan VAE is causal, so it is exact — tested equal to upstream's
  whole-clip encode and decode), frames go to ffmpeg as each chunk is done, and memory does not grow with the take: a
  60 s take does not hold 960 frames, nor upstream's 4.6 GB tensor of zeros for the condition. Once two all-zero
  condition chunks encode the same, that latent is reused (`torch.equal`, exact).
- **T5 let go after the prompt** (`MUX_CAMERA_KEEP_T5=1` keeps it); embeddings of the last 8 prompts are kept, keyed by
  SHA-256, never the prompt.
- **Memory (2026-11-17, after the first real clip peaked at 73 GB).** Measured phase by phase on the real weights
  (`torch.mps.current_allocated_memory` against `driver_allocated_memory`): the DiT, KV cache and T5 were as estimated;
  the excess was the **Wan VAE's `CausalConv3d` on MPS**. At 480p each conv3d holds scratch outside PyTorch's
  allocator, and the driver's share grew to 69 GB while PyTorch had 21 GB in use (the VAE alone: 27 GB for 7 GB in use).
  Now each `CausalConv3d` runs as a sum of 2D convolutions over its time taps (`causal_conv3d_taps`: the same sums,
  zero padding frames skipped; within 10⁻⁵ of upstream's conv3d for every shape the VAE has, decoded frames within one
  8-bit level, and faster), MPS's cache is emptied after the first-frame encode, after each decoded latent frame and
  after every chunk, and the encoder's cache is let go once the all-zero latent is steady.

## Does it run on Apple Silicon? What is proven and what is not

| | Status | Evidence |
|---|---|---|
| Each MPS replacement against upstream's code | **Proven** (this Mac: M3 Ultra, 96 GB, PyTorch 2.14.1 MPS) | `server/video/test_lingbot_mps.py` with tiny random weights: RoPE ≤ 10⁻⁵ from upstream's float64 one; timestep embedding 10⁻⁶; SDPA (split, masked) within bf16 of the reference; the sampler's timesteps and sigmas equal upstream's `FlowUniPCMultistepScheduler`; Plücker rays and framewise poses equal upstream's `cam_utils` (10⁻⁵, 10⁻⁴) |
| The chunked VAE | **Proven** equal to upstream's (tiny random Wan VAE) | encode 10⁻⁵, decode within one 8-bit level |
| Upstream's DiT code on MPS, causal KV cache with eviction | **Proven** with a 2-layer model | 3 chunks, window 6, sink 1: MPS against CPU 7·10⁻⁵ relative (5·10⁻⁷ with float32 attention); against upstream's float64 RoPE path 10⁻⁴ |
| The whole take loop on MPS | **Proven** with tiny weights | `LingBotCamera.segment`, 4 chunks past the KV window: 13 + 16 + 16 + 16 frames, every step reported |
| The real weights fit the model | **Proven without downloading** | The Hub's `model.safetensors.index.json` lists exactly the model's 1071 tensors, none missing or extra, and 1 709 502 016 parameters × 4 bytes = its `total_size` 6 838 008 064 |
| The text encoder's tokens | **Proven** | Upstream's own tokenizer and cleaning (`HuggingfaceTokenizer(clean='whitespace')` on Wan's `google/umt5-xxl`) and mux's (the VACE folder's tokenizer, `clean_prompt`) give identical ids and masks on four prompts, one over 512 tokens, one with HTML entities, CJK and emoji |
| The text encoder's numbers (diffusers umT5 against Wan's `.pth`) | **Not proven here** | the same Google umT5-XXL weights; diffusers' Wan pipelines use exactly this. `MUX_CAMERA_T5_PTH` switches to Wan's own if in doubt |
| The job API, pose mapping, anchors, fps, mp4 | **Proven** with a stub model | `server/video/test_camera_server.py`: every field's 400, the axis mapping (dolly, pan, tilt, world-invariance), Sets' intrinsics, frames in order in the H.264 mp4, 24 fps, anchors restarting from their pictures, cancel, the queue, the lock shared with the Wan server, expiry, nothing of the prompt or picture in the log |
| The gateway | **Proven** | `server/test/video.test.ts`: camera takes go only to camera models and plain video never does (even with empty routes), alias and `mux/` names, 400 before any machine, 403 without the route, 503 without a model |
| **The real 1.3B on MPS: pictures, speed, memory over 2 s** | **Proven** (2 s clips, 832×480) | the picture is right (the lake, the tree, the walk); 28.2 GB peak, 33.8 s per second of video: *Measured on the Mac* below |
| Camera adherence and drift over 20–60 s | **Not proven** | `--measure 30` gives the numbers; not run yet |
| bfloat16 DiT (`MUX_CAMERA_DTYPE=bf16`), 1280×720, the `.pth` T5 path | **Not proven** | written, not run |
| Anchors' seams | **Not proven** | the cut is by design; how visible it is wants watching |
| Matrix-Game 3.0, Hy-Nomas | **Not ported** | licences and pins above |
| macOS itself | **A known risk** | the measure work met a report of macOS 26.4 reserving ~40 GiB of MPS memory on a 48 GB Mac; if a load fails with plenty free, check the macOS version first |

### Memory and time (estimates, before the Mac measured them; the measured numbers are below)

| | 832 × 480 | 1280 × 720 |
|---|---|---|
| DiT (float32) | 6.8 GB (3.4 GB in bf16) | same |
| VAE | 0.5 GB | same |
| umT5-XXL (bf16, only while the prompt is encoded) | 11.4 GB | same |
| KV cache (30 layers, 18 latent frames, bf16) | 5.2 GB (28 080 tokens) | 11.9 GB (64 800 tokens) |
| Peak (estimate) | **~20 GB** (while encoding the prompt), ~16 GB while making the take | ~25–28 GB |
| One DiT forward, window full (estimate) | ~3.7 s: 21 TFLOP of matmuls at 17.6 TFLOPS + 32 TFLOP of attention at 13.2 TFLOPS (both rates measured on this Mac at these shapes) | ~16 s (49 + 172 TFLOP) |
| **One chunk = 1 s of video** (5 forwards + VAE) | **~20–30 s**; the first five chunks less (the window fills) | ~1.5–2 min |
| A 60 s take | **~20–30 min** | ~1.5–2 h |

The server loads only with **24 GB free** on macOS (`MUX_CAMERA_MIN_FREE_GB`), as mux's 48 GB budget does not count it.
Upstream's 720p-at-60-fps claim is for its own unreleased multi-GPU deployment with a TensorRT refiner; nothing like it
is expected here. **Write the real numbers here** from `deploy/video-camera.sh` (`~/.mux/logs/video-camera-test.json`,
`video-camera-measure-N.json`).

### Measured on the Mac

M3 Ultra, 96 GB, PyTorch 2.14.1 MPS, a llama-server chat model (~19 GB) resident beside it. The deploy's 2 s test take
(832×480, 16 fps, seed 7, `examples/03/image.jpg`, the sample walk), 3 chunks, the model loading on the job:

| 2026-11-17 | Peak | Seconds per video second | Chunk (median / max) | Text encode | Total |
|---|---|---|---|---|---|
| Before (a4ff1e2) | **73 GB** (MPS driver; swap grew to 36 GB, an earlier try filled the disk and was SIGKILLed) | **95.5 s** | 62 / 79 s | 11.7 s | 191 s |
| After (`causal_conv3d_taps`, caches emptied) | **28.2 GB** (the process's footprint, MPS buffers included; no swap growth) | **33.8 s** | 20 / 23 s | 7.1 s | 68 s |

Phase by phase after the change (profiled the same way): DiT loaded 7.4 GB; with T5 encoding 19 GB, then T5 let go;
the take holds 17.6 GB in use (DiT 6.9 + KV cache 5.2 + VAE decoder cache 3.6 + the encoder's) and the footprint stays
at 25–27.6 GB through every chunk; the VAE decode of a chunk is the high point. The picture is the same take as before:
PSNR 41.6 dB between the two mp4s (same seed; float rounding through the sampler), the drift record equal to within
1 % (luma 181.4/179.1/179.0 against 181.5/179.1/179.0). The before numbers were slow because the Mac was swapping.

**The memory guard.** `camera_server.py` refuses a take with **503 `memory_busy`** (*"the Mac is short of memory: N GB
free and a 832x480 take needs about M GB more …"*) when macOS's free memory plus what the server already holds is
below the take's peak (`MUX_CAMERA_PEAK_GB` 28, `MUX_CAMERA_PEAK_720_GB` 46 — an estimate — plus `MUX_CAMERA_SPARE_GB`
2; a larger peak once seen is kept), and a queued take that no longer fits fails the same way when it starts. Its
`/v1/models` says `need_gb`, and mux's `roomForService` (runtime/manager.ts) unloads idle models, least recently used
first, to make that room before it forwards a take — also with the model loaded — and refuses in words (503) if it
cannot. `deploy/video-camera.sh` registers the model with `size_bytes` 28 GB for that. PyTorch's own MPS allocator is
capped at 0.6 of Metal's working set (`PYTORCH_MPS_HIGH_WATERMARK_RATIO`) as a last guard: past it a take fails with
`out_of_memory` instead of swapping. 1280×720 is not measured.

## Running it

On the Mac, once this is on `main` and mux has been rebuilt and restarted (the route `video-camera` and its kind come
with the new mux; the script checks):

```sh
cd ~/_code/mux/mux && git pull --ff-only && npm run build && launchctl kickstart -k gui/$(id -u)/com.mux.server
./deploy/video-camera.sh --measure 30 --railway
```

`video-camera.sh` makes `~/.mux/video-camera-venv` (the Wan server's pins plus einops), clones the code at its commit,
fetches the weights at their revisions and checks every SHA-256, runs the port's parity tests on this Mac, starts
`com.mux.video-camera` on :8315, registers `lingbot-world-v2-1.3b` on the route `video-camera`, makes a 2 s test clip
(`~/.mux/logs/video-camera-test.mp4`, its numbers in `video-camera-test.json`). `--measure 30` then makes a 30 s take
(5–60) and prints seconds per chunk, peak memory and the drift record. `--railway` deploys the gateway from a clean
worktree of `origin/main`, waits for the route and `mac-studio/lingbot-world-v2-1.3b`, and allows `video-camera` for
the `thread` tenant. Files: `server/video/camera_server.py`, `camera_poses.py`, `lingbot_mps.py`; logs in
`~/.mux/logs/video-camera.log` (load and let-go, each take's timings, a failed job's error class; no prompts or
pictures). Tests without the weights: `~/.mux/video-venv/bin/python server/video/test_camera_server.py`; with the
checkout: `MUX_CAMERA_CODE=~/.mux/lingbot-world-v2 ~/.mux/video-camera-venv/bin/python server/video/test_lingbot_mps.py`;
the gateway's: `cd server && npm test`.
