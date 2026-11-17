"""Run: identity_scene.py WORKDIR/scene (numpy, Pillow). A synthetic test subject for mux's identity research: a ray-traced ellipsoid mannequin (yellow hat, red jacket,
blue trousers, black shoes) walking across an empty studio. No real person, no photograph.

Writes into OUT: first.png (frame 0 in colour), depth.zip (32 16-bit PNG frames, mm, 2 s at 16 fps), parts.npz (the
per-frame part ids, for measuring), ref1.png (front, on white), ref2.png (three-quarter, on white), ref3.png (hat and
jacket close, on white).
"""
import io, os, sys, zipfile
import numpy as np
from PIL import Image

OUT = sys.argv[1]
os.makedirs(OUT, exist_ok=True)
W, H = 832, 480
SKIN, HAT, JACKET, TROUSERS, SHOES = (205, 192, 172), (240, 196, 24), (196, 28, 40), (36, 62, 168), (30, 30, 34)
COLOURS = {1: SKIN, 2: HAT, 3: JACKET, 4: TROUSERS, 5: SHOES}
NAMES = {1: "skin", 2: "hat", 3: "jacket", 4: "trousers", 5: "shoes"}


def figure(phase):
    s = np.sin(phase) * 0.12
    return [  # (part id, centre, radii) in the figure's frame: feet at y 0, facing +z
        (1, (0, 1.60, 0), (.105, .125, .11)), (1, (0, 1.43, 0), (.05, .06, .05)),           # head, neck
        (2, (0, 1.715, 0), (.115, .07, .115)), (2, (0, 1.675, 0), (.21, .018, .21)),        # hat crown, brim
        (3, (0, 1.17, 0), (.20, .27, .12)), (3, (0, 1.33, 0), (.23, .08, .13)),            # jacket, shoulders
        (3, (.26, 1.13, -s), (.058, .27, .06)), (3, (-.26, 1.13, s), (.058, .27, .06)),    # sleeves
        (1, (.27, .83, -1.6 * s), (.045, .06, .045)), (1, (-.27, .83, 1.6 * s), (.045, .06, .045)),  # hands
        (4, (0, .90, 0), (.18, .08, .11)),                                                    # hips
        (4, (.095, .48, s), (.075, .43, .08)), (4, (-.095, .48, -s), (.075, .43, .08)),      # legs
        (5, (.095, .04, 2 * s + .05), (.06, .04, .12)), (5, (-.095, .04, -2 * s + .05), (.06, .04, .12)),
    ]


def render(cam_pos, look_at, f_px, fig_pos, yaw, phase, white=False, w=W, h=H):
    cam_pos, look_at = np.array(cam_pos, float), np.array(look_at, float)
    fwd = look_at - cam_pos; fwd /= np.linalg.norm(fwd)
    right = np.cross(fwd, [0, 1, 0]); right /= np.linalg.norm(right)
    up = np.cross(right, fwd)
    xs, ys = np.meshgrid(np.arange(w) + .5 - w / 2, np.arange(h) + .5 - h / 2)
    d = fwd[None, None] * f_px + right[None, None] * xs[..., None] - up[None, None] * ys[..., None]
    d /= np.linalg.norm(d, axis=-1, keepdims=True)
    t_best = np.full((h, w), np.inf); part = np.zeros((h, w), int); nrm = np.zeros((h, w, 3))
    c, s_ = np.cos(yaw), np.sin(yaw)
    R = np.array([[c, 0, s_], [0, 1, 0], [-s_, 0, c]])  # figure → world
    o_l = (cam_pos - np.array(fig_pos)) @ R  # world → figure (R^T x)
    d_l = d @ R
    for pid, cen, rad in figure(phase):
        cen, rad = np.array(cen), np.array(rad)
        o = (o_l - cen) / rad; dd = d_l / rad
        a = (dd * dd).sum(-1); b = 2 * (dd * o).sum(-1); cc = (o * o).sum() - 1
        disc = b * b - 4 * a * cc
        hit = disc > 0
        t = np.where(hit, (-b - np.sqrt(np.maximum(disc, 0))) / (2 * a), np.inf)
        t = np.where(t > 0, t, np.inf)
        better = t < t_best
        t_best = np.where(better, t, t_best); part = np.where(better, pid, part)
        p = o + dd * np.where(np.isfinite(t), t, 0)[..., None]
        n_l = p / rad
        n_w = n_l @ R.T
        nrm = np.where(better[..., None], n_w / np.linalg.norm(n_w, axis=-1, keepdims=True).clip(1e-9), nrm)
    light = np.array([-.4, .8, .45]); light /= np.linalg.norm(light)
    img = np.zeros((h, w, 3))
    if white:
        img[:] = 255
        depth = None
    else:
        # floor y = 0 and a back wall z = -9
        tf = np.where(d[..., 1] < -1e-6, -cam_pos[1] / d[..., 1], np.inf)
        tw = np.where(d[..., 2] < -1e-6, (-9 - cam_pos[2]) / d[..., 2], np.inf)
        floor = tf < tw
        tb = np.minimum(tf, tw)
        pf = cam_pos + d * np.where(np.isfinite(tb), tb, 0)[..., None]
        shade_floor = 0.85 + 0.15 * (((np.floor(pf[..., 0]) + np.floor(pf[..., 2])) % 2) == 0)
        img[floor] = (np.array([150, 144, 134]) * shade_floor[floor][:, None])
        img[~floor] = np.array([182, 188, 196]) * (0.9 + 0.1 * np.clip(pf[~floor][:, 1] / 4, 0, 1))[:, None]
        # the figure's shadow on the floor (a soft disc under it)
        r2 = (pf[..., 0] - fig_pos[0]) ** 2 + (pf[..., 2] - fig_pos[2]) ** 2
        img[floor] *= (1 - 0.35 * np.exp(-r2 / 0.08))[floor][:, None]
        depth = np.where(part > 0, t_best, tb) * (d @ fwd)  # along the camera's axis
    lam = 0.35 + 0.65 * np.clip((nrm * light).sum(-1), 0, 1)
    for pid, col in COLOURS.items():
        m = part == pid
        img[m] = np.array(col)[None] * lam[m][:, None]
    return np.clip(img, 0, 255).astype(np.uint8), depth, part


if __name__ == "__main__":
    n = 32
    cam, at = (0, 1.5, 0.5), (0, 1.0, -4)
    zf = zipfile.ZipFile(os.path.join(OUT, "depth.zip"), "w")
    parts = []
    for i in range(n):
        t = i / 16
        x = -0.7 + 0.6 * t
        img, depth, part = render(cam, at, 760, (x, 0, -4), np.pi / 2 * 0.85, t * 2 * np.pi * 0.9)
        if i == 0:
            Image.fromarray(img).save(os.path.join(OUT, "first.png"))
        if i in (16, 31):
            Image.fromarray(img).save(os.path.join(OUT, f"truth_{i}.png"))
        b = io.BytesIO()
        Image.fromarray(np.clip(depth * 1000, 1, 65535).astype(np.uint16)).save(b, format="PNG")
        zf.writestr(f"depth_{i:04d}.png", b.getvalue())
        parts.append(part.astype(np.uint8))
    zf.close()
    np.savez_compressed(os.path.join(OUT, "parts.npz"), parts=np.stack(parts))
    # references on white: front, three-quarter, and the hat and jacket close
    for name, yaw, cam_r, at_r, f in (("ref1", 0.0, (0, 1.0, 3.2), (0, 0.9, 0), 900), ("ref2", 0.7, (0, 1.0, 3.2), (0, 0.9, 0), 900),
                                      ("ref3", 0.3, (0, 1.5, 1.6), (0, 1.4, 0), 1300)):
        img, _, _ = render(cam_r, at_r, f, (0, 0, 0), yaw, 0.0, white=True, w=640, h=640)
        Image.fromarray(img).save(os.path.join(OUT, f"{name}.png"))
    print("ok", OUT)
