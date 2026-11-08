#!/bin/sh
# Freefield (rummand/freefield) on Railway with mux as its AI gateway, in one go. Safe to run again.
#   ./deploy/freefield.sh        hand the work to launchd (images may restart mux) and return at once
#   ./deploy/freefield.sh --run  do it here, in the foreground (what the launchd job runs)
# Follow it in ~/.mux/logs/freefield.log; a notification says when it is done or what stopped it.
#  1. images: if the gateway has no /v1/images/generations yet, ./deploy/setup-images.sh --run first
#  2. the gateway tenant `freefield` ($20 a month) with a new key "railway web"; image and image-edit allowed
#  3. Railway: the project and service `freefield` (made when missing), a volume on /data, the variables
#     MUX_BASE_URL, MUX_API_KEY and FREEFIELD_PASSCODE (kept if set), `railway up` of freefield's main, a domain
#  4. checks: /health says mux, one image through the gateway with Freefield's key; older "railway web" keys revoked
# Reads ~/.mux/railway.env (MUX_GATEWAY_URL, MUX_GATEWAY_ADMIN_TOKEN); the railway CLI must be logged in and git must
# reach rummand/freefield (private). The key is never printed; the passcode and link are, at the end.
set -eu
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
MUX_HOME="$HOME/.mux"
LOG="$MUX_HOME/logs/freefield.log"
LABEL=com.mux.freefield
SERVICE=freefield
REPO=https://github.com/rummand/freefield
PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
mkdir -p "$MUX_HOME/logs"

if [ "${1:-}" != "--run" ]; then
  PLIST="$MUX_HOME/$LABEL.plist"
  cat > "$PLIST" <<PL
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key><array><string>/bin/sh</string><string>$ROOT/deploy/freefield.sh</string><string>--run</string></array>
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
  echo "started: Freefield on Railway with mux. Follow it in $LOG (longer the first time, when images are installed too)."
  exit 0
fi

step() { echo; echo "── $(date '+%H:%M:%S') $*"; }
notify() { osascript -e "display notification \"$1\" with title \"Freefield\"" 2>/dev/null || true; }
fail() { echo "✗ $*"; notify "Stopped: $*"; exit 1; }
trap 'code=$?; [ $code -eq 0 ] || notify "Stopped (exit $code), see freefield.log"' EXIT
wait_for() { limit=$1 what=$2; shift 2; i=0; until "$@" >/dev/null 2>&1; do i=$((i + 5)); [ $i -lt "$limit" ] || fail "$what: not after $limit s"; sleep 5; done; }
js() { node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const d=JSON.parse(s);$1})"; }
cd "$ROOT"
. "$MUX_HOME/railway.env"
GW="${MUX_GATEWAY_URL:-https://mux-production-0b55.up.railway.app}"
gw() { curl -sf -X "$1" -H "Authorization: Bearer $MUX_GATEWAY_ADMIN_TOKEN" -H "content-type: application/json" ${3:+-d "$3"} "$GW/api/admin$2"; }

# ── 1. Images on the gateway ────────────────────────────────────────────────────────────────────────────────────
step "1/4 images on the gateway"
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST -H content-type:application/json -d '{}' "$GW/v1/images/generations")
if [ "$code" = 404 ]; then
  echo "the gateway has no image API yet: running setup-images.sh (this Mac, Railway mux, LBS Studio)"
  git fetch -q origin main && { git merge-base --is-ancestor origin/main HEAD || git merge --ff-only origin/main; } || fail "cannot bring this working tree up to main"
  sh "$ROOT/deploy/setup-images.sh" --run
else
  echo "✓ the gateway has /v1/images/generations (HTTP $code without a key)"
fi

# ── 2. Tenant and key ───────────────────────────────────────────────────────────────────────────────────────────
step "2/4 tenant freefield and a key"
gw PUT /tenants/freefield '{"name":"Freefield","status":"active","default_route":"auto","monthly_usd_budget":20}' >/dev/null || fail "saving the tenant"
gw GET /tenants/freefield > "$MUX_HOME/logs/freefield-tenant.json"
ALLOWED=$(js 'console.log(d.allowed.length ? JSON.stringify({allowed:[...new Set([...d.allowed,"image","image-edit"])]}) : "")' < "$MUX_HOME/logs/freefield-tenant.json")
[ -z "$ALLOWED" ] || gw PUT /tenants/freefield "$ALLOWED" >/dev/null
OLD_KEYS=$(js 'console.log(d.keys.filter(k=>k.name==="railway web"&&!k.revoked_at).map(k=>k.id).join(" "))' < "$MUX_HOME/logs/freefield-tenant.json")
KEYJSON=$(gw POST /tenants/freefield/keys '{"name":"railway web"}') || fail "making the key"
KEY=$(printf %s "$KEYJSON" | js 'console.log(d.key)')
echo "✓ tenant freefield, new key $(printf %s "$KEYJSON" | js 'console.log(d.record.prefix)')"

# ── 3. Railway ──────────────────────────────────────────────────────────────────────────────────────────────────
step "3/4 Railway: project, service, variables, deploy"
SRC=$(mktemp -d /tmp/freefield-src.XXXXXX)
git clone -q --depth 1 "$REPO" "$SRC" || fail "git clone $REPO (does git on this Mac reach the private repo?)"
cd "$SRC"
PROJECT=$(railway list --json | js 'const l=Array.isArray(d)?d:d.projects??[];const p=l.find(p=>/^freefield$/i.test(p.name));if(p)console.log(p.id)') || true
if [ -z "$PROJECT" ]; then
  railway init -n freefield >/dev/null || fail "railway init"
  echo "  made the Railway project freefield"
else
  railway link -p "$PROJECT" -e production >/dev/null || fail "railway link"
fi
railway service "$SERVICE" >/dev/null 2>&1 || { railway add -s "$SERVICE" >/dev/null && railway service "$SERVICE" >/dev/null; } || fail "making the service $SERVICE"
railway volume list 2>/dev/null | grep -q "/data" || railway volume add -m /data >/dev/null 2>&1 || echo "  (no volume added: add one on /data in the dashboard for run history)"
PASS=$(railway variables --kv -s "$SERVICE" 2>/dev/null | sed -n 's/^FREEFIELD_PASSCODE=//p')
[ -n "$PASS" ] || PASS=$(node -e 'console.log(require("crypto").randomBytes(9).toString("base64url"))')
railway variables -s "$SERVICE" --skip-deploys --set "MUX_BASE_URL=$GW" --set "MUX_API_KEY=$KEY" --set "FREEFIELD_PASSCODE=$PASS" >/dev/null || fail "setting the variables"
railway up --detach -s "$SERVICE" >/dev/null || fail "railway up"
DOMAIN=$(railway domain -s "$SERVICE" 2>&1 | grep -oE 'https://[A-Za-z0-9.-]+' | head -1) || true
[ -n "$DOMAIN" ] || fail "no domain from railway domain"
cd "$ROOT" && rm -rf "$SRC"
echo "✓ deploying to $DOMAIN"

# ── 4. Checks ───────────────────────────────────────────────────────────────────────────────────────────────────
step "4/4 checks"
says_mux() { curl -sf "$DOMAIN/health" | js 'process.exit(d.ok&&d.mux?0:1)'; }
wait_for 900 "$DOMAIN/health with mux: true" says_mux
echo "✓ Freefield answers and uses mux"
OUT="$MUX_HOME/logs/freefield-test.png"
curl -s -m 600 -H "Authorization: Bearer $KEY" -H "content-type: application/json" \
  -d '{"model":"image","prompt":"A field of wildflowers under a wide summer sky, film photo","size":"512x512","n":1,"response_format":"b64_json"}' \
  "$GW/v1/images/generations" > "$MUX_HOME/logs/freefield-test.json" || true
node -e 'const f=require("fs");const d=JSON.parse(f.readFileSync(process.argv[1],"utf8"));if(!d.data)throw new Error(JSON.stringify(d).slice(0,300));f.writeFileSync(process.argv[2],Buffer.from(d.data[0].b64_json,"base64"))' \
  "$MUX_HOME/logs/freefield-test.json" "$OUT" || fail "no image with Freefield's key (see freefield-test.json)"
echo "✓ an image with Freefield's key: $OUT"
for id in $OLD_KEYS; do gw DELETE "/keys/$id" >/dev/null && echo "  revoked an older railway web key"; done

step "done"
echo "✓ Freefield: $DOMAIN/?key=$PASS"
notify "Freefield is live on Railway with mux"
