#!/bin/bash
# The Mac's outside watchdog (launchd, every 60 s): three failed health checks in a row restart mux. It catches what
# mux cannot catch itself: a process that is up but answers nothing.
MUX_HOME="${MUX_HOME:-$HOME/.mux}"
PORT="$(grep -E '^MUX_PORT=' "$MUX_HOME/mux.env" 2>/dev/null | cut -d= -f2)"; PORT="${PORT:-7070}"
STATE="$MUX_HOME/run/watchdog.fails"
if curl -sf -m 10 "http://127.0.0.1:$PORT/health" >/dev/null; then echo 0 > "$STATE"; exit 0; fi
n=$(( $(cat "$STATE" 2>/dev/null || echo 0) + 1 )); echo "$n" > "$STATE"
echo "$(date -u +%FT%TZ) health check failed ($n in a row)"
if [ "$n" -ge 3 ]; then
  echo "$(date -u +%FT%TZ) restarting com.mux.server"
  launchctl kickstart -k "gui/$(id -u)/com.mux.server"
  echo 0 > "$STATE"
fi
