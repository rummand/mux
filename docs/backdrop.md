# Backdrops on mux (2026-11-17)

Thread's Sets draws a world beyond the set's edge: distant hills, a coast, a skyline. Thread's World Models proposal
(`thread/docs/proposals/2026-11-17-world-models-for-sets.html`, section 08; research in
`thread/docs/research/hunyuanworld-for-sets.md`) set the order, and the owner said go on it:

1. **a panorama from text or an image** — HunyuanWorld 1.0's panorama step, 1920 × 960 equirectangular;
2. **the panorama plus MoGe-2 depth, shaped into a dome** — a cheap backdrop that needs none of Tencent's mesh code;
3. Thread draws it beyond the set's edge (Thread's side, another piece of work);
4. only if the dome is not enough, the full layered scene step (not now).

This is steps 1 and 2, on the Mac Studio, behind one route: `backdrop`. The owner (2026-11-17): *"we need everything
hosted on mux"*.

## The choice

| Part | What | Pinned |
|---|---|---|
| Panorama code | **HunyuanWorld 1.0**'s panorama step (Tencent): `hy3dworld/models/pano_generator.py` and `pipelines.py` — FLUX pipelines that roll the latents and blend the left and right edges during the first steps, and decode with a tiler that wraps around, so the seam closes | [`Tencent-Hunyuan/HunyuanWorld-1.0`](https://github.com/Tencent-Hunyuan/HunyuanWorld-1.0) at `57fa9f3a79eae1079c279968cdb9d82c75fa7c86` (cloned to `~/.mux/backdrop/HunyuanWorld-1.0`, used unmodified) |
| Panorama LoRAs | `HunyuanWorld-PanoDiT-Text` (text) and `HunyuanWorld-PanoDiT-Image` (image), rank-128 LoRAs on every double and single block of the FLUX transformer (transformer only: the text encoders are untouched, read from the safetensors headers) | [`tencent/HunyuanWorld-1`](https://huggingface.co/tencent/HunyuanWorld-1) at `43c47e7c5d7e5c6ac0f8410cb1df31a4af815d88`; `PanoDiT-Text/lora.safetensors` 478 187 784 bytes, SHA-256 `704431edbf336f161810f51252f9916e374dc00190c00d34a6a0b6a80c76511d`; `PanoDiT-Image/lora.safetensors` 478 187 784 bytes, SHA-256 `3e5aad27a015e238f28bfc50aceb959d34c85c380f516cc9d1f46c910e4b2e9d` (checked by `deploy/backdrop.sh`) |
| Base, text | **FLUX.1-dev** (Black Forest Labs), diffusers layout only: transformer 23.8 GB, T5-XXL 9.5 GB, CLIP-L 0.25 GB, VAE 0.17 GB (not its single-file `flux1-dev.safetensors` and `ae.safetensors`: 24 GB more for nothing) | [`black-forest-labs/FLUX.1-dev`](https://huggingface.co/black-forest-labs/FLUX.1-dev) at `3de623fc3c33e44ffbe2bad470d0f45bccf2eb21` (gated) |
| Base, image (`--image`) | **FLUX.1-Fill-dev**: its own transformer (23.8 GB), VAE and scheduler; its tokenizers and text encoders are FLUX.1-dev's (the tokenizer files have the same git hashes in both repositories, the text-encoder shards the same sizes), so they are not downloaded twice | [`black-forest-labs/FLUX.1-Fill-dev`](https://huggingface.co/black-forest-labs/FLUX.1-Fill-dev) at `358293da0354175698b67ec8299acf928313a78a` (gated) |
| Depth | **MoGe-2** ViT-L with normals (Microsoft): metric scale, MIT | code [`microsoft/MoGe`](https://github.com/microsoft/MoGe) at `07444410f1e33f402353b99d6ccd26bd31e469e8` (MoGe 2.0.0, the last release before MoGe-3, whose new `flex-gemm` dependency is a CUDA kernel library); weights [`Ruicheng/moge-2-vitl-normal`](https://huggingface.co/Ruicheng/moge-2-vitl-normal) at `cb0e8bbd6b1e243589717c78e750b1ba4c093acf`, `model.pt` 1 323 815 904 bytes, SHA-256 `280741fd09bc3f403ccff9967784c2a391b52d2c0742ae3efdb21d9f90cc1a01`; `utils3d` at `3fab839f0be9931dac7c8488eb0e1600c236e183` (as MoGe 2.0.0 pins it) |
| Dome | `server/backdrop/dome.py`: numpy and Pillow, no model | this repo |
| Runtime | PyTorch 2.14.1 on **MPS**, bf16 (FLUX); fp32 (MoGe-2, `MUX_BACKDROP_MOGE_FP16=1` to try half); diffusers 0.34.0, transformers 4.51.0, peft 0.15.0, accelerate 1.6.0 — what HunyuanWorld 1.0 was tested with (`docker/HunyuanWorld.yaml`), since its pipelines subclass diffusers' Flux internals | `deploy/backdrop.sh` |

FLUX's SHA-256s are behind Hugging Face's gate (its API shows them only to a logged-in account that accepted the
licence). `hf download` checks each file against the pinned revision as it comes; `deploy/backdrop.sh` then writes
`SHA256SUMS` beside the weights on the first download and checks them on every later run. **Put those sums here after
the first run.**

### Why this pipeline, and not the alternatives

- **HunyuanWorld 1.0's own panorama code, not plain FLUX.** A plain FLUX at 2:1 draws a wide picture, not a 360°
  panorama: its edges do not meet and its poles are wrong. The PanoDiT LoRAs were trained on equirectangular
  panoramas, and the pipelines blend the seam. Their code is used as published, loaded file by file (the package's
  `__init__` imports the scene step — open3d, ZIM, Grounding DINO, Real-ESRGAN, MoGe v1 — none of which a panorama
  needs). Its only CUDA-specific parts (fp8 GEMM and attention, `enable_model_cpu_offload`) are not used.
- **diffusers on MPS, not MLX.** mflux (MLX) runs FLUX.1-dev with LoRAs, but not HunyuanWorld's seam blending and wrap-
  around decode; porting those is a later speed-up, behind the same API (`make_panorama` in the server).
- **MoGe-2, not MoGe v1** (HunyuanWorld's own): MoGe-2 gives metric scale; MIT either way. MoGe's own panorama recipe
  (20 perspective views of 90°, merged by a Poisson solve on log distance) is used as published; the merge keeps
  shape but not scale, so the server puts the scale back as the median ratio of each view's own distance to the merged
  one along the same rays.
- **The dome, not the scene step.** The scene step builds two FLUX.1-Fill pipelines at once (~68 GB), plus four other
  models; the dome needs none of it. Step 4 of the proposal comes only if the dome is not enough.

## The pipeline (one job)

1. **Prompt → embeddings.** FLUX.1-dev's T5-XXL and CLIP-L load (bf16, ~10 GB), encode the prompt (and, from an
   image, HunyuanWorld's negative prompt), and are let go.
2. **Panorama.** The FLUX transformer with the PanoDiT LoRA fused in (text: FLUX.1-dev + PanoDiT-Text; image:
   FLUX.1-Fill-dev + PanoDiT-Image, the photo placed at 80° field of view facing forward, the rest masked to be made).
   HunyuanWorld's settings: 50 steps, guidance 30, seam blend 6 latent columns; from an image, true CFG 2.0. 1920 × 960.
   Cancel and progress are checked at every step. Progress 0.03 → 0.80.
3. **Depth.** MoGe-2 on 20 views of 512 px, merged at 1024 × 512 (`MUX_BACKDROP_MERGE_WIDTH`), the metric scale put back,
   resized to 1920 × 960. Sky is where no view saw a surface. Progress → 0.95.
4. **Dome and meta** (`dome.py`), below. Progress 1.0.

### The dome (`server/backdrop/dome.py`, tested without weights)

- **Frame:** y up, the camera at the origin, **−z is the panorama's centre column** (u = 0.5), +x a quarter turn to its
  right (u = 0.75). The direction of panorama pixel (u, v) is `(cos lat sin lon, sin lat, −cos lat cos lon)` with
  `lon = (u − 0.5)·2π`, `lat = (0.5 − v)·π`.
- **One mesh, the panorama as its texture** (an embedded JPEG, `KHR_materials_unlit`, not double-sided, the sampler
  wrapping around the seam). The contract allows vertex colours or a texture: a texture keeps the panorama sharp where
  vertex colours at this grid would blur it.
- **A radial graph:** every vertex lies on its own grid ray (256 columns + the seam column again, 128 rows plus six
  just below the horizon, `MUX_BACKDROP_GRID`), so from the origin it is exactly the panorama whatever the depth does.
  Triangles wind counter-clockwise seen from the origin: **they face inward**. Each pole is one point. Welded by
  position, every edge is in exactly two faces: **the dome is closed**, under the horizon and over it.
- **Scale:** the median horizon distance is **100 units**. Per column, the horizon distance is the median distance of
  what stands on the horizon (from it to 1.5° above); where nothing does (open sea, a plain), the farthest ground seen
  within 1.5° below it; smoothed around the seam.
- **Ground:** every ray below the horizon ends on a **floor at y = −1.6** (the eye height), or, where the thing at the
  horizon in that column stands nearer than the floor reaches, on a vertical wall at that thing's distance coming down
  to the floor. So the floor meets Sets' ground, and the walls stand on it. Six extra rows just below the horizon (where
  a wall 800 down to 25 units out meets the floor: 0.1° to 3.7° down) keep the floor from sloping up to the horizon.
- **Above the horizon** each ray ends at its own depth (scaled, at least 1 unit); the sky at **1000 units**.
- **The ground plane** is fitted to the depth (RANSAC, residual relative to distance) to give the camera's height and
  the tilt. The dome itself is not turned by the tilt: a generated panorama is level, and a depth model's few tenths
  of a degree are noise.
- Size: ~34 000 vertices, ~67 000 triangles, ~1.5 MB with a real panorama's JPEG; 0.2 s to build. Khronos'
  glTF validator: no errors, no warnings.

## Memory: the plan, and what was chosen

The research said the panorama step needs ~34 GB (FLUX's bf16 transformer 23.8 GB + T5-XXL 9.5 GB + CLIP and VAE). This
Mac is an M3 Ultra with 96 GB (macOS 26.3); mux's chat models share it.

- **Never hold the text encoders and the transformer at once (chosen).** They are used one after the other: a job
  encodes its prompt (~10 GB), lets the encoders go, then denoises with the transformer (~24 GB + the work at 1920 × 960).
  Peak ≈ **27–30 GB** instead of 34 GB plus. When the transformer is still in memory from the last job and macOS has
  room for the encoders beside it, it stays; if not, it goes first and comes back after.
- **CPU offload does not help here (not chosen).** `enable_model_cpu_offload` and sequential offload move weights
  between the CPU's and the GPU's memory — which on Apple Silicon are the same memory. They would only add copying.
  HunyuanWorld's demo uses offload for CUDA cards; on MPS the pipeline is moved to the device instead.
- **bf16, not fp16 (chosen).** FLUX's T5 and transformer overflow in fp16 (NaN images); bf16 runs on MPS on macOS 14+.
  MoGe-2 runs in fp32 (it is small: 1.3 GB, a few GB at work).
- **Other mux models go first (chosen, `runtime/manager.ts` `roomForService`).** The model is registered with
  `size_bytes` = 30 GB, what it needs free to load. When a backdrop is asked for and the server has nothing loaded, mux
  checks macOS's free memory; if it lacks 30 GB plus mux's headroom (10 GB), it unloads its own idle, unpinned models,
  least recently used first. If that is still not enough (everything else busy or pinned), the request is refused at
  once — **503 `all_models_failed`, saying how much is free and how much is needed** — instead of failing minutes
  later. The backdrop server checks again before each part loads (`MUX_BACKDROP_TEXT_FREE_GB` 12,
  `MUX_BACKDROP_PANO_FREE_GB` 30, `MUX_BACKDROP_DEPTH_FREE_GB` 5) and refuses a new job with 429 `busy` in the same
  words when nothing is loaded and the room is not there (mux passes it on as the 503).
- **Let go when idle:** the transformer and MoGe-2 go after 10 idle minutes (`MUX_BACKDROP_IDLE_MIN`).
- **Not done yet:** 8-bit FLUX (optimum-quanto or a GGUF transformer, ~12 GB) would halve the peak; unproven on MPS and
  slower per step there. The first thing to try if the Mac is too often busy for 30 GB.

## Licences, read from the files on 2026-11-17

The owner's rule (CLAUDE.md, 2026-11-17): *"we are not commercial"*, *"we are research and our location is the
world"*. Every model here is allowed by it; every term is written down so it can be kept, or raised if Thread changes.

### Tencent HunyuanWorld-1.0 Community License Agreement (the code and the PanoDiT LoRAs)

Read from `LICENSE` in the GitHub repository at the pinned commit; the Hugging Face copy (`tencent/HunyuanWorld-1`,
tag `license:other`, `tencent-hunyuanworld-1.0-community`) is the same text. Release date July 27, 2025.

- **Territory (§1l, §2, §5c, AUP 1).** *"THIS LICENSE AGREEMENT DOES NOT APPLY IN THE EUROPEAN UNION, UNITED KINGDOM AND
  SOUTH KOREA."* The licence is granted *"for the Territory only"*, and §5c: *"You must not use, reproduce, modify,
  distribute, or display the Tencent HunyuanWorld-1.0 Works, Output or results of the Tencent HunyuanWorld-1.0 Works
  outside the Territory. Any such use outside the Territory is unlicensed and unauthorized."* **The Mac is in Denmark
  (EU).** So running it here, and using its outputs here, is outside what the licence grants. This is an **accepted
  risk under the owner's rule**, not something the licence permits.
- **No training other models on it (§5b):** *"You must not use the Tencent HunyuanWorld-1.0 Works or any Output or
  results … to improve any other AI model."* No backdrop (panorama, depth, dome) may be used to train or tune any
  model, Thread's own included.
- **Over 1 million monthly active users (§4):** a separate licence must be requested from Tencent (counted on the
  release date, for all products of the licensee).
- **Offering it to third parties (§3e):** whoever uses it to provide a service to third parties must disclose to end
  users the provider's full legal name, and *"expressly and conspicuously state that Tencent is not affiliated with,
  associated with, sponsoring, or endorsing"* it; no Tencent marks that suggest affiliation. **Thread must show this
  where backdrops appear** (e.g. "Backdrops made with Tencent HunyuanWorld 1.0. Tencent is not affiliated with Thread.").
- **Distribution (§3a–d)** (giving the Works themselves — code or weights — to others, not serving outputs): a copy of
  the Agreement, prominent notices on changed files, and a `Notice` file with *"Tencent HunyuanWorld-1.0 is licensed
  under the Tencent HunyuanWorld-1.0 Community License Agreement, Copyright © 2025 Tencent. All Rights Reserved. The
  trademark rights of "Tencent Hunyuan" are owned by Tencent or its affiliate."* mux does not distribute them (it
  clones and downloads them on the Mac; nothing of Tencent's is committed here). `deploy/backdrop.sh` keeps `LICENSE`
  and `NOTICE` beside the weights. §3c *encourages* (not requires) "Powered by Tencent Hunyuan".
- **Acceptable Use Policy (Exhibit A):** among others, not outside the Territory; not for military purposes; not to
  harm minors; no disinformation, harassment, impersonation without consent; and (item 12) *content placed in any
  public context must be "expressly and conspicuously" identified as machine generated* — Thread's AI label covers it.
- **Outputs (§6d):** *"Tencent claims no rights in Outputs You generate."* Hong Kong law and courts (§9). As-is.
- The repository's `NOTICE` lists Apache-2.0 components Tencent modified (autofp8, DeepCache): not used here.

### FLUX.1 [dev] Non-Commercial License v1.1.1 (FLUX.1-dev and FLUX.1-Fill-dev)

Read from `LICENSE.md` at the pinned revision (the same file in both repositories and in `black-forest-labs/flux`'s
`model_licenses/LICENSE-FLUX1-dev`). Gated: the owner accepts it on Hugging Face.

- **Non-commercial only (§2a–b, §4a(i)).** "Non-Commercial Purpose" (§1c) is personal research, experiment, testing,
  hobby projects, or *"use by commercial or for-profit entities for testing, evaluation, or non-commercial research and
  development in a non-production environment"* — **and it excludes use *"(b) in direct interactions with or that has
  impact on end users"*.** Read literally, showing backdrops to Thread's users is outside even if nothing is charged.
  Allowed under the owner's rule ("we are not commercial, we are research"); written here because it is stricter than
  "no money". **If Thread charges for anything built on it, or stops being research, raise it with the owner first.**
- **Content filtering and AI disclosure (§2e) — conditions of using it at all:** either (A) *"implement and maintain
  content filtering measures … to prevent the creation, display, transmission, generation, or dissemination of
  unlawful or infringing content"*, or (B) review output for unlawful or infringing content before it is distributed
  or displayed; and the output must carry a disclosure that it was AI-generated where the law requires. **mux does not
  filter prompts.** Thread's illegal-content protections (its prompt checks) must run before it calls
  `/v1/backdrops`, and its AI label must stay on backdrops. (CLAUDE.md in Thread: never remove them.)
- **Outputs (§2d):** BFL claims no ownership; outputs may be used for any purpose *"except as expressly prohibited"*;
  they *may not be used to train, fine-tune or distill a model that is competitive with FLUX.1 [dev]*.
- **Restrictions (§4a):** no military purposes, surveillance, biometric processing, unlawful content, violating
  privacy laws (GDPR and the EU AI Act named), export-control breaches. No circumventing its protections (§4c).
- **Distribution (§3)** of the weights or derivatives (not outputs) needs the licence and BFL's Attribution Notice; mux
  does not distribute them. A LoRA fused in memory is not distributed.
- Revocable at any time on notice (§8b); Delaware law. As-is, indemnification of BFL (§7).

### MoGe-2 and the rest

- **MoGe (code and the `moge-2-vitl-normal` weights): MIT** (`LICENSE` at the pinned commit: *"Copyright (c) Microsoft
  Corporation"*, the MIT text; the same file also carries the Apache-2.0 text, for the DINOv2 code under
  `moge/model/dinov2` that comes from Meta's DINOv2, which is Apache-2.0). Hugging Face tag `license:mit`. Keep the
  copyright notice (`deploy/backdrop.sh` copies `LICENSE` beside the weights). No field or territory limit.
- `utils3d` (EasternJournalist): MIT. diffusers, transformers, accelerate, peft: Apache-2.0. PyTorch: BSD-3-Clause.
  OpenCV: Apache-2.0.

This is a reading of the licence texts, not legal advice.

## Does it run on Apple Silicon? What is proven and what is not

| | Status | Evidence |
|---|---|---|
| The job API (create, status, the three files, cancel, expiry, queue, body limit, busy, one device thread, nothing logged) | **Proven without weights** | `server/backdrop/test_backdrop_server.py`, stub model |
| The dome (frame and axes, scale 100, floor at −1.6, walls meeting the floor, closed, faces inward, radial, poles, seam, a tilted camera, noisy depth, an open plain, all sky) | **Proven without weights** | `server/backdrop/test_dome.py` on synthetic scenes with known geometry; the GLB read back by trimesh and passed by Khronos' glTF validator (0 errors, 0 warnings) |
| The depth PNG (16-bit grey, mm when metric, relative past 65.5 m, sky 0) and the meta | **Proven without weights** | both test files |
| The gateway (route, per-tenant ids, auth, isolation, files byte for byte, body limit, the node chain from Railway, presence, busy as 503 `all_models_failed` in words, no cooldown for busy, mux making room or refusing) | **Proven without weights** | `server/test/backdrop.test.ts` |
| HunyuanWorld 1.0's panorama step on MPS | **Not proven.** Plausible: pure PyTorch and diffusers, no custom kernels in the panorama path; the FLUX pipelines in diffusers run on MPS in bf16 elsewhere | Nobody has published a Mac run of HunyuanWorld 1.0 (searched 2026-11-17). Its pipelines were tested on CUDA with diffusers 0.34.0. Loading it without its text encoders (`text_encoder=None`) and passing embeddings is diffusers' documented path, but HunyuanWorld's subclass has not been run that way |
| FLUX.1-Fill-dev assembled from its transformer, VAE and scheduler with FLUX.1-dev's tokenizers and text encoders | **Not proven** | identical tokenizer files, text-encoder shards of identical size (their SHA-256s are behind the gate); not run |
| MoGe-2 on MPS | **Likely, not proven.** Pure PyTorch (DINOv2 ViT-L with SDPA attention, conv heads, no custom kernels); xFormers is optional and absent on a Mac | read in the code at the pinned commit; no Mac run looked for or found |
| The scale put back after MoGe's panorama merge | **Written, not run** | the merge (a Poisson solve on log distance) is MoGe's own; the ratio is the server's |
| Memory and time | **Estimates** (below) | — |
| macOS | **Known risk** | the Developer Forums report of macOS 26.4 reserving ~40 GiB of MPS allocations (docs/measure.md); this Mac is on 26.3 |

**`deploy/backdrop.sh` ends with the first real proof:** one backdrop from text through this Mac's mux (so mux makes
room for it as it would for Thread), checked (sizes, 16-bit depth, the floor at −1.6, the horizon ring at 100, the
seam), with its time and the lowest free memory while it ran. With `--image`, a second from a crop of the first
panorama. **Write the numbers here.**

### Time and memory (estimates, before the Mac measures them)

| | Estimate | From |
|---|---|---|
| First load | 1–3 min (24 GB transformer + 10 GB encoders from the SSD, the LoRA fused) | weight sizes, the video server's load times on this Mac |
| A text backdrop, warm | **4–9 min**: encode ~20 s; 50 steps at 1920 × 960 ≈ 4–8 s a step; MoGe-2's 20 views ~0.5–1 min; merge and dome < 1 min | my estimate, not a measurement: FLUX.1-dev in diffusers on an M3 Ultra's GPU at ~2–4 s a step at 1024², × ~2 for the 1.8× tokens at 1920 × 960 |
| From an image | **8–16 min** (true CFG doubles every step) | as above |
| Peak memory | ~27–30 GB while denoising; ~10 GB while encoding; ~3–5 GB for MoGe-2 | weights + activations |

`MUX_BACKDROP_STEPS` (default 50, HunyuanWorld's) trades quality for time; 28 is FLUX.1-dev's usual.

### If it does not run on MPS

1. Read `~/.mux/logs/backdrop.log` (load and let-go only, and a failed job's error class; never a prompt).
2. `out_of_memory` with plenty free: the macOS 26.4 issue above, or a peak at the VAE decode (HunyuanWorld's tiled
   decoder is used, as published). Fewer steps do not lower the peak; an 8-bit transformer would (not written yet).
   Do not lift PyTorch's MPS memory limit (`PYTORCH_MPS_HIGH_WATERMARK_RATIO=0.0`): it can stall the whole Mac.
3. A diffusers error inside HunyuanWorld's pipeline: its pipelines are pinned to diffusers 0.34.0; if a fix needs a
   change in their code, copy the two files into `server/backdrop/` with a "changed by mux" notice (§3b) rather than
   editing the clone (the deploy refuses a changed clone).
4. If FLUX on MPS is too slow: a port of the seam blending to mflux (MLX), behind the same `make_panorama`.

## The contract (Thread is built against it)

Base: `MUX_BASE_URL` (the Railway gateway, `…/v1`) with `Authorization: Bearer $MUX_API_KEY` (tenant `thread`).

```
POST /v1/backdrops   { prompt, image_b64?, seed?, size?: "1920x960" }  → 202 { id, status: "queued", model: "backdrop" }
GET  /v1/backdrops/{id}            → { id, status: queued|running|succeeded|failed|cancelled, progress 0..1, error?: {type, message},
                                       meta?: { horizon: v (0..1, the horizon's row in the panorama), groundDepth?: m, depthScale: "relative" | "metric" } }
GET  /v1/backdrops/{id}/panorama   → image/png, equirectangular 2:1
GET  /v1/backdrops/{id}/depth      → image/png 16-bit grey, equirectangular, depth in millimetres (relative units ×1000 when not metric)
GET  /v1/backdrops/{id}/dome       → model/gltf-binary: the dome as one mesh with vertex colours (or the panorama as its texture),
                                       y up, the camera at the origin, −z is the panorama's centre column, scaled so the median
                                       horizon distance is 100 units; ground below the horizon flattened to a floor at y = −eye
                                       (eye height 1.6 units) so it meets Sets' ground
POST /v1/backdrops/{id}/cancel
503 all_models_failed when the Mac is busy (said in words). Results kept one hour.
```

What each part means, exactly:

- **Input.** `prompt`: 1–2000 characters, required (from an image too: it says what to make around it). `image_b64`:
  JPEG, PNG or WebP, base64 (a `data:` prefix is fine), 64 × 64 to 50 megapixels, read upright (EXIF); it becomes the
  panorama's centre (80° wide). Only on a Mac set up with `--image`; otherwise 400 saying text only. `seed`: a whole
  number from 0 (random when absent; the same seed and prompt should give the same panorama on the same Mac, though
  MPS does not promise bit-for-bit repeats). `size`: only
  `"1920x960"`. Other fields are ignored. Body up to 50 MB (413 above). Bad input is 400 naming the field.
- **Status.** Also carries `object: "backdrop"`, `model: "backdrop"`, `size`, `created_at`. `meta` comes with
  `succeeded`. `error.type`: `out_of_memory` (also when macOS lacks the room at load) or `server_error`, with the
  reason. A cancel stops a running job at its next step; a cancelled job gives no files.
- **`meta.horizon`:** the horizon's row v at the panorama's **centre column**, from the fitted ground plane's tilt; 0.5
  when level or when no ground was found. (A tilted panorama's horizon is a sinusoid; its centre-column row is the one
  Sets' default view looks along.)
- **`meta.groundDepth`:** the camera's height above the fitted ground, in the depth PNG's unit / 1000 — metres when
  `depthScale` is `metric`, relative units when `relative`. Absent when no ground plane fits (all sky, all water at the
  horizon, a cliff edge).
- **`meta.depthScale` and the depth PNG:** the depth is the **distance along each pixel's ray** (not a z-depth), at
  1920 × 960, aligned with the panorama. `metric`: millimetres, from MoGe-2's metric scale, used only when the 99th
  percentile of the depth fits in 65 m (a 16-bit PNG holds 65.535 m). Otherwise `relative`: units in which **the median
  horizon distance is 20**, × 1000 in the PNG (so the horizon reads 20 000; up to 3.3 × the horizon distance fits).
  0 is no depth (the sky); 65 535 is that far or farther.
- **The dome:** as described above; the panorama as its texture (`TEXCOORD_0` is the panorama's (u, v)), no vertex
  colours; `asset.extras.mux_backdrop` holds `eye`, `horizonDistance`, `skyDistance`, `horizon`, `groundTiltDeg`, `grid`.
- **Busy.** The Mac turned off or busy (presence), someone at it while the model is not loaded (polite), too little
  memory even after mux lets its idle models go, or a full queue (4 waiting or running): **503 `all_models_failed`**,
  the message saying which and why (e.g. *"no backdrop can be made now: the Mac is busy: it has 11 GB of memory free
  and a backdrop needs about 30 GB …"*). Not a failure of the model: no cooldown follows, so the next try is real.
- **Through mux:** each mux in the way (Railway, the Mac) gives its own id and keeps, per tenant, which job it stands
  for: a tenant sees only its own jobs. The create is metered (`backdrop.generate`); polls, files and cancels are not.
  Prompts and images are never logged. A job already accepted keeps running and can be polled whatever the presence.
  Results are kept one hour after the job ends, then 404.

### Contract changes I would want (not made: Thread is built against the contract as it is)

1. **Depth range.** A backdrop's depth is mostly beyond 65.5 m, so 16-bit millimetres rarely fit and the PNG is
   usually relative. A `meta.depthUnitM` (metres per PNG unit, when metric scale is known) would let the PNG stay 16-bit
   and still be metric; or a float depth (`/depth.exr` or raw float32).
2. **The dome's scale in metres.** The dome is 100 units to the horizon with the eye at 1.6 units — not metres. A
   `meta.cameraHeightM` (MoGe-2's estimate, whatever the PNG's unit) and `meta.horizonDistanceM` would let Sets place
   it at real size; today Thread can only use `groundDepth` when `depthScale` is `metric`.
3. **A quality knob** (`steps`, or `draft: true` at ~20 steps) for quick looks: a backdrop is minutes.
4. **`negative_prompt`**, as the video route has.

## Running it

On the Mac, in the mux folder:

```sh
git pull --ff-only
# once: accept the FLUX.1 [dev] Non-Commercial License on huggingface.co/black-forest-labs/FLUX.1-dev (and
# FLUX.1-Fill-dev for --image) with the owner's account; the script then asks for: ~/.mux/backdrop-venv/bin/hf auth login
./deploy/setup-backdrop.sh            # Mac + Railway + Thread's tenant, under launchd; follow ~/.mux/logs/setup-backdrop.log
# or only this Mac:
./deploy/backdrop.sh                  # venv, code and weights (pinned), launchd com.mux.backdrop on :8315, route, a test backdrop
./deploy/backdrop.sh --image          # and backdrops from an image (FLUX.1-Fill-dev, 24 GB more)
```

**Disk:** ~37 GB of weights (~61 GB with `--image`), and the script wants 60 GB left free after them (mux's floor for
downloads; `MUX_BACKDROP_DISK_FLOOR_GB` changes it): ~97 GB free (~121 GB with `--image`). On 2026-11-17 this Mac had
**23 GB free**: room must be made first.

Files: `server/backdrop/backdrop_server.py` (jobs, the models), `server/backdrop/dome.py` (the dome, the depth PNG, the
GLB), `server/backdrop/try_backdrop.py` (the deploy's test), `server/src/router/backdrop.ts`, the room-making in
`server/src/runtime/manager.ts` (`roomForService`). Logs in `~/.mux/logs/backdrop.log` (load, let-go and a failed job's
error class only); test files in `~/.mux/logs/backdrop-test-*`. Tests: `python3 server/backdrop/test_dome.py`,
`python3 server/backdrop/test_backdrop_server.py` (numpy and Pillow), `cd server && npm test`.
