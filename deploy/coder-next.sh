#!/bin/sh
# Qwen3-Coder-Next as the main model for `agent` and `code`, and OpenCode on it (owner, 2026-11-20). Safe to run again.
#   ./deploy/coder-next.sh            fetch the weights if missing, register the model, set the routes here and on
#                                     Railway mux, and point OpenCode (com.mux.opencode) at this mux
# Model: Qwen/Qwen3-Coder-Next (80 B total, 3 B active, hybrid attention, 256K context, Apache-2.0), unsloth's
# UD-Q4_K_XL GGUF (49.6 GB) — the strongest coding model that fits this Mac; nothing local is close to a frontier model.
# Measured 2026-11-20: weights 46.2 GiB, context cache 1.6 GiB at 128K with 8-bit KV (only 12 of 48 layers use full
# attention), so caps.memGb 50 replaces mux's formula (which counted 58 and never let it load). It and qwen3.6 still do
# not fit together (50 + 36 of a 70 GB budget), and a pinned model is never unloaded, so neither is pinned: mux keeps the
# one in use and swaps (13–17 s each way, measured). 64 tokens/s; tool calls work.
# 2026-11-25 (owner): 262K context in one pool both slots share (+~1.6 GB, so memGb 52) and ngram speculation
# (copies from the context: code edits 3-4x faster, output unchanged; docs/speed.md).
# Routes: agent and code → qwen3-coder-next, then qwen3.6; vision, multilingual and smart keep qwen3.6 first.
# OpenCode: provider `mux` on http://127.0.0.1:7070/v1 with the tenant `opencode` (data border own) and its key in
# ~/.config/opencode/mux-opencode.key (make it with MUX_TARGET=mac ./deploy/tenant.sh opencode …; never in the repo).
set -eu
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
MUX_HOME="$HOME/.mux"
DIR="$MUX_HOME/models/unsloth--Qwen3-Coder-Next-GGUF"
FILE=Qwen3-Coder-Next-UD-Q4_K_XL.gguf
ID=qwen3-coder-next
HF="$MUX_HOME/images-venv/bin/hf"
. "$MUX_HOME/mux.env"
MUX="http://127.0.0.1:${MUX_PORT:-7070}/api/admin"
api() { curl -sf -X "$1" -H "Authorization: Bearer $MUX_ADMIN_TOKEN" -H "content-type: application/json" ${3:+-d "$3"} "$MUX$2"; }

echo "→ weights: $FILE (49.6 GB once)"
mkdir -p "$DIR"
[ -f "$DIR/$FILE" ] || "$HF" download unsloth/Qwen3-Coder-Next-GGUF "$FILE" --local-dir "$DIR"
SIZE=$(stat -f %z "$DIR/$FILE")

echo "→ model $ID"
MODEL='{"id":"'$ID'","display_name":"Qwen3-Coder-Next 80B-A3B (UD-Q4_K_XL)","kind":"chat","backend":"llamacpp","path":"'$DIR/$FILE'","size_bytes":'$SIZE',"ctx":262144,"parallel":2,"reasoning":"off","pinned":false,"extra_args":["--kv-unified","--cache-type-k","q8_0","--cache-type-v","q8_0","--cache-ram","1024","--spec-type","ngram-simple","--spec-draft-n-max","16"],"caps":{"quality":8,"code":9.5,"tools":9,"speed":8,"reasoning":7,"multilingual":6,"context":9,"memGb":52},"notes":"Qwen/Qwen3-Coder-Next (Apache-2.0), unsloth UD-Q4_K_XL: the main model for agent and code (owner, 2026-11-20). Not pinned: it and qwen3.6 swap. deploy/coder-next.sh"}'
api POST /models "$MODEL" >/dev/null 2>&1 || api PATCH "/models/$ID" "$MODEL" >/dev/null
api PATCH /models/qwen3.6-35b-a3b '{"pinned":false}' >/dev/null
api PUT /routes/agent '{"candidates":["'$ID'","qwen3.6-35b-a3b","qwen3.5-0.8b"]}' >/dev/null
api PUT /routes/code '{"candidates":["'$ID'","qwen3.6-35b-a3b"]}' >/dev/null
echo "✓ this Mac: agent and code → $ID → qwen3.6 (qwen3.6 unpinned)"

echo "→ Railway mux"
. "$MUX_HOME/railway.env"
gw() { curl -sf -X "$1" -H "Authorization: Bearer $MUX_GATEWAY_ADMIN_TOKEN" -H "content-type: application/json" ${3:+-d "$3"} "$MUX_GATEWAY_URL/api/admin$2"; }
for i in $(seq 1 30); do gw GET /models | grep -q "\"mac-studio/$ID\"" && break; sleep 5; done
if gw GET /models | grep -q "\"mac-studio/$ID\""; then
  for r in agent code; do
    CUR=$(gw GET /routes | python3 -c 'import json,sys; r=[x for x in json.load(sys.stdin) if x["name"]==sys.argv[1]]; print(json.dumps(r[0]["candidates"] if r else []))' "$r")
    NEW=$(python3 -c 'import json,sys; c=[x for x in json.loads(sys.argv[1]) if x!=sys.argv[2]]; print(json.dumps({"candidates":[sys.argv[2]]+c}))' "$CUR" "mac-studio/$ID")
    gw PUT "/routes/$r" "$NEW" >/dev/null && echo "✓ Railway $r: mac-studio/$ID first"
  done
else
  echo "✗ Railway has not synced mac-studio/$ID yet: run again in a minute"
fi

echo "→ OpenCode on this mux"
OC="$HOME/.config/opencode"
[ -s "$OC/mux-opencode.key" ] || { echo "✗ no $OC/mux-opencode.key: make the tenant opencode and its key first"; exit 1; }
[ -f "$OC/opencode.json" ] && ! grep -q '"mux"' "$OC/opencode.json" && cp "$OC/opencode.json" "$OC/opencode.json.bak-$(date +%Y%m%d)"
cat > "$OC/opencode.json" <<'JSON'
{
  "$schema": "https://opencode.ai/config.json",
  "provider": {
    "mux": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "mux (this Mac)",
      "options": { "baseURL": "http://127.0.0.1:7070/v1", "apiKey": "{file:~/.config/opencode/mux-opencode.key}" },
      "models": {
        "code": { "name": "Code — Qwen3-Coder-Next (mux route)", "tool_call": true, "limit": { "context": 262144, "output": 32768 } },
        "agent": { "name": "Agent — Qwen3-Coder-Next (mux route)", "tool_call": true, "limit": { "context": 262144, "output": 32768 } },
        "smart": { "name": "Smart — qwen3.6 (mux route)", "tool_call": true, "limit": { "context": 262144, "output": 16384 } },
        "fast": { "name": "Fast — small model (mux route)", "tool_call": true, "limit": { "context": 32768, "output": 4096 } }
      }
    }
  },
  "model": "mux/code",
  "small_model": "mux/code"
}
JSON
launchctl kickstart -k "gui/$(id -u)/com.mux.opencode" 2>/dev/null || true
echo "✓ OpenCode: mux/code (Qwen3-Coder-Next), restarted"
