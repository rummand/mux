"""How well the subject's look holds: frames at 0, 1, 2 s of each run; in the known subject mask (eroded 2 px), the
8x8x8 RGB histogram intersection with the true render (1 = same colours) and each part's mean-colour distance (RGB,
0–441) from the true part colour. Usage: identity_look.py WORKDIR RUN [RUN…] (WORKDIR/runs/<name>.mp4, WORKDIR/scene from identity_scene.py)"""
import json, os, subprocess, sys
import numpy as np
from PIL import Image
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
HERE = os.path.abspath(sys.argv.pop(1))
import identity_scene as S
import imageio_ffmpeg
parts = np.load(os.path.join(HERE, "scene/parts.npz"))["parts"]
IDX = {"0s": 0, "1s": 16, "2s": 31}


def frames(mp4):
    raw = subprocess.run([imageio_ffmpeg.get_ffmpeg_exe(), "-v", "error", "-i", mp4, "-f", "rawvideo", "-pix_fmt", "rgb24", "-"], capture_output=True).stdout
    return np.frombuffer(raw, np.uint8).reshape(-1, 480, 832, 3)


def erode(m, r=2):
    out = m.copy()
    for dy in range(-r, r + 1):
        for dx in range(-r, r + 1):
            out &= np.roll(np.roll(m, dy, 0), dx, 1)
    return out


def hist(px):
    h, _ = np.histogramdd(px // 32, bins=(8, 8, 8), range=((0, 8),) * 3)
    return h / max(1, h.sum())


truth = {}
for k, i in IDX.items():
    t = i / 16
    img, _, _ = S.render((0, 1.5, 0.5), (0, 1.0, -4), 760, (-0.7 + 0.6 * t, 0, -4), np.pi / 2 * 0.85, t * 2 * np.pi * 0.9)
    truth[k] = img
out = {}
sheet_rows = []
for run in sys.argv[1:]:
    fr = frames(os.path.join(HERE, "runs", run + ".mp4"))
    res = {}
    row = []
    for k, i in IDX.items():
        f = fr[min(i, len(fr) - 1)]
        m = erode(parts[i] > 0)
        hi = float(np.minimum(hist(f[m]), hist(truth[k][m])).sum())
        d = {}
        for pid in (2, 3, 4):
            pm = erode(parts[i] == pid)
            if pm.sum() > 20:
                d[S.NAMES[pid]] = round(float(np.linalg.norm(f[pm].mean(0) - truth[k][pm].mean(0))), 1)
        res[k] = {"hist_intersection": round(hi, 3), "part_rgb_distance": d}
        ys, xs = np.nonzero(parts[i] > 0)
        cy, cx = int(ys.mean()), int(xs.mean())
        y0, x0 = max(0, cy - 150), min(max(0, cx - 75), 832 - 150)
        row.append(Image.fromarray(f).resize((416, 240)))
        row.append(Image.fromarray(f[y0:y0 + 300, x0:x0 + 150]).resize((120, 240)))
    out[run] = res
    sheet_rows.append(row)
    print(run, json.dumps(res))
W = sum(im.width for im in sheet_rows[0]) + 4 * len(sheet_rows[0])
sheet = Image.new("RGB", (W, 244 * len(sheet_rows)), "white")
for r, row in enumerate(sheet_rows):
    x = 0
    for im in row:
        sheet.paste(im, (x, r * 244)); x += im.width + 4
sheet.save(os.path.join(HERE, "runs", "sheet_" + "_".join(sys.argv[1:]) + ".png"))
json.dump(out, open(os.path.join(HERE, "runs", "look_" + "_".join(sys.argv[1:]) + ".json"), "w"), indent=1)
