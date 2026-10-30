#!/bin/sh
# Speech on this Mac, as mux models: Whisper (speech to text) and Piper (text to speech), both open source.
#   ./deploy/audio.sh      install what is missing, (re)load the agents, register the models and routes
# whisper.cpp's whisper-server on 127.0.0.1:8310 (com.mux.whisper), large-v3-turbo q5_0 — good Danish;
# server/tts/piper_server.py on 127.0.0.1:8311 (com.mux.tts), the Danish voice da_DK-talesyntese-medium (CC0).
# They become the models `whisper` (route transcribe) and `piper-da` (route speak); a gateway that has this Mac
# as a node gets them as mac-studio/whisper and mac-studio/piper-da on its next sync.
set -eu
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
MUX_HOME="$HOME/.mux"
AGENTS="$HOME/Library/LaunchAgents"
WHISPER_MODEL="$MUX_HOME/models/whisper/ggml-large-v3-turbo-q5_0.bin"
PIPER_DIR="$MUX_HOME/models/piper"
VOICE=da_DK-talesyntese-medium
. "$MUX_HOME/mux.env"
mkdir -p "$MUX_HOME/logs" "$(dirname "$WHISPER_MODEL")" "$PIPER_DIR" "$AGENTS"

echo "→ whisper.cpp and the model"
command -v whisper-server >/dev/null || brew install whisper-cpp
[ -f "$WHISPER_MODEL" ] || curl -fL -o "$WHISPER_MODEL" https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo-q5_0.bin

echo "→ piper and the Danish voice"
[ -x "$MUX_HOME/tts-venv/bin/python" ] || python3.11 -m venv "$MUX_HOME/tts-venv"
"$MUX_HOME/tts-venv/bin/python" -c "import piper" 2>/dev/null || "$MUX_HOME/tts-venv/bin/pip" install -q piper-tts
for f in "$VOICE.onnx" "$VOICE.onnx.json"; do
  [ -f "$PIPER_DIR/$f" ] || curl -fL -o "$PIPER_DIR/$f" "https://huggingface.co/rhasspy/piper-voices/resolve/main/da/da_DK/talesyntese/medium/$f"
done

agent() { # label, log name, program args (as <string> elements)
  cat > "$AGENTS/$1.plist" <<PL
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$1</string>
  <key>ProgramArguments</key><array>$3</array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>ProcessType</key><string>Interactive</string>
  <key>StandardOutPath</key><string>$MUX_HOME/logs/$2.log</string>
  <key>StandardErrorPath</key><string>$MUX_HOME/logs/$2.log</string>
  <key>EnvironmentVariables</key><dict><key>PATH</key><string>/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin</string></dict>
</dict></plist>
PL
  launchctl bootout "gui/$(id -u)/$1" 2>/dev/null || true
  launchctl bootstrap "gui/$(id -u)" "$AGENTS/$1.plist"
}

echo "→ launchd agents com.mux.whisper and com.mux.tts"
agent com.mux.whisper whisper "<string>$(command -v whisper-server)</string><string>-m</string><string>$WHISPER_MODEL</string><string>--host</string><string>127.0.0.1</string><string>--port</string><string>8310</string><string>--inference-path</string><string>/v1/audio/transcriptions</string><string>--convert</string><string>-l</string><string>auto</string>"
agent com.mux.tts tts "<string>$MUX_HOME/tts-venv/bin/python</string><string>$ROOT/server/tts/piper_server.py</string>"
for i in $(seq 1 60); do curl -s -o /dev/null http://127.0.0.1:8310 && curl -sf -o /dev/null http://127.0.0.1:8311/health && break; sleep 1; done

echo "→ models and routes in mux"
api() { curl -sf -X "$1" -H "Authorization: Bearer $MUX_ADMIN_TOKEN" -H "content-type: application/json" -d "$3" "http://127.0.0.1:${MUX_PORT:-7070}/api/admin$2" >/dev/null; }
api POST /models '{"id":"whisper","display_name":"Whisper large-v3-turbo (speech to text)","kind":"transcription","backend":"external","base_url":"http://127.0.0.1:8310/v1","upstream_model":"whisper-1","caps":{"multilingual":9,"speed":8,"quality":8},"notes":"whisper.cpp whisper-server, ggml large-v3-turbo q5_0; com.mux.whisper"}'
api POST /models '{"id":"piper-da","display_name":"Piper, Danish voice (text to speech)","kind":"speech","backend":"external","base_url":"http://127.0.0.1:8311/v1","upstream_model":"da_DK-talesyntese-medium","caps":{"speed":10,"quality":5},"notes":"rhasspy/piper, da_DK-talesyntese-medium (CC0); server/tts/piper_server.py, com.mux.tts"}'
api PUT /routes/transcribe '{"kind":"transcription","strategy":"priority","candidates":["whisper"]}'
api PUT /routes/speak '{"kind":"speech","strategy":"priority","candidates":["piper-da"]}'
echo "✓ speech: whisper on :8310, piper on :8311 — POST /v1/audio/transcriptions and /v1/audio/speech on mux"
