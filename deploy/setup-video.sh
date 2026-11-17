#!/bin/sh
# Video end to end, in one go: this Mac and the Railway gateway, and the routes on Thread's tenant. Safe to run again.
#   ./deploy/setup-video.sh        hand the work to launchd (it outlives mux's restart) and return at once
#   ./deploy/setup-video.sh --run  do it here, in the foreground (what the launchd job runs)
# Follow it in ~/.mux/logs/setup-video.log; a notification says when it is done or what stopped it.
#  1. this Mac: main from GitHub (fast-forward only), build, restart mux, then ./deploy/video.sh — install PyTorch and
#     diffusers, fetch Wan2.1-VACE-1.3B at a pinned revision, register wan2.1-vace-1.3b on the routes video and
#     video-depth, and make a 2 s test clip
#  2. Railway mux: railway up from a clean worktree of main; wait until the gateway has the route video-depth and has
#     synced mac-studio/wan2.1-vace-1.3b; one 1 s job through the gateway with a throwaway key (revoked after)
#  3. Thread: video and video-depth added to the tenant `thread` on the gateway, if it lists allowed routes
# Reads ~/.mux/mux.env (this Mac's admin token) and ~/.mux/railway.env (MUX_GATEWAY_URL, MUX_GATEWAY_ADMIN_TOKEN);
# the railway CLI must be logged in. Tokens and keys are never printed.
set -eu
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
MUX_HOME="$HOME/.mux"
LOG="$MUX_HOME/logs/setup-video.log"
LABEL=com.mux.setup-video
MUX_PROJECT=a5bf89be-0ec9-4d3d-afcc-40226c2a86f4
PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
mkdir -p "$MUX_HOME/logs"

if [ "${1:-}" != "--run" ]; then
  # Run under launchd, not as a child of whoever asked: step 1 restarts mux, which would take its children with it.
  PLIST="$MUX_HOME/$LABEL.plist"
  cat > "$PLIST" <<PL
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key><array><string>/bin/sh</string><string>$ROOT/deploy/setup-video.sh</string><string>--run</string></array>
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
  echo "started: video on this Mac and Railway mux. Follow it in $LOG (30-90 min the first time: ~19 GB of weights and a first clip)."
  exit 0
fi

step() { echo; echo "── $(date '+%H:%M:%S') $*"; }
notify() { osascript -e "display notification \"$1\" with title \"mux video\"" 2>/dev/null || true; }
fail() { echo "✗ $*"; notify "Stopped: $*"; exit 1; }
trap 'code=$?; [ $code -eq 0 ] || notify "Stopped (exit $code), see setup-video.log"' EXIT
wait_for() { # seconds, description, command…
  limit=$1 what=$2; shift 2
  i=0; until "$@" >/dev/null 2>&1; do i=$((i + 5)); [ $i -lt "$limit" ] || fail "$what: not after $limit s"; sleep 5; done
}
js() { node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const j=JSON.parse(s);$1})"; }
cd "$ROOT"
. "$MUX_HOME/mux.env"
LOCAL="http://127.0.0.1:${MUX_PORT:-7070}"

# ── 1. This Mac ─────────────────────────────────────────────────────────────────────────────────────────────────
step "1/3 this Mac: code"
git fetch -q origin main
if [ ! -f server/video/video_server.py ]; then
  [ "$(git rev-parse --abbrev-ref HEAD)" = main ] || fail "this working tree is on $(git rev-parse --abbrev-ref HEAD), not main, and lacks the video code: merge main into it first"
fi
[ "$(git rev-parse --abbrev-ref HEAD)" != main ] || git merge --ff-only origin/main || fail "main here cannot fast-forward to GitHub's (local commits or changes?)"
git log --oneline -1

step "1/3 this Mac: build and restart mux"
npm run build >/dev/null
launchctl kickstart -k "gui/$(id -u)/com.mux.server"
sleep 5
wait_for 180 "mux on $LOCAL" curl -sf "$LOCAL/health"
echo "✓ mux is back"

step "1/3 this Mac: PyTorch, diffusers, Wan2.1-VACE-1.3B, the test clip"
sh "$ROOT/deploy/video.sh"
[ -s "$MUX_HOME/logs/video-test.mp4" ] || fail "no test clip from the video server: see $MUX_HOME/logs/video.log"

# ── 2. Railway mux ──────────────────────────────────────────────────────────────────────────────────────────────
step "2/3 Railway mux: deploy main"
. "$MUX_HOME/railway.env"
GW="${MUX_GATEWAY_URL:-https://mux-production-0b55.up.railway.app}"
gw() { curl -sf -X "$1" -H "Authorization: Bearer $MUX_GATEWAY_ADMIN_TOKEN" -H "content-type: application/json" ${3:+-d "$3"} "$GW/api/admin$2"; }
WT=$(mktemp -d /tmp/mux-deploy.XXXXXX) && rmdir "$WT"
git worktree add --detach "$WT" origin/main >/dev/null
(cd "$WT" && railway up --detach -p "$MUX_PROJECT" -e production -s mux) || { git worktree remove --force "$WT"; fail "railway up"; }
git worktree remove --force "$WT"
has_route() { gw GET /routes | js 'process.exit(j.some(r=>r.name==="video-depth")?0:1)'; }
wait_for 900 "the gateway running the new mux (route video-depth)" has_route
echo "✓ the gateway runs the new mux"
has_model() { gw GET /models | js 'process.exit(j.some(m=>m.id==="mac-studio/wan2.1-vace-1.3b"&&m.enabled)?0:1)'; }
wait_for 120 "mac-studio/wan2.1-vace-1.3b on the gateway (node sync)" has_model
echo "✓ the gateway has mac-studio/wan2.1-vace-1.3b"

step "2/3 Railway mux: one 1 s clip through the gateway (draft size, 8 fps)"
gw PUT /tenants/video-check '{"name":"video check (deploy/setup-video.sh)","status":"active","default_route":"auto"}' >/dev/null
KEYJSON=$(gw POST /tenants/video-check/keys '{"name":"setup-video","expiresInDays":1}')
KEY=$(printf %s "$KEYJSON" | js 'console.log(j.key)')
KEY_ID=$(printf %s "$KEYJSON" | js 'console.log(j.record.id)')
OUT="$MUX_HOME/logs/video-gateway-test.mp4"
ID=$(curl -sf -m 120 -H "Authorization: Bearer $KEY" -H "content-type: application/json" \
  -d '{"model":"video","prompt":"A lighthouse on a cliff at dusk, waves below","seconds":1,"fps":8,"size":"832x480","seed":3}' \
  "$GW/v1/videos/generations" | js 'console.log(j.id)') || { gw DELETE "/keys/$KEY_ID" >/dev/null || true; fail "the gateway did not take a video job"; }
T0=$(date +%s)
while :; do
  S=$(curl -sf -m 30 -H "Authorization: Bearer $KEY" "$GW/v1/videos/$ID" 2>/dev/null | js 'console.log(j.status+(j.error?" "+j.error.message:""))' 2>/dev/null || echo unreachable)
  case "$S" in
    succeeded) break ;;
    failed*|cancelled*) gw DELETE "/keys/$KEY_ID" >/dev/null || true; fail "gateway clip: $S" ;;
  esac
  [ $(( $(date +%s) - T0 )) -lt 1800 ] || { gw DELETE "/keys/$KEY_ID" >/dev/null || true; fail "gateway clip: not done after 30 min ($S)"; }
  sleep 10
done
curl -sf -m 300 -H "Authorization: Bearer $KEY" -o "$OUT" "$GW/v1/videos/$ID/content" || true
gw DELETE "/keys/$KEY_ID" >/dev/null || true
[ -s "$OUT" ] || fail "the gateway gave no mp4"
echo "✓ a clip through Railway in $(( $(date +%s) - T0 )) s: $OUT"

# ── 3. Thread ───────────────────────────────────────────────────────────────────────────────────────────────────
step "3/3 Thread: tenant routes"
gw GET /tenants | js '
  for (const t of j) {
    if (t.id !== "thread") continue;
    if (!t.allowed.length) { console.error("  thread: all routes allowed already"); continue; }
    console.log(t.id + "\t" + JSON.stringify({ allowed: [...new Set([...t.allowed, "video", "video-depth"])] }));
  }' > "$MUX_HOME/logs/video-tenants.tsv"
while IFS="$(printf '\t')" read -r id body; do
  [ -n "$id" ] && gw PUT "/tenants/$id" "$body" >/dev/null && echo "  $id: video and video-depth allowed"
done < "$MUX_HOME/logs/video-tenants.tsv"

step "done"
echo "✓ this Mac: wan2.1-vace-1.3b on :8313 (test clip $MUX_HOME/logs/video-test.mp4)"
echo "✓ Railway mux: /v1/videos/* live, mac-studio/wan2.1-vace-1.3b (test clip $OUT)"
echo "✓ Thread: calls video-depth with its MUX_BASE_URL and MUX_API_KEY"
notify "Video is live: Mac and Railway mux"
