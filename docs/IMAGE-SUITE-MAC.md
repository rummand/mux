# Thread image suite on the Mux Mac Studio (Apple Silicon)

This is an **on-demand local install**, not a cloud GPU service. The code is in Mux,
but GitHub pushes alone do not execute scripts on the Mac. Run the installer
**on the Mac** after the new code is on its local checkout. The existing
`server/images/image_server.py` FLUX.2 Klein worker on port 8312 and its
`image`/`image-edit` Mux routes are preserved.

## The five models

| Model in Mux | Source of quantized MLX weights | Disk approx. | Operation | Mux alias |
| --- | --- | ---: | --- | --- |
| FLUX.2 Klein 4B | existing mflux worker (`deploy/images.sh`) | 4.6–16 GB | generate + edit | `image`, `image-edit` (unchanged) |
| `z-image-turbo` | `mflux-community/z-image-turbo-mflux-q8` | 11 GB | generate | `image-fast` |
| `qwen-image-2512` | `mflux-community/qwen-image-2512-mflux-q6` | 31 GB | generate | `image-premium` |
| `qwen-image-edit-2511` | `mflux-community/qwen-image-edit-2511-mflux-q6` | 32.4 GB | edit only | `image-precision-edit` |
| `ming-image-0.1-design` | `mflux-community/ming-image-0-1-mflux-q8` | 25.2 GB | generate | `image-design` |

Image weights alone require roughly 100 GB additional disk space plus the
existing FLUX worker. Allow 110–120 GB free. **96 GB unified RAM is not
96 GB of GPU-only memory**: on-demand switching and 5-minute idle unloading
avoid loading four image pipelines simultaneously. Qwen may be substantially
slower than the fast local models. All models are Apache-2.0 except Ming
(MIT); converted checkpoints retain their originating license.

## Install on the Mac

```bash
cd ~/mux                 # or the Mac's actual clone of rummand/mux
git pull --ff-only
bash deploy/install-image-suite.sh
```

The script checks that Mux is up, ensures the original FLUX worker exists,
checks disk space, installs MFLUX 0.24.0 in the existing image venv, downloads
the four quantized checkpoints to `~/.mux/models/image-suite/`, creates a
LaunchAgent `com.mux.image-suite` on `127.0.0.1:8313`, and registers only
downloaded models in local Mux. It does not replace existing default routes.
A Mux node connected to the Railway gateway will sync the new model IDs;
Thread's **On your Mac** and **Draft on my Mac** read `/v1/models`.

Selective and repeat installs:

```bash
bash deploy/install-image-suite.sh --check
bash deploy/install-image-suite.sh --model=z-image-turbo
bash deploy/install-image-suite.sh --model=qwen-image-edit-2511
bash deploy/install-image-suite.sh --skip-download  # existing weights only
```

### Validate actual inference

`/health` checks only that the worker process is up and weights are present.
A model must **produce an image** before it is considered tested.
Each invocation can be slow on first load.

```bash
# Fast image
curl -fsS -X POST http://127.0.0.1:8313/v1/images/generations \
  -H 'Content-Type: application/json' \
  -d '{"model":"z-image-turbo","prompt":"A lighthouse at dusk","size":"512x512","n":1,"seed":42}' \
  > /tmp/mux-z-image.json
python3 -c 'import json,base64; p=json.load(open("/tmp/mux-z-image.json"));open("/tmp/mux-z-image.png","wb").write(base64.b64decode(p["data"][0]["b64_json"]))'

# Repeat for qwen-image-2512 and ming-image-0.1-design (edit is multipart).
# Editing needs a valid PNG reference (e.g., the Z-Image result above).
curl -fsS -X POST http://127.0.0.1:8313/v1/images/edits \
  -F model=qwen-image-edit-2511 \
  -F 'prompt=Make the lighthouse red while retaining the composition' \
  -F image=@/tmp/mux-z-image.png \
  > /tmp/mux-qwen-edit.json
```

Through Mux (not direct to the worker), use a tenant key and normal image endpoints:

```bash
curl -fsS "$MUX_BASE_URL/v1/models" -H "Authorization: Bearer $MUX_API_KEY"
curl -fsS "$MUX_BASE_URL/v1/images/generations" \
  -H "Authorization: Bearer $MUX_API_KEY" -H "Content-Type: application/json" \
  -d '{"model":"image-premium","prompt":"Product photography of a blue ceramic cup","size":"512x512"}'
```

The local worker deliberately has **no public network listener or credentials**
because Mux supplies authentication, tenant governance, routing, rate limits,
and metering. Do not expose port 8313 to the internet. Models use one loaded
pipeline at a time, serialized on the Mac, and report `data[].b64_json`.
A full production sign-off requires one successful call for each of the four
new models, a multipart edit test, and one gateway/Thread end-to-end test.

### Troubleshoot / rollback

```bash
tail -n 100 ~/.mux/logs/image-suite.log
bash deploy/install-image-suite.sh --check
launchctl kickstart -k "gui/$(id -u)/com.mux.image-suite"

# Disable the new worker without touching FLUX:
launchctl bootout "gui/$(id -u)/com.mux.image-suite"
```

Remove the four named Mux model entries and new capability routes using the
Mux dashboard if rolling back; do **not** remove `image` or `image-edit`.
Weights remain on disk for optional reinstallation. New routes contain one
capability-appropriate model each, so generation cannot silently fall back
to an edit-only model (or vice versa).

## Sources

- https://github.com/mflux-community/mflux
- https://huggingface.co/mflux-community/z-image-turbo-mflux-q8
- https://huggingface.co/mflux-community/qwen-image-2512-mflux-q6
- https://huggingface.co/mflux-community/qwen-image-edit-2511-mflux-q6
- https://huggingface.co/mflux-community/ming-image-0-1-mflux-q8
- https://github.com/rummand/thread/blob/main/docs/MUX-LOCAL-MODELS.md
