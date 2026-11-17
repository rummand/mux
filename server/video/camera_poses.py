"""Thread's Sets camera path → the camera input of LingBot-World v2 (docs/video-camera.md, "The pose mapping").

Pure numpy, no torch: the request validation and the tests use it without the model.

Sets (Thread's src/sets/setDoc.ts): metres, y up, a camera with no turn looks down −z, quaternions [x, y, z, w], camera
to world. Its axes are three.js/OpenGL camera axes: x right, y up, z backwards (out of the screen).

LingBot-World v2 (robbyant/lingbot-world-v2, wan/image2video.py and wan/utils/cam_utils.py): camera-to-world 4×4
matrices in the OpenCV convention (x right, y down, z forward), one per latent frame (every 4th video frame at 16 fps,
so one every 0.25 s), made relative to the first and then frame by frame (each pose in the previous camera's frame),
their translations divided by the largest step in the take; intrinsics fx fy cx cy in pixels of the output size, one
lens for the whole take (it reads Ks[0]).

So a Sets camera becomes an OpenCV one by flipping its y and z axes: R_cv = R_sets · diag(1, −1, −1), position kept.
The world's own axes (y up) cancel out, because the model only sees each pose relative to the one before.
"""
import math

import numpy as np

MODEL_FPS = 16        # LingBot-World v2 / Wan2.1 make 16 frames a second (wan_shared_cfg.sample_fps)
VAE_T = 4             # one latent frame for 4 video frames (Wan2.1 VAE, temporal stride 4)
CHUNK = 4             # latent frames made at once (generate.py --chunk_size, the default the README's commands use)
# mux's choice, not upstream's: the model divides every step by the largest in the take, so a camera that does not
# travel would have its shake blown up to full-size steps. Below 1 cm per latent frame (4 cm/s) a take counts as
# standing still and keeps its steps small. MUX_CAMERA_MIN_STEP_M changes it; 0 is upstream's behaviour.
MIN_STEP_M = 0.01

# Sets' frame aspects (setDoc.ts ASPECTS)
ASPECTS = {"16:9": 16 / 9, "2.39:1": 2.39, "1.85:1": 1.85, "4:3": 4 / 3, "1:1": 1.0, "4:5": 4 / 5, "9:16": 9 / 16}
FLIP_YZ = np.diag([1.0, -1.0, -1.0])


class PoseError(ValueError):
    """A camera path that cannot be used; the message names the field (the server answers 400 with it)."""


# ── quaternions ─────────────────────────────────────────────────────────────────────────────────────────────────

def quat_matrix(q):
    """[x, y, z, w] (unit) → 3×3 rotation matrix (columns: the camera's x, y, z axes in the world)."""
    x, y, z, w = q
    return np.array([
        [1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
        [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
        [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)],
    ])


def slerp(a, b, f):
    """Spherical interpolation along the shorter arc, as Sets' camera.ts slerp."""
    a, b = np.asarray(a, float), np.asarray(b, float)
    cos = float(a @ b)
    if cos < 0:
        b, cos = -b, -cos
    if cos > 0.9995:
        q = a + (b - a) * f
        return q / np.linalg.norm(q)
    th = math.acos(min(1.0, cos))
    s = math.sin(th)
    return a * (math.sin((1 - f) * th) / s) + b * (math.sin(f * th) / s)


# ── the request's camera ────────────────────────────────────────────────────────────────────────────────────────

def _num(v, what, lo=-1e5, hi=1e5):
    if isinstance(v, bool) or not isinstance(v, (int, float)) or not math.isfinite(v) or not lo <= v <= hi:
        raise PoseError(f"{what} must be a number from {lo:g} to {hi:g}")
    return float(v)


def _vec(v, n, what, lo=-1e5, hi=1e5):
    if not isinstance(v, (list, tuple)) or len(v) != n:
        raise PoseError(f"{what} must be [{', '.join('xyzw'[:n] if n <= 4 else 'n' * n)}]")
    return [_num(x, f"{what}[{i}]", lo, hi) for i, x in enumerate(v)]


def read_camera(cam, max_frames=4000):
    """The request's `camera` → {sensor, aspect, principal, frames: [(t, pos, quat, focal)] sorted by t}."""
    if not isinstance(cam, dict):
        raise PoseError("camera is required: {convention: \"sets\", sensorMm, aspect, frames: [{t, pos, quat, focalMm}]}")
    if cam.get("convention") != "sets":
        raise PoseError('camera.convention must be "sets" (metres, y up, a camera with no turn looks down -z)')
    sensor = _vec(cam.get("sensorMm"), 2, "camera.sensorMm", 1, 100)
    aspect = cam.get("aspect")
    if aspect not in ASPECTS:
        raise PoseError(f"camera.aspect must be one of {', '.join(ASPECTS)}")
    principal = cam.get("principal", [0.5, 0.5])
    principal = _vec(principal, 2, "camera.principal", 0, 1)
    frames = cam.get("frames")
    if not isinstance(frames, list) or not frames:
        raise PoseError("camera.frames must be a list of at least one {t, pos, quat, focalMm}")
    if len(frames) > max_frames:
        raise PoseError(f"camera.frames has more than {max_frames} frames")
    out = []
    for i, f in enumerate(frames):
        if not isinstance(f, dict):
            raise PoseError(f"camera.frames[{i}] must be an object")
        t = _num(f.get("t"), f"camera.frames[{i}].t", 0, 3600)
        pos = np.array(_vec(f.get("pos"), 3, f"camera.frames[{i}].pos"))
        q = np.array(_vec(f.get("quat"), 4, f"camera.frames[{i}].quat", -1.5, 1.5))
        n = float(np.linalg.norm(q))
        if not 0.9 < n < 1.1:
            raise PoseError(f"camera.frames[{i}].quat must be a unit quaternion [x, y, z, w] (its length is {n:.3f})")
        focal = _num(f.get("focalMm"), f"camera.frames[{i}].focalMm", 1, 2000)
        out.append((t, pos, q / n, focal))
    out.sort(key=lambda r: r[0])
    return {"sensor": sensor, "aspect": aspect, "principal": principal, "frames": out}


def sample(frames, t):
    """The pose at time t: position and focal length linear, rotation slerp between the two frames around t; before
    the first and after the last the camera holds. Send the path already sampled at fps (as Sets plays it, with its
    curves, eases and shake) and this only fills the gaps between frames."""
    if t <= frames[0][0]:
        return frames[0][1], frames[0][2], frames[0][3]
    if t >= frames[-1][0]:
        return frames[-1][1], frames[-1][2], frames[-1][3]
    lo, hi = 0, len(frames) - 1
    while hi - lo > 1:
        mid = (lo + hi) // 2
        if frames[mid][0] <= t:
            lo = mid
        else:
            hi = mid
    (ta, pa, qa, fa), (tb, pb, qb, fb) = frames[lo], frames[hi]
    f = 0.0 if tb <= ta else (t - ta) / (tb - ta)
    return pa + (pb - pa) * f, slerp(qa, qb, f), fa + (fb - fa) * f


def opencv_c2w(pos, quat):
    """A Sets camera (pos, quat) → the 4×4 OpenCV camera-to-world matrix LingBot reads (poses.npy)."""
    m = np.eye(4)
    m[:3, :3] = quat_matrix(quat) @ FLIP_YZ
    m[:3, 3] = pos
    return m


def framewise(c2ws):
    """Each pose in the camera frame of the one before; the first is the identity (cam_utils.compute_relative_poses
    with framewise=True, before its normalisation)."""
    out = np.empty_like(c2ws)
    out[0] = np.eye(4)
    for i in range(1, len(c2ws)):
        out[i] = np.linalg.inv(c2ws[i - 1]) @ c2ws[i]
    return out


def intrinsics(sensor, aspect, focal, width, height, principal=(0.5, 0.5)):
    """fx, fy, cx, cy in pixels of the output, as Sets' pinholeOf: the frame is the sensor cut to the aspect."""
    sw, sh = sensor
    a = ASPECTS[aspect]
    fw, fh = (sh * a, sh) if sw / sh >= a else (sw, sw / a)
    return focal / fw * width, focal / fh * height, principal[0] * width, principal[1] * height


# ── the take, planned ───────────────────────────────────────────────────────────────────────────────────────────

def latent_frames_for(n_frames):
    """Latent frames, a whole number of chunks, that cover n video frames (the first latent is 1 frame, then 4 each)."""
    lat = 1 + math.ceil(max(0, n_frames - 1) / VAE_T)
    return math.ceil(lat / CHUNK) * CHUNK


def plan(cam, seconds, width, height, anchor_times=(), min_step_m=MIN_STEP_M):
    """The take as the model will make it.

    Returns {frames: video frames at 16 fps, K: (fx, fy, cx, cy), segments: [{start, frames, deltas}], notes, scale}.
    A segment starts at 0 and at every anchor: the model starts again from the anchor's picture there, so drift is cut
    off (and the cut can show). Its `deltas` are [latent frames, 4, 4] framewise OpenCV poses, translations already
    divided by the take's largest step (one scale for the whole take, so segments keep their relative speeds).
    """
    frames = cam["frames"]
    total = max(1, round(seconds * MODEL_FPS))
    focal0 = frames[0][3]
    notes = []
    if any(abs(f[3] - focal0) > 0.01 * focal0 for f in frames):
        notes.append(f"the lens changes during the take; the model takes one lens for a take, so all of it uses {focal0:g} mm (the first frame's)")
    K = intrinsics(cam["sensor"], cam["aspect"], focal0, width, height, cam["principal"])
    starts = [0] + sorted({max(1, min(total - 1, round(t * MODEL_FPS))) for t in anchor_times if t > 0})
    starts = sorted(set(s for s in starts if s < total))
    segs = []
    for i, s in enumerate(starts):
        n = (starts[i + 1] if i + 1 < len(starts) else total) - s
        lat = latent_frames_for(n)
        times = [(s + VAE_T * j) / MODEL_FPS for j in range(lat)]
        c2ws = np.stack([opencv_c2w(*sample(frames, t)[:2]) for t in times])
        segs.append({"start": s, "frames": n, "latent": lat, "deltas": framewise(c2ws)})
    steps = np.concatenate([np.linalg.norm(sg["deltas"][:, :3, 3], axis=1) for sg in segs])
    biggest = float(steps.max()) if steps.size else 0.0
    scale = max(biggest, min_step_m)
    if scale > 0:
        for sg in segs:
            sg["deltas"][:, :3, 3] /= scale
    if 0 < biggest < min_step_m:
        notes.append(f"the camera travels under {min_step_m * 100:g} cm per quarter second: treated as standing (its shake is kept small)")
    return {"frames": total, "K": K, "segments": segs, "notes": notes, "scale": scale}


def resample(n_model, fps, seconds):
    """For each output frame at `fps`, the model frame (16 fps) shown: the nearest one. 16 fps maps one to one."""
    n_out = max(1, round(seconds * fps))
    return [min(n_model - 1, int(math.floor(k * MODEL_FPS / fps + 0.5))) for k in range(n_out)]
