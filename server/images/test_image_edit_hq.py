"""The second image model (image-edit-hq) without weights: mflux is replaced by stand-ins.
Run: python3 server/images/test_image_edit_hq.py (any Python 3.11+ with Pillow; mflux and MLX are not needed)."""
import importlib.util, io, json, os, sys, threading, time, types, urllib.request
from http.server import ThreadingHTTPServer

here = os.path.dirname(os.path.abspath(__file__))
os.environ.update({
    "MUX_IMAGE_MODEL": "flux2-klein-4b-q4", "MUX_IMAGE_BASE_MODEL": "flux2-klein-4b", "MUX_IMAGE_MODEL_PATH": "/weights/klein",
    "MUX_IMAGE_HQ_MODEL": "flux3-image-klein-q8", "MUX_IMAGE_HQ_BASE_MODEL": "flux3-image-klein",
    "MUX_IMAGE_HQ_MODEL_PATH": "/weights/flux3", "MUX_IMAGES_MIN_FREE_GB": "6", "MUX_IMAGE_HQ_MIN_FREE_GB": "24",
})

# ── stand-ins for mflux: every pipeline says which class it is and records what it was asked ─────────────────────────
made, asked = [], []


def pipeline(cls_name):
    class Pipe:
        def __init__(self, quantize=None, model_path=None, model_config=None):
            self.prompt_cache = {}
            made.append((cls_name, quantize, model_path, model_config))

        def generate_image(self, **kw):
            self.prompt_cache[kw["prompt"]] = "embeddings"
            asked.append((cls_name, kw))
            from PIL import Image
            img = Image.new("RGB", (kw["width"], kw["height"]), (200, 10, 10))
            return types.SimpleNamespace(image=img)
    Pipe.__name__ = cls_name
    return Pipe


def module(name, **attrs):
    m = types.ModuleType(name)
    m.__dict__.update(attrs)
    sys.modules[name] = m


module("mflux")
module("mflux.models")
module("mflux.models.common")
module("mflux.models.common.config", ModelConfig=types.SimpleNamespace(from_name=lambda n: f"config:{n}"))
module("mflux.models.flux2")
module("mflux.models.flux2.variants", Flux2Klein=pipeline("Flux2Klein"), Flux2KleinEdit=pipeline("Flux2KleinEdit"))
module("mflux.models.flux3")
module("mflux.models.flux3.variants", Flux3Klein=pipeline("Flux3Klein"), Flux3KleinEdit=pipeline("Flux3KleinEdit"))

spec = importlib.util.spec_from_file_location("image_server", os.path.join(here, "image_server.py"))
im = importlib.util.module_from_spec(spec)
spec.loader.exec_module(im)
im._mx = lambda: None   # no MLX here
free = {"gb": 64.0}
im.available_gb = lambda: free["gb"]

# ── which model a request gets ────────────────────────────────────────────────────────────────────────────────────────
assert im.pick("image-edit-hq") == im.pick("image-hq") == im.pick("flux3-image-klein-q8") == "flux3-image-klein-q8"
for other in ("flux2-klein-4b-q4", "image-edit", "image", "", None, "gpt-image-1"):
    assert im.pick(other) == "flux2-klein-4b-q4", other
assert im.family("flux3-image-klein") == "flux3" and im.family("flux2-klein-4b") == "flux2"
assert im.SPECS["flux3-image-klein-q8"] == {"base": "flux3-image-klein", "path": "/weights/flux3", "quantize": None, "steps": 16}
assert im.SPECS["flux2-klein-4b-q4"]["steps"] == 4
print("ok pick: image-edit-hq, image-hq and the model's own name get the second model; everything else the fast one")

# ── over HTTP, as mux sends it (multipart, its `model` field the upstream name) ────────────────────────────────────────
srv = ThreadingHTTPServer(("127.0.0.1", 0), im.Handler)
threading.Thread(target=srv.serve_forever, daemon=True).start()
base = f"http://127.0.0.1:{srv.server_address[1]}"


def png(w, h):
    from PIL import Image
    buf = io.BytesIO()
    Image.new("RGB", (w, h), (1, 2, 3)).save(buf, format="PNG")
    return buf.getvalue()


def edit(model, n_images, extra=None):
    b = "hq-boundary"
    parts = [("prompt", "The person from image 1 wears the jacket from image 2"), ("model", model), ("seed", "7")] + list((extra or {}).items())
    body = b"".join(f"--{b}\r\nContent-Disposition: form-data; name=\"{k}\"\r\n\r\n{v}\r\n".encode() for k, v in parts)
    for i in range(n_images):
        body += f"--{b}\r\nContent-Disposition: form-data; name=\"image[]\"; filename=\"{i}.png\"\r\nContent-Type: image/png\r\n\r\n".encode()
        body += png(768, 1152) if i == 0 else png(512, 512)
        body += b"\r\n"
    body += f"--{b}--\r\n".encode()
    req = urllib.request.Request(f"{base}/v1/images/edits?model={model}", data=body, method="POST", headers={"content-type": f"multipart/form-data; boundary={b}"})
    try:
        with urllib.request.urlopen(req) as r:
            return r.status, json.loads(r.read())
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read())


def models():
    with urllib.request.urlopen(f"{base}/v1/models") as r:
        return {d["id"]: d for d in json.loads(r.read())["data"]}


ms = models()
assert set(ms) == {"flux2-klein-4b-q4", "flux3-image-klein-q8"} and not any(d["loaded"] for d in ms.values()), ms
assert ms["flux3-image-klein-q8"]["need_gb"] == 24 and "need_gb" not in ms["flux2-klein-4b-q4"], ms

# a try-on: the person and three garments, 12 images sent → the first 10 kept; default 16 steps, ~1 MP in the person's shape
status, out = edit("flux3-image-klein-q8", 12)
assert status == 200 and out["model"] == "flux3-image-klein-q8", (status, out)
cls, kw = asked[-1]
assert cls == "Flux3KleinEdit" and made[-1] == ("Flux3KleinEdit", None, "/weights/flux3", "config:flux3-image-klein"), made
assert kw["num_inference_steps"] == 16 and len(kw["image_paths"]) == 10 and kw["seed"] == 7, kw
assert (kw["width"], kw["height"]) == (832, 1248), kw   # 768x1152 at about a megapixel, multiples of 16
assert im._model.prompt_cache == {}, "the prompt's embeddings are dropped after the request"
for _ in range(50):   # the answer is sent just before the handler's finally deletes the files
    if not any(os.path.exists(p) for p in kw["image_paths"]):
        break
    time.sleep(0.02)
assert not any(os.path.exists(p) for p in kw["image_paths"]), "the input images are deleted"
ms = models()
assert ms["flux3-image-klein-q8"]["loaded"] and not ms["flux2-klein-4b-q4"]["loaded"] and "need_gb" not in ms["flux3-image-klein-q8"], ms
print("ok image-edit-hq: FLUX 3's edit pipeline, the first 10 images, 16 steps, ~1 MP in the first image's shape; prompts and files dropped")

# the garments (every image after the first) at most ~0.26 MP for the second model; the person as it came
from PIL import Image
sizes = []
class Sizing:
    prompt_cache = {}
    def generate_image(self, **kw):
        sizes.extend(Image.open(p).size for p in kw["image_paths"])
        return types.SimpleNamespace(image=Image.new("RGB", (16, 16)))
real_model = im.model
im.model = lambda *_: Sizing()
status, out = edit("image-edit-hq", 4)
assert status == 200, out
assert sizes[0] == (768, 1152) and all(w * h <= 0.26e6 for w, h in sizes[1:]) and sizes[1] == (509, 509), sizes
sizes.clear()
status, out = edit("image-edit", 4)   # the fast model: images as they came
assert sizes[1] == (512, 512), sizes
im.model = real_model
print("ok references: for image-edit-hq every image after the first is made at most 0.26 MP; the first is kept as it came")

# size and steps as asked, up to 2048 a side
status, out = edit("image-edit-hq", 4, {"size": "1536x2048", "steps": "24"})
assert status == 200, out
assert (asked[-1][1]["width"], asked[-1][1]["height"], asked[-1][1]["num_inference_steps"]) == (1536, 2048, 24), asked[-1]
status, out = edit("image-edit-hq", 1, {"size": "4096x4096"})
assert (asked[-1][1]["width"], asked[-1][1]["height"]) == (2048, 2048), asked[-1]
print("ok size and steps: as asked, each side capped at 2048")

# the fast model after it: the second is let go first (one model in memory), and it keeps its 4 steps
n_made = len(made)
status, out = edit("flux2-klein-4b-q4", 4)
assert status == 200 and out["model"] == "flux2-klein-4b-q4", out
assert made[n_made:] == [("Flux2KleinEdit", None, "/weights/klein", "config:flux2-klein-4b")], made[n_made:]
assert asked[-1][1]["num_inference_steps"] == 4 and im._model_name == "flux2-klein-4b-q4"
print("ok one model in memory: asking for the other lets the first go; the fast one keeps its 4 steps")

# memory: loading the second model needs HQ_MIN_FREE_GB; the fast one only MIN_FREE_GB
free["gb"] = 12.0
status, out = edit("image-edit-hq", 2)
assert status == 503 and "flux3-image-klein-q8 needs 24 GB" in out["error"]["message"], out
status, out = edit("image-edit", 2)
assert status == 200 and out["model"] == "flux2-klein-4b-q4", out
free["gb"] = 4.0
status, out = edit("image-edit", 2)
assert status == 503 and "needs 6 GB" in out["error"]["message"], out
print("ok memory: the second model is refused in words below 24 GB free (when not loaded), the fast one below 6 GB")

srv.shutdown()
print("all image-edit-hq tests pass")
