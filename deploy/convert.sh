#!/bin/sh
# Documents to PDF on this Mac, as a mux model: LibreOffice headless behind server/convert/convert_server.mjs, with
# its network denied by the operating system (macOS sandbox-exec), a 30 s limit, a 25 MB cap and a fresh folder and
# LibreOffice profile per job, deleted afterwards; macros never run. For bloom for business's Desk (Word and
# PowerPoint pages; the owner, 19 November 2026).
#   ./deploy/convert.sh            install LibreOffice if missing, (re)load the agent, register the model and route,
#                                  allow the route for bloom's test tenant, then prove the network denial
#                                  (server/convert/prove.mjs)
#   ./deploy/convert.sh --no-test  the same without the proof
#   ./deploy/convert.sh --railway  after that, Railway mux from a clean worktree of origin/main (it must have this
#                                  change), the route convert → mac-studio/libreoffice there. bloom-for-business on
#                                  Railway allows every route already; settings.convertTenants names it.
# The converter runs on 127.0.0.1:8318 (com.mux.convert) and answers POST /v1/convert. It becomes `libreoffice` (kind
# document) on the route `convert`; a gateway that has this Mac as a node gets it as mac-studio/libreoffice. Only the
# tenants in settings.convertTenants may use the route (router/convert.ts). Keys and tokens are never printed.
set -eu
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
MUX_HOME="$HOME/.mux"
AGENTS="$HOME/Library/LaunchAgents"
PORT=8318
MODEL_ID=libreoffice
SOFFICE=/Applications/LibreOffice.app/Contents/MacOS/soffice
TEST=1 RAILWAY=
for a in "$@"; do case "$a" in --no-test) TEST= ;; --railway) RAILWAY=1 ;; *) echo "unknown flag $a"; exit 2 ;; esac; done
[ "$(uname -s)" = Darwin ] || { echo "Run this on the Mac (the sandbox is macOS's)."; exit 2; }
[ -x /usr/bin/sandbox-exec ] || { echo "No /usr/bin/sandbox-exec: the converter cannot deny itself the network, so it is not installed."; exit 1; }
. "$MUX_HOME/mux.env"
MUX="http://127.0.0.1:${MUX_PORT:-7070}/api/admin"
api() { curl -sf -X "$1" -H "Authorization: Bearer $MUX_ADMIN_TOKEN" -H "content-type: application/json" ${3:+-d "$3"} "$MUX$2"; }
js() { node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const j=JSON.parse(s);$1})"; }
mkdir -p "$MUX_HOME/logs" "$MUX_HOME/convert/jobs" "$AGENTS"
chmod 700 "$MUX_HOME/convert" "$MUX_HOME/convert/jobs"

echo "→ LibreOffice"
[ -x "$SOFFICE" ] || HOMEBREW_NO_AUTO_UPDATE=1 brew install --cask libreoffice
"$SOFFICE" --version | head -1

echo "→ launchd agent com.mux.convert on :$PORT"
cat > "$AGENTS/com.mux.convert.plist" <<PL
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.mux.convert</string>
  <key>ProgramArguments</key><array><string>$(command -v node)</string><string>$ROOT/server/convert/convert_server.mjs</string></array>
  <key>WorkingDirectory</key><string>$MUX_HOME/convert</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>ProcessType</key><string>Interactive</string>
  <key>StandardOutPath</key><string>$MUX_HOME/logs/convert.log</string>
  <key>StandardErrorPath</key><string>$MUX_HOME/logs/convert.log</string>
  <key>EnvironmentVariables</key><dict>
    <key>PATH</key><string>/usr/bin:/bin:/usr/sbin:/sbin</string>
    <key>MUX_CONVERT_PORT</key><string>$PORT</string>
    <key>MUX_CONVERT_SOFFICE</key><string>$SOFFICE</string>
  </dict>
</dict></plist>
PL
launchctl bootout "gui/$(id -u)/com.mux.convert" 2>/dev/null || true
i=0; while launchctl print "gui/$(id -u)/com.mux.convert" >/dev/null 2>&1; do i=$((i + 1)); [ $i -lt 20 ] || break; sleep 0.5; done
launchctl bootstrap "gui/$(id -u)" "$AGENTS/com.mux.convert.plist"
for i in $(seq 1 30); do curl -sf -o /dev/null "http://127.0.0.1:$PORT/health" && break; sleep 1; done
curl -sf "http://127.0.0.1:$PORT/health" | js 'console.log("  " + j.sandbox)' || { echo "✗ the converter is not up, or its sandbox did not hold: see $MUX_HOME/logs/convert.log"; exit 1; }

echo "→ model $MODEL_ID and route convert in mux"
M=$(node -e 'console.log(JSON.stringify({id:process.argv[1],display_name:"LibreOffice headless (documents to PDF)",kind:"document",backend:"external",base_url:"http://127.0.0.1:"+process.argv[2]+"/v1",upstream_model:process.argv[1],caps:{quality:7,speed:7},notes:"LibreOffice headless under macOS sandbox-exec: no IP networking, no name resolver, nothing read from the home folder; 30 s, 25 MB, a fresh folder and profile per job, macros off. server/convert/convert_server.mjs, com.mux.convert."}))' "$MODEL_ID" "$PORT")
api POST /models "$M" >/dev/null 2>&1 || api PATCH "/models/$MODEL_ID" "$M" >/dev/null
api PUT /routes/convert '{"kind":"document","strategy":"priority","candidates":["'$MODEL_ID'"]}' >/dev/null
# bloom's test tenant on this Mac lists its routes: convert is added (the owner approved this one change)
api GET /tenants | js 'for (const t of j) if (t.id === "bloom-design-composer-test" && t.allowed.length && !t.allowed.includes("convert")) console.log(JSON.stringify({ allowed: [...t.allowed, "convert"] }))' > "$MUX_HOME/logs/convert-tenant.json"
if [ -s "$MUX_HOME/logs/convert-tenant.json" ]; then api PUT /tenants/bloom-design-composer-test "$(cat "$MUX_HOME/logs/convert-tenant.json")" >/dev/null && echo "  bloom-design-composer-test: convert allowed"; fi
api GET /settings | js 'console.log("  settings.convertTenants: " + JSON.stringify(j.convertTenants))' || true

if [ -n "$TEST" ]; then
  echo "→ the network proof (server/convert/prove.mjs)"
  node "$ROOT/server/convert/prove.mjs" "http://127.0.0.1:$PORT" || { echo "✗ the proof did not pass: the converter must not be used"; exit 1; }
fi

if [ -n "$RAILWAY" ]; then
  echo "→ Railway mux: deploy origin/main (it must have this change merged), route convert → mac-studio/$MODEL_ID"
  . "$MUX_HOME/railway.env"
  GW="${MUX_GATEWAY_URL:-https://mux-production-0b55.up.railway.app}"
  gw() { curl -sf -X "$1" -H "Authorization: Bearer $MUX_GATEWAY_ADMIN_TOKEN" -H "content-type: application/json" ${3:+-d "$3"} "$GW/api/admin$2"; }
  git -C "$ROOT" fetch -q origin main
  git -C "$ROOT" cat-file -e origin/main:server/src/router/convert.ts 2>/dev/null || { echo "✗ origin/main has no convert route yet: merge it first"; exit 1; }
  WT=$(mktemp -d /tmp/mux-deploy.XXXXXX) && rmdir "$WT"
  git -C "$ROOT" worktree add --detach "$WT" origin/main >/dev/null
  (cd "$WT" && railway up --detach -p a5bf89be-0ec9-4d3d-afcc-40226c2a86f4 -e production -s mux) || { git -C "$ROOT" worktree remove --force "$WT"; echo "✗ railway up"; exit 1; }
  git -C "$ROOT" worktree remove --force "$WT"
  i=0; until gw GET /routes | js 'process.exit(j.some(r=>r.name==="convert")?0:1)' 2>/dev/null; do i=$((i + 10)); [ $i -lt 900 ] || { echo "✗ the gateway has no route convert after 15 min"; exit 1; }; sleep 10; done
  i=0; until gw GET /models | js 'process.exit(j.some(m=>m.id==="mac-studio/'$MODEL_ID'"&&m.enabled)?0:1)' 2>/dev/null; do i=$((i + 5)); [ $i -lt 180 ] || { echo "✗ the gateway has not synced mac-studio/$MODEL_ID"; exit 1; }; sleep 5; done
  gw PUT /routes/convert '{"kind":"document","strategy":"priority","candidates":["mac-studio/'$MODEL_ID'"]}' >/dev/null
  echo "  ✓ Railway mux: route convert → mac-studio/$MODEL_ID"
fi
echo "✓ convert: $MODEL_ID on :$PORT — POST /v1/convert on mux"
