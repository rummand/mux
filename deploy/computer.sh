#!/bin/sh
# The Mac's screen and apps for Ask mux, through Peekaboo (openclaw/Peekaboo, MIT). Safe to run again.
#   ./deploy/computer.sh        hand the work to launchd (it restarts mux) and return at once
#   ./deploy/computer.sh --run  do it here, in the foreground (what the launchd job runs)
# Follow it in ~/.mux/logs/computer.log; notifications say when to grant permissions and when it is done.
#  1. Peekaboo's CLI (Homebrew, openclaw/tap) and Peekaboo.app (the signed DMG from the latest GitHub release, checked
#     against the OpenClaw Foundation's signing team before it is installed) in /Applications, started
#  2. this Mac's mux: main, build, restart (Ask mux gets computer_look, computer_list and computer_act)
#  3. permissions: System Settings opens on Screen Recording and Accessibility; a person at the Mac switches on
#     Peekaboo in both (macOS lets no script do it). It waits up to 15 minutes for them.
#  4. a check from launchd, as mux runs: one look at the frontmost window, and mux's GET /api/admin/computer
# Then in the dashboard: Ask mux "what is on my screen?" — looking runs at once, every action waits for approval.
set -eu
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
MUX_HOME="$HOME/.mux"
LOG="$MUX_HOME/logs/computer.log"
LABEL=com.mux.computer-setup
TEAM=FWJYW4S8P8 # Developer ID Application: OpenClaw Foundation (Peekaboo's docs/permissions.md)
PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
mkdir -p "$MUX_HOME/logs"

if [ "${1:-}" != "--run" ]; then
  PLIST="$MUX_HOME/$LABEL.plist"
  cat > "$PLIST" <<PL
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key><array><string>/bin/sh</string><string>$ROOT/deploy/computer.sh</string><string>--run</string></array>
  <key>RunAtLoad</key><true/>
  <key>WorkingDirectory</key><string>$ROOT</string>
  <key>StandardOutPath</key><string>$LOG</string>
  <key>StandardErrorPath</key><string>$LOG</string>
  <key>EnvironmentVariables</key><dict><key>PATH</key><string>$PATH</string><key>HOME</key><string>$HOME</string></dict>
</dict></plist>
PL
  launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
  : > "$LOG"
  launchctl bootstrap "gui/$(id -u)" "$PLIST"
  echo "started: Peekaboo for mux. Follow it in $LOG. Someone at the Mac must switch on two permissions when System Settings opens."
  exit 0
fi

step() { echo; echo "── $(date '+%H:%M:%S') $*"; }
notify() { osascript -e "display notification \"$1\" with title \"mux: the Mac for Ask mux\"" 2>/dev/null || true; }
fail() { echo "✗ $*"; notify "Stopped: $*"; exit 1; }
trap 'code=$?; [ $code -eq 0 ] || notify "Stopped (exit $code), see computer.log"' EXIT
cd "$ROOT"
. "$MUX_HOME/mux.env"
LOCAL="http://127.0.0.1:${MUX_PORT:-7070}"

step "1/4 Peekaboo"
MAJOR=$(sw_vers -productVersion | cut -d. -f1)
[ "$MAJOR" -ge 15 ] || fail "Peekaboo needs macOS 15 or later; this Mac runs $(sw_vers -productVersion)"
command -v peekaboo >/dev/null || brew install openclaw/tap/peekaboo || fail "brew install openclaw/tap/peekaboo"
brew upgrade openclaw/tap/peekaboo 2>/dev/null || true
echo "  CLI: $(command -v peekaboo) $(peekaboo --version 2>/dev/null | head -1)"
if [ ! -d /Applications/Peekaboo.app ]; then
  REL=$(curl -sfL https://api.github.com/repos/openclaw/Peekaboo/releases/latest) || fail "reading Peekaboo's latest release from GitHub"
  URL=$(printf %s "$REL" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const a=(JSON.parse(s).assets||[]).find(a=>/\.dmg$/i.test(a.name));if(a)console.log(a.browser_download_url)})')
  [ -n "$URL" ] || fail "no .dmg in Peekaboo's latest release"
  TMP=$(mktemp -d /tmp/peekaboo.XXXXXX)
  curl -sfL -o "$TMP/Peekaboo.dmg" "$URL" || fail "downloading $URL"
  MNT="$TMP/mnt"; mkdir "$MNT"
  hdiutil attach -nobrowse -quiet -mountpoint "$MNT" "$TMP/Peekaboo.dmg" || fail "opening the DMG"
  APP=$(find "$MNT" -maxdepth 1 -name '*.app' | head -1)
  # Install only what OpenClaw signed and Apple notarized
  codesign --verify --deep --strict "$APP" 2>/dev/null || { hdiutil detach -quiet "$MNT"; fail "Peekaboo.app's signature does not verify"; }
  codesign -dv "$APP" 2>&1 | grep -q "TeamIdentifier=$TEAM" || { hdiutil detach -quiet "$MNT"; fail "Peekaboo.app is not signed by team $TEAM (OpenClaw Foundation)"; }
  spctl --assess --type execute "$APP" 2>/dev/null || { hdiutil detach -quiet "$MNT"; fail "Gatekeeper refuses Peekaboo.app (not notarized?)"; }
  ditto "$APP" /Applications/Peekaboo.app
  hdiutil detach -quiet "$MNT"; rm -rf "$TMP"
  echo "  installed /Applications/Peekaboo.app ($(basename "$URL"), signed by $TEAM)"
fi
open -g -a /Applications/Peekaboo.app
sleep 3
echo "✓ Peekaboo.app runs (menu bar). Switch on Launch at Login in its Settings so it is there after a restart."

step "2/4 mux: code, build, restart"
git fetch -q origin main
git merge-base --is-ancestor origin/main HEAD 2>/dev/null || git merge --ff-only origin/main || fail "this working tree cannot fast-forward to main"
git log --oneline -1
npm run build >/dev/null || fail "npm run build"
launchctl kickstart -k "gui/$(id -u)/com.mux.server"
sleep 5
i=0; until curl -sf -o /dev/null "$LOCAL/health"; do i=$((i + 5)); [ $i -lt 180 ] || fail "mux did not come back"; sleep 5; done
echo "✓ mux is back"

step "3/4 permissions: Screen Recording and Accessibility for Peekaboo"
granted() { peekaboo permissions status 2>/dev/null | grep -iE "screen recording" | grep -qiE "granted|enabled|yes|✓|true" && peekaboo permissions status 2>/dev/null | grep -iE "accessibility" | grep -qiE "granted|enabled|yes|✓|true"; }
if ! granted; then
  peekaboo permissions request screen-recording >/dev/null 2>&1 || true
  open "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture" 2>/dev/null || true
  sleep 2
  open "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility" 2>/dev/null || true
  notify "Switch on Peekaboo under Screen Recording and Accessibility in System Settings"
  echo "  waiting: in System Settings → Privacy & Security, switch on Peekaboo under Screen & System Audio Recording"
  echo "  and under Accessibility (both are open now). If macOS asks to quit and reopen Peekaboo, say yes."
  i=0; until granted; do i=$((i + 10)); [ $i -lt 900 ] || { peekaboo permissions status --all-sources 2>&1 | sed 's/^/    /'; fail "permissions not granted after 15 minutes"; }; sleep 10; done
fi
peekaboo permissions status --all-sources 2>&1 | sed 's/^/  /'
echo "✓ permissions granted"

step "4/4 a check, from launchd as mux runs"
SEE=$(peekaboo see --mode frontmost --json --path "$MUX_HOME/logs/computer-test.png" 2>&1) || true
printf %s "$SEE" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const d=JSON.parse(s);const b=d.data??d;const n=(b.ui_elements??b.elements??[]).length;if(!(b.snapshot_id??b.snapshotId))throw new Error(JSON.stringify(d).slice(0,300));console.log("  saw "+(b.application_name??"the frontmost window")+": "+n+" elements, snapshot "+(b.snapshot_id??b.snapshotId))}catch(e){console.error("  "+e.message);process.exit(1)}})' \
  || fail "Peekaboo could not look at the screen from launchd (see above; Peekaboo.app must be running)"
STATUS=$(curl -sf -H "Authorization: Bearer $MUX_ADMIN_TOKEN" "$LOCAL/api/admin/computer") || fail "mux has no /api/admin/computer: is this mux on main?"
printf %s "$STATUS" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const d=JSON.parse(s);if(!d.available){console.error("  mux says: "+(d.reason||JSON.stringify(d)));process.exit(1)}console.log("  mux: computer tools on, "+(typeof d.version==="string"?d.version.trim():"Peekaboo"))})' \
  || fail "mux does not see Peekaboo"
echo "✓ Ask mux can see and use this Mac: ask it \"what is on my screen?\" — every action waits for your approval"
notify "Ask mux can now see and use this Mac"
