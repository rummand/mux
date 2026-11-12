"""Images for mux: OpenAI's POST /v1/images/generations and /v1/images/edits in front of mflux (MLX, open source).

Runs in ~/.mux/images-venv (python3.12 -m venv ~/.mux/images-venv && ~/.mux/images-venv/bin/pip install mflux).
The model is FLUX.2 [klein] 4B (Black Forest Labs, Apache-2.0): text to image, and editing from one or more input
images, in 4 steps. Text to image runs mflux's Flux2Klein, edits its Flux2KleinEdit (0.24's edit pipeline needs an input
image), one of them in memory at a time. Weights come from Hugging Face into HF_HUB_CACHE (deploy/images.sh points it at ~/.mux/models/hf and
fetches them first). The model loads on the first request and is let go after MUX_IMAGE_IDLE_MIN idle minutes, so
its ~9 GB (8-bit) go back to the chat models. One image at a time: the GPU does one well, not two at half speed.
Started by deploy/images.sh as launchd agent com.mux.images on 127.0.0.1:8312. Images are never written to disk.

A pre-quantised local copy instead of the Hugging Face cache: MUX_IMAGE_MODEL_PATH (a directory of mflux weights, e.g.
~/.mux/models/flux2-klein-4b-mflux-q4, 4.6 GB, from deploy/images.sh --q4), MUX_IMAGE_BASE_MODEL the architecture it
is (flux2-klein-4b), MUX_IMAGE_MODEL the name it answers as (flux2-klein-4b-q4). Its quantisation is in the weights.
"""
import base64, email.parser, email.policy, gc, io, json, os, random, sys, tempfile, threading, time
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

_model = None
_model_kind = None  # "edit" or "txt2img": mflux 0.24's edit pipeline needs an input image, so text to image has its own
_last_used = 0.0
_gpu = threading.Lock()  # one generation at a time; also guards loading and letting go


def model(kind="txt2img"):
    """The pipeline for this kind, loaded once; the other kind's is let go first, so only one is ever in memory."""
    global _model, _model_kind
    if _model is not None and _model_kind != kind:
        _model = None
        gc.collect()
    if _model is None:
        from mflux.models.common.config import ModelConfig
        from mflux.models.flux2.variants import Flux2Klein, Flux2KleinEdit
        t = time.time()
        cls = Flux2KleinEdit if kind == "edit" else Flux2Klein
        _model = cls(quantize=QUANTIZE, model_path=MODEL_PATH, model_config=ModelConfig.from_name(BASE_MODEL))
        _model_kind = kind
        print(f"loaded {MODEL} {kind} ({MODEL_PATH or f'q{QUANTIZE or 'bf16'}'}) in {time.time() - t:.0f} s", file=sys.stderr, flush=True)
    return _model


def let_go():
    global _model
    _model = None
    gc.collect()
    try:
        import mlx.core as mx
        mx.clear_cache()
    except Exception:  # noqa: BLE001 – an older mlx; the memory still goes when Python frees it
        pass
    print(f"let go of {MODEL} after {IDLE_MIN:g} idle minutes", file=sys.stderr, flush=True)


def idle_watch():
    while True:
        time.sleep(30)
        if _model is not None and time.time() - _last_used > IDLE_MIN * 60 and _gpu.acquire(blocking=False):
            try:
                if _model is not None and time.time() - _last_used > IDLE_MIN * 60:
                    let_go()
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


def generate(prompt, size, n, seed, steps, images=None):
    global _last_used
    out = []
    with _gpu:
        m = model("edit" if images else "txt2img")
        w, h = edit_dims(images) if images and size in (None, "", "auto") else dims(size)
        for i in range(n):
            s = (seed + i) if seed is not None else random.randrange(2**31)
            extra = {"image_paths": images} if images else {}
            img = m.generate_image(seed=s, prompt=prompt, num_inference_steps=steps, width=w, height=h, **extra)
            buf = io.BytesIO()
            img.image.save(buf, format="PNG")
            out.append({"b64_json": base64.b64encode(buf.getvalue()).decode()})
        _last_used = time.time()
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
            return self._send(200, {"object": "list", "data": [{"id": MODEL, "object": "model", "loaded": _model is not None}]})
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
                for d in data[:10]:
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
            n = max(1, min(MAX_N, int(b.get("n") or 1)))
            seed = int(b["seed"]) if str(b.get("seed", "")).strip().lstrip("-").isdigit() else None
            steps = max(1, min(50, int(b.get("steps") or STEPS)))
            data = generate(prompt, b.get("size"), n, seed, steps, images)
            self._send(200, {"created": int(time.time()), "model": MODEL, "data": data})
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
    threading.Thread(target=idle_watch, daemon=True).start()
    if "--warm" in sys.argv:  # deploy/images.sh: fetch the weights and load once, then exit
        model()
        sys.exit(0)
    print(f"mflux images on 127.0.0.1:{PORT}: {MODEL} {MODEL_PATH or f'q{QUANTIZE or 'bf16'}'}, {STEPS} steps, idle {IDLE_MIN:g} min", file=sys.stderr, flush=True)
    ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
