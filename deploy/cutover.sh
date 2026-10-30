#!/bin/sh
# Cut Nexus's model servers over to mux (2026-10-30, the owner: "mux can kill all existing stuff ... model servers only").
# Stops and disables com.nexus.{toolguard,llm,embed} and the challenger pair; their ports (8090, 8094, 8099) are then
# answered by mux's localhost compatibility listeners (MUX_COMPAT in ~/.mux/mux.env), so Caddy, Nexus Build and
# anything else calling them keep working unchanged. Plists are renamed *.disabled-by-mux; rollback.sh undoes it all.
set -eu
D="gui/$(id -u)"
LA="$HOME/Library/LaunchAgents"
for label in com.nexus.toolguard com.nexus.toolguard-challenger com.nexus.llm com.nexus.llm-challenger com.nexus.embed; do
  launchctl bootout "$D/$label" 2>/dev/null && echo "stopped $label" || true
  [ -f "$LA/$label.plist" ] && mv "$LA/$label.plist" "$LA/$label.plist.disabled-by-mux" && echo "disabled $label"
done
grep -q '^MUX_COMPAT=' "$HOME/.mux/mux.env" || echo 'MUX_COMPAT=8090=nexus,8094=nexus,8099=nexus-build' >> "$HOME/.mux/mux.env"
launchctl kickstart -k "$D/com.mux.server"
for i in $(seq 1 30); do curl -sf http://127.0.0.1:7070/health >/dev/null && break; sleep 1; done
echo "mux: $(curl -s http://127.0.0.1:7070/health)"
