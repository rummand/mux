#!/bin/sh
# Images end to end, in one go: this Mac, the Railway gateway and LBS Studio. Safe to run again.
#   ./deploy/setup-images.sh        hand the work to launchd (it outlives mux's restart) and return at once
#   ./deploy/setup-images.sh --run  do it here, in the foreground (what the launchd job runs)
# Follow it in ~/.mux/logs/setup-images.log; a notification says when it is done or what stopped it.
#  1. this Mac: main from GitHub (fast-forward only), build, restart mux, then ./deploy/images.sh — unload what is not
#     needed, install mflux and FLUX.2 klein 4B, register flux2-klein-4b on the routes image and image-edit
#  2. Railway mux: railway up from a clean worktree of main; wait until the gateway has the image routes and has synced
#     mac-studio/flux2-klein-4b; one image through the gateway with a throwaway key (revoked after)
#  3. LBS Studio on Railway: image and image-edit added to any LBS tenant that lists allowed routes, and
#     MUX_IMAGE_ENABLED=true on the lbs-studio service (Railway redeploys it)
# Reads ~/.mux/mux.env (this Mac's admin token) and ~/.mux/railway.env (MUX_GATEWAY_URL, MUX_GATEWAY_ADMIN_TOKEN);
# the railway CLI must be logged in. Tokens and keys are never printed.
set -eu
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
MUX_HOME="$HOME/.mux"
LOG="$MUX_HOME/logs/setup-images.log"
LABEL=com.mux.setup-images
MUX_PROJECT=a5bf89be-0ec9-4d3d-afcc-40226c2a86f4
NEEDS=82516d2 # the commit that brought images
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
  <key>ProgramArguments</key><array><string>/bin/sh</string><string>$ROOT/deploy/setup-images.sh</string><string>--run</string></array>
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
  echo "started: images on this Mac, Railway mux and LBS Studio. Follow it in $LOG (20-40 min the first time: ~16 GB of weights)."
  exit 0
fi

step() { echo; echo "── $(date '+%H:%M:%S') $*"; }
notify() { osascript -e "display notification \"$1\" with title \"mux images\"" 2>/dev/null || true; }
fail() { echo "✗ $*"; notify "Stopped: $*"; exit 1; }
trap 'code=$?; [ $code -eq 0 ] || notify "Stopped (exit $code), see setup-images.log"' EXIT
wait_for() { # seconds, description, command…
  limit=$1 what=$2; shift 2
  i=0; until "$@" >/dev/null 2>&1; do i=$((i + 5)); [ $i -lt "$limit" ] || fail "$what: not after $limit s"; sleep 5; done
}
cd "$ROOT"
. "$MUX_HOME/mux.env"
LOCAL="http://127.0.0.1:${MUX_PORT:-7070}"

# ── 1. This Mac ─────────────────────────────────────────────────────────────────────────────────────────────────
step "1/3 this Mac: code"
git fetch -q origin main
if ! git merge-base --is-ancestor "$NEEDS" HEAD 2>/dev/null; then
  [ "$(git rev-parse --abbrev-ref HEAD)" = main ] || fail "this working tree is on $(git rev-parse --abbrev-ref HEAD), not main, and lacks the image code: merge main into it first"
  git merge --ff-only origin/main || fail "main here cannot fast-forward to GitHub's (local commits or changes?)"
fi
git log --oneline -1

step "1/3 this Mac: build and restart mux"
npm run build >/dev/null
launchctl kickstart -k "gui/$(id -u)/com.mux.server"
sleep 5
wait_for 180 "mux on $LOCAL" curl -sf "$LOCAL/health"
echo "✓ mux is back"

step "1/3 this Mac: make room, install FLUX.2 klein 4B, register it"
sh "$ROOT/deploy/images.sh"
[ -s "$MUX_HOME/logs/images-test.png" ] || fail "no test image from the image server: see $MUX_HOME/logs/images.log"

# ── 2. Railway mux ──────────────────────────────────────────────────────────────────────────────────────────────
step "2/3 Railway mux: deploy main"
. "$MUX_HOME/railway.env"
GW="${MUX_GATEWAY_URL:-https://mux-production-0b55.up.railway.app}"
gw() { curl -sf -X "$1" -H "Authorization: Bearer $MUX_GATEWAY_ADMIN_TOKEN" -H "content-type: application/json" ${3:+-d "$3"} "$GW/api/admin$2"; }
WT=$(mktemp -d /tmp/mux-deploy.XXXXXX) && rmdir "$WT"
git worktree add --detach "$WT" origin/main >/dev/null
(cd "$WT" && railway up --detach -p "$MUX_PROJECT" -e production -s mux) || { git worktree remove --force "$WT"; fail "railway up"; }
git worktree remove --force "$WT"
has_image_route() { gw GET /routes | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.exit(JSON.parse(s).some(r=>r.name==="image-edit")?0:1))'; }
wait_for 900 "the gateway running the new mux (route image-edit)" has_image_route
echo "✓ the gateway runs the new mux"
has_mac_model() { gw GET /models | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.exit(JSON.parse(s).some(m=>m.id==="mac-studio/flux2-klein-4b"&&m.enabled)?0:1))'; }
wait_for 120 "mac-studio/flux2-klein-4b on the gateway (node sync)" has_mac_model
echo "✓ the gateway has mac-studio/flux2-klein-4b"

step "2/3 Railway mux: one image through the gateway"
gw PUT /tenants/images-check '{"name":"images check (deploy/setup-images.sh)","status":"active","default_route":"auto"}' >/dev/null
KEYJSON=$(gw POST /tenants/images-check/keys '{"name":"setup-images","expiresInDays":1}')
KEY=$(printf %s "$KEYJSON" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).key))')
KEY_ID=$(printf %s "$KEYJSON" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).record.id))')
OUT="$MUX_HOME/logs/images-gateway-test.png"
curl -s -m 600 -D "$MUX_HOME/logs/images-gateway-test.headers" -H "Authorization: Bearer $KEY" -H "content-type: application/json" \
  -d '{"model":"image","prompt":"A lighthouse on a cliff at dusk, warm window light","size":"512x512","n":1,"response_format":"b64_json"}' \
  "$GW/v1/images/generations" > "$MUX_HOME/logs/images-gateway-test.json" || true
gw DELETE "/keys/$KEY_ID" >/dev/null || true
node -e 'const f=require("fs");const d=JSON.parse(f.readFileSync(process.argv[1],"utf8"));if(!d.data)throw new Error(JSON.stringify(d).slice(0,300));f.writeFileSync(process.argv[2],Buffer.from(d.data[0].b64_json,"base64"))' \
  "$MUX_HOME/logs/images-gateway-test.json" "$OUT" || fail "the gateway did not return an image (see images-gateway-test.json)"
grep -i '^x-mux-model' "$MUX_HOME/logs/images-gateway-test.headers" || true
echo "✓ an image through Railway: $OUT"

# ── 3. LBS Studio ───────────────────────────────────────────────────────────────────────────────────────────────
step "3/3 LBS Studio: tenant routes"
gw GET /tenants | node -e '
  let s=""; process.stdin.on("data",d=>s+=d).on("end",()=>{
    for (const t of JSON.parse(s)) {
      if (!/lbs/i.test(t.id + " " + t.name)) continue;
      if (!t.allowed.length) { console.error("  " + t.id + ": all routes allowed already"); continue; }
      const allowed = [...new Set([...t.allowed, "image", "image-edit"])];
      console.log(t.id + "\t" + JSON.stringify({ allowed }));
    }
  })' > "$MUX_HOME/logs/images-tenants.tsv"
while IFS="$(printf '\t')" read -r id body; do
  [ -n "$id" ] && gw PUT "/tenants/$id" "$body" >/dev/null && echo "  $id: image and image-edit allowed"
done < "$MUX_HOME/logs/images-tenants.tsv"

step "3/3 LBS Studio: MUX_IMAGE_ENABLED=true"
LBS_PROJECT=$(railway list --json | node -e '
  let s=""; process.stdin.on("data",d=>s+=d).on("end",()=>{
    const all = JSON.parse(s); const list = Array.isArray(all) ? all : all.projects ?? [];
    const p = list.find(p => /lbs[- ]?studio/i.test(p.name)); if (p) console.log(p.id);
  })') || true
[ -n "$LBS_PROJECT" ] || fail "no Railway project named lbs-studio for this railway login"
LINK=$(mktemp -d /tmp/lbs-link.XXXXXX)
(cd "$LINK" && railway link -p "$LBS_PROJECT" -e production -s lbs-studio >/dev/null && railway variables --set "MUX_IMAGE_ENABLED=true" -s lbs-studio -e production >/dev/null) \
  || { rm -rf "$LINK"; fail "setting MUX_IMAGE_ENABLED on lbs-studio"; }
rm -rf "$LINK"
echo "✓ MUX_IMAGE_ENABLED=true on lbs-studio; Railway redeploys it"
wait_for 600 "LBS Studio answering after its redeploy" sh -c 'curl -sf https://lbs-studio-production.up.railway.app/health >/dev/null'

step "done"
echo "✓ this Mac: flux2-klein-4b on :8312 (test image $MUX_HOME/logs/images-test.png)"
echo "✓ Railway mux: /v1/images/* live, mac-studio/flux2-klein-4b (test image $OUT)"
echo "✓ LBS Studio: image inference on — Generate and Harmonize go through mux"
notify "Images are live: Mac, Railway mux and LBS Studio"
