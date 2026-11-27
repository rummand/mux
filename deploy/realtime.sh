#!/bin/sh
# Talking to Bloom on this Mac: the cascade behind WebSocket /v1/realtime (docs/realtime.md).
#   ./deploy/realtime.sh             the hear sidecar (Silero VAD + Smart Turn v3 + parakeet-mlx streaming) as launchd
#                                    agent com.mux.hear on 127.0.0.1:8326, mux's settings for it, the routes a session
#                                    uses allowed for bloom's test tenant, then 5 English turns measured on this Mac
#                                    (deploy/realtime-measure.mjs, p50/p90) with a one-day key, revoked after
#   ./deploy/realtime.sh --no-hear   no sidecar: sessions use the energy VAD and whisper (transcribe route) only
#   ./deploy/realtime.sh --no-test   without the measurement
#   ./deploy/realtime.sh --railway   after that, Railway mux from a clean worktree of origin/main (it must have this
#                                    change), then 5 turns measured through Railway as bloom-for-business (one-day key)
# Needs mux on this Mac built with /v1/realtime (git pull, npm ci, npm run build, restart com.mux.server: the script
# says so if it is not), whisper on `transcribe` (deploy/audio.sh) and Kokoro af_heart on `speak` (deploy/speech-en.sh).
# Keys and tokens are never printed. Audio and words are never logged.
set -eu
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
MUX_HOME="$HOME/.mux"
AGENTS="$HOME/Library/LaunchAgents"
VENV="$MUX_HOME/realtime-venv"
PORT=8326
TURNS=5
# Pinned to what this was written against (docs/realtime.md); change together and measure again.
PIP_PINS="torch silero-vad>=5.1 onnxruntime transformers>=4.46,<5 parakeet-mlx>=0.4 websockets>=14,<16 huggingface_hub numpy"
HEAR=1 TEST=1 RAILWAY=
for a in "$@"; do case "$a" in --no-hear) HEAR= ;; --no-test) TEST= ;; --railway) RAILWAY=1 ;; *) echo "unknown flag $a"; exit 2 ;; esac; done
[ "$(uname -s)" = Darwin ] && [ "$(uname -m)" = arm64 ] || { echo "Run this on the Mac (Apple Silicon: parakeet-mlx)."; exit 2; }
. "$MUX_HOME/mux.env"
BASE="http://127.0.0.1:${MUX_PORT:-7070}"
MUX="$BASE/api/admin"
api() { curl -sf -X "$1" -H "Authorization: Bearer $MUX_ADMIN_TOKEN" -H "content-type: application/json" ${3:+-d "$3"} "$MUX$2"; }
js() { node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const j=JSON.parse(s);$1})"; }
mkdir -p "$MUX_HOME/logs" "$AGENTS"
T=$(mktemp -d /tmp/mux-realtime.XXXXXX); trap 'rm -rf "$T"' EXIT

api GET /settings | js 'process.exit(Array.isArray(j.realtimeTenants)?0:1)' || {
  echo "✗ mux on this Mac has no /v1/realtime yet: git pull --ff-only && npm ci && npm run build && launchctl kickstart -k gui/\$(id -u)/com.mux.server"; exit 1; }

if [ -n "$HEAR" ]; then
  echo "→ Python packages in $VENV (Silero VAD, Smart Turn v3's runtime, parakeet-mlx)"
  PY="$(command -v python3.12 || command -v python3.11 || true)"
  [ -n "$PY" ] || { echo "python 3.11 or 3.12 is needed (brew install python@3.12)"; exit 1; }
  [ -x "$VENV/bin/python" ] || "$PY" -m venv "$VENV"
  if [ "$(cat "$VENV/.mux-pins" 2>/dev/null || true)" != "$PIP_PINS" ]; then
    "$VENV/bin/pip" install -q --upgrade pip
    # shellcheck disable=SC2086
    "$VENV/bin/pip" install -q $PIP_PINS
    echo "$PIP_PINS" > "$VENV/.mux-pins"
  fi
  echo "→ models: Smart Turn v3 (ONNX, ~32 MB) and parakeet-tdt-0.6b-v3 (MLX, ~2.5 GB), into the Hugging Face cache"
  "$VENV/bin/python" -c 'from huggingface_hub import snapshot_download as d; d("pipecat-ai/smart-turn-v3", allow_patterns=["*.onnx"]); d("mlx-community/parakeet-tdt-0.6b-v3")' >/dev/null

  echo "→ launchd agent com.mux.hear on :$PORT"
  cat > "$AGENTS/com.mux.hear.plist" <<PL
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.mux.hear</string>
  <key>ProgramArguments</key><array><string>$VENV/bin/python</string><string>$ROOT/server/realtime/hear_server.py</string><string>--port</string><string>$PORT</string></array>
  <key>WorkingDirectory</key><string>$MUX_HOME</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>ProcessType</key><string>Interactive</string>
  <key>StandardOutPath</key><string>$MUX_HOME/logs/hear.log</string>
  <key>StandardErrorPath</key><string>$MUX_HOME/logs/hear.log</string>
  <key>EnvironmentVariables</key><dict><key>HF_HUB_OFFLINE</key><string>1</string></dict>
</dict></plist>
PL
  launchctl bootout "gui/$(id -u)/com.mux.hear" 2>/dev/null || true
  i=0; while launchctl print "gui/$(id -u)/com.mux.hear" >/dev/null 2>&1; do i=$((i + 1)); [ $i -lt 20 ] || break; sleep 0.5; done
  launchctl bootstrap "gui/$(id -u)" "$AGENTS/com.mux.hear.plist"
  for i in $(seq 1 120); do curl -sf -o /dev/null "http://127.0.0.1:$PORT/health" && break; sleep 1; done
  curl -sf -o /dev/null "http://127.0.0.1:$PORT/health" || { echo "✗ the hear sidecar is not up: see $MUX_HOME/logs/hear.log (sessions fall back to the energy VAD)"; exit 1; }
  echo "  ✓ hear sidecar up"
  api PATCH /settings '{"realtimeHearUrl":"ws://127.0.0.1:'$PORT'/hear"}' >/dev/null
else
  api PATCH /settings '{"realtimeHearUrl":""}' >/dev/null
  echo "→ no hear sidecar: sessions hear with the energy VAD and transcribe with whisper"
fi

echo "→ who may talk, and the routes a session uses"
api GET /settings | js 'console.log("  settings.realtimeTenants: " + JSON.stringify(j.realtimeTenants) + "; hear " + (j.realtimeHearUrl || "off"))'
api GET /routes | js 'for (const n of ["transcribe","speak"]) { const r = j.find(x => x.name === n); console.log(`  route ${n}: ${r && r.candidates.length ? r.candidates.join(" → ") : "EMPTY: run deploy/" + (n === "speak" ? "speech-en.sh" : "audio.sh")}`); }'
# bloom's test tenant on this Mac lists its routes: transcribe and speak are added (a session's words and voice)
api GET /tenants | js 'for (const t of j) if (t.id === "bloom-design-composer-test" && t.allowed.length) { const add = ["transcribe","speak"].filter(r => !t.allowed.includes(r)); if (add.length) console.log(JSON.stringify({ allowed: [...t.allowed, ...add] })); }' > "$T/tenant.json"
if [ -s "$T/tenant.json" ]; then api PUT /tenants/bloom-design-composer-test "$(cat "$T/tenant.json")" >/dev/null && echo "  bloom-design-composer-test: transcribe and speak allowed"; fi
api GET /tenants | js 'const t = j.find(x => x.id === "gateway-railway"); if (t && t.allowed.length) console.log("  ! gateway-railway lists its routes: it needs transcribe, speak and bloom'"'"'s chat route for Railway sessions"); else if (t) console.log("  gateway-railway: every route (Railway sessions run as it here)")'

measure() { # $1 base URL, $2 key file, $3 label
  echo "→ $TURNS English turns measured ($3)"
  node "$ROOT/deploy/realtime-measure.mjs" --url "$1" --key-file "$2" --turns "$TURNS" --barge-in --json "$MUX_HOME/logs/realtime-measure-$(date +%Y%m%d-%H%M)-$3.json" || OK=
}
OK=1
if [ -n "$TEST" ]; then
  api POST /tenants/bloom-design-composer-test/keys '{"name":"realtime.sh check (one day)","expiresInDays":1}' > "$T/key.json"
  KEY_ID=$(js 'console.log(j.record.id)' < "$T/key.json"); js 'console.log(j.key)' < "$T/key.json" > "$T/key"; rm -f "$T/key.json"
  measure "$BASE" "$T/key" mac
  curl -s -o /dev/null -X DELETE -H "Authorization: Bearer $MUX_ADMIN_TOKEN" "$MUX/keys/$KEY_ID"; rm -f "$T/key"
fi

if [ -n "$RAILWAY" ]; then
  echo "→ Railway mux: deploy origin/main (it must have this change merged)"
  . "$MUX_HOME/railway.env"
  GW="${MUX_GATEWAY_URL:-https://mux-production-0b55.up.railway.app}"
  gw() { curl -sf -X "$1" -H "Authorization: Bearer $MUX_GATEWAY_ADMIN_TOKEN" -H "content-type: application/json" ${3:+-d "$3"} "$GW/api/admin$2"; }
  git -C "$ROOT" fetch -q origin main
  git -C "$ROOT" cat-file -e origin/main:server/src/realtime/server.ts 2>/dev/null || { echo "✗ origin/main has no /v1/realtime yet: merge talk-to-bloom first"; exit 1; }
  WT=$(mktemp -d /tmp/mux-deploy.XXXXXX) && rmdir "$WT"
  git -C "$ROOT" worktree add --detach "$WT" origin/main >/dev/null
  (cd "$WT" && railway up --detach -p a5bf89be-0ec9-4d3d-afcc-40226c2a86f4 -e production -s mux) || { git -C "$ROOT" worktree remove --force "$WT"; echo "✗ railway up"; exit 1; }
  git -C "$ROOT" worktree remove --force "$WT"
  i=0; until gw GET /settings | js 'process.exit(Array.isArray(j.realtimeTenants)?0:1)' 2>/dev/null; do i=$((i + 10)); [ $i -lt 900 ] || { echo "✗ the gateway has no /v1/realtime after 15 min"; exit 1; }; sleep 10; done
  echo "  ✓ Railway mux has /v1/realtime; settings.realtimeTenants: $(gw GET /settings | js 'console.log(JSON.stringify(j.realtimeTenants))')"
  if [ -n "$TEST" ]; then
    gw POST /tenants/bloom-for-business/keys '{"name":"realtime.sh check (one day)","expiresInDays":1}' > "$T/key.json"
    KEY_ID=$(js 'console.log(j.record.id)' < "$T/key.json"); js 'console.log(j.key)' < "$T/key.json" > "$T/key"; rm -f "$T/key.json"
    measure "$GW" "$T/key" railway
    curl -s -o /dev/null -X DELETE -H "Authorization: Bearer $MUX_GATEWAY_ADMIN_TOKEN" "$GW/api/admin/keys/$KEY_ID"; rm -f "$T/key"
  fi
fi
[ -n "$OK" ] || { echo "✗ a measured turn failed: see above"; exit 1; }
echo "✓ Talking to Bloom: wss://…/v1/realtime on mux (docs/realtime.md). Put the p50/p90 above into docs/realtime.md (\"Measured\")."
