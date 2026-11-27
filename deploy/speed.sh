#!/bin/sh
# Bloom's answers fast on this Mac (owner, 27 November 2026: "the model should always be hot, not unloaded — do the
# performance you can do with the necessary setup"; "give Bloom's live answers priority"). Idempotent; prints before
# and after.
#
#   ./deploy/speed.sh             1. prints what is loaded, pinned and hot, the memory, the routes, and measures chat
#                                    latency as it is (deploy/chat-latency.mjs, one-day key of bloom's test tenant)
#                                 2. the memory plan: the model behind the Mac's `agent` and the Mac model Railway's
#                                    `agent` starts with, pinned (never unloaded by idle timers or for room; the healer
#                                    restarts a pinned model at once; a warm-up turn after each load), with room left
#                                    for the hear sidecar (~2.5 GB), the face (5.3 GB peak) and Kokoro; refused, in
#                                    words, if they do not fit
#                                 3. the trials that do not work yet stop: Haru (failed its forced-text test) and
#                                    MiniCPM-o (no speech): their launchd agents are stopped and their models disabled
#                                    (./deploy/haru.sh, ./deploy/minicpm-o.sh bring them back)
#                                 4. the hot models' interactive settings: 2+ slots (one kept for a person),
#                                    `--cache-reuse 256` (a follow-up turn reuses the conversation's cached prefix),
#                                    ngram speculation kept; priority on; thinking off for interactive turns
#                                 5. measures again, priority off then on under a background load, and prints both
#   ./deploy/speed.sh --railway   also on Railway: drops from its `agent` the Mac models that cannot answer now (not
#                                 loaded and not pinned, or their server down), saved to ~/.mux/speed-railway-agent.json
#                                 to put back; then measures through Railway as bloom-for-business (one-day key)
#   ./deploy/speed.sh --no-test   without the measurements
# Needs mux on this Mac built with the Speed page (git pull --ff-only && npm ci && npm run build && launchctl kickstart
# -k gui/$(id -u)/com.mux.server; the script says so). Keys and tokens are never printed.
set -eu
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
MUX_HOME="$HOME/.mux"
RAILWAY= TEST=1
for a in "$@"; do case "$a" in --railway) RAILWAY=1 ;; --no-test) TEST= ;; *) echo "unknown flag $a"; exit 2 ;; esac; done
. "$MUX_HOME/mux.env"
BASE="http://127.0.0.1:${MUX_PORT:-7070}"
MUX="$BASE/api/admin"
api() { curl -sf -X "$1" -H "Authorization: Bearer $MUX_ADMIN_TOKEN" -H "content-type: application/json" ${3:+-d "$3"} "$MUX$2"; }
js() { node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const j=JSON.parse(s);$1})"; }
T=$(mktemp -d /tmp/mux-speed.XXXXXX); trap 'rm -rf "$T"' EXIT
# Outside mux's model budget, on the same Mac: the hear sidecar, the face's peak, Kokoro (GB)
EXTRA_GB=8.3

api GET /speed/live > /dev/null || { echo "✗ mux on this Mac has no Speed page yet: git pull --ff-only && npm ci && npm run build && launchctl kickstart -k gui/\$(id -u)/com.mux.server"; exit 1; }

state() {
  api GET /system > "$T/system.json"; api GET /models > "$T/models.json"; api GET /routes > "$T/routes.json"; api GET /speed/live > "$T/live.json"
  node -e '
    const fs = require("fs"); const r = (f) => JSON.parse(fs.readFileSync(process.argv[1] + "/" + f));
    const sys = r("system.json"), models = r("models.json"), routes = r("routes.json"), live = r("live.json");
    const by = new Map(models.map((m) => [m.id, m]));
    console.log(`  memory: ${sys.system.memFreeGb.toFixed(1)} of ${sys.system.memTotalGb.toFixed(0)} GB free; mux budget ${sys.budget.usedGb.toFixed(1)} of ${sys.budget.budgetGb} GB used; priority ${live.priority.enabled ? "on" : "off"}, ${live.priority.reserveSlots} slot kept`);
    for (const i of sys.instances) { const m = by.get(i.id) ?? {}; console.log(`  ${i.state === "ready" ? "●" : "○"} ${i.id.padEnd(28)} ${i.state.padEnd(8)} ~${i.estimateGb} GB${i.rssGb ? ` (${i.rssGb.toFixed(1)} held)` : ""}${m.pinned ? " pinned" : ""} · ${m.parallel} slots · ${(m.extra_args ?? []).join(" ") || "no extra flags"}`); }
    for (const m of models.filter((m) => m.pinned && !sys.instances.some((i) => i.id === m.id))) console.log(`  ○ ${m.id.padEnd(28)} pinned but NOT loaded`);
    for (const h of live.hot.filter((h) => h.lastUnload)) console.log(`    ${h.id}: last went ${new Date(h.lastUnload.at).toISOString().slice(11, 19)} UTC (${h.lastUnload.why}), ${h.unloads24h} in 24 h`);
    const agent = routes.find((x) => x.name === "agent"); console.log(`  the Mac'"'"'s agent route: ${agent ? agent.candidates.join(" → ") || "(empty)" : "(none)"}`);
  ' "$T"
}

KEY_ID=""
mkkey() { # $1 base url, $2 admin token, $3 tenant → $T/key
  curl -sf -X POST -H "Authorization: Bearer $2" -H "content-type: application/json" -d '{"name":"speed.sh check (one day)","expiresInDays":1}' "$1/api/admin/tenants/$3/keys" > "$T/key.json"
  KEY_ID=$(js 'console.log(j.record.id)' < "$T/key.json"); js 'console.log(j.key)' < "$T/key.json" > "$T/key"; rm -f "$T/key.json"
}
rmkey() { curl -s -o /dev/null -X DELETE -H "Authorization: Bearer $2" "$1/api/admin/keys/$KEY_ID"; rm -f "$T/key"; }
measure() { # $1 url, $2 label, $3.. chat-latency flags
  u="$1"; l="$2"; shift 2
  echo "→ chat latency, $l"
  MUX_KEY="$(cat "$T/key")" MUX_ADMIN_TOKEN="${ADMIN_FOR_MEASURE:-}" node "$ROOT/deploy/chat-latency.mjs" --url "$u" --model agent --turns 10 --background 3 --json "$MUX_HOME/logs/speed-$l-$(date +%Y%m%d-%H%M).json" "$@" || echo "  ✗ the measurement failed (see above)"
}

echo "== Before"
state
if [ -n "$TEST" ]; then mkkey "$BASE" "$MUX_ADMIN_TOKEN" bloom-design-composer-test; measure "$BASE" before; rmkey "$BASE" "$MUX_ADMIN_TOKEN"; fi

echo "== The memory plan"
RW_FIRST=""
if [ -n "$RAILWAY" ]; then
  . "$MUX_HOME/railway.env"
  GW="${MUX_GATEWAY_URL:-https://mux-production-0b55.up.railway.app}"
  gw() { curl -sf -X "$1" -H "Authorization: Bearer $MUX_GATEWAY_ADMIN_TOKEN" -H "content-type: application/json" ${3:+-d "$3"} "$GW/api/admin$2"; }
  gw GET /routes > "$T/gw-routes.json"; gw GET /models > "$T/gw-models.json"
  # The first of Railway's agent candidates that is a model of this Mac: its name here
  RW_FIRST=$(node -e '
    const fs = require("fs"); const routes = JSON.parse(fs.readFileSync(process.argv[1])), models = JSON.parse(fs.readFileSync(process.argv[2]));
    const a = routes.find((r) => r.name === "agent"); const m = (a?.candidates ?? []).map((c) => models.find((x) => x.id === c)).find((x) => x?.backend === "node");
    console.log(m?.upstream_model ?? "")' "$T/gw-routes.json" "$T/gw-models.json")
  echo "  Railway's agent starts on this Mac with: ${RW_FIRST:-(none)}"
fi
api GET /system > "$T/system.json"; api GET /models > "$T/models.json"; api GET /routes > "$T/routes.json"
node -e '
  const fs = require("fs"); const r = (f) => JSON.parse(fs.readFileSync(process.argv[1] + "/" + f));
  const sys = r("system.json"), models = r("models.json"), routes = r("routes.json");
  const rw = process.argv[2], extra = Number(process.argv[3]);
  const by = new Map(models.map((m) => [m.id, m]));
  const localOf = (name) => (routes.find((x) => x.name === name)?.candidates ?? []).find((c) => by.get(c)?.enabled && ["llamacpp", "mlx"].includes(by.get(c)?.backend));
  // The interactive route first (qwen3.6, thinking off: 92 tok/s and ~140 ms to its first token warm), then the Mac'"'"'s
  // agent, then what Railway'"'"'s agent starts with (Inkling: 29 tok/s, always reasons) only if it fits beside them
  const inter = localOf("interactive") ?? (by.get("qwen3.6-35b-a3b")?.enabled ? "qwen3.6-35b-a3b" : localOf("agent"));
  const want = [...new Set([inter, localOf("agent"), rw].filter((x) => x && by.has(x)))];
  // Small helpers already pinned stay pinned, whatever their kind (embeddings; arch-router, the intent router, is a chat model): part of every turn
  const small = models.filter((m) => m.pinned && !want.includes(m.id) && m.estimateGb <= 3).map((m) => m.id);
  const others = models.filter((m) => m.pinned && !want.includes(m.id) && !small.includes(m.id)).map((m) => m.id);
  const gb = (id) => { const m = by.get(id); const i = sys.instances.find((x) => x.id === id); return Math.max(m.estimateGb ?? 0, i?.rssGb ?? 0); };
  let keep = [], used = small.reduce((a, id) => a + gb(id), 0);
  const free = sys.system.memTotalGb - extra - sys.budget.headroomGb;
  for (const id of want) {
    const need = gb(id);
    if (used + need <= sys.budget.budgetGb && used + need <= free) { keep.push(id); used += need; }
    else console.log(`  ✗ ${id} (~${need.toFixed(1)} GB) does not fit beside ${[...small, ...keep].join(", ") || "nothing"} (${used.toFixed(1)} GB of a ${sys.budget.budgetGb} GB budget; ${free.toFixed(1)} GB for models after the voice services and the headroom): not pinned`);
  }
  console.log(`  pin: ${[...keep, ...small].join(", ") || "nothing"}  ·  ${used.toFixed(1)} GB of mux'"'"'s ${sys.budget.budgetGb} GB, ${(sys.budget.budgetGb - used).toFixed(1)} GB left for models that load on demand`);
  console.log(`  beside them on the Mac: hear ~2.5 GB, the face 5.3 GB at its peak, Kokoro ~0.5 GB, ${sys.budget.headroomGb} GB headroom (${sys.system.memTotalGb.toFixed(0)} GB in all)`);
  if (others.length) console.log(`  unpin (pinned, not part of a live turn): ${others.join(", ")}`);
  fs.writeFileSync(process.argv[1] + "/plan.json", JSON.stringify({ keep, small, others, inter: keep.includes(inter) ? inter : "" }));
' "$T" "$RW_FIRST" "$EXTRA_GB"

KEEP=$(js 'console.log(j.keep.join(" "))' < "$T/plan.json")
OTHERS=$(js 'console.log(j.others.join(" "))' < "$T/plan.json")
for id in $OTHERS; do api PATCH "/models/$id" '{"pinned":false}' > /dev/null && echo "  unpinned $id"; done

echo "== The trials that do not work yet"
for t in haru-4b:com.mux.haru minicpm-o-4.5:com.mux.minicpm-o; do
  id=${t%%:*}; label=${t#*:}
  if launchctl print "gui/$(id -u)/$label" > /dev/null 2>&1; then launchctl bootout "gui/$(id -u)/$label" 2>/dev/null && echo "  stopped $label"; fi
  if api GET /models | js "process.exit(j.some(m => m.id === '$id' && (m.enabled || m.pinned)) ? 0 : 1)"; then api PATCH "/models/$id" '{"enabled":false,"pinned":false}' > /dev/null && echo "  disabled $id (./deploy/${id%%-*}.sh brings it back)"; else echo "  $id: already off"; fi
done

echo "== Hot and quick: ${KEEP:-nothing}"
for id in $KEEP; do
  api GET /models | node -e '
    let s=""; process.stdin.on("data",d=>s+=d).on("end",()=>{
      const m = JSON.parse(s).find((x) => x.id === process.argv[1]); const patch = { pinned: true };
      if (m.backend === "llamacpp") {
        const a = [...m.extra_args];
        if (!a.includes("--cache-reuse")) a.push("--cache-reuse", "256");
        if (JSON.stringify(a) !== JSON.stringify(m.extra_args)) patch.extra_args = a;
        if ((m.parallel ?? 1) < 2 && !a.includes("--parallel") && !a.includes("-np")) patch.parallel = 2;
      }
      console.log(JSON.stringify(patch));
      console.error(`  ${m.id}: pinned${patch.extra_args ? ", --cache-reuse 256" : ""}${patch.parallel ? ", 2 slots (one kept for a person)" : ""}${(m.extra_args ?? []).includes("--spec-type") ? "; ngram speculation kept" : ""}${m.reasoning !== "off" ? "; thinking off for interactive turns (settings.interactiveNoThinking)" : ""}`);
    })' "$id" > "$T/patch.json"
  api PATCH "/models/$id" "$(cat "$T/patch.json")" > /dev/null
  printf "  loading %s … " "$id"; if api POST "/models/$id/load" > /dev/null; then echo "hot"; else echo "✗ did not load (see the Speed page and ~/.mux/logs/models/$id.log)"; fi
done
api PATCH /settings '{"interactiveNoThinking":true,"pauseCiForVoice":true}' > /dev/null && echo "  thinking off for interactive turns; CI pauses while a voice session is open"
INTER=$(js 'console.log(j.inter)' < "$T/plan.json")
if [ -n "$INTER" ]; then
  # The route a person's turn names (`model: "interactive"`): the hot model alone, so a turn never falls through to a cold one
  api PUT /routes/interactive "{\"kind\":\"chat\",\"strategy\":\"priority\",\"candidates\":[\"$INTER\"],\"description\":\"A person is waiting: the always-hot model with thinking off (deploy/speed.sh)\"}" > /dev/null && echo "  route interactive → $INTER"
  api GET /tenants | js 'for (const t of j) if (t.allowed.length && !t.allowed.includes("interactive") && /bloom/.test(t.id)) console.log(t.id)' | while read -r t; do
    api GET /tenants | js "const t=j.find(x=>x.id==='$t'); console.log(JSON.stringify({allowed:[...t.allowed,'interactive']}))" > "$T/allowed.json"
    api PUT "/tenants/$t" "$(cat "$T/allowed.json")" > /dev/null && echo "  $t may use interactive"
  done
fi

if [ -n "$RAILWAY" ]; then
  echo "== Railway's agent: only models that can answer"
  api GET /models > "$T/models.json"; api GET /system > "$T/system.json"
  node -e '
    const fs = require("fs"); const routes = JSON.parse(fs.readFileSync(process.argv[1])), gwModels = JSON.parse(fs.readFileSync(process.argv[2])), mac = JSON.parse(fs.readFileSync(process.argv[3])), sys = JSON.parse(fs.readFileSync(process.argv[4]));
    const a = routes.find((r) => r.name === "agent"); if (!a) { fs.writeFileSync(process.argv[5], JSON.stringify({ before: [], after: [], dead: [] })); process.exit(0); }
    // Dropped only what can never answer now: missing or disabled on this Mac, or too big to load beside the pinned models
    // (a model that loads on demand stays: Inkling for deep work); a service that is down is checked below
    const pinnedGb = mac.filter((m) => m.pinned).reduce((a, m) => a + (m.estimateGb ?? 0), 0);
    const dead = []; const keep = [];
    for (const c of a.candidates) {
      const g = gwModels.find((x) => x.id === c); const m = g?.backend === "node" ? mac.find((x) => x.id === g.upstream_model) : null;
      const local = m && ["llamacpp", "mlx"].includes(m.backend);
      if (g?.backend === "node" && (!m || !m.enabled || (local && !m.pinned && (m.estimateGb ?? 0) > sys.budget.budgetGb - pinnedGb))) dead.push(c); else keep.push(c);
    }
    fs.writeFileSync(process.argv[5], JSON.stringify({ before: a.candidates, after: keep, dead }));
  ' "$T/gw-routes.json" "$T/gw-models.json" "$T/models.json" "$T/system.json" "$T/rw.json"
  DEAD=$(js 'console.log(j.dead.join(" "))' < "$T/rw.json")
  # A Mac model behind a service of its own (MTPLX for qwen3.8-flash-next): down when its server does not answer
  for c in $(js 'console.log(j.after.join(" "))' < "$T/rw.json"); do
    up=$(js "const m=j.find(x=>x.id==='$c'); console.log(m?.backend==='node' ? m.upstream_model : '')" < "$T/gw-models.json")
    [ -n "$up" ] || continue
    url=$(api GET /models | js "const m=j.find(x=>x.id==='$up'); console.log(m && m.backend==='external' && m.base_url ? m.base_url : '')")
    if [ -n "$url" ] && ! curl -sf -m 3 "${url%/}/models" > /dev/null; then DEAD="$DEAD $c"; fi
  done
  if [ -n "$(echo "$DEAD" | tr -d ' ')" ]; then
    [ -f "$MUX_HOME/speed-railway-agent.json" ] || cp "$T/rw.json" "$MUX_HOME/speed-railway-agent.json"
    NEW=$(node -e 'const j=JSON.parse(require("fs").readFileSync(process.argv[1]));const dead=new Set(process.argv[2].split(" ").filter(Boolean));console.log(JSON.stringify({candidates:j.before.filter(c=>!dead.has(c))}))' "$T/rw.json" "$DEAD")
    gw PUT /routes/agent "$NEW" > /dev/null && echo "  Railway agent: dropped$DEAD (the old list is in ~/.mux/speed-railway-agent.json)"
  else echo "  Railway agent: every candidate can answer"; fi
  gw GET /routes | js 'console.log("  Railway agent now: " + (j.find(r => r.name === "agent")?.candidates ?? []).join(" → "))'
  if [ -n "$INTER" ]; then
    GWI=$(js "const m=j.find(x=>x.backend==='node'&&x.upstream_model==='$INTER'); console.log(m?m.id:'')" < "$T/gw-models.json")
    if [ -n "$GWI" ]; then gw PUT /routes/interactive "{\"kind\":\"chat\",\"strategy\":\"priority\",\"candidates\":[\"$GWI\"],\"description\":\"A person is waiting: the Mac's always-hot model with thinking off (deploy/speed.sh)\"}" > /dev/null && echo "  Railway interactive → $GWI (Bloom asks for model \"interactive\" on its live paths; agent stays for deep work)"
    else echo "  ✗ Railway does not list $INTER from this Mac yet (sync the node on Railway's Providers page)"; fi
  fi
  # The gateway passes the class and the trace on to this Mac and keeps its own turn stats only with this change deployed
  if ! gw GET /speed/live > /dev/null 2>&1; then
    git -C "$ROOT" fetch -q origin main
    if git -C "$ROOT" cat-file -e origin/main:server/src/speed.ts 2>/dev/null; then
      echo "→ Railway mux: deploy origin/main (it has the Speed page)"
      WT=$(mktemp -d /tmp/mux-deploy.XXXXXX) && rmdir "$WT"
      git -C "$ROOT" worktree add --detach "$WT" origin/main >/dev/null
      (cd "$WT" && railway up --detach -p a5bf89be-0ec9-4d3d-afcc-40226c2a86f4 -e production -s mux) || echo "  ✗ railway up"
      git -C "$ROOT" worktree remove --force "$WT"
      i=0; until gw GET /speed/live > /dev/null 2>&1; do i=$((i + 10)); [ $i -lt 900 ] || { echo "  ✗ Railway has no Speed page after 15 min"; break; }; sleep 10; done
    else echo "  ✗ origin/main has no Speed page yet: merge the speed branch, then run this again with --railway"; fi
  fi
fi

echo "== Priority"
# On only once Railway passes the class on: until then every Railway call arrives here as `normal` (gateway-railway),
# and Bloom's answers would share what is left beside the reserved slot with OpenCode and the batch work
if [ -n "$RAILWAY" ] && gw GET /speed/live > /dev/null 2>&1; then
  api PATCH /settings '{"priorityEnabled":true}' > /dev/null && echo "  priority on: Railway sends x-mux-priority, and a person's turn gets the next slot (one kept for them)"
else
  api GET /settings | js 'console.log(j.priorityEnabled ? "  priority stays on" : "  ! priority left off: Railway does not pass the class on yet (run with --railway once the speed branch is on origin/main). The measurement below still compares off and on.")'
fi

echo "== After"
state
if [ -n "$TEST" ]; then
  mkkey "$BASE" "$MUX_ADMIN_TOKEN" bloom-design-composer-test
  ADMIN_FOR_MEASURE="$MUX_ADMIN_TOKEN" measure "$BASE" mac --compare
  if [ -n "$INTER" ]; then
    measure "$BASE" mac-interactive --model interactive
    # Thinking really off? A reasoning token on an interactive turn would show here (llama.cpp's --reasoning may win)
    api GET "/speed?priority=interactive&window=15m" | js 'const r = j.byPriority.interactive; console.log(r.reasoning.n ? `  ✗ ${r.reasoning.n} of ${r.n} interactive turns still reasoned first (first reasoning token p50 ${r.reasoning.p50} ms): turn reasoning off on the model itself` : `  ✓ no interactive turn reasoned (${r.n} turns)`)'
  fi
  rmkey "$BASE" "$MUX_ADMIN_TOKEN"
  if [ -n "$RAILWAY" ]; then
    mkkey "$GW" "$MUX_GATEWAY_ADMIN_TOKEN" bloom-for-business
    measure "$GW" railway
    rmkey "$GW" "$MUX_GATEWAY_ADMIN_TOKEN"
  fi
  echo "  The Speed page (/speed) has every turn above with its breakdown; put the before/after numbers in docs/speed.md (\"Priority\")."
fi
