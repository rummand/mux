#!/bin/sh
# Set up a tenant on the public gateway (Railway; it keeps its own tenants) and give it a key, then send one request as
# it. MUX_TARGET=mac does it on this Mac's mux instead, for callers on the Mac or its network.
#   ./deploy/tenant.sh <id> <name> <key name> [tenant json]
#   ./deploy/tenant.sh knitlabs-desk "knitlabs desk" "railway web" '{"monthly_usd_budget":20,"data_border":"any"}'
# The tenant is saved with default_route auto and status active unless the json says otherwise (again: it updates
# it). Every run makes a new key: mux keeps only its hash, so the key is printed this once — paste it straight where
# it goes. The gateway's URL is MUX_GATEWAY_URL, else the Railway gateway; its admin token is read with the logged-in
# railway CLI (run from the repo) and never printed. MUX_KEY_VALUE=mux-sk-… registers that key instead of making one (a
# key handed out before the tenant existed); keep it out of the repo, which is public.
set -eu
[ $# -ge 3 ] || { sed -n 2,9p "$0" >&2; exit 2; }
ID=$1 NAME=$2 KEY_NAME=$3 EXTRA=${4:-'{}'}
GATEWAY=${MUX_GATEWAY_URL:-https://mux-production-0b55.up.railway.app}
if [ "${MUX_TARGET:-gateway}" = mac ]; then
  . "$HOME/.mux/mux.env"
  GATEWAY="http://127.0.0.1:${MUX_PORT:-7070}"
else
  MUX_ADMIN_TOKEN=$(cd "$(dirname "$0")/.." && railway variables --kv | sed -n 's/^MUX_ADMIN_TOKEN=//p')
  [ -n "$MUX_ADMIN_TOKEN" ] || { echo "no MUX_ADMIN_TOKEN from railway variables: is the CLI logged in and linked?" >&2; exit 1; }
fi
BASE="$GATEWAY/api/admin"

api() { curl -sf -X "$1" -H "Authorization: Bearer $MUX_ADMIN_TOKEN" -H "content-type: application/json" --data-binary @- "$BASE$2"; }
field() { python3 -c 'import sys, json; print(json.load(sys.stdin)[sys.argv[1]])' "$1"; }

python3 - "$NAME" "$EXTRA" <<'PY' | api PUT "/tenants/$ID" >/dev/null
import sys, json
print(json.dumps({"name": sys.argv[1], "default_route": "auto", "status": "active", **json.loads(sys.argv[2])}))
PY
echo "tenant $ID saved"

KEY=$(python3 -c 'import sys, json; print(json.dumps({"name": sys.argv[1], **({"value": sys.argv[2]} if sys.argv[2] else {})}))' "$KEY_NAME" "${MUX_KEY_VALUE:-}" | api POST "/tenants/$ID/keys" | field key)
echo "key ($KEY_NAME): $KEY"

echo "test request through $GATEWAY:"
curl -s -D - -o /dev/null --max-time 180 -H "Authorization: Bearer $KEY" -H "content-type: application/json" "$GATEWAY/v1/chat/completions" \
  -d '{"model":"auto","max_tokens":50,"messages":[{"role":"user","content":"Say hi in one line."}]}' | grep -i '^HTTP\|^x-mux-model\|^x-mux-route' || true
echo "MUX_URL=$GATEWAY"
