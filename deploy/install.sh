#!/bin/sh
# Install mux on this Mac as a launchd agent (com.mux.server), listening on :7070.
#   ./deploy/install.sh            build, write ~/.mux/mux.env (once), (re)load the agent
# The admin token for the dashboard is in ~/.mux/mux.env (MUX_ADMIN_TOKEN).
set -eu
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
MUX_HOME="$HOME/.mux"
LABEL=com.mux.server
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
mkdir -p "$MUX_HOME/logs" "$MUX_HOME/slots"

echo "→ build"
cd "$ROOT" && npm install --no-audit --no-fund >/dev/null && npm run build -w server >/dev/null
( [ -f web/package.json ] && npm run build -w web >/dev/null 2>&1 ) || echo "  (dashboard not built: web/ missing or failing; the API runs without it)"

if [ ! -f "$MUX_HOME/mux.env" ]; then
  echo "→ write $MUX_HOME/mux.env"
  umask 077
  cat > "$MUX_HOME/mux.env" <<ENV
MUX_PORT=7070
MUX_HOST=0.0.0.0
MUX_ADMIN_TOKEN=$(openssl rand -hex 24)
MUX_MEMORY_BUDGET_GB=48
PATH=/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin
ENV
fi

echo "→ launchd agent $LABEL"
cat > "$PLIST" <<PL
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key><array><string>$ROOT/deploy/run.sh</string></array>
  <key>WorkingDirectory</key><string>$ROOT/server</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>ExitTimeOut</key><integer>30</integer>
  <key>ProcessType</key><string>Interactive</string>
  <key>StandardOutPath</key><string>$MUX_HOME/logs/mux.log</string>
  <key>StandardErrorPath</key><string>$MUX_HOME/logs/mux.log</string>
  <key>EnvironmentVariables</key><dict><key>PATH</key><string>/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin</string></dict>
</dict></plist>
PL
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
for i in $(seq 1 30); do curl -sf "http://127.0.0.1:7070/health" >/dev/null && break; sleep 1; done
curl -s "http://127.0.0.1:7070/health"; echo
echo "✓ mux on http://$(scutil --get LocalHostName 2>/dev/null || hostname).local:7070 — admin token: grep MUX_ADMIN_TOKEN ~/.mux/mux.env"
