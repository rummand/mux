# FLUX 3 Image Klein on the Mux Mac Studio

This setup is for personal, non-commercial use. FLUX 3 Image Klein is open-weight
under the FLUX Kommunity License v1.0 (not Apache-2.0). Read the original
license and model card at https://huggingface.co/black-forest-labs/flux-3-image-klein
before installing. Converted checkpoints retain the original license.

## What it installs

- FLUX 3 Image Klein distilled Q8, 16 steps, generation and up to ten reference images for edits.
- Native Apple MLX / MFLUX on the user's 96 GB Mac Studio.
- Weights from https://huggingface.co/mflux-community/flux-3-image-klein-mflux-q8
  (approximately 9.9 GB on disk).
- A loopback-only image-generation and editing worker on 127.0.0.1:8314.
- A launchd agent named com.mux.flux3; generation/edit pipelines load on demand
  and are released after five minutes idle.
- Mux model flux3-image-klein-q8 and named routes image-flux3 and image-flux3-edit.
- Real generation and editing smoke tests before Mux model registration.

Existing FLUX.2 Klein on port 8312 and default image/image-edit routes are untouched.
MFLUX reports about 22.8 GB peak memory for a Q8 1024-square benchmark on an M4 Pro;
memory use on this Mac will depend on other models, resolutions and pressure.
The installer requires at least 14 GB free disk when downloading from scratch.

## Install (run ON the Mac itself)

Open Terminal and use the path of your Mux checkout:

    cd ~/mux
    git pull --ff-only
    bash deploy/flux3.sh

The local Mux server and an admin token in ~/.mux/mux.env are required.
Python 3.11 or 3.12 is needed; the script reuses the image venv, installing
MFLUX 0.24.0 if the needed FLUX 3 classes are not present.

If Hugging Face requests license acceptance, accept the model's terms on the
model page and authenticate on your Mac with:

    ~/.mux/images-venv/bin/hf auth login

Do not put authentication tokens in GitHub.

Health check and logs:

    bash deploy/flux3.sh --check
    tail -n 100 ~/.mux/logs/flux3.log

The first install performs actual text-to-image and reference-image editing
before registering the model. Generated PNGs are saved in:
  ~/.mux/logs/flux3-generate-test.png
  ~/.mux/logs/flux3-edit-test.png

The flag --skip-test skips the inference smoke tests and is not recommended
for the first installation.

## Using it through Mux / Thread

The Mac model id is flux3-image-klein-q8; the gateway should list it as
mac-studio/flux3-image-klein-q8 after node sync. The image routes
image-flux3 and image-flux3-edit are available to tenants with access.
Thread's Mux model/route setting can choose either route explicitly.

Example (your existing Mux tenant URL and key; not port 8314):

    curl -fsS "$MUX_BASE_URL/v1/images/generations" \
      -H "Authorization: Bearer $MUX_API_KEY" \
      -H "Content-Type: application/json" \
      -d '{"model":"image-flux3","prompt":"A red bicycle in soft morning light","size":"1024x1024","n":1}'

Image editing goes to /v1/images/edits with multipart image or image[] parts
and model image-flux3-edit. Bounding boxes guide layout, not hard pixel masks.

## Rollback

    launchctl bootout "gui/$(id -u)/com.mux.flux3"

Remove only the FLUX 3 model and two named FLUX 3 routes from the Mux dashboard
if rollback is desired. Leave FLUX.2 and its default routes alone. Quantized
weights remain on disk for re-installation.

Model engine docs:
https://github.com/mflux-community/mflux/blob/main/src/mflux/models/flux3/README.md

Important: committing this code does NOT execute a script on the Mac. Verify the
installer's final success message and actual generated images before reporting
the model as installed and functional.

## bf16 (full precision)

    hf auth login                     # once; accept the FLUX 3 Image Klein licence on Hugging Face first
    bash deploy/flux3.sh --bf16       # ~20 GB download, needs ~30 GB free
    bash deploy/flux3.sh --bf16 --check
    tail -n 100 ~/.mux/logs/flux3-bf16.log

This runs the original bf16 weights (black-forest-labs/flux-3-image-klein, loaded with no quantisation) as a second
worker: launchd agent com.mux.flux3-bf16 on 127.0.0.1:8315, Mux model flux3-image-klein-bf16, routes image-flux3-bf16 and
image-flux3-bf16-edit. The Q8 worker, its routes and the default image routes are unchanged. Same licence as Q8: FLUX
Kommunity License v1.0, personal and non-commercial, so it is not for Thread's paying customers.
