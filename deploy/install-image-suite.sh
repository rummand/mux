#!/bin/bash
# Install the Thread image suite on the Mux Mac Studio; keep existing FLUX.2 routes intact.
# Usage: bash deploy/install-image-suite.sh [--model=NAME] [--skip-download] [--check]
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
MUX_HOME="$HOME/.mux"
VENV="$MUX_HOME/images-venv"
DIR="${MUX_IMAGE_SUITE_DIR:-$MUX_HOME/models/image-suite}"
PORT="${MUX_IMAGE_SUITE_PORT:-8313}"
LABEL="com.mux.image-suite"
ONLY=all; SKIP_DOWNLOAD=0; CHECK=0
for arg in "$@"; do
  case "$arg" in
    --model=*) ONLY="${arg#*=}" ;;
    --skip-download) SKIP_DOWNLOAD=1 ;;
    --check) CHECK=1 ;;
    *) echo "Unknown option: $arg" >&2; exit 2 ;;
  esac
done
if [[ "$(uname -s)" != Darwin || "$(uname -m)" != arm64 ]]; then
  echo "ERROR: Apple Silicon Mac required" >&2; exit 2
fi
case "$ONLY" in
  all|z-image-turbo|qwen-image-2512|qwen-image-edit-2511|ming-image-0.1-design) ;;
  *) echo "ERROR: Unknown model $ONLY" >&2; exit 2 ;;
esac
mkdir -p "$MUX_HOME/logs" "$DIR" "$HOME/Library/LaunchAgents"
[[ -f "$MUX_HOME/mux.env" ]] || { echo "ERROR: Install Mux first ($MUX_HOME/mux.env missing)"; exit 1; }
# shellcheck disable=SC1090
source "$MUX_HOME/mux.env"
: "${MUX_ADMIN_TOKEN:?Missing MUX_ADMIN_TOKEN}"
MUX="http://127.0.0.1:${MUX_PORT:-7070}/api/admin"
api() { curl -fsS -X "$1" -H "Authorization: Bearer $MUX_ADMIN_TOKEN" -H "Content-Type: application/json" ${3:+--data "$3"} "$MUX$2"; }
curl -fsS "http://127.0.0.1:${MUX_PORT:-7070}/health" >/dev/null || { echo "ERROR: local Mux is offline"; exit 1; }
names=(z-image-turbo qwen-image-2512 qwen-image-edit-2511 ming-image-0.1-design)
repos=(mflux-community/z-image-turbo-mflux-q8 mflux-community/qwen-image-2512-mflux-q6 mflux-community/qwen-image-edit-2511-mflux-q6 mflux-community/ming-image-0-1-mflux-q8)
sizes=(11 31 33 26)
selected() { [[ "$ONLY" == all || "$ONLY" == "$1" ]]; }
has_weights() { [[ -n "$(find "$DIR/$1" -name '*.safetensors' -print -quit 2>/dev/null)" ]]; }
if [[ "$CHECK" == 1 ]]; then
  for name in "${names[@]}"; do
    has_weights "$name" && echo "downloaded: $name" || echo "missing: $name"
  done
  curl -fsS "http://127.0.0.1:$PORT/health" 2>/dev/null || true
  exit 0
fi

# FLUX.2 Klein is the first of the five models. Preserve its current worker if up.
if ! curl -fsS "http://127.0.0.1:8312/health" >/dev/null 2>&1; then
  echo "Installing the existing FLUX.2 Klein 4B worker (Q4)"
  bash "$ROOT/deploy/images.sh" --q4 --keep
fi

needed=10
for i in "${!names[@]}"; do
  if selected "${names[$i]}" && ! has_weights "${names[$i]}"; then needed=$((needed+sizes[$i])); fi
done
free_kb=$(df -Pk "$DIR" | awk 'NR==2 {print $4}')
free_gb=$((free_kb / 1024 / 1024))
if [[ "$SKIP_DOWNLOAD" != 1 && "$free_gb" -lt "$needed" ]]; then
  echo "ERROR: only $free_gb GB free, about $needed GB required for weights plus headroom" >&2
  exit 1
fi

PY=$(command -v python3.12 || command -v python3.11 || true)
[[ -n "$PY" ]] || { echo "ERROR: brew install python@3.12"; exit 1; }
[[ -x "$VENV/bin/python" ]] || "$PY" -m venv "$VENV"
if ! "$VENV/bin/python" -c 'from importlib.metadata import version; assert version("mflux")=="0.24.0"; import huggingface_hub' 2>/dev/null; then
  "$VENV/bin/python" -m pip install -q --upgrade "mflux==0.24.0" "huggingface_hub[hf_xet]"
fi
[[ -x "$VENV/bin/hf" ]] || { echo "ERROR: Hugging Face CLI not found"; exit 1; }

for i in "${!names[@]}"; do
  name="${names[$i]}"
  selected "$name" || continue
  dest="$DIR/$name"
  if [[ "$SKIP_DOWNLOAD" != 1 ]]; then
    echo "Downloading $name (${sizes[$i]} GB approximately) from ${repos[$i]}"
    mkdir -p "$dest"
    "$VENV/bin/hf" download "${repos[$i]}" --local-dir "$dest"
  fi
  has_weights "$name" || { echo "ERROR: missing weights for $name"; exit 1; }
done

PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
cat > "$PLIST" <<PL
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList 1.0//EN" "http://www.apple.com/DTDs/PropertyList 1.0//EN">
<plist version="1.0"><dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key><array><string>$VENV/bin/python</string><string>$ROOT/server/images/suite_server.py</string></array>
  <key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$MUX_HOME/logs/image-suite.log</string>
  <key>StandardErrorPath</key><string>$MUX_HOME/logs/image-suite.log</string>
  <key>EnvironmentVariables</key><dict>
    <key>PATH</key><string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
    <key>MUX_IMAGE_SUITE_DIR</key><string>$DIR</string>
    <key>MUX_IMAGE_SUITE_PORT</key><string>$PORT</string>
    <key>MUX_IMAGE_SUITE_IDLE_MIN</key><string>5</string>
    <key>HF_HUB_OFFLINE</key><string>1</string>
  </dict>
</dict></plist>
PL
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
healthy=0
for _ in {1..30}; do
  if curl -fsS "http://127.0.0.1:$PORT/health" >/dev/null 2>&1; then healthy=1; break; fi
  sleep 2
done
[[ "$healthy" == 1 ]] || { echo "ERROR: image-suite failed; see ~/.mux/logs/image-suite.log"; exit 1; }

for name in "${names[@]}"; do
  has_weights "$name" || continue
  payload=$(node -e 'console.log(JSON.stringify({id:process.argv[1], display_name:process.argv[1], kind:"image",
    backend:"external", base_url:"http://127.0.0.1:"+process.argv[2]+"/v1",
    upstream_model:process.argv[1], catalog_id:process.argv[1],
    caps:{quality:process.argv[1]==="z-image-turbo"?8:9,speed:process.argv[1]==="z-image-turbo"?9:3},
    notes:"Local MLX/MFLUX image suite; loads on demand. "+(process.argv[1]==="ming-image-0.1-design"?"MIT":"Apache-2.0")
  }))' "$name" "$PORT")
  api POST /models "$payload" >/dev/null 2>&1 || api PATCH "/models/$name" "$payload" >/dev/null
  echo "Registered Mux model: $name"
done
make_route() {
  local route="$1" name="$2"
  has_weights "$name" || return 0
  payload=$(node -e 'console.log(JSON.stringify({kind:"image",strategy:"priority",candidates:[process.argv[1]]}))' "$name")
  api PUT "/routes/$route" "$payload" >/dev/null
  echo "Registered route: $route -> $name"
}
make_route image-fast z-image-turbo
make_route image-premium qwen-image-2512
make_route image-design ming-image-0.1-design
make_route image-precision-edit qwen-image-edit-2511
echo "✓ Mac worker and local registrations ready. Run the per-model inference tests in docs/IMAGE-SUITE-MAC.md."
