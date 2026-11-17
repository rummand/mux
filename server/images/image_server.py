"""Images for mux: OpenAI's POST /v1/images/generations and /v1/images/edits in front of mflux (MLX, open source).

Runs in ~/.mux/images-venv (python3.12 -m venv ~/.mux/images-venv && ~/.mux/images-venv/bin/pip install mflux).
The model is FLUX.2 [klein] 4B (Black Forest Labs, Apache-2.0): text to image, and editing from one or more input
images, in 4 steps. Text to image runs mflux's Flux2Klein, edits its Flux2KleinEdit (0.24's edit pipeline needs an input
image), one of them in memory at a time. Weights come from Hugging Face into HF_HUB_CACHE (deploy/images.sh points it at ~/.mux/models/hf and
fetches them first). The model loads on the first request and is let go after MUX_IMAGE_IDLE_MIN idle minutes, so
its ~9 GB (8-bit) go back to the chat models. MLX's buffer cache is capped (MUX_IMAGES_CACHE_GB, 2) and emptied after
every request: uncapped, it grew to 71 GB (2026-11-17). One image at a time: the GPU does one well, not two at half speed.
Started by deploy/images.sh as launchd agent com.mux.images on 127.0.0.1:8312. Images are never written to disk.

A second, stronger model for identity edits (Thread's try-on: a person and garments into one picture), on the same
server so that only one model is ever in memory, under the same lock, cache cap and idle let-go: MUX_IMAGE_HQ_MODEL
(the name it answers as, e.g. flux3-image-klein-q8), MUX_IMAGE_HQ_BASE_MODEL (its mflux architecture,
flux3-image-klein), MUX_IMAGE_HQ_MODEL_PATH (its pre-quantised weights, deploy/image-edit-hq.sh), MUX_IMAGE_HQ_STEPS
(16, the distilled checkpoint's own). A request whose `model` is that name, `image-edit-hq` or `image-hq` gets it;
every other request gets the fast model, as before. docs/image-edit.md has the measurements and the licence.

A pre-quantised local copy instead of the Hugging Face cache: MUX_IMAGE_MODEL_PATH (a directory of mflux weights, e.g.
~/.mux/models/flux2-klein-4b-mflux-q4, 4.6 GB, from deploy/images.sh --q4), MUX_IMAGE_BASE_MODEL the architecture it
is (flux2-klein-4b), MUX_IMAGE_MODEL the name it answers as (flux2-klein-4b-q4). Its quantisation is in the weights.
"""
import base64, concurrent.futures, email.parser, email.policy, gc, io, json, os, random, subprocess, sys, tempfile, threading, time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PORT = int(os.environ.get("MUX_IMAGES_PORT", "8312"))
MODEL = os.environ.get("MUX_IMAGE_MODEL", "flux2-klein-4b")
BASE_MODEL = os.environ.get("MUX_IMAGE_BASE_MODEL", MODEL)
MODEL_PATH = os.path.expanduser(os.environ.get("MUX_IMAGE_MODEL_PATH", "")) or None
QUANTIZE = None if MODEL_PATH else (int(os.environ.get("MUX_IMAGE_QUANTIZE", "8")) or None)
STEPS = int(os.environ.get("MUX_IMAGE_STEPS", "4"))
IDLE_MIN = float(os.environ.get("MUX_IMAGE_IDLE_MIN", "10"))
MAX_SIDE = 2048
MAX_N = 4
MAX_BODY = 48 * 1024 * 1024
# Free memory a request needs before it starts (MUX_IMAGES_MIN_FREE_GB; 0 turns the check off). mux's memory budget does
# not count this server: on 2026-11-17, with the video and measure models loading beside the chat models, an edit ran at
# 32 s a step instead of 3 and the next request had the process killed by macOS (the caller saw "fetch failed"). Now a
# request that would not fit is refused at once with a 503 that says why, and the process lives.
MIN_FREE_GB = float(os.environ.get("MUX_IMAGES_MIN_FREE_GB", "6"))
# MLX's buffer cache. MLX keeps every freed GPU buffer for reuse, by default up to its memory limit (~78 GB on this
# 96 GB Mac). Sizes, input-image counts and the edit/text-to-image switch each make buffers of other shapes, which the
# next request cannot reuse, so the cache only grew: on 2026-11-17 the server reached 67–71 GB with ~5 GB of model in
# it and pushed macOS 43 GB into swap. Now the cache is capped (MUX_IMAGES_CACHE_GB) and emptied after every request and
# whenever a pipeline is let go.
CACHE_GB = float(os.environ.get("MUX_IMAGES_CACHE_GB", "2"))

# The second model (none unless MUX_IMAGE_HQ_MODEL is set). FLUX 3 Image Klein's distilled checkpoint runs 16 steps.
HQ_MODEL = os.environ.get("MUX_IMAGE_HQ_MODEL", "").strip()
HQ_BASE_MODEL = os.environ.get("MUX_IMAGE_HQ_BASE_MODEL", "flux3-image-klein")
HQ_MODEL_PATH = os.path.expanduser(os.environ.get("MUX_IMAGE_HQ_MODEL_PATH", "")) or None
HQ_STEPS = int(os.environ.get("MUX_IMAGE_HQ_STEPS", "16"))
HQ_NAMES = {"image-edit-hq", "image-hq"} | ({HQ_MODEL} if HQ_MODEL else set())
# Free memory the second model needs before it loads (its peak while it works, measured in docs/image-edit.md);
# once it is in memory, MIN_FREE_GB as for the fast one.
HQ_MIN_FREE_GB = float(os.environ.get("MUX_IMAGE_HQ_MIN_FREE_GB", "24"))
# Every input image after the first (the garments of a try-on; the first is the person or the picture being edited) is
# made at most this many megapixels for the second model: each image is tokens the transformer attends over at every
# step, so three 1024x1024 garments made a try-on 4x slower (310 s against 77 s, 8 steps, the same look; docs/image-edit.md).
HQ_REF_MP = float(os.environ.get("MUX_IMAGE_HQ_REF_MP", "0.26"))
# At most this many input images are used (FLUX 3 Image Klein takes up to 10; klein 4B is given the same).
MAX_IMAGES = 10


def family(base):
    """mflux's model family for an architecture name: flux3 (FLUX 3 Image Klein) or flux2 (FLUX.2 klein)."""
    return "flux3" if str(base).startswith(("flux3", "flux-3")) else "flux2"


SPECS = {MODEL: {"base": BASE_MODEL, "path": MODEL_PATH, "quantize": QUANTIZE, "steps": STEPS}}
if HQ_MODEL:
    SPECS[HQ_MODEL] = {"base": HQ_BASE_MODEL, "path": HQ_MODEL_PATH, "quantize": None if HQ_MODEL_PATH else 8, "steps": HQ_STEPS}


def pick(requested):
    """The model a request gets: the second one when it asks for it by name, else the fast one (as before)."""
    return HQ_MODEL if HQ_MODEL and str(requested or "").strip() in HQ_NAMES else MODEL


def available_gb():
    """What macOS could hand out now (free, inactive, purgeable, speculative pages); None where it cannot be read."""
    if sys.platform != "darwin":
        return None
    try:
        out = subprocess.run(["vm_stat"], capture_output=True, text=True, timeout=5).stdout
        page = int(out.split("page size of ")[1].split()[0])
        pages = {k.strip(): int(v.strip().rstrip(".")) for k, v in (ln.split(":", 1) for ln in out.splitlines()[1:] if ":" in ln)}
        return sum(pages.get(k, 0) for k in ("Pages free", "Pages inactive", "Pages purgeable", "Pages speculative")) * page / 1024**3
    except Exception:  # noqa: BLE001
        return None

_model = None
_model_kind = None  # "edit" or "txt2img": mflux 0.24's edit pipeline needs an input image, so text to image has its own
_model_name = None  # which of SPECS is in memory
_last_used = 0.0
_gpu = threading.Lock()  # one generation at a time; also guards loading and letting go
# MLX keeps its default stream per thread: a model loaded on one thread fails on another with "There is no
# Stream(cpu, 0) in current thread". ThreadingHTTPServer answers each request on a new thread, so every MLX call
# (load, generate, let go) runs on this one worker thread instead.
_mlx = concurrent.futures.ThreadPoolExecutor(max_workers=1, thread_name_prefix="mlx")


def on_mlx(fn, *args, **kwargs):
    """Run fn on the MLX thread and wait for it; exceptions come back to the caller."""
    return _mlx.submit(fn, *args, **kwargs).result()


def _mx():
    try:
        import mlx.core as mx
        return mx
    except Exception:  # noqa: BLE001 – no MLX here (tests)
        return None


def cap_cache():
    """Cap MLX's buffer cache (once, on the MLX thread)."""
    mx = _mx()
    if mx is not None:
        mx.set_cache_limit(int(CACHE_GB * 1024**3))


def empty_cache():
    """Give MLX's cached buffers back to macOS; (active, cache, peak) GB before it, for the log."""
    mx = _mx()
    if mx is None:
        return None
    seen = (mx.get_active_memory() / 1024**3, mx.get_cache_memory() / 1024**3, mx.get_peak_memory() / 1024**3)
    mx.clear_cache()
    mx.reset_peak_memory()
    return seen


def model(kind="txt2img", name=None):
    """The pipeline for this model and kind, loaded once; any other is let go first, so only one is ever in memory."""
    global _model, _model_kind, _model_name
    name = name or MODEL
    if _model is not None and (_model_kind, _model_name) != (kind, name):
        _model = None
        gc.collect()
        empty_cache()   # else the other pipeline's weights stay in MLX's cache
    if _model is None:
        from mflux.models.common.config import ModelConfig
        spec = SPECS[name]
        if family(spec["base"]) == "flux3":
            from mflux.models.flux3.variants import Flux3Klein as Txt2Img, Flux3KleinEdit as Edit
        else:
            from mflux.models.flux2.variants import Flux2Klein as Txt2Img, Flux2KleinEdit as Edit
        t = time.time()
        cls = Edit if kind == "edit" else Txt2Img
        _model = cls(quantize=spec["quantize"], model_path=spec["path"], model_config=ModelConfig.from_name(spec["base"]))
        _model_kind, _model_name = kind, name
        how = spec["path"] or f"q{spec['quantize'] or 'bf16'}"
        print(f"loaded {name} {kind} ({how}) in {time.time() - t:.0f} s", file=sys.stderr, flush=True)
    return _model


def forget_prompts():
    """mflux keeps every prompt's text embeddings (`prompt_cache`) for the life of the pipeline: memory that only grows,
    and prompts kept after their request. Dropped after every request."""
    cache = getattr(_model, "prompt_cache", None)
    if isinstance(cache, dict):
        cache.clear()


def let_go():
    global _model, _model_name
    _model = None
    _model_name = None
    gc.collect()
    try:
        import mlx.core as mx
        mx.clear_cache()
    except Exception:  # noqa: BLE001 – an older mlx; the memory still goes when Python frees it
        pass
    print(f"let go of the image model after {IDLE_MIN:g} idle minutes", file=sys.stderr, flush=True)


def idle_watch():
    while True:
        time.sleep(30)
        if _model is not None and time.time() - _last_used > IDLE_MIN * 60 and _gpu.acquire(blocking=False):
            try:
                if _model is not None and time.time() - _last_used > IDLE_MIN * 60:
                    on_mlx(let_go)
            finally:
                _gpu.release()


def dims(size, fallback=(1024, 1024)):
    """'1536x1024' → (1536, 1024), each side a multiple of 16 and at most MAX_SIDE; 'auto' or nothing → fallback."""
    try:
        w, h = (int(x) for x in str(size).lower().split("x"))
    except ValueError:
        w, h = fallback
    fit = lambda v: max(256, min(MAX_SIDE, v - v % 16))
    return fit(w), fit(h)


def edit_dims(paths):
    """No size asked for: the first image's shape at about a megapixel, as the edit should look like the input."""
    from PIL import Image
    with Image.open(paths[0]) as im:
        w, h = im.size
    scale = (1024 * 1024 / (w * h)) ** 0.5
    return dims(f"{round(w * scale)}x{round(h * scale)}")


def shrink_refs(paths, max_mp):
    """Each image after the first made at most max_mp megapixels (in place, aspect kept); the first is left as it came."""
    from PIL import Image
    for p in paths[1:]:
        with Image.open(p) as im:
            w, h = im.size
            if w * h <= max_mp * 1e6:
                continue
            k = (max_mp * 1e6 / (w * h)) ** 0.5
            small = im.convert("RGBA" if im.mode in ("RGBA", "LA", "P") else "RGB").resize((max(16, int(w * k)), max(16, int(h * k))), Image.LANCZOS)
        small.save(p, format="PNG")


def _generate_on_mlx(prompt, size, n, seed, steps, images, name=None):
    out = []
    if images and name == HQ_MODEL and HQ_REF_MP > 0:
        shrink_refs(images, HQ_REF_MP)
    m = model("edit" if images else "txt2img", name)
    w, h = edit_dims(images) if images and size in (None, "", "auto") else dims(size)
    for i in range(n):
        s = (seed + i) if seed is not None else random.randrange(2**31)
        extra = {"image_paths": images} if images else {}
        img = m.generate_image(seed=s, prompt=prompt, num_inference_steps=steps, width=w, height=h, **extra)
        buf = io.BytesIO()
        img.image.save(buf, format="PNG")
        out.append({"b64_json": base64.b64encode(buf.getvalue()).decode()})
    return out


def _after_request():
    forget_prompts()
    return empty_cache()


def generate(prompt, size, n, seed, steps, images=None, name=None):
    global _last_used
    with _gpu:
        t = time.time()
        try:
            out = on_mlx(_generate_on_mlx, prompt, size, n, seed, steps, images, name)
        finally:
            seen = on_mlx(_after_request)
            _last_used = time.time()
            if seen:  # sizes only; never a prompt or an image
                print(f"request done ({name or MODEL}, {len(images or [])} images, {steps} steps, {time.time() - t:.1f} s): active {seen[0]:.1f} GB, "
                      f"cache {seen[1]:.1f} GB emptied, peak {seen[2]:.1f} GB", file=sys.stderr, flush=True)
    return out


def form(body, content_type):
    """multipart/form-data → ({field: text}, [image bytes]). OpenAI's clients send `image` or `image[]`."""
    msg = email.parser.BytesParser(policy=email.policy.HTTP).parsebytes(b"content-type: " + content_type.encode() + b"\r\n\r\n" + body)
    fields, images = {}, []
    for part in msg.iter_parts():
        name = part.get_param("name", header="content-disposition")
        if not name:
            continue
        data = part.get_payload(decode=True) or b""
        if name in ("image", "image[]") or part.get_filename():
            if name != "mask" and data:
                images.append(data)
        else:
            fields[name] = data.decode("utf-8", "replace").strip()
    return fields, images


class Handler(BaseHTTPRequestHandler):
    def _send(self, status, obj):
        body = json.dumps(obj).encode()
        self.send_response(status)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _error(self, status, message):
        self._send(status, {"error": {"message": message, "type": "invalid_request_error" if status < 500 else "server_error"}})

    def do_GET(self):
        if self.path.rstrip("/") in ("", "/health", "/v1/models"):
            return self._send(200, {"object": "list", "data": [
                {"id": n, "object": "model", "loaded": _model is not None and _model_name == n, "steps": SPECS[n]["steps"],
                 **({"need_gb": HQ_MIN_FREE_GB} if n == HQ_MODEL and _model_name != n else {})} for n in SPECS]})
        self._error(404, "not found")

    def do_POST(self):
        path = self.path.split("?")[0].rstrip("/")
        length = int(self.headers.get("content-length") or 0)
        if length > MAX_BODY:
            return self._error(413, f"at most {MAX_BODY // 1024 // 1024} MB")
        raw = self.rfile.read(length)
        tmp = []
        try:
            if path.endswith("/images/generations"):
                try:
                    b = json.loads(raw or b"{}")
                except ValueError:
                    return self._error(400, "body is not JSON")
                images = None
            elif path.endswith("/images/edits"):
                b, data = form(raw, self.headers.get("content-type") or "")
                if not data:
                    return self._error(400, "an image is required")
                for d in data[:MAX_IMAGES]:
                    f = tempfile.NamedTemporaryFile(suffix=".png", delete=False)
                    f.write(d)
                    f.close()
                    tmp.append(f.name)
                images = tmp
            else:
                return self._error(404, "not found")
            prompt = str(b.get("prompt") or "").strip()
            if not prompt:
                return self._error(400, "prompt is required")
            name = pick(b.get("model") or (self.path.split("model=", 1)[1].split("&")[0] if "model=" in self.path else ""))
            need = HQ_MIN_FREE_GB if name == HQ_MODEL and _model_name != HQ_MODEL else MIN_FREE_GB
            have = available_gb() if need else None
            if have is not None and have < need:
                return self._error(503, f"only {have:.1f} GB free on this Mac right now; {name} needs {need:g} GB: try again in a minute")
            n = max(1, min(MAX_N, int(b.get("n") or 1)))
            seed = int(b["seed"]) if str(b.get("seed", "")).strip().lstrip("-").isdigit() else None
            steps = max(1, min(50, int(b.get("steps") or SPECS[name]["steps"])))
            data = generate(prompt, b.get("size"), n, seed, steps, images, name)
            self._send(200, {"created": int(time.time()), "model": name, "data": data})
        except Exception as e:  # noqa: BLE001 – the caller gets the reason, mux falls through to the next model
            self._error(500, str(e)[:300])
        finally:
            for p in tmp:
                try:
                    os.unlink(p)
                except OSError:
                    pass

    def log_message(self, *_):
        pass


if __name__ == "__main__":
    on_mlx(cap_cache)
    threading.Thread(target=idle_watch, daemon=True).start()
    if "--warm" in sys.argv:  # deploy/images.sh: fetch the weights and load once, then exit
        on_mlx(model)
        sys.exit(0)
    if "--warm-hq" in sys.argv:  # deploy/image-edit-hq.sh: load the second model's edit pipeline once, then exit
        on_mlx(model, "edit", HQ_MODEL)
        sys.exit(0)
    hq = f"; {HQ_MODEL} ({HQ_BASE_MODEL}) {HQ_STEPS} steps on image-edit-hq" if HQ_MODEL else ""
    print(f"mflux images on 127.0.0.1:{PORT}: {MODEL} {MODEL_PATH or f'q{QUANTIZE or 'bf16'}'}, {STEPS} steps{hq}, idle {IDLE_MIN:g} min", file=sys.stderr, flush=True)
    ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
