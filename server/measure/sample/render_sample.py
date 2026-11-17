"""The measure server's sample photos: a small house rendered from three cameras, with numpy and Pillow only.

No photo of anyone's house, no licence to read: the scene is made here, so its true sizes are known and the deploy test
(deploy/measure.sh) can print how close Depth Pro and the reconstruction come to them. Run from anywhere:

  python3 server/measure/sample/render_sample.py      writes house-1.jpg, house-2.jpg, house-3.jpg and truth.json here

The scene, in metres (y up): a 7.3 × 2.55 m box house, 3.0 m tall, with vertical boards 0.14 m wide, a door and two
windows on its front (z = +1.275), on a tiled ground. Cameras: 1024 × 768, focal 900 px, eye height 1.6 m.
"""
import json, math, os

import numpy as np
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
W, H, F = 1024, 768, 900.0
HOUSE = {"min": [-3.65, 0.0, -1.275], "max": [3.65, 3.0, 1.275]}
DOOR = {"x": (-1.6, -0.79), "y": (0.0, 1.98)}            # on the front wall, 0.81 × 1.98 m
WINDOWS = [{"x": (0.2, 1.4), "y": (0.95, 1.95)}, {"x": (2.0, 3.2), "y": (0.95, 1.95)}]
CAMERAS = [  # eye, the point looked at
    {"eye": [-4.0, 1.6, 9.0], "at": [0.0, 1.3, 0.0]},
    {"eye": [0.0, 1.6, 9.5], "at": [0.0, 1.3, 0.0]},
    {"eye": [5.0, 1.6, 8.0], "at": [0.0, 1.3, 0.0]},
]


def look_at(eye, at):
    """OpenCV camera axes (x right, y down, z forward) in world coordinates; R maps world → camera."""
    eye, at = np.array(eye, float), np.array(at, float)
    z = at - eye
    z /= np.linalg.norm(z)
    x = np.cross(z, [0.0, 1.0, 0.0])  # right
    x /= np.linalg.norm(x)
    y = np.cross(z, x)  # down
    R = np.stack([x, y, z])
    return R, -R @ eye


def noise(shape, seed):
    rng = np.random.default_rng(seed)
    return rng.random(shape)


def render(cam, seed):
    R, t = look_at(cam["eye"], cam["at"])
    eye = np.array(cam["eye"], float)
    u, v = np.meshgrid(np.arange(W) + 0.5, np.arange(H) + 0.5)
    d_cam = np.stack([(u - W / 2) / F, (v - H / 2) / F, np.ones_like(u)], -1)
    d = d_cam @ R  # world directions (R is orthonormal: R^T applied row-wise)
    d /= np.linalg.norm(d, axis=-1, keepdims=True)
    img = np.zeros((H, W, 3))
    depth = np.full((H, W), np.inf)
    # Sky
    sky = np.clip(d[..., 1], 0, 1)[..., None]
    img[:] = (1 - sky) * np.array([0.78, 0.86, 0.95]) + sky * np.array([0.35, 0.55, 0.85])
    # Ground (y = 0): tiles of 1 m with grain
    with np.errstate(divide="ignore", invalid="ignore"):
        tg = -eye[1] / d[..., 1]
    hit = (d[..., 1] < 0) & (tg > 0)
    p = eye + d * np.where(hit, tg, 0)[..., None]
    tile = ((np.floor(p[..., 0]) + np.floor(p[..., 2])) % 2)[..., None]
    grain = noise((H, W), seed)[..., None]
    ground = np.array([0.42, 0.5, 0.33]) * (0.85 + 0.15 * tile) * (0.9 + 0.2 * grain)
    img = np.where(hit[..., None], ground, img)
    depth = np.where(hit, tg, depth)
    # House: a box, by slabs
    lo, hi = np.array(HOUSE["min"]), np.array(HOUSE["max"])
    with np.errstate(divide="ignore", invalid="ignore"):
        t1, t2 = (lo - eye) / d, (hi - eye) / d
    tmin = np.nanmax(np.minimum(t1, t2), axis=-1)
    tmax = np.nanmin(np.maximum(t1, t2), axis=-1)
    box = (tmax >= tmin) & (tmin > 0) & (tmin < depth)
    q = eye + d * np.where(box, tmin, 0)[..., None]
    eps = 1e-4
    front = box & (np.abs(q[..., 2] - hi[2]) < eps)
    side = box & ((np.abs(q[..., 0] - lo[0]) < eps) | (np.abs(q[..., 0] - hi[0]) < eps))
    top = box & (np.abs(q[..., 1] - hi[1]) < eps)
    # Cladding: boards 0.14 m wide on the front (vertical, along x), metal ribs 0.1 m on the sides (along z)
    board = np.floor(q[..., 0] / 0.14) % 2
    rib = np.floor(q[..., 2] / 0.1) % 2
    cedar = np.array([0.62, 0.42, 0.26]) * (0.9 + 0.1 * board[..., None]) * (0.92 + 0.12 * grain)
    metal = np.array([0.24, 0.25, 0.27]) * (0.85 + 0.2 * rib[..., None])
    roof = np.array([0.1, 0.1, 0.11])
    img = np.where(front[..., None], cedar, img)
    img = np.where(side[..., None], metal * 0.8, img)
    img = np.where(top[..., None], roof, img)
    # Door and windows on the front
    def on(rect):
        return front & (q[..., 0] >= rect["x"][0]) & (q[..., 0] <= rect["x"][1]) & (q[..., 1] >= rect["y"][0]) & (q[..., 1] <= rect["y"][1])
    img = np.where(on(DOOR)[..., None], np.array([0.15, 0.12, 0.1]), img)
    for w in WINDOWS:
        frame = on({"x": (w["x"][0] - 0.06, w["x"][1] + 0.06), "y": (w["y"][0] - 0.06, w["y"][1] + 0.06)})
        img = np.where(frame[..., None], np.array([0.05, 0.05, 0.05]), img)
        img = np.where(on(w)[..., None], np.array([0.55, 0.68, 0.78]) * (0.9 + 0.1 * grain), img)
    depth = np.where(box, tmin, depth)
    z_depth = np.where(np.isfinite(depth), depth * d_cam[..., 2] / np.linalg.norm(d_cam, axis=-1), 0)  # along the axis
    return (np.clip(img, 0, 1) * 255).round().astype(np.uint8), z_depth, R, t


def main():
    truth = {"note": "rendered by render_sample.py; R, t map world to camera (OpenCV: x right, y down, z forward); metres",
             "house": HOUSE, "door": DOOR, "windows": WINDOWS, "width": W, "height": H,
             "K": [[F, 0, W / 2], [0, F, H / 2], [0, 0, 1]], "cameras": []}
    for i, cam in enumerate(CAMERAS):
        img, z, R, t = render(cam, seed=i + 1)
        Image.fromarray(img).save(os.path.join(HERE, f"house-{i + 1}.jpg"), quality=90)
        # The front wall's depth at the middle of the door's height, straight ahead of the image centre
        cy, cx = H // 2, W // 2
        truth["cameras"].append({"photo": i, "file": f"house-{i + 1}.jpg", "eye": cam["eye"], "R": R.round(6).tolist(),
                                 "t": t.round(6).tolist(), "centre_depth_m": round(float(z[cy, cx]), 3)})
    # A measurement a person could give: the door's width, from its bottom corners in photo 2 (the straight one)
    R, t = np.array(truth["cameras"][1]["R"]), np.array(truth["cameras"][1]["t"])
    def project(X):
        c = R @ np.array(X) + t
        return [round(F * c[0] / c[2] + W / 2, 1), round(F * c[1] / c[2] + H / 2, 1)]
    truth["door_measurement"] = {"photo": 1, "p1": project([DOOR["x"][0], 1.0, HOUSE["max"][2]]),
                                 "p2": project([DOOR["x"][1], 1.0, HOUSE["max"][2]]), "metres": round(DOOR["x"][1] - DOOR["x"][0], 3)}
    truth["baseline_1_2_m"] = round(math.dist(CAMERAS[0]["eye"], CAMERAS[1]["eye"]), 3)
    with open(os.path.join(HERE, "truth.json"), "w") as f:
        json.dump(truth, f, indent=1)
    print("wrote house-1..3.jpg and truth.json in", HERE)


if __name__ == "__main__":
    main()
