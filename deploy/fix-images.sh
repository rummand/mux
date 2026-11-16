#!/usr/bin/env bash
# Get FLUX on the Mac answering again: pull the latest mux, restart the image workers on it, and test two
# generations in a row (the old server answered the first and failed every one after with
# "There is no Stream(cpu, N) in current thread"; 289802a runs every MLX call on one thread).
# Usage, on the Mac in the mux folder:  bash deploy/fix-images.sh
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
[ "$(uname -s)" = Darwin ] || { echo "Run this on the Mac." >&2; exit 2; }

echo "→ Pulling mux main"
git pull --ff-only

grep -q 'on_mlx' server/images/image_server.py || { echo "ERROR: image_server.py has no MLX-thread fix after the pull" >&2; exit 1; }

echo "→ Restarting the image workers"
for label in com.mux.images com.mux.flux3 com.mux.flux3-bf16; do
  if launchctl print "gui/$(id -u)/$label" >/dev/null 2>&1; then
    launchctl kickstart -k "gui/$(id -u)/$label" && echo "  restarted $label"
  fi
done

echo "→ Waiting for FLUX.2 klein on 127.0.0.1:8312"
for i in $(seq 1 30); do curl -fsS -m 5 http://127.0.0.1:8312/health >/dev/null 2>&1 && break; sleep 2; done
curl -fsS -m 5 http://127.0.0.1:8312/health >/dev/null || { echo "ERROR: not up; see ~/.mux/logs/images.log" >&2; exit 1; }

echo "→ Two generations in a row (the first loads the model, so it can take a minute)"
for n in 1 2; do
  out=$(curl -sS -m 600 http://127.0.0.1:8312/v1/images/generations -H 'Content-Type: application/json' \
    -d '{"prompt":"a grey test cube on a wooden table, soft light","size":"512x512","n":1,"seed":'"$n"'}')
  if echo "$out" | grep -q '"b64_json"'; then echo "  ✓ generation $n"; else echo "  ✗ generation $n: ${out:0:300}" >&2; exit 1; fi
done
echo "✓ FLUX is answering on the Mac again. Mux's gateway picks it up on its next check."
