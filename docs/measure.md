# Measure on mux (2026-11-17)

The owner, 2026-11-17: *"we need everything hosted on mux"*. Thread's Reference Build (Thread's
`docs/proposals/2026-11-17-reference-build.html`, section 6 stage 2 "Measure", section 8) turns a few photos of a house
into real metres: a depth per photo, where each photo was taken from, and a metric point cloud. This runs on the Mac
Studio through mux, on no cloud provider.

## The choice

| Route | Model | Runtime |
|---|---|---|
| `depth` | **Depth Pro** (Apple). Code [`apple/ml-depth-pro`](https://github.com/apple/ml-depth-pro) at `9e65e4dbe9568d23c546fcec53302b10445e109e`; weights: Apple's 2024 checkpoint `https://ml-site.cdn-apple.com/models/depth-pro/depth_pro.pt` (1 904 446 787 bytes, SHA-256 `3eb35ca68168ad3d14cb150f8947a4edf85589941661fdb2686259c80685c0ce`, checked by `deploy/measure.sh`) | PyTorch on MPS, fp32 |
| `reconstruct` | **MapAnything, Apache build**. Code [`facebookresearch/map-anything`](https://github.com/facebookresearch/map-anything) at `3d10cf7a3016fc0f9bb13a071ee66c47b10be0d9`; weights [`facebook/map-anything-apache`](https://huggingface.co/facebook/map-anything-apache) at `00f9c245bbcb60522d1ed7f9e9d88462c6e3f38a` (4.9 GB) | PyTorch on MPS, fp32 (`MUX_MEASURE_AMP` for bf16/fp16 once tried) |
| `reconstruct`, fallback | **VGGT-1B-Commercial**. Code [`facebookresearch/vggt`](https://github.com/facebookresearch/vggt) at `a288dd0f14786c93483e45524328726ab7b1b4ce`; weights [`facebook/VGGT-1B-Commercial`](https://huggingface.co/facebook/VGGT-1B-Commercial) at `ebb29a532abe92960eeb6903a5530f16990ef4ab` (gated) | `deploy/measure.sh --vggt`; not metric: its scale comes from one measurement, else Depth Pro on photo 0 |

All three are pure PyTorch (no CUDA kernels), which is why MPS is possible at all. One server, `server/measure/measure_server.py`,
serves both routes on 127.0.0.1:8314 (launchd `com.mux.measure`): one piece of work at a time, every PyTorch call on one
device thread, each model loaded on first use and let go after 10 idle minutes, nothing about a photo logged.

## Licences, read from the files on 2026-11-17

**Depth Pro: read this one first.** There are two Depth Pro checkpoints under two different licences:

- **The GitHub repository and its checkpoint (what mux uses).** `LICENSE` in `apple/ml-depth-pro` is Apple's own
  permissive licence: Apple *"grants you a personal, non-exclusive license, under Apple's copyrights in this original
  Apple software (the "Apple Software"), to use, reproduce, modify and redistribute the Apple Software, with or without
  modifications, in source and/or binary forms"*; redistributing it unmodified and whole must keep the notice; Apple's
  name may not endorse derived products; *"no other rights or licenses, express or implied, are granted by Apple
  herein, including but not limited to any patent rights"*. The README says both *"This sample code is released under
  the LICENSE terms"* and *"The model weights are released under the LICENSE terms"*, and `get_pretrained_models.sh`
  fetches `depth_pro.pt` from Apple's CDN. Nothing in it limits the field of use, so commercial use by knitlabs is
  allowed; there is **no patent licence**, and it is provided "AS IS". mux keeps a copy of the LICENSE beside the
  weights (`~/.mux/models/depth-pro/LICENSE`).
- **Not to be used: Hugging Face `apple/DepthPro` (and `apple/DepthPro-hf`).** Tagged `apple-amlr`: the *Apple Machine
  Learning Research Model License*, *"exclusively for Research Purposes … "Research Purposes" does not include any
  commercial exploitation, product development or use in any commercial product or service."* That checkpoint is the
  2025 re-trained one. **Thread's proposal (section 8) says "commercial use allowed" for Depth Pro: that is true only
  of the GitHub/CDN checkpoint.** `deploy/measure.sh` downloads only that one, by URL and SHA-256.

**MapAnything Apache:** code Apache-2.0 (`LICENSE` in the repo); weights `facebook/map-anything-apache` tagged
`apache-2.0` (*"This is the Apache 2.0 variant of the model"*). The default `facebook/map-anything` weights are
**CC BY-NC 4.0** and are not used. Its encoder is DINOv2 ViT-g, whose code (and its torch.hub weights) are Apache-2.0;
`uniception` 0.1.7 is BSD-3-Clause. Apache-2.0 includes a patent licence.

**VGGT-1B-Commercial (fallback only):** the *VGGT License v1, 2025-07-29* (`LICENSE.txt` in the repo; the Hugging Face
copy is behind the gate and could not be read here): a *"non-exclusive, worldwide, non-transferable and royalty-free
limited license … to use, reproduce, distribute, copy, create derivative works of, and make modifications"*; anything
redistributed carries the Agreement; it incorporates an Acceptable Use Policy that excludes *"Military, warfare,
nuclear industries or applications, espionage"* and ITAR, weapons and the usual unlawful uses; for an EEA company the
licensor is Meta Platforms Ireland; Californian law and courts. The original `facebook/VGGT-1B` is non-commercial and
is not used. The weights are gated: someone must accept the licence on Hugging Face and log in on the Mac.

This is a reading of the licence texts, not legal advice.

## Does it run on Apple Silicon? What is proven and what is not

| | Status | Evidence |
|---|---|---|
| Depth Pro on MPS | **Likely, not proven here.** Pure PyTorch (timm ViT-L/16 DINOv2 backbones, conv decoder, no custom kernels). | No MPS issue in the repo's tracker; third-party write-ups run it on Apple Silicon through MPS at "several seconds per image"; Core ML conversions exist (~4.8 s a frame at 1024 on a fanless M-series, community). mux runs it in fp32 because half precision on MPS has not been tried. |
| MapAnything on MPS | **Supported upstream, not proven here.** | [PR #131 "Add MPS inference support"](https://github.com/facebookresearch/map-anything/pull/131), merged 2026-03-23: device auto-detection CUDA > MPS > CPU, device-agnostic autocast, cache clearing only where supported; the author wrote *"Confirmed working locally on Apple Silicon (MPS device)"* with no chip, timings or memory. On a non-CUDA device its memory-efficient head runs one view at a time. bf16 autocast on MPS is unproven, so mux defaults to fp32. Its first load fetches DINOv2's code through torch.hub (internet once; cached in `~/.mux/models/torch`). |
| VGGT on MPS | **Plausible, not proven here.** | Pure PyTorch; a community port ([vggt-mps](https://github.com/jmanhype/vggt-mps)) runs it on MPS. mux's VGGT path is written from the repo's README and has not run anywhere. |
| macOS itself | **A known risk.** | An Apple Developer Forums thread (2026) reports macOS 26.4 reserving ~40 GiB of MPS "other allocations" on a 48 GB M5 Pro, blocking large PyTorch tensors; fine on 26.3. If a load fails with plenty free, check the macOS version first. |

**Nothing here has run on Apple Silicon yet.** The job API, validation, the crop and camera maths, the measurement
scale and the PLY are tested with stub models (`server/measure/test_measure_server.py`); the gateway's routes, auth,
isolation, body limits, the node chain and presence in `server/test/measure.test.ts`. `deploy/measure.sh` ends with the
first real proof: it measures a rendered sample house with known sizes and prints the times and how far off it is.

If MapAnything will not run on MPS: `./deploy/measure.sh --vggt`. If neither will, `depth` still stands on its own,
and Thread falls back to what its proposal names: cameras solved later in Thread by fitting the built house to the
photos (section 11, "if both fail, the cameras are solved by fitting the built house to the photos").

### Memory and time (estimates until the Mac says otherwise)

| | Weights | Peak (estimate) | Time on the Mac Studio (estimate) |
|---|---|---|---|
| Depth Pro, fp32 | 1.9 GB | ~5–8 GB (it always runs at 1536 × 1536 inside, whatever the photo) | first load ~10–30 s; then ~1.5–5 s a photo |
| MapAnything Apache, fp32, 518-px views | 4.9 GB (~1.2 B parameters: DINOv2 ViT-g + 16 alternating-attention layers) | ~9–12 GB for 4 photos, ~12–18 GB for 12 | first load ~20–60 s; then ~10–40 s for 4 photos, ~30–120 s for 12 |
| VGGT-1B-Commercial, fp32 | ~5 GB | ~8–14 GB | similar to MapAnything |

Derived from the parameter counts, the models' published GPU timings (Depth Pro 0.3 s for 2.25 MP on a V100;
MapAnything's H100 profiles) and an Apple GPU's usual 3–10× gap to those cards in fp32. The server loads a model only
with that much free on macOS (`MUX_MEASURE_DEPTH_MIN_FREE_GB` 6, `MUX_MEASURE_RECON_MIN_FREE_GB` 14), as mux's 48 GB
budget does not count it. **`deploy/measure.sh` prints the real times: write them here.**

## The contract (Thread calls this)

Base: `MUX_BASE_URL` (the Railway gateway, `…/v1`) with `Authorization: Bearer $MUX_API_KEY` (tenant `thread`).
Photos are base64 (a `data:` prefix is fine): JPEG, PNG, WebP or HEIC, up to 50 megapixels each, read upright as the
camera held them (EXIF orientation applied); every pixel coordinate below is in that upright photo.

### Depth: one photo, one answer

```
POST /v1/depth
{ "image_b64": "<photo>", "focal_px"?: 812.5 }          // focal in pixels if Thread knows it; else EXIF, else the model's
→ 200 {
  "object": "depth", "model": "depth-pro",
  "width": 4032, "height": 3024,                       // the photo's own size; the depth map has this size
  "focal_px": 2950.4, "focal_source": "given" | "exif" | "model",
  "unit": "mm", "depth_png16_b64": "<16-bit greyscale PNG>",   // Z-depth in millimetres; 0 = no depth; 65 535 = 65.5 m or more
  "min_m": 2.31, "max_m": 41.7, "seconds": 2.4
}
```

Body up to 50 MB (413 above). It waits for the device if a reconstruction holds it, up to 5 minutes (503 `busy`).

### Reconstruct: 2–12 photos, an async job

```
POST /v1/reconstruct
{
  "images_b64": ["<photo 0>", "<photo 1>", …],          // 2 to 12
  "known"?: {
    "intrinsics"?: [[fx,0,cx],[0,fy,cy],[0,0,1]]        // one camera for every photo, in each photo's pixels,
                 | [K0 | null, K1 | null, …],           //   or one per photo (null where unknown)
    "one_measurement"?: { "photo": 1, "p1": [x, y], "p2": [x, y], "metres": 0.81 }   // e.g. the door's width
  },
  "max_points"?: 400000                                  // 1000 to 2 000 000; a seeded random sample above it
}
→ 202 { "id": "recon_…", "object": "reconstruction", "status": "queued", "model": "mapanything-apache" }

GET  /v1/reconstruct/{id}
→ 200 { "id", "object": "reconstruction", "status": "queued" | "running" | "succeeded" | "failed" | "cancelled",
        "progress": 0..1, "model", "photos": 4, "created_at",
        "error"?: { "type": "out_of_memory" | "server_error", "message" },
        "result"?: {                                     // only when succeeded
          "cameras": [ { "photo": 0, "width", "height",
                         "K": [[fx,0,cx],[0,fy,cy],[0,0,1]],   // in that photo's own pixels
                         "R": [[…],[…],[…]], "t": [x,y,z],     // world → camera: x_cam = R·X + t (OpenCV: x right, y down, z forward)
                         "position": [x,y,z] } … ],            // the camera's centre in the world
          "points": { "format": "ply", "encoding": "binary_little_endian", "count": 400000, "of": 812345,
                      "b64": "<PLY: float x,y,z; uchar red,green,blue; float confidence; uchar photo>" },
          "scale_source": "model" | "measurement" | "depth-pro" | "none",
          "scale_factor": 1.0,                            // what the model's units were multiplied by
          "measurement"?: { "photo", "metres", "model_metres", "scale_factor" },
          "confidence": { "mean", "per_photo": [ { "photo", "mean", "valid_fraction" } ], "note" },
          "frame": "photo 0's camera …",
          "warnings": [ "…" ]
        } }

POST /v1/reconstruct/{id}/cancel → { "id", "status" }
```

- **The world is photo 0's camera**: photo 0 has `R` = identity and `t` = 0; y points down, as in OpenCV. Thread turns
  it into its own up-axis.
- **Scale**: `model` = MapAnything's own metric estimate; `measurement` = the given `one_measurement` (the 3D points
  under `p1` and `p2` in that photo, interpolated, are moved to exactly `metres` apart, and everything scales with
  them); `depth-pro` = VGGT scaled by Depth Pro on photo 0; `none` = units are the model's own (said in `warnings`).
  A measurement whose points the model masked (sky, an edge) is not used, and `warnings` says so.
- The models cut every photo to one size (518 px wide for MapAnything, centred): points near a photo's edges may be
  missing, and `p1`/`p2` must fall inside the middle part. `K` is converted back to the full photo.
- `confidence` is the model's own (1 = least sure, larger = surer): compare photos with it, not models.
- Body up to 150 MB (413 above). Bad input is 400 naming the field. One job at a time on the Mac; at most 6 waiting or
  running (429 `queue_full`). A cancel stops a running job at its next stage. A finished job is kept 1 hour, then 404.
- Through mux: each mux in the way (Railway gateway, the Mac) gives its own id and keeps, per tenant, which job it
  stands for: a tenant sees only its own jobs. The create and depth calls are metered (`measure.reconstruct`,
  `measure.depth`); polls and cancels are not. Photos are never logged. A `model` in the body that is not a model or
  route of the same kind is ignored (depth always goes to `depth`, a reconstruction to `reconstruct`).
- **Presence**, as for images and video: busy or away, nothing new; polite, only a model that is already loaded (depth
  and reconstruct are judged apart). A job already accepted keeps running and can be polled whatever the presence.

## Running it

On the Mac, in the mux folder:

```sh
git pull --ff-only
./deploy/setup-measure.sh          # Mac + Railway + Thread's tenant, under launchd; follow ~/.mux/logs/setup-measure.log
# or only this Mac:
./deploy/measure.sh                # venv, weights (pinned), launchd com.mux.measure on :8314, routes, the sample house
./deploy/measure.sh --vggt         # the fallback reconstruction (accept VGGT's licence on Hugging Face and
                                   # ~/.mux/measure-venv/bin/hf auth login first)
```

Files: `server/measure/measure_server.py`, `server/src/router/measure.ts` (and `runDepth` in `router/audio.ts`), the
sample house in `server/measure/sample/` (rendered by `render_sample.py`: no photo of anyone's house, sizes known),
logs in `~/.mux/logs/measure.log` (load/let-go and a failed job's error class only), test output in
`~/.mux/logs/measure-test-depth.png` and `measure-test.ply`.
