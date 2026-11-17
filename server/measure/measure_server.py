"""Measure for mux: metric depth from one photo, and cameras with a metric point cloud from 2–12 photos.

The "Measure" stage of Thread's Reference Build (Thread's docs/proposals/2026-11-17-reference-build.html, section 6):
photos of a house become real metres. Why these models, their licences, what is proven on Apple Silicon and what is
not: docs/measure.md. In short:

- Depth: Apple's Depth Pro (code at ml-depth-pro 9e65e4d, the 2024 checkpoint from Apple's CDN; both under Apple's
  own permissive licence. NOT the Hugging Face `apple/DepthPro` checkpoint, which is research-only).
- Reconstruction: MapAnything's Apache build (`facebook/map-anything-apache`), metric, on MPS since its PR #131.
  `MUX_MEASURE_RECON=vggt` swaps in VGGT-1B-Commercial (not metric: its scale comes from one measurement or Depth Pro).

Runs in ~/.mux/measure-venv (deploy/measure.sh), launchd agent com.mux.measure on 127.0.0.1:8314.

- One job at a time: a reconstruction and a depth request never run together. Reconstructions wait in a queue (at
  most MUX_MEASURE_QUEUE); a depth request waits for the device, up to MUX_MEASURE_DEPTH_WAIT_S, then is told busy.
- Each model loads on first use and is let go after MUX_MEASURE_IDLE_MIN idle minutes.
- Every PyTorch call (load, infer, let go) runs on one device thread, `on_device`, like the image and video servers.
- Nothing about the photos is logged: not their size, not a coordinate. Photos are held in memory only.
- A finished reconstruction is kept KEEP_S (1 hour), then the job is gone (404).

Contract (Thread is built against it; docs/measure.md has the long form):
  POST /v1/depth        {image_b64, focal_px?}  → {model, width, height, focal_px, focal_source, depth_png16_b64, unit: "mm", …}
  POST /v1/reconstruct  {images_b64: [2–12], known?: {intrinsics?, one_measurement?: {photo, p1, p2, metres}}, max_points?}
                        → 202 {id, status: "queued", model}
  GET  /v1/reconstruct/{id}         → {id, status, progress, model, error?, result? (when succeeded)}
  POST /v1/reconstruct/{id}/cancel  → {id, status}
"""
import base64, binascii, concurrent.futures, gc, io, json, math, os, queue, secrets, subprocess, sys, threading, time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PORT = int(os.environ.get("MUX_MEASURE_PORT", "8314"))
DEVICE = os.environ.get("MUX_MEASURE_DEVICE", "mps")
DEPTH_MODEL = os.environ.get("MUX_MEASURE_DEPTH_MODEL", "depth-pro")
DEPTH_CHECKPOINT = os.path.expanduser(os.environ.get("MUX_MEASURE_DEPTH_CHECKPOINT", "~/.mux/models/depth-pro/depth_pro.pt"))
RECON = os.environ.get("MUX_MEASURE_RECON", "mapanything")  # mapanything | vggt
RECON_MODEL = os.environ.get("MUX_MEASURE_RECON_MODEL", "mapanything-apache" if RECON == "mapanything" else "vggt-1b-commercial")
RECON_PATH = os.path.expanduser(os.environ.get("MUX_MEASURE_RECON_PATH", "~/.mux/models/map-anything-apache" if RECON == "mapanything" else "~/.mux/models/vggt-1b-commercial"))
# MapAnything's mixed precision on MPS is unproven (docs/measure.md): full precision unless told otherwise
AMP = os.environ.get("MUX_MEASURE_AMP", "off")  # off | bf16 | fp16
IDLE_MIN = float(os.environ.get("MUX_MEASURE_IDLE_MIN", "10"))
KEEP_S = float(os.environ.get("MUX_MEASURE_KEEP_S", "3600"))
MAX_QUEUE = int(os.environ.get("MUX_MEASURE_QUEUE", "6"))
DEPTH_WAIT_S = float(os.environ.get("MUX_MEASURE_DEPTH_WAIT_S", "300"))
MAX_BODY = {"/v1/depth": 50 * 1024 * 1024, "/v1/reconstruct": 150 * 1024 * 1024}
MAX_PIXELS = 50_000_000  # per photo: a 48 MP phone photo fits, a decompression bomb does not
MIN_PHOTOS, MAX_PHOTOS = 2, 12
DEFAULT_POINTS, MAX_POINTS = 400_000, 2_000_000
MIN_FREE_GB = {"depth": float(os.environ.get("MUX_MEASURE_DEPTH_MIN_FREE_GB", "6")),
               "recon": float(os.environ.get("MUX_MEASURE_RECON_MIN_FREE_GB", "14"))}


class BadInput(ValueError):
    pass


class Cancelled(Exception):
    pass


class Busy(Exception):
    pass


# ── Photos ───────────────────────────────────────────────────────────────────────────────────────────────────────

def b64(value, what):
    if not isinstance(value, str) or not value.strip():
        raise BadInput(f"{what} is required (base64)")
    if value.startswith("data:"):
        value = value.split(",", 1)[-1]
    try:
        return base64.b64decode(value, validate=False)
    except (binascii.Error, ValueError):
        raise BadInput(f"{what} is not base64")


def exif_focal_px(im, w, h):
    """The focal length in pixels from EXIF's 35 mm equivalent, as Depth Pro's own loader reads it; None without it."""
    try:
        f35 = im.getexif().get_ifd(0x8769).get(41989)  # FocalLengthIn35mmFilm
        if f35:
            return float(f35) * math.hypot(w, h) / math.hypot(36, 24)
    except Exception:  # noqa: BLE001 – no EXIF is the usual case
        pass
    return None


def decode_photo(data, what):
    """Bytes → (PIL RGB, upright as the camera held it, focal px from EXIF or None). HEIC if pillow-heif is there."""
    from PIL import Image, ImageOps
    try:
        import pillow_heif  # noqa: F401
        pillow_heif.register_heif_opener()
    except Exception:  # noqa: BLE001
        pass
    Image.MAX_IMAGE_PIXELS = MAX_PIXELS
    try:
        im = Image.open(io.BytesIO(data))
        if im.width * im.height > MAX_PIXELS:
            raise BadInput(f"{what} is over {MAX_PIXELS // 1_000_000} megapixels")
        im.load()
    except BadInput:
        raise
    except Image.DecompressionBombError:
        raise BadInput(f"{what} is over {MAX_PIXELS // 1_000_000} megapixels")
    except Exception:  # noqa: BLE001 – Pillow's own words could carry nothing useful; the field is enough
        raise BadInput(f"{what} is not an image (JPEG, PNG, WebP or HEIC)")
    up = ImageOps.exif_transpose(im)
    return up.convert("RGB"), exif_focal_px(im, *up.size)


def cover_crop(im, tw, th):
    """Scale a photo to cover tw × th, then cut the middle. Returns the image and (s, left, top): a pixel x in the
    photo is (x + 0.5) * s - 0.5 - left in the crop."""
    from PIL import Image
    s = max(tw / im.width, th / im.height)
    rw, rh = max(tw, round(im.width * s)), max(th, round(im.height * s))
    left, top = (rw - tw) // 2, (rh - th) // 2
    return im.resize((rw, rh), Image.LANCZOS).crop((left, top, left + tw, top + th)), (s, left, top)


def to_crop(x, y, tf):
    s, left, top = tf
    return (x + 0.5) * s - 0.5 - left, (y + 0.5) * s - 0.5 - top


def k_to_photo(K, tf):
    """Intrinsics in crop pixels → in the photo's own pixels."""
    s, left, top = tf
    K = [list(map(float, r)) for r in K]
    return [[K[0][0] / s, K[0][1] / s, (K[0][2] + left + 0.5) / s - 0.5],
            [0.0, K[1][1] / s, (K[1][2] + top + 0.5) / s - 0.5],
            [0.0, 0.0, 1.0]]


def k_to_crop(K, tf):
    s, left, top = tf
    return [[K[0][0] * s, K[0][1] * s, (K[0][2] + 0.5) * s - 0.5 - left],
            [0.0, K[1][1] * s, (K[1][2] + 0.5) * s - 0.5 - top],
            [0.0, 0.0, 1.0]]


def png16(depth_m):
    """Depth in metres (H, W) → 16-bit greyscale PNG in millimetres; 0 = no depth; 65.535 m at most."""
    import numpy as np
    from PIL import Image
    d = np.asarray(depth_m, dtype=np.float64)
    mm = np.where(np.isfinite(d) & (d > 0), np.clip(np.round(d * 1000), 1, 65535), 0).astype(np.uint16)
    buf = io.BytesIO()
    Image.fromarray(mm).save(buf, format="PNG")  # uint16 → mode I;16
    return buf.getvalue()


# ── Models ───────────────────────────────────────────────────────────────────────────────────────────────────────

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


def check_memory(which, name):
    # mux's memory budget does not count this server, so it checks for itself, as the video server does.
    need, have = MIN_FREE_GB[which], available_gb()
    if need and have is not None and have < need:
        raise MemoryError(f"only {have:.0f} GB free on this Mac; {name} wants {need:g} GB: try again when the chat models have been let go")


def torch_device():
    import torch
    if DEVICE == "mps" and not torch.backends.mps.is_available():
        raise RuntimeError("PyTorch has no MPS device here (Apple Silicon with macOS 14 or later is needed)")
    return torch.device(DEVICE)


def load_depth():
    """Depth Pro from Apple's 2024 checkpoint, in full precision (half on MPS is not proven)."""
    check_memory("depth", DEPTH_MODEL)
    import torch
    import depth_pro
    from depth_pro.depth_pro import DEFAULT_MONODEPTH_CONFIG_DICT
    from dataclasses import replace
    t = time.time()
    cfg = replace(DEFAULT_MONODEPTH_CONFIG_DICT, checkpoint_uri=DEPTH_CHECKPOINT)
    model, transform = depth_pro.create_model_and_transforms(config=cfg, device=torch_device(), precision=torch.float32)
    model.eval()
    print(f"loaded {DEPTH_MODEL} in {time.time() - t:.0f} s", file=sys.stderr, flush=True)
    return (model, transform)


def depth_infer(loaded, im, f_px):
    """PIL RGB → (depth in metres as float32 (H, W) at the photo's size, focal px used, where the focal came from)."""
    import numpy as np
    import torch
    model, transform = loaded
    with torch.no_grad():
        x = transform(np.asarray(im))
        out = model.infer(x, f_px=torch.tensor(f_px, dtype=torch.float32, device=x.device) if f_px else None)
    depth = out["depth"].detach().float().cpu().numpy().astype("float32")
    return depth, float(out["focallength_px"].detach().float().cpu())


def load_recon():
    check_memory("recon", RECON_MODEL)
    t = time.time()
    if RECON == "vggt":
        from vggt.models.vggt import VGGT
        model = VGGT.from_pretrained(RECON_PATH).to(torch_device()).eval()
    else:
        from mapanything.models import MapAnything
        model = MapAnything.from_pretrained(RECON_PATH).to(torch_device()).eval()
    print(f"loaded {RECON_MODEL} in {time.time() - t:.0f} s", file=sys.stderr, flush=True)
    return model


def recon_size(photos):
    """The size every photo is cut to for the model, as the model's own loader would choose it."""
    if RECON == "vggt":  # VGGT's "crop" mode: 518 wide, height a multiple of 14, at most 518
        a = sum(p.width / p.height for p in photos) / len(photos)
        return 518, min(518, max(14, round(518 / a / 14) * 14))
    from mapanything.utils.image import find_closest_aspect_ratio
    return find_closest_aspect_ratio(sum(p.width / p.height for p in photos) / len(photos), 518)


def recon_infer(model, photos, known_k, step):
    """The model on the photos. Returns, per photo, in the model's world frame: pts3d (h, w, 3), conf (h, w), mask
    (h, w), K (crop pixels), cam2world (4 × 4), rgb (h, w, 3) uint8, tf (crop transform) — and whether it is metric.
    `step(progress)` may raise Cancelled between stages."""
    import numpy as np
    import torch
    tw, th = recon_size(photos)
    crops = [cover_crop(p, tw, th) for p in photos]
    step(0.2)
    dev = torch_device()
    if RECON == "vggt":
        from vggt.utils.pose_enc import pose_encoding_to_extri_intri
        imgs = torch.stack([torch.from_numpy(np.asarray(c, dtype=np.float32) / 255.0).permute(2, 0, 1) for c, _ in crops]).to(dev)
        with torch.no_grad():
            pred = model(imgs)
        step(0.8)
        extr, intr = pose_encoding_to_extri_intri(pred["pose_enc"], imgs.shape[-2:])
        views = []
        for i, (c, tf) in enumerate(crops):
            E = np.eye(4)
            E[:3, :4] = extr[0, i].float().cpu().numpy()
            pts = pred["world_points"][0, i].float().cpu().numpy()
            conf = pred["world_points_conf"][0, i].float().cpu().numpy()
            views.append({"pts3d": pts, "conf": conf, "mask": np.isfinite(pts).all(-1), "K": intr[0, i].float().cpu().numpy(),
                          "cam2world": np.linalg.inv(E), "rgb": np.asarray(c), "tf": tf,
                          "depth": pred["depth"][0, i, ..., 0].float().cpu().numpy()})
        return views, False
    from mapanything.utils.image import preprocess_inputs
    inputs = []
    for i, (c, tf) in enumerate(crops):
        v = {"img": torch.from_numpy(np.asarray(c).copy())}
        if known_k and known_k[i] is not None:
            v["intrinsics"] = torch.tensor(k_to_crop(known_k[i], tf), dtype=torch.float32)
        inputs.append(v)
    processed = preprocess_inputs(inputs)
    step(0.3)
    with torch.no_grad():
        preds = model.infer(processed, memory_efficient_inference=True, use_amp=AMP != "off", amp_dtype=AMP if AMP != "off" else "bf16",
                            apply_mask=True, mask_edges=True)
    step(0.8)
    views = []
    for (c, tf), p in zip(crops, preds):
        pts = p["pts3d"][0].float().cpu().numpy()
        h2, w2 = pts.shape[:2]
        if (w2, h2) != (tw, th):  # the model's loader cut again: compose its cut with ours
            s2 = max(w2 / tw, h2 / th)
            tf = (tf[0] * s2, tf[1] * s2 + (max(w2, round(tw * s2)) - w2) // 2, tf[2] * s2 + (max(h2, round(th * s2)) - h2) // 2)
        rgb = p["img_no_norm"][0].float().cpu().numpy()
        rgb = (np.clip(rgb * (255.0 if rgb.max() <= 1.5 else 1.0), 0, 255)).round().astype(np.uint8)
        views.append({"pts3d": pts, "conf": p["conf"][0].float().cpu().numpy(), "mask": p["mask"][0].cpu().numpy().reshape(h2, w2).astype(bool),
                      "K": p["intrinsics"][0].float().cpu().numpy(), "cam2world": p["camera_poses"][0].float().cpu().numpy(),
                      "rgb": rgb, "tf": tf})
    return views, True


def let_go_model(which):
    _models[which] = None
    gc.collect()
    try:
        import torch
        if DEVICE == "mps":
            torch.mps.empty_cache()
    except Exception:  # noqa: BLE001 – the memory still goes when Python frees it
        pass
    print(f"let go of {DEPTH_MODEL if which == 'depth' else RECON_MODEL} after {IDLE_MIN:g} idle minutes", file=sys.stderr, flush=True)


# ── State ────────────────────────────────────────────────────────────────────────────────────────────────────────

_models = {"depth": None, "recon": None}
_last_used = {"depth": 0.0, "recon": 0.0}
_jobs = {}
_jobs_lock = threading.Lock()
_queue = queue.Queue()
_gpu = threading.Lock()  # one piece of work at a time; also guards loading and letting go
# PyTorch's device state (MPS streams, the allocator) is used from one thread only, as the image server does for MLX.
_device = concurrent.futures.ThreadPoolExecutor(max_workers=1, thread_name_prefix="mps")


def on_device(fn, *args, **kwargs):
    """Run fn on the device thread and wait for it; exceptions come back to the caller."""
    return _device.submit(fn, *args, **kwargs).result()


def model(which):
    """The loaded model (loading it first); on the device thread only."""
    if _models[which] is None:
        _models[which] = load_depth() if which == "depth" else load_recon()
    _last_used[which] = time.time()
    return _models[which]


# ── Depth ────────────────────────────────────────────────────────────────────────────────────────────────────────

def validate_depth(b):
    if not isinstance(b, dict):
        raise BadInput("the body must be a JSON object")
    im, exif_f = decode_photo(b64(b.get("image_b64"), "image_b64"), "image_b64")
    f = b.get("focal_px")
    if f is not None and (isinstance(f, bool) or not isinstance(f, (int, float)) or not 10 <= f <= 100_000):
        raise BadInput("focal_px must be a number of pixels from 10 to 100000")
    if f is not None:
        return {"image": im, "focal_px": float(f), "focal_source": "given"}
    if exif_f:
        return {"image": im, "focal_px": exif_f, "focal_source": "exif"}
    return {"image": im, "focal_px": None, "focal_source": "model"}


def _depth_on_device(req):
    loaded = model("depth")
    depth, f = depth_infer(loaded, req["image"], req["focal_px"])
    _last_used["depth"] = time.time()
    return depth, f


def run_depth(req):
    """Wait for the device (a reconstruction may hold it), then measure."""
    import numpy as np
    if not _gpu.acquire(timeout=DEPTH_WAIT_S):
        raise Busy(f"the measure server was busy for {DEPTH_WAIT_S:g} s; try again")
    try:
        t = time.time()
        depth, f = on_device(_depth_on_device, req)
    finally:
        _gpu.release()
    h, w = depth.shape
    ok = np.isfinite(depth) & (depth > 0)
    return {"object": "depth", "model": DEPTH_MODEL, "width": w, "height": h, "focal_px": round(f, 2),
            "focal_source": req["focal_source"], "unit": "mm", "depth_png16_b64": base64.b64encode(png16(depth)).decode(),
            "min_m": round(float(depth[ok].min()), 3) if ok.any() else None, "max_m": round(float(depth[ok].max()), 3) if ok.any() else None,
            "seconds": round(time.time() - t, 2)}


# ── Reconstruction ───────────────────────────────────────────────────────────────────────────────────────────────

def matrix3(v, what):
    if not (isinstance(v, list) and len(v) == 3 and all(isinstance(r, list) and len(r) == 3 for r in v)
            and all(isinstance(x, (int, float)) and not isinstance(x, bool) and math.isfinite(x) for r in v for x in r)):
        raise BadInput(f"{what} must be a 3 × 3 matrix of numbers [[fx, 0, cx], [0, fy, cy], [0, 0, 1]]")
    if v[0][0] <= 0 or v[1][1] <= 0:
        raise BadInput(f"{what}: fx and fy must be above 0")
    return [[float(x) for x in r] for r in v]


def point(v, what, w, h):
    if not (isinstance(v, list) and len(v) == 2 and all(isinstance(x, (int, float)) and not isinstance(x, bool) for x in v)):
        raise BadInput(f"{what} must be [x, y] in the photo's pixels")
    if not (0 <= v[0] < w and 0 <= v[1] < h):
        raise BadInput(f"{what} is outside the photo ({w} × {h}, upright as taken)")
    return (float(v[0]), float(v[1]))


def validate_reconstruct(b):
    if not isinstance(b, dict):
        raise BadInput("the body must be a JSON object")
    imgs = b.get("images_b64")
    if not isinstance(imgs, list) or not MIN_PHOTOS <= len(imgs) <= MAX_PHOTOS:
        raise BadInput(f"images_b64 must be a list of {MIN_PHOTOS} to {MAX_PHOTOS} photos (base64)")
    photos = [decode_photo(b64(v, f"images_b64[{i}]"), f"images_b64[{i}]")[0] for i, v in enumerate(imgs)]
    mp = b.get("max_points", DEFAULT_POINTS)
    if isinstance(mp, bool) or not isinstance(mp, int) or not 1000 <= mp <= MAX_POINTS:
        raise BadInput(f"max_points must be a whole number from 1000 to {MAX_POINTS}")
    known = b.get("known")
    known = {} if known is None else known
    if not isinstance(known, dict):
        raise BadInput("known must be an object")
    unknown = set(known) - {"intrinsics", "one_measurement"}
    if unknown:
        raise BadInput(f"known may hold intrinsics and one_measurement, not {sorted(unknown)[0]}")
    ks = None
    if known.get("intrinsics") is not None:
        v = known["intrinsics"]
        if isinstance(v, list) and len(v) == 3 and all(isinstance(r, list) and len(r) == 3 and not any(isinstance(x, list) for x in r) for r in v):
            ks = [matrix3(v, "known.intrinsics")] * len(photos)  # one camera for every photo
        elif isinstance(v, list) and len(v) == len(photos):
            ks = [None if k is None else matrix3(k, f"known.intrinsics[{i}]") for i, k in enumerate(v)]
        else:
            raise BadInput("known.intrinsics must be one 3 × 3 matrix (every photo) or a list with one per photo (null where unknown)")
    meas = None
    if known.get("one_measurement") is not None:
        m = known["one_measurement"]
        if not isinstance(m, dict):
            raise BadInput("known.one_measurement must be {photo, p1: [x, y], p2: [x, y], metres}")
        i = m.get("photo")
        if isinstance(i, bool) or not isinstance(i, int) or not 0 <= i < len(photos):
            raise BadInput(f"known.one_measurement.photo must be the index of a photo, 0 to {len(photos) - 1}")
        w, h = photos[i].size
        p1, p2 = point(m.get("p1"), "known.one_measurement.p1", w, h), point(m.get("p2"), "known.one_measurement.p2", w, h)
        if math.dist(p1, p2) < 4:
            raise BadInput("known.one_measurement: p1 and p2 are less than 4 pixels apart")
        metres = m.get("metres")
        if isinstance(metres, bool) or not isinstance(metres, (int, float)) or not 0.01 <= metres <= 1000:
            raise BadInput("known.one_measurement.metres must be from 0.01 to 1000")
        meas = {"photo": i, "p1": p1, "p2": p2, "metres": float(metres)}
    if RECON == "vggt" and ks:
        ks = None  # VGGT takes no intrinsics; said in the result's warnings
    return {"photos": photos, "intrinsics": ks, "measurement": meas, "max_points": mp,
            "ignored_intrinsics": RECON == "vggt" and known.get("intrinsics") is not None}


def _xyz_at(view, x, y):
    """The world point under a photo pixel: bilinear between the four around it when all are valid, else the median of
    the valid ones in a 3 × 3 window; None if there are none."""
    import numpy as np
    cx, cy = to_crop(x, y, view["tf"])
    h, w = view["mask"].shape
    xi, yi = int(round(cx)), int(round(cy))
    if not (0 <= xi < w and 0 <= yi < h):
        return None
    x0, y0 = int(math.floor(cx)), int(math.floor(cy))
    if 0 <= x0 < w - 1 and 0 <= y0 < h - 1:
        quad, okq = view["pts3d"][y0:y0 + 2, x0:x0 + 2].astype(np.float64), view["mask"][y0:y0 + 2, x0:x0 + 2]
        if okq.all() and np.isfinite(quad).all():
            fx, fy = cx - x0, cy - y0
            return (quad[0, 0] * (1 - fx) * (1 - fy) + quad[0, 1] * fx * (1 - fy) + quad[1, 0] * (1 - fx) * fy + quad[1, 1] * fx * fy)
    sl = (slice(max(0, yi - 1), yi + 2), slice(max(0, xi - 1), xi + 2))
    pts, ok = view["pts3d"][sl].reshape(-1, 3), view["mask"][sl].reshape(-1)
    ok = ok & np.isfinite(pts).all(-1)
    return np.median(pts[ok], axis=0) if ok.any() else None


def ply_binary(xyz, rgb, conf, photo):
    """A binary little-endian PLY: x, y, z (float), red, green, blue (uchar), confidence (float), photo (uchar)."""
    import numpy as np
    n = len(xyz)
    head = ("ply\nformat binary_little_endian 1.0\ncomment mux measure: metres, photo 0's camera frame (OpenCV: x right, y down, z forward)\n"
            f"element vertex {n}\nproperty float x\nproperty float y\nproperty float z\nproperty uchar red\nproperty uchar green\n"
            "property uchar blue\nproperty float confidence\nproperty uchar photo\nend_header\n").encode()
    rec = np.zeros(n, dtype=[("x", "<f4"), ("y", "<f4"), ("z", "<f4"), ("r", "u1"), ("g", "u1"), ("b", "u1"), ("c", "<f4"), ("p", "u1")])
    rec["x"], rec["y"], rec["z"] = xyz[:, 0], xyz[:, 1], xyz[:, 2]
    rec["r"], rec["g"], rec["b"] = rgb[:, 0], rgb[:, 1], rgb[:, 2]
    rec["c"], rec["p"] = conf, photo
    return head + rec.tobytes()


def assemble(views, metric, req, depth_scale=None):
    """The model's views → the answer: cameras in the photos' own pixels, everything in photo 0's camera frame, scaled
    to metres by the best source there is, and the points as a PLY. Pure numpy: tested without a model."""
    import numpy as np
    warnings = []
    to0 = np.linalg.inv(np.asarray(views[0]["cam2world"], dtype=np.float64))  # world → photo 0's camera
    for v in views:
        v["c2w"] = to0 @ np.asarray(v["cam2world"], dtype=np.float64)
        p = v["pts3d"].reshape(-1, 3).astype(np.float64)
        v["pts"] = (p @ to0[:3, :3].T + to0[:3, 3]).reshape(v["pts3d"].shape)
    scale, source, measured = 1.0, ("model" if metric else "none"), None
    m = req.get("measurement")
    if m:
        va = dict(views[m["photo"]], pts3d=views[m["photo"]]["pts"])
        a, b = _xyz_at(va, *m["p1"]), _xyz_at(va, *m["p2"])
        if a is None or b is None:
            warnings.append("one_measurement: no point under p1 or p2 (outside the part of the photo the model sees, or masked); its scale was not used")
        else:
            d = float(np.linalg.norm(a - b))
            if d <= 1e-9:
                warnings.append("one_measurement: p1 and p2 fell on the same point; its scale was not used")
            else:
                scale, source = m["metres"] / d, "measurement"
                measured = {"photo": m["photo"], "metres": m["metres"], "model_metres": round(d, 4), "scale_factor": round(scale, 6)}
    if source == "none" and depth_scale:
        scale, source = depth_scale, "depth-pro"
    if source == "none":
        warnings.append("no metric scale: the model is not metric and no measurement was given; units are the model's own")
    if req.get("ignored_intrinsics"):
        warnings.append("known.intrinsics was ignored: VGGT takes none")
    cameras, xyz, rgb, conf, photo, per = [], [], [], [], [], []
    for i, (v, im) in enumerate(zip(views, req["photos"])):
        Rwc, c = v["c2w"][:3, :3], v["c2w"][:3, 3] * scale
        R = Rwc.T
        cameras.append({"photo": i, "width": im.width, "height": im.height, "K": np.round(k_to_photo(v["K"], v["tf"]), 4).tolist(),
                        "R": np.round(R, 8).tolist(), "t": np.round(-R @ c, 6).tolist(), "position": np.round(c, 6).tolist()})
        ok = v["mask"] & np.isfinite(v["pts"]).all(-1) & np.isfinite(v["conf"])
        per.append({"photo": i, "mean": round(float(v["conf"][ok].mean()), 4) if ok.any() else None, "valid_fraction": round(float(ok.mean()), 4)})
        xyz.append(v["pts"][ok] * scale)
        rgb.append(np.asarray(v["rgb"])[ok])
        conf.append(v["conf"][ok])
        photo.append(np.full(int(ok.sum()), i, dtype=np.uint8))
    xyz, rgb, conf, photo = (np.concatenate(a) for a in (xyz, rgb, conf, photo))
    total = len(xyz)
    if total > req["max_points"]:
        keep = np.sort(np.random.default_rng(0).choice(total, req["max_points"], replace=False))
        xyz, rgb, conf, photo = xyz[keep], rgb[keep], conf[keep], photo[keep]
    return {"cameras": cameras,
            "points": {"format": "ply", "encoding": "binary_little_endian", "count": int(len(xyz)), "of": int(total),
                       "b64": base64.b64encode(ply_binary(xyz.astype(np.float32), rgb.astype(np.uint8), conf.astype(np.float32), photo)).decode()},
            "scale_source": source, "scale_factor": round(scale, 6), "measurement": measured,
            "confidence": {"mean": round(float(conf.mean()), 4) if len(conf) else None, "per_photo": per,
                           "note": "the model's own confidence (1 = least sure, larger is surer); compare photos, not models"},
            "frame": "photo 0's camera: x right, y down, z forward (OpenCV), metres when scale_source is not none; R, t map a world point to a camera (x_cam = R·X + t); position is the camera's centre",
            "warnings": warnings}


class Job:
    def __init__(self, req):
        self.id = "recon_" + secrets.token_hex(12)
        self.req = req  # validated request: the photos … (dropped once the job ends)
        self.photos = len(req["photos"])
        self.status = "queued"
        self.progress = 0.0
        self.error = None
        self.result = None
        self.created = time.time()
        self.finished = None
        self.cancel = threading.Event()

    def view(self):
        out = {"id": self.id, "object": "reconstruction", "status": self.status, "progress": round(self.progress, 3),
               "model": RECON_MODEL, "photos": self.photos, "created_at": int(self.created)}
        if self.error:
            out["error"] = self.error
        if self.status == "succeeded" and self.result is not None:
            out["result"] = self.result
        return out

    def end(self, status, error=None):
        self.status = status
        self.error = error
        self.finished = time.time()
        self.req = None


def _recon_on_device(job):
    req = job.req

    def step(p):
        if job.cancel.is_set():
            raise Cancelled()
        job.progress = max(job.progress, p)

    m = model("recon")
    step(0.1)
    views, metric = recon_infer(m, req["photos"], req["intrinsics"], step)
    _last_used["recon"] = time.time()
    depth_scale = None
    if not metric and not req.get("measurement"):
        depth_scale = vggt_scale_from_depth(views, req)
    step(0.9)
    return assemble(views, metric, req, depth_scale)


def vggt_scale_from_depth(views, req):
    """A non-metric model's scale from Depth Pro on photo 0's crop: the median ratio of the two depths."""
    import numpy as np
    from PIL import Image
    v = views[0]
    if "depth" not in v:
        return None
    dp, _ = depth_infer(model("depth"), Image.fromarray(np.asarray(v["rgb"])), None)
    ok = v["mask"] & np.isfinite(v["depth"]) & (v["depth"] > 0) & np.isfinite(dp) & (dp > 0)
    return float(np.median(dp[ok] / v["depth"][ok])) if ok.sum() > 100 else None


def run(job):
    with _gpu:
        if job.status != "queued":  # cancelled while it waited
            return
        job.status = "running"
        try:
            result = on_device(_recon_on_device, job)
            if job.cancel.is_set():
                raise Cancelled()
            job.result = result
            job.progress = 1.0
            job.end("succeeded")
        except Cancelled:
            job.end("cancelled")
        except Exception as e:  # noqa: BLE001 – the caller gets the reason; never the photos
            msg = str(e)[:300] or type(e).__name__
            kind = "out_of_memory" if isinstance(e, MemoryError) or "out of memory" in msg.lower() else "server_error"
            print(f"job {job.id} failed: {type(e).__name__}", file=sys.stderr, flush=True)
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
        if sum(1 for j in _jobs.values() if j.status in ("queued", "running")) >= MAX_QUEUE:
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
            # The device stops at its next stage; the job says so now, and its result never comes.
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
        for which in ("depth", "recon"):
            if _models[which] is not None and time.time() - _last_used[which] > IDLE_MIN * 60 and _gpu.acquire(blocking=False):
                try:
                    if _models[which] is not None and time.time() - _last_used[which] > IDLE_MIN * 60:
                        on_device(let_go_model, which)
                finally:
                    _gpu.release()


# ── HTTP ─────────────────────────────────────────────────────────────────────────────────────────────────────────

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
            return self._send(200, {"object": "list", "data": [{"id": DEPTH_MODEL, "object": "model", "route": "depth", "loaded": _models["depth"] is not None},
                                                               {"id": RECON_MODEL, "object": "model", "route": "reconstruct", "loaded": _models["recon"] is not None}]})
        parts = path.split("/")  # ["", "v1", "reconstruct", id]
        if len(parts) == 4 and parts[1:3] == ["v1", "reconstruct"]:
            job = get(parts[3])
            if not job:
                return self._error(404, "no such reconstruction (or it expired: they are kept 1 hour)", "not_found")
            return self._send(200, job.view())
        self._error(404, "not found", "not_found")

    def do_POST(self):
        path = self._path()
        try:
            length = int(self.headers.get("content-length") or 0)
        except ValueError:
            return self._error(400, "bad content-length")
        limit = MAX_BODY.get(path, 1024 * 1024)
        if length > limit:
            self.close_connection = True
            return self._error(413, f"the body is over {limit // 1024 // 1024} MB", "request_too_large")
        raw = self.rfile.read(length) if length else b""
        parts = path.split("/")
        if path in ("/v1/depth", "/v1/reconstruct"):
            try:
                b = json.loads(raw or b"{}")
            except ValueError:
                return self._error(400, "the body is not JSON")
            try:
                req = validate_depth(b) if path == "/v1/depth" else validate_reconstruct(b)
            except BadInput as e:
                return self._error(400, str(e))
            except Exception as e:  # noqa: BLE001
                return self._error(400, f"the input could not be read: {str(e)[:200]}")
            if path == "/v1/depth":
                try:
                    return self._send(200, run_depth(req))
                except Busy as e:
                    return self._error(503, str(e), "busy")
                except Exception as e:  # noqa: BLE001 – the reason, never the photo
                    msg = str(e)[:300] or type(e).__name__
                    print(f"depth failed: {type(e).__name__}", file=sys.stderr, flush=True)
                    oom = isinstance(e, MemoryError) or "out of memory" in msg.lower()
                    return self._error(503 if oom else 500, msg, "out_of_memory" if oom else "server_error")
            job = submit(req)
            if job is None:
                return self._error(429, f"{MAX_QUEUE} reconstructions are already waiting or running; try again later", "queue_full")
            return self._send(202, {"id": job.id, "object": "reconstruction", "status": job.status, "model": RECON_MODEL})
        if len(parts) == 5 and parts[1:3] == ["v1", "reconstruct"] and parts[4] == "cancel":
            job = get(parts[3])
            if not job:
                return self._error(404, "no such reconstruction (or it expired)", "not_found")
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


if __name__ == "__main__":
    if "--warm" in sys.argv:  # deploy/measure.sh: load both once (fetching DINOv2's code for MapAnything), then exit
        on_device(model, "depth")
        on_device(model, "recon")
        sys.exit(0)
    print(f"measure on 127.0.0.1:{PORT}: {DEPTH_MODEL} and {RECON_MODEL} ({DEVICE}), idle {IDLE_MIN:g} min, kept {KEEP_S / 60:g} min", file=sys.stderr, flush=True)
    start().serve_forever()
