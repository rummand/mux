#!/bin/sh
# Measure end to end, in one go: this Mac and the Railway gateway, and the routes on Thread's tenant. Safe to run again.
#   ./deploy/setup-measure.sh          hand the work to launchd (it outlives mux's restart) and return at once
#   ./deploy/setup-measure.sh --run    do it here, in the foreground (what the launchd job runs)
#   ./deploy/setup-measure.sh --vggt   the same, reconstructing with VGGT-1B-Commercial (see deploy/measure.sh)
# Follow it in ~/.mux/logs/setup-measure.log; a notification says when it is done or what stopped it.
#  1. this Mac: main from GitHub (fast-forward only), build, restart mux, then ./deploy/measure.sh — install PyTorch,
#     Depth Pro and MapAnything, fetch the weights at pinned revisions, register depth-pro and mapanything-apache on the
#     routes depth and reconstruct, and measure the sample house (times printed)
#  2. Railway mux: railway up from a clean worktree of main; wait until the gateway has the route reconstruct and has
#     synced mac-studio/depth-pro and the reconstruction model; the sample house through the gateway with a throwaway
#     key (revoked after)
#  3. Thread: depth and reconstruct added to the tenant `thread` on the gateway, if it lists allowed routes
# Reads ~/.mux/mux.env (this Mac's admin token) and ~/.mux/railway.env (MUX_GATEWAY_URL, MUX_GATEWAY_ADMIN_TOKEN);
# the railway CLI must be logged in. Tokens and keys are never printed.
set -eu
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
MUX_HOME="$HOME/.mux"
LOG="$MUX_HOME/logs/setup-measure.log"
LABEL=com.mux.setup-measure
MUX_PROJECT=a5bf89be-0ec9-4d3d-afcc-40226c2a86f4
PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
mkdir -p "$MUX_HOME/logs"
RUN= VGGT=
for a in "$@"; do case "$a" in --run) RUN=1 ;; --vggt) VGGT=--vggt ;; *) echo "unknown flag $a"; exit 2 ;; esac; done

if [ -z "$RUN" ]; then
  # Run under launchd, not as a child of whoever asked: step 1 restarts mux, which would take its children with it.
  PLIST="$MUX_HOME/$LABEL.plist"
  cat > "$PLIST" <<PL
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key><array><string>/bin/sh</string><string>$ROOT/deploy/setup-measure.sh</string><string>--run</string>${VGGT:+<string>--vggt</string>}</array>
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
  echo "started: measure on this Mac and Railway mux. Follow it in $LOG (15-40 min the first time: ~9 GB of weights and the sample house)."
  exit 0
fi

step() { echo; echo "── $(date '+%H:%M:%S') $*"; }
notify() { osascript -e "display notification \"$1\" with title \"mux measure\"" 2>/dev/null || true; }
fail() { echo "✗ $*"; notify "Stopped: $*"; exit 1; }
trap 'code=$?; [ $code -eq 0 ] || notify "Stopped (exit $code), see setup-measure.log"' EXIT
wait_for() { # seconds, description, command…
  limit=$1 what=$2; shift 2
  i=0; until "$@" >/dev/null 2>&1; do i=$((i + 5)); [ $i -lt "$limit" ] || fail "$what: not after $limit s"; sleep 5; done
}
js() { node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const j=JSON.parse(s);$1})"; }
cd "$ROOT"
. "$MUX_HOME/mux.env"
LOCAL="http://127.0.0.1:${MUX_PORT:-7070}"
RECON_ID=mapanything-apache
[ -z "$VGGT" ] || RECON_ID=vggt-1b-commercial

# ── 1. This Mac ─────────────────────────────────────────────────────────────────────────────────────────────────
step "1/3 this Mac: code"
git fetch -q origin main
if [ ! -f server/measure/measure_server.py ]; then
  [ "$(git rev-parse --abbrev-ref HEAD)" = main ] || fail "this working tree is on $(git rev-parse --abbrev-ref HEAD), not main, and lacks the measure code: merge main into it first"
fi
[ "$(git rev-parse --abbrev-ref HEAD)" != main ] || git merge --ff-only origin/main || fail "main here cannot fast-forward to GitHub's (local commits or changes?)"
git log --oneline -1

step "1/3 this Mac: build and restart mux"
npm run build >/dev/null
launchctl kickstart -k "gui/$(id -u)/com.mux.server"
sleep 5
wait_for 180 "mux on $LOCAL" curl -sf "$LOCAL/health"
echo "✓ mux is back"

step "1/3 this Mac: PyTorch, Depth Pro, $RECON_ID, the sample house"
sh "$ROOT/deploy/measure.sh" $VGGT || fail "deploy/measure.sh: see above and $MUX_HOME/logs/measure.log"

# ── 2. Railway mux ──────────────────────────────────────────────────────────────────────────────────────────────
step "2/3 Railway mux: deploy main"
. "$MUX_HOME/railway.env"
GW="${MUX_GATEWAY_URL:-https://mux-production-0b55.up.railway.app}"
gw() { curl -sf -X "$1" -H "Authorization: Bearer $MUX_GATEWAY_ADMIN_TOKEN" -H "content-type: application/json" ${3:+-d "$3"} "$GW/api/admin$2"; }
WT=$(mktemp -d /tmp/mux-deploy.XXXXXX) && rmdir "$WT"
git worktree add --detach "$WT" origin/main >/dev/null
(cd "$WT" && railway up --detach -p "$MUX_PROJECT" -e production -s mux) || { git worktree remove --force "$WT"; fail "railway up"; }
git worktree remove --force "$WT"
has_route() { gw GET /routes | js 'process.exit(j.some(r=>r.name==="reconstruct")?0:1)'; }
wait_for 900 "the gateway running the new mux (route reconstruct)" has_route
echo "✓ the gateway runs the new mux"
export RID="$RECON_ID"
has_models() { gw GET /models | js 'process.exit(["mac-studio/depth-pro","mac-studio/"+process.env.RID].every(id=>j.some(m=>m.id===id&&m.enabled))?0:1)'; }
wait_for 120 "mac-studio/depth-pro and mac-studio/$RECON_ID on the gateway (node sync)" has_models
echo "✓ the gateway has mac-studio/depth-pro and mac-studio/$RECON_ID"

step "2/3 Railway mux: the sample house through the gateway"
gw PUT /tenants/measure-check '{"name":"measure check (deploy/setup-measure.sh)","status":"active","default_route":"auto"}' >/dev/null
KEYJSON=$(gw POST /tenants/measure-check/keys '{"name":"setup-measure","expiresInDays":1}')
KEY_ID=$(printf %s "$KEYJSON" | js 'console.log(j.record.id)')
KEYFILE=$(mktemp "$MUX_HOME/.measure-key.XXXXXX")
chmod 600 "$KEYFILE"
printf %s "$KEYJSON" | js 'process.stdout.write(j.key)' > "$KEYFILE"
OK=1
"$MUX_HOME/measure-venv/bin/python" "$ROOT/server/measure/sample/try_measure.py" --base "$GW/v1" --key-file "$KEYFILE" --out "$MUX_HOME/logs/measure-gateway" || OK=
rm -f "$KEYFILE"
gw DELETE "/keys/$KEY_ID" >/dev/null || true
[ -n "$OK" ] || fail "the sample house did not come back through the gateway (see above)"
echo "✓ the sample house through Railway (files in $MUX_HOME/logs/measure-gateway)"

# ── 3. Thread ───────────────────────────────────────────────────────────────────────────────────────────────────
step "3/3 Thread: tenant routes"
gw GET /tenants | js '
  for (const t of j) {
    if (t.id !== "thread") continue;
    if (!t.allowed.length) { console.error("  thread: all routes allowed already"); continue; }
    console.log(t.id + "\t" + JSON.stringify({ allowed: [...new Set([...t.allowed, "depth", "reconstruct"])] }));
  }' > "$MUX_HOME/logs/measure-tenants.tsv"
while IFS="$(printf '\t')" read -r id body; do
  [ -n "$id" ] && gw PUT "/tenants/$id" "$body" >/dev/null && echo "  $id: depth and reconstruct allowed"
done < "$MUX_HOME/logs/measure-tenants.tsv"

step "done"
echo "✓ this Mac: depth-pro and $RECON_ID on :8314 (test files in $MUX_HOME/logs/measure-test*)"
echo "✓ Railway mux: /v1/depth and /v1/reconstruct live, mac-studio/depth-pro and mac-studio/$RECON_ID"
echo "✓ Thread: calls depth and reconstruct with its MUX_BASE_URL and MUX_API_KEY"
notify "Measure is live: Mac and Railway mux"
