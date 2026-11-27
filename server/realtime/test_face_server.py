"""The face sidecar without MuseTalk: the scheduling, the pacing, barge-in, the picture and the server's one-at-a-time.

    python server/realtime/test_face_server.py      (needs numpy, opencv-python(-headless), websockets; no MLX)
"""

from __future__ import annotations

import argparse
import asyncio
import base64
import json
import os
import struct
import sys
import unittest

import cv2
import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import face_server as fs  # noqa: E402


def synthetic_identity(blink: bool = True) -> fs.Identity:
    """A drawn face (no person's likeness): an oval, two eyes, a mouth."""
    img = np.full((512, 512, 3), (200, 210, 220), np.uint8)
    cv2.ellipse(img, (256, 270), (130, 170), 0, 0, 360, (150, 175, 205), -1)
    for x in (206, 306):
        cv2.circle(img, (x, 220), 14, (60, 40, 30), -1)
    cv2.ellipse(img, (256, 350), (40, 10), 0, 0, 360, (80, 80, 160), -1)
    shut = None
    if blink:
        shut = img.copy()
        for x in (206, 306):
            cv2.circle(shut, (x, 220), 16, (150, 175, 205), -1)
            cv2.line(shut, (x - 14, 220), (x + 14, 220), (60, 40, 30), 2)
    return fs.Identity("test-face", img, (126, 110, 386, 440), [(186, 200, 226, 240), (286, 200, 326, 240)], shut)


def tone24k(ms: int) -> bytes:
    n = 24 * ms
    return (np.sin(np.arange(n) * 2 * np.pi * 220 / 24000) * 9000).astype("<i2").tobytes()


class Sink:
    def __init__(self, sess_ref=None):
        self.frames: list[dict] = []
        self.pictures: list[bytes] = []
        self.texts: list[dict] = []
        self.sess_ref = sess_ref
        self.audio_at_send: list[float] = []

    async def __call__(self, m):
        if isinstance(m, (bytes, bytearray)):
            n = struct.unpack(">I", m[:4])[0]
            h = json.loads(m[4 : 4 + n])
            self.frames.append(h)
            self.pictures.append(bytes(m[4 + n :]))
            if self.sess_ref and h["response_id"]:
                a = self.sess_ref().answers.get(h["response_id"])
                self.audio_at_send.append(a.audio_ms if a else float("inf"))
        else:
            self.texts.append(json.loads(m))


def session(sink, fps=25, delay_s=0.0, blink=True):
    import concurrent.futures

    idn = synthetic_identity(blink)
    r = fs.StillRenderer(idn, delay_s)
    s = fs.FaceSession(r, idn, concurrent.futures.ThreadPoolExecutor(max_workers=1), sink, 256, fps, "jpeg")
    return s, r


class FaceSessionTest(unittest.IsolatedAsyncioTestCase):
    async def test_idle_then_listening_in_real_time_never_frozen(self):
        sink = Sink()
        s, _ = session(sink)
        task = asyncio.create_task(s.run())
        await asyncio.sleep(0.5)
        s.state("listening")
        await asyncio.sleep(0.5)
        s.closed = True
        s.wake.set()
        await task
        modes = [f["mode"] for f in sink.frames]
        self.assertGreaterEqual(len(modes), 20, "~25 fps in real time")
        self.assertLessEqual(len(modes), 28)
        self.assertEqual(modes[0], "idle")
        self.assertEqual(modes[-1], "listening")
        self.assertTrue(all(f["response_id"] is None for f in sink.frames))
        pts = [f["pts_ms"] for f in sink.frames]
        self.assertEqual(pts, sorted(pts))
        # The head moves: consecutive pictures are not all the same
        self.assertGreater(len(set(sink.pictures)), len(sink.pictures) // 2)
        img = cv2.imdecode(np.frombuffer(sink.pictures[0], np.uint8), cv2.IMREAD_COLOR)
        self.assertEqual(img.shape, (256, 256, 3))

    async def test_speaking_frames_follow_the_audio_with_their_lookahead_then_done(self):
        sink = Sink(lambda: s)
        s, r = session(sink)
        task = asyncio.create_task(s.run())
        for _ in range(10):  # 1 s of Bloom's speech, 100 ms pieces as mux sends them
            s.speech("resp_a", tone24k(100), 24000)
            await asyncio.sleep(0.02)
        s.speech_end("resp_a")
        for _ in range(200):
            if any(t.get("type") == "speech.done" for t in sink.texts):
                break
            await asyncio.sleep(0.01)
        s.closed = True
        s.wake.set()
        await task
        speaking = [f for f in sink.frames if f["response_id"] == "resp_a"]
        self.assertEqual([f["pts_ms"] for f in speaking], [i * 40.0 for i in range(25)], "one frame per 40 ms of speech, in order")
        self.assertTrue(all(f["mode"] == "speaking" for f in speaking))
        done = [t for t in sink.texts if t["type"] == "speech.done"][0]
        self.assertEqual((done["frames"], done["audio_ms"]), (25, 1000))
        # No frame before its own audio and the 80 ms after it had arrived (unless the speech had ended)
        for f, had in zip(speaking, sink.audio_at_send):
            self.assertTrue(had == float("inf") or f["pts_ms"] + 40 + fs.LOOKAHEAD_MS <= had + 1e-6 or s.answers.get("resp_a") is None, (f, had))
        self.assertEqual(r.calls[0], [0, 1], "a small first batch, for the first frame's latency")
        self.assertTrue(all(len(c) <= 8 for c in r.calls))

    async def test_barge_in_drops_the_answer_at_once_even_mid_batch(self):
        sink = Sink()
        s, r = session(sink, delay_s=0.05)
        task = asyncio.create_task(s.run())
        for _ in range(20):
            s.speech("resp_b", tone24k(100), 24000)
        await asyncio.sleep(0.12)
        s.cancel("resp_b")
        s.state("listening")
        n = len([f for f in sink.frames if f["response_id"] == "resp_b"])
        await asyncio.sleep(0.3)
        s.speech("resp_b", tone24k(100), 24000)  # late audio of a cancelled answer is ignored
        await asyncio.sleep(0.2)
        s.closed = True
        s.wake.set()
        await task
        self.assertLess(n, 50, "it was stopped before the end")
        self.assertEqual(len([f for f in sink.frames if f["response_id"] == "resp_b"]), n, "no frame of it after the cancel")
        self.assertFalse(any(t.get("type") == "speech.done" for t in sink.texts))
        self.assertEqual(sink.frames[-1]["mode"], "listening", "the face listens again")

    async def test_a_pause_mid_answer_closes_the_mouth_and_idles_then_speech_goes_on(self):
        """A tool running after "Let me look.": the face must not freeze on its last speaking frame."""
        sink = Sink()
        s, _ = session(sink)
        task = asyncio.create_task(s.run())
        for _ in range(3):
            s.speech("resp_p", tone24k(100), 24000)
        await asyncio.sleep(1.25)  # no speech.end: the answer waits on its tool
        during = list(sink.frames)
        for _ in range(3):
            s.speech("resp_p", tone24k(100), 24000)
        s.speech_end("resp_p")
        for _ in range(200):
            if any(t.get("type") == "speech.done" for t in sink.texts):
                break
            await asyncio.sleep(0.01)
        s.closed = True
        s.wake.set()
        await task
        first = [f["pts_ms"] for f in during if f["response_id"] == "resp_p"]
        self.assertEqual(first, [i * 40.0 for i in range(7)], "the mouth finished the 300 ms it heard (to pts 240)")
        idle = [f for f in during if f["response_id"] is None and f["index"] > max(f2["index"] for f2 in during if f2["response_id"])]
        self.assertGreaterEqual(len(idle), 20, f"about 25 idle frames a second during the pause, got {len(idle)}")
        self.assertLessEqual(len(idle), 30)
        all_p = [f["pts_ms"] for f in sink.frames if f["response_id"] == "resp_p"]
        self.assertEqual(all_p, [i * 40.0 for i in range(15)], "after the pause the answer's frames go on from where they were")
        done = [t for t in sink.texts if t["type"] == "speech.done"][0]
        self.assertEqual((done["frames"], done["audio_ms"]), (15, 600))

    async def test_an_answer_with_no_audio_is_done_at_once(self):
        sink = Sink()
        s, _ = session(sink)
        s.speech_end("resp_empty")
        await asyncio.sleep(0.01)
        self.assertEqual(sink.texts, [{"type": "speech.done", "response_id": "resp_empty", "frames": 0, "audio_ms": 0}])


class PictureTest(unittest.TestCase):
    def test_blink_closes_the_eyes_and_the_mouth_is_pasted_back(self):
        idn = synthetic_identity()
        c = fs.Composer(idn, 512, "jpeg", 95)
        still = fs.Pose()
        open_ = cv2.imdecode(np.frombuffer(c.compose(None, 0, still), np.uint8), cv2.IMREAD_COLOR).astype(int)
        shut = cv2.imdecode(np.frombuffer(c.compose(None, 0, fs.Pose(blink=1.0)), np.uint8), cv2.IMREAD_COLOR).astype(int)
        self.assertGreater(np.abs(open_[205:235, 195:220] - shut[205:235, 195:220]).mean(), 20, "the eye is covered by the lid")
        self.assertLess(np.abs(open_[400:500] - shut[400:500]).mean(), 2, "nothing else changes")
        green = np.zeros((256, 256, 3), np.uint8)
        green[..., 1] = 255
        lips = cv2.imdecode(np.frombuffer(c.compose(green, 1.0, still), np.uint8), cv2.IMREAD_COLOR).astype(int)
        self.assertGreater(lips[350, 256, 1] - open_[350, 256, 1], 40, "the mouth comes from the crop")
        self.assertLess(np.abs(lips[150:180, 230:280] - open_[150:180, 230:280]).mean(), 3, "the forehead stays the reference's")

    def test_motion_never_stands_still_and_listening_nods(self):
        m = fs.Motion()
        idle = [m.pose(t / 25, "idle") for t in range(250)]
        self.assertGreater(np.std([p.dx for p in idle]), 0.3)
        self.assertTrue(any(p.blink > 0.5 for p in idle), "a blink in 10 s")
        lm = fs.Motion()
        listening = [lm.pose(t / 25, "listening") for t in range(250)]
        self.assertGreater(max(p.dy for p in listening), max(p.dy for p in idle) + 1.5, "a nod")
        self.assertAlmostEqual(len(fs.resample_to_16k(np.zeros(24000, "<i2"), 24000)), 16000)


class ServerTest(unittest.IsolatedAsyncioTestCase):
    async def test_one_session_at_a_time_and_the_memory_floor(self):
        from websockets.asyncio.client import connect
        from websockets.asyncio.server import serve

        args = argparse.Namespace(need_gb=9.0, cache_gb=1.0, renderer="still", identity="", weights="")
        idn = synthetic_identity()
        srv = fs.Server(args, fs.StillRenderer(idn), idn)
        self.assertEqual(srv.models(), {"data": [{"id": "musetalk-1.5-mlx", "loaded": False, "need_gb": 9.0}]})
        async with serve(srv.handler, "127.0.0.1", 0) as server:
            port = server.sockets[0].getsockname()[1]
            async with connect(f"ws://127.0.0.1:{port}/face") as a:
                await a.send(json.dumps({"type": "start", "size": 256, "fps": 25}))
                ready = json.loads(await a.recv())
                self.assertEqual((ready["type"], ready["width"], ready["identity"], ready["model"]), ("ready", 256, "test-face", "still"))
                self.assertEqual(srv.models()["data"][0]["need_gb"], 0, "loaded: nothing more to make room for")
                async with connect(f"ws://127.0.0.1:{port}/face") as b:
                    refused = json.loads(await b.recv())
                    self.assertEqual(refused["type"], "error")
                    self.assertIn("one at a time", refused["message"])
                await a.send(json.dumps({"type": "speech", "response_id": "r1", "sample_rate": 24000, "audio": base64.b64encode(tone24k(400)).decode()}))
                await a.send(json.dumps({"type": "speech.end", "response_id": "r1"}))
                done = None
                for _ in range(200):
                    m = await asyncio.wait_for(a.recv(), 5)
                    if isinstance(m, str) and json.loads(m)["type"] == "speech.done":
                        done = json.loads(m)
                        break
                self.assertEqual(done["frames"], 10)
                await a.send(json.dumps({"type": "end"}))


if __name__ == "__main__":
    unittest.main(verbosity=2)
