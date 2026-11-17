"""The backdrop's geometry: a panorama and its depth become one mesh around the camera, written as a GLB.

Plain numpy and Pillow, no model and no GPU, so every rule here is tested without weights (test_dome.py). The
backdrop server (backdrop_server.py) calls it after the panorama (HunyuanWorld 1.0) and its depth (MoGe-2) are made.

Conventions (Thread's Sets is built against them; docs/backdrop.md):
- An equirectangular panorama, 2:1. Column u in [0, 1] left to right, row v in [0, 1] top to bottom. Longitude
  lon = (u - 0.5)·2π, latitude lat = (0.5 - v)·π. The direction of (lon, lat) is
  (cos lat · sin lon, sin lat, -cos lat · cos lon): y up, the camera at the origin, -z is the panorama's centre column
  (u = 0.5), +x is a quarter turn to the right of it (u = 0.75).
- Depth is the distance from the camera along each pixel's ray (not a z-depth), in the depth model's units; `valid` is
  False where there is no surface (the sky).
- The dome is scaled so the median horizon distance is HORIZON_DISTANCE units, and every ray below the horizon ends
  on a floor at y = -eye (EYE units) or, where something at the horizon stands nearer than the floor reaches, on a
  wall at that thing's distance. So the dome is closed below the horizon and meets Sets' ground. At and above the
  horizon each ray ends at its own depth; the sky at SKY_DISTANCE. The ground plane (when one is found) gives the
  camera's height and the horizon's row; the dome itself stays in the panorama's frame (a generated panorama is level).
- The mesh is a radial graph: every vertex lies on its own grid ray, so seen from the origin it is exactly the
  panorama, whatever the depth does; faces wind counter-clockwise seen from the origin (they face inward).
"""
import io, json, math, struct, warnings

import numpy as np

EYE = 1.6
HORIZON_DISTANCE = 100.0
SKY_DISTANCE = 1000.0
MAX_TILT_DEG = 10.0      # a ground plane tilted more than this is taken for a wrong fit, not a tilted camera
HORIZON_BAND_DEG = 1.5   # pixels this close to the horizon say how far away the horizon is, column by column
RELATIVE_HORIZON = 20.0  # in a relative depth PNG, the median horizon distance is this many units (× 1000 in the PNG)
METRIC_LIMIT_M = 65.0    # a metric depth PNG holds up to 65.535 m: beyond this (at the 99th percentile) it goes relative


# ── Directions ───────────────────────────────────────────────────────────────────────────────────────────────────

def lon_lat(u, v):
    return (np.asarray(u, dtype=np.float64) - 0.5) * 2 * np.pi, (0.5 - np.asarray(v, dtype=np.float64)) * np.pi


def direction(lon, lat):
    """Unit direction(s) for longitude and latitude (radians), in the dome's frame: y up, -z the centre column."""
    lon, lat = np.broadcast_arrays(np.asarray(lon, dtype=np.float64), np.asarray(lat, dtype=np.float64))
    c = np.cos(lat)
    return np.stack([c * np.sin(lon), np.sin(lat), -c * np.cos(lon)], axis=-1)


def pixel_directions(h, w):
    """(h, w, 3) unit directions through the pixel centres of an h × w equirectangular image."""
    u = (np.arange(w) + 0.5) / w
    v = (np.arange(h) + 0.5) / h
    lon, lat = lon_lat(u[None, :], v[:, None])
    return direction(lon, lat)


# ── Ground and horizon ───────────────────────────────────────────────────────────────────────────────────────────

def fit_ground(depth, valid, dirs=None, seed=0):
    """The ground plane under the camera, from the points well below the horizon.

    Returns (normal, height, inlier_fraction) with the unit normal pointing up (towards the camera) and the camera's
    height above the plane in depth units, or None when no plane fits. RANSAC with a residual relative to each point's
    distance (depth models err in proportion to distance), then a least-squares refit on the inliers.
    """
    h, w = depth.shape
    dirs = pixel_directions(h, w) if dirs is None else dirs
    lat = np.arcsin(np.clip(dirs[..., 1], -1, 1))
    pick = valid & np.isfinite(depth) & (depth > 0) & (lat < np.deg2rad(-15))
    if pick.sum() < 50:
        return None
    pts = (dirs[pick] * depth[pick][:, None]).astype(np.float64)
    rng = np.random.default_rng(seed)
    if len(pts) > 20000:
        pts = pts[rng.choice(len(pts), 20000, replace=False)]
    dist = np.linalg.norm(pts, axis=1)
    best, best_n = None, 0
    for _ in range(300):
        a, b, c = pts[rng.choice(len(pts), 3, replace=False)]
        n = np.cross(b - a, c - a)
        ln = np.linalg.norm(n)
        if ln < 1e-12:
            continue
        n = n / ln
        if n[1] < 0:
            n = -n
        if n[1] < math.cos(math.radians(30)):
            continue
        d = -n @ a  # plane n·x + d = 0; the camera (origin) is d above it
        if d <= 0:
            continue
        inl = np.abs(pts @ n + d) < 0.02 * dist
        k = int(inl.sum())
        if k > best_n:
            best, best_n = inl, k
    if best is None or best_n < max(50, 0.2 * len(pts)):
        return None
    q = pts[best]
    centre = q.mean(axis=0)
    _, _, vt = np.linalg.svd(q - centre, full_matrices=False)
    n = vt[-1]
    if n[1] < 0:
        n = -n
    d = -n @ centre
    if d <= 0:
        return None
    return n, float(d), best_n / len(pts)


def tilt_deg(normal):
    return math.degrees(math.acos(float(np.clip(normal[1], -1, 1))))


def levelling(normal):
    """The rotation that turns `normal` to straight up (Rodrigues); identity for None."""
    if normal is None:
        return np.eye(3)
    n = np.asarray(normal, dtype=np.float64) / np.linalg.norm(normal)
    up = np.array([0.0, 1.0, 0.0])
    axis = np.cross(n, up)
    s, c = np.linalg.norm(axis), float(n @ up)
    if s < 1e-12:
        return np.eye(3)
    k = axis / s
    kx = np.array([[0, -k[2], k[1]], [k[2], 0, -k[0]], [-k[1], k[0], 0]])
    return np.eye(3) + s * kx + (1 - c) * (kx @ kx)


def horizon_row(rot):
    """The horizon's row v at the panorama's centre column, once levelled by `rot` (0.5 when level)."""
    # The centre column's direction at latitude φ is (0, sin φ, -cos φ); levelled height (rot·d)_y = 0 there.
    r = rot[1]
    phi = math.atan2(r[2], r[1])
    return 0.5 - phi / math.pi


def horizon_distances(depth, valid, dirs, rot, band_deg=HORIZON_BAND_DEG):
    """Per image column, how far away (horizontally, in depth units) the horizon is; None when nothing is seen there.

    What stands on the horizon: the median of the valid pixels from the (levelled) horizon up to `band_deg` above it.
    Where nothing does (open sea, a plain), the farthest ground seen within `band_deg` below it. Columns with neither
    are filled from their neighbours (around the seam), then smoothed with a circular median so one stray pixel does
    not make a spike.
    """
    h, w = depth.shape
    lev = dirs @ rot.T
    lat = np.arcsin(np.clip(lev[..., 1], -1, 1))
    band = np.deg2rad(max(band_deg, 90.0 / h))  # at least a row's height
    ok = valid & np.isfinite(depth) & (depth > 0)
    hor = depth * np.cos(lat)
    above = ok & (lat >= 0) & (lat <= band)
    under = ok & (lat < 0) & (lat >= -band)
    with warnings.catch_warnings():
        warnings.simplefilter("ignore", RuntimeWarning)  # a column with nothing near the horizon: NaN, filled below
        stands = np.nanmedian(np.where(above, hor, np.nan), axis=0)
        ground = np.nanmax(np.where(under, hor, np.nan), axis=0)
    cols = np.where(np.isfinite(stands), stands, ground)
    have = np.isfinite(cols)
    if not have.any():
        return None
    if not have.all():
        idx = np.arange(w)
        known = idx[have]
        cols = np.interp(idx, np.concatenate([known - w, known, known + w]), np.tile(cols[have], 3))
    k = max(3, (w // 128) | 1)
    pad = np.concatenate([cols[-(k // 2):], cols, cols[: k // 2]])
    return np.median(np.lib.stride_tricks.sliding_window_view(pad, k), axis=1)


def analyse(depth, valid):
    """What the dome and the job's meta need from a depth map: the levelling, the horizon and the ground."""
    h, w = depth.shape
    dirs = pixel_directions(h, w)
    ground = fit_ground(depth, valid, dirs)
    if ground is not None and tilt_deg(ground[0]) > MAX_TILT_DEG:
        ground = None
    rot = levelling(ground[0] if ground else None)
    rh = horizon_distances(depth, valid, dirs, rot)
    ok = valid & np.isfinite(depth) & (depth > 0)
    if rh is not None:
        ref = float(np.median(rh))
    elif ok.any():
        ref = float(np.median(depth[ok]))
    else:
        ref = 1.0
    return {"rot": rot, "ground": ground, "horizon": horizon_row(rot), "horizon_distances": rh, "reference": ref,
            "tilt_deg": tilt_deg(ground[0]) if ground else 0.0}


# ── The depth PNG ────────────────────────────────────────────────────────────────────────────────────────────────

def encode_depth(depth, valid, metric, reference):
    """The depth as a 16-bit grey PNG: millimetres when metric (and it fits), else relative units × 1000.

    Relative units put the median horizon distance (`reference`, in depth units) at RELATIVE_HORIZON units. 0 is no
    depth (the sky); 65 535 is that far or farther. Returns (png bytes, "metric" | "relative", depth units per unit).
    """
    from PIL import Image
    ok = valid & np.isfinite(depth) & (depth > 0)
    p99 = float(np.percentile(depth[ok], 99)) if ok.any() else 0.0
    if metric and p99 <= METRIC_LIMIT_M:
        kind, unit = "metric", 1.0
    else:
        kind, unit = "relative", max(reference, 1e-9) / RELATIVE_HORIZON
    out = np.zeros(depth.shape, dtype=np.uint16)
    out[ok] = np.clip(np.round(depth[ok] / unit * 1000), 1, 65535).astype(np.uint16)
    buf = io.BytesIO()
    Image.fromarray(out).save(buf, format="PNG")
    return buf.getvalue(), kind, unit


# ── The dome ─────────────────────────────────────────────────────────────────────────────────────────────────────

def grid_rows(gh, eye=EYE, horizon_distance=HORIZON_DISTANCE):
    """The rows of vertices, as panorama rows v from 0 (the zenith) to 1 (the nadir).

    gh even rows (so the horizon, v = 0.5, is one), and a few more just below it, where the floor meets walls far
    away: a ray that far down reaches the floor at only eye / tan(angle), so a wall 100 units out is met 0.9° below
    the horizon, one 400 units out 0.23°. Without these rows the floor would slope up to the horizon instead of
    meeting the walls.
    """
    gh = max(4, gh + (gh % 2))
    v = list(np.arange(gh + 1) / gh)
    step = 1.0 / gh
    for far in (8, 4, 2, 1, 0.5, 0.25):
        lat = math.atan(eye / (horizon_distance * far))
        x = 0.5 + lat / math.pi
        if min(abs(x - y) for y in v) > 0.25 * step:
            v.append(x)
    return np.array(sorted(v))


def sample_grid(depth, valid, u, v):
    """Depth at the grid's vertices (rows v × columns u): the median of the valid pixels in a small window around
    each (wrapping around the seam), NaN where most of the window is sky."""
    h, w = depth.shape
    cols = np.floor(u * w).astype(int) % w            # the seam column (u = 1) is column 0 again
    rows = np.clip(np.floor(v * h).astype(int), 0, h - 1)
    a = max(0, (w // max(1, len(u) - 1)) // 2)
    b = max(0, (h // max(1, len(v) - 1)) // 2)
    off_c = np.arange(-a, a + 1)
    off_r = np.arange(-b, b + 1)
    cc = (cols[None, :, None, None] + off_c[None, None, None, :]) % w
    rr = np.clip(rows[:, None, None, None] + off_r[None, None, :, None], 0, h - 1)
    cc, rr = np.broadcast_arrays(cc, rr)
    d = depth[rr, cc].reshape(len(v), len(u), -1).astype(np.float64)
    ok = (valid & np.isfinite(depth) & (depth > 0))[rr, cc].reshape(len(v), len(u), -1)
    d = np.where(ok, d, np.nan)
    with warnings.catch_warnings():
        warnings.simplefilter("ignore", RuntimeWarning)  # all sky: NaN, which is what it should be
        med = np.nanmedian(d, axis=-1)
    med[ok.mean(axis=-1) < 0.5] = np.nan
    return med


def build_dome(depth, valid, grid=(256, 128), eye=EYE, horizon_distance=HORIZON_DISTANCE, sky_distance=SKY_DISTANCE, info=None):
    """The dome's vertices (N, 3), texture coordinates (N, 2), triangles (M, 3) and what was decided (a dict).

    `info` is analyse(depth, valid), if already made. The grid has gw columns (plus the seam column again, for the
    texture) and the rows of grid_rows(gh); its first and last rows are the two poles. Rows are vertex-major: vertex
    (row j, column i) is j · (gw + 1) + i.

    The dome is built in the panorama's own frame (not turned by the ground's tilt: a generated panorama is level,
    and a depth model's few tenths of a degree are noise): the floor is y = -eye and the horizon the middle row.
    """
    gw, gh = grid
    info = analyse(depth, valid) if info is None else info
    rh = info["horizon_distances"]
    h, w = depth.shape
    scale = horizon_distance / info["reference"] if info["reference"] > 0 else 1.0
    u = np.arange(gw + 1) / gw
    v = grid_rows(gh, eye, horizon_distance)
    cols = np.floor(u * w).astype(int) % w
    r_col = (rh[cols] * scale) if rh is not None else np.full(gw + 1, horizon_distance)
    r_col = np.clip(r_col, eye, sky_distance)
    grid_depth = sample_grid(depth, valid, u, v) * scale
    grid_depth = np.where(np.isfinite(grid_depth), np.clip(grid_depth, 1.0, sky_distance), sky_distance)

    lon, lat = lon_lat(u[None, :], v[:, None])
    lon, lat = np.broadcast_arrays(lon, lat)
    dirs = direction(lon, lat)
    pos = dirs * grid_depth[..., None]                  # at or above the horizon: each ray at its own depth
    below = lat < 0
    tan_down = np.tan(np.clip(-lat, 1e-12, np.pi / 2))
    floor_reach = eye / np.maximum(tan_down, 1e-12)     # how far out this ray meets the floor
    r = np.broadcast_to(r_col[None, :], lat.shape)
    on_floor = below & (floor_reach <= r)
    hd = np.where(on_floor, floor_reach, r)             # the floor, or the wall of what stands at the horizon
    y = np.where(on_floor, -eye, -hd * tan_down)
    low = np.stack([hd * np.sin(lon), y, -hd * np.cos(lon)], axis=-1)
    pos = np.where(below[..., None], low, pos)

    # The poles: one point each, so the dome closes there
    pos[0] = dirs[0, 0] * float(np.median(grid_depth[0]))
    pos[-1] = np.array([0.0, -eye, 0.0])                # straight down: the floor under the camera
    uv = np.stack(np.broadcast_arrays(u[None, :], v[:, None]), axis=-1).copy()
    uv[0, :, 0] = uv[-1, :, 0] = np.minimum(u + 0.5 / gw, 1.0)  # a pole's texel: the middle of its quad

    nr = len(v)
    idx = np.arange(nr * (gw + 1)).reshape(nr, gw + 1)
    tl, tr, bl, br = idx[:-1, :-1], idx[:-1, 1:], idx[1:, :-1], idx[1:, 1:]
    first = np.stack([tl, bl, br], axis=-1)             # counter-clockwise seen from the origin
    second = np.stack([tl, br, tr], axis=-1)
    # In the last row of quads `first` has two corners on the bottom pole, in the first row `second` two on the top
    # pole: those triangles have no area and are left out.
    faces = np.concatenate([first[:-1].reshape(-1, 3), second[1:].reshape(-1, 3)]).astype(np.uint32)
    ground = info["ground"]
    decided = {"horizon": info["horizon"], "tilt_deg": info["tilt_deg"], "scale": scale, "eye": eye,
               "horizon_distance": horizon_distance, "sky_distance": sky_distance, "rows": v, "columns": u,
               "ground_height": ground[1] if ground else None, "reference": info["reference"]}
    return pos.reshape(-1, 3).astype(np.float32), uv.reshape(-1, 2).astype(np.float32), faces, decided


# ── GLB ──────────────────────────────────────────────────────────────────────────────────────────────────────────

def _pad(b, fill=b"\x00"):
    return b + fill * ((4 - len(b) % 4) % 4)


def write_glb(positions, uvs, faces, texture_jpeg, extras=None):
    """One unlit textured mesh as a binary glTF 2.0 (written by hand: no library). The texture is the panorama."""
    positions = np.ascontiguousarray(positions, dtype=np.float32)
    uvs = np.ascontiguousarray(uvs, dtype=np.float32)
    faces = np.ascontiguousarray(faces, dtype=np.uint32)
    parts, views = [], []
    offset = 0
    for data, target in ((positions.tobytes(), 34962), (uvs.tobytes(), 34962), (faces.tobytes(), 34963), (texture_jpeg, None)):
        view = {"buffer": 0, "byteOffset": offset, "byteLength": len(data)}
        if target:
            view["target"] = target
        views.append(view)
        padded = _pad(data)
        parts.append(padded)
        offset += len(padded)
    binary = b"".join(parts)
    doc = {
        "asset": {"version": "2.0", "generator": "mux backdrop (server/backdrop/dome.py)", **({"extras": extras} if extras else {})},
        "extensionsUsed": ["KHR_materials_unlit"],
        "scene": 0,
        "scenes": [{"nodes": [0]}],
        "nodes": [{"mesh": 0, "name": "backdrop"}],
        "meshes": [{"name": "backdrop", "primitives": [{"attributes": {"POSITION": 0, "TEXCOORD_0": 1}, "indices": 2, "material": 0, "mode": 4}]}],
        "materials": [{"name": "backdrop", "doubleSided": False, "extensions": {"KHR_materials_unlit": {}},
                       "pbrMetallicRoughness": {"baseColorTexture": {"index": 0}, "metallicFactor": 0.0, "roughnessFactor": 1.0}}],
        "textures": [{"sampler": 0, "source": 0}],
        # Linear, mipmapped; wraps around the seam (S), clamps at the poles (T)
        "samplers": [{"magFilter": 9729, "minFilter": 9987, "wrapS": 10497, "wrapT": 33071}],
        "images": [{"bufferView": 3, "mimeType": "image/jpeg"}],
        "accessors": [
            {"bufferView": 0, "componentType": 5126, "count": len(positions), "type": "VEC3",
             "min": positions.min(axis=0).tolist(), "max": positions.max(axis=0).tolist()},
            {"bufferView": 1, "componentType": 5126, "count": len(uvs), "type": "VEC2"},
            {"bufferView": 2, "componentType": 5125, "count": int(faces.size), "type": "SCALAR"},
        ],
        "bufferViews": views,
        "buffers": [{"byteLength": len(binary)}],
    }
    js = _pad(json.dumps(doc, separators=(",", ":")).encode(), b" ")
    total = 12 + 8 + len(js) + 8 + len(binary)
    return b"".join([struct.pack("<4sII", b"glTF", 2, total), struct.pack("<I4s", len(js), b"JSON"), js,
                     struct.pack("<I4s", len(binary), b"BIN\x00"), binary])


def read_glb(data):
    """(the glTF JSON, the binary chunk): enough to check a GLB this module wrote."""
    magic, version, total = struct.unpack_from("<4sII", data, 0)
    if magic != b"glTF" or version != 2 or total != len(data):
        raise ValueError("not a glTF 2.0 binary")
    jlen, jtype = struct.unpack_from("<I4s", data, 12)
    if jtype != b"JSON":
        raise ValueError("the first chunk is not JSON")
    doc = json.loads(data[20:20 + jlen])
    blen, btype = struct.unpack_from("<I4s", data, 20 + jlen)
    if btype != b"BIN\x00":
        raise ValueError("the second chunk is not BIN")
    return doc, data[28 + jlen:28 + jlen + blen]


def accessor(doc, binary, i):
    """Accessor i of a GLB read by read_glb, as a numpy array."""
    a = doc["accessors"][i]
    view = doc["bufferViews"][a["bufferView"]]
    dtype = {5126: np.float32, 5125: np.uint32}[a["componentType"]]
    width = {"SCALAR": 1, "VEC2": 2, "VEC3": 3}[a["type"]]
    arr = np.frombuffer(binary, dtype=dtype, count=a["count"] * width, offset=view["byteOffset"])
    return arr.reshape(a["count"], width) if width > 1 else arr


def panorama_jpeg(rgb, quality=90):
    """The panorama (h, w, 3 uint8) as JPEG bytes, for the dome's texture."""
    from PIL import Image
    buf = io.BytesIO()
    Image.fromarray(np.asarray(rgb, dtype=np.uint8)).save(buf, format="JPEG", quality=quality)
    return buf.getvalue()


def dome_glb(rgb, depth, valid, grid=(256, 128), info=None):
    """The whole step: the panorama and its depth → (GLB bytes, what was decided)."""
    pos, uv, faces, decided = build_dome(depth, valid, grid=grid, info=info)
    extras = {"mux_backdrop": {"eye": decided["eye"], "horizonDistance": decided["horizon_distance"],
                               "skyDistance": decided["sky_distance"], "horizon": round(decided["horizon"], 4),
                               "groundTiltDeg": round(decided["tilt_deg"], 2), "grid": list(grid)}}
    return write_glb(pos, uv, faces, panorama_jpeg(rgb), extras), decided
