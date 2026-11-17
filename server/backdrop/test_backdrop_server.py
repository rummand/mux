"""The backdrop server's job API with a stub model: no torch, no diffusers, no weights, no Mac.

Run: python3 server/backdrop/test_backdrop_server.py   (needs numpy and Pillow, as the server does)
The stub makes a known panorama and a known depth (a ground 1.7 units below the camera, walls around it); everything
after that is the server's own: the depth PNG, the dome, the meta, the job's life, validation and limits.
What it cannot prove: that HunyuanWorld 1.0's panorama step and MoGe-2 load and run on MPS. That is
deploy/backdrop.sh's test backdrop, on the Mac.
"""
import base64, contextlib, http.client, importlib.util, io, json, math, os, sys, threading, time

import numpy as np
from PIL import Image

here = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location("backdrop_server", os.path.join(here, "backdrop_server.py"))
bs = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bs)
dome = bs.dome

err = io.StringIO()  # everything the server logs, to check no prompt is in it
real_stderr = sys.stderr
sys.stderr = err
sys.excepthook = lambda *e: __import__("traceback").print_exception(*e, file=real_stderr)  # a failed check is shown

# ── the stub model ───────────────────────────────────────────────────────────────────────────────────────────────
device_threads = set()
gate = threading.Event()   # the panorama waits here until the test lets it go
gate.set()
seen = []                  # what the panorama step was given
fail_with = []             # an exception for the next job to raise
SCENE = {"ground": 1.7, "radius": 30.0, "metric": True}


def synthetic_depth(h, w, ground, radius, top=8.0):
    d = dome.pixel_directions(h, w)
    horiz = np.sqrt(d[..., 0] ** 2 + d[..., 2] ** 2)
    t_wall = radius / np.maximum(horiz, 1e-12)
    t_floor = np.where(d[..., 1] < 0, ground / np.maximum(-d[..., 1], 1e-12), np.inf)
    depth = np.minimum(t_floor, np.where(t_wall * d[..., 1] <= top, t_wall, np.inf))
    valid = np.isfinite(depth)
    return np.where(valid, depth, 0).astype(np.float32), valid


def fake_panorama(req, on_step):
    device_threads.add(threading.get_ident())
    seen.append(req)
    if fail_with:
        raise fail_with.pop()
    bs._pano = ("image" if req["image"] is not None else "text", object())  # loaded now, as the real one would be
    on_step(0, 4)
    while not gate.wait(0.02):
        on_step(0, 4)  # a real step would come now and then: a cancel is seen here
    for i in range(1, 5):
        on_step(i, 4)
    w, h = bs.SIZES[req["size"]]
    rgb = np.zeros((h, w, 3), np.uint8)
    rgb[..., 0] = np.linspace(0, 255, w)[None, :]
    rgb[..., 1] = req["seed"] % 256
    return Image.fromarray(rgb)


def fake_depth(rgb, on_view):
    device_threads.add(threading.get_ident())
    for i in range(1, 6):
        on_view(i * 4, 20)
    h, w = rgb.shape[:2]
    depth, valid = synthetic_depth(h, w, SCENE["ground"], SCENE["radius"])
    return depth, valid, SCENE["metric"]


assert os.environ.get("MUX_BACKDROP_PORT") or bs.PORT == 8316, bs.PORT  # 8315 is com.mux.video-camera's
bs.make_panorama, bs.make_depth = fake_panorama, fake_depth
bs.image_ready = lambda: True
bs.available_gb = lambda: 100.0
server = bs.start(0)
port = server.server_address[1]
threading.Thread(target=server.serve_forever, daemon=True).start()


def call(method, path, body=None, raw=None):
    c = http.client.HTTPConnection("127.0.0.1", port, timeout=30)
    data = raw if raw is not None else (json.dumps(body).encode() if body is not None else None)
    c.request(method, path, body=data, headers={"content-type": "application/json"} if data is not None else {})
    r = c.getresponse()
    out = r.read()
    c.close()
    try:
        return r.status, json.loads(out), r.getheader("content-type")
    except ValueError:
        return r.status, out, r.getheader("content-type")


def wait_for(job_id, statuses, limit=20.0):
    t = time.time()
    j = None
    while time.time() - t < limit:
        s, j, _ = call("GET", f"/v1/backdrops/{job_id}")
        if j["status"] in statuses:
            return j
        time.sleep(0.02)
    raise AssertionError(f"{job_id} never reached {statuses}: {j}")


SECRET = "a lighthouse on a basalt cliff, storm light, kestrel-7781"
BASE = {"prompt": SECRET, "seed": 3}
ok = lambda name: print(f"ok {name}", file=real_stderr)

# ── status flow ──────────────────────────────────────────────────────────────────────────────────────────────────
gate.clear()
s, j, _ = call("POST", "/v1/backdrops", {**BASE, "size": "1920x960"})
assert s == 202 and j["status"] == "queued" and j["model"] == "backdrop" and j["id"].startswith("backdrop_"), (s, j)
jid = j["id"]
running = wait_for(jid, {"running"})
assert 0 <= running["progress"] < 0.5 and "meta" not in running
for f in ("panorama", "depth", "dome"):
    s, j, _ = call("GET", f"/v1/backdrops/{jid}/{f}")
    assert s == 409 and j["error"]["type"] == "not_ready", (f, s, j)
gate.set()
done = wait_for(jid, {"succeeded"})
assert done["progress"] == 1.0 and "error" not in done
meta = done["meta"]
assert set(meta) == {"horizon", "groundDepth", "depthScale"}, meta
assert abs(meta["horizon"] - 0.5) < 0.005 and meta["depthScale"] == "metric" and abs(meta["groundDepth"] - 1.7) < 0.03, meta
assert seen[-1]["seed"] == 3 and seen[-1]["prompt"] == SECRET and seen[-1]["image"] is None
ok("status flow: queued → running → succeeded; meta horizon 0.5, groundDepth 1.7 m, metric")

# ── the three files ──────────────────────────────────────────────────────────────────────────────────────────────
s, png, ctype = call("GET", f"/v1/backdrops/{jid}/panorama")
assert s == 200 and ctype == "image/png"
pano = Image.open(io.BytesIO(png))
assert pano.size == (1920, 960) and pano.mode == "RGB"
s, dpng, ctype = call("GET", f"/v1/backdrops/{jid}/depth")
assert s == 200 and ctype == "image/png"
dim = Image.open(io.BytesIO(dpng))
assert dim.size == (1920, 960) and dim.mode in ("I;16", "I;16B", "I;16L", "I"), dim.mode
darr = np.asarray(dim).astype(np.int64)
truth, tvalid = synthetic_depth(960, 1920, 1.7, 30.0)
assert (darr[~tvalid] == 0).all(), "the sky is 0"
probe = tvalid & (truth < 60)
assert np.abs(darr[probe] - np.round(truth[probe] * 1000)).max() <= 1, "millimetres"
s, glb, ctype = call("GET", f"/v1/backdrops/{jid}/dome")
assert s == 200 and ctype == "model/gltf-binary" and glb[:4] == b"glTF"
doc, binary = dome.read_glb(glb)
prim = doc["meshes"][0]["primitives"][0]
pos = dome.accessor(doc, binary, prim["attributes"]["POSITION"])
assert pos[:, 1].min() >= -1.6 - 1e-5 and np.isclose(pos[:, 1], -1.6, atol=1e-5).sum() > 1000, "the floor at y = -1.6"
eq = np.abs(pos[:, 1]) < 1e-3
assert abs(np.median(np.hypot(pos[eq, 0], pos[eq, 2])) - 100) < 2, "the horizon at 100 units"
ok("files: panorama PNG 1920×960, depth PNG 16-bit in mm (sky 0), dome GLB with its floor at -1.6 and horizon at 100")

# ── a far scene: the depth PNG goes relative; a scene without metric scale says so ───────────────────────────────
SCENE.update(radius=3000.0)
_, j, _ = call("POST", "/v1/backdrops", BASE)
far = wait_for(j["id"], {"succeeded"})
assert far["meta"]["depthScale"] == "relative" and abs(far["meta"]["groundDepth"] - 1.7 / 3000 * 20) < 0.002, far["meta"]
SCENE.update(radius=30.0, metric=False)
_, j, _ = call("POST", "/v1/backdrops", BASE)
rel = wait_for(j["id"], {"succeeded"})
assert rel["meta"]["depthScale"] == "relative", rel["meta"]
SCENE.update(metric=True)
ok("depthScale: relative when the depth is beyond 65 m or has no metric scale (units: horizon = 20)")

# ── an image ─────────────────────────────────────────────────────────────────────────────────────────────────────
img = io.BytesIO()
Image.new("RGB", (640, 480), (20, 120, 200)).save(img, format="JPEG")
s, j, _ = call("POST", "/v1/backdrops", {"prompt": "a harbour", "image_b64": "data:image/jpeg;base64," + base64.b64encode(img.getvalue()).decode()})
assert s == 202, j
wait_for(j["id"], {"succeeded"})
assert seen[-1]["image"].size == (640, 480) and seen[-1]["image"].mode == "RGB" and isinstance(seen[-1]["seed"], int)
bs.image_ready = lambda: False
s, j, _ = call("POST", "/v1/backdrops", {"prompt": "a harbour", "image_b64": base64.b64encode(img.getvalue()).decode()})
assert s == 400 and "--image" in j["error"]["message"] and "text only" in j["error"]["message"], j
bs.image_ready = lambda: True
ok("an image: decoded (a data: prefix is fine) and handed to the panorama step; a seed is picked when none is given; "
   "without FLUX.1-Fill-dev installed, 400 says text only")

# ── cancel: queued and running ───────────────────────────────────────────────────────────────────────────────────
gate.clear()
_, a, _ = call("POST", "/v1/backdrops", BASE)
wait_for(a["id"], {"running"})
_, b, _ = call("POST", "/v1/backdrops", BASE)
s, c, _ = call("POST", f"/v1/backdrops/{b['id']}/cancel")
assert s == 200 and c == {"id": b["id"], "status": "cancelled"}, c
s, c, _ = call("POST", f"/v1/backdrops/{a['id']}/cancel")
assert s == 200 and c["status"] == "cancelled"
gate.set()
time.sleep(0.4)
assert call("GET", f"/v1/backdrops/{a['id']}")[1]["status"] == "cancelled"
assert call("GET", f"/v1/backdrops/{a['id']}/dome")[0] == 409
assert call("GET", f"/v1/backdrops/{b['id']}")[1]["status"] == "cancelled"
assert call("POST", "/v1/backdrops/nope/cancel")[0] == 404
assert call("GET", "/v1/backdrops/nope")[0] == 404
ok("cancel: a queued job never runs, a running one stops at its next step and gives no files")

# ── a failed job says why; nothing of the prompt in the log ──────────────────────────────────────────────────────
fail_with.append(MemoryError("only 12 GB free on this Mac; the panorama model wants 30 GB"))
_, j, _ = call("POST", "/v1/backdrops", BASE)
f = wait_for(j["id"], {"failed"})
assert f["error"]["type"] == "out_of_memory" and "30 GB" in f["error"]["message"], f
fail_with.append(RuntimeError("MPS backend out of memory (MPS allocated 41 GB)"))
_, j, _ = call("POST", "/v1/backdrops", BASE)
assert wait_for(j["id"], {"failed"})["error"]["type"] == "out_of_memory"
fail_with.append(ValueError("something else broke"))
_, j, _ = call("POST", "/v1/backdrops", BASE)
f = wait_for(j["id"], {"failed"})
assert f["error"] == {"type": "server_error", "message": "something else broke"}, f
ok("failures: out_of_memory (also MPS's own words) and server_error, with the reason")

# ── busy: nothing loaded and not the memory for it → 429, in words; loaded → taken ───────────────────────────────
bs.on_device(bs.let_go)
assert call("GET", "/v1/models")[1]["data"][0]["loaded"] is False
bs.available_gb = lambda: 11.0
s, j, _ = call("POST", "/v1/backdrops", BASE)
assert s == 429 and j["error"]["type"] == "busy" and "busy" in j["error"]["message"] and "11 GB" in j["error"]["message"], (s, j)
bs._pano = ("text", object())
s, j, _ = call("POST", "/v1/backdrops", BASE)
assert s == 202, "with the model in memory the room is already there"
wait_for(j["id"], {"succeeded"})
bs.available_gb = lambda: 100.0
ok("busy: 429 'the Mac is busy' with the memory it lacks, unless the model is already loaded")

# ── expiry ───────────────────────────────────────────────────────────────────────────────────────────────────────
bs.KEEP_S = 0.2
_, e, _ = call("POST", "/v1/backdrops", BASE)
wait_for(e["id"], {"succeeded"})
time.sleep(0.3)
assert call("GET", f"/v1/backdrops/{e['id']}")[0] == 404
assert call("GET", f"/v1/backdrops/{e['id']}/panorama")[0] == 404
bs.KEEP_S = 3600
ok("expiry: a finished backdrop is gone (404) once past its keep (1 hour)")

# ── validation ───────────────────────────────────────────────────────────────────────────────────────────────────
tiny = io.BytesIO()
Image.new("RGB", (16, 16)).save(tiny, format="PNG")
bad = [
    ({"prompt": ""}, "prompt"), ({"prompt": None}, "prompt"), ({"prompt": 7}, "prompt"), ({"prompt": "x" * 2001}, "2000"),
    ({"size": "1024x512"}, "1920x960"), ({"size": None}, "1920x960"),
    ({"seed": -1}, "seed"), ({"seed": 1.5}, "seed"), ({"seed": True}, "seed"),
    ({"image_b64": base64.b64encode(b"not an image").decode()}, "image_b64"), ({"image_b64": 5}, "image_b64"),
    ({"image_b64": base64.b64encode(tiny.getvalue()).decode()}, "64"),
]
for patch, word in bad:
    s, j, _ = call("POST", "/v1/backdrops", {**BASE, **patch})
    assert s == 400 and word in j["error"]["message"], (patch, s, j)
assert call("POST", "/v1/backdrops", raw=b"{nope")[0] == 400
assert call("POST", "/v1/backdrops", body=[1, 2])[0] == 400
s, j, _ = call("POST", "/v1/backdrops", {"prompt": "dunes", "model": "anything", "extra": 1})
assert s == 202, "unknown fields are ignored"
wait_for(j["id"], {"succeeded"})
ok("validation: prompt, size 1920x960 only, seed, image; 400 says what is wrong")

# ── body limit and the queue ─────────────────────────────────────────────────────────────────────────────────────
assert bs.MAX_BODY == 50 * 1024 * 1024
bs.MAX_BODY = 1024
s, j, _ = call("POST", "/v1/backdrops", raw=b"x" * 2048)
assert s == 413 and "MB" in j["error"]["message"], (s, j)
bs.MAX_BODY = 50 * 1024 * 1024
gate.clear()
answers = [call("POST", "/v1/backdrops", BASE) for _ in range(bs.MAX_QUEUE + 1)]
assert [a[0] for a in answers[:-1]] == [202] * bs.MAX_QUEUE and answers[-1][0] == 429, [a[0] for a in answers]
assert answers[-1][1]["error"]["type"] == "queue_full" and "busy" in answers[-1][1]["error"]["message"]
gate.set()
for s, j, _ in answers[:-1]:
    wait_for(j["id"], {"succeeded"})
ok(f"limits: body 50 MB (413 above); at most {bs.MAX_QUEUE} waiting or running, then 429 queue_full")

# ── one device thread; nothing about a prompt logged ─────────────────────────────────────────────────────────────
assert len(device_threads) == 1, f"model work ran on {len(device_threads)} threads"
assert threading.get_ident() not in device_threads
s, j, _ = call("GET", "/v1/models")
assert j["data"][0]["id"] == bs.MODEL and j["data"][0]["loaded"] is True
bs.on_device(bs.let_go)
assert call("GET", "/v1/models")[1]["data"][0]["loaded"] is False
logged = err.getvalue()
assert "kestrel" not in logged and "lighthouse" not in logged and "harbour" not in logged, "a prompt reached the log"
assert "job backdrop_" in logged and "MemoryError" in logged, "a failed job's class is logged"
ok("one device thread for every model call; the log has job ids and error classes, never a prompt")
print("all backdrop server tests passed", file=real_stderr)
os._exit(0)
