"""Make one real backdrop and check it: the first proof that the panorama and depth models run on this Mac.

deploy/backdrop.sh runs it through this Mac's mux (so mux makes room for it, as it would for Thread):
  python try_backdrop.py --base http://127.0.0.1:7070/v1 --key-file KEY --out ~/.mux/logs [--image]
It prints the time it took, the lowest memory macOS had free while it ran, and the meta; it writes the three files
(backdrop-test-panorama.png, -depth.png, -dome.glb) to --out. With --image it then makes a second backdrop from a crop
of the first panorama (no photo of anyone), through FLUX.1-Fill-dev. Exit 1 if anything is wrong.
"""
import argparse, base64, importlib.util, io, json, os, subprocess, sys, threading, time, urllib.error, urllib.request

import numpy as np
from PIL import Image

here = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location("dome", os.path.join(here, "dome.py"))
dome = importlib.util.module_from_spec(spec)
spec.loader.exec_module(dome)

PROMPT = "A quiet harbour town on a rocky coast at golden hour, fishing boats, low hills behind, calm sea, clear sky"


def free_gb():
    try:
        out = subprocess.run(["vm_stat"], capture_output=True, text=True, timeout=5).stdout
        page = int(out.split("page size of ")[1].split()[0])
        pages = {k.strip(): int(v.strip().rstrip(".")) for k, v in (ln.split(":", 1) for ln in out.splitlines()[1:] if ":" in ln)}
        return sum(pages.get(k, 0) for k in ("Pages free", "Pages inactive", "Pages purgeable", "Pages speculative")) * page / 1024**3
    except Exception:  # noqa: BLE001
        return None


def call(base, key, method, path, body=None, timeout=60):
    req = urllib.request.Request(base + path, method=method, data=json.dumps(body).encode() if body is not None else None,
                                 headers={"content-type": "application/json", **({"authorization": f"Bearer {key}"} if key else {})})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, r.read(), r.headers.get("content-type")
    except urllib.error.HTTPError as e:
        return e.code, e.read(), e.headers.get("content-type")


def make(base, key, out, name, body):
    lowest = [free_gb()]
    done = threading.Event()

    def watch():
        while not done.wait(2):
            f = free_gb()
            if f is not None and (lowest[0] is None or f < lowest[0]):
                lowest[0] = f

    threading.Thread(target=watch, daemon=True).start()
    t0 = time.time()
    s, b, _ = call(base, key, "POST", "/backdrops", body)
    if s != 202:
        done.set()
        raise SystemExit(f"✗ POST /backdrops: {s} {b[:400].decode('utf-8', 'replace')}")
    job = json.loads(b)
    assert job["model"] == "backdrop" and job["status"] == "queued", job
    last = ""
    while True:
        s, b, _ = call(base, key, "GET", f"/backdrops/{job['id']}")
        j = json.loads(b)
        if j["status"] in ("succeeded", "failed", "cancelled"):
            break
        line = f"  {j['status']} {round(j['progress'] * 100)}%"
        if line != last:
            print(f"{line}, {time.time() - t0:.0f} s", flush=True)
            last = line
        if time.time() - t0 > 3 * 3600:
            raise SystemExit("✗ not done after three hours")
        time.sleep(10)
    took = time.time() - t0
    done.set()
    if j["status"] != "succeeded":
        raise SystemExit(f"✗ the backdrop {j['status']}: {j.get('error')}")
    files = {}
    for f, ctype in (("panorama", "image/png"), ("depth", "image/png"), ("dome", "model/gltf-binary")):
        s, data, got = call(base, key, "GET", f"/backdrops/{job['id']}/{f}", timeout=300)
        assert s == 200 and got == ctype, (f, s, got)
        files[f] = data
        ext = "glb" if f == "dome" else "png"
        with open(os.path.join(out, f"{name}-{f}.{ext}"), "wb") as fh:
            fh.write(data)
    pano = Image.open(io.BytesIO(files["panorama"]))
    assert pano.size == (1920, 960), pano.size
    depth = Image.open(io.BytesIO(files["depth"]))
    assert depth.size == (1920, 960) and depth.mode in ("I;16", "I;16B", "I;16L", "I"), depth.mode
    d = np.asarray(depth)
    sky = float((d == 0).mean())
    doc, binary = dome.read_glb(files["dome"])
    prim = doc["meshes"][0]["primitives"][0]
    pos = dome.accessor(doc, binary, prim["attributes"]["POSITION"])
    assert pos[:, 1].min() >= -1.6 - 1e-4, pos[:, 1].min()
    eq = np.abs(pos[:, 1]) < 0.05
    horizon = float(np.median(np.hypot(pos[eq, 0], pos[eq, 2]))) if eq.any() else float("nan")
    # The seam: the panorama's left and right edges should meet (HunyuanWorld blends them)
    rgb = np.asarray(pano.convert("RGB")).astype(np.float64)
    seam = float(np.abs(rgb[:, 0] - rgb[:, -1]).mean())
    inner = float(np.abs(rgb[:, 959] - rgb[:, 960]).mean())
    free = f"{lowest[0]:.0f} GB" if lowest[0] is not None else "unknown"
    print(f"  {name}: {took:.0f} s (with any loading), lowest free memory {free}; meta {j.get('meta')}; "
          f"sky {sky:.0%} of the depth; dome {len(pos)} vertices, {len(files['dome']) // 1024} kB, horizon ring {horizon:.1f} units; "
          f"seam step {seam:.1f} (a column step inside: {inner:.1f})", flush=True)
    return pano


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", required=True)
    ap.add_argument("--key-file")
    ap.add_argument("--out", required=True)
    ap.add_argument("--image", action="store_true")
    a = ap.parse_args()
    key = open(a.key_file).read().strip() if a.key_file else ""
    os.makedirs(a.out, exist_ok=True)
    pano = make(a.base.rstrip("/"), key, a.out, "backdrop-test", {"prompt": PROMPT, "seed": 7, "size": "1920x960"})
    if a.image:
        crop = pano.crop((720, 240, 1200, 600))  # the middle of the first panorama: a 480 × 360 "photo"
        buf = io.BytesIO()
        crop.save(buf, format="JPEG", quality=92)
        make(a.base.rstrip("/"), key, a.out, "backdrop-test-image",
             {"prompt": "the same harbour town, all around", "seed": 7, "image_b64": base64.b64encode(buf.getvalue()).decode()})
    print("✓ backdrop test passed", flush=True)


if __name__ == "__main__":
    main()
