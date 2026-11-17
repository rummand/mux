# FLUX.2 [dev] on the Mac Studio

The owner, 2026-11-17: "We want FLUX.2-dev running", and then "We run both": FLUX.2 [dev] for the best images, FLUX.2
klein (`image`, `image-edit`) staying the fast default, FLUX 3 klein (`image-edit-hq`, Thread's try-on) untouched.

## What runs

| | |
|---|---|
| Model | Black Forest Labs FLUX.2 [dev], 32 B parameters, as `flux2-dev-q4` |
| Weights | `city96/FLUX.2-dev-gguf` `flux2-dev-Q4_K_M.gguf` (20 GB); text encoder `unsloth/Mistral-Small-3.2-24B-Instruct-2506-GGUF` Q4_K_M (14.3 GB); VAE `Comfy-Org/Flux-2-Dev` `split_files/vae/flux2-vae.safetensors` (BFL's FLUX.2 VAE, repackaged without the gate) — in `~/.mux/models/flux2-dev-sdcpp` |
| Engine | stable-diffusion.cpp `sd-server` (Metal), release `master-1106-532d2c1`, in `~/.mux/sdcpp`. mflux 0.24 has no FLUX.2 [dev] |
| Service | `server/images/sdcpp_proxy.py` on 127.0.0.1:8320 (launchd `com.mux.images-dev`): starts sd-server (:8321) with the model on the first request, only with 36 GB free (else a 503 that says why, and the route falls back to klein); one image at a time; stops it after 10 idle minutes |
| Defaults | 28 steps, Euler, CFG 1.0 (FLUX.2 [dev] is guidance-distilled) |
| Routes | `image-hq` (text to image) and `image-edit-dev` (edits): `flux2-dev-q4`, then FLUX.2 klein when the Mac has no room |
| Install | `./deploy/flux2-dev.sh` (`--railway` adds the routes on Railway mux) |

## Licences, read on 2026-11-17

**FLUX.2 [dev]: FLUX [dev] Non-Commercial License v2.0** (Black Forest Labs; `model_licenses/LICENSE-FLUX-DEV` in
black-forest-labs/flux2, and city96's GGUF repeats it).

- Non-commercial and non-production use only (§2b): "research, experiment, and testing", or "testing, evaluation, or
  non-commercial research and development in a non-production environment" (§1c). **Allowed: we are research
  (CLAUDE.md).** If a tenant starts charging money for what it makes with this model, raise it with the owner first.
- **Outputs may be used for any purpose, including commercial** (§2d): the restriction is on the model, not its images.
- **§2e — every product that shows these images must** (i) either run content filtering against unlawful or
  infringing content, **or** review Output for unlawful or infringing content before it is distributed, displayed or
  transmitted, **and** (ii) disclose that the Output was made with AI where the law requires it. mux has no image
  content filter: **the product (Thread, Bloom) carries this** — review before showing, and label AI images.
- Distributing the weights (we do not) needs the licence and this Attribution Notice: "The FLUX [dev] Model is licensed by
  Black Forest Labs Inc. under the FLUX [dev] Non-Commercial License. Copyright Black Forest Labs Inc. IN NO EVENT SHALL
  BLACK FOREST LABS INC. BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
  OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH USE OF THIS MODEL."
- No military use, no export to sanctioned parties (§4); BFL may end the licence on notice (§8).

**Mistral Small 3.2 24B Instruct (text encoder): Apache-2.0.** **stable-diffusion.cpp: MIT.**

## Measured on the Mac (2026-11-17, M3 Ultra, Q4_K_M, 1024 x 1024)

| Setup | Per step | An image (28 steps) |
|---|---|---|
| Whole model in GPU memory (needs ~35 GB free) | **~30 s** | ~14 min (+ ~10 s VAE, ~12 s load) |
| Memory-mapped, at most 16 GB held (`--mmap --offload-to-cpu --max-vram 16`) | 70–85 s | 35–40 min — unusable |

4 steps (2 min 25 s) gives the right picture with a visible grid pattern; it needs its steps. **Open:** the owner to
choose between the Turbo LoRA (8 steps, ~4–5 min at 1024², ~2–3 min at 768²) and the full 28 steps; either way the
route should become an async job (as video is), since Railway cuts a request off at 5 minutes — the first real call
(22:14, from Railway) ended `499 the caller went away` after 300 s.
