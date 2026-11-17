#!/bin/sh
# Video on this Mac, as a mux model: Wan2.1-VACE-1.3B (Apache-2.0) through diffusers on PyTorch's MPS backend, for
# Thread's Sets (a grey 3D take's depth pass becomes footage) and anyone else. Why this model: docs/video.md.
#   ./deploy/video.sh             install what is missing, fetch the weights, (re)load the agent, register model and
#                                 routes, then make a 2 s test clip
#   ./deploy/video.sh --no-test   the same without the test clip
# server/video/video_server.py runs on 127.0.0.1:8313 (com.mux.video) and answers /v1/videos/generations (async
# jobs). It becomes the model `wan2.1-vace-1.3b` on the routes `video` and `video-depth`; a gateway that has this Mac
# as a node gets it as mac-studio/wan2.1-vace-1.3b. Nothing loaded is unloaded: the server loads its model on the
# first job (if macOS has 24 GB free) and lets it go after 10 idle minutes. Keys and tokens are never printed.
set -eu
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
MUX_HOME="$HOME/.mux"
AGENTS="$HOME/Library/LaunchAgents"
VENV="$MUX_HOME/video-venv"
PORT=8313
MODEL_ID=wan2.1-vace-1.3b
REPO=Wan-AI/Wan2.1-VACE-1.3B-diffusers
REV=ec4d2cb062b548996b179d493fdd05340de702a1
DIR="$MUX_HOME/models/wan2.1-vace-1.3b-diffusers"
# Pinned: the versions this was written against (docs/video.md). Change them together, and run the test clip after.
PIP_PINS="torch==2.14.1 diffusers==0.42.1 transformers==5.22.2 accelerate==1.15.0 ftfy==6.3.1 sentencepiece==0.2.2 imageio-ffmpeg==0.6.0 pillow numpy"
TEST=1
for a in "$@"; do case "$a" in --no-test) TEST= ;; *) echo "unknown flag $a"; exit 2 ;; esac; done
[ "$(uname -s)" = Darwin ] || { echo "Run this on the Mac."; exit 2; }
[ "$(uname -m)" = arm64 ] || { echo "Apple Silicon is needed (MPS)."; exit 2; }
. "$MUX_HOME/mux.env"
MUX="http://127.0.0.1:${MUX_PORT:-7070}/api/admin"
mkdir -p "$MUX_HOME/logs" "$MUX_HOME/models" "$AGENTS"

api() { curl -sf -X "$1" -H "Authorization: Bearer $MUX_ADMIN_TOKEN" -H "content-type: application/json" ${3:+-d "$3"} "$MUX$2"; }

echo "→ Python packages in $VENV (PyTorch with MPS, diffusers' WanVACEPipeline)"
PY="$(command -v python3.12 || command -v python3.11 || true)"
[ -n "$PY" ] || { echo "python 3.11 or 3.12 is needed (brew install python@3.12)"; exit 1; }
[ -x "$VENV/bin/python" ] || "$PY" -m venv "$VENV"
"$VENV/bin/python" -c "import importlib.metadata as m; assert m.version('diffusers') == '0.42.1' and m.version('torch') == '2.14.1'" 2>/dev/null \
  || "$VENV/bin/pip" install -q $PIP_PINS
"$VENV/bin/python" -c "import torch; assert torch.backends.mps.is_available(), 'no MPS'; from diffusers import WanVACEPipeline; print('  torch', torch.__version__, 'MPS ok')"

echo "→ Wan2.1-VACE-1.3B weights ($REPO @ ${REV%"${REV#???????}"}, ~19 GB once) into $DIR"
if [ ! -f "$DIR/transformer/diffusion_pytorch_model.safetensors.index.json" ]; then
  FREE_GB=$(df -g "$MUX_HOME/models" | awk 'NR == 2 { print $4 }')
  [ "$FREE_GB" -ge 30 ] || { echo "only $FREE_GB GB free; 30 GB wanted"; exit 1; }
  "$VENV/bin/hf" download "$REPO" --revision "$REV" --local-dir "$DIR" --exclude "assets/*"
fi

echo "→ launchd agent com.mux.video on :$PORT"
cat > "$AGENTS/com.mux.video.plist" <<PL
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.mux.video</string>
  <key>ProgramArguments</key><array><string>$VENV/bin/python</string><string>$ROOT/server/video/video_server.py</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>ProcessType</key><string>Interactive</string>
  <key>StandardOutPath</key><string>$MUX_HOME/logs/video.log</string>
  <key>StandardErrorPath</key><string>$MUX_HOME/logs/video.log</string>
  <key>EnvironmentVariables</key><dict>
    <key>PATH</key><string>/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
    <key>HF_HUB_OFFLINE</key><string>1</string>
    <key>PYTORCH_ENABLE_MPS_FALLBACK</key><string>1</string>
    <key>MUX_VIDEO_PORT</key><string>$PORT</string>
    <key>MUX_VIDEO_MODEL</key><string>$MODEL_ID</string>
    <key>MUX_VIDEO_MODEL_PATH</key><string>$DIR</string>
  </dict>
</dict></plist>
PL
launchctl bootout "gui/$(id -u)/com.mux.video" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$AGENTS/com.mux.video.plist"
for i in $(seq 1 30); do curl -sf -o /dev/null "http://127.0.0.1:$PORT/health" && break; sleep 1; done
curl -sf -o /dev/null "http://127.0.0.1:$PORT/health" || { echo "✗ the video server is not up: see $MUX_HOME/logs/video.log"; exit 1; }

echo "→ model $MODEL_ID and routes video, video-depth in mux"
NOTES="diffusers WanVACEPipeline on MPS, Wan2.1-VACE-1.3B ($REPO @ ${REV%"${REV#???????}"}, Apache-2.0, ~19 GB in $DIR): text to video and video from a depth pass, async jobs; server/video/video_server.py, com.mux.video. Loads on the first job (~20-30 GB, only with 24 GB free), lets go after 10 idle minutes; presence applies (polite: only when loaded)."
MODEL=$(node -e 'console.log(JSON.stringify({id:process.argv[1],display_name:"Wan2.1 VACE 1.3B (video)",kind:"video",backend:"external",base_url:"http://127.0.0.1:"+process.argv[2]+"/v1",upstream_model:process.argv[1],caps:{quality:5,speed:3},notes:process.argv[3]}))' "$MODEL_ID" "$PORT" "$NOTES")
api POST /models "$MODEL" >/dev/null 2>&1 || api PATCH "/models/$MODEL_ID" "$MODEL" >/dev/null
api PUT /routes/video '{"kind":"video","strategy":"priority","candidates":["'$MODEL_ID'"]}' >/dev/null
api PUT /routes/video-depth '{"kind":"video","strategy":"priority","candidates":["'$MODEL_ID'"]}' >/dev/null

[ -n "$TEST" ] || { echo "✓ video: $MODEL_ID on :$PORT (no test clip)"; exit 0; }
echo "→ a 2 s test clip, straight from the video server (832x480, 8 fps; the first job loads the model: minutes)"
OUT="$MUX_HOME/logs/video-test.mp4"
rm -f "$OUT"
ID=$(curl -sf -H "content-type: application/json" \
  -d '{"model":"video","prompt":"A red bicycle leaning on a brick wall, soft morning light, a slow pan","seconds":2,"fps":8,"size":"832x480","seed":7}' \
  "http://127.0.0.1:$PORT/v1/videos/generations" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).id))')
T0=$(date +%s)
while :; do
  J=$(curl -sf "http://127.0.0.1:$PORT/v1/videos/$ID")
  S=$(printf %s "$J" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);console.log(j.status+" "+Math.round(j.progress*100)+"%"+(j.error?" "+j.error.message:""))})')
  case "$S" in
    succeeded*) break ;;
    failed*|cancelled*) echo "✗ test clip: $S (see $MUX_HOME/logs/video.log)"; exit 1 ;;
  esac
  [ $(( $(date +%s) - T0 )) -lt 3600 ] || { echo "✗ test clip: not done after an hour ($S)"; exit 1; }
  printf '  %s, %s s\n' "$S" "$(( $(date +%s) - T0 ))"
  sleep 15
done
curl -sf -o "$OUT" "http://127.0.0.1:$PORT/v1/videos/$ID/content"
echo "  wrote $OUT in $(( $(date +%s) - T0 )) s (with the model's load) — record this in docs/video.md"
echo "✓ video: $MODEL_ID on :$PORT — POST /v1/videos/generations on mux (routes video, video-depth)"
