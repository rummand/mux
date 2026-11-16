#!/usr/bin/env bash
# Personal-use FLUX 3 Image Klein Q8 on the Mux Mac Studio.
# Does not modify FLUX.2 Klein or the existing image / image-edit routes.
# Usage: bash deploy/flux3.sh [--check] [--skip-test]
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
MUX_HOME="$HOME/.mux"
VENV="$MUX_HOME/images-venv"
WEIGHTS="$MUX_HOME/models/flux3-image-klein-q8"
REPO="mflux-community/flux-3-image-klein-mflux-q8"
PORT=8314
LABEL="com.mux.flux3"
CHECK=0
SKIP_TEST=0
for arg in "$@"; do
  case "$arg" in
    --check) CHECK=1 ;;
    --skip-test) SKIP_TEST=1 ;;
    *) echo "Unknown option: $arg" >&2; exit 2 ;;
  esac
done

if [ "$(uname -s)" != Darwin ] || [ "$(uname -m)" != arm64 ]; then
  echo "ERROR: FLUX 3 local MLX requires an Apple Silicon Mac." >&2; exit 2
fi

if [ "$CHECK" = 1 ]; then
  if find "$WEIGHTS" -name '*.safetensors' -print -quit 2>/dev/null | grep -q .; then
    echo "Weights present: $WEIGHTS"
  else
    echo "Weights missing: $WEIGHTS"
  fi
  curl -fsS "http://127.0.0.1:$PORT/health" || true
  exit 0
fi

[ -f "$MUX_HOME/mux.env" ] || { echo "ERROR: $MUX_HOME/mux.env is missing; install Mux first" >&2; exit 1; }
# shellcheck disable=SC1090
source "$MUX_HOME/mux.env"
[ -n "$MUX_ADMIN_TOKEN" ] || { echo "ERROR: MUX_ADMIN_TOKEN missing" >&2; exit 1; }
MUX="http://127.0.0.1:$(printf %s "$MUX_PORT" | sed 's/^$/7070/')/api/admin"
# MUX_PORT may be undefined in older installations:
if [ -z "$MUX_PORT" ]; then MUX="http://127.0.0.1:7070/api/admin"; fi
admin_get() { curl -fsS -H "Authorization: Bearer $MUX_ADMIN_TOKEN" "$MUX$1"; }
admin_put() { curl -fsS -X PUT -H "Authorization: Bearer $MUX_ADMIN_TOKEN" -H "Content-Type: application/json" -d "$2" "$MUX$1"; }
admin_post() { curl -fsS -X POST -H "Authorization: Bearer $MUX_ADMIN_TOKEN" -H "Content-Type: application/json" -d "$2" "$MUX$1"; }
admin_patch() { curl -fsS -X PATCH -H "Authorization: Bearer $MUX_ADMIN_TOKEN" -H "Content-Type: application/json" -d "$2" "$MUX$1"; }
admin_get /models >/dev/null || { echo "ERROR: local Mux admin API is offline" >&2; exit 1; }

mkdir -p "$WEIGHTS" "$MUX_HOME/logs" "$HOME/Library/LaunchAgents"
PY=$(command -v python3.12 || command -v python3.11 || true)
[ -n "$PY" ] || { echo "ERROR: install Python 3.12 (brew install python@3.12)" >&2; exit 1; }
if [ ! -x "$VENV/bin/python" ]; then "$PY" -m venv "$VENV"; fi
if ! "$VENV/bin/python" -c 'import mflux; from mflux.models.flux3.variants import Flux3Klein, Flux3KleinEdit; import huggingface_hub' 2>/dev/null; then
  "$VENV/bin/python" -m pip install --upgrade "mflux==0.24.0" "huggingface_hub[hf_xet]"
fi
[ -x "$VENV/bin/hf" ] || { echo "ERROR: Hugging Face CLI missing in image venv" >&2; exit 1; }

if ! find "$WEIGHTS" -name '*.safetensors' -print -quit | grep -q .; then
  free_kb=$(df -Pk "$WEIGHTS" | awk 'NR==2 {print $4}')
  free_gb=$((free_kb / 1024 / 1024))
  if [ "$free_gb" -lt 14 ]; then
    echo "ERROR: Only $free_gb GB disk available; allow at least 14 GB for FLUX 3 Q8 + workspace" >&2
    exit 1
  fi
fi

# Hugging Face license acceptance/login may be needed. Never save a token in the repo.
echo "Downloading FLUX 3 Image Klein Q8 if needed ($REPO, approximately 9.9 GB)"
"$VENV/bin/hf" download "$REPO" --local-dir "$WEIGHTS"
if ! find "$WEIGHTS" -name '*.safetensors' -print -quit | grep -q .; then
  echo "ERROR: no FLUX 3 weights downloaded" >&2; exit 1
fi

PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
cat > "$PLIST" <<PL
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
 <key>Label</key><string>$LABEL</string>
 <key>ProgramArguments</key><array>
  <string>$VENV/bin/python</string>
  <string>$ROOT/server/images/flux3_server.py</string>
 </array>
 <key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
 <key>StandardOutPath</key><string>$MUX_HOME/logs/flux3.log</string>
 <key>StandardErrorPath</key><string>$MUX_HOME/logs/flux3.log</string>
 <key>EnvironmentVariables</key><dict>
  <key>PATH</key><string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
  <key>MUX_FLUX3_PORT</key><string>$PORT</string>
  <key>MUX_FLUX3_WEIGHTS</key><string>$WEIGHTS</string>
  <key>MUX_FLUX3_IDLE_MIN</key><string>5</string>
  <key>HF_HUB_OFFLINE</key><string>1</string>
 </dict>
</dict></plist>
PL
plutil -lint "$PLIST"
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"

healthy=0
for i in $(seq 1 30); do
  if curl -fsS "http://127.0.0.1:$PORT/health" >/dev/null 2>&1; then healthy=1; break; fi
  sleep 2
done
[ "$healthy" = 1 ] || { echo "ERROR: FLUX 3 daemon did not start. See ~/.mux/logs/flux3.log" >&2; exit 1; }
echo "FLUX 3 worker is up on 127.0.0.1:$PORT"

if [ "$SKIP_TEST" != 1 ]; then
  echo "Testing real generation at 512x512 (first run also loads model)"
  TMP_JSON=$(mktemp)
  trap 'rm -f "$TMP_JSON"' EXIT
  curl -fsS --max-time 900 "http://127.0.0.1:$PORT/v1/images/generations" \
    -H "Content-Type: application/json" \
    -d '{"model":"flux3-image-klein-q8","prompt":"A red bicycle leaning on a brick wall, soft morning light, photograph","size":"512x512","n":1,"seed":42}' > "$TMP_JSON"
  "$VENV/bin/python" -c 'import json,base64,sys; x=json.load(open(sys.argv[1])); b=base64.b64decode(x["data"][0]["b64_json"]); assert b.startswith(bytes([137,80,78,71])); open(sys.argv[2],"wb").write(b)' \
    "$TMP_JSON" "$MUX_HOME/logs/flux3-generate-test.png"
  echo "Testing a reference-image edit with the same model"
  curl -fsS --max-time 900 "http://127.0.0.1:$PORT/v1/images/edits" \
    -F model=flux3-image-klein-q8 \
    -F 'prompt=A photograph of a blue bicycle leaning on a brick wall, soft morning light' \
    -F "image=@$MUX_HOME/logs/flux3-generate-test.png" > "$TMP_JSON"
  "$VENV/bin/python" -c 'import json,base64,sys; x=json.load(open(sys.argv[1])); b=base64.b64decode(x["data"][0]["b64_json"]); assert b.startswith(bytes([137,80,78,71])); open(sys.argv[2],"wb").write(b)' \
    "$TMP_JSON" "$MUX_HOME/logs/flux3-edit-test.png"
  echo "✓ FLUX 3 generated and edited PNGs successfully"
fi

MODEL_JSON=$(node -e 'console.log(JSON.stringify({
 id:"flux3-image-klein-q8", display_name:"FLUX 3 Image Klein Q8 (personal use)",
 kind:"image", backend:"external", base_url:"http://127.0.0.1:8314/v1",
 upstream_model:"flux3-image-klein-q8",catalog_id:"flux3-image-klein",
 caps:{quality:9,speed:4},
 notes:"Local MFLUX/MLX on Mac Studio; generation + up to 10 reference-image edits; distilled 16 steps; FLUX Kommunity License v1.0 (personal non-commercial); idle-unloaded."
}))')
admin_post /models "$MODEL_JSON" >/dev/null 2>&1 || admin_patch /models/flux3-image-klein-q8 "$MODEL_JSON" >/dev/null
ROUTE_JSON='{"kind":"image","strategy":"priority","candidates":["flux3-image-klein-q8"]}'
admin_put /routes/image-flux3 "$ROUTE_JSON" >/dev/null
admin_put /routes/image-flux3-edit "$ROUTE_JSON" >/dev/null

echo "✓ Registered FLUX 3 in Mux as model flux3-image-klein-q8"
echo "✓ Routes image-flux3 and image-flux3-edit (the default image routes are unchanged)"
echo "The Railway Mux gateway should discover mac-studio/flux3-image-klein-q8 on its next node synchronization."
echo "The Mac must be online and reachable for remote Thread requests."
