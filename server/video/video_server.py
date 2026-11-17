"""Video for mux: an async job API (POST /v1/videos/generations, then poll) in front of Wan 2.1 VACE 1.3B.

Why this model, what it costs and what else was considered: docs/video.md. In short: Wan2.1-VACE-1.3B (Alibaba Wan
team, Apache-2.0) through diffusers' WanVACEPipeline on PyTorch's MPS backend: text to video, and video from a depth
pass (Thread's Sets: a grey 3D take's exact depth becomes real footage), with an optional first frame.

Runs in ~/.mux/video-venv (deploy/video.sh). Weights at a pinned revision in MUX_VIDEO_MODEL_PATH
(~/.mux/models/wan2.1-vace-1.3b-diffusers). Started by deploy/video.sh as launchd agent com.mux.video on
127.0.0.1:8313.

- One job at a time: the GPU does one well, not two at half speed. Jobs wait in a queue (at most MUX_VIDEO_QUEUE).
- The model loads on the first job and is let go after MUX_VIDEO_IDLE_MIN idle minutes, so its memory goes back to
  the chat models.
- Every PyTorch call (load, generate, let go) runs on one worker thread, `on_device`, like the image server's MLX
  thread: ThreadingHTTPServer answers each request on a new thread, and device state is kept per thread.
- Nothing about a prompt or media is logged. Media is held in memory; ffmpeg's temporary files are deleted at once.
- A finished video is kept KEEP_S (1 hour), then the job is gone (404).

Contract (Thread is built against it):
  POST /v1/videos/generations {model: "video-depth" | "video", prompt, negative_prompt?, seed?, seconds (1–10),
       fps (8–24), size ("832x480" draft | "1280x720" finish), control?: {type: "depth", video_b64, format: "mp4" |
       "png16-zip"}, image_b64?}                       → 202 {id, status: "queued", model}
  GET  /v1/videos/{id}                                 → {id, status, progress, model, error?, seconds, size}
  GET  /v1/videos/{id}/content                         → video/mp4
  POST /v1/videos/{id}/cancel                          → {id, status}
"""
import base64, binascii, concurrent.futures, gc, io, json, os, queue, secrets, shutil, subprocess, sys, tempfile, threading, time, zipfile
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PORT = int(os.environ.get("MUX_VIDEO_PORT", "8313"))
MODEL = os.environ.get("MUX_VIDEO_MODEL", "wan2.1-vace-1.3b")
MODEL_PATH = os.path.expanduser(os.environ.get("MUX_VIDEO_MODEL_PATH", "~/.mux/models/wan2.1-vace-1.3b-diffusers"))
DEVICE = os.environ.get("MUX_VIDEO_DEVICE", "mps")
IDLE_MIN = float(os.environ.get("MUX_VIDEO_IDLE_MIN", "10"))
KEEP_S = float(os.environ.get("MUX_VIDEO_KEEP_S", "3600"))
MAX_QUEUE = int(os.environ.get("MUX_VIDEO_QUEUE", "6"))
MAX_BODY = 200 * 1024 * 1024
SIZES = {"832x480": (832, 480), "1280x720": (1280, 720)}
# Steps per size: the draft is for looking, the finish for keeping. Guidance as Wan's own examples.
STEPS = {"832x480": int(os.environ.get("MUX_VIDEO_STEPS_DRAFT", "20")), "1280x720": int(os.environ.get("MUX_VIDEO_STEPS_FINISH", "30"))}
# UniPC's flow shift as Wan recommends: 3.0 at 480p, 5.0 at 720p
FLOW_SHIFT = {"832x480": 3.0, "1280x720": 5.0}
GUIDANCE = float(os.environ.get("MUX_VIDEO_GUIDANCE", "5.0"))
NAMES = {"video", "video-depth", MODEL}
NEGATIVE = "blurry, low quality, distorted, deformed, flickering, watermark, text, static frame, oversaturated"


class BadInput(ValueError):
    pass


class Cancelled(Exception):
    pass


class Job:
    def __init__(self, req):
        self.id = "video_" + secrets.token_hex(12)
        self.req = req  # validated request: prompt, frames, image … (dropped once the job ends)
        self.status = "queued"
        self.progress = 0.0
        self.error = None
        self.content = None
        self.created = time.time()
        self.finished = None
        self.cancel = threading.Event()
        self.req_seconds, self.req_size, self.req_fps = req["seconds"], req["size"], req["fps"]

    def view(self):
        out = {"id": self.id, "object": "video", "status": self.status, "progress": round(self.progress, 3), "model": MODEL,
               "seconds": self.req_seconds, "size": self.req_size, "fps": self.req_fps, "created_at": int(self.created)}
        if self.error:
            out["error"] = self.error
        return out

    def end(self, status, error=None):
        self.status = status
        self.error = error
        self.finished = time.time()
        self.req = None


_jobs = {}
_jobs_lock = threading.Lock()
_queue = queue.Queue()
_pipe = None
_last_used = 0.0
_gpu = threading.Lock()  # one job at a time; also guards loading and letting go
# PyTorch's device state (MPS streams, the allocator) is used from one thread only, as the image server does for MLX.
_device = concurrent.futures.ThreadPoolExecutor(max_workers=1, thread_name_prefix="mps")


def on_device(fn, *args, **kwargs):
    """Run fn on the device thread and wait for it; exceptions come back to the caller."""
    return _device.submit(fn, *args, **kwargs).result()


# ── The model ────────────────────────────────────────────────────────────────────────────────────────────────────

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


def load_pipeline():
    # mux's memory budget does not count this server, so it checks for itself: a load that cannot fit would push the
    # chat models into swap. MUX_VIDEO_MIN_FREE_GB 0 turns the check off.
    need = float(os.environ.get("MUX_VIDEO_MIN_FREE_GB", "24"))
    have = available_gb()
    if need and have is not None and have < need:
        raise MemoryError(f"only {have:.0f} GB free on this Mac; the video model wants {need:g} GB: try again when the chat models have been let go")
    import torch
    from diffusers import AutoencoderKLWan, WanVACEPipeline
    if DEVICE == "mps" and not torch.backends.mps.is_available():
        raise RuntimeError("PyTorch has no MPS device here (Apple Silicon with macOS 14 or later is needed)")
    t = time.time()
    vae = AutoencoderKLWan.from_pretrained(MODEL_PATH, subfolder="vae", torch_dtype=torch.float32)
    pipe = WanVACEPipeline.from_pretrained(MODEL_PATH, vae=vae, torch_dtype=torch.bfloat16)
    pipe.to(DEVICE)
    pipe.set_progress_bar_config(disable=True)
    print(f"loaded {MODEL} in {time.time() - t:.0f} s", file=sys.stderr, flush=True)
    return pipe


def pipeline():
    global _pipe
    if _pipe is None:
        _pipe = load_pipeline()
    return _pipe


def let_go():
    global _pipe
    _pipe = None
    gc.collect()
    try:
        import torch
        if DEVICE == "mps":
            torch.mps.empty_cache()
    except Exception:  # noqa: BLE001 – the memory still goes when Python frees it
        pass
    print(f"let go of {MODEL} after {IDLE_MIN:g} idle minutes", file=sys.stderr, flush=True)


def frames_for(n):
    """Wan makes 4k+1 frames: the fewest that cover n."""
    return n if (n - 1) % 4 == 0 else n + (4 - (n - 1) % 4)


def render(pipe, req, on_step):
    """Run the pipeline; return frames as uint8 numpy (n, h, w, 3). on_step(i, steps) may raise Cancelled."""
    import numpy as np
    import torch
    from PIL import Image
    from diffusers.schedulers.scheduling_unipc_multistep import UniPCMultistepScheduler
    w, h = SIZES[req["size"]]
    n = req["frames"]
    n4 = frames_for(n)
    steps = req["steps"]
    pipe.scheduler = UniPCMultistepScheduler.from_config(pipe.scheduler.config, flow_shift=FLOW_SHIFT[req["size"]])
    video, mask = None, None
    control = req.get("control")  # uint8 (n, h, w): depth, near is bright
    if control is not None:
        control = np.concatenate([control, np.repeat(control[-1:], n4 - len(control), axis=0)]) if len(control) < n4 else control[:n4]
        video = [Image.fromarray(f).convert("RGB") for f in control]
    first = req.get("image")  # PIL RGB at w×h
    if first is not None:
        # VACE's composition: frame 0 is kept as given (mask black), the rest is made (mask white), from the depth
        # where there is one, from grey (nothing) where there is not.
        rest = video[1:] if video else [Image.new("RGB", (w, h), (128, 128, 128))] * (n4 - 1)
        video = [first, *rest]
        mask = [Image.new("L", (w, h), 0)] + [Image.new("L", (w, h), 255)] * (n4 - 1)

    def cb(_pipe, i, _t, kwargs):
        on_step(i + 1, steps)
        return kwargs

    out = pipe(prompt=req["prompt"], negative_prompt=req["negative_prompt"], video=video, mask=mask, height=h, width=w,
               num_frames=n4, num_inference_steps=steps, guidance_scale=GUIDANCE,
               generator=torch.Generator(device="cpu").manual_seed(req["seed"]), output_type="np",
               callback_on_step_end=cb).frames[0]
    return (np.clip(out[:n], 0, 1) * 255).round().astype("uint8")


# ── Media ────────────────────────────────────────────────────────────────────────────────────────────────────────

def ffmpeg():
    try:
        import imageio_ffmpeg
        return imageio_ffmpeg.get_ffmpeg_exe()
    except Exception:  # noqa: BLE001
        exe = shutil.which("ffmpeg")
        if not exe:
            raise RuntimeError("ffmpeg is missing (deploy/video.sh installs imageio-ffmpeg)")
        return exe


def encode_mp4(frames, fps):
    """uint8 (n, h, w, 3) → H.264 mp4 bytes. The temporary file is deleted before this returns."""
    n, h, w, _ = frames.shape
    fd, path = tempfile.mkstemp(suffix=".mp4")
    os.close(fd)
    try:
        cmd = [ffmpeg(), "-v", "error", "-y", "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", f"{w}x{h}", "-r", str(fps), "-i", "-",
               "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "17", "-preset", "medium", "-movflags", "+faststart", path]
        p = subprocess.run(cmd, input=frames.tobytes(), capture_output=True, timeout=600)
        if p.returncode:
            raise RuntimeError("ffmpeg could not write the video: " + p.stderr.decode("utf-8", "replace")[-300:])
        with open(path, "rb") as f:
            return f.read()
    finally:
        os.unlink(path)


def pick(n_have, n_want):
    """n_want indices spread over n_have frames, first and last included."""
    if n_have == 1 or n_want == 1:
        return [0] * n_want
    return [round(i * (n_have - 1) / (n_want - 1)) for i in range(n_want)]


def depth_from_png16_zip(data, w, h, n):
    """A zip of 16-bit PNG depth frames (in name order; larger = farther, 0 = no depth) → uint8 (n, h, w), near bright.

    VACE learned depth as the depth estimators draw it (relative inverse depth: near is bright), so exact depth is
    turned into disparity (1/d) and stretched over the whole clip at once — per frame would make it flicker.
    """
    import numpy as np
    from PIL import Image
    try:
        z = zipfile.ZipFile(io.BytesIO(data))
    except zipfile.BadZipFile:
        raise BadInput("control.video_b64 is not a zip (format png16-zip)")
    names = sorted(i.filename for i in z.infolist() if not i.is_dir() and i.filename.lower().endswith(".png") and not i.filename.startswith("__MACOSX"))
    if not names:
        raise BadInput("the control zip holds no PNG frames")
    if len(names) > 2000:
        raise BadInput("the control zip holds more than 2000 frames")
    picked = [names[i] for i in pick(len(names), n)]
    raw = {}
    for name in dict.fromkeys(picked):
        try:
            with Image.open(io.BytesIO(z.read(name))) as im:
                if im.mode not in ("I;16", "I;16B", "I;16L", "I"):
                    raise BadInput(f"{name} is not a 16-bit PNG (mode {im.mode})")
                if im.size != (w, h):
                    im = im.convert("I").resize((w, h), Image.NEAREST)  # depth is not blended across edges
                raw[name] = np.asarray(im, dtype=np.float64)
        except BadInput:
            raise
        except Exception as e:  # noqa: BLE001
            raise BadInput(f"{name} could not be read as a PNG: {e}")
    stack = np.stack([raw[nm] for nm in picked])
    valid = stack > 0
    if not valid.any():
        raise BadInput("the depth frames are all zero")
    disp = np.zeros_like(stack)
    disp[valid] = 1.0 / stack[valid]
    lo, hi = np.percentile(disp[valid], [1, 99])
    if hi <= lo:
        hi = lo + 1e-9
    out = np.clip((disp - lo) / (hi - lo), 0, 1) * 255
    out[~valid] = 0  # no depth (the sky, the void): far
    return out.round().astype("uint8")


def depth_from_mp4(data, w, h, n):
    """An mp4 depth pass (already drawn as depth maps are: near bright) → uint8 (n, h, w)."""
    import numpy as np
    fd, path = tempfile.mkstemp(suffix=".mp4")
    try:
        with os.fdopen(fd, "wb") as f:
            f.write(data)
        cmd = [ffmpeg(), "-v", "error", "-i", path, "-vf", f"scale={w}:{h}:flags=bicubic,format=gray", "-f", "rawvideo", "-pix_fmt", "gray", "-"]
        p = subprocess.run(cmd, capture_output=True, timeout=300)
    finally:
        os.unlink(path)
    if p.returncode or not p.stdout:
        raise BadInput("control.video_b64 could not be read as an mp4")
    frames = np.frombuffer(p.stdout, dtype=np.uint8)
    if frames.size % (w * h):
        raise BadInput("control.video_b64 decoded to a partial frame")
    frames = frames.reshape(-1, h, w)
    return frames[pick(len(frames), n)].copy()


def first_frame(data, w, h):
    """An image → PIL RGB w×h, cropped to fill (centred)."""
    from PIL import Image
    try:
        im = Image.open(io.BytesIO(data))
        im.load()
    except Exception:  # noqa: BLE001
        raise BadInput("image_b64 is not an image")
    im = im.convert("RGB")
    scale = max(w / im.width, h / im.height)
    im = im.resize((max(w, round(im.width * scale)), max(h, round(im.height * scale))), Image.LANCZOS)
    left, top = (im.width - w) // 2, (im.height - h) // 2
    return im.crop((left, top, left + w, top + h))


def b64(value, what):
    if not isinstance(value, str) or not value.strip():
        raise BadInput(f"{what} is required")
    if value.startswith("data:"):
        value = value.split(",", 1)[-1]
    try:
        return base64.b64decode(value, validate=False)
    except (binascii.Error, ValueError):
        raise BadInput(f"{what} is not base64")


def number(b, key, lo, hi, integer=False):
    v = b.get(key)
    if isinstance(v, bool) or not isinstance(v, (int, float)) or (integer and int(v) != v):
        raise BadInput(f"{key} must be {'a whole number' if integer else 'a number'} from {lo} to {hi}")
    if not lo <= v <= hi:
        raise BadInput(f"{key} must be from {lo} to {hi} (got {v})")
    return int(v) if integer else float(v)


def validate(b):
    """The request body → what a job needs. BadInput (400) names what is wrong."""
    if not isinstance(b, dict):
        raise BadInput("the body must be a JSON object")
    name = b.get("model", "video")
    if name not in NAMES:
        raise BadInput(f"model must be video or video-depth (got {str(name)[:40]})")
    prompt = b.get("prompt")
    if not isinstance(prompt, str) or not prompt.strip():
        raise BadInput("prompt is required")
    if len(prompt) > 4000:
        raise BadInput("prompt is longer than 4000 characters")
    neg = b.get("negative_prompt")
    if neg is not None and not isinstance(neg, str):
        raise BadInput("negative_prompt must be text")
    seconds = number(b, "seconds", 1, 10)
    fps = number(b, "fps", 8, 24, integer=True)
    size = b.get("size")
    if size not in SIZES:
        raise BadInput('size must be "832x480" (draft) or "1280x720" (finish)')
    seed = b.get("seed")
    if seed is None:
        seed = secrets.randbelow(2**31)
    elif isinstance(seed, bool) or not isinstance(seed, int) or not 0 <= seed < 2**63:
        raise BadInput("seed must be a whole number from 0")
    control = b.get("control")
    if name == "video-depth" and control is None:
        raise BadInput("video-depth needs control: {type: \"depth\", video_b64, format}")
    w, h = SIZES[size]
    frames = max(1, round(seconds * fps))
    req = {"prompt": prompt.strip(), "negative_prompt": (neg or "").strip() or NEGATIVE, "seconds": seconds, "fps": fps,
           "size": size, "seed": seed, "frames": frames, "steps": STEPS[size], "control": None, "image": None}
    if control is not None:
        if not isinstance(control, dict):
            raise BadInput("control must be an object")
        if control.get("type") != "depth":
            raise BadInput('control.type must be "depth"')
        fmt = control.get("format")
        if fmt not in ("mp4", "png16-zip"):
            raise BadInput('control.format must be "mp4" or "png16-zip"')
        data = b64(control.get("video_b64"), "control.video_b64")
        req["control"] = depth_from_mp4(data, w, h, frames) if fmt == "mp4" else depth_from_png16_zip(data, w, h, frames)
    if b.get("image_b64") is not None:
        req["image"] = first_frame(b64(b.get("image_b64"), "image_b64"), w, h)
    return req


# ── Jobs ─────────────────────────────────────────────────────────────────────────────────────────────────────────

def _run_on_device(job):
    global _last_used
    req = job.req

    def on_step(i, steps):
        if job.cancel.is_set():
            raise Cancelled()
        job.progress = 0.05 + 0.9 * i / steps

    pipe = pipeline()
    job.progress = 0.05
    frames = render(pipe, req, on_step)
    if job.cancel.is_set():
        raise Cancelled()
    job.progress = 0.97
    data = encode_mp4(frames, req["fps"])
    _last_used = time.time()
    return data


def run(job):
    with _gpu:
        if job.status != "queued":  # cancelled while it waited
            return
        job.status = "running"
        try:
            data = on_device(_run_on_device, job)
            if job.cancel.is_set():
                raise Cancelled()
            job.content = data
            job.progress = 1.0
            job.end("succeeded")
        except Cancelled:
            job.end("cancelled")
        except Exception as e:  # noqa: BLE001 – the caller gets the reason; never the prompt or the media
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
            # The device stops at its next step; the job says so now, and its content never comes.
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


def loaded():
    return _pipe is not None


def idle_watch():
    while True:
        time.sleep(30)
        reap()
        if _pipe is not None and time.time() - _last_used > IDLE_MIN * 60 and _gpu.acquire(blocking=False):
            try:
                if _pipe is not None and time.time() - _last_used > IDLE_MIN * 60:
                    on_device(let_go)
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
            return self._send(200, {"object": "list", "data": [{"id": MODEL, "object": "model", "loaded": loaded()}]})
        parts = path.split("/")  # ["", "v1", "videos", id, ("content")]
        if len(parts) in (4, 5) and parts[1:3] == ["v1", "videos"]:
            job = get(parts[3])
            if not job:
                return self._error(404, "no such video (or it expired: videos are kept 1 hour)", "not_found")
            if len(parts) == 4:
                return self._send(200, job.view())
            if parts[4] == "content":
                if job.status != "succeeded" or job.content is None:
                    return self._error(409, f"the video is {job.status}, not ready", "not_ready")
                self.send_response(200)
                self.send_header("content-type", "video/mp4")
                self.send_header("content-length", str(len(job.content)))
                self.end_headers()
                self.wfile.write(job.content)
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
        if path == "/v1/videos/generations":
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
            job = submit(req)
            if job is None:
                return self._error(429, f"{MAX_QUEUE} videos are already waiting or running; try again later", "queue_full")
            return self._send(202, {"id": job.id, "object": "video", "status": job.status, "model": MODEL})
        if len(parts) == 5 and parts[1:3] == ["v1", "videos"] and parts[4] == "cancel":
            job = get(parts[3])
            if not job:
                return self._error(404, "no such video (or it expired)", "not_found")
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
    if "--warm" in sys.argv:  # deploy/video.sh: load once to check the weights, then exit
        on_device(pipeline)
        sys.exit(0)
    print(f"video on 127.0.0.1:{PORT}: {MODEL} ({DEVICE}), steps {STEPS}, idle {IDLE_MIN:g} min, kept {KEEP_S / 60:g} min", file=sys.stderr, flush=True)
    start().serve_forever()
