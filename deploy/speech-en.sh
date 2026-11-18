#!/bin/sh
# English on the speak route, chosen by voice (the owner, 18 November 2026: "only an English voice is added to Mux's
# speak route. No new Danish voice"). The English voice is Kokoro's af_heart, the voice that already reads bloom for
# business's films: Kokoro-82M (Apache-2.0) served by Nexus's audio service (launchd com.nexus.audio, mlx_audio on
# 127.0.0.1:8093) and registered here as `bloom-kokoro-en`. Nothing new is installed and no Danish voice is added.
#   ./deploy/speech-en.sh            check Kokoro answers, give bloom-kokoro-en and piper-da their voices
#                                    (caps.voices: af_heart; the .onnx voices in ~/.mux/models/piper), keep both on
#                                    the route speak (Piper first, so Danish stays as it was), allow speak for bloom's
#                                    test tenant, then speak one English sentence through this mux with a one-day key
#                                    (revoked, proven 401, deleted)
#   ./deploy/speech-en.sh --no-test  the same without the sentence
#   ./deploy/speech-en.sh --railway  after that, Railway mux from a clean worktree of origin/main (it must have
#                                    router/audio.ts's byVoice), and wait until it has synced the voices.
#                                    bloom-for-business on Railway allows every route already.
# A request naming a voice goes to the model that lists it (router/audio.ts, byVoice): af_heart to Kokoro, Piper's
# voice to Piper; no voice, or one no model lists, keeps the route's order. Keys and tokens are never printed.
set -eu
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
MUX_HOME="$HOME/.mux"
KOKORO=http://127.0.0.1:8093/v1
VOICE=af_heart
TEST=1 RAILWAY=
for a in "$@"; do case "$a" in --no-test) TEST= ;; --railway) RAILWAY=1 ;; *) echo "unknown flag $a"; exit 2 ;; esac; done
. "$MUX_HOME/mux.env"
BASE="http://127.0.0.1:${MUX_PORT:-7070}"
MUX="$BASE/api/admin"
api() { curl -sf -X "$1" -H "Authorization: Bearer $MUX_ADMIN_TOKEN" -H "content-type: application/json" ${3:+-d "$3"} "$MUX$2"; }
js() { node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const j=JSON.parse(s);$1})"; }
umask 077
T=$(mktemp -d "${TMPDIR:-/tmp}/mux-speech-en.XXXXXX")
trap 'rm -rf "$T"' EXIT

echo "→ Kokoro on :8093 (com.nexus.audio)"
curl -sf -m 120 -o "$T/k.mp3" "$KOKORO/audio/speech" -H "content-type: application/json" \
  -d '{"model":"mlx-community/Kokoro-82M-bf16","input":"Kokoro answers.","voice":"'$VOICE'","response_format":"mp3"}' \
  || { echo "✗ Kokoro does not answer on :8093: Nexus's audio service (com.nexus.audio) must be running"; exit 1; }
echo "  ✓ $(wc -c < "$T/k.mp3" | tr -d ' ') bytes of mp3"

echo "→ the voices of the speech models"
api GET /models > "$T/models.json"
# Kokoro: registered by bloom's film tooling; registered here the same way if it is missing
node -e 'const j=require(process.argv[1]);process.exit(j.some(m=>m.id==="bloom-kokoro-en")?0:1)' "$T/models.json" || \
  api POST /models '{"id":"bloom-kokoro-en","display_name":"Bloom English documentation voice","kind":"speech","backend":"external","base_url":"'$KOKORO'","upstream_model":"mlx-community/Kokoro-82M-bf16","caps":{},"notes":"Kokoro-82M (Apache-2.0), voice af_heart, served by Nexus audio (com.nexus.audio, mlx_audio :8093)."}' >/dev/null
api GET /models > "$T/models.json"
PIPER_VOICES=$(ls "$MUX_HOME/models/piper/" 2>/dev/null | sed -n 's/\.onnx$//p' | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.stringify(s.split("\n").filter(Boolean))))')
for pair in "bloom-kokoro-en|[\"$VOICE\"]" "piper-da|$PIPER_VOICES"; do
  id=${pair%%|*}; voices=${pair#*|}
  body=$(node -e 'const j=require(process.argv[1]);const m=j.find(x=>x.id===process.argv[2]);if(!m)process.exit(3);console.log(JSON.stringify({caps:{...m.caps,voices:JSON.parse(process.argv[3])}}))' "$T/models.json" "$id" "$voices") \
    || { echo "  – $id is not registered here: skipped"; continue; }
  api PATCH "/models/$id" "$body" >/dev/null && echo "  $id: voices $voices"
done

echo "→ route speak"
api GET /routes > "$T/routes.json"
R=$(node -e 'const j=require(process.argv[1]);const r=j.find(x=>x.name==="speak");const c=r?r.candidates:[];for(const id of ["piper-da","bloom-kokoro-en"])if(!c.includes(id))c.push(id);console.log(JSON.stringify({kind:"speech",strategy:r?r.strategy:"priority",candidates:c,description:r?r.description:"Text to speech: OpenAI'"'"'s /v1/audio/speech"}))' "$T/routes.json")
api PUT /routes/speak "$R" >/dev/null && echo "  speak: $(echo "$R" | js 'console.log(j.candidates.join(" → "))')"
# bloom's test tenant on this Mac lists its routes: speak is added (the owner approved this one change)
api GET /tenants | js 'for (const t of j) if (t.id === "bloom-design-composer-test" && t.allowed.length && !t.allowed.includes("speak")) console.log(JSON.stringify({ allowed: [...t.allowed, "speak"] }))' > "$T/tenant.json"
if [ -s "$T/tenant.json" ]; then api PUT /tenants/bloom-design-composer-test "$(cat "$T/tenant.json")" >/dev/null && echo "  bloom-design-composer-test: speak allowed"; fi

if [ -n "$TEST" ]; then
  echo "→ one English sentence through this mux (route speak, voice $VOICE), as bloom's test tenant"
  api POST /tenants/bloom-design-composer-test/keys '{"name":"speech-en.sh check (one day)","expiresInDays":1}' > "$T/key.json"
  KEY_ID=$(js 'console.log(j.record.id)' < "$T/key.json")
  js 'console.log(j.key)' < "$T/key.json" > "$T/key"; rm -f "$T/key.json"
  code=$(curl -s -m 120 -o "$T/s.mp3" -D "$T/h.txt" -w '%{http_code}' "$BASE/v1/audio/speech" -H "Authorization: Bearer $(cat "$T/key")" \
    -H "content-type: application/json" -d '{"model":"speak","input":"This is the English voice on the speak route.","voice":"'$VOICE'","response_format":"mp3"}')
  model=$(sed -n 's/^x-mux-model: *//Ip' "$T/h.txt" | tr -d '\r')
  echo "  revoke: $(curl -s -o /dev/null -w '%{http_code}' -X DELETE -H "Authorization: Bearer $MUX_ADMIN_TOKEN" "$MUX/keys/$KEY_ID"), then the key answers $(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $(cat "$T/key")" "$BASE/v1/models")"
  rm -f "$T/key"
  [ "$code" = 200 ] && [ "$model" = bloom-kokoro-en ] || { echo "✗ speak answered $code from ${model:-nothing}"; exit 1; }
  echo "  ✓ 200 from $model, $(wc -c < "$T/s.mp3" | tr -d ' ') bytes"
fi

if [ -n "$RAILWAY" ]; then
  echo "→ Railway mux: deploy origin/main (it must have byVoice), then wait for the voices to sync"
  . "$MUX_HOME/railway.env"
  GW="${MUX_GATEWAY_URL:-https://mux-production-0b55.up.railway.app}"
  gw() { curl -sf -X "$1" -H "Authorization: Bearer $MUX_GATEWAY_ADMIN_TOKEN" -H "content-type: application/json" ${3:+-d "$3"} "$GW/api/admin$2"; }
  git -C "$ROOT" fetch -q origin main
  git -C "$ROOT" show origin/main:server/src/router/audio.ts | grep -q "export function byVoice" || { echo "✗ origin/main has no byVoice yet: merge it first"; exit 1; }
  WT=$(mktemp -d /tmp/mux-deploy.XXXXXX) && rmdir "$WT"
  git -C "$ROOT" worktree add --detach "$WT" origin/main >/dev/null
  (cd "$WT" && railway up --detach -p a5bf89be-0ec9-4d3d-afcc-40226c2a86f4 -e production -s mux) || { git -C "$ROOT" worktree remove --force "$WT"; echo "✗ railway up"; exit 1; }
  git -C "$ROOT" worktree remove --force "$WT"
  i=0; until gw GET /models | js 'process.exit(j.some(m=>m.id==="mac-studio/bloom-kokoro-en"&&(m.caps.voices||[]).includes("'$VOICE'"))?0:1)' 2>/dev/null; do i=$((i + 10)); [ $i -lt 900 ] || { echo "✗ the gateway has not synced the voices after 15 min"; exit 1; }; sleep 10; done
  echo "  ✓ Railway mux: mac-studio/bloom-kokoro-en has $VOICE; route speak: $(gw GET /routes | js 'console.log(j.find(r=>r.name==="speak").candidates.join(" → "))')"
  echo "  (the deploy itself is confirmed by railway deployment list -s mux: SUCCESS)"
fi
echo "✓ speak: English by voice $VOICE (bloom-kokoro-en), Danish as before (piper-da)"
