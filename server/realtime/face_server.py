"""mux's face sidecar: Bloom's talking face for /v1/realtime sessions that ask for it (session.start face: true).

    ~/.mux/face-venv/bin/python server/realtime/face_server.py --port 8324 --identity ~/.mux/face/bloom
    ~/.mux/face-venv/bin/python server/realtime/face_server.py --identity ~/.mux/face/bloom --bench speech.wav

MuseTalk 1.5 on MLX (xocialize/musetalk-mlx, weights mlx-community/MuseTalk-1.5-q8) regenerates the lower half of one
fixed face, Bloom's, from Bloom's speech: a single UNet pass per frame, no denoising loop. Around it this server draws a
face that is never frozen: an idle loop (blinks, a slow small sway of the head), a listening variant while the person
talks (small nods, a glance aside and back) and, while Bloom speaks, the lip-synced mouth with the same head motion.
The motion is procedural 2D (an affine warp of the whole picture, a blink blended over the eyes): it is not a listening
model (AVTR-1 and Avatar Forcing are, and need CUDA; docs/face.md).

One WebSocket per voice session at ws://127.0.0.1:8324/face, one session at a time (a second is refused: MuseTalk at
~34 faces/s on the Mac covers one real-time stream). mux sends

    {"type":"start","size":384,"fps":25,"format":"jpeg"|"webp"}
    {"type":"state","mode":"idle"|"listening"}           the person's speech (vad.start → listening, turn.end → idle)
    {"type":"speech","response_id":…,"sample_rate":24000,"audio":base64 pcm16}   Bloom's speech, as the caller got it
    {"type":"speech.end","response_id":…}                that answer's speech is complete
    {"type":"cancel","response_id":…}                    barge-in: drop its frames now
    {"type":"end"}

and this answers {"type":"ready","fps","width","height","format","identity","model"}, then binary frames: 4 bytes
(big-endian) of JSON header length, the header {"response_id","index","pts_ms","mode","format"}, then the picture.
Speaking frames have pts_ms on their answer's audio clock (frame n shows the audio at n·1000/fps ms); idle and
listening frames have response_id null and pts_ms since start (paced at fps in real time). After speech.end:
{"type":"speech.done","response_id","frames","audio_ms"}.

GET /v1/models → {"data":[{"id":"musetalk-1.5-mlx","loaded":bool,"need_gb":n}]}: mux's memory floor reads need_gb
before it admits a session. MuseTalk loads on the first session and the process exits after --idle-exit seconds with
none; launchd (KeepAlive) starts it again, unloaded. Every MLX call runs on one thread (MLX keeps its GPU streams per
thread), and MLX's buffer cache is capped and emptied after each answer (what grew com.mux.images to 70 GB).

Licences (docs/face.md): MuseTalk 1.5 code and weights MIT (TMElyralab); the MLX port says MIT in pyproject.toml and its
model card but has no LICENSE file; sd-vae-ft-mse (Stability AI) MIT; whisper-tiny (OpenAI) Apache-2.0; OpenCV Apache-2.0.
The face is Bloom's own synthetic identity (deploy/face.sh), never a real person's likeness. Nothing is logged or kept.
"""

from __future__ import annotations

import argparse
import asyncio
import base64
import concurrent.futures
import json
import logging
import math
import os
import struct
import sys
import time
from dataclasses import dataclass, field

import numpy as np

log = logging.getLogger("mux.face")
SR = 16_000  # MuseTalk's whisper-tiny hears 16 kHz
LOOKAHEAD_MS = 80  # a frame's audio window reaches 2 audio-frames (80 ms at 25 fps) past it
CONTEXT_MS = 1000  # audio before a batch given to the encoder, so its first frame has its left context
PAUSE_S = 0.25  # no speech this long mid-answer (a tool running, a slow sentence): the mouth closes and the face idles
MODEL_ID = "musetalk-1.5-mlx"


# ---------------------------------------------------------------------------------------------------- the identity


@dataclass
class Identity:
    """Bloom's face: one picture, its face box, and optionally the same picture with the eyes closed (for blinks)."""

    name: str
    image: np.ndarray  # BGR uint8, square
    box: tuple[int, int, int, int]  # x1, y1, x2, y2 of the face in `image`
    eyes: list[tuple[int, int, int, int]] = field(default_factory=list)
    blink: np.ndarray | None = None

    @classmethod
    def load(cls, folder: str) -> "Identity":
        import cv2

        meta = json.load(open(os.path.join(folder, "identity.json")))
        img = cv2.imread(os.path.join(folder, meta.get("image", "face.png")), cv2.IMREAD_COLOR)
        if img is None:
            raise RuntimeError(f"no face picture in {folder}")
        blink = None
        if meta.get("blink") and os.path.isfile(os.path.join(folder, meta["blink"])):
            blink = cv2.imread(os.path.join(folder, meta["blink"]), cv2.IMREAD_COLOR)
            if blink is not None and blink.shape != img.shape:
                blink = cv2.resize(blink, (img.shape[1], img.shape[0]))
        return cls(meta.get("name", "bloom"), img, tuple(meta["box"]), [tuple(e) for e in meta.get("eyes", [])], blink)


def detect_box(img: np.ndarray) -> tuple[tuple[int, int, int, int], list[tuple[int, int, int, int]]]:
    """The face box (and eye boxes) of the identity picture, found once at deploy with OpenCV's Haar cascades
    (Apache-2.0, in opencv-python): upstream MuseTalk uses S3FD and DWPose, which a single still frontal portrait does
    not need. The box is squared and widened as MuseTalk's crop expects (chin included)."""
    import cv2

    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    faces = cv2.CascadeClassifier(cv2.data.haarcascades + "haarcascade_frontalface_default.xml").detectMultiScale(gray, 1.1, 5, minSize=(96, 96))
    if not len(faces):
        raise RuntimeError("no face found in the identity picture: it must be one frontal face")
    x, y, w, h = max(faces, key=lambda f: f[2] * f[3])
    # Haar's box stops above the chin: grow it down and a little to the sides
    x1, x2 = max(0, int(x - 0.05 * w)), min(img.shape[1], int(x + 1.05 * w))
    y1, y2 = max(0, int(y + 0.02 * h)), min(img.shape[0], int(y + 1.15 * h))
    eyes_found = cv2.CascadeClassifier(cv2.data.haarcascades + "haarcascade_eye.xml").detectMultiScale(gray[y : y + h // 2, x : x + w], 1.1, 6)
    eyes = sorted([(int(x + ex), int(y + ey), int(x + ex + ew), int(y + ey + eh)) for ex, ey, ew, eh in eyes_found])[:2]
    return (x1, y1, x2, y2), eyes


# ---------------------------------------------------------------------------------------------------- the renderers


class MuseTalkRenderer:
    """MuseTalk 1.5 on MLX: 16 kHz audio and frame numbers in, 256² lower-face crops out. Used from one thread only."""

    name = MODEL_ID

    def __init__(self, weights: str, identity: Identity, cache_gb: float):
        self.weights, self.identity, self.cache_gb = weights, identity, cache_gb
        self.pipe = None
        self.latent = None

    def load(self):
        import cv2
        import mlx.core as mx
        from musetalk_mlx.pipeline_mlx import MuseTalkPipeline

        t0 = time.time()
        mx.set_default_device(mx.gpu)
        try:
            mx.set_cache_limit(int(self.cache_gb * 1e9))
        except AttributeError:  # older MLX
            mx.metal.set_cache_limit(int(self.cache_gb * 1e9))
        self.pipe = MuseTalkPipeline.from_pretrained_mlx(self.weights)
        x1, y1, x2, y2 = crop_box(self.identity)
        crop = cv2.resize(self.identity.image[y1:y2, x1:x2], (256, 256), interpolation=cv2.INTER_LANCZOS4)
        # One still reference: its masked + reference latents are the same for every frame, so they are made once
        self.latent = self.pipe.get_latents_for_unet(crop)
        mx.eval(self.latent)
        log.info("MuseTalk loaded in %.1f s from %s", time.time() - t0, self.weights)

    def lips(self, audio: np.ndarray, ids: list[int], fps: int) -> list[np.ndarray]:
        """The crops for frames `ids` (consecutive) of an answer whose 16 kHz audio so far is `audio`."""
        import mlx.core as mx
        from musetalk_mlx.whisper.audio2feature import get_whisper_chunk
        from musetalk_mlx.whisper.log_mel import log_mel_spectrogram

        per = SR / fps
        first = max(0, ids[0] - int(CONTEXT_MS * fps / 1000))
        s0 = int(round(first * per))
        window = audio[s0:]
        mel = log_mel_spectrogram(mx.array(window.astype(np.float32)))  # pads to 30 s: a window is ≤ ~1.5 s
        feats = self.pipe.whisper_encoder(mel)
        chunks = get_whisper_chunk(feats, len(window), fps=fps)  # (frames in window, 50, 384)
        local = [i - first for i in ids]
        local = [min(i, chunks.shape[0] - 1) for i in local]
        batch = chunks[mx.array(local)]
        lat = mx.repeat(self.latent, len(ids), axis=0)
        dtype = getattr(self.pipe, "_dtype", mx.float16)
        faces = self.pipe.generate_faces(lat.astype(dtype), batch.astype(dtype))
        return [faces[i] for i in range(len(ids))]

    def after_answer(self):
        import mlx.core as mx

        try:
            mx.clear_cache()
        except AttributeError:
            mx.metal.clear_cache()

    def peak_gb(self) -> float:
        import mlx.core as mx

        try:
            return mx.get_peak_memory() / 1e9
        except AttributeError:
            return mx.metal.get_peak_memory() / 1e9


class StillRenderer:
    """No model: the reference's own lower face (the tests, and --renderer still to check the motion alone)."""

    name = "still"

    def __init__(self, identity: Identity, delay_s: float = 0.0):
        self.identity, self.delay_s = identity, delay_s
        self.calls: list[list[int]] = []

    def load(self):
        pass

    def lips(self, audio: np.ndarray, ids: list[int], fps: int) -> list[np.ndarray]:
        import cv2

        self.calls.append(list(ids))
        if self.delay_s:
            time.sleep(self.delay_s)
        x1, y1, x2, y2 = crop_box(self.identity)
        crop = cv2.resize(self.identity.image[y1:y2, x1:x2], (256, 256))
        return [crop] * len(ids)

    def after_answer(self):
        pass

    def peak_gb(self) -> float:
        return 0.0


def crop_box(idn: Identity) -> tuple[int, int, int, int]:
    """MuseTalk 1.5's crop: the face box with 10 px more below the chin (upstream's extra_margin), squared."""
    x1, y1, x2, y2 = idn.box
    y2 = min(idn.image.shape[0], y2 + 10)
    return x1, y1, x2, y2


# ---------------------------------------------------------------------------------------------------- the picture


class Composer:
    """Puts a frame together: the lip-synced lower face pasted back with a feathered mask (upstream uses face parsing;
    one still frontal face needs only an ellipse over the mouth and jaw), a blink over the eyes, the head motion, the
    output size, and the encoding."""

    def __init__(self, idn: Identity, size: int, fmt: str, quality: int = 82):
        import cv2

        self.size, self.fmt, self.quality = size, fmt, quality
        # Work at ~1.25× the output, not at the identity's 1024²: a full-size float blend and warp per frame costs
        # ~25–35 ms (measured on a 4-core Linux box), most of a 40 ms frame at 25 fps
        work = min(idn.image.shape[0], int(round(size * 1.25)))
        if work < idn.image.shape[0]:
            k = work / idn.image.shape[0]
            sc = lambda b: tuple(int(round(v * k)) for v in b)  # noqa: E731
            idn = Identity(idn.name, cv2.resize(idn.image, (work, work), interpolation=cv2.INTER_AREA), sc(idn.box), [sc(e) for e in idn.eyes],
                           None if idn.blink is None else cv2.resize(idn.blink, (work, work), interpolation=cv2.INTER_AREA))
        self.idn = idn
        self.base = idn.image.astype(np.float32)
        x1, y1, x2, y2 = crop_box(idn)
        self.crop = (x1, y1, x2, y2)
        w, h = x2 - x1, y2 - y1
        m = np.zeros((h, w), np.float32)
        cv2.ellipse(m, (w // 2, int(h * 0.74)), (int(w * 0.36), int(h * 0.27)), 0, 0, 360, 1.0, -1)
        k = max(3, (w // 10) | 1)
        self.mask = cv2.GaussianBlur(m, (k, k), 0)[..., None]
        # Blinks: the eye-closed picture over the eye boxes, feathered; none when the identity has no blink picture
        self.eye_mask = None
        if idn.blink is not None and idn.eyes:
            em = np.zeros(idn.image.shape[:2], np.float32)
            for ex1, ey1, ex2, ey2 in idn.eyes:
                cx, cy = (ex1 + ex2) // 2, (ey1 + ey2) // 2
                cv2.ellipse(em, (cx, cy), (int((ex2 - ex1) * 0.7), int((ey2 - ey1) * 0.6)), 0, 0, 360, 1.0, -1)
            kk = max(3, ((idn.eyes[0][2] - idn.eyes[0][0]) // 3) | 1)
            self.eye_mask = cv2.GaussianBlur(em, (kk, kk), 0)[..., None]
            self.blink = idn.blink.astype(np.float32)

    def compose(self, lips: np.ndarray | None, lips_alpha: float, pose: "Pose") -> bytes:
        import cv2

        img = self.base.copy()
        if pose.blink > 0 and self.eye_mask is not None:
            a = self.eye_mask * pose.blink
            img = img * (1 - a) + self.blink * a
        if lips is not None and lips_alpha > 0:
            x1, y1, x2, y2 = self.crop
            region = cv2.resize(lips, (x2 - x1, y2 - y1), interpolation=cv2.INTER_LINEAR).astype(np.float32)
            a = self.mask * lips_alpha
            img[y1:y2, x1:x2] = img[y1:y2, x1:x2] * (1 - a) + region * a
        h, w = img.shape[:2]
        cx, cy = (self.idn.box[0] + self.idn.box[2]) / 2, (self.idn.box[1] + self.idn.box[3]) / 2
        M = cv2.getRotationMatrix2D((cx, cy), pose.roll_deg, pose.scale)
        M[0, 2] += pose.dx * w / 512
        M[1, 2] += pose.dy * h / 512
        img = cv2.warpAffine(np.clip(img, 0, 255).astype(np.uint8), M, (w, h), flags=cv2.INTER_LINEAR, borderMode=cv2.BORDER_REFLECT)
        if (w, h) != (self.size, self.size):
            img = cv2.resize(img, (self.size, self.size), interpolation=cv2.INTER_AREA)
        if self.fmt == "webp":
            ok, buf = cv2.imencode(".webp", img, [cv2.IMWRITE_WEBP_QUALITY, self.quality])
        else:
            ok, buf = cv2.imencode(".jpg", img, [cv2.IMWRITE_JPEG_QUALITY, self.quality])
        if not ok:
            raise RuntimeError("could not encode a frame")
        return buf.tobytes()


@dataclass
class Pose:
    dx: float = 0.0  # px at 512
    dy: float = 0.0
    roll_deg: float = 0.0
    scale: float = 1.0
    blink: float = 0.0  # 0 open … 1 closed


class Motion:
    """The head's motion, as a function of time and mode: never still, never a loop the eye catches.

    idle: a slow sway (sums of incommensurate sines, ~1.5 px, ~0.6°) and a blink every 2.5–6 s (~150 ms).
    listening: the same, plus a small nod now and then (a dip of ~4 px and back, 0.5 s) and a glance aside and back.
    speaking: the sway a little livelier, following the voice's loudness (a speaker's head moves with stress)."""

    def __init__(self, seed: int = 7):
        self.rng = np.random.default_rng(seed)
        self.next_blink = 1.5
        self.blink_at = -10.0
        self.next_nod = 1.2
        self.nod_at = -10.0
        self.glance_at = -10.0
        self.glance_dir = 1.0
        self.next_glance = 3.0

    def pose(self, t: float, mode: str, loudness: float = 0.0) -> Pose:
        if t >= self.next_blink:
            self.blink_at = t
            self.next_blink = t + float(self.rng.uniform(2.5, 6.0))
        bt = t - self.blink_at
        blink = math.sin(math.pi * bt / 0.15) if 0 <= bt < 0.15 else 0.0
        amp = 1.0 if mode == "idle" else 1.1 if mode == "listening" else 1.5 + 2.0 * min(1.0, loudness * 6)
        dx = amp * (0.9 * math.sin(t * 0.61) + 0.5 * math.sin(t * 1.37 + 1.1))
        dy = amp * (0.7 * math.sin(t * 0.83 + 0.4) + 0.3 * math.sin(t * 1.91))
        roll = 0.35 * amp * math.sin(t * 0.47 + 2.0)
        if mode == "listening":
            if t >= self.next_nod:
                self.nod_at = t
                self.next_nod = t + float(self.rng.uniform(1.6, 3.8))
            nt = t - self.nod_at
            if 0 <= nt < 0.5:
                dy += 4.0 * math.sin(math.pi * nt / 0.5)
            if t >= self.next_glance:
                self.glance_at = t
                self.glance_dir = float(self.rng.choice([-1.0, 1.0]))
                self.next_glance = t + float(self.rng.uniform(3.0, 7.0))
            gt = t - self.glance_at
            if 0 <= gt < 1.2:
                dx += self.glance_dir * 3.0 * math.sin(math.pi * gt / 1.2)
                roll += self.glance_dir * 0.4 * math.sin(math.pi * gt / 1.2)
        return Pose(dx, dy, roll, 1.0 + 0.004 * math.sin(t * 0.29), blink)


# ---------------------------------------------------------------------------------------------------- one session


def resample_to_16k(pcm: np.ndarray, rate: int) -> np.ndarray:
    """pcm16 at `rate` → float32 at 16 kHz (linear: whisper-tiny's mel of speech does not need better)."""
    x = pcm.astype(np.float32) / 32768.0
    if rate == SR or not len(x):
        return x
    n = int(round(len(x) * SR / rate))
    return np.interp(np.arange(n) * (rate / SR), np.arange(len(x)), x).astype(np.float32)


@dataclass
class Answer:
    rid: str
    audio: np.ndarray = field(default_factory=lambda: np.zeros(0, np.float32))
    made: int = 0  # frames made
    ended: bool = False
    cancelled: bool = False
    started_wall: float = 0.0
    base: float = 0.0  # the motion's time (s since the session began) at this answer's audio time 0
    last_audio: float = 0.0  # wall time its last piece of speech arrived
    paused: bool = False  # no speech for PAUSE_S mid-answer: its frames are flushed and the face idles
    resume: bool = False  # speech came back after a pause

    @property
    def audio_ms(self) -> float:
        return len(self.audio) * 1000 / SR


class FaceSession:
    """One session's face: idle and listening frames in real time, speaking frames as Bloom's audio arrives."""

    def __init__(self, renderer, identity: Identity, pool: concurrent.futures.ThreadPoolExecutor, send, size=384, fps=25, fmt="jpeg", first_batch=2, batch=8):
        self.r, self.pool, self.send = renderer, pool, send
        self.fps = int(fps)
        self.comp = Composer(identity, int(size), fmt)
        self.fmt = fmt
        self.motion = Motion()
        self.mode = "idle"
        self.t0 = time.monotonic()
        self.index = 0
        self.answers: dict[str, Answer] = {}
        self.order: list[str] = []  # answers in the order their speech began
        self.wake = asyncio.Event()
        self.first_batch, self.batch = first_batch, batch
        self.last_lips: np.ndarray | None = None
        self.fade = 0  # idle frames left in the fade from the last mouth back to the reference's
        self.closed = False
        self.frames_sent = 0

    # -- from mux
    def state(self, mode: str):
        if mode in ("idle", "listening"):
            self.mode = mode

    def speech(self, rid: str, pcm16: bytes, rate: int):
        a = self.answers.get(rid)
        if a is None:
            if rid in self.order:
                return  # cancelled or done: late audio is ignored
            now = time.monotonic()
            a = self.answers[rid] = Answer(rid, started_wall=now, base=now - self.t0)
            self.order.append(rid)
        if a.cancelled or a.ended:
            return
        a.last_audio = time.monotonic()
        if a.paused:
            a.paused, a.resume = False, True
        a.audio =np.concatenate([a.audio, resample_to_16k(np.frombuffer(pcm16, dtype="<i2"), rate)])
        self.wake.set()

    def speech_end(self, rid: str):
        a = self.answers.get(rid)
        if a:
            a.ended = True
            self.wake.set()
        elif rid not in self.order:  # an answer with no audio: nothing to show, done at once
            self.order.append(rid)
            asyncio.ensure_future(self.send(json.dumps({"type": "speech.done", "response_id": rid, "frames": 0, "audio_ms": 0})))

    def cancel(self, rid: str):
        a = self.answers.pop(rid, None)
        if a:
            a.cancelled = True
        if rid not in self.order:
            self.order.append(rid)
        self.wake.set()

    # -- out
    def _speaking(self) -> Answer | None:
        for rid in self.order:
            a = self.answers.get(rid)
            if a and not a.cancelled:
                return a
        return None

    async def _frame(self, rid, pts_ms: float, mode: str, picture: bytes):
        head = json.dumps({"response_id": rid, "index": self.index, "pts_ms": round(pts_ms, 1), "mode": mode, "format": self.fmt}).encode()
        self.index += 1
        self.frames_sent += 1
        await self.send(struct.pack(">I", len(head)) + head + picture)

    async def run(self):
        """Until closed: speak when there is speech to show, else idle or listen at fps in real time."""
        period = 1.0 / self.fps
        next_idle = time.monotonic()
        while not self.closed:
            a = self._speaking()
            if a is not None:
                if await self._speak_some(a):
                    next_idle = time.monotonic() + period
                    continue
                quiet = time.monotonic() - a.last_audio
                if not a.paused and quiet < PAUSE_S:
                    # between two sentences: wait a moment for the next one before calling it a pause
                    self.wake.clear()
                    try:
                        await asyncio.wait_for(self.wake.wait(), timeout=PAUSE_S - quiet)
                    except asyncio.TimeoutError:
                        pass
                    continue
                if not a.paused:
                    # A pause mid-answer (a tool running, a slow sentence): the mouth finishes what it has heard and
                    # closes, and the face idles (response_id null) until the voice comes back
                    await self._speak_some(a, flush=True)
                    a.paused = True
                    self.fade = 4
                    continue
            now = time.monotonic()
            if now < next_idle:
                self.wake.clear()
                try:
                    await asyncio.wait_for(self.wake.wait(), timeout=next_idle - now)
                except asyncio.TimeoutError:
                    pass
                continue
            next_idle = max(next_idle + period, now - period)  # keep the beat, never a burst after a stall
            t = now - self.t0
            lips, alpha = None, 0.0
            if self.fade > 0 and self.last_lips is not None:
                alpha = self.fade / 4
                lips = self.last_lips
                self.fade -= 1
            picture = await asyncio.get_running_loop().run_in_executor(None, self.comp.compose, lips, alpha, self.motion.pose(t, self.mode))
            await self._frame(None, t * 1000, self.mode, picture)

    async def _speak_some(self, a: Answer, flush: bool = False) -> bool:
        """Make the next batch of `a`'s frames whose audio (with its lookahead) is here; at its end (or a pause:
        `flush`), every frame of the audio heard, with silence after it, and at its end speech.done."""
        per_ms = 1000 / self.fps
        have = a.audio_ms
        whole = a.ended or flush
        ready = int(math.floor(have / per_ms)) if whole else int(max(0, math.floor((have - LOOKAHEAD_MS) / per_ms)))
        if a.ended and ready <= a.made:
            await self._finish(a)
            return True
        made = False
        while ready > a.made and not (a.cancelled or self.closed):
            n = min(ready - a.made, self.first_batch if a.made == 0 else self.batch)
            await self._batch(a, n, whole)
            made = True
            if not whole:
                break
        return made

    async def _batch(self, a: Answer, n: int, pad: bool):
        per_ms = 1000 / self.fps
        ids = list(range(a.made, a.made + n))
        audio = a.audio
        if pad:  # the last frames before an end or a pause: silence after the speech, so the encoder's window is whole
            audio = np.concatenate([audio, np.zeros(int(SR * (LOOKAHEAD_MS + 120) / 1000), np.float32)])
        if a.resume:
            # back from a pause: the head goes on from where it is now rather than jumping back to the answer's clock
            a.base = (time.monotonic() - self.t0) - ids[0] * per_ms / 1000
            a.resume = False
        loop = asyncio.get_running_loop()
        crops = await loop.run_in_executor(self.pool, self.r.lips, audio, ids, self.fps)
        if a.cancelled or self.closed:
            return  # barge-in while the batch rendered: thrown away
        for i, crop in zip(ids, crops):
            pts = i * per_ms
            s0, s1 = int(pts * SR / 1000), int((pts + per_ms) * SR / 1000)
            loud = float(np.sqrt(np.mean(a.audio[s0:s1] ** 2))) if s1 > s0 and s0 < len(a.audio) else 0.0
            t = a.base + pts / 1000
            picture = await loop.run_in_executor(None, self.comp.compose, crop, 1.0, self.motion.pose(t, "speaking", loud))
            if a.cancelled or self.closed:
                return
            await self._frame(a.rid, pts, "speaking", picture)
            self.last_lips = crop
        a.made += n

    async def _finish(self, a: Answer):
        self.answers.pop(a.rid, None)
        await self.send(json.dumps({"type": "speech.done", "response_id": a.rid, "frames": a.made, "audio_ms": round(a.audio_ms)}))
        self.fade = 4
        await asyncio.get_running_loop().run_in_executor(self.pool, self.r.after_answer)


# ---------------------------------------------------------------------------------------------------- the server


class Server:
    def __init__(self, args, renderer=None, identity: Identity | None = None):
        self.args = args
        self.identity = identity
        self.renderer = renderer
        self.loaded = False
        self.pool = concurrent.futures.ThreadPoolExecutor(max_workers=1, thread_name_prefix="mlx")  # one MLX thread
        self.busy = asyncio.Lock()
        self.last_used = time.time()

    async def ensure(self):
        if self.loaded:
            return
        if self.identity is None:
            self.identity = Identity.load(self.args.identity)
        if self.renderer is None:
            self.renderer = MuseTalkRenderer(self.args.weights, self.identity, self.args.cache_gb) if self.args.renderer == "musetalk" else StillRenderer(self.identity)
        await asyncio.get_running_loop().run_in_executor(self.pool, self.renderer.load)
        self.loaded = True

    def models(self) -> dict:
        return {"data": [{"id": MODEL_ID, "loaded": self.loaded, "need_gb": 0 if self.loaded else self.args.need_gb}]}

    async def handler(self, ws):
        if self.busy.locked():
            await ws.send(json.dumps({"type": "error", "message": "the face is in another conversation (one at a time)"}))
            await ws.close()
            return
        async with self.busy:
            sess = None
            runner = None
            try:
                first = json.loads(await ws.recv())
                if first.get("type") != "start":
                    await ws.send(json.dumps({"type": "error", "message": "send start first"}))
                    return
                await self.ensure()
                size = int(min(512, max(256, int(first.get("size") or 384))))
                fps = int(min(30, max(10, int(first.get("fps") or 25))))
                fmt = "webp" if first.get("format") == "webp" else "jpeg"
                sess = FaceSession(self.renderer, self.identity, self.pool, ws.send, size, fps, fmt)
                await ws.send(json.dumps({"type": "ready", "fps": fps, "width": size, "height": size, "format": fmt, "identity": self.identity.name, "model": self.renderer.name}))
                runner = asyncio.create_task(sess.run())
                async for msg in ws:
                    self.last_used = time.time()
                    if isinstance(msg, (bytes, bytearray)):
                        continue
                    m = json.loads(msg)
                    t = m.get("type")
                    if t == "state":
                        sess.state(str(m.get("mode")))
                    elif t == "speech":
                        sess.speech(str(m["response_id"]), base64.b64decode(m.get("audio") or ""), int(m.get("sample_rate") or 24000))
                    elif t == "speech.end":
                        sess.speech_end(str(m["response_id"]))
                    elif t == "cancel":
                        sess.cancel(str(m["response_id"]))
                    elif t == "end":
                        break
            except Exception as e:  # noqa: BLE001 — said to mux, which goes on with voice alone
                log.warning("session: %s", e)
                try:
                    await ws.send(json.dumps({"type": "error", "message": str(e)[:300]}))
                except Exception:  # noqa: BLE001
                    pass
            finally:
                if sess:
                    sess.closed = True
                    sess.wake.set()
                if runner:
                    try:
                        await asyncio.wait_for(runner, timeout=5)
                    except Exception:  # noqa: BLE001
                        runner.cancel()
                if self.loaded:
                    await asyncio.get_running_loop().run_in_executor(self.pool, self.renderer.after_answer)
                self.last_used = time.time()


async def main_async(args):
    from websockets.asyncio.server import serve

    srv = Server(args)

    def http(connection, request):
        if request.path == "/health":
            return connection.respond(200, "ok\n")
        if request.path in ("/v1/models", "/models"):
            return connection.respond(200, json.dumps(srv.models()))
        if request.path != "/face":
            return connection.respond(404, "not here\n")
        return None

    async def idle():
        while True:
            await asyncio.sleep(30)
            if srv.loaded and not srv.busy.locked() and time.time() - srv.last_used > args.idle_exit:
                log.info("idle for %d s: exiting to free the memory (launchd starts an unloaded server)", args.idle_exit)
                os._exit(0)

    async with serve(srv.handler, args.host, args.port, process_request=http, max_size=2**22, compression=None):
        print(f"[face] ready on ws://{args.host}:{args.port}/face (MuseTalk loads on the first session)", flush=True)
        asyncio.create_task(idle())
        await asyncio.Future()


# ---------------------------------------------------------------------------------------------------- the bench


def read_wav(path: str) -> tuple[np.ndarray, int]:
    import wave

    with wave.open(path, "rb") as w:
        rate, ch, width = w.getframerate(), w.getnchannels(), w.getsampwidth()
        raw = w.readframes(w.getnframes())
    if width != 2:
        raise RuntimeError("the bench reads 16-bit PCM WAV")
    x = np.frombuffer(raw, dtype="<i2")
    if ch > 1:
        x = x.reshape(-1, ch).mean(axis=1).astype("<i2")
    return x, rate


async def bench(args):
    """The face alone on this Mac: a WAV of speech sent as mux sends it (100 ms pieces, at most --lead-ms ahead of real
    time), and what came back: first-frame latency (first audio in → first frame out), frames per second of wall time
    and per second of audio, how far each frame came behind its audio's arrival, and MLX's peak memory."""
    pcm, rate = read_wav(args.bench)
    srv = Server(args)
    t_load = time.monotonic()
    await srv.ensure()
    load_s = time.monotonic() - t_load
    got: list[tuple[float, dict]] = []
    done = asyncio.Event()

    async def send(m):
        if isinstance(m, (bytes, bytearray)):
            n = struct.unpack(">I", m[:4])[0]
            got.append((time.monotonic(), json.loads(m[4 : 4 + n])))
        elif json.loads(m).get("type") == "speech.done":
            done.set()

    for run in range(args.bench_runs):
        got.clear()
        done.clear()
        sess = FaceSession(srv.renderer, srv.identity, srv.pool, send, args.size, args.fps, args.format)
        task = asyncio.create_task(sess.run())
        await asyncio.sleep(0.3)  # a few idle frames first, as in a session
        rid = f"bench_{run}"
        piece = int(rate / 10) * 2
        raw = pcm.tobytes()
        start = time.monotonic()
        arrivals = []  # (audio ms at the end of the piece, wall)
        sent_ms = 0.0
        for off in range(0, len(raw), piece):
            chunk = raw[off : off + piece]
            ms = len(chunk) / 2 / rate * 1000
            ahead = (start + (sent_ms + ms) / 1000) - time.monotonic()
            if ahead > args.lead_ms / 1000:
                await asyncio.sleep(ahead - args.lead_ms / 1000)
            sent_ms += ms
            arrivals.append((sent_ms, time.monotonic()))
            sess.speech(rid, chunk, rate)
        sess.speech_end(rid)
        await asyncio.wait_for(done.wait(), timeout=max(60, sent_ms / 1000 * 10))
        sess.closed = True
        sess.wake.set()
        await task
        speaking = [(w, h) for w, h in got if h["response_id"] == rid]
        if not speaking:
            print("no speaking frames came back")
            return 1
        first = speaking[0][0] - arrivals[0][1]
        wall = speaking[-1][0] - speaking[0][0]
        lags = []
        for w, h in speaking:
            arr = next((a for m, a in arrivals if m > h["pts_ms"] + LOOKAHEAD_MS), arrivals[-1][1])
            lags.append((w - arr) * 1000)
        lags.sort()
        print(f"run {run + 1}: {len(speaking)} frames for {sent_ms / 1000:.1f} s of speech at {args.fps} fps, {args.size} px {args.format}, renderer {srv.renderer.name}")
        print(f"  first frame {first * 1000:.0f} ms after the first audio  ·  {len(speaking) / max(wall, 1e-6):.1f} frames/s (wall)  ·  {len(speaking) / (sent_ms / 1000):.1f} frames per audio second")
        print(f"  lag behind its audio (with its {LOOKAHEAD_MS} ms lookahead): p50 {lags[len(lags) // 2]:.0f} ms, p90 {lags[int(len(lags) * 0.9)]:.0f} ms, max {lags[-1]:.0f} ms — mux's lead is {args.lead_ms} ms")
        print(f"  peak MLX memory {srv.renderer.peak_gb():.2f} GB · load {load_s:.1f} s")
        verdict = "keeps up" if len(speaking) / max(wall, 1e-6) >= args.fps * 0.95 and lags[int(len(lags) * 0.9)] <= args.lead_ms else "DOES NOT keep up"
        print(f"  → {verdict} with real time at {args.fps} fps within mux's {args.lead_ms} ms lead")
    return 0


def setup_identity(folder: str) -> int:
    """deploy/face.sh: the face's boxes, once, beside the provenance the script wrote (prompt, seed, model, SHA-256)."""
    import cv2

    path = os.path.join(folder, "identity.json")
    meta = json.load(open(path)) if os.path.isfile(path) else {}
    img = cv2.imread(os.path.join(folder, meta.get("image", "face.png")), cv2.IMREAD_COLOR)
    if img is None:
        print(f"no face.png in {folder}")
        return 1
    if img.shape[0] != img.shape[1]:
        print("the identity picture must be square (1024x1024)")
        return 1
    box, eyes = detect_box(img)
    meta.update({"name": meta.get("name", "bloom"), "image": meta.get("image", "face.png"), "box": list(box), "eyes": [list(e) for e in eyes]})
    if os.path.isfile(os.path.join(folder, "blink.png")):
        meta["blink"] = "blink.png"
    if len(eyes) < 2:
        meta.pop("blink", None)
        print("  ! two eyes were not found: blinks are off for this face")
    json.dump(meta, open(path, "w"), indent=2)
    print(f"  face box {box}, eyes {eyes}")
    return 0


def main():
    p = argparse.ArgumentParser(description="Bloom's talking face (MuseTalk 1.5 on MLX) for mux's /v1/realtime")
    p.add_argument("--host", default="127.0.0.1")
    p.add_argument("--port", type=int, default=8324)
    p.add_argument("--identity", default=os.path.expanduser("~/.mux/face/bloom"), help="folder with identity.json and the face picture (deploy/face.sh)")
    p.add_argument("--weights", default=os.path.expanduser("~/.mux/models/musetalk-1.5-mlx-q8"), help="a mlx-community/MuseTalk-1.5-* snapshot")
    p.add_argument("--renderer", choices=("musetalk", "still"), default="musetalk", help="still: no model (motion and pipeline only)")
    p.add_argument("--need-gb", type=float, default=9.0, help="memory to have free before loading (vendor: ~7 GB peak at batch 8)")
    p.add_argument("--cache-gb", type=float, default=1.0, help="MLX's buffer cache cap")
    p.add_argument("--idle-exit", type=int, default=900)
    p.add_argument("--bench", help="a WAV of speech: measure first-frame latency and fps, then exit")
    p.add_argument("--bench-runs", type=int, default=2, help="the first run is warm-up for the GPU's kernels")
    p.add_argument("--lead-ms", type=int, default=400, help="how far ahead of real time the audio is sent (mux's leadMs)")
    p.add_argument("--size", type=int, default=384)
    p.add_argument("--fps", type=int, default=25)
    p.add_argument("--format", choices=("jpeg", "webp"), default="jpeg")
    p.add_argument("--setup-identity", action="store_true", help="find the face and eye boxes in <identity>/face.png and write identity.json (keeps its provenance)")
    args = p.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s: %(message)s")
    if args.setup_identity:
        sys.exit(setup_identity(args.identity))
    if args.bench:
        sys.exit(asyncio.run(bench(args)))
    asyncio.run(main_async(args))


if __name__ == "__main__":
    main()
