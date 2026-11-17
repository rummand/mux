#!/bin/sh
# Backdrops on this Mac, as a mux model: a 360° panorama from text (HunyuanWorld 1.0's panorama step on FLUX.1-dev),
# its depth (MoGe-2) and a dome mesh, for Thread's Sets (a world beyond the set's edge). Why, the licences, the memory
# plan and what is proven: docs/backdrop.md.
#   ./deploy/backdrop.sh            install what is missing, fetch the code and weights at pinned revisions, (re)load
#                                   the agent, register the model and the route, then make one test backdrop through
#                                   this Mac's mux (it makes room for it) and print the time and the memory it took
#   ./deploy/backdrop.sh --image    the same, and backdrops from an image too: FLUX.1-Fill-dev (24 GB more on disk)
#                                   and HunyuanWorld's PanoDiT-Image LoRA; the test then makes a second one from a photo
#   ./deploy/backdrop.sh --no-test  without the test backdrop
# Before the first run, once: FLUX.1-dev (and, for --image, FLUX.1-Fill-dev) are gated on Hugging Face. Accept the
# FLUX.1 [dev] Non-Commercial License on huggingface.co/black-forest-labs/FLUX.1-dev (and .../FLUX.1-Fill-dev) with the
# owner's account, then: ~/.mux/backdrop-venv/bin/hf auth login (the script creates the venv and stops to say so).
# server/backdrop/backdrop_server.py runs on 127.0.0.1:8316 (com.mux.backdrop) and answers /v1/backdrops (async jobs).
# It becomes the model `hunyuanworld-pano-moge2` on the route `backdrop`; a gateway that has this Mac as a node gets it
# as mac-studio/hunyuanworld-pano-moge2. Nothing loaded is unloaded by this script: mux lets idle models go when a
# backdrop needs the room. Keys and tokens are never printed. Downloads: ~37 GB (text) or ~61 GB (with --image).
set -eu
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
MUX_HOME="$HOME/.mux"
AGENTS="$HOME/Library/LaunchAgents"
VENV="$MUX_HOME/backdrop-venv"
PORT=8316
MODEL_ID=hunyuanworld-pano-moge2
MODELS="$MUX_HOME/models"
CODE="$MUX_HOME/backdrop"
# Pinned: what this was written against (docs/backdrop.md). Change them together, and run the test after.
HW_COMMIT=57fa9f3a79eae1079c279968cdb9d82c75fa7c86          # github.com/Tencent-Hunyuan/HunyuanWorld-1.0
HW_REPO=tencent/HunyuanWorld-1                              # the PanoDiT LoRAs
HW_REV=43c47e7c5d7e5c6ac0f8410cb1df31a4af815d88
HW_TEXT_SHA256=704431edbf336f161810f51252f9916e374dc00190c00d34a6a0b6a80c76511d   # HunyuanWorld-PanoDiT-Text/lora.safetensors
HW_IMAGE_SHA256=3e5aad27a015e238f28bfc50aceb959d34c85c380f516cc9d1f46c910e4b2e9d  # HunyuanWorld-PanoDiT-Image/lora.safetensors
FLUX_REPO=black-forest-labs/FLUX.1-dev
FLUX_REV=3de623fc3c33e44ffbe2bad470d0f45bccf2eb21
FILL_REPO=black-forest-labs/FLUX.1-Fill-dev
FILL_REV=358293da0354175698b67ec8299acf928313a78a
MOGE_COMMIT=07444410f1e33f402353b99d6ccd26bd31e469e8        # github.com/microsoft/MoGe: the last MoGe-2 release (2.0.0) before MoGe-3
MOGE_REPO=Ruicheng/moge-2-vitl-normal
MOGE_REV=cb0e8bbd6b1e243589717c78e750b1ba4c093acf
MOGE_SHA256=280741fd09bc3f403ccff9967784c2a391b52d2c0742ae3efdb21d9f90cc1a01      # model.pt
UTILS3D_COMMIT=3fab839f0be9931dac7c8488eb0e1600c236e183     # github.com/EasternJournalist/utils3d, as MoGe 2.0.0 pins it
# HunyuanWorld 1.0 was tested on diffusers 0.34.0, transformers 4.51.0, peft 0.15.0, accelerate 1.6.0 (its
# docker/HunyuanWorld.yaml); its pipelines subclass diffusers' Flux internals, so those stay as it had them. PyTorch is
# mux's (2.14.1, MPS). MoGe installs without its declared dependencies (gradio, a GUI opencv): its real ones are here.
PIP_PINS="torch==2.14.1
torchvision
diffusers==0.34.0
transformers==4.51.0
accelerate==1.6.0
peft==0.15.0
sentencepiece==0.2.0
protobuf==5.29.3
safetensors==0.5.3
huggingface_hub[cli]==0.35.0
opencv-python-headless==4.11.0.86
numpy
scipy
pillow
tqdm
click
utils3d @ git+https://github.com/EasternJournalist/utils3d.git@$UTILS3D_COMMIT"
MOGE_PIN="moge @ git+https://github.com/microsoft/MoGe.git@$MOGE_COMMIT"
TEST=1 IMAGE=
for a in "$@"; do case "$a" in --no-test) TEST= ;; --image) IMAGE=1 ;; *) echo "unknown flag $a"; exit 2 ;; esac; done
[ "$(uname -s)" = Darwin ] || { echo "Run this on the Mac."; exit 2; }
[ "$(uname -m)" = arm64 ] || { echo "Apple Silicon is needed (MPS)."; exit 2; }
. "$MUX_HOME/mux.env"
MUX="http://127.0.0.1:${MUX_PORT:-7070}"
mkdir -p "$MUX_HOME/logs" "$MODELS" "$AGENTS" "$CODE"
api() { curl -sf -X "$1" -H "Authorization: Bearer $MUX_ADMIN_TOKEN" -H "content-type: application/json" ${3:+-d "$3"} "$MUX/api/admin$2"; }
sha() { shasum -a 256 "$1" | cut -d' ' -f1; }

# Disk: what is still to come, and 60 GB left after it (mux's own floor for downloads; MUX_BACKDROP_DISK_FLOOR_GB)
need_gb() { # dir, GB it takes when complete
  [ -f "$1/.mux-complete" ] && echo 0 || echo "$2"
}
WANT=$(( $(need_gb "$MODELS/flux.1-dev" 34) + $(need_gb "$MODELS/hunyuanworld-1" 1) + $(need_gb "$MODELS/moge-2-vitl-normal" 2) + 3 ))
[ -z "$IMAGE" ] || WANT=$(( WANT + $(need_gb "$MODELS/flux.1-fill-dev" 25) ))
FLOOR=${MUX_BACKDROP_DISK_FLOOR_GB:-60}
FREE_GB=$(df -g "$MODELS" | awk 'NR == 2 { print $4 }')
[ "$FREE_GB" -ge $(( WANT + FLOOR )) ] || { echo "only $FREE_GB GB free in $MODELS; this needs ~$WANT GB and leaves $FLOOR GB free after: free $(( WANT + FLOOR - FREE_GB )) GB first (or MUX_BACKDROP_DISK_FLOOR_GB=…)"; exit 1; }

echo "→ Python packages in $VENV (PyTorch with MPS, diffusers 0.34 for HunyuanWorld's pipelines, MoGe-2)"
PY="$(command -v python3.12 || command -v python3.11 || true)"
[ -n "$PY" ] || { echo "python 3.11 or 3.12 is needed (brew install python@3.12)"; exit 1; }
[ -x "$VENV/bin/python" ] || "$PY" -m venv "$VENV"
PINS_NOW="$PIP_PINS $MOGE_PIN"
if [ "$(cat "$VENV/.mux-pins" 2>/dev/null || true)" != "$PINS_NOW" ]; then
  "$VENV/bin/pip" install -q --upgrade pip
  printf '%s\n' "$PIP_PINS" > "$VENV/requirements.txt"
  "$VENV/bin/pip" install -q -r "$VENV/requirements.txt"
  "$VENV/bin/pip" install -q --no-deps "$MOGE_PIN"
  printf '%s' "$PINS_NOW" > "$VENV/.mux-pins"
fi

echo "→ HunyuanWorld 1.0's code at ${HW_COMMIT%"${HW_COMMIT#???????}"} into $CODE/HunyuanWorld-1.0 (only its panorama step is used)"
HW="$CODE/HunyuanWorld-1.0"
[ -d "$HW/.git" ] || git clone -q https://github.com/Tencent-Hunyuan/HunyuanWorld-1.0 "$HW"
[ "$(git -C "$HW" rev-parse HEAD)" = "$HW_COMMIT" ] || { git -C "$HW" fetch -q origin && git -C "$HW" checkout -q --detach "$HW_COMMIT"; }
[ -z "$(git -C "$HW" status --porcelain)" ] || { echo "✗ $HW has local changes: not used (git -C $HW status)"; exit 1; }
"$VENV/bin/python" - "$HW" <<'PY'
import importlib, sys, types, os
hw = sys.argv[1]
import torch
assert torch.backends.mps.is_available(), "PyTorch has no MPS device here"
pkg = types.ModuleType("hwpano"); pkg.__path__ = [os.path.join(hw, "hy3dworld", "models")]; sys.modules["hwpano"] = pkg
gen = importlib.import_module("hwpano.pano_generator")
assert gen.Text2PanoramaPipelines and gen.Image2PanoramaPipelines
from moge.model.v2 import MoGeModel  # noqa: F401
from moge.utils.panorama import merge_panorama_depth  # noqa: F401
import diffusers, transformers
print(f"  torch {torch.__version__} (MPS ok), diffusers {diffusers.__version__}, transformers {transformers.__version__}; HunyuanWorld's panorama pipelines and MoGe-2 import")
PY

echo "→ weights (pinned revisions; FLUX.1-dev is gated: the owner's Hugging Face login)"
"$VENV/bin/hf" auth whoami >/dev/null 2>&1 || {
  echo "✗ not logged in to Hugging Face. Accept the FLUX.1 [dev] Non-Commercial License on huggingface.co/$FLUX_REPO"
  [ -z "$IMAGE" ] || echo "  and on huggingface.co/$FILL_REPO"
  echo "  with the owner's account, then run: $VENV/bin/hf auth login   — and this script again"; exit 1; }
get() { # repo, revision, dir, what, patterns…
  repo=$1 rev=$2 dir=$3 what=$4; shift 4
  [ -f "$dir/.mux-complete" ] && [ "$(cat "$dir/.mux-complete")" = "$rev" ] && return 0
  echo "  $what ($repo @ ${rev%"${rev#???????}"})"
  "$VENV/bin/hf" download "$repo" --revision "$rev" --local-dir "$dir" --include "$@" >/dev/null \
    || { echo "✗ $repo could not be downloaded: if it is gated, accept its licence on huggingface.co/$repo with the logged-in account"; exit 1; }
  printf '%s' "$rev" > "$dir/.mux-complete"
}
# FLUX.1-dev in diffusers' layout only (not its single-file flux1-dev.safetensors and ae.safetensors: 24 GB more)
get "$FLUX_REPO" "$FLUX_REV" "$MODELS/flux.1-dev" "FLUX.1-dev, diffusers layout, ~34 GB once" \
  model_index.json "scheduler/*" "text_encoder/*" "text_encoder_2/*" "tokenizer/*" "tokenizer_2/*" "transformer/*" "vae/*" LICENSE.md README.md
LORAS="HunyuanWorld-PanoDiT-Text/*"
[ -z "$IMAGE" ] || LORAS="$LORAS HunyuanWorld-PanoDiT-Image/*"
# shellcheck disable=SC2086
get "$HW_REPO" "$HW_REV" "$MODELS/hunyuanworld-1" "HunyuanWorld 1.0's PanoDiT LoRAs, 0.5 GB each" $LORAS LICENSE README.md
[ "$(sha "$MODELS/hunyuanworld-1/HunyuanWorld-PanoDiT-Text/lora.safetensors")" = "$HW_TEXT_SHA256" ] || { rm -f "$MODELS/hunyuanworld-1/.mux-complete"; echo "✗ PanoDiT-Text's SHA-256 does not match: not used"; exit 1; }
if [ -n "$IMAGE" ]; then
  [ -f "$MODELS/hunyuanworld-1/HunyuanWorld-PanoDiT-Image/lora.safetensors" ] || { rm -f "$MODELS/hunyuanworld-1/.mux-complete"; get "$HW_REPO" "$HW_REV" "$MODELS/hunyuanworld-1" "PanoDiT-Image" $LORAS LICENSE README.md; }
  [ "$(sha "$MODELS/hunyuanworld-1/HunyuanWorld-PanoDiT-Image/lora.safetensors")" = "$HW_IMAGE_SHA256" ] || { rm -f "$MODELS/hunyuanworld-1/.mux-complete"; echo "✗ PanoDiT-Image's SHA-256 does not match: not used"; exit 1; }
  # Fill-dev's own transformer, VAE and scheduler; its text encoders are FLUX.1-dev's (the same T5-XXL and CLIP-L)
  get "$FILL_REPO" "$FILL_REV" "$MODELS/flux.1-fill-dev" "FLUX.1-Fill-dev, transformer and VAE, ~24 GB once" \
    model_index.json "scheduler/*" "transformer/*" "vae/*" LICENSE.md README.md
fi
get "$MOGE_REPO" "$MOGE_REV" "$MODELS/moge-2-vitl-normal" "MoGe-2 ViT-L (normal), 1.3 GB once" model.pt README.md
[ "$(sha "$MODELS/moge-2-vitl-normal/model.pt")" = "$MOGE_SHA256" ] || { rm -f "$MODELS/moge-2-vitl-normal/.mux-complete"; echo "✗ MoGe-2's SHA-256 does not match: not used"; exit 1; }
# FLUX's own SHA-256s are behind Hugging Face's gate (the API does not show them without a login): hf checks each file
# against its revision as it downloads; here they are written down once and checked on every later run.
for d in "$MODELS/flux.1-dev" ${IMAGE:+"$MODELS/flux.1-fill-dev"}; do
  if [ -f "$d/SHA256SUMS" ]; then
    (cd "$d" && shasum -a 256 -c --quiet SHA256SUMS) || { echo "✗ $d does not match its SHA256SUMS (from its first download): not used"; exit 1; }
  else
    echo "  SHA-256 of $(basename "$d") (once, a minute or two): $d/SHA256SUMS — put them in docs/backdrop.md"
    (cd "$d" && find . -name '*.safetensors' | sort | xargs shasum -a 256 > SHA256SUMS)
  fi
done
# The licences beside the weights, and the notice HunyuanWorld's licence asks for
cp "$HW/LICENSE" "$MODELS/hunyuanworld-1/LICENSE-code"
cp "$HW/NOTICE" "$MODELS/hunyuanworld-1/NOTICE"
curl -fsSL -o "$MODELS/moge-2-vitl-normal/LICENSE" "https://raw.githubusercontent.com/microsoft/MoGe/$MOGE_COMMIT/LICENSE"

echo "→ launchd agent com.mux.backdrop on :$PORT"
cat > "$AGENTS/com.mux.backdrop.plist" <<PL
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.mux.backdrop</string>
  <key>ProgramArguments</key><array><string>$VENV/bin/python</string><string>$ROOT/server/backdrop/backdrop_server.py</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>ProcessType</key><string>Interactive</string>
  <key>StandardOutPath</key><string>$MUX_HOME/logs/backdrop.log</string>
  <key>StandardErrorPath</key><string>$MUX_HOME/logs/backdrop.log</string>
  <key>EnvironmentVariables</key><dict>
    <key>PATH</key><string>/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
    <key>HF_HUB_OFFLINE</key><string>1</string>
    <key>PYTORCH_ENABLE_MPS_FALLBACK</key><string>1</string>
    <key>MUX_BACKDROP_PORT</key><string>$PORT</string>
    <key>MUX_BACKDROP_MODEL</key><string>$MODEL_ID</string>
    <key>MUX_BACKDROP_HW_CODE</key><string>$HW</string>
    <key>MUX_BACKDROP_FLUX</key><string>$MODELS/flux.1-dev</string>
    <key>MUX_BACKDROP_FLUX_FILL</key><string>$MODELS/flux.1-fill-dev</string>
    <key>MUX_BACKDROP_LORA</key><string>$MODELS/hunyuanworld-1</string>
    <key>MUX_BACKDROP_MOGE</key><string>$MODELS/moge-2-vitl-normal/model.pt</string>
  </dict>
</dict></plist>
PL
launchctl bootout "gui/$(id -u)/com.mux.backdrop" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$AGENTS/com.mux.backdrop.plist"
for i in $(seq 1 30); do curl -sf -o /dev/null "http://127.0.0.1:$PORT/health" && break; sleep 1; done
curl -sf -o /dev/null "http://127.0.0.1:$PORT/health" || { echo "✗ the backdrop server is not up: see $MUX_HOME/logs/backdrop.log"; exit 1; }

echo "→ model $MODEL_ID and route backdrop in mux"
# size_bytes is what it needs free in memory when it loads (FLUX's transformer and the work): mux lets idle models go
# for it, and refuses a backdrop in words when even that is not enough (runtime/manager.ts roomForService).
NOTES="HunyuanWorld 1.0 panorama step (code ${HW_COMMIT%"${HW_COMMIT#???????}"}, PanoDiT LoRAs $HW_REPO @ ${HW_REV%"${HW_REV#???????}"}; Tencent HunyuanWorld-1.0 Community Licence: territory excludes the EU/UK/KR, outputs not to train other models, >1M MAU needs a licence) on FLUX.1-dev$( [ -n "$IMAGE" ] && echo " and FLUX.1-Fill-dev" ) (FLUX.1 [dev] Non-Commercial Licence), bf16 on MPS, 1920x960; depth MoGe-2 ViT-L (MIT); dome by server/backdrop/dome.py. Async jobs, server/backdrop/backdrop_server.py, com.mux.backdrop. Needs ~30 GB free to load (mux makes room); lets go after 10 idle minutes; presence applies. Research use (docs/backdrop.md)."
MODEL=$(node -e 'console.log(JSON.stringify({id:process.argv[1],display_name:"HunyuanWorld panorama + MoGe-2 (backdrop)",kind:"backdrop",backend:"external",base_url:"http://127.0.0.1:"+process.argv[2]+"/v1",upstream_model:process.argv[1],size_bytes:30*1024**3,caps:{quality:6,speed:2},notes:process.argv[3]}))' "$MODEL_ID" "$PORT" "$NOTES")
api POST /models "$MODEL" >/dev/null 2>&1 || api PATCH "/models/$MODEL_ID" "$MODEL" >/dev/null
api PUT /routes/backdrop '{"kind":"backdrop","strategy":"priority","candidates":["'$MODEL_ID'"]}' >/dev/null

[ -n "$TEST" ] || { echo "✓ backdrop: $MODEL_ID on :$PORT (no test)"; exit 0; }
echo "→ a test backdrop through this Mac's mux (the first loads FLUX: minutes; 50 steps at 1920 × 960 on MPS: unmeasured)"
api PUT /tenants/backdrop-check '{"name":"backdrop check (deploy/backdrop.sh)","status":"active","default_route":"auto"}' >/dev/null
KEYJSON=$(api POST /tenants/backdrop-check/keys '{"name":"backdrop.sh","expiresInDays":1}')
KEY_ID=$(printf %s "$KEYJSON" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).record.id))')
KEYFILE=$(mktemp "$MUX_HOME/.backdrop-key.XXXXXX")
chmod 600 "$KEYFILE"
printf %s "$KEYJSON" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(JSON.parse(s).key))' > "$KEYFILE"
OK=1
"$VENV/bin/python" "$ROOT/server/backdrop/try_backdrop.py" --base "$MUX/v1" --key-file "$KEYFILE" --out "$MUX_HOME/logs" ${IMAGE:+--image} || OK=
rm -f "$KEYFILE"
api DELETE "/keys/$KEY_ID" >/dev/null || true
[ -n "$OK" ] || { echo "✗ the test backdrop did not pass: see above and $MUX_HOME/logs/backdrop.log (what to try: docs/backdrop.md)"; exit 1; }
echo "  files in $MUX_HOME/logs/backdrop-test-*; load and step times in $MUX_HOME/logs/backdrop.log — put the times and memory in docs/backdrop.md"
echo "✓ backdrop: $MODEL_ID on :$PORT — POST /v1/backdrops on mux (route backdrop)"
