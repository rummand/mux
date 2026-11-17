"""Backdrops for mux: a 360° panorama from text or an image, its depth, and a dome mesh around the camera.

Thread's Sets draws it beyond the set's edge (Thread's docs/proposals/2026-11-17-world-models-for-sets.html, section 8:
the World Models proposal's next steps 1 and 2). Why these models, their licences, the memory plan and what is proven
on Apple Silicon and what is not: docs/backdrop.md. In short:

- The panorama: HunyuanWorld 1.0's panorama step (Tencent; its PanoDiT LoRAs and its own diffusers pipelines, which
  blend the left and right edges so the seam closes), on FLUX.1-dev for text and FLUX.1-Fill-dev for an image (Black
  Forest Labs). 1920 × 960 equirectangular. bf16 on PyTorch's MPS backend.
- The depth: MoGe-2 (Microsoft, MIT) on 20 perspective views cut from the panorama, merged back into one panorama of
  distances (MoGe's own panorama merge), its metric scale kept.
- The dome: dome.py (no model): the depth shaped into one mesh, the ground below the horizon flattened to a floor.

Runs in ~/.mux/backdrop-venv (deploy/backdrop.sh), launchd agent com.mux.backdrop on 127.0.0.1:8316.

- One job at a time; jobs wait in a queue (at most MUX_BACKDROP_QUEUE).
- Memory: the text encoders (T5-XXL and CLIP, ~10 GB) and the FLUX transformer (~24 GB) are never needed at once, so
  they are not held at once unless macOS has the room: a job encodes its prompt, lets the encoders go, then denoises.
  Each part loads only with enough free (MUX_BACKDROP_*_FREE_GB), else the job fails as out_of_memory, and a new job
  is refused (429, said in words) while nothing is loaded and the Mac lacks the room. The transformer (and MoGe-2)
  stay for MUX_BACKDROP_IDLE_MIN idle minutes, then go.
- Every PyTorch call runs on one device thread, `on_device`, as in the video and measure servers.
- Nothing about a prompt or an image is logged: not its text, not its size. They are held in memory only.
- A finished job's panorama, depth and dome are kept KEEP_S (1 hour), then the job is gone (404).

Contract (Thread is built against it; docs/backdrop.md has the long form):
  POST /v1/backdrops             {prompt, image_b64?, seed?, size?: "1920x960"} → 202 {id, status: "queued", model: "backdrop"}
  GET  /v1/backdrops/{id}        → {id, status, progress, error?, meta?: {horizon, groundDepth?, depthScale}}
  GET  /v1/backdrops/{id}/panorama → image/png      /depth → image/png (16-bit grey)      /dome → model/gltf-binary
  POST /v1/backdrops/{id}/cancel → {id, status}
"""
import base64, binascii, concurrent.futures, gc, importlib, importlib.util, io, json, os, queue, secrets, subprocess, sys, threading, time, types
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

here = os.path.dirname(os.path.abspath(__file__))
_spec = importlib.util.spec_from_file_location("mux_backdrop_dome", os.path.join(here, "dome.py"))
dome = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(dome)

home = os.path.expanduser
PORT = int(os.environ.get("MUX_BACKDROP_PORT", "8316"))
MODEL = os.environ.get("MUX_BACKDROP_MODEL", "hunyuanworld-pano-moge2")  # the mux model id this server answers for
ROUTE = "backdrop"                                                          # what the contract calls it
DEVICE = os.environ.get("MUX_BACKDROP_DEVICE", "mps")
HW_CODE = home(os.environ.get("MUX_BACKDROP_HW_CODE", "~/.mux/backdrop/HunyuanWorld-1.0"))
FLUX_DIR = home(os.environ.get("MUX_BACKDROP_FLUX", "~/.mux/models/flux.1-dev"))
FILL_DIR = home(os.environ.get("MUX_BACKDROP_FLUX_FILL", "~/.mux/models/flux.1-fill-dev"))
LORA_DIR = home(os.environ.get("MUX_BACKDROP_LORA", "~/.mux/models/hunyuanworld-1"))
MOGE_PATH = home(os.environ.get("MUX_BACKDROP_MOGE", "~/.mux/models/moge-2-vitl-normal/model.pt"))
IDLE_MIN = float(os.environ.get("MUX_BACKDROP_IDLE_MIN", "10"))
KEEP_S = float(os.environ.get("MUX_BACKDROP_KEEP_S", "3600"))
MAX_QUEUE = int(os.environ.get("MUX_BACKDROP_QUEUE", "4"))
MAX_BODY = 50 * 1024 * 1024
MAX_PIXELS = 50_000_000
SIZES = {"1920x960": (1920, 960)}
# HunyuanWorld 1.0's own settings (demo_panogen.py): 50 steps, guidance 30, the seam blended over 6 latent columns;
# from an image, true CFG 2.0 against its negative prompt and the photo placed at 80° field of view facing forward.
STEPS = int(os.environ.get("MUX_BACKDROP_STEPS", "50"))
GUIDANCE = float(os.environ.get("MUX_BACKDROP_GUIDANCE", "30"))
BLEND_EXTEND = 6
IMAGE_TRUE_CFG = 2.0
IMAGE_FOV = 80
IMAGE_POSITIVE = "high-quality,  high-resolution, sharp, clear, 8k"
IMAGE_NEGATIVE = "human, person, people, messy,low-quality, blur, noise, low-resolution"
GRID = tuple(int(x) for x in os.environ.get("MUX_BACKDROP_GRID", "256x128").split("x"))
MERGE_W = int(os.environ.get("MUX_BACKDROP_MERGE_WIDTH", "1024"))       # MoGe's panorama merge (a sparse solve) runs at this width
MOGE_FP16 = os.environ.get("MUX_BACKDROP_MOGE_FP16", "0") == "1"         # half precision on MPS: not tried yet
# What macOS must have free before each part loads (GB). The transformer's figure is its bf16 weights (23.8 GB) and
# the work at 1920 × 960; mux's memory budget does not count this server, so it checks for itself. 0 turns a check off.
NEED_TEXT = float(os.environ.get("MUX_BACKDROP_TEXT_FREE_GB", "12"))
NEED_PANO = float(os.environ.get("MUX_BACKDROP_PANO_FREE_GB", "30"))
NEED_DEPTH = float(os.environ.get("MUX_BACKDROP_DEPTH_FREE_GB", "5"))


class BadInput(ValueError):
    pass


class Cancelled(Exception):
    pass


class Job:
    def __init__(self, req):
        self.id = "backdrop_" + secrets.token_hex(12)
        self.req = req  # validated request (prompt, image, seed): dropped once the job ends
        self.status = "queued"
        self.progress = 0.0
        self.error = None
        self.meta = None
        self.files = {}  # "panorama" | "depth" | "dome" → bytes, once succeeded
        self.created = time.time()
        self.finished = None
        self.cancel = threading.Event()

    def view(self):
        out = {"id": self.id, "object": "backdrop", "status": self.status, "progress": round(self.progress, 3), "model": ROUTE,
               "size": "1920x960", "created_at": int(self.created)}
        if self.error:
            out["error"] = self.error
        if self.meta:
            out["meta"] = self.meta
        return out

    def end(self, status, error=None):
        self.status = status
        self.error = error
        self.finished = time.time()
        self.req = None


_jobs = {}
_jobs_lock = threading.Lock()
_queue = queue.Queue()
_gpu = threading.Lock()   # one job at a time; also guards loading and letting go
_device = concurrent.futures.ThreadPoolExecutor(max_workers=1, thread_name_prefix="mps")
_pano = None              # (mode "text" | "image", the panorama pipeline without its text encoders)
_moge = None
_last_used = 0.0


def on_device(fn, *args, **kwargs):
    """Run fn on the device thread and wait for it; exceptions come back to the caller."""
    return _device.submit(fn, *args, **kwargs).result()


def log(msg):
    print(msg, file=sys.stderr, flush=True)


# ── Memory ───────────────────────────────────────────────────────────────────────────────────────────────────────

def available_gb():
    """What macOS could hand out now (free, inactive, purgeable, speculative pages); None where it cannot be read."""
    if sys.platform != "darwin":
        return None
    try:
        out = subprocess.run(["vm_stat"], capture_output=True, text=True, timeout=5).stdout
        page = int(out.split("page size of ")[1].split()[0])
        pages = {k.strip(): int(v.strip().rstrip(".")) for k, v in (ln.split(":", 1) for ln in out.splitlines()[1:] if ":" in ln)}
        n = sum(pages.get(k, 0) for k in ("Pages free", "Pages inactive", "Pages purgeable", "Pages speculative"))
        return n * page / 1024**3
    except Exception:  # noqa: BLE001
        return None


def has_room(need):
    have = available_gb()
    return not need or have is None or have >= need, have


def free_device():
    gc.collect()
    try:
        import torch
        if DEVICE == "mps":
            torch.mps.empty_cache()
    except Exception:  # noqa: BLE001 – the memory still goes when Python frees it
        pass


def ensure_room(need, what, drop=()):
    """Before loading `what`: if macOS lacks `need` GB, let go of the parts named in `drop` first; then refuse."""
    ok, have = has_room(need)
    if not ok and drop:
        for name in drop:
            let_go(name)
        ok, have = has_room(need)
    if not ok:
        raise MemoryError(f"only {have:.0f} GB free on this Mac; {what} wants {need:g} GB: try again when the chat models have been let go")


def let_go(name="all"):
    global _pano, _moge
    if name in ("pano", "all") and _pano is not None:
        _pano = None
        log("let go of the panorama model")
    if name in ("moge", "all") and _moge is not None:
        _moge = None
        log("let go of the depth model")
    free_device()


def loaded():
    return _pano is not None


def busy_reason():
    """Why a new job cannot be taken now, in words, or None. Only when nothing is loaded or running: a job already
    accepted, or a model already in memory, means the room was found."""
    if _pano is not None or any(j.status in ("queued", "running") for j in list(_jobs.values())):
        return None
    ok, have = has_room(NEED_PANO)
    if ok:
        return None
    return (f"the Mac is busy: it has {have:.0f} GB of memory free and a backdrop needs about {NEED_PANO:g} GB "
            "(the panorama model alone is 24 GB); try again when it is less busy")


# ── The models (only on the Mac: torch, diffusers, HunyuanWorld 1.0 and MoGe are imported here, not at the top) ──

def hunyuanworld():
    """HunyuanWorld 1.0's panorama code (hy3dworld/models/pano_generator.py and pipelines.py, and its
    perspective-to-equirectangular helper), without the package's __init__, which imports the scene step (open3d,
    ZIM, Grounding DINO, Real-ESRGAN, MoGe v1) that a panorama does not need."""
    if "hwpano" in sys.modules:
        return sys.modules["hwpano.pano_generator"], sys.modules["hwpano_perspective"]
    models = os.path.join(HW_CODE, "hy3dworld", "models")
    pkg = types.ModuleType("hwpano")
    pkg.__path__ = [models]
    sys.modules["hwpano"] = pkg
    gen = importlib.import_module("hwpano.pano_generator")
    spec = importlib.util.spec_from_file_location("hwpano_perspective", os.path.join(HW_CODE, "hy3dworld", "utils", "perspective_utils.py"))
    persp = importlib.util.module_from_spec(spec)
    sys.modules["hwpano_perspective"] = persp
    spec.loader.exec_module(persp)
    return gen, persp


def encode_prompts(prompt, negative):
    """FLUX's T5-XXL and CLIP, loaded for this one encoding and let go after (they are never needed beside the
    transformer). With the transformer resident and no room for both, the transformer goes first."""
    import torch
    from diffusers import FluxPipeline
    ensure_room(NEED_TEXT, "FLUX's text encoders", drop=("pano",))
    t = time.time()
    enc = FluxPipeline.from_pretrained(FLUX_DIR, transformer=None, vae=None, torch_dtype=torch.bfloat16).to(DEVICE)
    try:
        with torch.no_grad():
            pe, pooled, _ = enc.encode_prompt(prompt=prompt, prompt_2=None, device=DEVICE, max_sequence_length=512)
            neg = enc.encode_prompt(prompt=negative, prompt_2=None, device=DEVICE, max_sequence_length=512)[:2] if negative is not None else None
    finally:
        del enc
        free_device()
    log(f"text encoded in {time.time() - t:.0f} s")
    return pe, pooled, neg


def panorama_pipeline(mode):
    """The panorama pipeline for "text" (FLUX.1-dev + PanoDiT-Text) or "image" (FLUX.1-Fill-dev + PanoDiT-Image),
    its LoRA fused, its text encoders left out (encode_prompts does that). One transformer in memory at a time."""
    global _pano
    if _pano is not None and _pano[0] == mode:
        return _pano[1]
    let_go("pano")
    ensure_room(NEED_PANO, "the panorama model (FLUX, 24 GB in bf16)", drop=("moge",))
    import torch
    gen, _ = hunyuanworld()
    t = time.time()
    if mode == "text":
        pipe = gen.Text2PanoramaPipelines.from_pretrained(FLUX_DIR, text_encoder=None, text_encoder_2=None, torch_dtype=torch.bfloat16)
        sub = "HunyuanWorld-PanoDiT-Text"
    else:
        from diffusers import AutoencoderKL, FlowMatchEulerDiscreteScheduler, FluxTransformer2DModel
        from transformers import CLIPTokenizer, T5TokenizerFast
        # Fill-dev's own transformer, VAE and scheduler; its tokenizers (and text encoders) are FLUX.1-dev's, the same
        # T5-XXL and CLIP-L, so they are not downloaded twice.
        pipe = gen.Image2PanoramaPipelines(
            scheduler=FlowMatchEulerDiscreteScheduler.from_pretrained(FILL_DIR, subfolder="scheduler"),
            vae=AutoencoderKL.from_pretrained(FILL_DIR, subfolder="vae", torch_dtype=torch.bfloat16),
            text_encoder=None, tokenizer=CLIPTokenizer.from_pretrained(FLUX_DIR, subfolder="tokenizer"),
            text_encoder_2=None, tokenizer_2=T5TokenizerFast.from_pretrained(FLUX_DIR, subfolder="tokenizer_2"),
            transformer=FluxTransformer2DModel.from_pretrained(FILL_DIR, subfolder="transformer", torch_dtype=torch.bfloat16))
        sub = "HunyuanWorld-PanoDiT-Image"
    pipe.load_lora_weights(LORA_DIR, subfolder=sub, weight_name="lora.safetensors", torch_dtype=torch.bfloat16)
    pipe.fuse_lora(components=["transformer"])
    pipe.unload_lora_weights()
    pipe.to(DEVICE)
    pipe.set_progress_bar_config(disable=True)
    _pano = (mode, pipe)
    log(f"loaded the panorama model ({mode}) in {time.time() - t:.0f} s")
    return pipe


def image_to_equirect(image, persp):
    """HunyuanWorld's placement of a photo in the panorama (demo_panogen.py, Image2PanoramaDemo.run): scaled to an
    80° field of view, facing forward (the centre column), the rest masked to be made."""
    import cv2
    import numpy as np
    from PIL import Image
    w_pano, h_pano = SIZES["1920x960"]
    bgr = np.asarray(image.convert("RGB"))[:, :, ::-1].copy()
    hf, wf = bgr.shape[:2]
    if wf > hf:
        w = int((IMAGE_FOV / 360) * w_pano)
        h = int(w / (wf / hf))
    else:
        h = int((IMAGE_FOV / 180) * h_pano)
        w = int(h / (hf / wf))
    bgr = cv2.resize(bgr, (w, h), interpolation=cv2.INTER_AREA)
    img, mask = persp.Perspective(bgr, IMAGE_FOV, 0, 0, crop_bound=False).GetEquirec(h_pano, w_pano)
    mask = cv2.erode(mask.astype(np.uint8), np.ones((3, 3), np.uint8), iterations=5)
    img = img * mask
    mask = 255 - mask.astype(np.uint8) * 255
    return Image.fromarray(cv2.cvtColor(img.astype(np.uint8), cv2.COLOR_BGR2RGB)), Image.fromarray(mask[:, :, 0])


def make_panorama(req, on_step):
    """The panorama, as a PIL RGB image 1920 × 960. on_step(i, steps) may raise Cancelled."""
    import torch
    w, h = SIZES[req["size"]]
    image = req.get("image")
    mode = "image" if image is not None else "text"
    if mode == "text":
        pe, pooled, _ = encode_prompts(req["prompt"], None)
        extra = {"true_cfg_scale": 0.0}
    else:
        pe, pooled, neg = encode_prompts(req["prompt"] + ", " + IMAGE_POSITIVE, IMAGE_NEGATIVE + ", ")
        extra = {"true_cfg_scale": IMAGE_TRUE_CFG, "negative_prompt_embeds": neg[0], "negative_pooled_prompt_embeds": neg[1], "shifting_extend": 0}
    on_step(0, STEPS)  # a cancel while the prompt was encoded stops here
    pipe = panorama_pipeline(mode)
    if mode == "image":
        _, persp = hunyuanworld()
        extra["image"], extra["mask_image"] = image_to_equirect(image, persp)

    def cb(_pipe, i, _t, kwargs):
        on_step(i + 1, STEPS)
        return kwargs

    out = pipe(prompt=None, prompt_embeds=pe, pooled_prompt_embeds=pooled, height=h, width=w,
               generator=torch.Generator("cpu").manual_seed(req["seed"]), num_inference_steps=STEPS,
               guidance_scale=GUIDANCE, blend_extend=BLEND_EXTEND, callback_on_step_end=cb, **extra).images[0]
    return out.convert("RGB")


def depth_model():
    global _moge
    if _moge is None:
        ensure_room(NEED_DEPTH, "MoGe-2")
        from moge.model.v2 import MoGeModel
        t = time.time()
        _moge = MoGeModel.from_pretrained(MOGE_PATH).to(DEVICE).eval()
        log(f"loaded the depth model in {time.time() - t:.0f} s")
    return _moge


def make_depth(rgb, on_view):
    """MoGe-2 on the panorama → (distance along each pixel's ray, H × W float32, sky False in `valid`, metric bool).

    MoGe's own panorama recipe (moge/scripts/infer_panorama.py): 20 perspective views of 90° (an icosahedron's
    vertices), each inferred at 512 px, merged by a Poisson solve on log distance, which keeps shape but not scale; the
    scale is then put back as the median ratio of each view's own (metric) distance to the merged one.
    """
    import cv2
    import numpy as np
    import torch
    import utils3d
    from moge.utils.panorama import get_panorama_cameras, merge_panorama_depth, split_panorama_image, spherical_uv_to_directions
    model = depth_model()
    h, w = rgb.shape[:2]
    extr, intr = get_panorama_cameras()
    views = split_panorama_image(rgb, extr, intr, 512)
    dists, masks = [], []
    for i in range(0, len(views), 4):
        x = torch.tensor(np.stack(views[i:i + 4]) / 255, dtype=torch.float32, device=DEVICE).permute(0, 3, 1, 2)
        fov_x, _ = np.rad2deg(utils3d.np.intrinsics_to_fov(np.array(intr[i:i + 4])))
        with torch.no_grad():
            out = model.infer(x, fov_x=torch.tensor(fov_x, dtype=torch.float32, device=DEVICE), apply_mask=False, use_fp16=MOGE_FP16)
        dists.extend(list(out["points"].norm(dim=-1).cpu().numpy()))
        masks.extend(list(out["mask"].cpu().numpy()))
        on_view(min(i + 4, len(views)), len(views))
    mw, mh = min(MERGE_W, w), min(MERGE_W, w) // 2
    merged, mask = merge_panorama_depth(mw, mh, dists, masks, extr, intr)
    # Back to metres: along the same rays, each view's distance over the merged one
    dirs = spherical_uv_to_directions(utils3d.np.uv_map(mh, mw))
    ratios = []
    for i in range(len(dists)):
        uv, z = utils3d.np.project_cv(dirs, extrinsics=extr[i], intrinsics=intr[i])
        seen = (z > 0) & (uv > 0).all(axis=-1) & (uv < 1).all(axis=-1) & mask
        if not seen.any():
            continue
        px = utils3d.np.uv_to_pixel(uv[seen], dists[i].shape).astype(int)
        px[:, 0] = np.clip(px[:, 0], 0, dists[i].shape[1] - 1)
        px[:, 1] = np.clip(px[:, 1], 0, dists[i].shape[0] - 1)
        good = masks[i][px[:, 1], px[:, 0]]
        ratios.append(dists[i][px[good, 1], px[good, 0]] / merged[seen][good])
    ratios = np.concatenate(ratios) if ratios else np.array([])
    ratios = ratios[np.isfinite(ratios) & (ratios > 0)]
    metric = ratios.size > 1000
    merged = merged * (float(np.median(ratios)) if metric else 1.0)
    depth = cv2.resize(merged.astype(np.float32), (w, h), interpolation=cv2.INTER_LINEAR)
    valid = cv2.resize(mask.astype(np.uint8), (w, h), interpolation=cv2.INTER_NEAREST) > 0
    return depth, valid, metric


def png_bytes(img):
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue()


def make_backdrop(req, job):
    """The whole job on the device thread: panorama, depth, dome. Progress: the panorama to 0.80, depth to 0.95."""
    import numpy as np

    def on_step(i, steps):
        if job.cancel.is_set():
            raise Cancelled()
        job.progress = max(job.progress, 0.03 + 0.77 * i / steps)

    def on_view(i, n):
        if job.cancel.is_set():
            raise Cancelled()
        job.progress = max(job.progress, 0.82 + 0.1 * i / n)

    job.progress = 0.01
    pano = make_panorama(req, on_step)
    rgb = np.asarray(pano.convert("RGB"))
    job.progress = 0.81
    depth, valid, metric = make_depth(rgb, on_view)
    if job.cancel.is_set():
        raise Cancelled()
    job.progress = 0.95
    info = dome.analyse(depth, valid)
    depth_png, scale_kind, unit = dome.encode_depth(depth, valid, metric, info["reference"])
    glb, decided = dome.dome_glb(rgb, depth, valid, grid=GRID, info=info)
    meta = {"horizon": round(float(info["horizon"]), 4), "depthScale": scale_kind}
    if info["ground"] is not None:
        meta["groundDepth"] = round(info["ground"][1] / unit, 3)
    return {"panorama": png_bytes(pano), "depth": depth_png, "dome": glb}, meta


# ── Input ────────────────────────────────────────────────────────────────────────────────────────────────────────

def b64(value, what):
    if not isinstance(value, str) or not value.strip():
        raise BadInput(f"{what} must be a base64 image")
    if value.startswith("data:"):
        value = value.split(",", 1)[-1]
    try:
        return base64.b64decode(value, validate=False)
    except (binascii.Error, ValueError):
        raise BadInput(f"{what} is not base64")


def read_image(data):
    from PIL import Image, ImageOps
    Image.MAX_IMAGE_PIXELS = MAX_PIXELS
    try:
        im = Image.open(io.BytesIO(data))
        if im.width * im.height > MAX_PIXELS:
            raise BadInput(f"image_b64 is over {MAX_PIXELS // 1_000_000} megapixels")
        im.load()
    except BadInput:
        raise
    except Exception:  # noqa: BLE001
        raise BadInput("image_b64 is not an image (JPEG, PNG or WebP)")
    im = ImageOps.exif_transpose(im)
    if im.width < 64 or im.height < 64:
        raise BadInput("image_b64 is smaller than 64 × 64 pixels")
    return im.convert("RGB")


def image_ready():
    """Whether this Mac has the image-to-panorama parts (FLUX.1-Fill-dev and PanoDiT-Image): deploy/backdrop.sh --image."""
    return (os.path.isfile(os.path.join(FILL_DIR, "transformer", "config.json"))
            and os.path.isfile(os.path.join(LORA_DIR, "HunyuanWorld-PanoDiT-Image", "lora.safetensors")))


def validate(b):
    """The request body → what a job needs. BadInput (400) names what is wrong."""
    if not isinstance(b, dict):
        raise BadInput("the body must be a JSON object")
    prompt = b.get("prompt")
    if not isinstance(prompt, str) or not prompt.strip():
        raise BadInput("prompt is required: words for the place to make")
    if len(prompt) > 2000:
        raise BadInput("prompt is longer than 2000 characters")
    size = b.get("size", "1920x960")
    if size not in SIZES:
        raise BadInput('size must be "1920x960" (the only size: an equirectangular 2:1 panorama)')
    seed = b.get("seed")
    if seed is None:
        seed = secrets.randbelow(2**31)
    elif isinstance(seed, bool) or not isinstance(seed, int) or not 0 <= seed < 2**63:
        raise BadInput("seed must be a whole number from 0")
    req = {"prompt": prompt.strip(), "size": size, "seed": seed, "image": None}
    if b.get("image_b64") is not None:
        if not image_ready():
            raise BadInput("image_b64: this Mac makes backdrops from text only (FLUX.1-Fill-dev is not installed: deploy/backdrop.sh --image); send the prompt alone")
        req["image"] = read_image(b64(b.get("image_b64"), "image_b64"))
    return req


# ── Jobs ─────────────────────────────────────────────────────────────────────────────────────────────────────────

def run(job):
    global _last_used
    with _gpu:
        if job.status != "queued":  # cancelled while it waited
            return
        job.status = "running"
        try:
            files, meta = on_device(make_backdrop, job.req, job)
            _last_used = time.time()
            if job.cancel.is_set():
                raise Cancelled()
            job.files, job.meta = files, meta
            job.progress = 1.0
            job.end("succeeded")
        except Cancelled:
            _last_used = time.time()
            job.end("cancelled")
        except Exception as e:  # noqa: BLE001 – the caller gets the reason; never the prompt or the image
            _last_used = time.time()
            msg = str(e)[:300] or type(e).__name__
            kind = "out_of_memory" if isinstance(e, MemoryError) or "out of memory" in msg.lower() else "server_error"
            log(f"job {job.id} failed: {type(e).__name__}")
            job.end("failed", {"type": kind, "message": msg})


def worker():
    while True:
        job = _queue.get()
        try:
            run(job)
        finally:
            _queue.task_done()


def submit(req):
    with _jobs_lock:
        waiting = sum(1 for j in _jobs.values() if j.status in ("queued", "running"))
        if waiting >= MAX_QUEUE:
            return None
        job = Job(req)
        _jobs[job.id] = job
    _queue.put(job)
    return job


def cancel(job):
    if job.status in ("queued", "running"):
        job.cancel.set()
        if job.status == "queued":
            job.end("cancelled")
        else:
            # The device stops at its next step; the job says so now, and its files never come.
            job.status = "cancelled"
    return job


def get(job_id):
    with _jobs_lock:
        job = _jobs.get(job_id)
        if job and job.finished and time.time() - job.finished > KEEP_S:
            del _jobs[job_id]
            return None
        return job


def reap():
    with _jobs_lock:
        for jid in [j.id for j in _jobs.values() if j.finished and time.time() - j.finished > KEEP_S]:
            del _jobs[jid]


def idle_watch():
    while True:
        time.sleep(30)
        reap()
        if (_pano is not None or _moge is not None) and time.time() - _last_used > IDLE_MIN * 60 and _gpu.acquire(blocking=False):
            try:
                if time.time() - _last_used > IDLE_MIN * 60:
                    on_device(let_go)
                    log(f"idle {IDLE_MIN:g} minutes")
            finally:
                _gpu.release()


# ── HTTP ─────────────────────────────────────────────────────────────────────────────────────────────────────────

FILES = {"panorama": "image/png", "depth": "image/png", "dome": "model/gltf-binary"}


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def _send(self, status, obj):
        body = json.dumps(obj).encode()
        self.send_response(status)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _error(self, status, message, kind=None):
        self._send(status, {"error": {"message": message, "type": kind or ("invalid_request_error" if status < 500 else "server_error")}})

    def _path(self):
        return self.path.split("?")[0].rstrip("/")

    def do_GET(self):
        path = self._path()
        if path in ("", "/health", "/v1/models"):
            return self._send(200, {"object": "list", "data": [{"id": MODEL, "object": "model", "route": ROUTE, "loaded": loaded()}]})
        parts = path.split("/")  # ["", "v1", "backdrops", id, (file)]
        if len(parts) in (4, 5) and parts[1:3] == ["v1", "backdrops"]:
            job = get(parts[3])
            if not job:
                return self._error(404, "no such backdrop (or it expired: backdrops are kept 1 hour)", "not_found")
            if len(parts) == 4:
                return self._send(200, job.view())
            if parts[4] in FILES:
                data = job.files.get(parts[4]) if job.status == "succeeded" else None
                if data is None:
                    return self._error(409, f"the backdrop is {job.status}, not ready", "not_ready")
                self.send_response(200)
                self.send_header("content-type", FILES[parts[4]])
                self.send_header("content-length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)
                return
        self._error(404, "not found", "not_found")

    def do_POST(self):
        path = self._path()
        try:
            length = int(self.headers.get("content-length") or 0)
        except ValueError:
            return self._error(400, "bad content-length")
        if length > MAX_BODY:
            self.close_connection = True
            return self._error(413, f"the body is over {MAX_BODY // 1024 // 1024} MB", "request_too_large")
        raw = self.rfile.read(length) if length else b""
        parts = path.split("/")
        if path == "/v1/backdrops":
            try:
                b = json.loads(raw or b"{}")
            except ValueError:
                return self._error(400, "the body is not JSON")
            try:
                req = validate(b)
            except BadInput as e:
                return self._error(400, str(e))
            except Exception as e:  # noqa: BLE001
                return self._error(400, f"the input could not be read: {str(e)[:200]}")
            why = busy_reason()
            if why:
                return self._error(429, why, "busy")
            job = submit(req)
            if job is None:
                return self._error(429, f"the Mac is busy: {MAX_QUEUE} backdrops are already waiting or being made; try again later", "queue_full")
            return self._send(202, {"id": job.id, "object": "backdrop", "status": job.status, "model": ROUTE})
        if len(parts) == 5 and parts[1:3] == ["v1", "backdrops"] and parts[4] == "cancel":
            job = get(parts[3])
            if not job:
                return self._error(404, "no such backdrop (or it expired)", "not_found")
            cancel(job)
            return self._send(200, {"id": job.id, "status": job.status})
        self._error(404, "not found", "not_found")

    def log_message(self, *_):
        pass


def start(port=PORT):
    """The server and its threads; serve_forever() is the caller's (tests run it on a thread)."""
    threading.Thread(target=worker, daemon=True).start()
    threading.Thread(target=idle_watch, daemon=True).start()
    return ThreadingHTTPServer(("127.0.0.1", port), Handler)


def warm():
    """deploy/backdrop.sh: load each part once (text encoders, the text panorama model, MoGe-2), then exit."""
    encode_prompts("a quiet meadow at dawn", None)
    panorama_pipeline("text")
    depth_model()


if __name__ == "__main__":
    if "--warm" in sys.argv:
        on_device(warm)
        sys.exit(0)
    log(f"backdrop on 127.0.0.1:{PORT}: {MODEL} ({DEVICE}), {STEPS} steps, grid {GRID[0]}x{GRID[1]}, idle {IDLE_MIN:g} min, kept {KEEP_S / 60:g} min")
    start().serve_forever()
