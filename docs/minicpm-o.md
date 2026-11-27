# MiniCPM-o 4.5 on the Mac (duplex trial, `minicpm-o-4.5`)

**What:** `openbmb/MiniCPM-o-4_5`, a 9B end-to-end omni model (SigLip2, Whisper-medium, CosyVoice2, Qwen3-8B) with a
full-duplex mode: it hears and speaks at once and decides about once a second whether to speak. Speech in English
and Chinese; voice cloning from a reference clip. Assistant-tuned (unlike Haru). Tool use is not stated.

**Licences (read 2026-11-27):**
- Weights and code: **Apache-2.0** (the model card: "The MiniCPM-o/V model weights and code are open-sourced under
  the Apache-2.0 license"; front matter `license: apache-2.0`; the GGUF card the same; OpenBMB/MiniCPM-V `LICENSE` is
  Apache-2.0). The card adds a statement that OpenBMB is not liable for generated content.
- `llama.cpp-omni` (tc-mb, the C++ engine): **MIT** ("Copyright (c) 2023-2026 The ggml authors").
- The demo worker (OpenBMB/MiniCPM-o-Demo, branch `Comni`): **no licence file found** (LICENSE and LICENSE.md 404 on
  that branch and on main). Under the owner's research rule it runs here unmodified, is not redistributed, and is
  credited; if it is ever shipped or changed, ask OpenBMB for its terms first.

## On mux

- `./deploy/minicpm-o.sh`: builds llama.cpp-omni (`feat/web-demo`, Metal) in `~/.mux/minicpm-o`, downloads the GGUF
  set (LLM Q4_K_M + audio, vision, TTS, Token2Wav; ~8.3 GB), clones the Comni demo and runs its `install.sh` (a
  Python 3.10+ venv with PyTorch), writes its `config.json` for the C++ backend, and runs
  `server/realtime/minicpm_o_server.py` as `com.mux.minicpm-o` on 127.0.0.1:8322; model `minicpm-o-4.5` (kind
  `realtime`) on the route `realtime`. `--measure` then measures 5 English turns.
- The wrapper speaks mux's engine protocol on `/duplex` and drives the Comni worker's `/ws/duplex` (`prepare` →
  `prepared`; `audio_chunk` with 1 s of float32 16 kHz; `result` / `audio_only` with float32 audio back). It starts
  the worker (which spawns `llama-omni-server`) on the first session and stops it after 15 idle minutes.
- A session: `{"type":"session.start","model":"minicpm-o-4.5","instructions":"…"}`. No tools; no forced text.

## Memory and speed

- **Memory:** the CookBook gives ~8.3 GB of files and **~10 GB at runtime** (KV cache and buffers) for Q4_K_M;
  llama.cpp-omni's README gives ~8.5 GB of unified memory on Apple Silicon. mux's memory floor holds a session until
  **14 GB** are free (`--need-gb`; the wrapper's `/v1/models` says so while unloaded), unloading idle models first.
- **Speed: unproven on this Mac.** The CookBook's table: duplex minimum *M4 Pro, 36 GB*, recommended *M4 Max, 64 GB*,
  and "M1/M2/M3 chips lack the bandwidth and compute power needed for real-time duplex streaming". The Mac Studio is
  an M3 Ultra (more bandwidth than an M4 Max, older GPU cores): whether it keeps up is the first thing to measure. The
  worker logs each 1 s chunk's wall time (`SPEAK/LISTEN wall=… ms`): real time needs it under 1000 ms.
- Vendor first-audio on an M4 Max: < 650 ms (llama.cpp-omni's README).

## Unverified

- The output sample rate is taken as 24 kHz (the card's duplex example writes 24 kHz); check the first take.
- The Comni worker's `/ws/duplex` messages were read from its `worker.py` on 27 November; the branch moves.
- **Tried on the Mac, 2026-11-27: no speech came out.** First run: `deploy/minicpm-o.sh` wrote the worker's
  config with its `node -e` arguments off by one (`process.argv` has no script path under `-e`), so the worker port
  was empty and the worker crashed at start (`service.worker_base_port: Input should be a valid integer`); its
  "measurement" heard nothing and is not a result. Fixed. Second run: the worker and llama.cpp-omni start (LLM, TTS,
  Token2Wav load), but every turn timed out (5 of 5): the TTS step writes `wav_0.wav`… while the merge looks for
  `tts_output_chunk_N.wav` ("no valid WAV files to merge"), and Token2Wav runs from `./tools/omni/pyt2w/token2wav`,
  which may not be in this checkout. The branch `feat/web-demo` and the Comni worker do not fit together as installed;
  next: read llama.cpp-omni's TTS output naming at the pinned commit.
- Nothing ran before 27 November: no Metal, no worker. The wrapper compiles; its protocol is the one the Haru wrapper proved
  through mux against a fake model.
