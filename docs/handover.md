# Handover — 2026-11-17

What mux is now, how it runs, what was built in the last stretch (2026-11-02 → 11-04), and what is waiting.
Read with `README.md` (how mux works) and `docs/decisions.md` (why it is built this way).

**Rule (set by the owner on 2026-11-17):** every commit writes to this file. Add one line at the top of the Log below,
newest first (date · commit · what changed · what the owner must run or decide), and update *Waiting on the owner* when
it changes. Merge commits skip it. `tools/githooks/pre-commit` enforces it (`git config core.hooksPath tools/githooks`);
the file merges with git's `union` driver (`.gitattributes`), so keep each Log entry on one line.

## Log

- 2026-11-17 · (this commit) · FLUX 3's free-memory floor is 18 GB (`MUX_IMAGE_HQ_MIN_FREE_GB`, passed by `deploy/images.sh`): its measured peak is 15.3 GB, and the old 24 refused the deploy's test edit with 23 GB free while the chat model was resident. Mac: `./deploy/image-edit-hq.sh && ./deploy/image-edit-hq.sh --no-test --railway`.
- 2026-11-17 · (this commit) · `deploy/image-edit-hq.sh`: its `js` helper now passes file paths through (`node -e … -- args`); the test edit stopped there with "path … Received undefined" after the route was registered. Mac: `./deploy/image-edit-hq.sh && ./deploy/image-edit-hq.sh --no-test --railway`.
- 2026-11-17 · (this commit) · `deploy/images.sh` waits for the old `com.mux.images` to be gone before bootstrapping it again (the first `image-edit-hq.sh` run failed there with "Bootstrap failed: 5" and left the image server down until it was bootstrapped by hand). Mac: `./deploy/image-edit-hq.sh && ./deploy/image-edit-hq.sh --no-test --railway`.
- 2026-11-17 · (this commit) · **Identity edits for Thread's try-on: `image-edit-hq`** (`docs/image-edit.md`). Surveyed FLUX 3 Image Klein, FLUX.2 klein 9B / [dev], Qwen-Image-Edit-2509/2511, Qwen-Image-2.1 (licences read and written; Qwen-Image-2.1 needs ≥ 48 GB free disk to try). Picked **FLUX 3 Image Klein** (BFL, FLUX Kommunity License v1.0, mflux-community Q8 9.9 GB pinned `7e46237d`, SHA-256 checked) as a second model of `server/images/image_server.py` (one model in memory at a time; `model` = `image-edit-hq`/`flux3-image-klein-q8` picks it; garments shrunk to 0.26 MP, 4× faster with the same look; mflux's prompt cache now dropped after every request, klein too). Measured on the Mac with two synthetic people (try-on: person + 3 garments, 832×1248): FLUX 3 16 steps **148–169 s, peak 14 GB** (klein 4B Q4 4 steps 73–99 s, 10.5 GB); on a casual three-quarter photo klein loses the person and FLUX 3 keeps face, scar, glasses, build and skin; on a front studio photo both hold, FLUX 3 more natural. Images in `docs/identity/tryon-*.jpg`. Tests without weights pass; the gateway needed no change. `com.mux.images` was not restarted. Mac, once merged: `git pull --ff-only && ./deploy/image-edit-hq.sh` (weights already in `~/.mux/models/flux-3-image-klein-mflux-q8`), then `./deploy/image-edit-hq.sh --no-test --railway`; Thread then sends `model=image-edit-hq` from Fashion try-on.
- 2026-11-17 · (this commit) · **Studio Cast P3: likeness on mux, measured with a synthetic mannequin** (`docs/identity.md`). VACE reference images (2 s, 832×480, same depth and seed): first frame 315 s / 31.1 GB; first frame + 3 refs 463 s / 30.5 GB, best colour match at 1–2 s (histogram 0.60 vs 0.53) and a steadier background; refs alone 464 s, the whole costume rebuilt in an invented set. **Phantom-Wan 1.3B ported** as route/kind `video-subject` (`server/video/subject_server.py`, :8317, `deploy/video-subject.sh`): its DiT is stock Wan2.1-1.3B, so diffusers' converter loads it (825/825 tensors) and upstream's sampler is rewritten on diffusers' parts with upstream's own scheduler; Apache-2.0 code and weights (pinned, SHA-256). On MPS: 2 s in 653 s (30 steps), peak 29.9 GB, swap flat; keeps the costume, but no layout control. Licences of Stand-In, Wan2.2-Animate, PuLID-FLUX, HunyuanCustom read and written. Not tested: a face (next, with a synthetic face). Mac, once merged: `git pull --ff-only && npm run build && launchctl kickstart -k gui/$(id -u)/com.mux.server && launchctl kickstart -k gui/$(id -u)/com.mux.video && ./deploy/video-subject.sh`.
- 2026-11-17 · (this commit) · **The AI label and the conv3d fix, run on the Mac** (this branch's `video_server.py` on spare port :8323, mux's :8313 untouched): a 2 s video-depth draft (832×480, 16 fps, synthetic mannequin, depth + first frame + `label`) **succeeded with `label_burned: true`** in 322 s, peak 31.1 GB, swap flat (22.8 GB); frames at 0, 1, 2 s show the pill bottom-right, crisp after H.264, and the mp4's comment/description carry the metadata. Before the conv3d fix the same clip swapped 9 GB and was stopped at 343 s. Mac, once merged: `launchctl kickstart -k gui/$(id -u)/com.mux.video && launchctl kickstart -k gui/$(id -u)/com.mux.video-camera`.
- 2026-11-17 · (this commit) · **VACE reference images on `video`/`video-depth`** (Thread's Studio Cast P3): optional `reference_images_b64` (1–3 pictures of the subject on white) passed to diffusers' `WanVACEPipeline(reference_images=…)`; backward compatible, 400 names a bad item; contract in `docs/video.md`. Tests without weights pass. What they do to a subject's look is measured in `docs/identity.md` (next commits). Mac, once merged: `launchctl kickstart -k gui/$(id -u)/com.mux.video`.
- 2026-11-17 · (this commit) · **Wan2.1-VACE's VAE on MPS, the same fix as video-camera's:** the label test clip (2 s, 832×480, on a spare port from this branch) pushed macOS from 22 to 31.7 GB of swap and was still running at 343 s (the deploy's clip: ~185 s), so my swap guard stopped it. Diffusers' `WanCausalConv3d` is the conv3d that held 69 GB of MPS scratch in the LingBot port; `video_server.py` now runs it as conv2d over its time taps on MPS (`conv3d_by_frames`, written fresh for this Apache-2.0 file; equal to diffusers' within 10⁻⁵ per shape and through a whole tiny Wan VAE) and empties MPS's cache after each job (`MUX_VIDEO_CONV3D=native` for the old way). Not yet measured on the real weights: swap is over the 25 GB gate. Mac, once merged: `launchctl kickstart -k gui/$(id -u)/com.mux.video`.
- 2026-11-17 · (this commit) · **Why `com.mux.images` grew to 67–71 GB, fixed:** MLX keeps every freed GPU buffer in its cache, uncapped up to its memory limit (~78 GB here); mflux's buffers differ by size, number of input images and edit vs text-to-image, so they were rarely reused and the cache only grew (and switching pipelines left the old one's weights in it). It pushed macOS to 44.8 GB of swap and 13 GB free disk again 52 min after this morning's restart. `server/images/image_server.py` now caps the cache (`MUX_IMAGES_CACHE_GB`, 2), empties it after every request (also a failed one) and on a pipeline switch, and logs active/cache/peak GB per request. Measured on a spare port, five varied requests (txt2img 512², 768×512, 1024²; edits with 1 and 2 images): **before 9.5 → 12.4 → 21.8 → 37.1 → 41.8 GB; after 2.3, 2.1, 2.5, 2.3, 2.6 GB**, same times (4.3–17.4 s). Test in `server/images/test_mlx_thread.py`. I restarted `com.mux.images` (old code) to free the Mac. `flux3_server.py` (not running) clears its cache only on let-go: same risk if it is ever served. Mac, once merged: `git pull --ff-only && launchctl kickstart -k gui/$(id -u)/com.mux.images`.
- 2026-11-17 · (this commit) · **The AI label, burned in by mux** for Thread's Studio Cast (Thread dcdedd8 sends `label: {text, position, every_frame, metadata}` on a made-real take with a real person and keeps the file only if the status says `label_burned: true`): `video_server.py` (`video`, `video-depth`) and `camera_server.py` (`video-camera`) composite Thread's mark (aiLabel.ts's pill, spark and words, same geometry) into every frame after decoding, write the words into the mp4's comment/description, and say `label_burned: true` once done (only when asked; a server without this never says it, so Thread refuses: safe). Tests without weights pass (every frame marked once, also at 24 fps and the held last frame; nothing else touched; bad label 400). Contract in `docs/video.md`, `docs/video-camera.md`. **Not yet run on the Mac:** the GPU check was blocked (13 GB disk free, 44.8 GB swap: `com.mux.images` at 67 GB again, the next commit). Mac, once merged: `git pull --ff-only && launchctl kickstart -k gui/$(id -u)/com.mux.video && launchctl kickstart -k gui/$(id -u)/com.mux.video-camera`.
- 2026-11-17 · (this commit) · `video-camera` is live: installed on the Mac (launchd `com.mux.video-camera` :8315), Railway mux deployed at e32e4d1 and `video-camera` allowed for the `thread` tenant. The 30 s measure: 857 s (28.6 s per video second), peak 27.4 GB, no swap growth; the scene holds, what leaves the frame is re-imagined, sharpness falls after ~10 s (in `docs/video-camera.md`). Nothing to run on the Mac.
- 2026-11-17 · (this commit) · **video-camera memory: 73 GB → 28.2 GB peak, 95.5 → 33.8 s per video second** (2 s test take, 832×480, same picture: PSNR 41.6 dB to the old clip). The excess was the Wan VAE's `CausalConv3d` on MPS (scratch outside PyTorch's allocator: the driver held 69 GB with 21 GB in use); it now runs as conv2d over its time taps (`lingbot_mps.causal_conv3d_taps`, tested equal to upstream's for every shape), MPS's cache is emptied per chunk and per decoded frame, and the encoder's cache goes once steady. `camera_server.py` refuses a take with 503 `memory_busy` ("the Mac is short of memory") when free memory + what it holds is under the peak (`MUX_CAMERA_PEAK_GB` 28) and fails a queued one that no longer fits; its `/v1/models` says `need_gb`, which mux's `roomForService` now honours (also with the model loaded) to unload idle models first; `deploy/video-camera.sh` registers `size_bytes` 28 GB and its stats line no longer throws (`const s` shadowed the `js` helper's `s`); memory refusals put no model in cooldown. Numbers in `docs/video-camera.md` (*Measured on the Mac*). Mac, once merged: `git pull --ff-only && npm run build && launchctl kickstart -k gui/$(id -u)/com.mux.server && MUX_VIDEO_CAMERA_SPARE_GB=12 ./deploy/video-camera.sh` (2 s clip; then `--measure 30` when the owner says go, `--railway` after).
- 2026-11-17 · (this commit) · `deploy/video-camera.sh` downloads LingBot's six shards by name: `hf download --include a b c` read b and c as file names, so only the index and README came down and the SHA-256 check stopped. Mac: rerun `MUX_VIDEO_CAMERA_SPARE_GB=12 ./deploy/video-camera.sh --measure 30 --railway`.
- 2026-11-17 · (this commit) · `deploy/video-camera.sh`: `MUX_VIDEO_CAMERA_SPARE_GB` (default 20) sets what must stay free after the weights; the owner chose 12 for the first run, with 24 GB free on the Mac. Mac: `MUX_VIDEO_CAMERA_SPARE_GB=12 ./deploy/video-camera.sh --measure 30 --railway`.
- 2026-11-17 · (this commit) · **Camera video (`video-camera`) for Thread's long takes:** LingBot-World v2 1.3B causal-fast (Robbyant, CC BY-NC-SA 4.0 — allowed, we are research; credit and share-alike kept) ported to PyTorch MPS (`server/video/lingbot_mps.py`, itself CC BY-NC-SA: flash-attn → SDPA, no float64, no CUDA imports, float32 DiT with bf16 attention, the causal loop as a stream with the VAE chunk by chunk) behind the video job API in its own server `server/video/camera_server.py` (:8315, launchd `com.mux.video-camera`); Sets' poses → OpenCV framewise poses in `camera_poses.py`; new kind and route `video-camera` (`server/src/router/video.ts`), so Wan and the camera model never stand in for each other; both video servers share `~/.mux/run/video-gpu.lock` (one job on the GPU at a time). Proven on this Mac with tiny weights: every MPS replacement equals upstream's code, the DiT's KV-cache loop on MPS matches the CPU (7e-5), the whole take loop runs; found and fixed an MPS bug (`.to("cpu", float64)` of an int64 tensor gives zeros). Not proven: the real 1.3B's pictures, speed (estimate 20–30 s per second of video at 832x480), memory (~20 GB peak), drift. Fallback Matrix-Game 3.0 pinned, not ported. Contract, mapping, licences, proven/not proven: `docs/video-camera.md`. Owner must: merge to main, rebuild and restart mux, then `./deploy/video-camera.sh --measure 30 --railway` (7.3 GB of weights) and write the numbers into `docs/video-camera.md`.
- 2026-11-17 · (this commit) · Backdrop server moved from :8315 to **:8316** (8315 is `com.mux.video-camera`'s on the video-camera branch, 38dc7fa): server default, launchd plist and model URL in `deploy/backdrop.sh`, `setup-backdrop.sh`, router comment, `docs/backdrop.md`, README; a test checks the default. Nothing in main or video-camera uses 8316. Nothing to run on the Mac (not deployed yet).
- 2026-11-17 · handover: the backdrop entry names its commit. Nothing to run on the Mac.
- 2026-11-17 · 0b40a3f · **Backdrops for Thread's Sets** (World Models proposal §08, steps 1–2): route and kind `backdrop`, `server/backdrop/backdrop_server.py` on :8315 (launchd `com.mux.backdrop`, MPS bf16, one job at a time, one device thread, nothing of a prompt logged): `POST /v1/backdrops {prompt, image_b64?, seed?, size?}` → 202; `GET /v1/backdrops/{id}` (meta horizon, groundDepth, depthScale), `/panorama`, `/depth`, `/dome`, `/cancel`; kept 1 h. Panorama: HunyuanWorld 1.0's panorama step (code 57fa9f3, PanoDiT LoRAs, SHA-256 pinned) on FLUX.1-dev (3de623f; `--image` adds FLUX.1-Fill-dev); depth: MoGe-2 (MIT, 0744441 + weights cb0e8bb); dome: `server/backdrop/dome.py` (numpy, hand-written GLB: closed, inward, horizon at 100, floor at −1.6; Khronos validator clean). Memory: text encoders and transformer never held together (peak ~27–30 GB), and mux lets idle models go for it (`roomForService` in runtime/manager.ts, from the model's `size_bytes`) or answers 503 `all_models_failed` in words. Licences in `docs/backdrop.md`: Tencent's (EU excluded: accepted risk; no training on outputs; >1M MAU; Thread must say Tencent is not affiliated) and FLUX.1 [dev] NC (Thread's prompt checks and AI label must stay). Stub-model, dome and gateway tests pass; **nothing has run on Apple Silicon**. Owner must: free disk (23 GB free; ~97 GB wanted), accept FLUX.1-dev's licence on Hugging Face, then `./deploy/setup-backdrop.sh` (it asks for `hf auth login` once) and put the printed times and memory in `docs/backdrop.md`.
- 2026-11-17 · (this commit) · Images failed for Thread (`/v1/images/edits` 503, "fetch failed"): with the video and measure models loading beside the chat models this morning, an edit ran at 32 s a step (normally 3) and the next request had `com.mux.images` killed by macOS (signal 9); launchd brought it back. The image server now checks free memory before each request (`MUX_IMAGES_MIN_FREE_GB`, 6) and answers a 503 that says why instead of being killed. Verified: generations 6–9 s and edits ~20 s through Railway with Thread's key; the refusal tested on a spare port. The service was restarted with this code; nothing to run on the Mac.
- 2026-11-17 · (this commit) · The two `computer` tests failed on the Mac Studio because Peekaboo **is** installed there: they assumed Linux, so `computer_look` really looked and `startTask` could start a real Peekaboo agent run ("Open Notes and write a line"). New `MUX_NO_COMPUTER` (set in `test/setup.ts`, like `MUX_NO_DOWNLOADS`): tests act as if Peekaboo were not there and never touch the real screen. 111 tests pass. **Ask mux with Peekaboo verified through `/api/admin/assistant`:** `computer_list` (Orca, Finder, Safari, Terminal) and `computer_look` (frontmost window + screenshot) ran at once; `computer_act` (open a URL) stopped as pending, waiting for the owner. Orca (Electron) shows little in the accessibility tree; native apps show more. Nothing to run on the Mac.
- 2026-11-17 · (this commit) · Ran `./deploy/setup-measure.sh` (after the two pip fixes above): **measure works on the Mac and through Railway** — `depth-pro` and `mapanything-apache` on :8314 (`com.mux.measure`), routes `depth`/`reconstruct`, Thread allowed. Depth Pro 2.7 s warm, MapAnything 6.6 s warm (3 views); both loaded in 49 s. On the rendered sample house: depth 35 % off with the model's own focal guess, **~8 % off with the true `focal_px`**; reconstruct 17 % off scaled by the door. Results in `docs/measure.md` ("Measured on the Mac"). Thread should send photos with EXIF or a focal length. Nothing to run on the Mac.
- 2026-11-17 · (this commit) · `deploy/measure.sh`: Depth Pro declares `numpy<2`, MapAnything (via rerun-sdk) needs `numpy>=2` — pip could not install both. Now everything installs with numpy 2 and Depth Pro alone with `--no-deps` (its real dependencies timm, matplotlib, pillow-heif listed; its pin predates numpy 2). Rerun: `./deploy/setup-measure.sh`.
- 2026-11-17 · (this commit) · `deploy/measure.sh`: one requirement per line (pip refused `torch==2.14.1 torchvision pillow-heif numpy<2` on one line, so the first `./deploy/setup-measure.sh` stopped before installing anything). Rerun: `./deploy/setup-measure.sh`.
- 2026-11-17 · (this commit) · Ran `./deploy/thread-ready.sh` (it ran setup-video.sh): **every capability Thread uses works with its key through Railway** — chat, vision, messages, search, image, edit, inpaint, speak, transcribe, transcribe-da; video on the Mac (2 s clip 185 s with load) and through Railway (1 s draft 136 s). Thread's key saved to `~/.mux/keys/thread.key` (the one made on 11-15; Thread already used it). Fixed: Piper had **no launchd agent** (`com.mux.tts` never installed), so speak fell to Kokoro (English); created it — Danish speak now answers from `mac-studio/piper-da`; the script now installs it via `audio.sh` when missing. Its video check sent no size (the server takes 832x480 or 1280x720): now 832x480. Disk: swap had reached 47 GB (50 GB of swapfiles), and came back on its own; 40 GB free after the video weights (~19 GB). Still open: Railway's `fast` lists `ovh/gpt-oss-20b` (free tier) first in practice; Whisper's own agent (`com.mux.whisper`, :8310) is not installed either — transcription runs on the speech service (whisper-turbo, Røst). Nothing to run on the Mac.
- 2026-11-17 · (this commit) · Autopilot fixed: (1) the memory check counts pinned models (Qwen3-Omni, 21 GB, "fitted" beside the 1 GB `fast` champion while ~41 GB of pinned models filled the 48 GB budget, and failed every first try); (2) a challenger the experiment put on a route comes off it unless promoted (`experiments.challenger_added`); (3) no download that would leave under 60 GB free (or the disk reserve, if higher). Done on the Mac by hand today: LFM2.5-24B deleted (14 GB; no product used it; its experiment had expired with 0 requests), `fast` back to qwen3.5-0.8b → qwen3.6 → gpt-oss-20b. **Both Omni models stay**: Blip's `blip-meaning` asks for them by name every night (~200–350 requests). Known: the two `computer` tests (`test/computer*.test.ts`) fail on main before this change too. Nothing else to run on the Mac (it is restarted with this commit).
- 2026-11-17 · da1c326 · Long jobs on the Mac: Ask mux's `computer_task` hands one approved instruction to Peekaboo's own agent (`peekaboo agent --model mux/agent`, ≤ 60 turns, ≤ 30 min, one at a time; `computer_task_status`, `computer_task_stop`). Its model is this mux through Peekaboo's custom provider `mux` and a local tenant `computer` with `data_border: own`, so screen contents never reach a cloud API. Cua was the plan, but its agent (`cua-agent`) is deprecated upstream. `deploy/computer.sh` step 4 sets it up. Owner must run: `./deploy/computer.sh` (again, if it ran before).
- 2026-11-17 · CLAUDE.md: "we are also research and our location is the world": territory-limited licences (Hunyuan's) no longer rule a model out. Nothing to run on the Mac.
- 2026-11-17 · CLAUDE.md added with the owner's standing rules, first: "we are not commercial", so non-commercial models may be served (territorial exclusions such as Hunyuan's still bind). Nothing to run on the Mac.
- 2026-11-17 · (this commit) · Ask mux can see and use the Mac: Peekaboo (openclaw/Peekaboo, MIT) behind three tools in `server/src/computer.ts` — `computer_look` (UI map of an app, window or the screen; runs at once), `computer_list` (apps, windows), `computer_act` (click, type, keys, scroll, menu, launch/focus/quit, open a link; waits for approval). Only the owner's Ask mux on a Mac with Peekaboo gets them; the doctor and brain keeper are refused; never a tenant key. `GET /api/admin/computer`, `/computer/screens/:name` (screenshots kept an hour). Owner must run: `./deploy/computer.sh` and, at the Mac, switch on Peekaboo under Screen Recording and Accessibility.
- 2026-11-17 · e9b15c9 · Ask mux can see and use the Mac: Peekaboo (openclaw/Peekaboo, MIT) behind three tools in `server/src/computer.ts` — `computer_look` (UI map of an app, window or the screen; runs at once), `computer_list` (apps, windows), `computer_act` (click, type, keys, scroll, menu, launch/focus/quit, open a link; waits for approval). Only the owner's Ask mux on a Mac with Peekaboo gets them; the doctor and brain keeper are refused; never a tenant key. `GET /api/admin/computer`, `/computer/screens/:name` (screenshots kept an hour). Owner must run: `./deploy/computer.sh` and, at the Mac, switch on Peekaboo under Screen Recording and Accessibility.
- 2026-11-17 · handover: the measure entry names its commit.
- 2026-11-17 · c88ce1d · Measure for Thread's Reference Build: `server/measure/measure_server.py` (:8314, launchd `com.mux.measure`, PyTorch MPS fp32, one at a time, one device thread) with Depth Pro (Apple's CDN checkpoint under the repo's permissive LICENSE; the Hugging Face `apple/DepthPro` is research-only and is not used) on route `depth` (`POST /v1/depth`) and MapAnything Apache (Apache-2.0, MPS upstream since PR #131) on route `reconstruct` (async: `POST /v1/reconstruct`, `GET /v1/reconstruct/{id}`, `/cancel`), new kinds `depth` and `reconstruct`; VGGT-1B-Commercial as `--vggt` fallback; `deploy/thread-ready.sh` allows both routes. Stub-model and gateway tests pass; nothing has run on Apple Silicon yet: `./deploy/setup-measure.sh`. Contract and licences in `docs/measure.md`.
- 2026-11-17 · dd4da30 · Thread on mux, all of it: tested with Thread's key, `speak` failed (Piper on the Mac down), `transcribe`/`transcribe-da` failed (routed to `hviske-v5`, gone from the speech service), video not on the gateway. `deploy/thread-ready.sh` restarts Piper, disables hviske-v5, sets speak (Piper → Kokoro) and transcribe (Whisper turbo → Røst; Danish Røst first) on the Mac and the gateway, runs setup-video.sh, points Thread's Railway variables at the thread tenant's key and prints a table of every capability. Audio and images now fall through on a 404 (a model gone where it was registered) instead of failing. Owner must run: `git pull --ff-only origin main && ./deploy/thread-ready.sh`.
- 2026-11-17 · handover rule: every commit writes here; pre-commit hook and union merge added.
- 2026-11-17 · 1ce0567 · Video on the Mac: Wan2.1-VACE-1.3B (Apache-2.0) on PyTorch MPS behind async jobs (`server/video/video_server.py`, :8313, launchd `com.mux.video`), routes `video` and `video-depth`; per-tenant job ids; refused audio/image/video bodies no longer kept in the request log. Not yet run on the Mac: `./deploy/setup-video.sh`. Notes in `docs/video.md`.
- 2026-11-17 · be05e6d · FLUX 3 bf16 option removed (revert of 804c061); the Q8 worker is unchanged.
- 2026-11-17 · 51a1526 · `deploy/fix-images.sh`: pull, restart the image workers, test two generations in a row (the MLX one-thread fix, 289802a).

## Where mux runs

| | Mac Studio (`mac-studio`) | Railway gateway |
|---|---|---|
| Role | `MUX_ROLE=all`: gateway + the models | `MUX_ROLE=gateway`: routes SaaS traffic, runs no models |
| Address | `localhost:7070`; tailnet / Funnel `https://lv426.tail134047.ts.net/mux` | https://mux-production-0b55.up.railway.app (shown as "Railway mux") |
| Admin token | `MUX_ADMIN_TOKEN` in `~/.mux/mux.env` | `MUX_GATEWAY_ADMIN_TOKEN` in `~/.mux/railway.env` |
| Runs from | launchd `com.mux.server` → `deploy/run.sh` from this working tree | `railway up` (it does **not** deploy from GitHub) |
| Models loaded | qwen3.6-35b-a3b, bge-m3, arch-router (pinned) | reaches them as `mac-studio/…` |

Never put a token in the repo: it is public. Secrets live in `~/.mux/*.env`, `~/.gbrain/mux.env`, and the dashboard.

## How to ship a change

1. Branch, commit, push the branch; `git merge --ff-only` into `main`; push `main` (secret scan the diff first).
2. **The Mac:** `npm run build`, then `launchctl kickstart -k gui/$(id -u)/com.mux.server` (~30 s; Railway and the
   Nexus ports come back on their own).
3. **Railway — from a clean checkout of `main`, not the working tree.** Other sessions often have uncommitted work
   here, and `railway up` uploads whatever is on disk:
   ```sh
   git worktree add --detach /tmp/mux-deploy main && cd /tmp/mux-deploy
   railway up --detach -p a5bf89be-0ec9-4d3d-afcc-40226c2a86f4 -e production -s mux
   cd - && git worktree remove --force /tmp/mux-deploy
   railway deployment list -s mux   # wait for SUCCESS
   ```
4. When another session's files are dirty: stage only your own (`git apply --cached` for a shared file's hunks),
   check the commit builds and tests on its own in a worktree, and move `main` with `git fetch . <branch>:main` if
   `git checkout main` refuses.

Tests: `cd server && npm test` (74 pass). They never touch `~/.mux/mux.db` (`test/setup.ts`).

## Built 2026-11-02 → 11-04

| Commit | What |
|---|---|
| `4c6f288` `b4d3525` `fa49613` `449ad8a` | **System page, live:** every core every 2 s (P/E clusters, heatmap), GPU %, memory as macOS splits it, network, disk, processes with model servers named; Linux readings from /proc and the container's cgroup on Railway; the Machine bar's first button is this mux's name ("Railway mux"). `runtime/live.ts`, `components/SystemLive.tsx` |
| `73ce67d` | **Services page:** web search (SearXNG beside Railway) and the page reader — health every minute, engines and their errors, calls, latency, tenants, per-engine answers and failure reasons, try-it box. Query words are never stored. `services.ts` |
| `e5fc9c7` | **"Ask mux"** instead of "Assistant" everywhere visible; the chat speaks as mux. Internal names (`/assistant`, the Assistant tenant) unchanged |
| `0ccf39d` | **Lens checks its model's claims** (`lens-checks.ts`): a false claim rejects the finding ("Thrown away", with why); nothing checkable = "guess", low at most; high needs claims that hold, ≥ 3 requests and a claim pinned to the error/tool/finish/border |
| `e96987f` | **Agents page:** healer & doctor, experiments autopilot, Lens watches, brain keeper — state, schedule, last run, what each changed, Run now. Autopilot runs now persist (`autopilot_runs`). `agents.ts` |
| `bda780f` | **Affinity:** one agent run stays on one model (`router/affinity.ts`). Key: `x-mux-affinity`, else `x-mux-trace-id`, else the conversation's opening. Experiment arms are fixed per run; the route's first choice is kept 30 min unless the model is unfit or has a queue ≥ 2 |
| `6850b54` | **Arch-Router** (Katanemo 1.5B, Q6_K, pinned on the Mac) picks the route for requests on `auto` routes, once per user turn (`router/intent.ts`). Routes have an `intent` field (defaults built in for agent/code/fast/multilingual/smart: 10/12 right in a sample, against 4/7 with the plain descriptions). Falls back to the old scoring on "other", unknown route or > 2 s. Never answers a chat itself. Setting `intentRouterModel`: `arch-router` (Mac), `mac-studio/arch-router` (Railway). Card on the Routes page |

Outside the repo: LongCat-Video staged in `~/.mux/longcat` (see below).

## 2026-11-12: the page reader reads whole sites (reader v2)

`/v1/read` moved to `server/src/router/reader.ts` and grew, backward compatible, for bloom for business (the owner:
"it can return files to bloom for business so it can use them for provenance"): `links: true` (every link, absolute),
`files: true` (a document's exact bytes, base64, with their SHA-256; 413 above `max_bytes`, 25 MB default, 50 MB cap),
at most 5 redirects each re-checked (loop and cap are clear errors), status, content type, redirects, meta robots and
X-Robots-Tag, canonical, lang, ETag, Last-Modified, and `robots_txt: true` (raw; mux does not decide on robots.txt).
The user agent carries `x-mux-agent`. `service_calls` gained `bytes` and `mime`; the Services page shows bytes read and
what was read. Setting `readerParallel` (8): reads in flight per tenant. Contract in `README.md`; tests in
`server/test/reader.test.ts` (a fixture server on loopback).

Later the same day (bloom for business's design system reads a company's look from its own stylesheets; the owner
approved the reader returning links and files): `links: true` also returns `<link rel=stylesheet>` hrefs with
`rel: "stylesheet"`, and `files: true` returns a stylesheet as a file (`text/css`, exact bytes, SHA-256, its words as
`text`). Without `files: true` a stylesheet is still refused (415), as before. Tests in `server/test/reader.test.ts`.

Then (bloom for business ranks a company's colours by the elements its start page shows): `html: true` returns a web
page's markup as it came, capped at `max_html_chars` (200 000 default, 2 000 000 at most) with `html_truncated`;
metered with the text. `links` and `file` unchanged. Contract in `README.md`; test in `server/test/reader.test.ts`.

## 2026-11-14: the page reader renders pages that build themselves in the browser (`render: true`)

bloom for business read energinet.dk (a Vue site) through Railway's reader and got titles and no words from every page;
its sitemap (8,308 addresses) was refused with 415. The owner approved extending the reader again. Branch
`reader-render`.

- **`render: true`** on `/v1/read` (route `web.render`, model `renderer`, `server/src/router/render.ts`): a headless
  Chromium through `playwright-core` 1.56.1 (an optional dependency; the Chromium in `~/Library/Caches/ms-playwright`,
  or `MUX_CHROMIUM_PATH`). The browser resolves no name (`--host-resolver-rules=MAP * ~NOTFOUND`) and its proxy is a
  closed port: every request the page makes is intercepted, checked for a public address (each redirect hop too, at
  most 5) and fetched by mux; frames, pictures, media, fonts, WebSockets, beacons and non-GET are refused; a fresh
  context per page, Set-Cookie dropped, no Cookie or Authorization sent; no downloads, pop-ups, dialogs or service
  workers; 25 s, 15 MB, 150 requests; the reader's user agent. Words settle when the page's text has not changed for
  1.2 s (at most 10 s after load). A tenant with an `allowed` list must name `web.render`. `renderParallel` (2) per
  tenant and per machine. energinet.dk: plain read 0 words, rendered 348 words and 84 links in 3.5 s.
- **On a gateway** (Railway) the render is sent to the first online `mux` provider (the Mac Studio, over its
  Funnel/tailnet address, with the gateway's own tenant key there) and metered on both sides; no node is 503
  `render_unavailable`, and so is a node that answers without `rendered: true`.
- **`files: true` returns XML and gzip** (a sitemap, `sitemap.xml.gz`), the XML's words as `text`.
- **Services page**: a "Page renderer" row (`web.render`), with its try-it box.
- Tests: `server/test/render.test.ts` (a script shell rendered; a private fetch from the page refused; no POST,
  pictures or cookies; redirects; download refused; byte and time caps; the route permission; a gateway without a
  node; XML and gzip files).
- Later the same day: every answer carries `x-ratelimit-limit-requests` and `x-ratelimit-remaining-requests` (`0861286`,
  bloom paces its agents to them); the user agent is `mux-reader/2.1 (+https://github.com/rummand/mux; <agent>)`
  without `Mozilla/5.0` (`f54eaa6`, nemlig.com still rendered 749 words); `images: true` lists a page's `<img>`; a
  site's public scripts and stylesheets are cached 10 minutes for renders, 64 MB at most (`21426ea`: energinet.dk
  3.7 MB a page down to 0.1 MB).
- Commits on main: `2de1d79`, `65bbf00`, `0861286`, `f54eaa6`, `21426ea`. Each built and kickstarted on the Mac
  Studio and deployed to Railway with `railway up` from a clean worktree of main (SUCCESS). Verified through Railway
  with a one-day key for `bloom-for-business` (revoked, 200, then 401): energinet.dk rendered 347 words and 84 links in
  4.3 s, `render.node: "Mac Studio"`, the sitemap as a `text/xml` file. No tenant was changed: `gateway-railway` on
  the Mac and `bloom-for-business` on Railway list no `allowed` routes, so `web.render` is allowed.

## 2026-11-12: images on the Mac Studio (FLUX.2 klein 4B Q4)

The owner (bloom for business, testing Composer's images with a real model): "Local image model: install an open image
model on the Mac Studio's Mux. Free and local." `dc5aefc`.

- **Model:** `mflux-community/flux2-klein-4b-mflux-q4` @ `794cd159` — FLUX.2 [klein] 4B pre-quantised to 4 bits,
  **Apache-2.0** (the files' card; inherits `black-forest-labs/FLUX.2-klein-4B`, Apache-2.0). 4.3 GiB in
  `~/.mux/models/flux2-klein-4b-mflux-q4`; mflux 0.24.0 in `~/.mux/images-venv` (1.4 GiB). Candidates and licences:
  `docs/research-local-llm.md` (SDXL-Turbo and klein 9B are non-commercial; the 16 GB bf16 default did not fit).
- **Service:** launchd `com.mux.images`, `server/images/image_server.py` on **127.0.0.1:8312** only, installed with
  `./deploy/images.sh --q4 --keep` (no chat model unloaded). Model `flux2-klein-4b-q4` on routes `image` and
  `image-edit`. Loads on the first request (~1 s, ~5 GB), lets go after 10 idle minutes.
- **Fixed on the way:** mflux 0.24's `Flux2KleinEdit` fails without an input image, so text to image now runs
  `Flux2Klein`; edits keep `Flux2KleinEdit`; one in memory at a time.
- **Presence:** `acquire` skipped presence for every `external` model. A local image service (external, kind image,
  loopback) is now admitted like the models mux runs (`isLocalService`, `runtime/manager.ts`): busy/away nothing,
  polite only when its model is loaded and one at a time; a resting refusal counts no cooldown.
  `server/test/images-presence.test.ts`. Whisper, Piper and other loopback audio services are unchanged.
- **Tenant:** `bloom-design-composer-test` `allowed` += `image`, `flux2-klein-4b-q4` (nothing else changed; read back).
- **Verified through mux** (one-day key, revoked): `POST /v1/images/generations {model: "image", size: "768x768",
  seed: 1234, response_format: "b64_json"}` → 200 in 5.9 s and 5.8 s (warm), `x-mux-model: flux2-klein-4b-q4`,
  `model` in the JSON, PNG 768×768 decodes; **the same seed gives a byte-identical PNG**. 512×512: ~4 s warm, ~7 s
  cold. Requests page: tenant and `x-mux-agent` recorded; prompts and images are never logged.
- **Railway** runs no image model; it reaches this one as `mac-studio/flux2-klein-4b-q4` on its next sync if a route
  there names it (none does).
- **Disk:** 25 GB free before, 18 GB right after the download; 13 GB at the end of the session as other projects built
  (mux's share is the 5.7 GiB above). Watch it.

## 2026-11-12: `vision` on the Mac Studio is the local qwen3.6

The owner (bloom for business, whose Library reads pictures and scanned pages through route `vision`): "Yes, use the
local qwen". A route setting, not code: `PUT /api/admin/routes/vision {candidates: ["qwen3.6-35b-a3b"]}` on the Mac
Studio (was `[]`, which took every chat model in list order); journaled as a route change. Presence rules unchanged.

- **Tenants:** no `bloom-for-business` tenant exists on the Mac Studio. Bloom tests here as
  `bloom-design-composer-test` (`allowed`: `qwen3.6-35b-a3b`, `image`, `flux2-klein-4b-q4`), which **may not name
  route `vision`** (403 `permission_denied`) but may name `qwen3.6-35b-a3b`. No tenant was changed; adding `vision`
  there waits for the owner.
- **Thinking:** qwen3.6 runs here with `--reasoning off`; no `reasoning_content` came back, and 800 tokens were plenty.
  Per request, `chat_template_kwargs: {enable_thinking: false}` passes through to llama-server (README, *Pictures*).
- **Verified** with one-day keys, each revoked (200), then 401, files deleted. A synthetic 900×360 PNG with four
  lines of text, `max_tokens` 800: tenant `lan`, `model: "vision"` → 200 in 1.4 s, `x-mux-route: vision`,
  `x-mux-model: qwen3.6-35b-a3b`, 342 prompt + 90 completion tokens, all four lines exact plus a one-sentence
  description. With `enable_thinking: false`: 0.9 s, 61 completion tokens, the same text. Tenant
  `bloom-design-composer-test`: `vision` → 403; `qwen3.6-35b-a3b` by name → 200 in 7.8 s (cold prompt cache), the
  same text, 90 completion tokens.
- **Railway** (read only, nothing changed): `vision` = `mac-studio/qwen3.6-35b-a3b`, `mac-studio/qwen3.5-0.8b`, then
  OVH. Tenant `bloom-for-business` (allowed all, border `own`): `/routes/explain` with a picture gives only
  `mac-studio/qwen3.6-35b-a3b` (0.8b has no vision, OVH is outside the border). Production bloom's `MUX_URL` is this
  Railway gateway. That path was not tried with a real call.

## Live state (2026-11-06)

- Railway intent router: 19 decisions, 17 routed, 2 "other", 0 failed; **p50 436 ms, p95 1.8 s** — the p95 is close
  to the 2 s budget because each decision goes Railway → Mac → Railway. Watch `/routes/intent`; if failures appear,
  raise `BUDGET_MS` in `router/intent.ts` or run the router nearer the gateway.
- Memory budget 48 GB; autoExperiments, freeRescue, selfHeal on.
- Mac disk: 107 GB free (was 2.8 GB on 11-04 — Epic Games deleted, 60 GB). The big users are `~/.record/corpus`
  (261 GB of Danish speech data), `~/.nexus` (108 GB, incl. qwen3.6's weights — keep `~/.nexus/models`),
  `~/.mux/longcat` (79 GB).
- Docker (Colima, 2 GB RAM VM) runs the other projects' databases; `nexus-laya-laya-1`, its image and volume were
  deleted on the owner's word (it was dying of out-of-memory).

## Waiting on the owner

- **Identity edits for Thread (2026-11-17, branch `image-edit-real`):** merge it, then on the Mac `git pull --ff-only &&
  ./deploy/image-edit-hq.sh && ./deploy/image-edit-hq.sh --no-test --railway` (route `image-edit-hq`, FLUX 3 Image Klein Q8,
  FLUX Kommunity License). Then Thread's Fashion try-on sends `model=image-edit-hq` with a full-caption prompt (`docs/image-edit.md` §3).
- **Camera video for Thread (2026-11-17, branch `video-camera`):** merge it to `main`, then on the Mac `git pull --ff-only
  && npm run build && launchctl kickstart -k gui/$(id -u)/com.mux.server`, then `./deploy/video-camera.sh --measure 30
  --railway` (LingBot-World v2 1.3B, 7.3 GB, CC BY-NC-SA 4.0); put its numbers in `docs/video-camera.md` ("Measured on
  the Mac"). If its takes do not hold the camera or the set: Matrix-Game 3.0 is the pinned fallback (not ported).
- **Backdrops for Thread (2026-11-17):** make room on the Mac's disk (23 GB free; the deploy wants ~97 GB free, ~121 GB with
  `--image`), accept the FLUX.1 [dev] Non-Commercial License on huggingface.co/black-forest-labs/FLUX.1-dev with your
  account, then `git pull --ff-only && ./deploy/setup-backdrop.sh` (it stops once for `~/.mux/backdrop-venv/bin/hf auth
  login`; follow `~/.mux/logs/setup-backdrop.log`). It ends with a test backdrop and prints its time and the lowest free
  memory: put them in `docs/backdrop.md`. Decide whether Thread shows "Tencent is not affiliated" where backdrops appear
  (Tencent's licence §3e asks for it when offered to others).

- **The Mac for Ask mux:** `git pull --ff-only origin main && ./deploy/computer.sh`, then at the Mac switch on Peekaboo in System Settings → Privacy & Security → Screen & System Audio Recording and Accessibility (it waits 15 min for that), and Launch at Login in Peekaboo's Settings.

- **Thread on mux:** `./deploy/thread-ready.sh` on the Mac (includes setup-video.sh). Until then Thread's speech, transcription and video fail.

- **Run on the Mac (2026-11-17):** `git pull --ff-only && ./deploy/fix-images.sh` (FLUX answers more than once again),
  then `./deploy/setup-video.sh` (video for Thread's Make it real; follow `~/.mux/logs/setup-video.log`, and put the
  2 s test clip's time into `docs/video.md`).
- **Run on the Mac (2026-11-17, measure for Thread):** `git pull --ff-only && ./deploy/setup-measure.sh` (Depth Pro and
  MapAnything on :8314, Railway, Thread's tenant; follow `~/.mux/logs/setup-measure.log`, ~9 GB of weights). It ends
  by measuring the rendered sample house and prints the times and how far off: put them in `docs/measure.md`. If
  MapAnything fails on MPS: accept VGGT-1B-Commercial's licence on Hugging Face, `~/.mux/measure-venv/bin/hf auth
  login`, then `./deploy/setup-measure.sh --vggt`. Decide: Thread's proposal calls Depth Pro "commercial use allowed";
  that holds only for Apple's GitHub/CDN checkpoint (no patent grant), which is the one mux uses.
- **LTX-2 as a second video model:** better pictures, but its licence needs a paid licence above USD 10M revenue.

- **Memory budget 48 → ~58–60 GB.** The autopilot is blocked from trying Gemma 4 26B on the multilingual route
  (advisor 8.8 vs qwen3.6's 7.5; the two need ~58 GB together).
- **Free tier as a regular candidate on Railway:** `ovh/gpt-oss-20b` is listed on the `fast` and `agent` routes, so
  those prompts can go to OVH's free tier, though free tiers are meant as rescue only. Offered to take it out.
- **LongCat-Video test:** weights (78 GB), venv and Mac patches in `~/.mux/longcat` (`README.md` there); smoke test
  passes. Run with `~/.mux/longcat/schedule.sh HH:MM` (or `run-test.sh` now) — it takes the chat models offline up
  to ~100 min, then restores them. If usable: a video kind with a background job API. If not: delete the weights.
- **Kimi K3:** does not fit the Mac (≥ 594 GB). Through the cloud needs a Moonshot or OpenRouter key in the dashboard.
- **Smaller:** `@fastify/static` advisories (upgrade on its own branch); Funnel `/mux` dashboard asset paths; Windows
  installer untested on a real PC; SearXNG engines DuckDuckGo (CAPTCHA) and Brave (rate-limited) failing — switch them
  off once the Services page has a few days of data; qwen3.6 context overflows (8 in a day) — a longer-context fallback
  would catch them; the Routes page's "Explain a decision" shows the scoring, not Arch-Router's choice.

## Gotchas learned

- `lsof -ti tcp:PORT` also matches clients — use `-sTCP:LISTEN` before killing anything.
- GBrain: never configure its `openai` provider with a mux key (it ignores the base URL and sends the key to OpenAI).
- MPS (Apple GPU) asserts on mixed-dtype matmuls instead of raising; CUDA-autocast code paths need explicit casts.
- Arch-Router's GGUF answers with single quotes (`{'route': 'code'}`).
- The owner's rules: every change mux makes to itself is journaled and shown ("What mux changed"); Ask mux's changes
  wait for approval; the owner's brain pages are never rewritten; restarting mux or the Mac is allowed for healing.
