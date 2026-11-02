#!/bin/sh
# Record's Danish speech engines as mux models: CoRal's Røst v3, syv.ai's Hviske v5.3, Whisper turbo and the Alexandra
# Institute's Edda v0.2 (large and turbo), served on this Mac by Record's speech-da service (com.record.speech-da,
# 127.0.0.1:8798; record repo ops/mac-studio/speech-da).
#   ./deploy/speech-da.sh      register the models and the route transcribe-da (again: it updates them)
# Route transcribe-da tries Røst first, then Hviske, Whisper turbo and whisper.cpp's Whisper. A gateway with this Mac
# as a node gets them as mac-studio/roest-v3, … on its next sync. speech-da's key is read from Record's settings on
# this Mac and kept in mux's database as the models' key; it is never printed. Audio is never logged.
set -eu
MUX_HOME="$HOME/.mux"
. "$MUX_HOME/mux.env"
SPEECH_ENV="${SPEECH_DA_ENV:-$HOME/.record/etc/speech-da.env}"
SPEECH_DA_KEY=$(sed -n 's/^SPEECH_DA_KEY=//p' "$SPEECH_ENV")
[ -n "$SPEECH_DA_KEY" ] || { echo "no SPEECH_DA_KEY in $SPEECH_ENV: install Record's speech-da first" >&2; exit 1; }
curl -sf -o /dev/null http://127.0.0.1:8798/health || echo "speech-da is not answering on :8798 yet; the models are registered anyway"

api() { curl -sf -X "$1" -H "Authorization: Bearer $MUX_ADMIN_TOKEN" -H "content-type: application/json" --data-binary @- "http://127.0.0.1:${MUX_PORT:-7070}/api/admin$2" >/dev/null; }
model() { # id, display name, quality, speed, notes: made, or brought up to date when it is there already
  body=$(SPEECH_DA_KEY="$SPEECH_DA_KEY" python3 - "$@" <<'PY'
import json, os, sys
id_, name, quality, speed, notes = sys.argv[1:6]
print(json.dumps({"id": id_, "display_name": name, "kind": "transcription", "backend": "external",
                  "base_url": "http://127.0.0.1:8798/v1", "api_key": os.environ["SPEECH_DA_KEY"], "upstream_model": id_,
                  "caps": {"multilingual": 3, "quality": int(quality), "speed": int(speed)}, "notes": notes}))
PY
)
  printf '%s' "$body" | api POST /models 2>/dev/null || printf '%s' "$body" | api PATCH "/models/$1"
  unset body
}

echo "→ Record's Danish engines in mux"
model roest-v3 "Røst v3, CoRal's Danish Whisper (speech to text)" 10 6 "CoRal-project/roest-v3-whisper-1.5b on Record's speech-da; words timed. CoRal's licence (OpenRAIL-M)"
model hviske-v5 "Hviske v5.3, Danish Conformer (speech to text)" 10 7 "syvai/hviske-v5.3 on Record's speech-da; text only. CC BY-NC 4.0: run at Record's owner's risk"
model whisper-turbo "Whisper large-v3-turbo, held to Danish (speech to text)" 8 8 "openai/whisper-large-v3-turbo on Record's speech-da (Metal); words timed. MIT"
model edda-large "Edda v0.2 large, Danish Whisper large-v3 (speech to text)" 10 6 "danish-foundation-models/edda-v0.2-large on Record's speech-da; words timed. Apache-2.0"
model edda "Edda v0.2, Danish Whisper large-v3-turbo (speech to text)" 9 9 "danish-foundation-models/edda-v0.2 on Record's speech-da; words timed. Apache-2.0"
printf '%s' '{"kind":"transcription","strategy":"priority","description":"Danish speech: Record'"'"'s engines, Røst first","candidates":["roest-v3","hviske-v5","whisper-turbo","whisper"]}' | api PUT /routes/transcribe-da
echo "✓ transcribe-da: roest-v3, hviske-v5, whisper-turbo, whisper — POST /v1/audio/transcriptions with model=transcribe-da (or an engine)"
