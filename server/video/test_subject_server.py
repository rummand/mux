"""The subject server (Phantom-Wan 1.3B) without its weights: job API, validation, the label, upstream's letterbox, and the
sampler's mechanics with a recording stand-in for the DiT.

Run: ~/.mux/video-venv/bin/python server/video/test_subject_server.py
With Phantom's checkout at MUX_SUBJECT_CODE (~/.mux/phantom) it also checks the letterbox against upstream's own
load_ref_images and uses upstream's scheduler; without it those parts are skipped or stubbed.
What it cannot prove: the pictures of the real model. That is deploy/video-subject.sh's 2 s test clip, on the Mac.
"""
import ast, base64, http.client, importlib.util, io, json, os, sys, tempfile, threading, time

here = os.path.dirname(os.path.abspath(__file__))
os.environ.setdefault("MUX_VIDEO_GPU_LOCK", os.path.join(tempfile.mkdtemp(prefix="mux-subject-test-"), "video-gpu.lock"))
spec = importlib.util.spec_from_file_location("subject_server", os.path.join(here, "subject_server.py"))
ss = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ss)
vs = ss.vs

import numpy as np
import torch
from PIL import Image

ok = lambda name: print(f"ok {name}", flush=True)


def png_b64(size, color=(200, 30, 40)):
    b = io.BytesIO(); Image.new("RGB", size, color).save(b, format="PNG"); return base64.b64encode(b.getvalue()).decode()


# ── the job API with a stub model ────────────────────────────────────────────────────────────────────────────────
seen = []
real_render = ss.render
vs.load_pipeline = lambda: object()


def fake_render(pipe, req, on_step):
    seen.append(req)
    w, h = vs.SIZES[req["size"]]
    for i in range(1, 4):
        on_step(i, 3)
    return np.full((req["frames"], h, w, 3), 90, dtype=np.uint8)


vs.render = fake_render
vs.encode_mp4 = lambda frames, fps, extra=(): b"\x00\x00\x00\x18ftypmp42" + json.dumps([len(frames), list(extra)]).encode()
server = ss.start(0)
port = server.server_address[1]
threading.Thread(target=server.serve_forever, daemon=True).start()


def call(method, path, body=None):
    c = http.client.HTTPConnection("127.0.0.1", port, timeout=10)
    c.request(method, path, body=json.dumps(body).encode() if body is not None else None, headers={"content-type": "application/json"})
    r = c.getresponse(); out = r.read(); c.close()
    try:
        return r.status, json.loads(out)
    except ValueError:
        return r.status, out


def wait(jid, limit=10):
    t = time.time()
    while time.time() - t < limit:
        s, j = call("GET", f"/v1/videos/{jid}")
        if j["status"] in ("succeeded", "failed", "cancelled"):
            return j
        time.sleep(0.02)
    raise AssertionError(j)


BASE = {"model": "video-subject", "prompt": "a mannequin walks across a studio", "seconds": 2, "fps": 16, "size": "832x480", "seed": 5,
        "reference_images_b64": [png_b64((300, 600)), png_b64((640, 640), (240, 196, 24))]}
s, j = call("POST", "/v1/videos/generations", BASE)
assert s == 202 and j["model"] == "phantom-wan-1.3b", (s, j)
done = wait(j["id"])
assert done["status"] == "succeeded" and done["model"] == "phantom-wan-1.3b" and "label_burned" not in done, done
r = seen[-1]
assert r["frames"] == 32 and len(r["refs"]) == 2 and r["steps"] == ss.STEPS == 30 and r["negative_prompt"] == ss.NEGATIVE and r["image"] is None and r["control"] is None
ok("job: 202 → succeeded under the model's own name; 2 s at 16 fps is 32 frames; two references; upstream's negative prompt by default; 30 steps")

s, j = call("POST", "/v1/videos/generations", {**BASE, "steps": 12, "negative_prompt": "blurry", "label": {"text": "AI-generated"}})
done = wait(j["id"])
assert done["label_burned"] is True and seen[-1]["steps"] == 12 and seen[-1]["negative_prompt"] == "blurry", (done, seen[-1]["steps"])
_, body = call("GET", f"/v1/videos/{j['id']}/content")
n, extra = json.loads(body[12:])
assert n == 32 and extra[:2] == ["-metadata", "comment=AI-generated"], (n, extra)
ok("the AI label as on video (label_burned, the mp4's metadata); steps and negative_prompt taken")

bad = [({"reference_images_b64": None}, "reference_images_b64"), ({"reference_images_b64": []}, "1 to 4"),
       ({"reference_images_b64": [png_b64((8, 8))] * 5}, "1 to 4"), ({"reference_images_b64": ["bm9wZQ=="]}, "reference_images_b64[0]"),
       ({"image_b64": png_b64((8, 8))}, "image_b64 is not taken"), ({"control": {"type": "depth"}}, "control is not taken"),
       ({"seconds": 6}, "1 to 5"), ({"steps": 5}, "steps"), ({"steps": 51}, "steps"), ({"model": "video-depth"}, "video-subject"),
       ({"size": "640x640"}, "size"), ({"prompt": ""}, "prompt"), ({"label": {"position": "middle"}}, "label.position")]
for patch, word in bad:
    s, j = call("POST", "/v1/videos/generations", {**BASE, **patch})
    assert s == 400 and word in j["error"]["message"], (patch, s, j)
ok("400 names what is wrong: references (1–4, pictures), no first frame or control, seconds 1–5, steps 10–50, model, size, prompt, label")

# ── upstream's letterbox ─────────────────────────────────────────────────────────────────────────────────────────
gen = os.path.join(ss.CODE, "generate.py")
if os.path.exists(gen):
    tree = ast.parse(open(gen).read())
    fn = next(n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name == "load_ref_images")
    ns = {"Image": Image, "ImageOps": __import__("PIL.ImageOps", fromlist=["x"])}
    exec(compile(ast.Module(body=[fn], type_ignores=[]), gen, "exec"), ns)
    tmp = tempfile.mkdtemp()
    for i, size in enumerate([(300, 600), (1200, 300), (832, 480), (500, 500)]):
        p = os.path.join(tmp, f"{i}.png")
        a = np.random.default_rng(i).integers(0, 255, (size[1], size[0], 3), dtype=np.uint8)
        Image.fromarray(a).save(p)
        want = np.asarray(ns["load_ref_images"](p, (832, 480))[0])
        got = np.asarray(ss.letterbox(Image.open(p), 832, 480))
        assert want.shape == got.shape and (want == got).all(), size
    ok("references letterboxed on white exactly as upstream's load_ref_images (tall, wide, exact, square)")
else:
    print(f"skip letterbox parity: no Phantom checkout at {ss.CODE}")

# ── the sampler's mechanics, with stand-ins for the DiT, the VAE and the text encoder ───────────────────────────
vs.DEVICE = "cpu"
calls = []


class DiT:
    def __call__(self, hidden_states, timestep, encoder_hidden_states, return_dict=False):
        calls.append((hidden_states.clone(), encoder_hidden_states[0, 0, 0].item()))
        # a "prediction" that depends on the context, so the guidance mix can be checked
        return (hidden_states.float() * 0 + encoder_hidden_states[0, 0, 0].float() + hidden_states.float().mean(),)


class Dist:
    def __init__(self, z):
        self.z = z

    def mode(self):
        return self.z


class VAE:
    dtype = torch.float32

    class config:
        z_dim = 16
        latents_mean = [0.0] * 16
        latents_std = [1.0] * 16

    def encode(self, x):   # [1, 3, 1, h, w] → [1, 16, 1, h/8, w/8]: a reference's own colour
        z = x.float().mean(dim=(1, 3, 4), keepdim=True).expand(1, 16, 1, x.shape[3] // 8, x.shape[4] // 8).clone()
        return type("E", (), {"latent_dist": Dist(z)})()

    def decode(self, z, return_dict=False):
        t = (z.shape[2] - 1) * 4 + 1
        return (torch.zeros(1, 3, t, z.shape[3] * 8, z.shape[4] * 8),)


class VP:
    @staticmethod
    def postprocess_video(video, output_type="np"):
        return video.permute(0, 2, 3, 4, 1).numpy() * 0 + 0.5


class Pipe:
    transformer = DiT()
    vae = VAE()
    video_processor = VP()

    def encode_prompt(self, prompt, negative, **kw):
        return torch.full((1, 512, 4096), 2.0, dtype=torch.bfloat16), torch.full((1, 512, 4096), 1.0, dtype=torch.bfloat16)


if not os.path.exists(os.path.join(ss.CODE, "phantom_wan")):
    from diffusers.schedulers.scheduling_unipc_multistep import UniPCMultistepScheduler

    def stub_scheduler(steps, device):
        sc = UniPCMultistepScheduler(prediction_type="flow_prediction", use_flow_sigmas=True, flow_shift=ss.SHIFT)
        sc.set_timesteps(steps, device=device)
        return sc
    ss.upstream_scheduler = stub_scheduler
req = ss.validate({**BASE, "steps": 10, "seconds": 1, "fps": 8, "reference_images_b64": [png_b64((64, 64), (255, 255, 255)), png_b64((64, 64), (0, 0, 0))]})
steps_seen = []
frames = real_render(Pipe(), req, lambda i, n: steps_seen.append((i, n)))
assert frames.shape == (8, 480, 832, 3) and frames.dtype == np.uint8, frames.shape
assert steps_seen == [(i, 10) for i in range(1, 11)], steps_seen
assert len(calls) == 30, len(calls)
white = (np.asarray(ss.letterbox(Image.new("RGB", (64, 64), (255, 255, 255)), 832, 480), np.float32) / 127.5 - 1).mean()
black = (np.asarray(ss.letterbox(Image.new("RGB", (64, 64), (0, 0, 0)), 832, 480), np.float32) / 127.5 - 1).mean()
for k, (x, c) in enumerate(calls):
    assert x.shape[2] == 3 + 2, x.shape   # 9 frames → 3 latent frames, then the two references
    assert x.dtype == torch.bfloat16
    which = k % 3
    assert c == (2.0 if which == 0 else 1.0), (k, c)   # text+pictures, pictures alone, neither
    if which < 2:   # the references, clean, at the end, every step
        assert abs(x[0, 0, 3].float().mean().item() - white) < 1e-2 and abs(x[0, 0, 4].float().mean().item() - black) < 1e-2, k
    else:
        assert x[0, :, 3:].abs().max().item() == 0, k
    if k >= 3:
        assert torch.equal(calls[k - (k % 3)][0][:, :, :3], x[:, :, :3])   # the three forwards of a step see the same clip latents
ok("sampler: 3 forwards a step (text+pictures, pictures, neither: zeros for the pictures), references clean after the clip's latent frames at every step, bf16 in, the references dropped before decoding")
if os.path.exists(os.path.join(ss.CODE, "phantom_wan")):
    sc = ss.upstream_scheduler(30, "cpu")
    assert len(sc.timesteps) == 30 and sc.sigmas[0].item() > 0.99 and sc.sigmas[-1].item() == 0 and (sc.sigmas[1:] <= sc.sigmas[:-1]).all()
    ok("upstream's FlowUniPCMultistepScheduler from the checkout, 30 steps at shift 5")
print("all subject server tests passed", flush=True)
os._exit(0)
