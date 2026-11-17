"""Camera-driven video for mux (route `video-camera`): a first frame and a camera path in, a long take out.

LingBot-World v2 1.3B causal-fast (Robbyant, CC BY-NC-SA 4.0; port in lingbot_mps.py) on PyTorch MPS, behind the
same async job API as server/video/video_server.py. Why this model, the pose mapping, licences and what is proven:
docs/video-camera.md. Runs in ~/.mux/video-camera-venv (deploy/video-camera.sh) as launchd agent com.mux.video-camera
on 127.0.0.1:8315.

Its own process, not a model inside the video server: LingBot's code is imported from a pinned checkout under a
non-commercial share-alike licence and patched at run time (kept out of the Apache-licensed Wan server), the port is
new and may crash where the Wan server is proven, and either can be redeployed without stopping the other. They share
one Mac-wide lock (video_server.gpu_lock), so only one video job runs on the GPU at a time across both.

- One job at a time; at most MUX_CAMERA_QUEUE waiting or running (429 beyond).
- The model loads on the first job (only with MUX_CAMERA_MIN_FREE_GB free) and is let go after MUX_CAMERA_IDLE_MIN
  idle minutes; the text encoder is let go as soon as the prompt is encoded.
- Every PyTorch call runs on one device thread. The take is made chunk by chunk (one second of video each) and written
  to ffmpeg as it comes, so memory does not grow with its length; a cancel stops it at the next step.
- Nothing about a prompt or an image is logged: only load and let-go, a finished take's timings, a failed job's error
  class. Media is held in memory; ffmpeg's temporary file is deleted at once. A video is kept KEEP_S (1 hour).

Contract (Thread builds against it; docs/video-camera.md):
  POST /v1/videos/generations {model: "video-camera", prompt, negative_prompt?, seed?, fps (8–24), size ("832x480" |
       "1280x720"), seconds (1–60), image_b64, camera: {convention: "sets", sensorMm: [w, h], aspect, principal?,
       frames: [{t, pos, quat, focalMm}]}, anchors?: [{t, image_b64}]}   → 202 {id, status: "queued", model}
  GET  /v1/videos/{id}            → {id, status, progress, model, seconds, size, fps, error?, notes?, stats?}
  GET  /v1/videos/{id}/content    → video/mp4 (H.264, yuv420p)
  POST /v1/videos/{id}/cancel     → {id, status}
"""
import concurrent.futures, gc, importlib.util, io, json, math, os, queue, secrets, subprocess, sys, tempfile, threading, time, warnings
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

here = os.path.dirname(os.path.abspath(__file__))


def _load(name, file):
    spec = importlib.util.spec_from_file_location(name, os.path.join(here, file))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


vs = _load("video_server", "video_server.py")      # shared helpers: first frame, base64, numbers, memory, ffmpeg, the GPU lock
poses = _load("camera_poses", "camera_poses.py")

PORT = int(os.environ.get("MUX_CAMERA_PORT", "8315"))
MODEL = os.environ.get("MUX_CAMERA_MODEL", "lingbot-world-v2-1.3b")
HOME = os.path.expanduser("~/.mux")
CODE_DIR = os.path.expanduser(os.environ.get("MUX_CAMERA_CODE", f"{HOME}/lingbot-world-v2"))
DIT_DIR = os.path.expanduser(os.environ.get("MUX_CAMERA_DIT", f"{HOME}/models/lingbot-world-v2-1.3b-causal-fast"))
VAE_PTH = os.path.expanduser(os.environ.get("MUX_CAMERA_VAE", f"{HOME}/models/wan2.1-assets/Wan2.1_VAE.pth"))
T5_DIR = os.path.expanduser(os.environ.get("MUX_CAMERA_T5_DIR", f"{HOME}/models/wan2.1-vace-1.3b-diffusers"))
T5_PTH = os.path.expanduser(os.environ.get("MUX_CAMERA_T5_PTH", "")) or None
DEVICE = os.environ.get("MUX_CAMERA_DEVICE", "mps")
IDLE_MIN = float(os.environ.get("MUX_CAMERA_IDLE_MIN", "10"))
KEEP_S = float(os.environ.get("MUX_CAMERA_KEEP_S", "3600"))
MAX_QUEUE = int(os.environ.get("MUX_CAMERA_QUEUE", "6"))
MIN_STEP_M = float(os.environ.get("MUX_CAMERA_MIN_STEP_M", str(poses.MIN_STEP_M)))
MAX_SECONDS = 60
MAX_ANCHORS = 60
MAX_BODY = 200 * 1024 * 1024
SIZES = {"832x480": (832, 480), "1280x720": (1280, 720)}
NAMES = {"video-camera", MODEL}

# upstream's model has `with torch.amp.autocast('cuda', …)` inside; on a Mac each says CUDA is missing, every step
warnings.filterwarnings("ignore", message=".*CUDA is not available.*")
warnings.filterwarnings("ignore", message=".*torch.cuda.amp.autocast.*")

BadInput, Cancelled = vs.BadInput, vs.Cancelled


class Job:
    def __init__(self, req):
        self.id = "video_" + secrets.token_hex(12)
        self.req = req   # validated request (prompt, pictures, the planned take); dropped once the job ends
        self.status = "queued"
        self.progress = 0.0
        self.error = None
        self.content = None
        self.created = time.time()
        self.finished = None
        self.cancel = threading.Event()
        self.seconds, self.size, self.fps = req["seconds"], req["size"], req["fps"]
        self.notes = list(req["notes"])
        self.stats = None

    def view(self):
        out = {"id": self.id, "object": "video", "status": self.status, "progress": round(self.progress, 3), "model": MODEL,
               "seconds": self.seconds, "size": self.size, "fps": self.fps, "created_at": int(self.created)}
        if self.error:
            out["error"] = self.error
        if self.notes:
            out["notes"] = self.notes
        if self.stats:
            out["stats"] = self.stats
        return out

    def end(self, status, error=None):
        self.status = status
        self.error = error
        self.finished = time.time()
        self.req = None


_jobs = {}
_jobs_lock = threading.Lock()
_queue = queue.Queue()
_model = None
_last_used = 0.0
_gpu = threading.Lock()
_device = concurrent.futures.ThreadPoolExecutor(max_workers=1, thread_name_prefix="mps")


def on_device(fn, *args, **kwargs):
    return _device.submit(fn, *args, **kwargs).result()


# ── the model ────────────────────────────────────────────────────────────────────────────────────────────────────

def load_model():
    need = float(os.environ.get("MUX_CAMERA_MIN_FREE_GB", "24"))
    have = vs.available_gb()
    if need and have is not None and have < need:
        raise MemoryError(f"only {have:.0f} GB free on this Mac; the camera model wants {need:g} GB: try again when the chat models have been let go")
    import torch
    if DEVICE == "mps" and not torch.backends.mps.is_available():
        raise RuntimeError("PyTorch has no MPS device here (Apple Silicon with macOS 14 or later is needed)")
    lb = _load("lingbot_mps", "lingbot_mps.py")
    t5_dir = None if T5_PTH else T5_DIR
    m = lb.LingBotCamera(CODE_DIR, DIT_DIR, VAE_PTH, t5_diffusers_dir=t5_dir, t5_pth=T5_PTH, device=DEVICE)
    m.memory_gb = lb.memory_gb
    m.empty = lambda: lb.empty_cache(DEVICE)
    print(f"loaded {MODEL} in {m.load_s:.0f} s ({'bf16' if m.dtype == torch.bfloat16 else 'fp32'} DiT, {DEVICE})", file=sys.stderr, flush=True)
    return m


def model():
    global _model
    if _model is None:
        _model = load_model()
    return _model


def let_go():
    global _model
    empty = getattr(_model, "empty", None)
    _model = None
    gc.collect()
    if empty:
        empty()
    print(f"let go of {MODEL} after {IDLE_MIN:g} idle minutes", file=sys.stderr, flush=True)


# ── the request ──────────────────────────────────────────────────────────────────────────────────────────────────

def picture(value, what, w, h, notes):
    from PIL import Image
    data = vs.b64(value, what)
    try:
        with Image.open(io.BytesIO(data)) as im:
            size = im.size
    except Exception:  # noqa: BLE001
        raise BadInput(f"{what} is not an image")
    if size != (w, h):
        notes.append(f"{what} was {size[0]}x{size[1]}, not {w}x{h}: cropped to fill (the camera path is for the size asked)")
    try:
        return vs.first_frame(data, w, h)
    except BadInput:
        raise BadInput(f"{what} is not an image")


def validate(b):
    """The body → what a job needs, including the planned take. BadInput (400) names the field."""
    if not isinstance(b, dict):
        raise BadInput("the body must be a JSON object")
    name = b.get("model", "video-camera")
    if name not in NAMES:
        raise BadInput(f"model must be video-camera (got {str(name)[:40]})")
    prompt = b.get("prompt")
    if not isinstance(prompt, str) or not prompt.strip():
        raise BadInput("prompt is required")
    if len(prompt) > 4000:
        raise BadInput("prompt is longer than 4000 characters")
    notes = []
    neg = b.get("negative_prompt")
    if neg is not None and not isinstance(neg, str):
        raise BadInput("negative_prompt must be text")
    if neg and neg.strip():
        notes.append("negative_prompt is not used: the distilled model samples in 4 steps without guidance")
    seconds = vs.number(b, "seconds", 1, MAX_SECONDS)
    fps = vs.number(b, "fps", 8, 24, integer=True)
    size = b.get("size")
    if size not in SIZES:
        raise BadInput('size must be "832x480" (the model\'s own) or "1280x720"')
    if size == "1280x720":
        notes.append("1280x720 is beyond what the 1.3B was shown working at (its examples are 832x480); about 2.5x the time")
    if fps != poses.MODEL_FPS:
        notes.append(f"the model makes 16 frames a second; {fps} fps repeats or drops its frames (nearest), it does not interpolate")
    seed = b.get("seed")
    if seed is None:
        seed = secrets.randbelow(2**31)
    elif isinstance(seed, bool) or not isinstance(seed, int) or not 0 <= seed < 2**63:
        raise BadInput("seed must be a whole number from 0")
    w, h = SIZES[size]
    if b.get("image_b64") is None:
        raise BadInput("image_b64 is required: the first frame of the take, at size")
    image = picture(b.get("image_b64"), "image_b64", w, h, notes)
    try:
        cam = poses.read_camera(b.get("camera"))
    except poses.PoseError as e:
        raise BadInput(str(e))
    anchors = b.get("anchors")
    pics = {}
    if anchors is not None:
        if not isinstance(anchors, list) or len(anchors) > MAX_ANCHORS:
            raise BadInput(f"anchors must be a list of at most {MAX_ANCHORS} {{t, image_b64}}")
        times = []
        for i, a in enumerate(anchors):
            if not isinstance(a, dict):
                raise BadInput(f"anchors[{i}] must be an object")
            t = a.get("t")
            if isinstance(t, bool) or not isinstance(t, (int, float)) or not 1 <= t <= seconds - 1:
                raise BadInput(f"anchors[{i}].t must be a time in seconds from 1 to {seconds - 1:g} (an anchor starts at least 1 s of take)")
            times.append((float(t), i))
        times.sort()
        last = 0.0
        for t, i in times:
            if t - last < 1.0:
                raise BadInput(f"anchors[{i}].t is {t - last:.2f} s after the one before (or the start): keep anchors at least 1 s apart")
            last = t
        for t, i in times:
            pics[round(t * poses.MODEL_FPS)] = picture(anchors[i].get("image_b64"), f"anchors[{i}].image_b64", w, h, notes)
        if times:
            notes.append(f"{len(times)} anchor(s): the model starts again from each anchor's picture there, which cuts off drift and can show as a cut")
    p = poses.plan(cam, seconds, w, h, anchor_times=[t / poses.MODEL_FPS for t in pics], min_step_m=MIN_STEP_M)
    notes.extend(p["notes"])
    for sg in p["segments"]:
        sg["image"] = image if sg["start"] == 0 else pics[sg["start"]]
    return {"prompt": prompt.strip(), "seconds": seconds, "fps": fps, "size": size, "seed": seed, "plan": p,
            "out": poses.resample(p["frames"], fps, seconds), "notes": notes}


# ── the mp4, written as the frames come ───────────────────────────────────────────────────────────────────────────

class Mp4Writer:
    """rgb24 frames → H.264 yuv420p mp4 through one ffmpeg; its temporary file is gone when finish() or abort() returns."""

    def __init__(self, w, h, fps):
        fd, self.path = tempfile.mkstemp(suffix=".mp4")
        os.close(fd)
        cmd = [vs.ffmpeg(), "-v", "error", "-y", "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", f"{w}x{h}", "-r", str(fps), "-i", "-",
               "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "17", "-preset", "medium", "-movflags", "+faststart", self.path]
        self.p = subprocess.Popen(cmd, stdin=subprocess.PIPE, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
        self.n = 0

    def write(self, frame):
        self.p.stdin.write(frame.tobytes())
        self.n += 1

    def finish(self):
        try:
            self.p.stdin.close()
            err = self.p.stderr.read()
            if self.p.wait(timeout=600):
                raise RuntimeError("ffmpeg could not write the video: " + err.decode("utf-8", "replace")[-300:])
            with open(self.path, "rb") as f:
                return f.read()
        finally:
            self._rm()

    def abort(self):
        try:
            self.p.kill()
            self.p.wait(timeout=10)
        except Exception:  # noqa: BLE001
            pass
        self._rm()

    def _rm(self):
        try:
            os.unlink(self.path)
        except FileNotFoundError:
            pass


def look(frame):
    """A frame's look for the drift record: mean luma, its spread and the sharpness (variance of a Laplacian), on a
    quarter-size grey copy. Numbers only; no picture is kept."""
    import numpy as np
    g = frame[::4, ::4].astype(np.float32) @ np.array([0.299, 0.587, 0.114], dtype=np.float32)
    lap = g[1:-1, 1:-1] * 4 - g[:-2, 1:-1] - g[2:, 1:-1] - g[1:-1, :-2] - g[1:-1, 2:]
    return {"luma": round(float(g.mean()), 1), "contrast": round(float(g.std()), 1), "sharpness": round(float(lap.var()), 1)}


# ── jobs ─────────────────────────────────────────────────────────────────────────────────────────────────────────

def _run_on_device(job):
    global _last_used
    req = job.req
    p = req["plan"]
    w, h = SIZES[req["size"]]
    m = model()
    t0 = time.time()
    total = sum(sg["latent"] // poses.CHUNK * 5 for sg in p["segments"])
    base = [0]

    def on_step(done, _steps):
        if job.cancel.is_set():
            raise Cancelled()
        job.progress = 0.05 + 0.9 * (base[0] + done) / total

    job.progress = 0.02
    ctx = m.encode(req["prompt"])
    encode_s = time.time() - t0
    out = req["out"]
    writer = Mp4Writer(w, h, req["fps"])
    chunk_s, drift, peak = [], [], 0.0
    k = 0
    last = None
    try:
        for si, sg in enumerate(p["segments"]):
            g = sg["start"]
            end = sg["start"] + sg["frames"]
            tc = time.time()
            for frames in m.segment(ctx, sg["image"], sg["deltas"], p["K"], req["seed"] + si, on_step):
                chunk_s.append(round(time.time() - tc, 2))
                mem = m.memory_gb() if getattr(m, "memory_gb", None) else None
                if mem:
                    peak = max(peak, mem)
                for fr in frames:
                    if g >= end:
                        break
                    last = fr
                    while k < len(out) and out[k] == g:
                        writer.write(fr)
                        k += 1
                    g += 1
                drift.append({"t": round(min(g, end) / poses.MODEL_FPS, 2), **look(frames[-1])})
                job.stats = {"chunks_done": len(chunk_s), "chunk_s": chunk_s[-1]}
                if g >= end:
                    break
                tc = time.time()
            base[0] += sg["latent"] // poses.CHUNK * 5
        if job.cancel.is_set():
            raise Cancelled()
        while k < len(out) and last is not None:   # never short: the last frame holds
            writer.write(last)
            k += 1
        job.progress = 0.97
        data = writer.finish()
    except BaseException:
        writer.abort()
        raise
    finally:
        if getattr(m, "empty", None):
            m.empty()
    s = sorted(chunk_s)
    job.stats = {"load_s": round(getattr(m, "load_s", 0.0), 1), "encode_s": round(encode_s, 1), "total_s": round(time.time() - t0, 1),
                 "chunks": len(chunk_s), "chunk_s_median": s[len(s) // 2] if s else None, "chunk_s_max": s[-1] if s else None,
                 "seconds_per_video_second": round((time.time() - t0) / req["seconds"], 1), "peak_gb": round(peak, 1) if peak else None,
                 "segments": len(p["segments"]), "frames": k, "drift": drift}
    m.load_s = 0.0   # counted once, on the job that loaded it
    print(f"job {job.id}: {req['seconds']:g} s at {req['size']}, {len(chunk_s)} chunks, {job.stats['chunk_s_median']} s a chunk (median), "
          f"{job.stats['total_s']} s in all, peak {job.stats['peak_gb']} GB", file=sys.stderr, flush=True)
    _last_used = time.time()
    return data


def run(job):
    with _gpu, vs.gpu_lock(job) as mine:
        if not mine or job.status != "queued":
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
        except Exception as e:  # noqa: BLE001 – the reason goes to the caller; never the prompt or a picture
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
    return _model is not None


def idle_watch():
    while True:
        time.sleep(30)
        reap()
        if _model is not None and time.time() - _last_used > IDLE_MIN * 60 and _gpu.acquire(blocking=False):
            try:
                if _model is not None and time.time() - _last_used > IDLE_MIN * 60:
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
        parts = path.split("/")
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
    threading.Thread(target=worker, daemon=True).start()
    threading.Thread(target=idle_watch, daemon=True).start()
    return ThreadingHTTPServer(("127.0.0.1", port), Handler)


# ── a sample take (deploy/video-camera.sh's test clip and --measure) ─────────────────────────────────────────────

def sample_request(seconds, image_path, size="832x480", fps=16):
    """A Sets-convention request: a camera at eye height walking forward at 0.6 m/s while it looks slowly left and
    right (±25°, every 12 s), sampled at fps as Thread would send it."""
    import base64
    w, h = SIZES[size]
    with open(image_path, "rb") as f:
        img = base64.b64encode(f.read()).decode()
    frames = []
    for i in range(int(seconds * fps) + 1):
        t = i / fps
        yaw = math.radians(25) * math.sin(2 * math.pi * t / 12)
        frames.append({"t": round(t, 4), "pos": [0.0, 1.6, round(-0.6 * t, 4)],
                       "quat": [0.0, round(math.sin(yaw / 2), 6), 0.0, round(math.cos(yaw / 2), 6)], "focalMm": 24})
    return {"model": "video-camera", "prompt": "A serene lakeside scene with a lone tree standing in calm water, surrounded by distant snow-capped mountains under a bright blue sky, the camera walking slowly along the shore",
            "seed": 7, "fps": fps, "size": size, "seconds": seconds, "image_b64": img,
            "camera": {"convention": "sets", "sensorMm": [36, 24], "aspect": "16:9", "frames": frames}}


if __name__ == "__main__":
    if "--warm" in sys.argv:   # deploy/video-camera.sh: load once to check the weights, then exit
        on_device(model)
        sys.exit(0)
    if "--sample-request" in sys.argv:   # --sample-request SECONDS IMAGE [SIZE]
        i = sys.argv.index("--sample-request")
        print(json.dumps(sample_request(float(sys.argv[i + 1]), sys.argv[i + 2], *(sys.argv[i + 3:i + 4]))))
        sys.exit(0)
    print(f"video-camera on 127.0.0.1:{PORT}: {MODEL} ({DEVICE}), idle {IDLE_MIN:g} min, kept {KEEP_S / 60:g} min", file=sys.stderr, flush=True)
    start().serve_forever()
