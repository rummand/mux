#!/bin/sh
# Haru-4B on this Mac, the duplex trial behind /v1/realtime (model "haru-4b"; docs/haru.md, docs/realtime.md).
#   ./deploy/haru.sh               haru_mlx (Apache-2.0, higurashi) in ~/.mux/haru-venv, the weights (~10 GB,
#                                  higurashi-ai/Haru-4B), a voice clip in Bloom's voice (Kokoro af_heart through mux's
#                                  speak route, ~25 s), the headless server server/realtime/haru_server.py as launchd
#                                  agent com.mux.haru on 127.0.0.1:8327 (8-bit; it loads on the first session and exits
#                                  after 15 idle minutes), the model haru-4b (kind realtime) on the route realtime, and a
#                                  health check
#   ./deploy/haru.sh --forced-text the deciding test after that: can Haru say a sentence an LLM wrote?
#                                  (server/realtime/haru_forced_text.py; prints WER per mode and PASS/FAIL)
#   ./deploy/haru.sh --bf16        the published bfloat16 weights instead of 8-bit
#   ./deploy/haru.sh --measure     5 English turns through /v1/realtime with model haru-4b (deploy/realtime-measure.mjs)
# The owner's feel test is Haru's own macOS app (haru_mlx/swift/build_app.sh in the Haru repo, wired headset): this
# script does not need it. Only voices we have the rights to: the clip is Kokoro's af_heart (Apache-2.0).
set -eu
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
MUX_HOME="$HOME/.mux"
AGENTS="$HOME/Library/LaunchAgents"
VENV="$MUX_HOME/haru-venv"
DIR="$MUX_HOME/haru"
PORT=8327
MODEL_ID=haru-4b
REPO=higurashi-ai/Haru-4B
PIP_PINS="haru-speech-mlx==0.1.0 websockets>=14,<16 scipy numpy"
QUANT=8 FORCED= MEASURE=
for a in "$@"; do case "$a" in --forced-text) FORCED=1 ;; --bf16) QUANT=none ;; --measure) MEASURE=1 ;; *) echo "unknown flag $a"; exit 2 ;; esac; done
[ "$(uname -s)" = Darwin ] && [ "$(uname -m)" = arm64 ] || { echo "Run this on the Mac (Apple Silicon: MLX)."; exit 2; }
. "$MUX_HOME/mux.env"
BASE="http://127.0.0.1:${MUX_PORT:-7070}"
MUX="$BASE/api/admin"
api() { curl -sf -X "$1" -H "Authorization: Bearer $MUX_ADMIN_TOKEN" -H "content-type: application/json" ${3:+-d "$3"} "$MUX$2"; }
js() { node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const j=JSON.parse(s);$1})"; }
mkdir -p "$MUX_HOME/logs" "$DIR" "$AGENTS"
T=$(mktemp -d /tmp/mux-haru.XXXXXX); trap 'rm -rf "$T"' EXIT
api GET /settings | js 'process.exit(Array.isArray(j.realtimeTenants)?0:1)' || {
  echo "✗ mux on this Mac has no /v1/realtime yet: git pull --ff-only && npm ci && npm run build && launchctl kickstart -k gui/\$(id -u)/com.mux.server"; exit 1; }
FREE_GB=$(df -g "$MUX_HOME" | awk 'NR == 2 { print $4 }')
[ -d "$HOME/.cache/huggingface/hub/models--higurashi-ai--Haru-4B" ] || [ "$FREE_GB" -ge 20 ] || { echo "only $FREE_GB GB free on disk; 20 GB wanted (weights ~10 GB)"; exit 1; }

echo "→ haru_mlx in $VENV"
PY="$(command -v python3.12 || command -v python3.11 || true)"
[ -n "$PY" ] || { echo "python 3.11 or 3.12 is needed (brew install python@3.12)"; exit 1; }
[ -x "$VENV/bin/python" ] || "$PY" -m venv "$VENV"
if [ "$(cat "$VENV/.mux-pins" 2>/dev/null || true)" != "$PIP_PINS" ]; then
  "$VENV/bin/pip" install -q --upgrade pip
  # shellcheck disable=SC2086
  "$VENV/bin/pip" install -q $PIP_PINS || "$VENV/bin/pip" install -q "haru-speech-mlx @ git+https://github.com/higurashi-ai/Haru#subdirectory=haru_mlx" websockets scipy numpy
  echo "$PIP_PINS" > "$VENV/.mux-pins"
fi

echo "→ weights: $REPO (~10 GB)"
"$VENV/bin/python" -c 'import sys; from huggingface_hub import snapshot_download; print("  " + snapshot_download(sys.argv[1]))' "$REPO"

KEY_ID=
key() { # a one-day key of bloom's test tenant on this Mac, for the voice clip and the tests
  [ -s "$T/key" ] && return 0
  api POST /tenants/bloom-design-composer-test/keys '{"name":"haru.sh (one day)","expiresInDays":1}' > "$T/key.json"
  KEY_ID=$(js 'console.log(j.record.id)' < "$T/key.json"); js 'console.log(j.key)' < "$T/key.json" > "$T/key"; rm -f "$T/key.json"
}
revoke() { [ -n "$KEY_ID" ] && curl -s -o /dev/null -X DELETE -H "Authorization: Bearer $MUX_ADMIN_TOKEN" "$MUX/keys/$KEY_ID"; KEY_ID=; rm -f "$T/key"; }

if [ ! -s "$DIR/voice-en.wav" ]; then
  echo "→ the voice clip: Kokoro af_heart through mux's speak route → $DIR/voice-en.wav"
  key
  code=$(curl -s -m 180 -o "$DIR/voice-en.wav" -w '%{http_code}' "$BASE/v1/audio/speech" -H "Authorization: Bearer $(cat "$T/key")" -H "content-type: application/json" \
    -d '{"model":"speak","voice":"af_heart","response_format":"wav","input":"Hello, I am Bloom. I help small businesses keep track of their customers, their invoices and their day. When you ask me something, I listen first, and then I answer as clearly as I can. If I am not sure, I will say so, and I will tell you what I would need to find out. Shall we look at what is on your desk today?"}')
  [ "$code" = 200 ] || { rm -f "$DIR/voice-en.wav"; echo "✗ speak answered $code: run deploy/speech-en.sh first"; exit 1; }
fi

echo "→ launchd agent com.mux.haru on :$PORT (quantize $QUANT)"
cat > "$AGENTS/com.mux.haru.plist" <<PL
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.mux.haru</string>
  <key>ProgramArguments</key><array><string>$VENV/bin/python</string><string>$ROOT/server/realtime/haru_server.py</string>
    <string>--port</string><string>$PORT</string><string>--quantize</string><string>$QUANT</string><string>--voice</string><string>$DIR/voice-en.wav</string></array>
  <key>WorkingDirectory</key><string>$DIR</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>ProcessType</key><string>Interactive</string>
  <key>StandardOutPath</key><string>$MUX_HOME/logs/haru.log</string>
  <key>StandardErrorPath</key><string>$MUX_HOME/logs/haru.log</string>
  <key>EnvironmentVariables</key><dict><key>HF_HUB_OFFLINE</key><string>1</string></dict>
</dict></plist>
PL
launchctl bootout "gui/$(id -u)/com.mux.haru" 2>/dev/null || true
i=0; while launchctl print "gui/$(id -u)/com.mux.haru" >/dev/null 2>&1; do i=$((i + 1)); [ $i -lt 20 ] || break; sleep 0.5; done
launchctl bootstrap "gui/$(id -u)" "$AGENTS/com.mux.haru.plist"
for i in $(seq 1 60); do curl -sf -o /dev/null "http://127.0.0.1:$PORT/health" && break; sleep 1; done
curl -sf "http://127.0.0.1:$PORT/v1/models" | js 'const m=j.data[0];console.log(`  ✓ ${m.id}: loaded ${m.loaded}, needs ${m.need_gb} GB free to load`)' || { echo "✗ Haru's server is not up: see $MUX_HOME/logs/haru.log"; exit 1; }

echo "→ model $MODEL_ID (kind realtime) on the route realtime"
SIZE=$([ "$QUANT" = 8 ] && echo 6000000000 || echo 11000000000)
M=$(node -e 'console.log(JSON.stringify({id:"haru-4b",display_name:"Haru-4B (full duplex, MLX)",kind:"realtime",backend:"external",base_url:"http://127.0.0.1:"+process.argv[1]+"/v1",upstream_model:"haru-4b",size_bytes:Number(process.argv[2]),caps:{quality:3,speed:10},notes:"higurashi-ai/Haru-4B (Apache-2.0): full-duplex speech-to-speech base model, Qwen3.5-4B backbone, 133 ms frames, 24 kHz. No tools; not an assistant (a base model: not a reliable source of facts). English among 9 languages; no Danish. server/realtime/haru_server.py, com.mux.haru; forced text is experimental (haru_forced.py). docs/haru.md."}))' "$PORT" "$SIZE")
api POST /models "$M" >/dev/null 2>&1 || api PATCH "/models/$MODEL_ID" "$M" >/dev/null
api GET /routes | js 'const r=j.find(x=>x.name==="realtime");const c=r?r.candidates:[];if(!c.includes("haru-4b"))c.push("haru-4b");console.log(JSON.stringify({kind:"realtime",strategy:"priority",candidates:c}))' > "$T/route.json"
api PUT /routes/realtime "$(cat "$T/route.json")" >/dev/null && echo "  realtime: $(js 'console.log(j.candidates.join(" → "))' < "$T/route.json")"
api GET /tenants | js 'for (const t of j) if (t.id === "bloom-design-composer-test" && t.allowed.length) { const add = ["realtime","haru-4b"].filter(r => !t.allowed.includes(r)); if (add.length) console.log(JSON.stringify({ allowed: [...t.allowed, ...add] })); }' > "$T/tenant.json"
if [ -s "$T/tenant.json" ]; then api PUT /tenants/bloom-design-composer-test "$(cat "$T/tenant.json")" >/dev/null && echo "  bloom-design-composer-test: realtime, haru-4b allowed"; fi

if [ -n "$FORCED" ]; then
  echo "→ the forced-text experiment (loads its own copy of Haru: ~6 GB more while it runs)"
  key
  MUX_KEY="$(cat "$T/key")" MUX_URL="$BASE" "$VENV/bin/python" "$ROOT/server/realtime/haru_forced_text.py" --quantize "$QUANT" --voice "$DIR/voice-en.wav" | tee "$MUX_HOME/logs/haru-forced-text.log" || true
  echo "  the takes are in $DIR/forced/; the result in $MUX_HOME/logs/haru-forced-text.log — put it in docs/haru.md"
fi
if [ -n "$MEASURE" ]; then
  key
  node "$ROOT/deploy/realtime-measure.mjs" --url "$BASE" --key-file "$T/key" --turns 5 --engine haru-4b --hearing energy --json "$MUX_HOME/logs/realtime-measure-haru.json" || true
fi
revoke
echo "✓ Haru-4B: /v1/realtime with {\"type\":\"session.start\",\"model\":\"haru-4b\"} (a trial: no tools)"
