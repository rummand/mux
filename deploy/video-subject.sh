#!/bin/sh
# Subject video on this Mac, as a mux model on the route `video-subject`: Phantom-Wan 1.3B (ByteDance, Apache-2.0) on
# diffusers and PyTorch MPS, a subject from 1–4 reference pictures. Why, the licences, what is proven: docs/identity.md.
#   ./deploy/video-subject.sh            fetch the pinned code and weights (checked by SHA-256), run the tests, start
#                                        com.mux.video-subject on :8317, register the model and route, a 2 s test clip
#                                        of a synthetic mannequin (never a real person)
#   ./deploy/video-subject.sh --no-test  the same without the clip
# It uses the Wan server's venv (~/.mux/video-venv) and its Wan2.1-VACE folder for umT5, the tokenizer and the VAE
# (Wan2.1's own, Apache-2.0), so only Phantom's DiT (5.7 GB) and its code (sparse, ~290 MB) are new. The server loads
# on the first job (only with 24 GB free), lets go after 10 idle minutes, and shares ~/.mux/run/video-gpu.lock with the
# Wan and camera servers: one video job at a time on this Mac. No tenant is given the route here: the owner decides.
set -eu
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
MUX_HOME="$HOME/.mux"
AGENTS="$HOME/Library/LaunchAgents"
VENV="$MUX_HOME/video-venv"
PORT=8317
MODEL_ID=phantom-wan-1.3b
CODE="$MUX_HOME/phantom"
CODE_REPO=https://github.com/Phantom-video/Phantom.git
CODE_REV=bd84b602dcc949e23c89cbbf266b6f5975f2f025
DIT_REPO=bytedance-research/Phantom
DIT_REV=926cb19b8273d3841edcf905ca4ddb57f8e43207
DIT="$MUX_HOME/models/phantom-wan-1.3b"
VACE="$MUX_HOME/models/wan2.1-vace-1.3b-diffusers"
TEST=1
[ "${1:-}" = --no-test ] && TEST=
[ "$(uname -s)" = Darwin ] || { echo "Run this on the Mac."; exit 2; }
[ "$(uname -m)" = arm64 ] || { echo "Apple Silicon is needed (MPS)."; exit 2; }
[ -x "$VENV/bin/python" ] && [ -d "$VACE/text_encoder" ] || { echo "✗ the Wan server is not set up here: ./deploy/video.sh first"; exit 1; }
. "$MUX_HOME/mux.env"
MUX="http://127.0.0.1:${MUX_PORT:-7070}/api/admin"
mkdir -p "$MUX_HOME/logs" "$MUX_HOME/models" "$AGENTS"
api() { curl -sf -X "$1" -H "Authorization: Bearer $MUX_ADMIN_TOKEN" -H "content-type: application/json" ${3:+-d "$3"} "$MUX$2"; }
sha() { shasum -a 256 "$1" | awk '{ print $1 }'; }
check() { [ -f "$1" ] && [ "$(sha "$1")" = "$2" ] || { echo "✗ $1 is missing or not the pinned file (SHA-256): delete it and run again"; exit 1; }; }
js() { node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const j=JSON.parse(s);$1})"; }
FREE=$(df -g "$HOME" | awk 'NR==2 { print $4 }')
[ -f "$DIT/Phantom-Wan-1.3B.pth" ] || [ "$FREE" -ge 32 ] || { echo "✗ $FREE GB free: Phantom needs 6 GB and the Mac should keep 25 GB"; exit 1; }

echo "→ Phantom's code at $CODE_REV (sparse: phantom_wan/, generate.py, the licence)"
if [ ! -d "$CODE/.git" ]; then
  git clone -q --filter=blob:none --no-checkout "$CODE_REPO" "$CODE"
  git -C "$CODE" sparse-checkout set --no-cone /phantom_wan/ /LICENSE.txt /README.md /generate.py /requirements.txt
fi
git -C "$CODE" fetch -q origin "$CODE_REV" 2>/dev/null || true
git -C "$CODE" checkout -q "$CODE_REV"
check "$CODE/LICENSE.txt" bcaef9fc0ed41ec93bc7a81aa1f53ba0886a68baf0d62ef5d5d56682eaa9254e

echo "→ Phantom-Wan-1.3B.pth ($DIT_REPO @ ${DIT_REV%"${DIT_REV#???????}"}, 5.7 GB)"
[ -f "$DIT/Phantom-Wan-1.3B.pth" ] || "$VENV/bin/hf" download "$DIT_REPO" Phantom-Wan-1.3B.pth README.md --revision "$DIT_REV" --local-dir "$DIT"
check "$DIT/Phantom-Wan-1.3B.pth" 3a23db1c11e23d350d24a418dcd2a252f50193097bca838d0c4c3ea8be3c0a84
cp "$CODE/LICENSE.txt" "$DIT/LICENSE.txt"   # Apache-2.0 §4: the licence goes with the weights
printf '%s\n' "Phantom-Wan 1.3B by the Intelligent Creation Team, ByteDance (Phantom, arXiv:2502.11079), https://huggingface.co/$DIT_REPO @ $DIT_REV," \
  "Apache-2.0 (LICENSE.txt here). Unchanged weights, loaded into diffusers' WanTransformer3DModel by mux's server/video/subject_server.py." > "$DIT/NOTICE"
echo "  ✓ pinned files"

echo "→ tests without the weights (job API, upstream's letterbox and scheduler, the sampler's mechanics)"
LOG="$MUX_HOME/logs/video-subject-test.log"
MUX_SUBJECT_CODE="$CODE" "$VENV/bin/python" "$ROOT/server/video/test_subject_server.py" > "$LOG" 2>&1 || { tail -20 "$LOG"; echo "✗ tests failed ($LOG)"; exit 1; }
tail -1 "$LOG" | sed 's/^/  /'

echo "→ launchd agent com.mux.video-subject on :$PORT"
cat > "$AGENTS/com.mux.video-subject.plist" <<PL
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.mux.video-subject</string>
  <key>ProgramArguments</key><array><string>$VENV/bin/python</string><string>$ROOT/server/video/subject_server.py</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>ProcessType</key><string>Interactive</string>
  <key>StandardOutPath</key><string>$MUX_HOME/logs/video-subject.log</string>
  <key>StandardErrorPath</key><string>$MUX_HOME/logs/video-subject.log</string>
  <key>EnvironmentVariables</key><dict>
    <key>PATH</key><string>/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
    <key>HF_HUB_OFFLINE</key><string>1</string>
    <key>MUX_SUBJECT_PORT</key><string>$PORT</string>
    <key>MUX_SUBJECT_MODEL</key><string>$MODEL_ID</string>
    <key>MUX_SUBJECT_CODE</key><string>$CODE</string>
    <key>MUX_SUBJECT_CKPT</key><string>$DIT/Phantom-Wan-1.3B.pth</string>
    <key>MUX_SUBJECT_WAN</key><string>$VACE</string>
  </dict>
</dict></plist>
PL
launchctl bootout "gui/$(id -u)/com.mux.video-subject" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$AGENTS/com.mux.video-subject.plist"
for i in $(seq 1 30); do curl -sf -o /dev/null "http://127.0.0.1:$PORT/health" && break; sleep 1; done
curl -sf -o /dev/null "http://127.0.0.1:$PORT/health" || { echo "✗ the subject server is not up: see $MUX_HOME/logs/video-subject.log"; exit 1; }

echo "→ model $MODEL_ID and route video-subject in mux"
api GET /routes | js 'process.exit(j.some(r=>r.name==="video-subject"&&r.kind==="video-subject")?0:1)' \
  || { echo "✗ this mux has no route video-subject: npm run build and restart mux (com.mux.server) with this change first"; exit 1; }
NOTES="Phantom-Wan 1.3B ($DIT_REPO @ ${DIT_REV%"${DIT_REV#???????}"}, ByteDance, Apache-2.0) on diffusers + PyTorch MPS: a subject from 1–4 reference pictures (on white) becomes a clip of up to 5 s, async jobs; server/video/subject_server.py, com.mux.video-subject. Loads on the first job (only with 24 GB free), lets go after 10 idle minutes; one video job at a time with the Wan and camera servers; research (docs/identity.md)."
MODEL=$(node -e 'console.log(JSON.stringify({id:process.argv[1],display_name:"Phantom-Wan 1.3B (subject video)",kind:"video-subject",backend:"external",base_url:"http://127.0.0.1:"+process.argv[2]+"/v1",upstream_model:process.argv[1],size_bytes:24*1024**3,caps:{quality:4,speed:1},notes:process.argv[3]}))' "$MODEL_ID" "$PORT" "$NOTES")
api POST /models "$MODEL" >/dev/null 2>&1 || api PATCH "/models/$MODEL_ID" "$MODEL" >/dev/null
api PUT /routes/video-subject '{"kind":"video-subject","strategy":"priority","candidates":["'$MODEL_ID'"]}' >/dev/null

if [ -n "$TEST" ]; then
  echo "→ a 2 s test clip of a synthetic mannequin (832x480, 16 fps, 30 steps; the first job loads the model)"
  W=$(mktemp -d)
  "$VENV/bin/python" "$ROOT/tools/identity_scene.py" "$W/scene" >/dev/null
  BODY="$W/body.json"
  "$VENV/bin/python" - "$W/scene" > "$BODY" <<'PY'
import base64, json, sys
b = lambda n: base64.b64encode(open(f"{sys.argv[1]}/{n}.png", "rb").read()).decode()
print(json.dumps({"model": "video-subject", "prompt": "a stylised mannequin figure walks slowly across an empty studio with a chequered floor, soft daylight",
                  "seed": 11, "seconds": 2, "fps": 16, "size": "832x480", "steps": 30, "reference_images_b64": [b("ref1"), b("ref2"), b("ref3")]}))
PY
  ID=$(curl -sf -H "content-type: application/json" --data-binary @"$BODY" "http://127.0.0.1:$PORT/v1/videos/generations" | js 'console.log(j.id)')
  T0=$(date +%s)
  while :; do
    S=$(curl -sf "http://127.0.0.1:$PORT/v1/videos/$ID" | js 'console.log(j.status+" "+Math.round(j.progress*100)+"%"+(j.error?" "+j.error.message:""))')
    case "$S" in succeeded*) break ;; failed*|cancelled*) echo "✗ clip: $S"; exit 1 ;; esac
    [ $(( $(date +%s) - T0 )) -lt 3600 ] || { echo "✗ clip: not done after an hour ($S)"; exit 1; }
    printf '  %s, %s s\n' "$S" "$(( $(date +%s) - T0 ))"; sleep 20
  done
  curl -sf -o "$MUX_HOME/logs/video-subject-test.mp4" "http://127.0.0.1:$PORT/v1/videos/$ID/content"
  rm -rf "$W"
  echo "  2 s in $(( $(date +%s) - T0 )) s: $MUX_HOME/logs/video-subject-test.mp4"
fi
echo "✓ video-subject: $MODEL_ID on :$PORT — POST /v1/videos/generations with model video-subject on mux (no tenant has the route yet)"
