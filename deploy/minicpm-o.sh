#!/bin/sh
# MiniCPM-o 4.5 full duplex on this Mac, a trial behind /v1/realtime (model "minicpm-o-4.5"; docs/minicpm-o.md).
#   ./deploy/minicpm-o.sh            llama.cpp-omni (MIT, branch feat/web-demo, Metal) built in ~/.mux/minicpm-o,
#                                    the GGUFs (openbmb/MiniCPM-o-4_5-gguf: LLM Q4_K_M + audio, vision, TTS, Token2Wav,
#                                    ~8.3 GB), the official demo's worker (OpenBMB/MiniCPM-o-Demo, branch Comni) with
#                                    its venv and a config for the C++ backend, the wrapper
#                                    server/realtime/minicpm_o_server.py as launchd agent com.mux.minicpm-o on
#                                    127.0.0.1:8322 (it starts the worker on the first session and stops it after 15
#                                    idle minutes), the model minicpm-o-4.5 (kind realtime) on the route realtime
#   ./deploy/minicpm-o.sh --measure  then 5 English turns through /v1/realtime with it (deploy/realtime-measure.mjs)
# Memory: the CookBook gives ~10 GB at runtime for Q4_K_M; mux admits a session only with --need-gb (14) free
# (the memory floor). Speed: the CookBook says duplex needs an M4 Pro/Max and that "M1/M2/M3 chips lack the bandwidth
# and compute power needed for real-time duplex streaming"; this Mac is an M3 Ultra, so real time is unproven here.
set -eu
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
MUX_HOME="$HOME/.mux"
AGENTS="$HOME/Library/LaunchAgents"
DIR="$MUX_HOME/minicpm-o"
PORT=8322
WORKER_PORT=22440
CPP_PORT=19080
MODEL_ID=minicpm-o-4.5
GGUF_REPO=openbmb/MiniCPM-o-4_5-gguf
MEASURE=
for a in "$@"; do case "$a" in --measure) MEASURE=1 ;; *) echo "unknown flag $a"; exit 2 ;; esac; done
[ "$(uname -s)" = Darwin ] && [ "$(uname -m)" = arm64 ] || { echo "Run this on the Mac (Apple Silicon: Metal)."; exit 2; }
. "$MUX_HOME/mux.env"
BASE="http://127.0.0.1:${MUX_PORT:-7070}"
MUX="$BASE/api/admin"
api() { curl -sf -X "$1" -H "Authorization: Bearer $MUX_ADMIN_TOKEN" -H "content-type: application/json" ${3:+-d "$3"} "$MUX$2"; }
js() { node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const j=JSON.parse(s);$1})"; }
mkdir -p "$MUX_HOME/logs" "$DIR" "$AGENTS"
T=$(mktemp -d /tmp/mux-minicpm.XXXXXX); trap 'rm -rf "$T"' EXIT
api GET /settings | js 'process.exit(Array.isArray(j.realtimeTenants)?0:1)' || {
  echo "✗ mux on this Mac has no /v1/realtime yet: git pull --ff-only && npm ci && npm run build && launchctl kickstart -k gui/\$(id -u)/com.mux.server"; exit 1; }
FREE_GB=$(df -g "$MUX_HOME" | awk 'NR == 2 { print $4 }')
[ -d "$DIR/gguf" ] || [ "$FREE_GB" -ge 25 ] || { echo "only $FREE_GB GB free on disk; 25 GB wanted (GGUFs ~8.3 GB, the build, PyTorch for the worker's venv)"; exit 1; }
command -v cmake >/dev/null || HOMEBREW_NO_AUTO_UPDATE=1 brew install cmake

echo "→ llama.cpp-omni (feat/web-demo) in $DIR/llama.cpp-omni"
[ -d "$DIR/llama.cpp-omni/.git" ] || git clone -q https://github.com/tc-mb/llama.cpp-omni.git "$DIR/llama.cpp-omni"
git -C "$DIR/llama.cpp-omni" fetch -q origin feat/web-demo && git -C "$DIR/llama.cpp-omni" checkout -q FETCH_HEAD
echo "  at $(git -C "$DIR/llama.cpp-omni" rev-parse --short HEAD)"
(cd "$DIR/llama.cpp-omni" && cmake -B build -DCMAKE_BUILD_TYPE=Release >/dev/null && cmake --build build --target llama-omni-server --target llama-omni-cli -j >/dev/null)
# The Comni worker runs build/bin/llama-server (its README); the target is llama-omni-server: give it both names
[ -x "$DIR/llama.cpp-omni/build/bin/llama-server" ] || ln -sf llama-omni-server "$DIR/llama.cpp-omni/build/bin/llama-server"

echo "→ GGUFs from $GGUF_REPO (~8.3 GB)"
PY="$(command -v python3.11 || command -v python3.12 || true)"
[ -n "$PY" ] || { echo "python 3.11 or 3.12 is needed (brew install python@3.11)"; exit 1; }
[ -x "$DIR/hf-venv/bin/python" ] || "$PY" -m venv "$DIR/hf-venv"
"$DIR/hf-venv/bin/pip" install -q huggingface_hub
"$DIR/hf-venv/bin/python" -c 'import sys; from huggingface_hub import snapshot_download; snapshot_download(sys.argv[1], local_dir=sys.argv[2], allow_patterns=["MiniCPM-o-4_5-Q4_K_M.gguf","audio/*","vision/*","tts/*","token2wav-gguf/*"])' "$GGUF_REPO" "$DIR/gguf"
ls "$DIR/gguf/MiniCPM-o-4_5-Q4_K_M.gguf" "$DIR/gguf/token2wav-gguf/prompt_cache.gguf" >/dev/null || { echo "✗ the GGUF set is incomplete in $DIR/gguf (compare with the CookBook's list)"; exit 1; }

echo "→ the demo's worker (OpenBMB/MiniCPM-o-Demo, Comni) in $DIR/demo"
[ -d "$DIR/demo/.git" ] || git clone -q https://github.com/OpenBMB/MiniCPM-o-Demo.git "$DIR/demo"
git -C "$DIR/demo" fetch -q origin Comni && git -C "$DIR/demo" checkout -q FETCH_HEAD
echo "  at $(git -C "$DIR/demo" rev-parse --short HEAD)"
[ -x "$DIR/demo/.venv/base/bin/python" ] || (cd "$DIR/demo" && PYTHON="$PY" bash install.sh)
"$DIR/demo/.venv/base/bin/pip" install -q "websockets>=14,<16"
node -e 'const [,root,gguf,cpp,wp]=process.argv; console.log(JSON.stringify({backend:"cpp",cpp_backend:{llamacpp_root:root,model_dir:gguf,llm_model:"MiniCPM-o-4_5-Q4_K_M.gguf",cpp_server_port:Number(cpp),ctx_size:8192,n_gpu_layers:99},audio:{playback_delay_ms:200},service:{gateway_port:8040,worker_base_port:Number(wp),num_workers:1,max_queue_size:10,request_timeout:300.0,data_dir:"data"},duplex:{pause_timeout:60.0},recording:{enabled:false}},null,2))' \
  "$DIR/llama.cpp-omni" "$DIR/gguf" "$CPP_PORT" "$WORKER_PORT" > "$DIR/demo/config.json"

echo "→ launchd agent com.mux.minicpm-o on :$PORT"
cat > "$AGENTS/com.mux.minicpm-o.plist" <<PL
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.mux.minicpm-o</string>
  <key>ProgramArguments</key><array><string>$DIR/demo/.venv/base/bin/python</string><string>$ROOT/server/realtime/minicpm_o_server.py</string>
    <string>--port</string><string>$PORT</string><string>--demo</string><string>$DIR/demo</string><string>--worker-port</string><string>$WORKER_PORT</string></array>
  <key>WorkingDirectory</key><string>$DIR</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>ProcessType</key><string>Interactive</string>
  <key>StandardOutPath</key><string>$MUX_HOME/logs/minicpm-o.log</string>
  <key>StandardErrorPath</key><string>$MUX_HOME/logs/minicpm-o.log</string>
</dict></plist>
PL
launchctl bootout "gui/$(id -u)/com.mux.minicpm-o" 2>/dev/null || true
i=0; while launchctl print "gui/$(id -u)/com.mux.minicpm-o" >/dev/null 2>&1; do i=$((i + 1)); [ $i -lt 20 ] || break; sleep 0.5; done
launchctl bootstrap "gui/$(id -u)" "$AGENTS/com.mux.minicpm-o.plist"
for i in $(seq 1 30); do curl -sf -o /dev/null "http://127.0.0.1:$PORT/health" && break; sleep 1; done
curl -sf "http://127.0.0.1:$PORT/v1/models" | js 'const m=j.data[0];console.log(`  ✓ ${m.id}: loaded ${m.loaded}, needs ${m.need_gb} GB free to load`)' || { echo "✗ the wrapper is not up: see $MUX_HOME/logs/minicpm-o.log"; exit 1; }

echo "→ model $MODEL_ID (kind realtime) on the route realtime"
M=$(node -e 'console.log(JSON.stringify({id:"minicpm-o-4.5",display_name:"MiniCPM-o 4.5 (full duplex, llama.cpp-omni)",kind:"realtime",backend:"external",base_url:"http://127.0.0.1:"+process.argv[1]+"/v1",upstream_model:"minicpm-o-4.5",size_bytes:10000000000,caps:{quality:6,speed:6},notes:"openbmb/MiniCPM-o-4_5 (Apache-2.0), 9B (Qwen3-8B + SigLip2 + Whisper-medium + CosyVoice2), GGUF Q4_K_M through llama.cpp-omni (MIT) and the Comni demo worker (no licence file found; run unmodified, not redistributed). Full duplex, English and Chinese speech; tools not stated. Real time on an M3 Ultra unproven (the CookBook names M4 Pro/Max). server/realtime/minicpm_o_server.py, com.mux.minicpm-o. docs/minicpm-o.md."}))' "$PORT")
api POST /models "$M" >/dev/null 2>&1 || api PATCH "/models/$MODEL_ID" "$M" >/dev/null
api GET /routes | js 'const r=j.find(x=>x.name==="realtime");const c=r?r.candidates:[];if(!c.includes("minicpm-o-4.5"))c.push("minicpm-o-4.5");console.log(JSON.stringify({kind:"realtime",strategy:"priority",candidates:c}))' > "$T/route.json"
api PUT /routes/realtime "$(cat "$T/route.json")" >/dev/null && echo "  realtime: $(js 'console.log(j.candidates.join(" → "))' < "$T/route.json")"
api GET /tenants | js 'for (const t of j) if (t.id === "bloom-design-composer-test" && t.allowed.length) { const add = ["realtime","minicpm-o-4.5"].filter(r => !t.allowed.includes(r)); if (add.length) console.log(JSON.stringify({ allowed: [...t.allowed, ...add] })); }' > "$T/tenant.json"
if [ -s "$T/tenant.json" ]; then api PUT /tenants/bloom-design-composer-test "$(cat "$T/tenant.json")" >/dev/null && echo "  bloom-design-composer-test: realtime, minicpm-o-4.5 allowed"; fi

if [ -n "$MEASURE" ]; then
  api POST /tenants/bloom-design-composer-test/keys '{"name":"minicpm-o.sh (one day)","expiresInDays":1}' > "$T/key.json"
  KEY_ID=$(js 'console.log(j.record.id)' < "$T/key.json"); js 'console.log(j.key)' < "$T/key.json" > "$T/key"; rm -f "$T/key.json"
  node "$ROOT/deploy/realtime-measure.mjs" --url "$BASE" --key-file "$T/key" --turns 5 --engine minicpm-o-4.5 --hearing energy --json "$MUX_HOME/logs/realtime-measure-minicpm-o.json" || true
  curl -s -o /dev/null -X DELETE -H "Authorization: Bearer $MUX_ADMIN_TOKEN" "$MUX/keys/$KEY_ID"; rm -f "$T/key"
  echo "  the worker's own per-chunk timings (SPEAK/LISTEN wall=… ms; real time needs < 1000 per 1 s chunk): $MUX_HOME/logs/minicpm-o-worker.log"
fi
echo "✓ MiniCPM-o 4.5: /v1/realtime with {\"type\":\"session.start\",\"model\":\"minicpm-o-4.5\"} (a trial)"
