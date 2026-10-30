#!/bin/sh
# Undo cutover.sh: give Nexus its own model servers back. mux keeps running on :7070, without the compat ports.
set -eu
D="gui/$(id -u)"
LA="$HOME/Library/LaunchAgents"
sed -i '' '/^MUX_COMPAT=/d' "$HOME/.mux/mux.env"
launchctl kickstart -k "$D/com.mux.server"
sleep 3
for label in com.nexus.embed com.nexus.llm com.nexus.toolguard; do
  [ -f "$LA/$label.plist.disabled-by-mux" ] && mv "$LA/$label.plist.disabled-by-mux" "$LA/$label.plist"
  [ -f "$LA/$label.plist" ] && launchctl bootstrap "$D" "$LA/$label.plist" 2>/dev/null && echo "started $label" || true
done
