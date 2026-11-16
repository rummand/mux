"""FLUX 3 Image Klein on the Mux Mac: OpenAI-compatible local MLX worker.

Personal, non-commercial weights under the FLUX Kommunity License v1.0.
Runs on loopback only; Mux handles API keys, tenant permissions and routing.
This worker does not modify the existing FLUX.2 worker on port 8312.
"""
import base64
import email.parser
import email.policy
import gc
import io
import json
import os
import random
import sys
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

PORT = int(os.environ.get("MUX_FLUX3_PORT", "8314"))
MODEL_ID = "flux3-image-klein-q8"
WEIGHTS = Path(os.environ.get("MUX_FLUX3_WEIGHTS", "~/.mux/models/flux3-image-klein-q8")).expanduser()
IDLE_MIN = float(os.environ.get("MUX_FLUX3_IDLE_MIN", "5"))
MAX_BODY = 48 * 1024 * 1024
MAX_SIDE = 2048
LOCK = threading.RLock()
PIPELINE = None
PIPELINE_KIND = None
LAST_USED = 0.0


def unload():
    global PIPELINE, PIPELINE_KIND
    PIPELINE = None
    PIPELINE_KIND = None
    gc.collect()
    try:
        import mlx.core as mx
        mx.clear_cache()
    except (ImportError, AttributeError):
        pass


def model(kind):
    """Load precisely one FLUX 3 pipeline at a time; reuse its quantized weights."""
    global PIPELINE, PIPELINE_KIND
    if PIPELINE is not None and PIPELINE_KIND == kind:
        return PIPELINE
    unload()
    if not any(WEIGHTS.rglob("*.safetensors")):
        raise FileNotFoundError(f"FLUX 3 model weights missing: {WEIGHTS}")
    from mflux.models.common.config import ModelConfig
    from mflux.models.flux3.variants import Flux3Klein, Flux3KleinEdit
    cls = Flux3KleinEdit if kind == "edit" else Flux3Klein
    started = time.monotonic()
    PIPELINE = cls(model_config=ModelConfig.flux3_image_klein(), model_path=str(WEIGHTS))
    PIPELINE_KIND = kind
    print(f"FLUX 3 {kind} loaded in {time.monotonic()-started:.1f}s", file=sys.stderr, flush=True)
    return PIPELINE


def idle_watch():
    while True:
        time.sleep(30)
        if PIPELINE is not None and time.monotonic() - LAST_USED > IDLE_MIN * 60:
            if LOCK.acquire(blocking=False):
                try:
                    if PIPELINE is not None and time.monotonic() - LAST_USED > IDLE_MIN * 60:
                        unload()
                finally:
                    LOCK.release()


def size_of(value, fallback=(1024, 1024)):
    try:
        w, h = [int(part) for part in str(value).lower().split("x")]
    except ValueError:
        w, h = fallback
    return tuple(max(256, min(MAX_SIDE, v - v % 16)) for v in (w, h))


def edit_size(images):
    from PIL import Image
    with Image.open(images[0]) as pic:
        w, h = pic.size
    scale = (1024 * 1024 / max(1, w * h)) ** 0.5
    return size_of(f"{round(w*scale)}x{round(h*scale)}")


def form_parts(data, content_type):
    """Read OpenAI image edits (up to ten source images). Masks are not hard masks in FLUX 3."""
    message = email.parser.BytesParser(policy=email.policy.HTTP).parsebytes(
        b"Content-Type: " + content_type.encode() + b"\r\n\r\n" + data
    )
    fields, images = {}, []
    for part in message.iter_parts():
        key = part.get_param("name", header="content-disposition")
        if not key:
            continue
        payload = part.get_payload(decode=True) or b""
        if key in ("image", "image[]") and payload:
            if len(images) < 10:
                images.append(payload)
        elif key not in ("image", "image[]", "mask"):
            fields[key] = payload.decode("utf-8", "replace").strip()
    return fields, images


def generate(prompt, size, n, seed, steps, images):
    global LAST_USED
    output = []
    with LOCK:
        pipeline = model("edit" if images else "generate")
        w, h = edit_size(images) if images and size in (None, "", "auto") else size_of(size)
        for i in range(n):
            args = {
                "seed": (seed + i) if seed is not None else random.randrange(2**31),
                "prompt": prompt,
                "num_inference_steps": steps,
                "width": w, "height": h,
            }
            if images:
                args["image_paths"] = images
            result = pipeline.generate_image(**args)
            png = io.BytesIO()
            result.image.save(png, format="PNG")
            output.append({"b64_json": base64.b64encode(png.getvalue()).decode("ascii")})
        LAST_USED = time.monotonic()
    return output


class Handler(BaseHTTPRequestHandler):
    def answer(self, status, value):
        body = json.dumps(value).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path.split("?")[0] in ("/health", "/v1/models"):
            return self.answer(200, {"object": "list", "data": [{
                "id": MODEL_ID, "object": "model", "kind": "image",
                "weights_present": any(WEIGHTS.rglob("*.safetensors")),
                "loaded": PIPELINE is not None,
            }]})
        return self.answer(404, {"error": {"message": "not found"}})

    def do_POST(self):
        operation = self.path.split("?")[0].rstrip("/")
        if operation not in ("/v1/images/generations", "/v1/images/edits"):
            return self.answer(404, {"error": {"message": "not found"}})
        length = int(self.headers.get("Content-Length") or "0")
        if length < 0 or length > MAX_BODY:
            return self.answer(413, {"error": {"message": "request exceeds 48 MB"}})
        raw = self.rfile.read(length)
        try:
            if operation.endswith("/generations"):
                fields, raw_images = json.loads(raw or b"{}"), []
                if not isinstance(fields, dict):
                    raise ValueError("JSON object expected")
            else:
                fields, raw_images = form_parts(raw, self.headers.get("Content-Type") or "")
                if not raw_images:
                    raise ValueError("image or image[] is required for edits")
            prompt = str(fields.get("prompt") or "").strip()
            if not prompt:
                raise ValueError("prompt is required")
            count = max(1, min(2, int(fields.get("n") or 1)))
            steps = max(1, min(50, int(fields.get("steps") or 16)))
            text_seed = str(fields.get("seed") or "")
            seed = int(text_seed) if text_seed.lstrip("-").isdigit() and int(text_seed) >= 0 else None
            with tempfile.TemporaryDirectory(prefix="mux-flux3-") as tempdir:
                image_paths = []
                for i, blob in enumerate(raw_images):
                    path = Path(tempdir) / f"reference-{i}.png"
                    path.write_bytes(blob)
                    image_paths.append(str(path))
                images = generate(prompt, fields.get("size"), count, seed, steps, image_paths)
            return self.answer(200, {"created": int(time.time()), "model": MODEL_ID, "data": images})
        except (ValueError, TypeError) as exc:
            return self.answer(400, {"error": {"message": str(exc)[:250]}})
        except Exception as exc:
            print(f"FLUX 3 generation failed: {exc}", file=sys.stderr, flush=True)
            return self.answer(500, {"error": {"message": str(exc)[:250]}})

    def log_message(self, *_args):
        pass  # image prompts and user media are private


if __name__ == "__main__":
    if sys.platform != "darwin":
        raise SystemExit("FLUX 3 worker must run on Apple silicon macOS")
    threading.Thread(target=idle_watch, daemon=True).start()
    print(f"FLUX 3 worker: http://127.0.0.1:{PORT}", file=sys.stderr, flush=True)
    ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
