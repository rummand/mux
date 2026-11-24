#!/bin/sh
# Inkling 2 Mini on this Mac (owner, 2026-11-24: "Install and load https://huggingface.co/blog/inkling2mini"). Safe to run again.
#   ./deploy/inkling.sh        fetch llama.cpp's nightly and the weights if missing, register the model, load it and
#                              ask it one text and one image question
# Model: thinkingmachines/Inkling-2-Mini (Apache-2.0; Thinking Machines' Acceptable Use Policy applies), a looped MoE:
# 26.4 B total, 3.4 B active, layers 6–17 run three times per token; text and image in, text out; up to 1M context.
# ggml-org's IQ4_NL GGUF (17.6 GB, experts of layers 0–19 at IQ4_NL, the rest Q8_0) and its BF16 vision projector.
# Its architecture (inkling2_loop, llama.cpp #32694, merged 2026-11-20) is newer than Homebrew's llama.cpp 1.0.0, so this
# model alone runs on a nightly in ~/.mux/llama.cpp/ (the model's server_bin); every other model keeps Homebrew's.
# No route sends to it yet: that is the owner's call once it is measured. Terms and numbers: docs/inkling.md.
set -eu
MUX_HOME="$HOME/.mux"
BUILD=b12678
BIN="$MUX_HOME/llama.cpp/$BUILD/llama-$BUILD/llama-server"
DIR="$MUX_HOME/models/ggml-org--Inkling-2-Mini-GGUF"
FILE=Inkling-2-Mini-IQ4_NL.gguf
MMPROJ=mmproj-Inkling-2-Mini-BF16.gguf
ID=inkling-2-mini
HF="$MUX_HOME/images-venv/bin/hf"
. "$MUX_HOME/mux.env"
PORT="${MUX_PORT:-7070}"
MUX="http://127.0.0.1:$PORT/api/admin"
api() { curl -sf -X "$1" -H "Authorization: Bearer $MUX_ADMIN_TOKEN" -H "content-type: application/json" ${3:+-d "$3"} "$MUX$2"; }

echo "→ llama.cpp $BUILD (for this model only)"
if [ ! -x "$BIN" ]; then
  mkdir -p "$MUX_HOME/llama.cpp/$BUILD"
  curl -sfL "https://github.com/ggml-org/llama.cpp/releases/download/$BUILD/llama-$BUILD-bin-macos-arm64.tar.gz" | tar xz -C "$MUX_HOME/llama.cpp/$BUILD"
  xattr -dr com.apple.quarantine "$MUX_HOME/llama.cpp/$BUILD" 2>/dev/null || true
fi
"$BIN" --version 2>&1 | grep -q "build ${BUILD#b}" || { echo "✗ $BIN does not run"; exit 1; }

echo "→ weights: $FILE + $MMPROJ (18.3 GB once)"
mkdir -p "$DIR"
[ -f "$DIR/$FILE" ] && [ -f "$DIR/$MMPROJ" ] || "$HF" download ggml-org/Inkling-2-Mini-GGUF "$FILE" "$MMPROJ" --local-dir "$DIR"
SIZE=$(stat -f %z "$DIR/$FILE")

echo "→ model $ID"
MODEL='{"id":"'$ID'","display_name":"Inkling 2 Mini 26B-A3B looped (IQ4_NL)","kind":"chat","backend":"llamacpp","path":"'$DIR/$FILE'","mmproj":"'$DIR/$MMPROJ'","server_bin":"'$BIN'","size_bytes":'$SIZE',"ctx":131072,"parallel":2,"reasoning":"auto","pinned":false,"extra_args":["--reasoning-effort","medium","--cache-ram","1024"],"caps":{"quality":7.5,"code":7,"tools":7.5,"speed":6,"reasoning":8,"multilingual":6,"vision":7,"context":9},"notes":"thinkingmachines/Inkling-2-Mini (Apache-2.0 + Thinking Machines AUP), ggml-org IQ4_NL + BF16 mmproj, on llama.cpp '$BUILD' (server_bin). Reasoning effort medium by default (the model card warns of long reasoning loops). No route yet. deploy/inkling.sh, docs/inkling.md"}'
api POST /models "$MODEL" >/dev/null 2>&1 || api PATCH "/models/$ID" "$MODEL" >/dev/null
echo "→ loading (unloads idle models if it needs the room)"
T0=$(date +%s)
OUT=$(curl -s -m 300 -X POST -H "Authorization: Bearer $MUX_ADMIN_TOKEN" "$MUX/models/$ID/load") || true
echo "$OUT" | grep -q '"ok":true' || { echo "✗ load failed: ${OUT:-no answer} (log: ~/.mux/logs/models/$ID.log)"; exit 1; }
echo "✓ loaded in $(( $(date +%s) - T0 )) s"

echo "→ test questions, with a one-day key of mux's own tenant assistant (revoked after)"
T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
api POST /tenants/assistant/keys '{"name":"inkling.sh check (one day)","expiresInDays":1}' > "$T/key.json"
KEY_ID=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["record"]["id"])' "$T/key.json")
python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["key"])' "$T/key.json" > "$T/key"; rm -f "$T/key.json"
ask() { curl -s --max-time 300 -H "Authorization: Bearer $(cat "$T/key")" -H "content-type: application/json" "http://127.0.0.1:$PORT/v1/chat/completions" -d "$1" \
  | python3 -c 'import json,sys; r=json.load(sys.stdin); m=r["choices"][0]["message"]; print("  →", (m.get("content") or "").strip()[:200].replace("\n"," ") or m.get("tool_calls"), "|", r["usage"]["completion_tokens"], "tokens")'; }
ask '{"model":"'$ID'","max_tokens":2000,"reasoning_effort":"low","messages":[{"role":"user","content":"What is the capital of Denmark? One word."}]}' || FAIL=1
ask '{"model":"'$ID'","max_tokens":2000,"reasoning_effort":"low","messages":[{"role":"user","content":[{"type":"text","text":"What colour is this image? One word."},{"type":"image_url","image_url":{"url":"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAEklEQVR4nGP4z8CAFWEXHbQSACj/P8Fu7N9hAAAAAElFTkSuQmCC"}}]}]}' || FAIL=1
ask '{"model":"'$ID'","max_tokens":1500,"reasoning_effort":"low","tools":[{"type":"function","function":{"name":"get_weather","description":"Weather for a city","parameters":{"type":"object","properties":{"city":{"type":"string"}},"required":["city"]}}}],"messages":[{"role":"user","content":"What is the weather in Aarhus?"}]}' || FAIL=1
echo "  key revoked: $(curl -s -o /dev/null -w '%{http_code}' -X DELETE -H "Authorization: Bearer $MUX_ADMIN_TOKEN" "$MUX/keys/$KEY_ID"), then it answers $(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $(cat "$T/key")" "http://127.0.0.1:$PORT/v1/models")"
[ -z "${FAIL:-}" ] || { echo "✗ a test question failed (log: ~/.mux/logs/models/$ID.log)"; exit 1; }
echo "✓ $ID answers on this Mac (no route sends to it; Railway lists it as mac-studio/$ID)"
