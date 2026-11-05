#!/bin/sh
# opencode's web app on this Mac, public at https://opencode.<tailnet>.ts.net (knitlabs' desk opens it from its menu).
#   ./deploy/opencode.sh       (re)load both launchd agents, join the tailnet (once: open the link it prints), funnel
# com.mux.opencode runs opencode's server on 127.0.0.1:4097; its password is in ~/.config/opencode/service.json and
# every request needs it (the desk asks /api/pair for a one-time sign-in link). The Funnel ports of lv426 itself are
# all taken (443 by mux and others, 8443 and 10000 by Nexus), and opencode's web app cannot live under a path, so
# com.mux.opencode-ts runs a second, userspace tailscaled with its own node, "opencode", whose 443 is opencode's alone.
set -eu
MUX_HOME="$HOME/.mux"
TS_DIR="$MUX_HOME/opencode-ts"
SOCK="$TS_DIR/tailscaled.sock"
TAILSCALED="$(brew --prefix tailscale)/bin/tailscaled"
OPENCODE="$(command -v opencode)"
PORT=4097
mkdir -p "$MUX_HOME/logs" "$TS_DIR"

agent() { # label, log name, program arguments…
  label=$1 log=$2; shift 2
  plist="$HOME/Library/LaunchAgents/$label.plist"
  args=""; for a in "$@"; do args="$args<string>$a</string>"; done
  cat > "$plist" <<PL
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$label</string>
  <key>ProgramArguments</key><array>$args</array>
  <key>WorkingDirectory</key><string>$HOME</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>ProcessType</key><string>Interactive</string>
  <key>StandardOutPath</key><string>$MUX_HOME/logs/$log.log</string>
  <key>StandardErrorPath</key><string>$MUX_HOME/logs/$log.log</string>
  <key>EnvironmentVariables</key><dict><key>PATH</key><string>/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin</string><key>HOME</key><string>$HOME</string></dict>
</dict></plist>
PL
  launchctl bootout "gui/$(id -u)/$label" 2>/dev/null || true
  launchctl bootstrap "gui/$(id -u)" "$plist"
}

echo "→ opencode on 127.0.0.1:$PORT"
"$OPENCODE" service set port $PORT >/dev/null
"$OPENCODE" service stop >/dev/null 2>&1 || true
agent com.mux.opencode opencode "$OPENCODE" serve --service --hostname 127.0.0.1 --port $PORT

echo "→ tailnet node opencode"
agent com.mux.opencode-ts opencode-ts "$TAILSCALED" --tun=userspace-networking --statedir="$TS_DIR" --socket="$SOCK" --port=0
ts() { tailscale --socket="$SOCK" "$@"; }
i=0; until ts status >/dev/null 2>&1 || ts status 2>&1 | grep -q -i "logged out\|needs login"; do i=$((i+1)); [ $i -lt 30 ] || { echo "tailscaled did not start: see $MUX_HOME/logs/opencode-ts.log" >&2; exit 1; }; sleep 1; done
ts status >/dev/null 2>&1 || { echo "  sign the node in (once):"; ts up --hostname=opencode --timeout=10m; }
ts funnel --bg --https=443 http://127.0.0.1:$PORT >/dev/null
echo "https://$(ts status --json | python3 -c 'import sys, json; print(json.load(sys.stdin)["Self"]["DNSName"].rstrip("."))')"
