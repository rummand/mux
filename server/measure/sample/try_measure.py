"""Try the measure server (or mux in front of it) on the sample house, and say how close it came, with the time.

  python3 try_measure.py [--base http://127.0.0.1:8314/v1] [--key-file FILE] [--out DIR] [--depth-only]

With --key-file the key is read from the file and sent as a bearer token; it is never printed. Writes the depth PNG and
the point cloud to --out (default ~/.mux/logs) as measure-test-depth.png and measure-test.ply. Needs numpy and Pillow
(the measure venv has both). The truth is in truth.json beside this file (render_sample.py made both).
"""
import argparse, base64, io, json, math, os, sys, time, urllib.error, urllib.request

import numpy as np
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", default="http://127.0.0.1:8314/v1")
    ap.add_argument("--key-file")
    ap.add_argument("--out", default=os.path.expanduser("~/.mux/logs"))
    ap.add_argument("--depth-only", action="store_true")
    ap.add_argument("--timeout-min", type=float, default=30)
    a = ap.parse_args()
    headers = {"content-type": "application/json"}
    if a.key_file:
        with open(a.key_file) as f:
            headers["authorization"] = "Bearer " + f.read().strip()
    os.makedirs(a.out, exist_ok=True)
    truth = json.load(open(os.path.join(HERE, "truth.json")))
    photos = [base64.b64encode(open(os.path.join(HERE, c["file"]), "rb").read()).decode() for c in truth["cameras"]]

    def call(method, path, body=None, timeout=900):
        req = urllib.request.Request(a.base.rstrip("/") + path, method=method, headers=headers,
                                     data=json.dumps(body).encode() if body is not None else None)
        try:
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return r.status, json.load(r)
        except urllib.error.HTTPError as e:
            try:
                return e.code, json.load(e)
            except ValueError:
                return e.code, {"error": {"message": f"HTTP {e.code}"}}

    failed = False
    # ── depth on the straight photo: the wall straight ahead is centre_depth_m away ──
    cam = truth["cameras"][1]
    t0 = time.time()
    s, j = call("POST", "/depth", {"image_b64": photos[1]})
    secs = time.time() - t0
    if s != 200:
        print(f"✗ depth: HTTP {s} {j.get('error', {}).get('message', '')}")
        return 1
    d = np.asarray(Image.open(io.BytesIO(base64.b64decode(j["depth_png16_b64"])))).astype(np.float64) / 1000
    open(os.path.join(a.out, "measure-test-depth.png"), "wb").write(base64.b64decode(j["depth_png16_b64"]))
    h, w = d.shape
    centre = float(np.median(d[h // 2 - 4:h // 2 + 5, w // 2 - 4:w // 2 + 5]))
    want, f_true = cam["centre_depth_m"], truth["K"][0][0]
    err = abs(centre - want) / want
    print(f"  depth ({j['model']}): {secs:.1f} s (with the load if it was cold) · the wall ahead {centre:.2f} m, truly {want:.2f} m "
          f"({err * 100:.0f} % off) · focal {j['focal_px']:.0f} px ({j['focal_source']}), truly {f_true:.0f} px")
    if err > 0.35:
        print("  ! more than 35 % off on a rendered scene: look at the depth PNG before trusting it")
    if a.depth_only:
        return 0

    # ── reconstruction from the three photos, with the door's width as the one measurement ──
    def reconstruct(known, label):
        t0 = time.time()
        s, j = call("POST", "/reconstruct", {"images_b64": photos, "known": known, "max_points": 200000})
        if s != 202:
            print(f"✗ reconstruct ({label}): HTTP {s} {j.get('error', {}).get('message', '')}")
            return None
        jid = j["id"]
        while True:
            s, j = call("GET", f"/reconstruct/{jid}", timeout=300)
            if s != 200:
                print(f"✗ reconstruct ({label}): HTTP {s} {j.get('error', {}).get('message', '')}")
                return None
            if j["status"] == "succeeded":
                break
            if j["status"] in ("failed", "cancelled"):
                print(f"✗ reconstruct ({label}): {j['status']} {j.get('error', {}).get('message', '')}")
                return None
            if time.time() - t0 > a.timeout_min * 60:
                call("POST", f"/reconstruct/{jid}/cancel")
                print(f"✗ reconstruct ({label}): not done after {a.timeout_min:g} min")
                return None
            time.sleep(3)
        res = j["result"]
        p = [np.array(c["position"]) for c in res["cameras"]]
        base = float(np.linalg.norm(p[1] - p[0]))
        print(f"  reconstruct ({j['model']}, {label}): {time.time() - t0:.1f} s (with the load if it was cold) · scale {res['scale_source']}"
              f" · camera 1 to 2 {base:.2f} m, truly {truth['baseline_1_2_m']:.2f} m ({abs(base - truth['baseline_1_2_m']) / truth['baseline_1_2_m'] * 100:.0f} % off)"
              f" · {res['points']['count']} of {res['points']['of']} points · confidence {res['confidence']['mean']}")
        for wmsg in res.get("warnings", []):
            print(f"    warning: {wmsg}")
        return res

    res = reconstruct({}, "its own scale")
    failed |= res is None
    m = truth["door_measurement"]
    res2 = reconstruct({"one_measurement": m}, f"the door {m['metres']} m")
    failed |= res2 is None
    if res2:
        open(os.path.join(a.out, "measure-test.ply"), "wb").write(base64.b64decode(res2["points"]["b64"]))
        if res2.get("measurement"):
            print(f"    the model saw the door as {res2['measurement']['model_metres']} m before scaling")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
