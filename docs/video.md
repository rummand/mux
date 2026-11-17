# Video on mux (2026-11-17)

The owner, 2026-11-17: *"we need everything hosted on mux"*. Thread's Sets turns a grey 3D take (a colour pass and
an exact depth video) into real footage; that runs on the Mac Studio through mux, on no cloud provider.

Long takes along a camera path (the route `video-camera`, LingBot-World v2) are a separate server: `docs/video-camera.md`.
Both servers take one Mac-wide lock per job (`~/.mux/run/video-gpu.lock`), so only one video job runs at a time.

## The choice: Wan2.1-VACE-1.3B, diffusers on MPS

| | |
|---|---|
| Model | [`Wan-AI/Wan2.1-VACE-1.3B-diffusers`](https://huggingface.co/Wan-AI/Wan2.1-VACE-1.3B-diffusers) at revision `ec4d2cb062b548996b179d493fdd05340de702a1` |
| Licence | **Apache-2.0** (weights and code): commercial use by knitlabs, no revenue threshold, no territory excluded, outputs ours |
| What it does | VACE = "all-in-one video creation and editing": text to video, and video **from a control video** — depth among the controls it was trained on — plus a kept first frame (VACE's masks), in one model |
| Runtime | diffusers 0.42.1 `WanVACEPipeline`, PyTorch 2.14.1 on the **MPS** backend, bf16 (VAE in fp32), UniPC with Wan's flow shift (3.0 at 480p, 5.0 at 720p) |
| Disk | ~19 GB in `~/.mux/models/wan2.1-vace-1.3b-diffusers` (most of it the umT5-XXL text encoder) |
| Memory (estimate) | ~15 GB of weights in bf16 (umT5-XXL ~11 GB, the 1.3B transformer with its VACE blocks ~3 GB, the VAE); peak ~20–25 GB at 832×480, ~30 GB at 1280×720 (attention and the VAE decode). The server loads only with **24 GB free** on macOS (`MUX_VIDEO_MIN_FREE_GB`), as mux's 48 GB budget does not count it |
| Speed (estimate, unmeasured) | draft 832×480, 20 steps: about **1.5–3 minutes per second of video** at 16 fps on an M-series Ultra; finish 1280×720, 30 steps: about **8–15 minutes per second**. Derived from Wan's own figure (1.3B, 81 frames at 480p in ~4 min on an RTX 4090 at 50 steps) and an Apple GPU's usual 3–5× gap to a 4090; attention grows with the square of the frames, so 24 fps costs more than 1.5× 16 fps. `deploy/video.sh` times its first clip: write the real number here |

### Why

- **Depth control and a licence we can use.** It is the only candidate that has depth-to-video, an open licence with
  no conditions, and a size an Apple GPU can turn around in minutes.
- **No maintained MLX port does VACE or depth.** [Blaizzy/mlx-video](https://github.com/Blaizzy/mlx-video) (MIT) runs
  Wan2.1/2.2 text- and image-to-video natively in MLX but has no VACE and no control input. So it is diffusers on MPS,
  which runs the reference pipeline. If mlx-video gains VACE, moving to it is a change to `load_pipeline`/`render` in
  `server/video/video_server.py` only; the API stays.

### Runner-up: LTX-2 with Lightricks' depth IC-LoRA, in MLX

[`Lightricks/LTX-2-19b-IC-LoRA-Depth-Control`](https://huggingface.co/Lightricks/LTX-2-19b-IC-LoRA-Depth-Control)
(or the 22B LTX-2.3 `IC-LoRA-Union-Control`) through [dgrauet/ltx-2-mlx](https://github.com/dgrauet/ltx-2-mlx) (MIT code; IC-LoRA "reference video conditioning
(depth/pose/edges)" with `--video-conditioning`). Better pictures, 720p and longer clips are native to it, and it runs
in MLX (int8: 32 GB+). It lost on the licence: the **LTX-2 Community License Agreement** is not open source.
Free for an entity (with all its affiliates) under **USD 10 000 000 annual revenue**; at or above that a paid
commercial licence is required; derivatives may be distributed only under the same licence; an acceptable-use policy
binds outputs; Lightricks claims no rights in the outputs. knitlabs is likely under the threshold today, but that is a
condition we would have to watch and a licence the owner should decide on, not something to adopt quietly. If the
owner says yes, it slots in behind the same API as a second model on `video-depth`.

### Considered and not chosen

- **Wan2.2 TI2V-5B** (Apache-2.0): 720p at 24 fps from text or an image, but no depth control in the release (Wan 2.2's
  VACE is the 14B "Fun" MoE). A good later `video` (text/first-frame only) model.
- **Wan2.1-VACE-14B / Wan2.2-VACE-Fun-A14B** (Apache-2.0): same control, ~10× the compute; on MPS a clip would take
  hours.
- **LTX-Video 0.9.x depth IC-LoRA** (13B): superseded by LTX-2 under the same family of licences.
- **Hunyuan** video models: excluded; their licence does not cover the EU.

## What it can and cannot do (read before relying on it)

- **Unproven until it runs on the Mac.** Nothing here has run on Apple Silicon: the job API, validation, depth
  decoding and the mp4 writer are tested with a stub model; the model itself is not. `deploy/video.sh` ends with a
  2 s test clip, which is the first real proof.
- **720p is beyond the 1.3B's training** (Wan's note: the 1.3B is a 480p model; 720p works but is less stable). Use the
  draft size for looks and treat the finish size as best effort until seen.
- **Long clips:** Wan was trained on 81 frames (5 s at 16 fps). 10 s at 24 fps is 241 frames in one pass: it may
  drift, and it costs about 3× the attention of 81. Prefer 8–16 fps for drafts.
- **Depth convention.** VACE learned depth as depth estimators draw it: near is bright (relative inverse depth). A
  `png16-zip` is read as exact depth (larger = farther, 0 = none): it becomes disparity 1/d, stretched over the whole
  clip at once (1st–99th percentile; per frame would flicker), with 0 as far. An `mp4` is taken as already drawn that
  way and only scaled. Control frames are resampled evenly to `seconds × fps` frames and resized to `size`.
- **A first frame** (`image_b64`) is kept as frame 0 (VACE's mask: black = keep, white = make), cropped to fill.

- **The VAE's conv3d on MPS** (2026-11-17). The first label test clip (2 s, 832×480) pushed macOS ~9 GB into swap and
  ran past 343 s where the deploy's clip had taken ~185 s: the cause found in the LingBot port (`docs/video-camera.md`),
  a conv3d of the VAE's size holding MPS scratch outside PyTorch's allocator. On MPS the server now runs diffusers'
  `WanCausalConv3d` as conv2d over its time taps (`conv3d_by_frames`; equal to diffusers' forward within 10⁻⁵ for every
  shape the VAE has, and a whole tiny Wan VAE encodes and decodes the same) and empties MPS's cache after each job.
  `MUX_VIDEO_CONV3D=native` keeps diffusers' own. **Measured after the change** (2026-11-17, 2 s, 832×480, 16 fps, 20
  steps, depth control + first frame + label, a fresh server process): **322 s** with the load (load and prompt 37 s),
  **peak 31.1 GB** (the process's physical footprint, MPS buffers included), **no swap growth** (22.8 GB before and
  after). The label was seen in every extracted frame (0, 1, 2 s) and the words in the mp4's metadata.

## The API (Thread is built against it)

```
POST /v1/videos/generations   {model: "video-depth" | "video", prompt, negative_prompt?, seed?, seconds (1–10),
                               fps (8–24), size ("832x480" draft | "1280x720" finish),
                               control?: {type: "depth", video_b64: base64 mp4 or zip of 16-bit PNGs,
                                          format: "mp4" | "png16-zip"},
                               image_b64? (the first frame),
                               reference_images_b64?: [1–3 images of the subject (a person, a costume, a prop), on white],
                               label?: {text?: "AI-generated", position?: "bottom-right" | "bottom-left" | "top-right" |
                                        "top-left", every_frame?: true, metadata?: text}}
                              → 202 {id, status: "queued", model}
GET  /v1/videos/{id}          → {id, status: queued | running | succeeded | failed | cancelled, progress 0..1, model,
                                 error?: {type, message}, seconds, size,
                                 label_burned?: true once succeeded with the label in every frame (only when asked)}
GET  /v1/videos/{id}/content  → video/mp4 (H.264, yuv420p), kept 1 hour after it is done, then 404
POST /v1/videos/{id}/cancel   → {id, status}
```

- **`reference_images_b64`** (2026-11-17, Studio Cast P3): VACE's reference images, 1–3, PNG or JPEG; transparency
  becomes white and the long side is cut to 1280 px. Diffusers fits each one to the frame on a white canvas (never
  cropped), encodes it as one latent frame ahead of the clip with a zero mask (so it is context, not footage), and
  drops those frames from the output. Each costs one latent frame (four video frames' worth of attention). Works with
  or without `image_b64` and `control`. Best as VACE was trained: the subject alone on white. What they hold and what
  they cost, measured: `docs/identity.md`. More than 3, an empty list or a non-image is 400 naming the item.
- **`label`: the AI label, burned in by mux** (2026-11-17, for Thread's Studio Cast: a made-real take that shows a real
  person, with recorded consent, keeps the file only when the job says `label_burned: true`). After the frames are
  decoded and before they are encoded, mux composites Thread's own mark (`src/identity/aiLabel.ts`, `labelBox` and
  `drawLabel`: a dark rounded pill with a white rim, a yellow four-point spark and the words in white; font 3.4 % of
  the frame's short side, inset 2.5 % + 2 px, in the asked corner) into **every frame**, and writes `metadata` (or the
  words) into the mp4's `comment` and `description`. `label_burned` is in the status only when a label was asked:
  `false` until the job succeeds, then `true`, and only after the server has counted the mark into as many frames as it
  encoded. `every_frame: false`, an unknown corner, empty words (over 120 characters) or metadata over 500 characters
  are 400. Without `label`, nothing changes. A server that predates this ignores `label` and never says
  `label_burned`, so Thread refuses its file: the safe way round. The camera server (`video-camera`) does the same.
- Body limit 200 MB (413 above). Bad input is 400 naming the field. `video-depth` without `control` is 400.
- One job at a time on the Mac; at most 6 waiting or running (429 `queue_full` beyond). A cancel stops a running job
  at its next step.
- Through mux: same tenant keys, `MUX_BASE_URL` and `MUX_API_KEY`. Each mux in the way (Railway gateway, the Mac's
  mux) gives its own id and keeps, per tenant, which job it stands for: a tenant sees only its own jobs. The create is
  metered (`openai.videos.generations`); polls, content and cancel are not, so polling every few seconds costs no
  rate limit. Prompts and media are never logged.
- **Presence**, as for images: busy or away, no new job; polite, a job only while the model is loaded. A job already
  accepted keeps running and can be polled whatever the presence.
- Errors in a job: `out_of_memory` (also when macOS lacks the 24 GB at load), `server_error` with the reason.

## Running it

On the Mac, in the mux folder:

```sh
git pull --ff-only
./deploy/setup-video.sh            # Mac + Railway + Thread's tenant, under launchd; follow ~/.mux/logs/setup-video.log
# or only this Mac:
./deploy/video.sh                  # venv, weights (pinned), launchd com.mux.video on :8313, routes, a 2 s test clip
```

Files: `server/video/video_server.py`, `server/src/router/video.ts`, logs in `~/.mux/logs/video.log` (no prompts or
media, only load/let-go and a failed job's error class), test clips in `~/.mux/logs/video-test.mp4`.
