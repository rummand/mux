#!/bin/sh
# Bloom's talking face on this Mac, for /v1/realtime sessions that ask for it (session.start face: true; docs/face.md).
#   ./deploy/face.sh                MuseTalk 1.5 on MLX (xocialize/musetalk-mlx @ c6eb30eb, MIT per its pyproject and
#                                   card) in ~/.mux/face-venv; the weights mlx-community/MuseTalk-1.5-q8 @ e5bb4364
#                                   (~1.6 GB, SHA-256 checked) in ~/.mux/models/musetalk-1.5-mlx-q8; Bloom's face
#                                   (made once with mux's own image route, a synthetic person: never regenerated
#                                   without --new-identity); the face server server/realtime/face_server.py as launchd
#                                   agent com.mux.face on 127.0.0.1:8324 (loads on the first session, exits after 15
#                                   idle minutes); the model musetalk-1.5-mlx (kind face) on the route face, allowed for
#                                   bloom's test tenant; and a health check
#   ./deploy/face.sh --measure      then the face alone (face_server.py --bench: first-frame latency, fps, lag, memory)
#                                   and 5 turns through /v1/realtime with the face (deploy/realtime-measure.mjs --face)
#   ./deploy/face.sh --new-identity make a new face (the old one is kept as face-<date>.png): the owner's call only
#   ./deploy/face.sh --still        the server without MuseTalk (the reference's mouth, motion only): to try the path
# Keys and tokens are never printed. Nothing a person says is kept.
set -eu
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
MUX_HOME="$HOME/.mux"
AGENTS="$HOME/Library/LaunchAgents"
VENV="$MUX_HOME/face-venv"
FACE="$MUX_HOME/face/bloom"
WEIGHTS="$MUX_HOME/models/musetalk-1.5-mlx-q8"
PORT=8324
MODEL_ID=musetalk-1.5-mlx
REPO=mlx-community/MuseTalk-1.5-q8
REV=e5bb43640a2e9457daae2bfbfdcefc402ef2051a
CODE="git+https://github.com/xocialize/musetalk-mlx@c6eb30ebd1ed4d043983209813370153de9346bf"
# Pinned to what this was written against (docs/face.md); change together and measure again.
PIP_PINS="mlx>=0.30 numpy opencv-python<5 librosa soundfile huggingface_hub websockets>=14,<16 musetalk-mlx@$CODE"
# The face: a fictional person made for Bloom, never a real one (docs/face.md, "Bloom's identity")
SEED=20261127
PROMPT="Studio portrait photograph of a fictional woman in her early thirties, an original synthetic person who is not any real or famous individual. Head and shoulders, facing the camera straight on, eyes open looking into the lens, a calm friendly expression, mouth gently closed, lips together. Warm brown eyes, natural light-brown hair tied back, a few freckles, no glasses, no jewellery, a plain dark-teal top. Even soft front light, no harsh shadows, plain light warm-grey background, sharp focus, natural skin texture."
BLINK_PROMPT="The same woman, the same photograph, with both eyes gently closed as in a blink. Nothing else changes: same face, head position, hair, light and background."
MEASURE= NEW= RENDERER=musetalk
for a in "$@"; do case "$a" in --measure) MEASURE=1 ;; --new-identity) NEW=1 ;; --still) RENDERER=still ;; *) echo "unknown flag $a"; exit 2 ;; esac; done
[ "$(uname -s)" = Darwin ] && [ "$(uname -m)" = arm64 ] || { echo "Run this on the Mac (Apple Silicon: MLX)."; exit 2; }
. "$MUX_HOME/mux.env"
BASE="http://127.0.0.1:${MUX_PORT:-7070}"
MUX="$BASE/api/admin"
api() { curl -sf -X "$1" -H "Authorization: Bearer $MUX_ADMIN_TOKEN" -H "content-type: application/json" ${3:+-d "$3"} "$MUX$2"; }
js() { node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const j=JSON.parse(s);$1})" -- "$@"; }
mkdir -p "$MUX_HOME/logs" "$FACE" "$AGENTS" "$WEIGHTS"
T=$(mktemp -d /tmp/mux-face.XXXXXX); trap 'rm -rf "$T"' EXIT
api GET /routes | js 'process.exit(j.some(r=>r.name==="face")?0:1)' || {
  echo "✗ mux on this Mac has no face route yet: git pull --ff-only && npm ci && npm run build && launchctl kickstart -k gui/\$(id -u)/com.mux.server"; exit 1; }
# bloom's test tenant lists its routes: it needs image and image-edit (the face is made with them, as it), face and the
# face's model (its sessions), speak (the measurement's speech)
api GET /tenants | js 'for (const t of j) if (t.id === "bloom-design-composer-test" && t.allowed.length) { const add = ["image","image-edit","speak","face","musetalk-1.5-mlx"].filter(r => !t.allowed.includes(r)); if (add.length) console.log(JSON.stringify({ allowed: [...t.allowed, ...add] })); }' > "$T/tenant.json"
if [ -s "$T/tenant.json" ]; then api PUT /tenants/bloom-design-composer-test "$(cat "$T/tenant.json")" >/dev/null && echo "  bloom-design-composer-test: image, image-edit, speak, face allowed"; fi

KEY_ID=
key() { # a one-day key of bloom's test tenant on this Mac, for the face picture and the measurement
  [ -s "$T/key" ] && return 0
  api POST /tenants/bloom-design-composer-test/keys '{"name":"face.sh (one day)","expiresInDays":1}' > "$T/key.json"
  KEY_ID=$(js 'console.log(j.record.id)' < "$T/key.json"); js 'console.log(j.key)' < "$T/key.json" > "$T/key"; rm -f "$T/key.json"
}
revoke() { [ -n "$KEY_ID" ] && curl -s -o /dev/null -X DELETE -H "Authorization: Bearer $MUX_ADMIN_TOKEN" "$MUX/keys/$KEY_ID"; KEY_ID=; rm -f "$T/key"; }

echo "→ MuseTalk on MLX in $VENV"
PY="$(command -v python3.12 || command -v python3.11 || true)"
[ -n "$PY" ] || { echo "python 3.11 or 3.12 is needed (brew install python@3.12)"; exit 1; }
[ -x "$VENV/bin/python" ] || "$PY" -m venv "$VENV"
if [ "$(cat "$VENV/.mux-pins" 2>/dev/null || true)" != "$PIP_PINS" ]; then
  "$VENV/bin/pip" install -q --upgrade pip
  "$VENV/bin/pip" install -q "mlx>=0.30" numpy "opencv-python<5" librosa soundfile huggingface_hub "websockets>=14,<16" "musetalk-mlx @ $CODE"
  echo "$PIP_PINS" > "$VENV/.mux-pins"
fi

echo "→ weights: $REPO @ ${REV%"${REV#????????}"} (~1.6 GB)"
"$VENV/bin/python" -c 'import sys; from huggingface_hub import snapshot_download as d; d(sys.argv[1], revision=sys.argv[2], local_dir=sys.argv[3])' "$REPO" "$REV" "$WEIGHTS" >/dev/null
( cd "$WEIGHTS" && shasum -a 256 -c - <<SUMS ) || { echo "✗ the weights' SHA-256 do not match the pinned revision"; exit 1; }
25f143b2788d67123e73809795192a7a169aa851f5f4253e21655413c7d52118  unet.safetensors
2a7670782dbe0ab66c40833dfd431b193375f0bdfc7c2daf76f5bc4e59070f98  vae.safetensors
c04baf7220bbc73393eeba74b6224398ce56caad60e4e0a0f4c28af3180836d3  whisper_encoder.safetensors
SUMS

if [ -n "$NEW" ] && [ -s "$FACE/face.png" ]; then
  D=$(date +%Y%m%d-%H%M); mv "$FACE/face.png" "$FACE/face-$D.png"; [ -f "$FACE/blink.png" ] && mv "$FACE/blink.png" "$FACE/blink-$D.png"
  [ -f "$FACE/identity.json" ] && mv "$FACE/identity.json" "$FACE/identity-$D.json"; SEED=$((SEED + 1))
fi
if [ ! -s "$FACE/face.png" ]; then
  echo "→ Bloom's face: one synthetic portrait from mux's image route (seed $SEED), and the same face blinking (image-edit)"
  key
  node -e 'console.log(JSON.stringify({model:"image",prompt:process.argv[1],size:"1024x1024",seed:Number(process.argv[2]),n:1}))' "$PROMPT" "$SEED" > "$T/gen.json"
  code=$(curl -s -m 600 -o "$T/out.json" -w '%{http_code}' "$BASE/v1/images/generations" -H "Authorization: Bearer $(cat "$T/key")" -H "content-type: application/json" --data-binary @"$T/gen.json")
  [ "$code" = 200 ] || { echo "✗ the image route answered $code: $(head -c 300 "$T/out.json")"; revoke; exit 1; }
  js 'require("fs").writeFileSync(process.argv[2], Buffer.from(j.data[0].b64_json, "base64")); console.log(j.model || "image")' "$FACE/face.png" < "$T/out.json" > "$T/model"
  rm -f "$T/out.json"
  code=$(curl -s -m 900 -o "$T/edit.json" -w '%{http_code}' "$BASE/v1/images/edits" -H "Authorization: Bearer $(cat "$T/key")" \
    -F model=image-edit -F size=1024x1024 -F seed="$SEED" --form-string prompt="$BLINK_PROMPT" -F image=@"$FACE/face.png")
  if [ "$code" = 200 ]; then js 'require("fs").writeFileSync(process.argv[2], Buffer.from(j.data[0].b64_json, "base64"))' "$FACE/blink.png" < "$T/edit.json"
  else echo "  ! image-edit answered $code: no blinks (the face still moves)"; fi
  rm -f "$T/edit.json"
  SHA=$(shasum -a 256 "$FACE/face.png" | cut -d' ' -f1)
  node -e 'const [prompt,seed,model,sha,blink]=process.argv.slice(1);console.log(JSON.stringify({name:"bloom",image:"face.png",provenance:{what:"a synthetic person generated for Bloom; not any real individual",made:new Date().toISOString(),route:"image",model,seed:Number(seed),size:"1024x1024",prompt,sha256:sha,blink_prompt:blink,licence:"output of mux image route (see docs/face.md)"}},null,2))' \
    "$PROMPT" "$SEED" "$(cat "$T/model")" "$SHA" "$BLINK_PROMPT" > "$FACE/identity.json"
  mkdir -p "$ROOT/docs/face"
  sips -s format jpeg -s formatOptions 90 "$FACE/face.png" --out "$ROOT/docs/face/bloom-face.jpg" >/dev/null
  [ -s "$FACE/blink.png" ] && sips -s format jpeg -s formatOptions 90 "$FACE/blink.png" --out "$ROOT/docs/face/bloom-blink.jpg" >/dev/null
  echo "  ✓ $FACE/face.png (sha256 ${SHA%"${SHA#????????????}"}…, model $(cat "$T/model"))"
  echo "  ! look at docs/face/bloom-face.jpg: if the owner approves this face, commit docs/face/ (it is Bloom's one identity)"
fi
"$VENV/bin/python" "$ROOT/server/realtime/face_server.py" --identity "$FACE" --setup-identity
[ -d "$ROOT/docs/face" ] && cp "$FACE/identity.json" "$ROOT/docs/face/identity.json"

echo "→ launchd agent com.mux.face on :$PORT (renderer $RENDERER)"
cat > "$AGENTS/com.mux.face.plist" <<PL
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.mux.face</string>
  <key>ProgramArguments</key><array><string>$VENV/bin/python</string><string>$ROOT/server/realtime/face_server.py</string>
    <string>--port</string><string>$PORT</string><string>--identity</string><string>$FACE</string><string>--weights</string><string>$WEIGHTS</string><string>--renderer</string><string>$RENDERER</string></array>
  <key>WorkingDirectory</key><string>$FACE</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>ProcessType</key><string>Interactive</string>
  <key>StandardOutPath</key><string>$MUX_HOME/logs/face.log</string>
  <key>StandardErrorPath</key><string>$MUX_HOME/logs/face.log</string>
  <key>EnvironmentVariables</key><dict><key>HF_HUB_OFFLINE</key><string>1</string></dict>
</dict></plist>
PL
launchctl bootout "gui/$(id -u)/com.mux.face" 2>/dev/null || true
i=0; while launchctl print "gui/$(id -u)/com.mux.face" >/dev/null 2>&1; do i=$((i + 1)); [ $i -lt 20 ] || break; sleep 0.5; done
launchctl bootstrap "gui/$(id -u)" "$AGENTS/com.mux.face.plist"
for i in $(seq 1 60); do curl -sf -o /dev/null "http://127.0.0.1:$PORT/health" && break; sleep 1; done
curl -sf "http://127.0.0.1:$PORT/v1/models" | js 'const m=j.data[0];console.log(`  ✓ ${m.id}: loaded ${m.loaded}, needs ${m.need_gb} GB free to load`)' || { echo "✗ the face server is not up: see $MUX_HOME/logs/face.log"; exit 1; }

echo "→ model $MODEL_ID (kind face) on the route face"
M=$(node -e 'console.log(JSON.stringify({id:"musetalk-1.5-mlx",display_name:"MuseTalk 1.5 (Bloom'"'"'s face, MLX q8)",kind:"face",backend:"external",base_url:"http://127.0.0.1:"+process.argv[1]+"/v1",upstream_model:"musetalk-1.5-mlx",size_bytes:9000000000,caps:{quality:3,speed:8},notes:"MuseTalk 1.5 (TMElyralab, MIT) on MLX (xocialize/musetalk-mlx c6eb30eb; mlx-community/MuseTalk-1.5-q8 e5bb4364): lip-sync of one fixed synthetic face (Bloom) from the speech of a /v1/realtime session that asks for it; idle and listening motion is procedural. server/realtime/face_server.py, com.mux.face :8324. docs/face.md."}))' "$PORT")
api POST /models "$M" >/dev/null 2>&1 || api PATCH "/models/$MODEL_ID" "$M" >/dev/null
api PUT /routes/face '{"kind":"face","strategy":"priority","candidates":["musetalk-1.5-mlx"]}' >/dev/null && echo "  face: musetalk-1.5-mlx"
api GET /tenants | js 'const t = j.find(x => x.id === "gateway-railway"); if (t && t.allowed.length && !t.allowed.includes("face")) console.log("  ! gateway-railway lists its routes: add face for Railway sessions with a face")'

if [ -n "$MEASURE" ]; then
  key
  echo "→ the face alone: 12 s of Bloom's speech (Kokoro af_heart), sent as mux sends it (stops com.mux.face while it runs)"
  curl -sf -m 180 -o "$T/speech.wav" "$BASE/v1/audio/speech" -H "Authorization: Bearer $(cat "$T/key")" -H "content-type: application/json" \
    -d '{"model":"speak","voice":"af_heart","response_format":"wav","input":"Good morning. You have three meetings today, and two invoices are overdue. The first meeting is at nine with Anna from the bank, about the new credit line. Shall I draft a reminder to the two customers who have not paid yet?"}' || { echo "✗ speak: run deploy/speech-en.sh"; revoke; exit 1; }
  launchctl bootout "gui/$(id -u)/com.mux.face" 2>/dev/null || true; sleep 2
  "$VENV/bin/python" "$ROOT/server/realtime/face_server.py" --identity "$FACE" --weights "$WEIGHTS" --renderer "$RENDERER" --bench "$T/speech.wav" --bench-runs 3 2>&1 | grep -v ' INFO ' | tee "$MUX_HOME/logs/face-bench.log" || true
  for size in 256 512; do "$VENV/bin/python" "$ROOT/server/realtime/face_server.py" --identity "$FACE" --weights "$WEIGHTS" --renderer "$RENDERER" --bench "$T/speech.wav" --bench-runs 2 --size $size 2>&1 | grep -v ' INFO ' | tail -5 | tee -a "$MUX_HOME/logs/face-bench.log" || true; done
  launchctl bootstrap "gui/$(id -u)" "$AGENTS/com.mux.face.plist"
  for i in $(seq 1 60); do curl -sf -o /dev/null "http://127.0.0.1:$PORT/health" && break; sleep 1; done
  echo "→ 5 turns through /v1/realtime with the face"
  node "$ROOT/deploy/realtime-measure.mjs" --url "$BASE" --key-file "$T/key" --turns 5 --barge-in --face --json "$MUX_HOME/logs/realtime-measure-face-$(date +%Y%m%d-%H%M).json" | tee -a "$MUX_HOME/logs/face-bench.log" || true
  echo "  put $MUX_HOME/logs/face-bench.log's numbers in docs/face.md (\"Measured\")"
fi
revoke
echo "✓ Bloom's face: /v1/realtime with {\"type\":\"session.start\",\"face\":true} (docs/face.md)"
