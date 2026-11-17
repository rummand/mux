"""The camera server (route video-camera) with a stub model: the request, the pose mapping, the job API. No torch.

Run: ~/.mux/video-venv/bin/python server/video/test_camera_server.py   (any python with numpy and Pillow; with ffmpeg
     through imageio-ffmpeg it also checks the mp4 frame by frame)
What it cannot prove: that LingBot-World v2 runs on MPS and what its video looks like. test_lingbot_mps.py checks the
port against upstream's code with tiny weights; deploy/video-camera.sh's test clip is the first real proof.
"""
import base64, contextlib, fcntl, http.client, importlib.util, io, json, math, os, subprocess, sys, tempfile, threading, time

here = os.path.dirname(os.path.abspath(__file__))
tmp = tempfile.mkdtemp(prefix="mux-camera-test-")
os.environ["MUX_VIDEO_GPU_LOCK"] = os.path.join(tmp, "video-gpu.lock")
spec = importlib.util.spec_from_file_location("camera_server", os.path.join(here, "camera_server.py"))
cs = importlib.util.module_from_spec(spec)
spec.loader.exec_module(cs)
P = cs.poses

import numpy as np
from PIL import Image


def ok(what):
    print("ok", what, flush=True)


def close(a, b, tol=1e-9):
    return np.allclose(np.asarray(a, float), np.asarray(b, float), atol=tol)


def yaw_quat(deg):
    r = math.radians(deg) / 2
    return [0.0, math.sin(r), 0.0, math.cos(r)]


def pitch_quat(deg):
    r = math.radians(deg) / 2
    return [math.sin(r), 0.0, 0.0, math.cos(r)]


# ── the pose mapping ─────────────────────────────────────────────────────────────────────────────────────────────
m = P.opencv_c2w([1, 2, 3], [0, 0, 0, 1])
assert close(m[:3, :3], np.diag([1, -1, -1])) and close(m[:3, 3], [1, 2, 3]), m
# OpenCV's forward (+z column) of an unturned Sets camera is the world's -z; its down (+y column) is the world's -y
assert close(m[:3, 2], [0, 0, -1]) and close(m[:3, 1], [0, -1, 0])
m = P.opencv_c2w([0, 0, 0], yaw_quat(90))   # Sets yaw +90° (about +y): looks down -x
assert close(m[:3, 2], [-1, 0, 0], 1e-9), m[:3, 2]
m = P.opencv_c2w([0, 0, 0], pitch_quat(30))  # pitch up 30°: forward climbs, down tilts
assert close(m[:3, 2], [0, math.sin(math.radians(30)), -math.cos(math.radians(30))], 1e-9), m[:3, 2]
ok("Sets → OpenCV: R_cv = R_sets · diag(1, -1, -1); no turn looks down -z; yaw and pitch go where Sets sends them")

# framewise: a dolly forward is +z in the camera's own frame, a pan left turns the forward to -x, a tilt up to -y
c2ws = np.stack([P.opencv_c2w([0, 1.6, -0.5 * i], [0, 0, 0, 1]) for i in range(4)])
d = P.framewise(c2ws)
assert close(d[0], np.eye(4)) and close(d[2][:3, 3], [0, 0, 0.5]) and close(d[2][:3, :3], np.eye(3))
d = P.framewise(np.stack([P.opencv_c2w([0, 0, 0], yaw_quat(a)) for a in (0, 10)]))
assert d[1][0, 2] < -0.17 and abs(d[1][1, 2]) < 1e-9, d[1][:3, 2]
d = P.framewise(np.stack([P.opencv_c2w([0, 0, 0], pitch_quat(a)) for a in (0, 10)]))
assert d[1][1, 2] < -0.17 and abs(d[1][0, 2]) < 1e-9, d[1][:3, 2]
# and the world's own frame cancels: the same move, the whole set turned and moved, gives the same deltas
Rw = P.quat_matrix(np.array(yaw_quat(37)) * 0 + np.array([0.2, 0.3, 0.1, 0.927]) / np.linalg.norm([0.2, 0.3, 0.1, 0.927]))
move = [P.opencv_c2w([0.1 * i, 0, -0.3 * i], yaw_quat(5 * i)) for i in range(5)]
W = np.eye(4); W[:3, :3] = Rw; W[:3, 3] = [5, -2, 9]
assert close(P.framewise(np.stack(move)), P.framewise(np.stack([W @ c for c in move])), 1e-9)
ok("framewise deltas: dolly is +z, pan left is -x, tilt up is -y in the camera before; the world's axes cancel")

# sampling between frames: position linear, rotation slerp, focal linear; held outside the path
frames = [(0.0, np.zeros(3), np.array(yaw_quat(0)), 24.0), (2.0, np.array([0, 0, -2.0]), np.array(yaw_quat(90)), 50.0)]
pos, q, f = P.sample(frames, 1.0)
assert close(pos, [0, 0, -1]) and close(q, yaw_quat(45), 1e-9) and f == 37.0
assert close(P.sample(frames, -1)[0], [0, 0, 0]) and close(P.sample(frames, 9)[1], yaw_quat(90))
ok("sampling: linear position and focal, slerped rotation, held before the first and after the last frame")

fx, fy, cx, cy = P.intrinsics([36, 24], "16:9", 24, 832, 480)
assert abs(fx - 24 / 36 * 832) < 1e-9 and abs(fy - 24 / 20.25 * 480) < 1e-9 and (cx, cy) == (416, 240)
fx, fy, _, _ = P.intrinsics([36, 24], "4:3", 50, 1280, 720)   # 4:3 on 3:2 keeps the height: frame 32 × 24 mm
assert abs(fx - 50 / 32 * 1280) < 1e-9 and abs(fy - 50 / 24 * 720) < 1e-9
ok("intrinsics as Sets' pinholeOf: the sensor cut to the aspect, then focal / frame × pixels")

assert [P.latent_frames_for(n) for n in (1, 13, 14, 32, 45, 46, 960)] == [4, 4, 8, 12, 12, 16, 244]
assert P.resample(32, 16, 2) == list(range(32))
r = P.resample(32, 24, 2)
assert len(r) == 48 and r[0] == 0 and r[-1] == 31 and all(b - a in (0, 1) for a, b in zip(r, r[1:]))
r = P.resample(32, 8, 2)
assert r == list(range(0, 32, 2))
ok("frames: latents a whole number of 4-frame chunks; 16 fps maps one to one, other rates take the nearest frame")

cam = {"convention": "sets", "sensorMm": [36, 24], "aspect": "16:9", "frames": [
    {"t": 0, "pos": [0, 1.6, 0], "quat": [0, 0, 0, 1], "focalMm": 24}, {"t": 10, "pos": [0, 1.6, -10], "quat": yaw_quat(40), "focalMm": 24}]}
p = P.plan(P.read_camera(cam), 10, 832, 480)
seg = p["segments"][0]
assert p["frames"] == 160 and len(p["segments"]) == 1 and seg["latent"] == P.latent_frames_for(160) == 44
steps = np.linalg.norm(seg["deltas"][:, :3, 3], axis=1)
assert abs(steps.max() - 1) < 1e-9 and steps[0] == 0, steps[:4]
assert abs(p["scale"] - 0.25) < 1e-9, p["scale"]          # 1 m/s, one latent frame every 0.25 s
p2 = P.plan(P.read_camera(cam), 10, 832, 480, anchor_times=[4.0, 7.5])
assert [(s["start"], s["frames"]) for s in p2["segments"]] == [(0, 64), (64, 56), (120, 40)]
assert abs(np.linalg.norm(p2["segments"][1]["deltas"][1:, :3, 3], axis=1).max() - 1) < 1e-9, "one scale for the whole take"
still = dict(cam, frames=[{"t": i / 16, "pos": [0.001 * math.sin(i), 1.6, 0], "quat": yaw_quat(i * 0.5), "focalMm": 24} for i in range(33)])
ps = P.plan(P.read_camera(still), 2, 832, 480)
assert ps["scale"] == P.MIN_STEP_M and any("standing" in n for n in ps["notes"]), ps["notes"]
assert np.linalg.norm(ps["segments"][0]["deltas"][:, :3, 3], axis=1).max() < 0.3
pu = P.plan(P.read_camera(still), 2, 832, 480, min_step_m=0)
assert abs(np.linalg.norm(pu["segments"][0]["deltas"][:, :3, 3], axis=1).max() - 1) < 1e-9, "upstream: shake blown up to 1"
zoom = dict(cam, frames=[dict(cam["frames"][0]), dict(cam["frames"][1], focalMm=50)])
assert any("lens changes" in n for n in P.plan(P.read_camera(zoom), 10, 832, 480)["notes"])
ok("plan: one segment per anchor, translations over the take's largest step (floor 1 cm), notes for a zoom or a still camera")

# ── the request ──────────────────────────────────────────────────────────────────────────────────────────────────

def png(w=832, h=480, colour=(90, 120, 200)):
    buf = io.BytesIO()
    Image.new("RGB", (w, h), colour).save(buf, "PNG")
    return base64.b64encode(buf.getvalue()).decode()


def path(seconds, fps=16):
    return [{"t": i / fps, "pos": [0, 1.6, -0.6 * i / fps], "quat": yaw_quat(10 * math.sin(i / fps)), "focalMm": 24} for i in range(int(seconds * fps) + 1)]


BASE = {"model": "video-camera", "prompt": "a lighthouse on a cliff at dusk, quiet sea", "seed": 3, "fps": 16, "size": "832x480", "seconds": 2,
        "image_b64": png(), "camera": {"convention": "sets", "sensorMm": [36, 24], "aspect": "16:9", "frames": path(2)}}

r = cs.validate(BASE)
assert r["plan"]["frames"] == 32 and len(r["out"]) == 32 and r["notes"] == [] and r["plan"]["segments"][0]["image"].size == (832, 480)


def bad(change, words):
    body = {**BASE, **change}
    for k, v in list(body.items()):
        if v is None:
            del body[k]
    try:
        cs.validate(body)
    except cs.BadInput as e:
        assert words in str(e), (words, str(e))
        return
    raise AssertionError(f"accepted {change}")


bad({"model": "video"}, "video-camera")
bad({"prompt": " "}, "prompt")
bad({"image_b64": None}, "image_b64 is required")
bad({"image_b64": base64.b64encode(b"not a picture").decode()}, "image_b64 is not an image")
bad({"camera": None}, "camera is required")
bad({"camera": {**BASE["camera"], "convention": "opencv"}}, "convention")
bad({"camera": {**BASE["camera"], "aspect": "3:2"}}, "camera.aspect")
bad({"camera": {**BASE["camera"], "sensorMm": [36]}}, "camera.sensorMm")
bad({"camera": {**BASE["camera"], "frames": []}}, "camera.frames")
bad({"camera": {**BASE["camera"], "frames": [{"t": 0, "pos": [0, 0, 0], "quat": [0, 0, 0, 1.3], "focalMm": 24}]}}, "unit quaternion")
bad({"camera": {**BASE["camera"], "frames": [{"t": 0, "pos": [0, 0], "quat": [0, 0, 0, 1], "focalMm": 24}]}}, "frames[0].pos")
bad({"camera": {**BASE["camera"], "frames": [{"t": 0, "pos": [0, 0, 0], "quat": [0, 0, 0, 1]}]}}, "focalMm")
bad({"seconds": 61}, "seconds must be from 1 to 60")
bad({"seconds": 0.5}, "seconds")
bad({"fps": 30}, "fps")
bad({"fps": 12.5}, "fps")
bad({"size": "1920x1080"}, "size")
bad({"seed": -1}, "seed")
bad({"anchors": [{"t": 0.5, "image_b64": png()}]}, "anchors[0].t")
bad({"seconds": 10, "camera": {**BASE["camera"], "frames": path(10)}, "anchors": [{"t": 3, "image_b64": png()}, {"t": 3.5, "image_b64": png()}]}, "at least 1 s apart")
bad({"seconds": 10, "camera": {**BASE["camera"], "frames": path(10)}, "anchors": [{"t": 3, "image_b64": "!!"}]}, "anchors[0].image_b64")
r = cs.validate({**BASE, "fps": 24, "negative_prompt": "blur", "image_b64": png(640, 480)})
assert any("24 fps" in n for n in r["notes"]) and any("negative_prompt" in n for n in r["notes"]) and any("cropped" in n for n in r["notes"]), r["notes"]
assert len(r["out"]) == 48 and r["plan"]["segments"][0]["image"].size == (832, 480)
r = cs.validate({**BASE, "seconds": 10, "camera": {**BASE["camera"], "frames": path(10)}, "anchors": [{"t": 6, "image_b64": png(colour=(1, 2, 3))}, {"t": 3, "image_b64": png(colour=(4, 5, 6))}]})
segs = r["plan"]["segments"]
assert [s["start"] for s in segs] == [0, 48, 96] and segs[1]["image"].getpixel((0, 0)) == (4, 5, 6) and segs[2]["image"].getpixel((0, 0)) == (1, 2, 3)
ok("validation: every field named when wrong; anchors sorted, 1 s apart, each starting a segment from its picture")

# ── the job API with a stub model ────────────────────────────────────────────────────────────────────────────────
device_threads = set()
gate = threading.Event()
gate.set()
loads = []


class Fake:
    load_s = 1.5

    def encode(self, prompt):
        device_threads.add(threading.get_ident())
        return ("ctx", len(prompt))

    def segment(self, ctx, image, deltas, K, seed, on_step):
        """13 then 16 frames a chunk, as the real loop; each frame's red is its index in the segment × 4, its green
        the segment's first pixel's green (which picture it started from)."""
        device_threads.add(threading.get_ident())
        w, h = image.size
        chunks = len(deltas) // 4
        n = 0
        for c in range(chunks):
            for step in range(5):
                while not gate.wait(0.02):
                    on_step(c * 5 + step, chunks * 5)
                on_step(c * 5 + step + 1, chunks * 5)
            count = 13 if c == 0 else 16
            out = np.zeros((count, h, w, 3), dtype=np.uint8)
            for i in range(count):
                out[i, :, :, 0] = ((n + i) * 4) % 256
                out[i, :, :, 1] = image.getpixel((0, 0))[1]
            n += count
            yield out

    def memory_gb(self):
        return 3.5

    def empty(self):
        pass


def fake_load():
    device_threads.add(threading.get_ident())
    loads.append(1)
    return Fake()


cs.load_model = fake_load
cs.vs.available_gb = lambda: 500.0   # this Mac's real free memory must not decide the tests; the memory test sets it
server = cs.start(0)
port = server.server_address[1]
threading.Thread(target=server.serve_forever, daemon=True).start()


def call(method, p, body=None, raw=None):
    c = http.client.HTTPConnection("127.0.0.1", port, timeout=20)
    data = raw if raw is not None else (json.dumps(body).encode() if body is not None else None)
    c.request(method, p, body=data, headers={"content-type": "application/json"} if data is not None else {})
    r = c.getresponse()
    out = r.read()
    c.close()
    try:
        return r.status, json.loads(out), r.getheader("content-type")
    except ValueError:
        return r.status, out, r.getheader("content-type")


def wait_for(job_id, statuses, limit=30.0):
    t = time.time()
    while time.time() - t < limit:
        s, j, _ = call("GET", f"/v1/videos/{job_id}")
        if j["status"] in statuses:
            return j
        time.sleep(0.02)
    raise AssertionError(f"{job_id} never reached {statuses}: {j}")


try:
    cs.vs.ffmpeg()
    have_ffmpeg = True
except RuntimeError:
    have_ffmpeg = False
if not have_ffmpeg:   # no ffmpeg: frames counted, not encoded
    class CountWriter:
        def __init__(self, w, h, fps):
            self.frames = []

        def write(self, f):
            self.frames.append(int(f[0, 0, 0]))

        def finish(self):
            return b"\x00\x00\x00\x18ftypmp42" + json.dumps(self.frames).encode()

        def abort(self):
            pass
    cs.Mp4Writer = CountWriter


def decoded_reds(mp4, w=832, h=480):
    fd, p = tempfile.mkstemp(suffix=".mp4")
    with os.fdopen(fd, "wb") as f:
        f.write(mp4)
    try:
        out = subprocess.run([cs.vs.ffmpeg(), "-v", "error", "-i", p, "-f", "rawvideo", "-pix_fmt", "rgb24", "-"], capture_output=True, timeout=120).stdout
    finally:
        os.unlink(p)
    frames = np.frombuffer(out, dtype=np.uint8).reshape(-1, h, w, 3)
    return [int(round(float(f[200:280, 300:500, 0].mean()))) for f in frames], [int(round(float(f[200:280, 300:500, 1].mean()))) for f in frames]


def reds_of(mp4):
    return decoded_reds(mp4)[0] if have_ffmpeg else json.loads(mp4[12:])


err = io.StringIO()
real_err = sys.stderr
sys.stderr = err
try:
    s, j, _ = call("POST", "/v1/videos/generations", BASE)
    assert s == 202 and j["status"] == "queued" and j["model"] == cs.MODEL and j["id"].startswith("video_"), (s, j)
    done = wait_for(j["id"], {"succeeded", "failed"})
finally:
    sys.stderr = real_err
assert done["status"] == "succeeded", done
st = done["stats"]
assert st["chunks"] == 3 and st["segments"] == 1 and st["frames"] == 32 and st["peak_gb"] == 3.5 and st["load_s"] == 1.5 and len(st["drift"]) == 3, st
assert set(st["drift"][0]) == {"t", "luma", "contrast", "sharpness"}
s, body, ctype = call("GET", f"/v1/videos/{j['id']}/content")
assert s == 200 and ctype == "video/mp4" and body[4:8] == b"ftyp", (s, ctype, body[:12])
reds = reds_of(body)
assert len(reds) == 32 and all(abs(r - (i * 4) % 256) <= 3 for i, r in enumerate(reds)), reds
log = err.getvalue()
assert "lighthouse" not in log and BASE["image_b64"][:40] not in log, log
assert "3 chunks" in log, log
ok("a 2 s take: 202, then succeeded with its timings; 32 frames in order in an H.264 mp4" + ("" if have_ffmpeg else " (counted: no ffmpeg here)") + "; nothing of the prompt or picture logged")

s, j, _ = call("POST", "/v1/videos/generations", {**BASE, "fps": 24})
done = wait_for(j["id"], {"succeeded", "failed"})
reds = reds_of(call("GET", f"/v1/videos/{j['id']}/content")[1])
assert len(reds) == 48 and abs(reds[1] - reds[0]) <= 3 and abs(reds[-1] - 124) <= 3, reds
assert done["fps"] == 24 and any("24 fps" in n for n in done["notes"])
ok("24 fps: 48 frames from the model's 32, nearest frame, and a note saying so")

s, j, _ = call("POST", "/v1/videos/generations", {**BASE, "seconds": 4, "camera": {**BASE["camera"], "frames": path(4)},
                                                 "anchors": [{"t": 2, "image_b64": png(colour=(0, 200, 0))}]})
done = wait_for(j["id"], {"succeeded", "failed"})
assert done["stats"]["segments"] == 2, done
if have_ffmpeg:
    reds, greens = decoded_reds(call("GET", f"/v1/videos/{j['id']}/content")[1])
    assert len(reds) == 64 and abs(reds[31] - 124) <= 3 and reds[32] <= 3 and abs(greens[10] - 120) <= 4 and abs(greens[40] - 200) <= 4, (reds[28:36], greens[::8])
ok("anchors: the take starts again at 2 s from the anchor's picture")

# cancel while running; the content never comes
gate.clear()
s, j, _ = call("POST", "/v1/videos/generations", BASE)
wait_for(j["id"], {"running"})
s, c, _ = call("POST", f"/v1/videos/{j['id']}/cancel")
assert s == 200 and c["status"] == "cancelled"
gate.set()
time.sleep(0.3)
assert call("GET", f"/v1/videos/{j['id']}")[1]["status"] == "cancelled"
assert call("GET", f"/v1/videos/{j['id']}/content")[0] == 409
ok("cancel: a running take stops at its next step; content is 409")

# another video server's job holds the Mac's lock: this one waits, queued, then runs
fd = os.open(os.environ["MUX_VIDEO_GPU_LOCK"], os.O_RDWR | os.O_CREAT)
fcntl.flock(fd, fcntl.LOCK_EX)
s, j, _ = call("POST", "/v1/videos/generations", BASE)
time.sleep(1.2)
assert call("GET", f"/v1/videos/{j['id']}")[1]["status"] == "queued"
fcntl.flock(fd, fcntl.LOCK_UN)
os.close(fd)
assert wait_for(j["id"], {"succeeded", "failed"})["status"] == "succeeded"
ok("one GPU: while the Wan server holds the lock a camera job stays queued, then runs")

# the queue is bounded; errors are 400 with the field; 404s
gate.clear()
ids = [call("POST", "/v1/videos/generations", BASE) for _ in range(cs.MAX_QUEUE + 1)]
assert [s for s, _, _ in ids[:-1]] == [202] * cs.MAX_QUEUE and ids[-1][0] == 429 and ids[-1][1]["error"]["type"] == "queue_full", [s for s, _, _ in ids]
gate.set()
for s, j, _ in ids[:-1]:
    wait_for(j["id"], {"succeeded"})
s, j, _ = call("POST", "/v1/videos/generations", {**BASE, "camera": None})
assert s == 400 and "camera" in j["error"]["message"]
assert call("POST", "/v1/videos/generations", raw=b"{nope")[0] == 400
assert call("GET", "/v1/videos/video_nope")[0] == 404 and call("POST", "/v1/videos/video_nope/cancel")[0] == 404
cs.MAX_BODY = 1024
assert call("POST", "/v1/videos/generations", raw=b"x" * 2048)[0] == 413
cs.MAX_BODY = 200 * 1024 * 1024
ok(f"queue: {cs.MAX_QUEUE} waiting or running, then 429; bad input 400; unknown ids 404; a body over the limit 413")

# kept an hour, then gone
s, j, _ = call("POST", "/v1/videos/generations", BASE)
wait_for(j["id"], {"succeeded"})
cs.KEEP_S = 0.2
time.sleep(0.3)
assert call("GET", f"/v1/videos/{j['id']}")[0] == 404
cs.KEEP_S = 3600
ok("expiry: a finished video is gone after KEEP_S")

# memory: refused in words (503 memory_busy) when free memory and what the server holds fall short of a take's peak,
# rather than swapping; a queued job that no longer fits fails when it starts; /v1/models says what more it needs;
# a take's peak footprint is its stat, and a larger peak than the measured one raises it
real_fp = cs.footprint_gb
cs.footprint_gb = lambda: (10.0, 10.0)
assert call("GET", "/v1/models")[1]["data"][0]["need_gb"] == cs.PEAK_GB["832x480"] + cs.SPARE_GB - 10
cs.vs.available_gb = lambda: 12.0
n_jobs = len(cs._jobs)
s, j, _ = call("POST", "/v1/videos/generations", BASE)
assert s == 503 and j["error"]["type"] == "memory_busy" and j["error"]["message"].startswith("the Mac is short of memory: 12 GB free"), (s, j)
assert len(cs._jobs) == n_jobs, "nothing queued"
cs.vs.available_gb = lambda: 25.0   # 25 + 10 held ≥ 28 + 2: it fits
fd = os.open(os.environ["MUX_VIDEO_GPU_LOCK"], os.O_RDWR | os.O_CREAT)
fcntl.flock(fd, fcntl.LOCK_EX)
s, j, _ = call("POST", "/v1/videos/generations", BASE)
assert s == 202, (s, j)
cs.vs.available_gb = lambda: 5.0    # the chat models came back while it waited
fcntl.flock(fd, fcntl.LOCK_UN)
os.close(fd)
done = wait_for(j["id"], {"succeeded", "failed"})
assert done["status"] == "failed" and done["error"]["type"] == "memory_busy", done
cs.vs.available_gb = lambda: 500.0
cs.footprint_gb = lambda: (40.0, 1e6)   # the lifetime peak was already higher: the sampled 40 GB counts
s, j, _ = call("POST", "/v1/videos/generations", BASE)
done = wait_for(j["id"], {"succeeded", "failed"})
assert done["status"] == "succeeded" and done["stats"]["peak_gb"] == 40.0 and cs.PEAK_GB["832x480"] == 40.0, (done, cs.PEAK_GB)
cs.PEAK_GB["832x480"] = 28.0
cs.footprint_gb = real_fp
now, life = cs.footprint_gb()
assert sys.platform != "darwin" or (0 < now <= life), (now, life)
ok("memory: 503 memory_busy in words when the Mac is short, nothing queued; a queued job that no longer fits fails as it starts; need_gb in /v1/models; the peak footprint is the stat")

assert len(loads) == 1, f"the model loaded {len(loads)} times"
assert len(device_threads) == 1 and threading.get_ident() not in device_threads, device_threads
m0 = call("GET", "/v1/models")[1]["data"][0]
assert {k: m0[k] for k in ("id", "object", "loaded")} == {"id": cs.MODEL, "object": "model", "loaded": True} and m0["need_gb"] >= 0, m0
cs.on_device(cs.let_go)
assert call("GET", "/v1/models")[1]["data"][0]["loaded"] is False
ok("one load, one device thread for every model call; /v1/models says loaded, and not after let-go")

Image.new("RGB", (832, 480)).save(os.path.join(tmp, "first.png"))
req = cs.sample_request(3, os.path.join(tmp, "first.png"))
assert cs.validate(req)["plan"]["frames"] == 48
ok("the sample take (deploy/video-camera.sh) is a valid request")
print("all camera server tests passed", flush=True)
os._exit(0)
