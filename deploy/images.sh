#!/bin/sh
# Images on this Mac, as a mux model: FLUX.2 [klein] 4B through mflux (MLX), for LBS Studio and anyone else.
#   ./deploy/images.sh            make room, install what is missing, (re)load the agent, register model and routes
#   ./deploy/images.sh --keep     the same, without unloading any loaded model first
# What "make room" does: every loaded model that is neither pinned nor first on the agent route is unloaded
# (LBS Studio's assistant uses `agent`; pinned models are kept warm on purpose). Nothing is deleted.
# server/images/image_server.py runs on 127.0.0.1:8312 (com.mux.images) and answers /v1/images/generations and
# /v1/images/edits. It becomes the model `flux2-klein-4b` on the routes `image` and `image-edit`, which are the
# names LBS Studio asks for; a gateway that has this Mac as a node gets it as mac-studio/flux2-klein-4b.
set -eu
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
MUX_HOME="$HOME/.mux"
AGENTS="$HOME/Library/LaunchAgents"
VENV="$MUX_HOME/images-venv"
HF_CACHE="$MUX_HOME/models/hf"
MFLUX_VERSION=0.24.0
PORT=8312
. "$MUX_HOME/mux.env"
MUX="http://127.0.0.1:${MUX_PORT:-7070}/api/admin"
mkdir -p "$MUX_HOME/logs" "$HF_CACHE" "$AGENTS"

api() { curl -sf -X "$1" -H "Authorization: Bearer $MUX_ADMIN_TOKEN" -H "content-type: application/json" ${3:+-d "$3"} "$MUX$2"; }

if [ "${1:-}" != "--keep" ]; then
  echo "→ make room: unload what is loaded but not pinned and not first on the agent route"
  api GET /models > "$MUX_HOME/logs/images-models.json"
  api GET /routes > "$MUX_HOME/logs/images-routes.json"
  node -e '
    const fs = require("fs");
    const models = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    const agent = JSON.parse(fs.readFileSync(process.argv[2], "utf8")).find((r) => r.name === "agent");
    const keep = new Set([agent && agent.candidates[0]].filter(Boolean));
    for (const m of models) {
      if (!m.instance || m.backend === "node" || m.backend === "external") continue;
      const gb = m.instance.rssGb ?? m.instance.estimateGb ?? 0;
      const why = m.pinned ? "pinned" : keep.has(m.id) ? "first on agent" : "";
      console.log((why ? "keep   " : "unload ") + m.id.padEnd(32) + String(Math.round(gb * 10) / 10).padStart(6) + " GB" + (why ? "  (" + why + ")" : ""));
    }' "$MUX_HOME/logs/images-models.json" "$MUX_HOME/logs/images-routes.json" | tee "$MUX_HOME/logs/images-room.txt"
  for id in $(awk '$1 == "unload" { print $2 }' "$MUX_HOME/logs/images-room.txt"); do
    api POST "/models/$id/unload" >/dev/null && echo "  unloaded $id"
  done
fi

echo "→ mflux $MFLUX_VERSION"
PY="$(command -v python3.12 || command -v python3.11 || true)"
[ -n "$PY" ] || { echo "python 3.11 or 3.12 is needed (brew install python@3.12)"; exit 1; }
[ -x "$VENV/bin/python" ] || "$PY" -m venv "$VENV"
"$VENV/bin/python" -c "import mflux, importlib.metadata as m; assert m.version('mflux') == '$MFLUX_VERSION'" 2>/dev/null \
  || "$VENV/bin/pip" install -q "mflux==$MFLUX_VERSION"

echo "→ FLUX.2 [klein] 4B weights (~16 GB, once) into $HF_CACHE, and one load to check them"
FREE_GB=$(df -g "$HF_CACHE" | awk 'NR == 2 { print $4 }')
[ -d "$HF_CACHE/models--black-forest-labs--FLUX.2-klein-4B" ] || [ "$FREE_GB" -ge 30 ] || { echo "only $FREE_GB GB free; 30 GB wanted"; exit 1; }
HF_HUB_CACHE="$HF_CACHE" "$VENV/bin/python" "$ROOT/server/images/image_server.py" --warm

echo "→ launchd agent com.mux.images on :$PORT"
cat > "$AGENTS/com.mux.images.plist" <<PL
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.mux.images</string>
  <key>ProgramArguments</key><array><string>$VENV/bin/python</string><string>$ROOT/server/images/image_server.py</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>ProcessType</key><string>Interactive</string>
  <key>StandardOutPath</key><string>$MUX_HOME/logs/images.log</string>
  <key>StandardErrorPath</key><string>$MUX_HOME/logs/images.log</string>
  <key>EnvironmentVariables</key><dict>
    <key>PATH</key><string>/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
    <key>HF_HUB_CACHE</key><string>$HF_CACHE</string>
    <key>HF_HUB_OFFLINE</key><string>1</string>
    <key>MUX_IMAGES_PORT</key><string>$PORT</string>
  </dict>
</dict></plist>
PL
launchctl bootout "gui/$(id -u)/com.mux.images" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$AGENTS/com.mux.images.plist"
for i in $(seq 1 30); do curl -sf -o /dev/null "http://127.0.0.1:$PORT/health" && break; sleep 1; done

echo "→ model flux2-klein-4b and routes image, image-edit in mux"
MODEL='{"id":"flux2-klein-4b","display_name":"FLUX.2 [klein] 4B (images)","kind":"image","backend":"external","base_url":"http://127.0.0.1:'$PORT'/v1","upstream_model":"flux2-klein-4b","catalog_id":"flux2-klein-4b","caps":{"quality":7.5,"speed":9},"notes":"mflux, FLUX.2 klein 4B 8-bit (Apache-2.0): text to image and edits; server/images/image_server.py, com.mux.images. Loads on first use, lets go after 10 idle minutes."}'
api POST /models "$MODEL" >/dev/null 2>&1 || api PATCH /models/flux2-klein-4b "$MODEL" >/dev/null
api PUT /routes/image '{"kind":"image","strategy":"priority","candidates":["flux2-klein-4b"]}' >/dev/null
api PUT /routes/image-edit '{"kind":"image","strategy":"priority","candidates":["flux2-klein-4b"]}' >/dev/null

echo "→ a test image, straight from the image server (512x512, the first one loads the model)"
curl -sf -m 600 -H "content-type: application/json" -d '{"prompt":"A red bicycle leaning on a brick wall, soft morning light","size":"512x512","seed":7}' \
  "http://127.0.0.1:$PORT/v1/images/generations" | node -e 'let s="";process.stdin.on("data",(d)=>s+=d).on("end",()=>{require("fs").writeFileSync(process.argv[1],Buffer.from(JSON.parse(s).data[0].b64_json,"base64"))})' "$MUX_HOME/logs/images-test.png" \
  && echo "  wrote $MUX_HOME/logs/images-test.png"
echo "✓ images: flux2-klein-4b on :$PORT — POST /v1/images/generations and /v1/images/edits on mux (routes image, image-edit)"
