#!/bin/sh
# Join this Mac's mux to a gateway as a node (a provider the gateway routes to).
#   ./deploy/join-node.sh [node-url] [node-id] [name]
# The node URL is how the gateway reaches this Mac: Tailscale Funnel at /mux by default, published with
#   tailscale funnel --bg --https=443 --set-path=/mux http://127.0.0.1:7070
# Reads the gateway's URL and admin token from ~/.mux/railway.env, this node's admin token from ~/.mux/mux.env.
set -eu
. "$HOME/.mux/railway.env"
NODE_TOKEN=$(grep '^MUX_ADMIN_TOKEN=' "$HOME/.mux/mux.env" | cut -d= -f2)
URL=${1:-https://$(tailscale status --json | python3 -c 'import json,sys; print(json.load(sys.stdin)["Self"]["DNSName"].rstrip("."))')/mux}
ID=${2:-mac-studio}
NAME=${3:-Mac Studio}
curl -sf --max-time 10 "$URL/health" >/dev/null || { echo "✗ $URL/health does not answer: publish mux first (see above)"; exit 1; }
curl -s -X PUT "$MUX_GATEWAY_URL/api/admin/providers/$ID" -H "authorization: Bearer $MUX_GATEWAY_ADMIN_TOKEN" -H content-type:application/json \
  -d "{\"kind\":\"mux\",\"name\":\"$NAME\",\"base_url\":\"$URL\",\"admin_token\":\"$NODE_TOKEN\"}" | python3 -c '
import json, sys
d = json.load(sys.stdin)
if d.get("error"): sys.exit("✗ " + d["error"])
print(f"✓ {d[\"name\"]} joined the gateway: {d[\"status\"]}, {(d.get(\"info\") or {}).get(\"models\")} models, {(d.get(\"info\") or {}).get(\"latencyMs\")} ms")'
