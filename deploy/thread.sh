#!/bin/sh
# The tenant `thread` (Thread) on the Railway gateway, with a new key, in one go.
#   ./deploy/thread.sh
# Prints the key once and also keeps it in ~/.mux/keys/thread.key (readable only by you), then sends one test
# request with it. Running it again makes another key; the older ones keep working until revoked in the dashboard.
set -eu
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
mkdir -p "$HOME/.mux/keys" && chmod 700 "$HOME/.mux/keys"
OUT=$(sh "$ROOT/deploy/tenant.sh" thread "Thread" "thread")
printf '%s\n' "$OUT"
KEY=$(printf '%s\n' "$OUT" | sed -n 's/^key (thread): //p')
[ -n "$KEY" ] || { echo "✗ no key came back (see above)"; exit 1; }
umask 077 && printf '%s\n' "$KEY" > "$HOME/.mux/keys/thread.key"
echo "✓ tenant thread ready; key also in ~/.mux/keys/thread.key"
