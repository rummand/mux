# Video on mux (2026-11-17)

The owner, 2026-11-17: *"we need everything hosted on mux"*. Thread's Sets turns a grey 3D take (a colour pass and
an exact depth video) into real footage; that runs on the Mac Studio through mux, on no cloud provider.

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

## The API (Thread is built against it)

```
POST /v1/videos/generations   {model: "video-depth" | "video", prompt, negative_prompt?, seed?, seconds (1–10),
                               fps (8–24), size ("832x480" draft | "1280x720" finish),
                               control?: {type: "depth", video_b64: base64 mp4 or zip of 16-bit PNGs,
                                          format: "mp4" | "png16-zip"},
                               image_b64? (the first frame)}
                              → 202 {id, status: "queued", model}
GET  /v1/videos/{id}          → {id, status: queued | running | succeeded | failed | cancelled, progress 0..1, model,
                                 error?: {type, message}, seconds, size}
GET  /v1/videos/{id}/content  → video/mp4 (H.264, yuv420p), kept 1 hour after it is done, then 404
POST /v1/videos/{id}/cancel   → {id, status}
```

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
