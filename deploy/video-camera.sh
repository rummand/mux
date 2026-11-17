#!/bin/sh
# Camera-driven video on this Mac, as a mux model on the route `video-camera`: LingBot-World v2 1.3B causal-fast
# (Robbyant, CC BY-NC-SA 4.0 — non-commercial, share-alike; allowed: we are research, not commercial) ported to
# PyTorch MPS. Why, the pose mapping, licences and what is proven: docs/video-camera.md.
#   ./deploy/video-camera.sh               install what is missing, fetch the pinned code and weights (checked by
#                                          SHA-256), check the port with tiny weights, (re)load the agent, register
#                                          the model and route, then make a 2 s test clip
#   ./deploy/video-camera.sh --no-test     the same without the test clip
#   ./deploy/video-camera.sh --measure 30  after that, a 30 s take (any 5-60): seconds per chunk, peak memory and the
#                                          drift record, into ~/.mux/logs/video-camera-measure-30.{mp4,json}
#   ./deploy/video-camera.sh --railway     after that, Railway mux from a clean worktree of origin/main (the route
#                                          video-camera needs the new gateway), and video-camera allowed for `thread`
# server/video/camera_server.py runs on 127.0.0.1:8315 (com.mux.video-camera). It loads its model on the first job
# (only with 24 GB free) and lets it go after 10 idle minutes; one video job at a time on this Mac, shared with the
# Wan server (com.mux.video, :8313) through ~/.mux/run/video-gpu.lock. Nothing loaded now is unloaded. Keys and
# tokens are never printed.
set -eu
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
MUX_HOME="$HOME/.mux"
AGENTS="$HOME/Library/LaunchAgents"
VENV="$MUX_HOME/video-camera-venv"
PORT=8315
MODEL_ID=lingbot-world-v2-1.3b
CODE="$MUX_HOME/lingbot-world-v2"
CODE_REPO=https://github.com/robbyant/lingbot-world-v2
CODE_REV=1895d300d8ac936401689b26389f51cbd36530eb
DIT_REPO=robbyant/lingbot-world-v2-1.3b-causal-fast
DIT_REV=7e36a5f919f86cb4255cc9bfc30adb44963fbde1
DIT="$MUX_HOME/models/lingbot-world-v2-1.3b-causal-fast"
# The Wan2.1 VAE and umT5-XXL that LingBot's README takes from its 14B repo are byte for byte Wan's own (same SHA-256),
# so they come from Wan-AI under Apache-2.0. umT5 is not stored twice: the diffusers copy Wan2.1-VACE already has is
# used (MUX_CAMERA_T5_DIR); only without it is Wan's .pth fetched (11.4 GB).
ASSETS_REPO=Wan-AI/Wan2.1-T2V-1.3B
ASSETS_REV=37ec512624d61f7aa208f7ea8140a131f93afc9a
ASSETS="$MUX_HOME/models/wan2.1-assets"
VACE="$MUX_HOME/models/wan2.1-vace-1.3b-diffusers"
TEST=1 MEASURE= RAILWAY=
while [ $# -gt 0 ]; do
  case "$1" in
    --no-test) TEST= ;;
    --measure) MEASURE="${2:-30}"; shift ;;
    --railway) RAILWAY=1 ;;
    *) echo "unknown flag $1"; exit 2 ;;
  esac
  shift
done
[ "$(uname -s)" = Darwin ] || { echo "Run this on the Mac."; exit 2; }
[ "$(uname -m)" = arm64 ] || { echo "Apple Silicon is needed (MPS)."; exit 2; }
. "$MUX_HOME/mux.env"
MUX="http://127.0.0.1:${MUX_PORT:-7070}/api/admin"
mkdir -p "$MUX_HOME/logs" "$MUX_HOME/models" "$MUX_HOME/run" "$AGENTS"
api() { curl -sf -X "$1" -H "Authorization: Bearer $MUX_ADMIN_TOKEN" -H "content-type: application/json" ${3:+-d "$3"} "$MUX$2"; }
sha() { shasum -a 256 "$1" | awk '{ print $1 }'; }
check() { # file sha256
  [ -f "$1" ] || { echo "✗ missing $1"; exit 1; }
  [ "$(sha "$1")" = "$2" ] || { echo "✗ $1 is not the pinned file (SHA-256 differs): delete it and run again"; exit 1; }
}
js() { node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const j=JSON.parse(s);$1})"; }

echo "→ Python packages in $VENV (PyTorch with MPS; the same pins as the Wan server, plus einops)"
PY="$(command -v python3.12 || command -v python3.11 || true)"
[ -n "$PY" ] || { echo "python 3.11 or 3.12 is needed (brew install python@3.12)"; exit 1; }
[ -x "$VENV/bin/python" ] || "$PY" -m venv "$VENV"
REQ=$(mktemp)
cat > "$REQ" <<'R'
torch==2.14.1
diffusers==0.42.1
transformers==5.22.2
accelerate==1.15.0
safetensors==0.8.0
einops==0.8.1
ftfy==6.3.1
sentencepiece==0.2.2
regex
imageio-ffmpeg==0.6.0
pillow
numpy
R
"$VENV/bin/python" -c "import importlib.metadata as m; assert m.version('torch') == '2.14.1' and m.version('einops') == '0.8.1' and m.version('diffusers') == '0.42.1'" 2>/dev/null \
  || "$VENV/bin/pip" install -q -r "$REQ"
rm -f "$REQ"
"$VENV/bin/python" -c "import torch, einops; assert torch.backends.mps.is_available(), 'no MPS'; print('  torch', torch.__version__, 'MPS ok')"

echo "→ LingBot-World v2 code ($CODE_REPO @ ${CODE_REV%"${CODE_REV#???????}"}) in $CODE"
if [ ! -d "$CODE/.git" ]; then
  git clone -q --filter=blob:none "$CODE_REPO" "$CODE"
fi
git -C "$CODE" fetch -q origin "$CODE_REV" 2>/dev/null || git -C "$CODE" fetch -q origin
git -C "$CODE" -c advice.detachedHead=false checkout -q "$CODE_REV"
[ "$(git -C "$CODE" rev-parse HEAD)" = "$CODE_REV" ] || { echo "✗ $CODE is not at $CODE_REV"; exit 1; }

NEED_GB=8
[ -d "$VACE/text_encoder" ] || NEED_GB=20
echo "→ weights: $DIT_REPO @ ${DIT_REV%"${DIT_REV#???????}"} (6.8 GB) and the Wan2.1 VAE ($ASSETS_REPO @ ${ASSETS_REV%"${ASSETS_REV#???????}"})"
if [ ! -f "$DIT/model-00006-of-00006.safetensors" ] || [ ! -f "$ASSETS/Wan2.1_VAE.pth" ]; then
  FREE_GB=$(df -g "$MUX_HOME/models" | awk 'NR == 2 { print $4 }')
  [ "$FREE_GB" -ge $((NEED_GB + 20)) ] || { echo "only $FREE_GB GB free; $((NEED_GB + 20)) GB wanted ($NEED_GB GB of weights, 20 GB left over)"; exit 1; }
fi
[ -f "$DIT/model-00006-of-00006.safetensors" ] || "$VENV/bin/hf" download "$DIT_REPO" --revision "$DIT_REV" --local-dir "$DIT" \
  --include "model-*.safetensors" "model.safetensors.index.json" "README.md"
[ -f "$ASSETS/Wan2.1_VAE.pth" ] || "$VENV/bin/hf" download "$ASSETS_REPO" Wan2.1_VAE.pth LICENSE.txt --revision "$ASSETS_REV" --local-dir "$ASSETS"
T5_ENV=""
if [ -d "$VACE/text_encoder" ]; then
  echo "  umT5-XXL: the diffusers copy in $VACE (shared with the Wan server)"
else
  echo "  umT5-XXL: no Wan2.1-VACE folder here, so Wan's own .pth (11.4 GB)"
  [ -f "$ASSETS/models_t5_umt5-xxl-enc-bf16.pth" ] || "$VENV/bin/hf" download "$ASSETS_REPO" models_t5_umt5-xxl-enc-bf16.pth "google/umt5-xxl/*" --revision "$ASSETS_REV" --local-dir "$ASSETS"
  check "$ASSETS/models_t5_umt5-xxl-enc-bf16.pth" 7cace0da2b446bbbbc57d031ab6cf163a3d59b366da94e5afe36745b746fd81d
  T5_ENV="<key>MUX_CAMERA_T5_PTH</key><string>$ASSETS/models_t5_umt5-xxl-enc-bf16.pth</string>"
fi
echo "  checking SHA-256 (a minute)"
check "$DIT/model-00001-of-00006.safetensors" 4169eaf504fc63c235f4b66c95887951ecd71ba4ca9492e8528b6709d63ed9b2
check "$DIT/model-00002-of-00006.safetensors" e6745d1e600f697f2285ca435de09c49d2082303b7f9a2bb39003fc87b354d2f
check "$DIT/model-00003-of-00006.safetensors" 20f9b226fcfcfb4dead5c1e3ff1b77da182787442ebabfdaf23d3c68aca44ceb
check "$DIT/model-00004-of-00006.safetensors" 5b5c18cc18a4de976002f45777f59b4d27d30786c6db94e134d0af5a031f5272
check "$DIT/model-00005-of-00006.safetensors" 089575f86c3c62e12566a79c5e0afd663415aa4376e193b45ee2bb2ac65a9cbe
check "$DIT/model-00006-of-00006.safetensors" c0d3d8643d07b6d6e26d614f80cf3538a562f575937a759c64a71d5575f2f915
check "$ASSETS/Wan2.1_VAE.pth" 38071ab59bd94681c686fa51d75a1968f64e470262043be31f7a094e442fd981
# The licence goes with the weights (CC BY-NC-SA 4.0 §3: keep the notice, credit Robbyant)
cp "$CODE/LICENSE.txt" "$DIT/LICENSE.txt"
printf '%s\n' "LingBot-World v2 1.3B causal-fast by the Robbyant Team (Ant Group), https://huggingface.co/$DIT_REPO @ $DIT_REV," \
  "licensed CC BY-NC-SA 4.0 (LICENSE.txt here). Unchanged weights. Run by mux's server/video/lingbot_mps.py (CC BY-NC-SA 4.0)." > "$DIT/NOTICE"
echo "  ✓ every file is the pinned one"

echo "→ the MPS port against upstream's code, with tiny random weights"
PARITY="$MUX_HOME/logs/video-camera-port-test.log"
if MUX_CAMERA_CODE="$CODE" "$VENV/bin/python" "$ROOT/server/video/test_lingbot_mps.py" > "$PARITY" 2>&1; then
  tail -1 "$PARITY" | sed 's/^/  /'
else
  tail -20 "$PARITY"; echo "✗ the port does not match upstream here (all of it: $PARITY)"; exit 1
fi

echo "→ launchd agent com.mux.video-camera on :$PORT"
cat > "$AGENTS/com.mux.video-camera.plist" <<PL
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.mux.video-camera</string>
  <key>ProgramArguments</key><array><string>$VENV/bin/python</string><string>$ROOT/server/video/camera_server.py</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>ProcessType</key><string>Interactive</string>
  <key>StandardOutPath</key><string>$MUX_HOME/logs/video-camera.log</string>
  <key>StandardErrorPath</key><string>$MUX_HOME/logs/video-camera.log</string>
  <key>EnvironmentVariables</key><dict>
    <key>PATH</key><string>/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
    <key>HF_HUB_OFFLINE</key><string>1</string>
    <key>MUX_CAMERA_PORT</key><string>$PORT</string>
    <key>MUX_CAMERA_MODEL</key><string>$MODEL_ID</string>
    <key>MUX_CAMERA_CODE</key><string>$CODE</string>
    <key>MUX_CAMERA_DIT</key><string>$DIT</string>
    <key>MUX_CAMERA_VAE</key><string>$ASSETS/Wan2.1_VAE.pth</string>
    <key>MUX_CAMERA_T5_DIR</key><string>$VACE</string>
    $T5_ENV
  </dict>
</dict></plist>
PL
launchctl bootout "gui/$(id -u)/com.mux.video-camera" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$AGENTS/com.mux.video-camera.plist"
for i in $(seq 1 30); do curl -sf -o /dev/null "http://127.0.0.1:$PORT/health" && break; sleep 1; done
curl -sf -o /dev/null "http://127.0.0.1:$PORT/health" || { echo "✗ the camera server is not up: see $MUX_HOME/logs/video-camera.log"; exit 1; }

echo "→ model $MODEL_ID and route video-camera in mux"
api GET /routes | js 'process.exit(j.some(r=>r.name==="video-camera"&&r.kind==="video-camera")?0:1)' \
  || { echo "✗ this mux has no route video-camera of kind video-camera: npm run build and restart mux (com.mux.server) on this branch first"; exit 1; }
NOTES="LingBot-World v2 1.3B causal-fast ($DIT_REPO @ ${DIT_REV%"${DIT_REV#???????}"}, Robbyant, CC BY-NC-SA 4.0: non-commercial, credit Robbyant, share-alike) on PyTorch MPS: a first frame and a camera path (Sets' convention) become a take of up to 60 s, async jobs; server/video/camera_server.py, com.mux.video-camera. Loads on the first job (only with 24 GB free), lets go after 10 idle minutes; one video job at a time with the Wan server; presence applies."
MODEL=$(node -e 'console.log(JSON.stringify({id:process.argv[1],display_name:"LingBot-World v2 1.3B (camera video)",kind:"video-camera",backend:"external",base_url:"http://127.0.0.1:"+process.argv[2]+"/v1",upstream_model:process.argv[1],caps:{quality:5,speed:2},notes:process.argv[3]}))' "$MODEL_ID" "$PORT" "$NOTES")
api POST /models "$MODEL" >/dev/null 2>&1 || api PATCH "/models/$MODEL_ID" "$MODEL" >/dev/null
api PUT /routes/video-camera '{"kind":"video-camera","strategy":"priority","candidates":["'$MODEL_ID'"]}' >/dev/null

take() { # seconds out.mp4 out.json
  BODY=$(mktemp)
  "$VENV/bin/python" "$ROOT/server/video/camera_server.py" --sample-request "$1" "$CODE/examples/03/image.jpg" > "$BODY"
  ID=$(curl -sf -H "content-type: application/json" --data-binary @"$BODY" "http://127.0.0.1:$PORT/v1/videos/generations" | js 'console.log(j.id)')
  rm -f "$BODY"
  T0=$(date +%s)
  while :; do
    J=$(curl -sf "http://127.0.0.1:$PORT/v1/videos/$ID")
    S=$(printf %s "$J" | js 'console.log(j.status+" "+Math.round(j.progress*100)+"%"+(j.stats&&j.stats.chunk_s?", last chunk "+j.stats.chunk_s+" s":"")+(j.error?" "+j.error.message:""))')
    case "$S" in
      succeeded*) break ;;
      failed*|cancelled*) echo "✗ take: $S (see $MUX_HOME/logs/video-camera.log)"; exit 1 ;;
    esac
    [ $(( $(date +%s) - T0 )) -lt 7200 ] || { echo "✗ take: not done after two hours ($S)"; exit 1; }
    printf '  %s, %s s\n' "$S" "$(( $(date +%s) - T0 ))"
    sleep 15
  done
  curl -sf -o "$2" "http://127.0.0.1:$PORT/v1/videos/$ID/content"
  printf %s "$J" > "$3"
  printf %s "$J" | js 'const s=j.stats;console.log(`  ${j.seconds} s in ${s.total_s} s (load ${s.load_s} s): ${s.chunks} chunks, ${s.chunk_s_median} s a chunk (median, max ${s.chunk_s_max}), ${s.seconds_per_video_second} s per second of video, peak ${s.peak_gb} GB`);for(const d of s.drift.filter((_,i)=>i%Math.max(1,Math.round(s.drift.length/12))===0))console.log(`    t ${d.t} s  luma ${d.luma}  contrast ${d.contrast}  sharpness ${d.sharpness}`)'
}

if [ -n "$TEST" ]; then
  echo "→ a 2 s test clip, straight from the camera server (832x480, 16 fps, a walk along a lake; the first job loads the model)"
  take 2 "$MUX_HOME/logs/video-camera-test.mp4" "$MUX_HOME/logs/video-camera-test.json"
  echo "  wrote $MUX_HOME/logs/video-camera-test.mp4 — record the times in docs/video-camera.md"
fi
if [ -n "$MEASURE" ]; then
  echo "→ a $MEASURE s take for the numbers (seconds per chunk, memory, drift)"
  take "$MEASURE" "$MUX_HOME/logs/video-camera-measure-$MEASURE.mp4" "$MUX_HOME/logs/video-camera-measure-$MEASURE.json"
  echo "  wrote $MUX_HOME/logs/video-camera-measure-$MEASURE.{mp4,json} — watch it for drift and write what you see in docs/video-camera.md"
fi

if [ -n "$RAILWAY" ]; then
  echo "→ Railway mux: deploy origin/main (it must have this change merged), allow video-camera for thread"
  . "$MUX_HOME/railway.env"
  GW="${MUX_GATEWAY_URL:-https://mux-production-0b55.up.railway.app}"
  gw() { curl -sf -X "$1" -H "Authorization: Bearer $MUX_GATEWAY_ADMIN_TOKEN" -H "content-type: application/json" ${3:+-d "$3"} "$GW/api/admin$2"; }
  git -C "$ROOT" fetch -q origin main
  git -C "$ROOT" cat-file -e origin/main:server/video/camera_server.py 2>/dev/null || { echo "✗ origin/main has no camera server yet: merge the branch video-camera first"; exit 1; }
  WT=$(mktemp -d /tmp/mux-deploy.XXXXXX) && rmdir "$WT"
  git -C "$ROOT" worktree add --detach "$WT" origin/main >/dev/null
  (cd "$WT" && railway up --detach -p a5bf89be-0ec9-4d3d-afcc-40226c2a86f4 -e production -s mux) || { git -C "$ROOT" worktree remove --force "$WT"; echo "✗ railway up"; exit 1; }
  git -C "$ROOT" worktree remove --force "$WT"
  i=0; until gw GET /routes | js 'process.exit(j.some(r=>r.name==="video-camera")?0:1)' 2>/dev/null; do i=$((i + 10)); [ $i -lt 900 ] || { echo "✗ the gateway has no route video-camera after 15 min"; exit 1; }; sleep 10; done
  i=0; until gw GET /models | js 'process.exit(j.some(m=>m.id==="mac-studio/'$MODEL_ID'"&&m.enabled)?0:1)' 2>/dev/null; do i=$((i + 5)); [ $i -lt 180 ] || { echo "✗ the gateway has not synced mac-studio/$MODEL_ID"; exit 1; }; sleep 5; done
  gw GET /tenants | js 'for (const t of j) if (t.id === "thread" && t.allowed.length && !t.allowed.includes("video-camera")) console.log(JSON.stringify({ allowed: [...t.allowed, "video-camera"] }))' > "$MUX_HOME/logs/video-camera-tenant.json"
  [ -s "$MUX_HOME/logs/video-camera-tenant.json" ] && gw PUT /tenants/thread "$(cat "$MUX_HOME/logs/video-camera-tenant.json")" >/dev/null && echo "  thread: video-camera allowed"
  echo "  ✓ Railway mux: route video-camera → mac-studio/$MODEL_ID"
fi
echo "✓ video-camera: $MODEL_ID on :$PORT — POST /v1/videos/generations with model video-camera on mux"
