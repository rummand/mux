"""The dome builder on synthetic scenes whose geometry is known: no weights, no torch, no Mac.

Run: python3 server/backdrop/test_dome.py   (needs numpy and Pillow, as the server does)
A scene: the camera `ground` units above a flat ground, a ring of walls around it at a radius that changes with the
direction, `top` units high, and sky above them. Depth is the distance along each pixel's ray, as MoGe-2 gives it.
"""
import importlib.util, io, math, os, sys

import numpy as np
from PIL import Image

here = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location("dome", os.path.join(here, "dome.py"))
dome = importlib.util.module_from_spec(spec)
spec.loader.exec_module(dome)

ok = lambda name: print(f"ok {name}")


def rot_x(deg):
    a = math.radians(deg)
    c, s = math.cos(a), math.sin(a)
    return np.array([[1, 0, 0], [0, c, -s], [0, s, c]])


def scene(h=480, w=960, ground=2.0, radius=lambda lon: 40 + 10 * np.sin(lon), top=10.0, pitch=0.0, noise=0.0):
    """(depth, valid) of the synthetic scene, seen by a camera pitched `pitch` degrees up."""
    d = dome.pixel_directions(h, w) @ rot_x(pitch).T     # camera rays in the level world
    lon = np.arctan2(d[..., 0], -d[..., 2])
    horiz = np.sqrt(d[..., 0] ** 2 + d[..., 2] ** 2)
    r = radius(lon)
    t_wall = r / np.maximum(horiz, 1e-12)
    wall_y = t_wall * d[..., 1]
    t_floor = np.where(d[..., 1] < 0, ground / np.maximum(-d[..., 1], 1e-12), np.inf)
    depth = np.minimum(t_floor, np.where(wall_y <= top, t_wall, np.inf))
    valid = np.isfinite(depth)
    if noise:
        depth = depth * (1 + noise * np.random.default_rng(1).standard_normal(depth.shape))
    return np.where(valid, depth, 0.0), valid


def weld(pos, faces, tol=1e-4):
    keys = np.round(pos / tol).astype(np.int64)
    _, inv = np.unique(keys, axis=0, return_inverse=True)
    return inv.reshape(-1)[faces]


def edges_shared_twice(faces):
    e = np.concatenate([faces[:, [0, 1]], faces[:, [1, 2]], faces[:, [2, 0]]])
    directed = {tuple(x) for x in e.tolist()}
    und = np.sort(e, axis=1)
    _, counts = np.unique(und, axis=0, return_counts=True)
    # closed and consistently wound: every edge in exactly two faces, once in each direction
    return bool((counts == 2).all()) and all((b, a) in directed for a, b in directed)


def face_normals(pos, faces):
    a, b, c = pos[faces[:, 0]], pos[faces[:, 1]], pos[faces[:, 2]]
    return np.cross(b - a, c - a), (a + b + c) / 3


GRID = (128, 64)

# ── a level scene ────────────────────────────────────────────────────────────────────────────────────────────────
depth, valid = scene()
info = dome.analyse(depth, valid)
n, height, frac = info["ground"]
assert abs(height - 2.0) < 0.02 and info["tilt_deg"] < 0.3, (height, info["tilt_deg"])
assert abs(info["horizon"] - 0.5) < 0.002, info["horizon"]
assert abs(info["reference"] - 40) < 0.8, info["reference"]   # the median of 40 + 10 sin(lon) is 40
ok("ground found under the camera (height 2.0), level, horizon at v = 0.5, median horizon distance 40")

pos, uv, faces, decided = dome.build_dome(depth, valid, grid=GRID, info=info)
gw = GRID[0]
u, v = decided["columns"], decided["rows"]
nr = len(v)
assert nr > GRID[1] + 1 and 0.5 in v and np.all(np.diff(v) > 0), "rows: the grid's, the horizon, and some just below it"
P = pos.reshape(nr, gw + 1, 3)
assert pos.dtype == np.float32 and faces.dtype == np.uint32 and faces.max() < len(pos)
assert abs(decided["scale"] - 100 / info["reference"]) < 1e-9

# Scale: the median horizon distance is 100 units; the floor is at y = -1.6
lat = (0.5 - v) * np.pi
j_eq = int(np.flatnonzero(v == 0.5)[0])                       # the horizon row: each ray at its depth
r_row = np.hypot(P[j_eq, :-1, 0], P[j_eq, :-1, 2])
assert abs(np.median(r_row) - 100) < 1.0, np.median(r_row)
below = lat[:, None] < 0
ys = P[..., 1][np.broadcast_to(below, P.shape[:2])]
assert ys.min() >= -1.6 - 1e-5, ys.min()
assert (np.abs(ys + 1.6) < 1e-5).sum() > 0.4 * ys.size, "most rays below the horizon end on the floor"
assert np.allclose(P[-1], [0, -1.6, 0], atol=1e-6), "straight down: the floor under the camera"
# The walls keep their shape: a vertex on the wall at azimuth lon is r(lon)·scale away
lon_c = (u[:-1] - 0.5) * 2 * np.pi
want = (40 + 10 * np.sin(lon_c)) * decided["scale"]
assert np.median(np.abs(r_row - want) / want) < 0.03, np.median(np.abs(r_row - want) / want)
# Just below the horizon the floor reaches out to the walls and the walls come down to it: where a column's wall
# (r) is nearer than the floor reaches, the vertex is on the wall at r; else on the floor
j_low = j_eq + 1
r_low = np.hypot(P[j_low, :-1, 0], P[j_low, :-1, 2])
reach = 1.6 / math.tan(-lat[j_low])
y_low = P[j_low, :-1, 1]
wall = r_low < reach - 1e-3
assert wall.any() and (~wall).any()
assert np.allclose(r_low[wall], r_row[wall], rtol=0.05) and (y_low[wall] > -1.6).all()
assert np.allclose(y_low[~wall], -1.6, atol=1e-5)
ok("scaled: median horizon distance 100 units, ground flattened to a floor at y = -1.6, walls where they stand")

# Closed: welded by position (the seam column and the poles repeat), every edge is in exactly two faces, wound
# consistently; so no ray from the camera gets out, below the horizon or above it
wf = weld(pos, faces)
assert edges_shared_twice(wf), "the dome has a hole or a flipped face"
assert np.allclose(P[:, 0], P[:, -1]), "the seam: the last column is the first again"
assert np.allclose(P[0], P[0, 0]) and np.allclose(P[-1], P[-1, 0]), "each pole is one point"
ok("closed: no hole anywhere (seam and poles welded), consistently wound")

# Every vertex lies on its own grid ray (a radial graph around the camera: seen from it, the panorama exactly)
dirs = dome.direction(*dome.lon_lat(u[None, :], v[:, None]))
inner = (slice(1, -1), slice(None))
unit = P[inner] / np.linalg.norm(P[inner], axis=-1, keepdims=True)
assert np.allclose(unit, dirs[inner], atol=1e-5)
# Faces inward: each face's normal (counter-clockwise) points back at the camera
nrm, cen = face_normals(pos.astype(np.float64), faces)
area = np.linalg.norm(nrm, axis=1)
facing = np.einsum("ij,ij->i", nrm, cen)
assert (facing[area > 1e-9] < 0).all(), f"{(facing[area > 1e-9] >= 0).sum()} faces face outward"
ok("faces inward, every vertex on its own ray")

# Axes: y up, -z the panorama's centre column, +x a quarter turn to its right; texture coordinates are (u, v)
c = P[j_eq - 1, gw // 2]
assert abs(c[0]) < 1e-4 and c[2] < 0, c
q = P[j_eq - 1, 3 * gw // 4]
assert q[0] > 0 and abs(q[2]) < 1e-3 * abs(q[0]), q
assert P[0, 0, 1] > 0 and P[-1, 0, 1] < 0
UV = uv.reshape(nr, gw + 1, 2)
assert np.allclose(UV[1:-1, :, 0], u[None, :]) and np.allclose(UV[:, 3, 1], v)
ok("axes: y up, -z is the centre column (u = 0.5), +x at u = 0.75; texture coordinates are the panorama's")

# Above the horizon each ray keeps its depth (scaled), the sky is far
sky_rows = lat > np.deg2rad(40)
assert np.allclose(np.linalg.norm(P[sky_rows][:, :-1], axis=-1), dome.SKY_DISTANCE, rtol=1e-6)
ok("the sky at the sky distance")

# ── a camera pitched 4° up: the tilt is found, the horizon is off the middle row at the centre column ─────────────
depth_t, valid_t = scene(pitch=4.0)
info_t = dome.analyse(depth_t, valid_t)
assert abs(info_t["tilt_deg"] - 4.0) < 0.2, info_t["tilt_deg"]
assert abs(info_t["horizon"] - (0.5 + 4.0 / 180)) < 0.003, info_t["horizon"]
pos_t, _, faces_t, _ = dome.build_dome(depth_t, valid_t, grid=GRID, info=info_t)
floor = np.abs(pos_t[:, 1] + 1.6) < 1e-4
assert floor.sum() > 0.25 * len(pos_t) and pos_t[:, 1].min() >= -1.6 - 1e-5
assert edges_shared_twice(weld(pos_t, faces_t))
ok("a pitched camera: tilt 4° found, horizon v = 0.5 + 4/180 at the centre column; the dome is closed, its floor flat")

# ── noisy depth (a depth model is not exact): the same answers, near enough ──────────────────────────────────────
depth_n, valid_n = scene(noise=0.01)
info_n = dome.analyse(depth_n, valid_n)
assert info_n["ground"] and abs(info_n["ground"][1] - 2.0) < 0.1 and info_n["tilt_deg"] < 1.0
assert abs(info_n["reference"] - 40) < 2
ok("1% depth noise: ground, level and horizon distance still found")

# ── an open plain: nothing stands on the horizon, so the farthest ground seen near it says how far it is ─────────
plain_d, plain_v = scene(radius=lambda lon: np.full_like(lon, 1e9), top=0.0)
info_p = dome.analyse(plain_d, plain_v)
assert info_p["ground"] and abs(info_p["ground"][1] - 2.0) < 0.02
assert info_p["reference"] > 300, info_p["reference"]        # 2 / tan(0.19°) ≈ 611 at this panorama's resolution
pos_p, _, faces_p, _ = dome.build_dome(plain_d, plain_v, grid=GRID, info=info_p)
assert edges_shared_twice(weld(pos_p, faces_p)) and pos_p[:, 1].min() >= -1.6 - 1e-5
ok("an open plain: the horizon distance from the farthest ground, the dome still closed")

# ── nothing seen at all (all sky): still a closed dome, floor and a ring at the horizon distance ─────────────────
none_d, none_v = np.zeros((240, 480)), np.zeros((240, 480), dtype=bool)
info_0 = dome.analyse(none_d, none_v)
assert info_0["ground"] is None and info_0["horizon"] == 0.5
pos_0, _, faces_0, dec_0 = dome.build_dome(none_d, none_v, grid=GRID, info=info_0)
P0 = pos_0.reshape(len(dec_0["rows"]), gw + 1, 3)
assert edges_shared_twice(weld(pos_0, faces_0))
assert abs(np.median(np.hypot(P0[j_eq + 1, :, 0], P0[j_eq + 1, :, 2])) - 100) < 1e-3, "the ring at 100 just below the horizon"
assert np.allclose(np.linalg.norm(P0[j_eq], axis=-1), dome.SKY_DISTANCE), "at the horizon: sky"
assert pos_0[:, 1].min() >= -1.6 - 1e-6
ok("nothing seen: still closed, a floor at -1.6 and a ring at 100")

# ── the depth PNG ────────────────────────────────────────────────────────────────────────────────────────────────
png, kind, unit = dome.encode_depth(depth, valid, metric=True, reference=info["reference"])
im = Image.open(io.BytesIO(png))
assert im.mode in ("I;16", "I;16B", "I;16L", "I") and im.size == (depth.shape[1], depth.shape[0])
arr = np.asarray(im).astype(np.int64)
assert kind == "metric" and unit == 1.0
assert (arr[~valid] == 0).all(), "the sky is 0"
probe = valid & (depth < 60)
assert np.abs(arr[probe] - np.round(depth[probe] * 1000)).max() <= 1, "metric: millimetres"
far_d, far_v = depth * 50, valid                              # walls 2 km away: past what 16 bits of mm hold
png_r, kind_r, unit_r = dome.encode_depth(far_d, far_v, metric=True, reference=info["reference"] * 50)
arr_r = np.asarray(Image.open(io.BytesIO(png_r))).astype(np.int64)
assert kind_r == "relative" and abs(unit_r - info["reference"] * 50 / dome.RELATIVE_HORIZON) < 1e-9
fits = far_v & (far_d / unit_r * 1000 < 65535)
assert np.abs(arr_r[fits] - far_d[fits] / unit_r * 1000).max() <= 1, "relative: depth / unit × 1000"
assert (arr_r[far_v & ~fits] == 65535).all(), "beyond 65.535 units: the most a PNG holds"
assert round(info["reference"] * 50 / unit_r * 1000) == 20000, "the median horizon distance is 20 units (20 000)"
png_m, kind_m, _ = dome.encode_depth(depth, valid, metric=False, reference=info["reference"])
assert kind_m == "relative"
ok("depth PNG: 16-bit grey, mm when metric and it fits, else relative (horizon = 20 000); sky 0")

# ── the GLB ──────────────────────────────────────────────────────────────────────────────────────────────────────
rgb = np.zeros((depth.shape[0], depth.shape[1], 3), dtype=np.uint8)
rgb[..., 0] = np.linspace(0, 255, depth.shape[1])[None, :]   # a gradient left to right, to see the texture
rgb[..., 2] = np.linspace(0, 255, depth.shape[0])[:, None]
glb, dec = dome.dome_glb(rgb, depth, valid, grid=GRID, info=info)
assert glb[:4] == b"glTF" and len(glb) % 4 == 0
doc, binary = dome.read_glb(glb)
assert doc["asset"]["version"] == "2.0" and "KHR_materials_unlit" in doc["extensionsUsed"]
assert doc["materials"][0]["doubleSided"] is False
prim = doc["meshes"][0]["primitives"][0]
assert prim["mode"] == 4 and set(prim["attributes"]) == {"POSITION", "TEXCOORD_0"}
gpos = dome.accessor(doc, binary, prim["attributes"]["POSITION"])
guv = dome.accessor(doc, binary, prim["attributes"]["TEXCOORD_0"])
gidx = dome.accessor(doc, binary, prim["indices"])
assert np.array_equal(gpos, pos) and np.array_equal(guv, uv) and np.array_equal(gidx.reshape(-1, 3), faces)
pa = doc["accessors"][prim["attributes"]["POSITION"]]
assert np.allclose(pa["min"], pos.min(axis=0)) and np.allclose(pa["max"], pos.max(axis=0))
for view in doc["bufferViews"]:
    assert view["byteOffset"] % 4 == 0 and view["byteOffset"] + view["byteLength"] <= len(binary)
img_view = doc["bufferViews"][doc["images"][0]["bufferView"]]
tex = Image.open(io.BytesIO(binary[img_view["byteOffset"]:img_view["byteOffset"] + img_view["byteLength"]]))
assert tex.format == "JPEG" and tex.size == (depth.shape[1], depth.shape[0])
assert doc["asset"]["extras"]["mux_backdrop"]["eye"] == 1.6 and doc["asset"]["extras"]["mux_backdrop"]["horizonDistance"] == 100
try:  # a second reader, if this machine has one
    import trimesh  # noqa: F401
    m = trimesh.load(io.BytesIO(glb), file_type="glb", force="mesh", process=False)
    assert len(m.faces) == len(faces)
    ok("trimesh reads the GLB")
except ImportError:
    pass
ok(f"GLB: one unlit textured mesh, {len(pos)} vertices, {len(faces)} triangles, {len(glb) // 1024} kB")

# The default grid on a full-size panorama: size and time stay reasonable
import time
big_d, big_v = scene(h=960, w=1920)
t = time.time()
big, _ = dome.dome_glb(np.zeros((960, 1920, 3), np.uint8), big_d, big_v)
assert len(big) < 6 * 1024 * 1024, len(big)
ok(f"1920×960 at the default grid: {len(big) // 1024} kB in {time.time() - t:.1f} s")
print("all dome tests passed")
