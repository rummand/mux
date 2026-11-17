#!/bin/sh
# Everything Thread (rummand/thread) uses on mux, working and checked, in one go. Safe to run again.
#   ./deploy/thread-ready.sh        hand the work to launchd (it restarts mux) and return at once
#   ./deploy/thread-ready.sh --run  do it here, in the foreground (what the launchd job runs)
# Follow it in ~/.mux/logs/thread-ready.log; it ends with a table of every capability, and a notification.
# What was broken on 2026-11-17, tested with Thread's key:
#   speak           Piper (com.mux.tts) not answering                → restart it; Kokoro (English) behind it
#   transcribe(-da) routed to hviske-v5, gone from the speech service → hviske-v5 disabled, Whisper turbo and Røst
#   video           not on the gateway                               → ./deploy/setup-video.sh (Mac, Railway)
#  1. this Mac: main, build, restart mux; Piper back; hviske-v5 off; routes speak, transcribe, transcribe-da
#  2. video: setup-video.sh --run (Wan2.1-VACE on the Mac, railway up of the gateway); a failure is reported, not fatal
#  3. the gateway: the same three routes on mac-studio/…, and the tenant thread allowed every route Thread uses
#  4. Thread on Railway: MUX_BASE_URL and MUX_API_KEY (the thread tenant's key) if they differ
#  5. checks with Thread's key: chat, vision, messages, search, image, edit, inpaint, speech, transcription, video
# Reads ~/.mux/mux.env, ~/.mux/railway.env and Thread's key from ~/.mux/keys/thread.key (deploy/thread.sh makes it).
set -eu
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
MUX_HOME="$HOME/.mux"
LOG="$MUX_HOME/logs/thread-ready.log"
LABEL=com.mux.thread-ready
PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
mkdir -p "$MUX_HOME/logs"

if [ "${1:-}" != "--run" ]; then
  PLIST="$MUX_HOME/$LABEL.plist"
  cat > "$PLIST" <<PL
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key><array><string>/bin/sh</string><string>$ROOT/deploy/thread-ready.sh</string><string>--run</string></array>
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
  echo "started: Thread on mux. Follow it in $LOG (longer the first time: video weights and a gateway deploy)."
  exit 0
fi

step() { echo; echo "── $(date '+%H:%M:%S') $*"; }
notify() { osascript -e "display notification \"$1\" with title \"Thread on mux\"" 2>/dev/null || true; }
fail() { echo "✗ $*"; notify "Stopped: $*"; exit 1; }
trap 'code=$?; [ $code -eq 0 ] || notify "Stopped (exit $code), see thread-ready.log"' EXIT
wait_for() { limit=$1 what=$2; shift 2; i=0; until "$@" >/dev/null 2>&1; do i=$((i + 5)); [ $i -lt "$limit" ] || { echo "  … $what: not after $limit s"; return 1; }; sleep 5; done; }
cd "$ROOT"
. "$MUX_HOME/mux.env"
. "$MUX_HOME/railway.env"
LOCAL="http://127.0.0.1:${MUX_PORT:-7070}"
GW="${MUX_GATEWAY_URL:-https://mux-production-0b55.up.railway.app}"
mac() { curl -sf -X "$1" -H "Authorization: Bearer $MUX_ADMIN_TOKEN" -H "content-type: application/json" ${3:+-d "$3"} "$LOCAL/api/admin$2"; }
gw() { curl -sf -X "$1" -H "Authorization: Bearer $MUX_GATEWAY_ADMIN_TOKEN" -H "content-type: application/json" ${3:+-d "$3"} "$GW/api/admin$2"; }
KEY_FILE="$MUX_HOME/keys/thread.key"
[ -s "$KEY_FILE" ] || fail "no $KEY_FILE: run ./deploy/thread.sh first"
KEY=$(cat "$KEY_FILE")
# routes NAME 'a b c' with only the ids that exist in MODELS_JSON (a file), in that order; prints the JSON body or nothing
routes_body() { node -e '
  const ids = new Set(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).filter((m) => m.enabled !== false).map((m) => m.id));
  const want = process.argv[3].split(" ").filter((id) => ids.has(id));
  if (want.length) console.log(JSON.stringify({ kind: process.argv[2], strategy: "priority", candidates: want }));' "$@"; }

# ── 1. This Mac ─────────────────────────────────────────────────────────────────────────────────────────────────
step "1/5 this Mac: code, build, restart"
git fetch -q origin main
git merge-base --is-ancestor origin/main HEAD 2>/dev/null || git merge --ff-only origin/main || fail "this working tree cannot fast-forward to main (on $(git rev-parse --abbrev-ref HEAD), or local changes)"
git log --oneline -1
npm run build >/dev/null || fail "npm run build"
launchctl kickstart -k "gui/$(id -u)/com.mux.server"
sleep 5
wait_for 180 "mux on $LOCAL" curl -sf "$LOCAL/health" || fail "mux did not come back"
echo "✓ mux is back"

step "1/5 this Mac: Piper (com.mux.tts)"
if ! curl -sf -m 5 -o /dev/null http://127.0.0.1:8311/health; then
  # No agent at all (2026-11-17: there was none to restart): install it; the routes are set again in the next step
  [ -f "$HOME/Library/LaunchAgents/com.mux.tts.plist" ] || "$ROOT/deploy/audio.sh" || true
  launchctl kickstart -k "gui/$(id -u)/com.mux.tts" 2>/dev/null \
    || { [ -f "$HOME/Library/LaunchAgents/com.mux.tts.plist" ] && launchctl bootstrap "gui/$(id -u)" "$HOME/Library/LaunchAgents/com.mux.tts.plist"; } || true
  wait_for 60 "Piper on :8311" curl -sf http://127.0.0.1:8311/health || { echo "  Piper's log:"; tail -n 15 "$MUX_HOME/logs/tts.log" 2>/dev/null | sed 's/^/    /'; }
fi
curl -sf -m 5 -o /dev/null http://127.0.0.1:8311/health && echo "✓ Piper answers on :8311" || echo "✗ Piper still down: speak falls back to Kokoro (English)"

step "1/5 this Mac: hviske-v5 off, routes speak, transcribe, transcribe-da"
mac GET /models > "$MUX_HOME/logs/thread-ready-mac-models.json"
if grep -q '"id":"hviske-v5"' "$MUX_HOME/logs/thread-ready-mac-models.json"; then
  mac PATCH /models/hviske-v5 '{"enabled":false}' >/dev/null && echo "  hviske-v5 disabled (the speech service has no such engine any more)"
  mac GET /models > "$MUX_HOME/logs/thread-ready-mac-models.json"
fi
M="$MUX_HOME/logs/thread-ready-mac-models.json"
for r in "speak|speech|piper-da bloom-kokoro-en" "transcribe|transcription|whisper-turbo roest-v3 whisper" "transcribe-da|transcription|roest-v3 whisper-turbo whisper"; do
  name=${r%%|*}; rest=${r#*|}; kind=${rest%%|*}; ids=${rest#*|}
  body=$(routes_body "$M" "$kind" "$ids")
  [ -n "$body" ] && mac PUT "/routes/$name" "$body" >/dev/null && echo "  $name → $(printf %s "$body" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).candidates.join(" → ")))')"
done

# ── 2. Video ────────────────────────────────────────────────────────────────────────────────────────────────────
step "2/5 video: setup-video.sh (Wan2.1-VACE on this Mac, then the gateway)"
VIDEO=ok
sh "$ROOT/deploy/setup-video.sh" --run || { VIDEO=failed; echo "✗ setup-video.sh stopped: see above; the rest goes on"; }

# ── 3. The gateway ──────────────────────────────────────────────────────────────────────────────────────────────
step "3/5 the gateway: routes and the tenant thread"
gone() { gw GET /models | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.exit(JSON.parse(s).some(m=>m.id==="mac-studio/hviske-v5")?1:0))'; }
wait_for 60 "the gateway dropping mac-studio/hviske-v5 (node sync)" gone || true
G="$MUX_HOME/logs/thread-ready-gw-models.json"
gw GET /models > "$G"
for r in "speak|speech|mac-studio/piper-da mac-studio/bloom-kokoro-en" "transcribe|transcription|mac-studio/whisper-turbo mac-studio/roest-v3 mac-studio/whisper" "transcribe-da|transcription|mac-studio/roest-v3 mac-studio/whisper-turbo mac-studio/whisper"; do
  name=${r%%|*}; rest=${r#*|}; kind=${rest%%|*}; ids=${rest#*|}
  body=$(routes_body "$G" "$kind" "$ids")
  [ -n "$body" ] && gw PUT "/routes/$name" "$body" >/dev/null && echo "  $name → $(printf %s "$body" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).candidates.join(" → ")))')"
done
gw GET /tenants/thread > "$MUX_HOME/logs/thread-ready-tenant.json" || fail "no tenant thread on the gateway: run ./deploy/thread.sh"
ALLOWED=$(node -e '
  const t = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
  const need = ["auto","fast","agent","smart","vision","multilingual","image","image-edit","speak","transcribe","transcribe-da","video","video-depth","depth","reconstruct","backdrop","web.search","web.read","web.render"];
  if (t.allowed.length && need.some((r) => !t.allowed.includes(r))) console.log(JSON.stringify({ allowed: [...new Set([...t.allowed, ...need])] }));' "$MUX_HOME/logs/thread-ready-tenant.json")
if [ -n "$ALLOWED" ]; then gw PUT /tenants/thread "$ALLOWED" >/dev/null && echo "  tenant thread: every route Thread uses allowed"; else echo "  tenant thread: no route list, everything allowed"; fi

# ── 4. Thread on Railway ────────────────────────────────────────────────────────────────────────────────────────
step "4/5 Thread on Railway: MUX_BASE_URL and MUX_API_KEY"
TP=$(railway list --json 2>/dev/null | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const d=JSON.parse(s);const l=Array.isArray(d)?d:d.projects??[];const p=l.find(p=>/^thread$/i.test(p.name))||l.find(p=>/thread/i.test(p.name));if(p)console.log(p.id)})') || true
if [ -z "$TP" ]; then
  echo "✗ no Railway project named thread for this login: set MUX_BASE_URL=$GW and MUX_API_KEY (from $KEY_FILE) on Thread by hand"
else
  LINK=$(mktemp -d /tmp/thread-link.XXXXXX)
  ( cd "$LINK" && railway link -p "$TP" -e production >/dev/null
    SVC=$(railway status --json 2>/dev/null | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const d=JSON.parse(s);const e=(d.services?.edges??[]).map(x=>x.node);const n=e.find(x=>/thread/i.test(x.name))||e[0];if(n)console.log(n.name)}catch{}})')
    SVC=${SVC:-thread}
    CUR=$(railway variables --kv -s "$SVC" 2>/dev/null)
    if printf '%s\n' "$CUR" | grep -qx "MUX_API_KEY=$KEY" && printf '%s\n' "$CUR" | grep -qx "MUX_BASE_URL=$GW"; then
      echo "✓ Thread ($SVC) already uses the thread tenant's key"
    else
      railway variables -s "$SVC" --set "MUX_BASE_URL=$GW" --set "MUX_API_KEY=$KEY" >/dev/null && echo "✓ Thread ($SVC): MUX_BASE_URL and MUX_API_KEY set; Railway redeploys it (a short downtime: it has a volume)"
    fi ) || echo "✗ could not set Thread's variables: set them by hand"
  rm -rf "$LINK"
fi

# ── 5. Checks ───────────────────────────────────────────────────────────────────────────────────────────────────
step "5/5 every capability Thread uses, with its key, through $GW"
T=$(mktemp -d /tmp/thread-check.XXXXXX)
H="Authorization: Bearer $KEY"
ROWS=""
row() { ROWS="$ROWS$1|$2|$3
"; }
check() { # name, expect (json|bytes), curl args…
  name=$1 kind=$2; shift 2
  code=$(curl -s -m 600 -D "$T/h" -o "$T/$name" -w '%{http_code}' -H "$H" "$@") || code=000
  model=$(grep -i '^x-mux-model' "$T/h" 2>/dev/null | cut -d' ' -f2 | tr -d '\r')
  if [ "$code" = 200 ]; then row "$name" "✓" "$model"; else row "$name" "✗ HTTP $code" "$(head -c 160 "$T/$name" | tr '\n' ' ')"; fi
}
J="content-type: application/json"
check chat-fast json -H "$J" "$GW/v1/chat/completions" -d '{"model":"fast","max_tokens":10,"messages":[{"role":"user","content":"Reply OK"}]}'
check chat-auto json -H "$J" "$GW/v1/chat/completions" -d '{"model":"auto","max_tokens":10,"messages":[{"role":"user","content":"Reply OK"}]}'
check vision json -H "$J" "$GW/v1/chat/completions" -d '{"model":"vision","max_tokens":10,"messages":[{"role":"user","content":[{"type":"text","text":"Colour?"},{"type":"image_url","image_url":{"url":"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAEklEQVR4nGP4z8CAFWEXHbQSACj/P8Fu7N9hAAAAAElFTkSuQmCC"}}]}]}'
check messages json -H "$J" -H "anthropic-version: 2023-06-01" "$GW/v1/messages" -d '{"model":"claude-opus-5-5","max_tokens":10,"messages":[{"role":"user","content":"Reply OK"}]}'
check search json -H "$J" "$GW/v1/search" -d '{"query":"FLUX.2 klein licence"}'
check image json -H "$J" "$GW/v1/images/generations" -d '{"model":"image","prompt":"a red apple on a wooden table","size":"512x512","n":1,"response_format":"b64_json","seed":3}'
node -e 'const f=require("fs");f.writeFileSync(process.argv[2],Buffer.from(JSON.parse(f.readFileSync(process.argv[1],"utf8")).data[0].b64_json,"base64"))' "$T/image" "$T/in.png" 2>/dev/null || true
if [ -s "$T/in.png" ]; then
  check edit json -F model=image-edit -F prompt="make the apple green" -F response_format=b64_json -F "image=@$T/in.png;type=image/png" "$GW/v1/images/edits"
  check inpaint json -F model=image-edit -F prompt="a blue cup" -F response_format=b64_json -F "image=@$T/in.png;type=image/png" -F "mask=@$T/in.png;type=image/png" "$GW/v1/images/edits"
else row edit "✗ skipped" "no image to edit"; row inpaint "✗ skipped" "no image to edit"; fi
check speak bytes -H "$J" "$GW/v1/audio/speech" -d '{"model":"speak","input":"Hello from Thread.","response_format":"mp3"}'
if [ -s "$T/speak" ] && ! head -c 1 "$T/speak" | grep -q '{'; then cp "$T/speak" "$T/a.mp3"; else
  curl -s -m 60 -H "$H" -H "$J" "$GW/v1/audio/speech" -d '{"model":"mac-studio/bloom-kokoro-en","input":"Hello from Thread.","response_format":"mp3"}' -o "$T/a.mp3"; fi
check transcribe json -F model=transcribe -F response_format=verbose_json -F "file=@$T/a.mp3;type=audio/mpeg" "$GW/v1/audio/transcriptions"
check transcribe-da json -F model=transcribe-da -F "file=@$T/a.mp3;type=audio/mpeg" "$GW/v1/audio/transcriptions"
# Video: a 1 s job, followed until done
VID=$(curl -s -m 60 -H "$H" -H "$J" "$GW/v1/videos/generations" -d '{"model":"video","prompt":"a red apple turning slowly on a table","seconds":1,"fps":8,"size":"832x480"}')
VID_ID=$(printf %s "$VID" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{console.log(JSON.parse(s).id||"")}catch{console.log("")}})')
if [ -z "$VID_ID" ]; then row video "✗" "$(printf %s "$VID" | head -c 160)"; else
  st=queued; i=0
  while [ "$st" = queued ] || [ "$st" = running ]; do
    sleep 10; i=$((i + 10)); [ $i -lt 1500 ] || { st=timeout; break; }
    st=$(curl -s -m 30 -H "$H" "$GW/v1/videos/$VID_ID" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{console.log(JSON.parse(s).status)}catch{console.log("unknown")}})')
  done
  if [ "$st" = succeeded ] && curl -sf -m 120 -H "$H" -o "$MUX_HOME/logs/thread-ready-test.mp4" "$GW/v1/videos/$VID_ID/content"; then row video "✓" "1 s clip in $i s: ~/.mux/logs/thread-ready-test.mp4"
  else row video "✗ $st" "job $VID_ID"; fi
fi
HEALTH=$(curl -s -m 20 https://thread-production-c43ca674.up.railway.app/api/health | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const d=JSON.parse(s);const m=d.providers.find(p=>p.id==="mux");console.log(m&&m.available&&!d.mock?"ok":"mux not available")}catch{console.log("no answer")}})')
[ "$HEALTH" = ok ] && row thread-app "✓" "Thread's /api/health: mux available" || row thread-app "✗" "Thread's /api/health: $HEALTH (it may still be redeploying)"
rm -rf "$T"

step "result"
printf '%s' "$ROWS" | awk -F'|' '{ printf "  %-14s %-14s %s\n", $1, $2, $3 }'
[ "$VIDEO" = ok ] || echo "  (setup-video.sh stopped; its log: $MUX_HOME/logs/setup-video.log)"
BAD=$(printf '%s' "$ROWS" | grep -c '|✗' || true)
if [ "$BAD" = 0 ]; then echo "✓ Thread: everything it uses on mux works"; notify "Thread: everything on mux works"
else echo "✗ $BAD not working: see the table"; notify "Thread: $BAD capabilities not working, see thread-ready.log"; exit 1; fi
