"""The measure server with stub models: no torch, no Depth Pro, no MapAnything, no Mac.

Run: python3 server/measure/test_measure_server.py   (needs numpy and Pillow, as the server does)
What it proves: the HTTP contract, the job flow (queued → running → succeeded, cancel, expiry, queue), validation, the
body limits, the one device thread, a depth request waiting for a running reconstruction, and the geometry around the
model (crops, intrinsics back in the photo's pixels, photo 0's frame, scale from one measurement, the PLY) on a scene
whose truth is known. What it cannot prove: that Depth Pro and MapAnything load and answer well on MPS. That is
deploy/measure.sh's test on the sample house, on the Mac.
"""
import base64, http.client, importlib.util, io, json, os, sys, threading, time

here = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location("measure_server", os.path.join(here, "measure_server.py"))
ms = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ms)

import numpy as np
from PIL import Image

# ── a scene with a known truth ───────────────────────────────────────────────────────────────────────────────────
# A wall at z = 5 m in photo 0's camera frame; photo i's camera sits i × 1.5 m to the right, turned 4° per step.
KT = np.array([[400.0, 0, 320], [0, 400.0, 240], [0, 0, 1]])  # in the photos' own pixels (640 × 480)


def rot_y(deg):
    a = np.radians(deg)
    return np.array([[np.cos(a), 0, np.sin(a)], [0, 1, 0], [-np.sin(a), 0, np.cos(a)]])


def true_cam(i):
    """World (= photo 0's camera) → camera i: R, t."""
    R = rot_y(-4.0 * i)
    c = np.array([1.5 * i, 0.0, 0.0])
    return R, -R @ c


# The model's world is not photo 0's frame and is at half scale: the server must undo both.
G = rot_y(30) @ np.array([[1, 0, 0], [0, np.cos(0.3), -np.sin(0.3)], [0, np.sin(0.3), np.cos(0.3)]])
GT = np.array([2.0, -1.0, 0.5])
HALF = 0.5

device_threads = set()
gate = threading.Event()
gate.set()
seen = []


def fake_load_depth():
    device_threads.add(threading.get_ident())
    return "depth-model"


def fake_depth_infer(loaded, im, f_px):
    device_threads.add(threading.get_ident())
    seen.append(("depth", im.size, f_px))
    d = np.full((im.height, im.width), 2.5, dtype=np.float32)
    d[: im.height // 2] = 70.0  # beyond 65.535 m: clipped
    d[0, 0] = np.nan  # nothing: 0
    return d, (f_px or 555.5)


def fake_load_recon():
    device_threads.add(threading.get_ident())
    return "recon-model"


def fake_recon_infer(model, photos, known_k, step):
    device_threads.add(threading.get_ident())
    seen.append(("recon", len(photos), known_k))
    tw, th = 160, 112
    step(0.2)
    while not gate.wait(0.02):
        step(0.2)  # a real stage boundary would come now and then: a cancel is seen here
    views = []
    for i, p in enumerate(photos):
        crop, tf = ms.cover_crop(p, tw, th)
        R, t = true_cam(i)
        Kc = np.array(ms.k_to_crop(KT.tolist(), tf))
        u, v = np.meshgrid(np.arange(tw, dtype=float), np.arange(th, dtype=float))
        rays = np.stack([u, v, np.ones_like(u)], -1) @ np.linalg.inv(Kc).T @ R  # world directions (R^T d)
        c = -R.T @ t
        lam = (5.0 - c[2]) / rays[..., 2]
        X = c + rays * lam[..., None]  # on the wall z = 5
        Xm = HALF * (X @ G.T + GT)
        c2w = np.eye(4)
        c2w[:3, :3], c2w[:3, 3] = G @ R.T, HALF * (G @ c + GT)
        mask = np.ones((th, tw), bool)
        mask[:4] = False  # an edge the model masked
        views.append({"pts3d": Xm.astype(np.float32), "conf": np.full((th, tw), 1.0 + i, np.float32), "mask": mask, "K": Kc,
                      "cam2world": c2w, "rgb": np.asarray(crop), "tf": tf})
    step(0.8)
    return views, False  # not metric: like VGGT, the scale comes from the measurement


ms.load_depth, ms.depth_infer, ms.load_recon, ms.recon_infer = fake_load_depth, fake_depth_infer, fake_load_recon, fake_recon_infer
server = ms.start(0)
port = server.server_address[1]
threading.Thread(target=server.serve_forever, daemon=True).start()


def call(method, path, body=None, raw=None):
    c = http.client.HTTPConnection("127.0.0.1", port, timeout=20)
    data = raw if raw is not None else (json.dumps(body).encode() if body is not None else None)
    c.request(method, path, body=data, headers={"content-type": "application/json"} if data is not None else {})
    r = c.getresponse()
    out = r.read()
    c.close()
    try:
        return r.status, json.loads(out)
    except ValueError:
        return r.status, out


def wait_for(job_id, statuses, limit=5.0):
    t = time.time()
    while time.time() - t < limit:
        s, j = call("GET", f"/v1/reconstruct/{job_id}")
        if j["status"] in statuses:
            return j
        time.sleep(0.02)
    raise AssertionError(f"{job_id} never reached {statuses}: {j}")


def jpeg(w=640, h=480, colour=(120, 90, 60), exif35=None):
    im = Image.new("RGB", (w, h), colour)
    b = io.BytesIO()
    if exif35:
        ex = Image.Exif()
        ex.get_ifd(0x8769)[41989] = exif35
        im.save(b, format="JPEG", exif=ex.tobytes())
    else:
        im.save(b, format="JPEG")
    return base64.b64encode(b.getvalue()).decode()


ok = lambda name: print(f"ok {name}")
PHOTO = jpeg()

# ── depth ────────────────────────────────────────────────────────────────────────────────────────────────────────
s, j = call("POST", "/v1/depth", {"image_b64": PHOTO})
assert s == 200, (s, j)
assert j["model"] == ms.DEPTH_MODEL and (j["width"], j["height"]) == (640, 480) and j["unit"] == "mm", j
assert j["focal_source"] == "model" and j["focal_px"] == 555.5, j
d = np.asarray(Image.open(io.BytesIO(base64.b64decode(j["depth_png16_b64"]))))
assert d.dtype in (np.uint16, np.int32) and d.shape == (480, 640), (d.dtype, d.shape)
assert d[479, 639] == 2500 and d[1, 1] == 65535 and d[0, 0] == 0, (d[479, 639], d[1, 1], d[0, 0])
assert j["min_m"] == 2.5 and j["max_m"] == 70.0
s, j = call("POST", "/v1/depth", {"image_b64": PHOTO, "focal_px": 812})
assert s == 200 and j["focal_source"] == "given" and seen[-1][2] == 812.0, j
s, j = call("POST", "/v1/depth", {"image_b64": jpeg(exif35=26)})
assert s == 200 and j["focal_source"] == "exif", j
assert abs(seen[-1][2] - 26 * np.hypot(640, 480) / np.hypot(36, 24)) < 1e-6, seen[-1]
# A photo taken on its side is measured upright (EXIF orientation 6: 640 × 480 stored, 480 × 640 seen)
im = Image.new("RGB", (640, 480)); ex = Image.Exif(); ex[0x0112] = 6; b = io.BytesIO(); im.save(b, format="JPEG", exif=ex.tobytes())
s, j = call("POST", "/v1/depth", {"image_b64": base64.b64encode(b.getvalue()).decode()})
assert s == 200 and (j["width"], j["height"]) == (480, 640), j
for body, word in [({}, "image_b64"), ({"image_b64": base64.b64encode(b"nope").decode()}, "not an image"),
                   ({"image_b64": PHOTO, "focal_px": 0}, "focal_px"), ({"image_b64": PHOTO, "focal_px": "800"}, "focal_px"), ([], "object")]:
    s, j = call("POST", "/v1/depth", body)
    assert s == 400 and word in j["error"]["message"], (body if not isinstance(body, dict) else list(body), s, j)
assert call("POST", "/v1/depth", raw=b"{nope")[0] == 400
ok("depth: 16-bit PNG in millimetres (0 = none, clipped at 65.535 m), focal given / EXIF / the model's, upright, 400 says what")

# ── reconstruct: status flow and the geometry ────────────────────────────────────────────────────────────────────
PHOTOS = [jpeg(colour=(40 * i, 90, 60)) for i in range(3)]
# The door: two points 1.2 m apart on the wall, as seen in photo 1
R1, t1 = true_cam(1)
def project(X, R, t):
    c = R @ X + t
    return [float(KT[0, 0] * c[0] / c[2] + KT[0, 2]), float(KT[1, 1] * c[1] / c[2] + KT[1, 2])]
A, B = np.array([0.9, 0.3, 5.0]), np.array([2.1, 0.3, 5.0])
MEAS = {"photo": 1, "p1": project(A, R1, t1), "p2": project(B, R1, t1), "metres": 1.2}

gate.clear()
s, j = call("POST", "/v1/reconstruct", {"images_b64": PHOTOS, "known": {"one_measurement": MEAS}, "max_points": 20000})
assert s == 202 and j["status"] == "queued" and j["id"].startswith("recon_") and j["model"] == ms.RECON_MODEL, (s, j)
jid = j["id"]
r = wait_for(jid, {"running"})
assert r["photos"] == 3 and 0 <= r["progress"] < 1 and "result" not in r, r
gate.set()
done = wait_for(jid, {"succeeded"})
res = done["result"]
assert done["progress"] == 1.0 and "error" not in done
assert res["scale_source"] == "measurement" and abs(res["scale_factor"] - 1 / HALF) < 1e-3, (res["scale_source"], res["scale_factor"])
assert abs(res["measurement"]["model_metres"] - 0.6) < 0.01, res["measurement"]
for i, cam in enumerate(res["cameras"]):
    R, t = true_cam(i)
    assert (cam["width"], cam["height"]) == (640, 480)
    assert np.allclose(cam["K"], KT, atol=1e-3), (i, cam["K"])
    assert np.allclose(cam["R"], R, atol=1e-5), (i, cam["R"])
    assert np.allclose(cam["t"], t, atol=1e-3), (i, cam["t"], t)
    assert np.allclose(cam["position"], [1.5 * i, 0, 0], atol=1e-3)
# The PLY: header, count, every point on the wall at z = 5 m (metres, photo 0's frame), colours from the photos
ply = base64.b64decode(res["points"]["b64"])
head, body = ply.split(b"end_header\n", 1)
assert b"format binary_little_endian 1.0" in head and b"element vertex 20000" in head, head
rec = np.frombuffer(body, dtype=[("x", "<f4"), ("y", "<f4"), ("z", "<f4"), ("r", "u1"), ("g", "u1"), ("b", "u1"), ("c", "<f4"), ("p", "u1")])
assert len(rec) == 20000 == res["points"]["count"] and res["points"]["of"] == 3 * 160 * 108, res["points"]
assert np.allclose(rec["z"], 5.0, atol=1e-3), (rec["z"].min(), rec["z"].max())
assert set(np.unique(rec["p"])) == {0, 1, 2} and set(np.unique(rec["c"])) == {1.0, 2.0, 3.0}
assert abs(int(rec["r"][rec["p"] == 2].mean()) - 80) <= 3, rec["r"][rec["p"] == 2].mean()  # photo 2's red, through JPEG
assert res["confidence"]["per_photo"][0]["valid_fraction"] == round(108 / 112, 4)
assert seen[-1] == ("recon", 3, None)
ok("reconstruct: queued → running → succeeded; cameras back in the photos' pixels and photo 0's frame; one measurement sets metres; PLY on the wall")

# Without a measurement and not metric: says so; known intrinsics, one for all or one per photo, reach the model
s, j = call("POST", "/v1/reconstruct", {"images_b64": PHOTOS[:2], "known": {"intrinsics": KT.tolist()}})
res = wait_for(j["id"], {"succeeded"})["result"]
assert res["scale_source"] == "none" and any("no metric scale" in w for w in res["warnings"]), res["warnings"]
assert seen[-1][2] == [KT.tolist()] * 2, seen[-1]
s, j = call("POST", "/v1/reconstruct", {"images_b64": PHOTOS[:2], "known": {"intrinsics": [None, KT.tolist()]}})
assert s == 202 and wait_for(j["id"], {"succeeded"}) and seen[-1][2] == [None, KT.tolist()], seen[-1]
# A measurement whose points the model masked: the scale is not used, and the result says why
bad = dict(MEAS, photo=0, p1=[10.0, 2.0], p2=[300.0, 2.0])
s, j = call("POST", "/v1/reconstruct", {"images_b64": PHOTOS[:2], "known": {"one_measurement": bad}})
res = wait_for(j["id"], {"succeeded"})["result"]
assert res["scale_source"] == "none" and any("one_measurement" in w for w in res["warnings"]), res["warnings"]
ok("reconstruct: no scale is said, intrinsics pass on, a masked measurement is refused in warnings")

# ── cancel: queued and running ───────────────────────────────────────────────────────────────────────────────────
gate.clear()
_, a = call("POST", "/v1/reconstruct", {"images_b64": PHOTOS[:2]})
wait_for(a["id"], {"running"})
_, b = call("POST", "/v1/reconstruct", {"images_b64": PHOTOS[:2]})
s, c = call("POST", f"/v1/reconstruct/{b['id']}/cancel")
assert s == 200 and c == {"id": b["id"], "status": "cancelled"}, c
s, c = call("POST", f"/v1/reconstruct/{a['id']}/cancel")
assert s == 200 and c["status"] == "cancelled"
gate.set()
time.sleep(0.3)
ja = call("GET", f"/v1/reconstruct/{a['id']}")[1]
assert ja["status"] == "cancelled" and "result" not in ja, ja
assert call("GET", f"/v1/reconstruct/{b['id']}")[1]["status"] == "cancelled"
assert call("POST", "/v1/reconstruct/nope/cancel")[0] == 404
ok("cancel: a queued job never runs, a running one stops at its next stage and gives no result")

# ── a depth request waits for a running reconstruction, and is told busy past its wait ───────────────────────────
gate.clear()
_, a = call("POST", "/v1/reconstruct", {"images_b64": PHOTOS[:2]})
wait_for(a["id"], {"running"})
ms.DEPTH_WAIT_S = 0.2
s, j = call("POST", "/v1/depth", {"image_b64": PHOTO})
assert s == 503 and j["error"]["type"] == "busy", (s, j)
ms.DEPTH_WAIT_S = 10
threading.Timer(0.3, gate.set).start()
t0 = time.time()
s, j = call("POST", "/v1/depth", {"image_b64": PHOTO})
assert s == 200 and time.time() - t0 >= 0.25, (s, time.time() - t0)
assert call("GET", f"/v1/reconstruct/{a['id']}")[1]["status"] == "succeeded"
ok("one at a time: depth waits for a running reconstruction (503 busy past MUX_MEASURE_DEPTH_WAIT_S)")

# ── expiry ───────────────────────────────────────────────────────────────────────────────────────────────────────
ms.KEEP_S = 0.2
_, e = call("POST", "/v1/reconstruct", {"images_b64": PHOTOS[:2]})
wait_for(e["id"], {"succeeded"})
time.sleep(0.3)
assert call("GET", f"/v1/reconstruct/{e['id']}")[0] == 404
assert call("POST", f"/v1/reconstruct/{e['id']}/cancel")[0] == 404
ms.KEEP_S = 3600
ok("expiry: a finished reconstruction is gone (404) once it is past its keep")

# ── validation ───────────────────────────────────────────────────────────────────────────────────────────────────
K3 = KT.tolist()
bad = [
    ({"images_b64": PHOTOS[:1]}, "2 to 12"), ({"images_b64": [PHOTO] * 13}, "2 to 12"), ({"images_b64": "x"}, "images_b64"), ({}, "images_b64"),
    ({"images_b64": [PHOTO, base64.b64encode(b"nope").decode()]}, "images_b64[1]"),
    ({"images_b64": [PHOTO, 5]}, "images_b64[1]"),
    ({"images_b64": PHOTOS[:2], "max_points": 10}, "max_points"), ({"images_b64": PHOTOS[:2], "max_points": 5_000_000}, "max_points"),
    ({"images_b64": PHOTOS[:2], "known": []}, "known"), ({"images_b64": PHOTOS[:2], "known": {"poses": []}}, "poses"),
    ({"images_b64": PHOTOS[:2], "known": {"intrinsics": [[1, 2], [3, 4]]}}, "intrinsics"),
    ({"images_b64": PHOTOS[:2], "known": {"intrinsics": [K3, K3, K3]}}, "intrinsics"),
    ({"images_b64": PHOTOS[:2], "known": {"intrinsics": [[0, 0, 1], [0, 1, 1], [0, 0, 1]]}}, "fx"),
    ({"images_b64": PHOTOS[:2], "known": {"one_measurement": {**MEAS, "photo": 2}}}, "photo"),
    ({"images_b64": PHOTOS[:2], "known": {"one_measurement": {**MEAS, "p1": [700, 10]}}}, "outside"),
    ({"images_b64": PHOTOS[:2], "known": {"one_measurement": {**MEAS, "p2": MEAS["p1"]}}}, "apart"),
    ({"images_b64": PHOTOS[:2], "known": {"one_measurement": {**MEAS, "metres": 0}}}, "metres"),
    ({"images_b64": PHOTOS[:2], "known": {"one_measurement": {**MEAS, "metres": "1.2"}}}, "metres"),
    ({"images_b64": PHOTOS[:2], "known": {"one_measurement": "door"}}, "one_measurement"),
]
for body, word in bad:
    s, j = call("POST", "/v1/reconstruct", body)
    assert s == 400 and word in j["error"]["message"], (word, s, j)
assert call("POST", "/v1/reconstruct", raw=b"{nope")[0] == 400
assert call("GET", "/v1/reconstruct/recon_nope")[0] == 404
assert call("POST", "/v1/nothing", {})[0] == 404
ok("validation: 2–12 photos, max_points, known.intrinsics and one_measurement checked; 400 says what is wrong")

# ── body limits ──────────────────────────────────────────────────────────────────────────────────────────────────
assert ms.MAX_BODY == {"/v1/depth": 50 * 1024 * 1024, "/v1/reconstruct": 150 * 1024 * 1024}
saved = dict(ms.MAX_BODY)
ms.MAX_BODY.update({"/v1/depth": 1024, "/v1/reconstruct": 2048})
s, j = call("POST", "/v1/depth", raw=b"x" * 2048)
assert s == 413 and "MB" in j["error"]["message"], (s, j)
s, j = call("POST", "/v1/reconstruct", raw=b"x" * 4096)
assert s == 413, (s, j)
ms.MAX_BODY.update(saved)
assert ms.MAX_PIXELS == 50_000_000
ms.MAX_PIXELS = 100 * 100
s, j = call("POST", "/v1/depth", {"image_b64": PHOTO})
assert s == 400 and "megapixels" in j["error"]["message"], j
ms.MAX_PIXELS = 50_000_000
ok("body limits: depth 50 MB, reconstruct 150 MB, 50 megapixels a photo; more is 413 / 400")

# ── the queue is bounded ─────────────────────────────────────────────────────────────────────────────────────────
gate.clear()
outs = [call("POST", "/v1/reconstruct", {"images_b64": PHOTOS[:2]}) for _ in range(ms.MAX_QUEUE + 1)]
assert [s for s, _ in outs[:-1]] == [202] * ms.MAX_QUEUE and outs[-1][0] == 429, [s for s, _ in outs]
gate.set()
for s, j in outs[:-1]:
    wait_for(j["id"], {"succeeded"})
ok(f"queue: at most {ms.MAX_QUEUE} waiting or running, then 429")

# ── PNG16 and the crop helpers on their own ──────────────────────────────────────────────────────────────────────
crop, tf = ms.cover_crop(Image.new("RGB", (4032, 3024)), 518, 392)
assert crop.size == (518, 392)
K = [[3000.0, 0, 2016.0], [0, 3000.0, 1512.0], [0, 0, 1]]
assert np.allclose(ms.k_to_photo(ms.k_to_crop(K, tf), tf), K)
x, y = ms.to_crop(2016 - 0.5, 1512 - 0.5, tf)
assert abs(x - (518 / 2 - 0.5)) < 0.6 and abs(y - (392 / 2 - 0.5)) < 0.6, (x, y)
ok("crops: intrinsics go to the crop and back exactly; the photo's centre is the crop's")

# ── one device thread ────────────────────────────────────────────────────────────────────────────────────────────
assert len(device_threads) == 1, f"PyTorch work ran on {len(device_threads)} threads"
assert threading.get_ident() not in device_threads
s, j = call("GET", "/v1/models")
assert [(m["id"], m["route"], m["loaded"]) for m in j["data"]] == [(ms.DEPTH_MODEL, "depth", True), (ms.RECON_MODEL, "reconstruct", True)], j
ms.on_device(ms.let_go_model, "depth")
assert [m["loaded"] for m in call("GET", "/v1/models")[1]["data"]] == [False, True]
ok("one device thread: every load, inference and let-go ran on the same worker thread, never a request's")
print("all measure server tests passed")
os._exit(0)
