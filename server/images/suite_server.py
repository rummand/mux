"""Local MLX image suite for Mux on Apple silicon.

The existing FLUX.2 Klein server on 8312 is unchanged. This second worker serves
four pre-quantized MFLUX checkpoints via OpenAI-compatible image endpoints, using
only one loaded pipeline at a time. Bind only to loopback; Mux authenticates
upstream callers and routes to this worker.

Python 3.11+; mflux 0.24.0; huggingface_hub; Pillow.
"""
import base64
import email.parser
import email.policy
import gc
import io
import json
import os
from pathlib import Path
import random
import sys
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ROOT = Path(os.environ.get("MUX_IMAGE_SUITE_DIR", "~/.mux/models/image-suite")).expanduser()
PORT = int(os.environ.get("MUX_IMAGE_SUITE_PORT", "8313"))
IDLE_MIN = float(os.environ.get("MUX_IMAGE_SUITE_IDLE_MIN", "5"))
MAX_BODY = 48 * 1024 * 1024
MAX_SIDE = 2048
SPECS = {
    "z-image-turbo": {"dir": "z-image-turbo", "task": "generate", "steps": 9, "license": "Apache-2.0"},
    "qwen-image-2512": {"dir": "qwen-image-2512", "task": "generate", "steps": 30, "license": "Apache-2.0"},
    "qwen-image-edit-2511": {"dir": "qwen-image-edit-2511", "task": "edit", "steps": 30, "license": "Apache-2.0"},
    "ming-image-0.1-design": {"dir": "ming-image-0.1-design", "task": "generate", "steps": 12, "license": "MIT"},
}
_lock = threading.RLock()
_pipeline = None
_pipeline_id = None
_last_used = 0.0


def model_path(name):
    if name not in SPECS:
        raise ValueError("Unknown image model")
    return ROOT / SPECS[name]["dir"]


def release():
    global _pipeline, _pipeline_id
    _pipeline = None
    _pipeline_id = None
    gc.collect()
    try:
        import mlx.core as mx
        mx.clear_cache()
    except (ImportError, AttributeError):
        pass


def load(name):
    """Only one of the four pipelines occupies unified memory at a time."""
    global _pipeline, _pipeline_id
    if _pipeline_id == name and _pipeline is not None:
        return _pipeline
    release()
    path = model_path(name)
    if not any(path.rglob("*.safetensors")):
        raise FileNotFoundError(f"{name} weights not downloaded to {path}")
    t = time.monotonic()
    if name == "z-image-turbo":
        from mflux.models.common.config import ModelConfig
        from mflux.models.z_image import ZImageTurbo
        value = ZImageTurbo(model_config=ModelConfig.z_image_turbo(), model_path=str(path))
    elif name == "qwen-image-2512":
        from mflux.models.common.config import ModelConfig
        from mflux.models.qwen.variants.txt2img.qwen_image import QwenImage
        value = QwenImage(model_config=ModelConfig.qwen_image(), model_path=str(path))
    elif name == "qwen-image-edit-2511":
        from mflux.models.common.config import ModelConfig
        from mflux.models.qwen.variants.edit.qwen_image_edit import QwenImageEdit
        value = QwenImageEdit(model_config=ModelConfig.qwen_image_edit_2511(), model_path=str(path))
    elif name == "ming-image-0.1-design":
        from mflux.models.ming_image import MingImage
        value = MingImage(model_path=str(path))
    else:
        raise ValueError("Unknown image model")
    _pipeline, _pipeline_id = value, name
    print(f"image-suite loaded {name} in {time.monotonic() - t:.1f}s", file=sys.stderr, flush=True)
    return value


def idle_watch():
    while True:
        time.sleep(30)
        with _lock:
            if _pipeline is not None and time.monotonic() - _last_used > IDLE_MIN * 60:
                print(f"image-suite unloading {_pipeline_id} after idle", file=sys.stderr, flush=True)
                release()


def dimensions(value, fallback=(1024, 1024)):
    try:
        w, h = [int(x) for x in str(value).lower().split("x")]
    except (TypeError, ValueError):
        w, h = fallback
    return tuple(max(256, min(MAX_SIDE, x - (x % 16))) for x in (w, h))


def parse_form(data, content_type):
    """Multipart parser for OpenAI edits. Preserve up to four input images."""
    message = email.parser.BytesParser(policy=email.policy.HTTP).parsebytes(
        b"Content-Type: " + content_type.encode() + b"\r\n\r\n" + data
    )
    fields, images = {}, []
    for part in message.iter_parts():
        key = part.get_param("name", header="content-disposition")
        if not key:
            continue
        data = part.get_payload(decode=True) or b""
        if key in ("image", "image[]") and data:
            images.append(data)
        elif key not in ("mask", "image", "image[]"):
            fields[key] = data.decode("utf-8", errors="replace")
    return fields, images[:4]


def run_generation(name, data, images):
    global _last_used
    spec = SPECS[name]
    if (spec["task"] == "edit") != bool(images):
        raise ValueError(f"{name} supports {spec['task']} only; choose the matching route")
    prompt = str(data.get("prompt") or "").strip()
    if not prompt:
        raise ValueError("prompt is required")
    n = max(1, min(2, int(data.get("n") or 1)))
    steps = max(1, min(60, int(data.get("steps") or spec["steps"])))
    seed = int(data.get("seed")) if str(data.get("seed", "")).lstrip("-").isdigit() else random.randrange(2**31)
    w, h = dimensions(data.get("size"))
    negative_prompt = str(data.get("negative_prompt") or "")
    result = []
    with _lock:
        m = load(name)
        for index in range(n):
            opts = {
                "seed": seed + index, "prompt": prompt,
                "num_inference_steps": steps, "width": w, "height": h,
            }
            if name == "qwen-image-2512":
                opts["negative_prompt"] = negative_prompt
            elif name == "qwen-image-edit-2511":
                opts["image_paths"] = images
                opts["guidance"] = float(data.get("guidance") or 2.5)
            generated = m.generate_image(**opts)
            pil = generated.image
            bio = io.BytesIO()
            pil.save(bio, format="PNG")
            result.append({"b64_json": base64.b64encode(bio.getvalue()).decode("ascii")})
        _last_used = time.monotonic()
    return result


class Handler(BaseHTTPRequestHandler):
    def send_json(self, code, value):
        payload = json.dumps(value).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def do_GET(self):
        if self.path.split("?")[0] in ("/health", "/v1/models"):
            with _lock:
                return self.send_json(200, {
                    "object": "list",
                    "loaded": _pipeline_id,
                    "data": [{"id": name, "kind": "image", "task": info["task"],
                              "downloaded": any(model_path(name).rglob("*.safetensors"))}
                             for name, info in SPECS.items()],
                })
        return self.send_json(404, {"error": {"message": "not found"}})

    def do_POST(self):
        path = self.path.split("?")[0].rstrip("/")
        if path not in ("/v1/images/generations", "/v1/images/edits"):
            return self.send_json(404, {"error": {"message": "not found"}})
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if length < 0 or length > MAX_BODY:
                return self.send_json(413, {"error": {"message": "request too large"}})
            body = self.rfile.read(length)
            images = []
            if path.endswith("edits"):
                fields, raw_images = parse_form(body, self.headers.get("Content-Type", ""))
                if not raw_images:
                    raise ValueError("one or more image files are required")
                data = fields
                with tempfile.TemporaryDirectory(prefix="mux-edit-") as tmp:
                    for i, blob in enumerate(raw_images):
                        p = Path(tmp) / f"ref-{i}.png"
                        p.write_bytes(blob)
                        images.append(str(p))
                    return self._respond(data, images)
            data = json.loads(body or b"{}")
            if not isinstance(data, dict):
                raise ValueError("JSON object expected")
            return self._respond(data, [])
        except (ValueError, TypeError, json.JSONDecodeError) as exc:
            return self.send_json(400, {"error": {"message": str(exc)[:300]}})
        except Exception as exc:
            print(f"image-suite error: {exc}", file=sys.stderr, flush=True)
            return self.send_json(500, {"error": {"message": str(exc)[:300]}})

    def _respond(self, data, images):
        name = str(data.get("model") or "")
        if name not in SPECS:
            raise ValueError(f"model must be one of: {', '.join(SPECS)}")
        output = run_generation(name, data, images)
        return self.send_json(200, {"created": int(time.time()), "model": name, "data": output})

    def log_message(self, *_args):
        return  # do not log image prompts


if __name__ == "__main__":
    if sys.platform != "darwin":
        raise SystemExit("This image suite is built for Apple Silicon macOS")
    threading.Thread(target=idle_watch, daemon=True).start()
    print(f"Mux image suite listening on 127.0.0.1:{PORT}", file=sys.stderr, flush=True)
    ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
