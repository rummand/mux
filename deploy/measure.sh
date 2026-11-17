#!/bin/sh
# Measure on this Mac, as two mux models: Depth Pro (metric depth from one photo) and MapAnything's Apache build
# (cameras and a metric point cloud from 2–12 photos), on PyTorch's MPS backend, for Thread's Reference Build.
# Why these models, their licences and what is proven on Apple Silicon: docs/measure.md.
#   ./deploy/measure.sh            install what is missing, fetch the weights, (re)load the agent, register models and
#                                  routes, then measure the sample house (server/measure/sample) and print the times
#   ./deploy/measure.sh --no-test  the same without the test
#   ./deploy/measure.sh --vggt     reconstruct with VGGT-1B-Commercial instead of MapAnything (the fallback if
#                                  MapAnything fails on MPS). Its weights are gated: accept Meta's licence on
#                                  huggingface.co/facebook/VGGT-1B-Commercial and `hf auth login` in this venv first.
# server/measure/measure_server.py runs on 127.0.0.1:8314 (com.mux.measure) and answers /v1/depth and /v1/reconstruct
# (async jobs). It becomes `depth-pro` on the route `depth` and `mapanything-apache` (or `vggt-1b-commercial`) on the
# route `reconstruct`; a gateway that has this Mac as a node gets them as mac-studio/…. Nothing loaded is unloaded:
# each model loads on first use (if macOS has the memory free) and is let go after 10 idle minutes. Keys and tokens are
# never printed.
set -eu
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
MUX_HOME="$HOME/.mux"
AGENTS="$HOME/Library/LaunchAgents"
VENV="$MUX_HOME/measure-venv"
PORT=8314
MODELS="$MUX_HOME/models"
# Pinned: what this was written against (docs/measure.md). Change them together, and run the test after.
DEPTH_PRO_COMMIT=9e65e4dbe9568d23c546fcec53302b10445e109e     # github.com/apple/ml-depth-pro
DEPTH_PRO_URL=https://ml-site.cdn-apple.com/models/depth-pro/depth_pro.pt  # Apple's 2024 checkpoint (the repo's LICENSE)
DEPTH_PRO_SHA256=3eb35ca68168ad3d14cb150f8947a4edf85589941661fdb2686259c80685c0ce
MAPANYTHING_COMMIT=3d10cf7a3016fc0f9bb13a071ee66c47b10be0d9   # github.com/facebookresearch/map-anything (MPS since PR #131)
MAPANYTHING_REPO=facebook/map-anything-apache
MAPANYTHING_REV=00f9c245bbcb60522d1ed7f9e9d88462c6e3f38a
VGGT_COMMIT=a288dd0f14786c93483e45524328726ab7b1b4ce          # github.com/facebookresearch/vggt
VGGT_REPO=facebook/VGGT-1B-Commercial
VGGT_REV=ebb29a532abe92960eeb6903a5530f16990ef4ab
PIP_PINS="torch==2.14.1 torchvision pillow-heif numpy<2
depth_pro @ git+https://github.com/apple/ml-depth-pro@$DEPTH_PRO_COMMIT
mapanything @ git+https://github.com/facebookresearch/map-anything@$MAPANYTHING_COMMIT"
TEST=1 RECON=mapanything
for a in "$@"; do case "$a" in --no-test) TEST= ;; --vggt) RECON=vggt ;; *) echo "unknown flag $a"; exit 2 ;; esac; done
[ "$(uname -s)" = Darwin ] || { echo "Run this on the Mac."; exit 2; }
[ "$(uname -m)" = arm64 ] || { echo "Apple Silicon is needed (MPS)."; exit 2; }
. "$MUX_HOME/mux.env"
MUX="http://127.0.0.1:${MUX_PORT:-7070}/api/admin"
mkdir -p "$MUX_HOME/logs" "$MODELS" "$AGENTS"
api() { curl -sf -X "$1" -H "Authorization: Bearer $MUX_ADMIN_TOKEN" -H "content-type: application/json" ${3:+-d "$3"} "$MUX$2"; }

FREE_GB=$(df -g "$MODELS" | awk 'NR == 2 { print $4 }')
[ "$FREE_GB" -ge 20 ] || { echo "only $FREE_GB GB free in $MODELS; 20 GB wanted (weights ~9 GB, PyTorch ~2 GB)"; exit 1; }

echo "→ Python packages in $VENV (PyTorch with MPS, Depth Pro, MapAnything)"
PY="$(command -v python3.12 || command -v python3.11 || true)"
[ -n "$PY" ] || { echo "python 3.11 or 3.12 is needed (brew install python@3.12)"; exit 1; }
[ -x "$VENV/bin/python" ] || "$PY" -m venv "$VENV"
PINS_NOW="$PIP_PINS $RECON"
if [ "$(cat "$VENV/.mux-pins" 2>/dev/null || true)" != "$PINS_NOW" ]; then
  "$VENV/bin/pip" install -q --upgrade pip
  printf '%s\n' "$PIP_PINS" > "$VENV/requirements.txt"
  "$VENV/bin/pip" install -q -r "$VENV/requirements.txt" "huggingface_hub[cli]"
  # VGGT asks for opencv-python beside MapAnything's headless build: its own code needs nothing else we lack
  [ "$RECON" != vggt ] || "$VENV/bin/pip" install -q --no-deps "vggt @ git+https://github.com/facebookresearch/vggt@$VGGT_COMMIT" einops
  printf '%s' "$PINS_NOW" > "$VENV/.mux-pins"
fi
"$VENV/bin/python" -c "import torch; assert torch.backends.mps.is_available(), 'no MPS'; import depth_pro, mapanything; print('  torch', torch.__version__, 'MPS ok')"

echo "→ Depth Pro checkpoint (Apple's CDN, 1.9 GB once, SHA-256 checked) into $MODELS/depth-pro"
mkdir -p "$MODELS/depth-pro"
CK="$MODELS/depth-pro/depth_pro.pt"
if [ ! -f "$CK" ] || [ "$(shasum -a 256 "$CK" | cut -d' ' -f1)" != "$DEPTH_PRO_SHA256" ]; then
  curl -fL --retry 3 -o "$CK.part" "$DEPTH_PRO_URL"
  [ "$(shasum -a 256 "$CK.part" | cut -d' ' -f1)" = "$DEPTH_PRO_SHA256" ] || { rm -f "$CK.part"; echo "✗ the Depth Pro checkpoint's SHA-256 does not match: not used"; exit 1; }
  mv "$CK.part" "$CK"
fi
curl -fsSL -o "$MODELS/depth-pro/LICENSE" "https://raw.githubusercontent.com/apple/ml-depth-pro/$DEPTH_PRO_COMMIT/LICENSE"

if [ "$RECON" = vggt ]; then
  RECON_ID=vggt-1b-commercial RECON_DIR="$MODELS/vggt-1b-commercial" RECON_NAME="VGGT 1B Commercial (reconstruct)"
  echo "→ VGGT-1B-Commercial ($VGGT_REPO @ ${VGGT_REV%"${VGGT_REV#???????}"}, gated, ~5 GB once) into $RECON_DIR"
  [ -f "$RECON_DIR/model.safetensors" ] || "$VENV/bin/hf" download "$VGGT_REPO" --revision "$VGGT_REV" --local-dir "$RECON_DIR" --include config.json model.safetensors LICENSE README.md \
    || { echo "✗ VGGT-1B-Commercial is gated: accept its licence on huggingface.co/$VGGT_REPO, then $VENV/bin/hf auth login"; exit 1; }
else
  RECON_ID=mapanything-apache RECON_DIR="$MODELS/map-anything-apache" RECON_NAME="MapAnything Apache (reconstruct)"
  echo "→ MapAnything Apache ($MAPANYTHING_REPO @ ${MAPANYTHING_REV%"${MAPANYTHING_REV#???????}"}, 4.9 GB once) into $RECON_DIR"
  [ -f "$RECON_DIR/model.safetensors" ] || "$VENV/bin/hf" download "$MAPANYTHING_REPO" --revision "$MAPANYTHING_REV" --local-dir "$RECON_DIR"
fi

ENV_KEYS="MUX_MEASURE_PORT=$PORT MUX_MEASURE_RECON=$RECON MUX_MEASURE_RECON_MODEL=$RECON_ID MUX_MEASURE_RECON_PATH=$RECON_DIR MUX_MEASURE_DEPTH_CHECKPOINT=$CK TORCH_HOME=$MODELS/torch PYTORCH_ENABLE_MPS_FALLBACK=1"
echo "→ load both once (MapAnything fetches DINOv2's code through torch.hub into $MODELS/torch the first time)"
launchctl bootout "gui/$(id -u)/com.mux.measure" 2>/dev/null || true
T0=$(date +%s)
env $ENV_KEYS MUX_MEASURE_DEPTH_MIN_FREE_GB=0 MUX_MEASURE_RECON_MIN_FREE_GB=0 "$VENV/bin/python" "$ROOT/server/measure/measure_server.py" --warm \
  || { echo "✗ a model did not load on MPS: see above, and docs/measure.md (what to try next: --vggt, or depth only)"; exit 1; }
echo "  both loaded in $(( $(date +%s) - T0 )) s"

echo "→ launchd agent com.mux.measure on :$PORT"
cat > "$AGENTS/com.mux.measure.plist" <<PL
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.mux.measure</string>
  <key>ProgramArguments</key><array><string>$VENV/bin/python</string><string>$ROOT/server/measure/measure_server.py</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>ProcessType</key><string>Interactive</string>
  <key>StandardOutPath</key><string>$MUX_HOME/logs/measure.log</string>
  <key>StandardErrorPath</key><string>$MUX_HOME/logs/measure.log</string>
  <key>EnvironmentVariables</key><dict>
    <key>PATH</key><string>/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
    <key>HF_HUB_OFFLINE</key><string>1</string>
    <key>PYTORCH_ENABLE_MPS_FALLBACK</key><string>1</string>
    <key>TORCH_HOME</key><string>$MODELS/torch</string>
    <key>MUX_MEASURE_PORT</key><string>$PORT</string>
    <key>MUX_MEASURE_RECON</key><string>$RECON</string>
    <key>MUX_MEASURE_RECON_MODEL</key><string>$RECON_ID</string>
    <key>MUX_MEASURE_RECON_PATH</key><string>$RECON_DIR</string>
    <key>MUX_MEASURE_DEPTH_CHECKPOINT</key><string>$CK</string>
  </dict>
</dict></plist>
PL
launchctl bootstrap "gui/$(id -u)" "$AGENTS/com.mux.measure.plist"
for i in $(seq 1 30); do curl -sf -o /dev/null "http://127.0.0.1:$PORT/health" && break; sleep 1; done
curl -sf -o /dev/null "http://127.0.0.1:$PORT/health" || { echo "✗ the measure server is not up: see $MUX_HOME/logs/measure.log"; exit 1; }

echo "→ models depth-pro and $RECON_ID, routes depth and reconstruct in mux"
reg() { # id, display name, kind, notes
  M=$(node -e 'const [id,name,kind,port,notes]=process.argv.slice(1);console.log(JSON.stringify({id,display_name:name,kind,backend:"external",base_url:"http://127.0.0.1:"+port+"/v1",upstream_model:id,caps:{quality:6,speed:5},notes}))' "$1" "$2" "$3" "$PORT" "$4")
  api POST /models "$M" >/dev/null 2>&1 || api PATCH "/models/$1" "$M" >/dev/null
}
reg depth-pro "Depth Pro (metric depth)" depth "Apple Depth Pro (ml-depth-pro ${DEPTH_PRO_COMMIT%"${DEPTH_PRO_COMMIT#???????}"}, Apple's 2024 checkpoint under the repo's LICENSE, 1.9 GB), PyTorch MPS, fp32: metric depth (mm PNG16) and focal length from one photo. server/measure/measure_server.py, com.mux.measure. Loads on first use, lets go after 10 idle minutes; presence applies."
reg "$RECON_ID" "$RECON_NAME" reconstruct "$( [ "$RECON" = vggt ] && echo "VGGT-1B-Commercial ($VGGT_REPO, VGGT License: commercial use, military excluded, gated), not metric: scale from one measurement or Depth Pro" || echo "MapAnything Apache ($MAPANYTHING_REPO @ ${MAPANYTHING_REV%"${MAPANYTHING_REV#???????}"}, Apache-2.0, 4.9 GB), metric" ): cameras and a point cloud from 2-12 photos, async jobs, PyTorch MPS. server/measure/measure_server.py, com.mux.measure. Loads on first use, lets go after 10 idle minutes; presence applies."
api PUT /routes/depth '{"kind":"depth","strategy":"priority","candidates":["depth-pro"]}' >/dev/null
api PUT /routes/reconstruct '{"kind":"reconstruct","strategy":"priority","candidates":["'$RECON_ID'"]}' >/dev/null
# Only one reconstruction model at a time on this Mac's route: the other one, if registered before, stays off it
[ "$RECON" = vggt ] && api PATCH /models/mapanything-apache '{"enabled":false}' >/dev/null 2>&1 || true
[ "$RECON" = mapanything ] && api PATCH /models/vggt-1b-commercial '{"enabled":false}' >/dev/null 2>&1 || true

[ -n "$TEST" ] || { echo "✓ measure: depth-pro and $RECON_ID on :$PORT (no test)"; exit 0; }
echo "→ the sample house (server/measure/sample, rendered with known sizes), straight from the measure server"
"$VENV/bin/python" "$ROOT/server/measure/sample/try_measure.py" --base "http://127.0.0.1:$PORT/v1" --out "$MUX_HOME/logs" \
  || { echo "✗ the test did not pass: see above and $MUX_HOME/logs/measure.log"; exit 1; }
echo "  depth PNG and point cloud in $MUX_HOME/logs/measure-test-depth.png and measure-test.ply — put the times in docs/measure.md"
echo "✓ measure: depth-pro and $RECON_ID on :$PORT — POST /v1/depth and /v1/reconstruct on mux"
