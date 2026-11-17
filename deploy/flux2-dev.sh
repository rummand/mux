#!/bin/sh
# FLUX.2 [dev] on this Mac, beside the fast FLUX.2 klein (owner, 2026-11-17: "We run both"). Safe to run again.
#   ./deploy/flux2-dev.sh            fetch what is missing, (re)load the agent, register the model and routes here
#   ./deploy/flux2-dev.sh --railway  the same, then the routes on Railway mux (after its next sync of this Mac)
# Engine: stable-diffusion.cpp's sd-server (Metal), pinned release master-1106-532d2c1, in ~/.mux/sdcpp (mflux has no
# FLUX.2 [dev]). Weights in ~/.mux/models/flux2-dev-sdcpp (~35 GB): city96/FLUX.2-dev-gguf Q4_K_M (20 GB),
# unsloth/Mistral-Small-3.2-24B-Instruct-2506-GGUF Q4_K_M (14.3 GB, the text encoder), Comfy-Org/Flux-2-Dev's FLUX.2
# VAE (the same file as black-forest-labs/FLUX.2-dev's, without the gate). server/images/sdcpp_proxy.py on
# 127.0.0.1:8320 (com.mux.images-dev) starts sd-server on the first request (only with 40 GB free) and stops it after
# 10 idle minutes. Model `flux2-dev-q4`; routes `image-hq` (text to image) and `image-edit-dev` (edits), each with
# FLUX.2 klein behind it. `image`, `image-edit` and `image-edit-hq` are not touched. Licences and times: docs/image-dev.md.
set -eu
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
MUX_HOME="$HOME/.mux"
AGENTS="$HOME/Library/LaunchAgents"
SD_DIR="$MUX_HOME/sdcpp"
SD_RELEASE=master-1106-532d2c1
SD_ZIP=sd-master-532d2c1-bin-Darwin-macOS-26.7.2-arm64.zip
DIR="$MUX_HOME/models/flux2-dev-sdcpp"
HF="$MUX_HOME/images-venv/bin/hf"
MODEL_ID=flux2-dev-q4
FAST=flux2-klein-4b-q4
LABEL=com.mux.images-dev
PORT=8320
RAILWAY=
for a in "$@"; do case "$a" in --railway) RAILWAY=1 ;; *) echo "unknown flag $a"; exit 2 ;; esac; done
. "$MUX_HOME/mux.env"
MUX="http://127.0.0.1:${MUX_PORT:-7070}/api/admin"
api() { curl -sf -X "$1" -H "Authorization: Bearer $MUX_ADMIN_TOKEN" -H "content-type: application/json" ${3:+-d "$3"} "$MUX$2"; }
mkdir -p "$MUX_HOME/logs" "$DIR" "$AGENTS" "$SD_DIR"

echo "→ stable-diffusion.cpp $SD_RELEASE"
if [ ! -x "$SD_DIR/sd-server" ]; then
  curl -fsSL -o "$SD_DIR/sd.zip" "https://github.com/leejet/stable-diffusion.cpp/releases/download/$SD_RELEASE/$SD_ZIP"
  (cd "$SD_DIR" && unzip -oq sd.zip && rm sd.zip && xattr -dr com.apple.quarantine . 2>/dev/null || true)
fi

echo "→ weights (~35 GB the first time) into $DIR"
[ -x "$HF" ] || { echo "no $HF: run ./deploy/images.sh first (it makes the images venv)"; exit 1; }
[ -f "$DIR/flux2-dev-Q4_K_M.gguf" ] || "$HF" download city96/FLUX.2-dev-gguf flux2-dev-Q4_K_M.gguf --local-dir "$DIR"
[ -f "$DIR/Mistral-Small-3.2-24B-Instruct-2506-Q4_K_M.gguf" ] || "$HF" download unsloth/Mistral-Small-3.2-24B-Instruct-2506-GGUF Mistral-Small-3.2-24B-Instruct-2506-Q4_K_M.gguf --local-dir "$DIR"
[ -f "$DIR/split_files/vae/flux2-vae.safetensors" ] || "$HF" download Comfy-Org/Flux-2-Dev split_files/vae/flux2-vae.safetensors --local-dir "$DIR"

echo "→ launchd agent $LABEL on :$PORT"
cat > "$AGENTS/$LABEL.plist" <<PL
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key><array><string>/usr/bin/python3</string><string>$ROOT/server/images/sdcpp_proxy.py</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>ProcessType</key><string>Interactive</string>
  <key>StandardOutPath</key><string>$MUX_HOME/logs/images-dev.log</string>
  <key>StandardErrorPath</key><string>$MUX_HOME/logs/images-dev.log</string>
  <key>EnvironmentVariables</key><dict><key>PATH</key><string>/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin</string></dict>
</dict></plist>
PL
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
sleep 1
launchctl bootstrap "gui/$(id -u)" "$AGENTS/$LABEL.plist"
for i in $(seq 1 30); do curl -sf -o /dev/null "http://127.0.0.1:$PORT/health" && break; sleep 1; done
curl -sf -o /dev/null "http://127.0.0.1:$PORT/health" || { echo "✗ $LABEL does not answer on :$PORT (see $MUX_HOME/logs/images-dev.log)"; exit 1; }

echo "→ model $MODEL_ID and the routes image-hq and image-edit-dev in mux"
MODEL='{"id":"'$MODEL_ID'","display_name":"FLUX.2 [dev] Q4 (text to image, edits; minutes an image)","kind":"image","backend":"external","base_url":"http://127.0.0.1:'$PORT'/v1","upstream_model":"sd-cpp-local","caps":{"quality":9,"speed":2},"notes":"Black Forest Labs FLUX.2 [dev] (32 B), city96 GGUF Q4_K_M, text encoder Mistral Small 3.2 24B Q4_K_M, via stable-diffusion.cpp sd-server (com.mux.images-dev, :8320). FLUX.2 [dev] Non-Commercial License: allowed, we are research (CLAUDE.md). docs/image-dev.md"}'
api POST /models "$MODEL" >/dev/null 2>&1 || api PATCH "/models/$MODEL_ID" "$MODEL" >/dev/null
api PUT /routes/image-hq '{"kind":"image","strategy":"priority","candidates":["'$MODEL_ID'","'$FAST'"],"description":"Text to image, best quality: FLUX.2 [dev] (minutes an image); FLUX.2 klein when the Mac has no room for it"}' >/dev/null
api PUT /routes/image-edit-dev '{"kind":"image","strategy":"priority","candidates":["'$MODEL_ID'","'$FAST'"],"description":"Image edits with FLUX.2 [dev] (minutes an image); FLUX.2 klein when the Mac has no room for it"}' >/dev/null
echo "✓ $MODEL_ID on :$PORT — routes image-hq and image-edit-dev (FLUX.2 klein behind it)"

if [ -n "$RAILWAY" ]; then
  echo "→ Railway mux: the same routes on mac-studio/…"
  . "$MUX_HOME/railway.env"
  gw() { curl -sf -X "$1" -H "Authorization: Bearer $MUX_GATEWAY_ADMIN_TOKEN" -H "content-type: application/json" ${3:+-d "$3"} "$MUX_GATEWAY_URL/api/admin$2"; }
  for i in $(seq 1 30); do gw GET /models | grep -q "\"mac-studio/$MODEL_ID\"" && break; sleep 5; done
  gw GET /models | grep -q "\"mac-studio/$MODEL_ID\"" || { echo "✗ Railway has not synced mac-studio/$MODEL_ID yet: run again in a minute"; exit 1; }
  gw PUT /routes/image-hq '{"kind":"image","strategy":"priority","candidates":["mac-studio/'$MODEL_ID'","mac-studio/'$FAST'"],"description":"Text to image, best quality: FLUX.2 [dev] (minutes an image); FLUX.2 klein when the Mac has no room for it"}' >/dev/null
  gw PUT /routes/image-edit-dev '{"kind":"image","strategy":"priority","candidates":["mac-studio/'$MODEL_ID'","mac-studio/'$FAST'"],"description":"Image edits with FLUX.2 [dev] (minutes an image); FLUX.2 klein when the Mac has no room for it"}' >/dev/null
  echo "✓ Railway mux: image-hq and image-edit-dev"
fi
