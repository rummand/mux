#!/bin/sh
# Identity edits on this Mac (Thread's fashion try-on: a person and garments in one picture), as a second model of the
# image server: FLUX 3 Image Klein (Black Forest Labs, FLUX Kommunity License v1.0 — non-commercial use; allowed: we
# are research) through mflux (MLX), pre-quantised to 8 bits. Measurements, licence, what is proven: docs/image-edit.md.
#   ./deploy/image-edit-hq.sh             fetch the pinned weights (9.9 GB, checked by SHA-256) and the licence, then
#                                         ./deploy/images.sh --q4 --keep (it adds the model flux3-image-klein-q8 and the
#                                         route image-edit-hq when the weights are there), then one test edit
#   ./deploy/image-edit-hq.sh --no-test   the same without the test edit
#   ./deploy/image-edit-hq.sh --railway   after that, the route image-edit-hq on Railway mux and allowed for `thread`
# One model in memory at a time: the image server (com.mux.images, :8312) lets klein go before FLUX 3 loads, and the
# other way round; the same 2 GB MLX cache cap and 10-minute idle let-go. Nothing loaded now is unloaded.
set -eu
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
MUX_HOME="$HOME/.mux"
VENV="$MUX_HOME/images-venv"
PORT=8312
HQ_ID=flux3-image-klein-q8
REPO=mflux-community/flux-3-image-klein-mflux-q8
REV=7e46237dea3999a9792959f5e000aeb1b9f9e7df
DIR="$MUX_HOME/models/flux-3-image-klein-mflux-q8"
# The licence and notice come from Black Forest Labs' own (gated) repository: accept its terms on Hugging Face once
# (https://huggingface.co/black-forest-labs/flux-3-image-klein) and `hf auth login`.
LICENSE_REPO=black-forest-labs/flux-3-image-klein
LICENSE_REV=09561231f44e41381c461caf53d5452005a60ac9
LICENSE_SHA=100a3a5af8f1a2943dca0d127671bcaa93ad894a63330825219f1a0a44451f22
# SHA-256 of every weight file, from the Hub's LFS records at $REV (checked on this Mac 2026-11-17)
FILES="text_encoder/0.safetensors 600652856574e9f347866a481ab03ecf8a99086e7a84d0fcea5c1be339ea9032
text_encoder/1.safetensors 04fd5c383b8b41c3e0882c93d0def127370aa985847f24678945defdd6723707
text_encoder/tokenizer.json be75606093db2094d7cd20f3c2f385c212750648bd6ea4fb2bf507a6a4c55506
transformer/0.safetensors 35978e837374f61578ff7ab5cbb7084e24f2ff2fb03b5f2c11e007f1d34a7c4a
transformer/1.safetensors c163baf4a4ab7ea8920a666557c8e711eb5077b8e5120a0c44af08ace7e4f1ee
transformer/2.safetensors 70c523328bec015552c712e803ff4982b712bf2876c368151b7dbde0eaa5026c
vae/0.safetensors 94068882f83f537035d4353c19a8fa0d0b9d0294ee3ad8834ef5e1eecc960861"
TEST=1 RAILWAY=
for a in "$@"; do case "$a" in --no-test) TEST= ;; --railway) RAILWAY=1 ;; *) echo "unknown flag $a"; exit 2 ;; esac; done
[ "$(uname -s)" = Darwin ] && [ "$(uname -m)" = arm64 ] || { echo "Run this on the Mac (Apple Silicon)."; exit 2; }
. "$MUX_HOME/mux.env"
sha() { shasum -a 256 "$1" | awk '{ print $1 }'; }
js() { node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const j=JSON.parse(s);$1})"; }

echo "→ mflux 0.24.0 (FLUX 3 Image Klein's edit pipeline) in $VENV"
[ -x "$VENV/bin/python" ] || { echo "✗ no $VENV: run ./deploy/images.sh --q4 first"; exit 1; }
"$VENV/bin/python" -c "from mflux.models.flux3.variants import Flux3KleinEdit" 2>/dev/null || "$VENV/bin/pip" install -q "mflux==0.24.0"

echo "→ weights $REPO @ ${REV%"${REV#???????}"} into $DIR"
if [ ! -f "$DIR/transformer/0.safetensors" ]; then
  FREE_GB=$(df -g "$MUX_HOME/models" | awk 'NR == 2 { print $4 }')
  [ "$FREE_GB" -ge 25 ] || { echo "✗ only $FREE_GB GB free: 9.9 GB to fetch and 15 GB to keep free"; exit 1; }
  "$VENV/bin/hf" download "$REPO" --revision "$REV" --local-dir "$DIR"
fi
printf '%s\n' "$FILES" | while read -r f want; do
  [ -f "$DIR/$f" ] || { echo "✗ missing $DIR/$f"; exit 1; }
  [ "$(sha "$DIR/$f")" = "$want" ] || { echo "✗ $DIR/$f is not the pinned file (SHA-256 differs): delete $DIR and run again"; exit 1; }
done
echo "  SHA-256 of all 7 weight files match"

echo "→ licence beside the weights (FLUX Kommunity License v1.0, from $LICENSE_REPO)"
if [ ! -f "$DIR/LICENSE.md" ]; then
  "$VENV/bin/hf" download "$LICENSE_REPO" LICENSE.md --revision "$LICENSE_REV" --local-dir "$DIR" >/dev/null \
    || { echo "✗ could not fetch the licence: accept it on https://huggingface.co/$LICENSE_REPO and run $VENV/bin/hf auth login"; exit 1; }
fi
[ "$(sha "$DIR/LICENSE.md")" = "$LICENSE_SHA" ] || { echo "✗ $DIR/LICENSE.md is not the licence that was read (SHA-256 differs): read it again before serving"; exit 1; }
cat > "$DIR/NOTICE" <<'N'
This FLUX Model is licensed by Black Forest Labs Inc. under the FLUX Kommunity License. Copyright Black Forest Labs Inc.
IN NO EVENT SHALL BLACK FOREST LABS INC. BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF
CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH USE OF THIS MODEL.
These weights are mflux-community's 8-bit MLX conversion (mflux-community/flux-3-image-klein-mflux-q8), not an official
release; the text encoder is Qwen3-VL-4B-Instruct (Apache-2.0). mux serves them unchanged.
N

echo "→ the image server with the second model: ./deploy/images.sh --q4 --keep"
sh "$ROOT/deploy/images.sh" --q4 --keep

if [ -n "$TEST" ]; then
  echo "→ a test edit on image-edit-hq, straight from the image server (the first one loads the model, ~10 s)"
  T=$(mktemp -d /tmp/image-edit-hq.XXXXXX)
  curl -sf -m 600 -H "content-type: application/json" -d '{"prompt":"A plain white ceramic mug on a wooden table, soft morning light, photograph","size":"512x512","seed":5}' \
    "http://127.0.0.1:$PORT/v1/images/generations" | js 'require("fs").writeFileSync(process.argv[1],Buffer.from(j.data[0].b64_json,"base64"))' "$T/in.png"
  S=$(date +%s)
  curl -sf -m 1200 -F model=image-edit-hq -F seed=5 -F size=512x512 -F "image=@$T/in.png;type=image/png" \
    -F prompt="A plain cobalt-blue ceramic mug on a wooden table, soft morning light, photograph" \
    "http://127.0.0.1:$PORT/v1/images/edits" | js 'if(j.model!=="'$HQ_ID'")throw new Error("answered by "+j.model);require("fs").writeFileSync(process.argv[1],Buffer.from(j.data[0].b64_json,"base64"))' "$MUX_HOME/logs/image-edit-hq-test.png"
  echo "  wrote $MUX_HOME/logs/image-edit-hq-test.png in $(( $(date +%s) - S )) s (load included)"
  rm -rf "$T"
fi

if [ -n "$RAILWAY" ]; then
  echo "→ Railway mux: route image-edit-hq → mac-studio/$HQ_ID (then mac-studio/flux2-klein-4b-q4), allowed for thread"
  . "$MUX_HOME/railway.env"
  GW="${MUX_GATEWAY_URL:-https://mux-production-0b55.up.railway.app}"
  gw() { curl -sf -X "$1" -H "Authorization: Bearer $MUX_GATEWAY_ADMIN_TOKEN" -H "content-type: application/json" ${3:+-d "$3"} "$GW/api/admin$2"; }
  i=0; until gw GET /models | js 'process.exit(j.some(m=>m.id==="mac-studio/'$HQ_ID'"&&m.enabled)?0:1)' 2>/dev/null; do i=$((i + 5)); [ $i -lt 180 ] || { echo "✗ the gateway has not synced mac-studio/$HQ_ID"; exit 1; }; sleep 5; done
  gw PUT /routes/image-edit-hq '{"kind":"image","strategy":"priority","candidates":["mac-studio/'$HQ_ID'","mac-studio/flux2-klein-4b-q4"]}' >/dev/null
  gw GET /tenants | js 'for (const t of j) if (t.id === "thread" && t.allowed.length && !t.allowed.includes("image-edit-hq")) console.log(JSON.stringify({ allowed: [...t.allowed, "image-edit-hq"] }))' > "$MUX_HOME/logs/image-edit-hq-tenant.json"
  [ -s "$MUX_HOME/logs/image-edit-hq-tenant.json" ] && gw PUT /tenants/thread "$(cat "$MUX_HOME/logs/image-edit-hq-tenant.json")" >/dev/null && echo "  thread: image-edit-hq allowed"
  echo "  ✓ Railway mux: route image-edit-hq"
fi
echo "✓ image-edit-hq: $HQ_ID on :$PORT — POST /v1/images/edits with model image-edit-hq on mux"
