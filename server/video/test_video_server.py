"""The video server's job API with a stub model: no torch, no diffusers, no Mac.

Run: python3 server/video/test_video_server.py   (needs numpy and Pillow, as the server does)
What it cannot prove: that Wan2.1-VACE-1.3B loads and renders on MPS. That is deploy/video.sh's test clip, on the Mac.
"""
import base64, http.client, importlib.util, io, json, os, sys, tempfile, threading, time, zipfile

here = os.path.dirname(os.path.abspath(__file__))
os.environ.setdefault("MUX_VIDEO_GPU_LOCK", os.path.join(tempfile.mkdtemp(prefix="mux-video-test-"), "video-gpu.lock"))
spec = importlib.util.spec_from_file_location("video_server", os.path.join(here, "video_server.py"))
vs = importlib.util.module_from_spec(spec)
spec.loader.exec_module(vs)

import numpy as np
from PIL import Image

# ── the stub model ───────────────────────────────────────────────────────────────────────────────────────────────
device_threads = set()
gate = threading.Event()   # render waits here until the test lets it go
gate.set()
seen = []                  # what render was given


def fake_load():
    device_threads.add(threading.get_ident())
    return object()


def fake_render(pipe, req, on_step):
    device_threads.add(threading.get_ident())
    seen.append(req)
    w, h = vs.SIZES[req["size"]]
    on_step(0, 4)
    while not gate.wait(0.02):
        on_step(0, 4)  # a real step would come now and then: a cancel is seen here
    for i in range(1, 5):
        on_step(i, 4)
        time.sleep(0.01)
    return np.zeros((req["frames"], h, w, 3), dtype=np.uint8)


encoded = []               # what encode_mp4 was given: (frames, extra ffmpeg options)


def fake_encode(frames, fps, extra=()):
    device_threads.add(threading.get_ident())
    encoded.append((frames, list(extra)))
    return b"\x00\x00\x00\x18ftypmp42" + f"{len(frames)}@{fps}".encode()


real_encode = vs.encode_mp4
vs.load_pipeline, vs.render, vs.encode_mp4 = fake_load, fake_render, fake_encode
server = vs.start(0)
port = server.server_address[1]
threading.Thread(target=server.serve_forever, daemon=True).start()


def call(method, path, body=None, raw=None):
    c = http.client.HTTPConnection("127.0.0.1", port, timeout=10)
    data = raw if raw is not None else (json.dumps(body).encode() if body is not None else None)
    c.request(method, path, body=data, headers={"content-type": "application/json"} if data is not None else {})
    r = c.getresponse()
    out = r.read()
    c.close()
    try:
        return r.status, json.loads(out), r.getheader("content-type")
    except ValueError:
        return r.status, out, r.getheader("content-type")


def wait_for(job_id, statuses, limit=5.0):
    t = time.time()
    while time.time() - t < limit:
        s, j, _ = call("GET", f"/v1/videos/{job_id}")
        if j["status"] in statuses:
            return j
        time.sleep(0.02)
    raise AssertionError(f"{job_id} never reached {statuses}: {j}")


def png16_zip(frames, size=(64, 36)):
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        for i, d in enumerate(frames):
            arr = np.full((size[1], size[0]), d, dtype=np.uint16)
            arr[:, : size[0] // 2] = d * 2  # the left half twice as far
            im = Image.fromarray(arr)
            b = io.BytesIO()
            im.save(b, format="PNG")
            z.writestr(f"depth_{i:04d}.png", b.getvalue())
    return base64.b64encode(buf.getvalue()).decode()


BASE = {"model": "video", "prompt": "a street at dusk", "seconds": 2, "fps": 8, "size": "832x480", "seed": 3}
ok = lambda name: print(f"ok {name}")


# ── status flow ──────────────────────────────────────────────────────────────────────────────────────────────────
gate.clear()
s, j, _ = call("POST", "/v1/videos/generations", BASE)
assert s == 202 and j["status"] == "queued" and j["model"] == vs.MODEL and j["id"].startswith("video_"), (s, j)
jid = j["id"]
running = wait_for(jid, {"running"})
assert running["seconds"] == 2 and running["size"] == "832x480" and 0 <= running["progress"] < 1
s, j, _ = call("GET", f"/v1/videos/{jid}/content")
assert s == 409, (s, j)
gate.set()
done = wait_for(jid, {"succeeded"})
assert done["progress"] == 1.0 and "error" not in done
s, body, ctype = call("GET", f"/v1/videos/{jid}/content")
assert s == 200 and ctype == "video/mp4" and body.endswith(b"16@8"), (s, body)  # 2 s × 8 fps
assert seen[-1]["frames"] == 16 and seen[-1]["seed"] == 3 and seen[-1]["control"] is None and seen[-1]["steps"] == vs.STEPS["832x480"]
assert vs.frames_for(16) == 17 and vs.frames_for(17) == 17 and vs.frames_for(81) == 81
ok("status flow: queued → running → succeeded, content as video/mp4")

# ── cancel: queued and running ───────────────────────────────────────────────────────────────────────────────────
gate.clear()
_, a, _ = call("POST", "/v1/videos/generations", BASE)
wait_for(a["id"], {"running"})
_, b, _ = call("POST", "/v1/videos/generations", BASE)
s, c, _ = call("POST", f"/v1/videos/{b['id']}/cancel")
assert s == 200 and c == {"id": b["id"], "status": "cancelled"}, c
s, c, _ = call("POST", f"/v1/videos/{a['id']}/cancel")
assert s == 200 and c["status"] == "cancelled"
gate.set()
time.sleep(0.3)
assert call("GET", f"/v1/videos/{a['id']}")[1]["status"] == "cancelled"
assert call("GET", f"/v1/videos/{a['id']}/content")[0] == 409
assert call("GET", f"/v1/videos/{b['id']}")[1]["status"] == "cancelled"
assert call("POST", "/v1/videos/nope/cancel")[0] == 404
ok("cancel: a queued job never runs, a running one stops at its next step and gives no content")

# ── expiry ───────────────────────────────────────────────────────────────────────────────────────────────────────
vs.KEEP_S = 0.2
_, e, _ = call("POST", "/v1/videos/generations", BASE)
wait_for(e["id"], {"succeeded"})
time.sleep(0.3)
assert call("GET", f"/v1/videos/{e['id']}")[0] == 404
assert call("GET", f"/v1/videos/{e['id']}/content")[0] == 404
vs.KEEP_S = 3600
ok("expiry: a finished video is gone (404) once it is past its keep")

# ── validation ───────────────────────────────────────────────────────────────────────────────────────────────────
bad = [
    ({"seconds": 0}, "seconds"), ({"seconds": 11}, "seconds"), ({"seconds": "5"}, "seconds"),
    ({"fps": 7}, "fps"), ({"fps": 25}, "fps"), ({"fps": 12.5}, "fps"),
    ({"size": "1920x1080"}, "size"), ({"size": None}, "size"),
    ({"prompt": ""}, "prompt"), ({"model": "sora-2"}, "model"),
    ({"model": "video-depth"}, "control"),
    ({"control": {"type": "pose", "format": "mp4", "video_b64": "AA=="}}, "control.type"),
    ({"control": {"type": "depth", "format": "exr", "video_b64": "AA=="}}, "control.format"),
    ({"control": {"type": "depth", "format": "png16-zip"}}, "video_b64"),
    ({"control": {"type": "depth", "format": "png16-zip", "video_b64": base64.b64encode(b"not a zip").decode()}}, "zip"),
    ({"image_b64": base64.b64encode(b"not an image").decode()}, "image_b64"),
    ({"seed": -1}, "seed"),
]
for patch, word in bad:
    s, j, _ = call("POST", "/v1/videos/generations", {**BASE, **patch})
    assert s == 400 and word in j["error"]["message"], (patch, s, j)
assert call("POST", "/v1/videos/generations", raw=b"{nope")[0] == 400
# An 8-bit PNG in a 16-bit zip
buf = io.BytesIO()
with zipfile.ZipFile(buf, "w") as z:
    b8 = io.BytesIO(); Image.new("L", (8, 8)).save(b8, format="PNG"); z.writestr("0.png", b8.getvalue())
s, j, _ = call("POST", "/v1/videos/generations", {**BASE, "control": {"type": "depth", "format": "png16-zip", "video_b64": base64.b64encode(buf.getvalue()).decode()}})
assert s == 400 and "16-bit" in j["error"]["message"], j
for size in ("832x480", "1280x720"):
    for secs, fps in ((1, 8), (10, 24)):
        s, j, _ = call("POST", "/v1/videos/generations", {**BASE, "size": size, "seconds": secs, "fps": fps})
        assert s == 202, (size, secs, fps, j)
        wait_for(j["id"], {"succeeded"})
assert seen[-1]["frames"] == 240 and seen[-1]["steps"] == vs.STEPS["1280x720"]
ok("validation: seconds 1–10, fps 8–24, the two sizes, control and image checked; 400 says what is wrong")

# ── a depth pass as 16-bit PNGs, and a first frame ───────────────────────────────────────────────────────────────
img = io.BytesIO(); Image.new("RGB", (1000, 1000), (200, 10, 10)).save(img, format="JPEG")
s, j, _ = call("POST", "/v1/videos/generations", {**BASE, "model": "video-depth", "image_b64": base64.b64encode(img.getvalue()).decode(),
                                                  "control": {"type": "depth", "format": "png16-zip", "video_b64": png16_zip([1000, 1000, 2000])}})
assert s == 202, j
wait_for(j["id"], {"succeeded"})
r = seen[-1]
assert r["control"].shape == (16, 480, 832) and r["control"].dtype == np.uint8, r["control"].shape
near, far = int(r["control"][0, 0, -1]), int(r["control"][0, 0, 0])
assert near > far, (near, far)  # disparity: the nearer right half is brighter
assert r["image"].size == (832, 480)
ok("depth: 16-bit PNG frames become one clip-wide disparity, near bright, at the asked size; a first frame is cropped to fill")

# ── the AI label (Thread's Studio Cast asks for it on a take with a real person) ───────────────────────────────
LABEL = {"text": "AI-generated", "position": "bottom-right", "every_frame": True, "metadata": "AI generated by Thread · shows a real person, with recorded consent"}
s, j, _ = call("POST", "/v1/videos/generations", {**BASE, "label": LABEL})
assert s == 202, j
done = wait_for(j["id"], {"succeeded"})
assert done["label_burned"] is True, done
frames, extra = encoded[-1]
assert extra == ["-metadata", "comment=" + LABEL["metadata"], "-metadata", "description=" + LABEL["metadata"]], extra
b = vs.label_box(832, 480, "bottom-right", lambda f: vs._label_font(f).getlength("AI-generated"))
assert b["x"] + b["w"] < 832 and b["y"] + b["h"] < 480 and b["x"] > 416 and b["y"] > 240 and b["font"] == 16, b
for f in frames:   # the stub's frames are black: the pill's rim and words are bright, nothing outside it changed
    box = f[b["y"]:b["y"] + b["h"], b["x"]:b["x"] + b["w"]]
    assert box.max() > 200 and (box[..., 0] > 200).sum() > 50, box.max()
    assert f.sum() == box.astype(np.int64).sum()
assert (frames[0] == frames[-1]).all()
yellow = frames[0][b["y"] + b["h"] // 2, b["x"] + b["pad"] + round(b["font"] * 0.4)]
assert yellow[0] > 200 and yellow[1] > 150 and yellow[2] < 80, yellow   # the spark
_, plain, _ = call("POST", "/v1/videos/generations", BASE)
assert "label_burned" not in wait_for(plain["id"], {"succeeded"}) and encoded[-1][1] == [] and encoded[-1][0].max() == 0
for pos in vs.LABEL_POSITIONS:
    bb = vs.label_box(1280, 720, pos, lambda f: 100)
    assert (bb["x"] < 640) == pos.endswith("left") and (bb["y"] < 360) == pos.startswith("top"), (pos, bb)
for patch, word in [({"label": "yes"}, "label must be an object"), ({"label": {"position": "centre"}}, "label.position"),
                    ({"label": {"every_frame": False}}, "every_frame"), ({"label": {"text": ""}}, "label.text"),
                    ({"label": {"metadata": 3}}, "label.metadata")]:
    s, j, _ = call("POST", "/v1/videos/generations", {**BASE, **patch})
    assert s == 400 and word in j["error"]["message"], (patch, s, j)
vs.Labeller(64, 36, vs.read_label(True))(np.zeros((36, 64, 3), np.uint8))   # a tiny frame: the pill fits inside
ok("AI label: in every frame (bottom-right pill, white words, yellow spark; nothing else touched), the words in the mp4's metadata, label_burned true; not asked, nothing changes; bad label 400")

# ── reference images (VACE's subject references) ────────────────────────────────────────────────────────────────
def png_b64(size, mode="RGB", color=(10, 200, 10)):
    b = io.BytesIO(); Image.new(mode, size, color).save(b, format="PNG"); return base64.b64encode(b.getvalue()).decode()

assert seen[-1]["refs"] is None  # backward compatible: none asked, none given
clear = io.BytesIO(); Image.new("RGBA", (40, 80), (0, 0, 0, 0)).save(clear, format="PNG")
s, j, _ = call("POST", "/v1/videos/generations", {**BASE, "reference_images_b64": [png_b64((3000, 1500)), "data:image/png;base64," + base64.b64encode(clear.getvalue()).decode()]})
assert s == 202, j
wait_for(j["id"], {"succeeded"})
refs = seen[-1]["refs"]
assert len(refs) == 2 and refs[0].mode == "RGB" and max(refs[0].size) == 1280 and refs[0].size == (1280, 640), refs[0].size
assert refs[1].size == (40, 80) and refs[1].getpixel((5, 5)) == (255, 255, 255)  # transparency → white
for patch, word in [({"reference_images_b64": []}, "reference_images_b64"), ({"reference_images_b64": [png_b64((8, 8))] * 4}, "1 to 3"),
                    ({"reference_images_b64": "AA=="}, "list"), ({"reference_images_b64": [base64.b64encode(b"nope").decode()]}, "reference_images_b64[0]")]:
    s, j, _ = call("POST", "/v1/videos/generations", {**BASE, **patch})
    assert s == 400 and word in j["error"]["message"], (patch, s, j)
ok("reference images: 1–3, alpha on white, long side at most 1280 px; 400 names the bad one; absent is as before")

# ── body limit ───────────────────────────────────────────────────────────────────────────────────────────────────
assert vs.MAX_BODY == 200 * 1024 * 1024
vs.MAX_BODY = 1024
s, j, _ = call("POST", "/v1/videos/generations", raw=b"x" * 2048)
assert s == 413 and "MB" in j["error"]["message"], (s, j)
vs.MAX_BODY = 200 * 1024 * 1024
ok("body limit: 200 MB; more is 413")

# ── the queue is bounded ─────────────────────────────────────────────────────────────────────────────────────────
gate.clear()
ids = []
for i in range(vs.MAX_QUEUE + 1):
    s, j, _ = call("POST", "/v1/videos/generations", BASE)
    ids.append((s, j))
assert [s for s, _ in ids[:-1]] == [202] * vs.MAX_QUEUE and ids[-1][0] == 429, [s for s, _ in ids]
gate.set()
for s, j in ids[:-1]:
    wait_for(j["id"], {"succeeded"})
ok(f"queue: at most {vs.MAX_QUEUE} waiting or running, then 429")

# ── real ffmpeg, where there is one: an mp4 out, and an mp4 depth pass in ────────────────────────────────────────
try:
    vs.ffmpeg()
    have_ffmpeg = True
except RuntimeError:
    have_ffmpeg = False
if have_ffmpeg:
    ramp = np.tile(np.linspace(0, 255, 64, dtype=np.uint8)[None, None, :, None], (9, 32, 1, 3))
    mp4 = real_encode(ramp, 8)
    assert mp4[4:8] == b"ftyp", mp4[:12]
    depth = vs.depth_from_mp4(mp4, 832, 480, 16)
    assert depth.shape == (16, 480, 832) and depth[0, 240, 800] > depth[0, 240, 30] + 150, depth[0, 240, ::200]
    s, j, _ = call("POST", "/v1/videos/generations", {**BASE, "model": "video-depth", "control": {"type": "depth", "format": "mp4", "video_b64": base64.b64encode(mp4).decode()}})
    assert s == 202, j
    wait_for(j["id"], {"succeeded"})
    s, j, _ = call("POST", "/v1/videos/generations", {**BASE, "control": {"type": "depth", "format": "mp4", "video_b64": base64.b64encode(b"junk").decode()}})
    assert s == 400 and "mp4" in j["error"]["message"], j
    ok("ffmpeg: frames encode to H.264 mp4; an mp4 depth pass decodes to grey frames at the asked size")
else:
    print("skip ffmpeg: not installed here")

# ── one device thread ────────────────────────────────────────────────────────────────────────────────────────────
assert len(device_threads) == 1, f"PyTorch work ran on {len(device_threads)} threads"
assert threading.get_ident() not in device_threads
s, j, _ = call("GET", "/v1/models")
assert j["data"][0]["loaded"] is True
vs.on_device(vs.let_go)
assert call("GET", "/v1/models")[1]["data"][0]["loaded"] is False
ok("one device thread: every load, render and let-go ran on the same worker thread, never a request's")
# ── the VAE's causal conv3d as conv2d over its time taps (MPS memory), against diffusers' own forward ─────────────
try:
    import torch
    from diffusers.models.autoencoders.autoencoder_kl_wan import WanCausalConv3d
    have_diffusers = True
except Exception:  # noqa: BLE001
    have_diffusers = False
if have_diffusers:
    torch.manual_seed(0)
    native = WanCausalConv3d.forward
    shapes = [((3, 3, 3), 1, (1, 1, 1), 5, 2), ((3, 1, 1), 1, (1, 0, 0), 4, 2), ((3, 1, 1), (2, 1, 1), (0, 0, 0), 5, None),
              (1, 1, 0, 3, None), ((3, 3, 3), 1, (1, 1, 1), 1, 2), ((3, 3, 3), 1, (1, 1, 1), 4, 1), ((3, 3, 3), 1, (1, 1, 1), 2, None)]
    for ks, st, pad, t, cache in shapes:
        conv = WanCausalConv3d(6, 5, ks, stride=st, padding=pad)
        x = torch.randn(1, 6, t, 10, 12)
        cx = torch.randn(1, 6, cache, 10, 12) if cache else None
        want = native(conv, x, cx)
        got = vs.conv3d_by_frames(conv, x, cx)
        assert got.shape == want.shape and torch.allclose(got, want, atol=1e-5), (ks, st, pad, t, cache, got.shape, want.shape, (got - want).abs().max())
    vs.use_conv3d_by_frames()
    from diffusers.models.autoencoders import autoencoder_kl_wan as akw
    assert akw.WanCausalConv3d.forward is vs.conv3d_by_frames and vs._CONV3D_FORWARD == [native]
    vs.use_conv3d_by_frames()
    assert vs._CONV3D_FORWARD == [native]
    from diffusers import AutoencoderKLWan
    vae = AutoencoderKLWan(base_dim=16, z_dim=4, dim_mult=[1, 2, 2], num_res_blocks=1, temperal_downsample=[False, True],
                           latents_mean=[0] * 4, latents_std=[1] * 4).eval()
    clip = torch.randn(1, 3, 9, 32, 48)
    with torch.no_grad():
        z1 = vae.encode(clip).latent_dist.mode(); d1 = vae.decode(z1).sample   # by frames (patched above)
        akw.WanCausalConv3d.forward = native
        z0 = vae.encode(clip).latent_dist.mode(); d0 = vae.decode(z0).sample
    assert (z1 - z0).abs().max() < 1e-4 and (d1 - d0).abs().max() < 1e-4, ((z1 - z0).abs().max(), (d1 - d0).abs().max())
    ok("VAE conv3d by frames: equal to diffusers' WanCausalConv3d (3x3x3, time-only, strided, 1x1x1; with and without cached frames); a whole tiny Wan VAE encodes and decodes the same")
else:
    print("skip conv3d parity: no diffusers here")
print("all video server tests passed")
os._exit(0)
