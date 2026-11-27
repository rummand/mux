"""A headless server for Haru-4B on MLX: the duplex engine `haru-4b` behind mux's /v1/realtime.

    ~/.mux/haru-venv/bin/python server/realtime/haru_server.py --port 8321 [--quantize 8] [--voice ~/.mux/haru/voice-en.wav]

haru_mlx ships a macOS app and a Unix-socket server for it, but no network server, so this is the wrapper: mux's
engine protocol on ws://127.0.0.1:8321/duplex (docs/realtime.md, "Duplex engines"), one conversation at a time.

    mux → engine   {"type":"start","instructions":"…","voice":null|"/path.wav","input_sample_rate":16000}
                   binary: pcm16 mono at 16 kHz, any length (resampled to Haru's 24 kHz, 3200 samples a frame)
                   {"type":"speak","text":"…"}   forced text (experimental: haru_forced.py)
                   {"type":"end"}
    engine → mux   {"type":"ready","sample_rate":24000,"frame_ms":133,"can_speak":true}
                   binary: pcm16 mono at 24 kHz, one 133 ms frame per user frame (silence included)
                   {"type":"text","text":"…"}     the model's text stream
                   {"type":"error","message":"…"}

GET /v1/models → {"data":[{"id":"haru-4b","loaded":bool,"need_gb":n}]}: mux's memory floor reads `need_gb` before it
admits a session (runtime/manager.ts roomForService). The model loads on the first session (~10 GB bf16, ~5 GB
8-bit) and the process exits after --idle-exit seconds without one; launchd (KeepAlive) starts it again, unloaded.

MLX keeps its GPU streams per thread: the model is loaded and driven on haru_mlx's MLXWorker thread only.
Licence: Apache-2.0 for code and weights (higurashi); use only voices you have the rights to (docs/haru.md).
"""

from __future__ import annotations

import argparse
import asyncio
import json
import logging
import os
import sys
import time

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from haru_forced import forced_session_class  # noqa: E402

log = logging.getLogger("mux.haru")
DEFAULT_INSTRUCTIONS = "You are Bloom, a warm and quick-witted assistant for small businesses. You speak English."


class Engine:
    def __init__(self, args):
        self.args = args
        self.worker = None
        self.model = None
        self.voice = None
        self.busy = asyncio.Lock()
        self.last_used = time.time()

    @property
    def loaded(self) -> bool:
        return self.model is not None

    def _load(self):
        from haru_mlx import HaruModel
        from haru_mlx.audio import load_audio, prepare_reference

        t0 = time.time()
        q = None if self.args.quantize == "none" else int(self.args.quantize)
        self.model = HaruModel.from_pretrained(self.args.hf_repo, quantize=q) if q else HaruModel.from_pretrained(self.args.hf_repo)
        if self.args.voice and os.path.isfile(self.args.voice):
            self.voice = prepare_reference(load_audio(self.args.voice))
        log.info("Haru loaded in %.1f s (%s)", time.time() - t0, "8-bit" if q else "bf16")

    async def ensure(self):
        from haru_mlx.worker import MLXWorker

        if self.worker is None:
            self.worker = MLXWorker()
        if self.model is None:
            await self.worker.run(self._load)

    async def session(self, ws, start: dict):
        from haru_mlx import DuplexConfig
        from haru_mlx.audio import load_audio, prepare_reference
        from scipy.signal import resample_poly

        await self.ensure()
        voice = self.voice
        if start.get("voice") and os.path.isfile(str(start["voice"])):
            voice = await self.worker.run(lambda: prepare_reference(load_audio(str(start["voice"]))))
        Session = forced_session_class()
        s = await self.worker.run(lambda: Session(self.model, system_prompt=start.get("instructions") or DEFAULT_INSTRUCTIONS, reference=voice, config=DuplexConfig()))
        in_rate = int(start.get("input_sample_rate") or 16000)
        frame = await self.worker.run(s.start)
        await ws.send(json.dumps({"type": "ready", "sample_rate": 24000, "frame_ms": 133, "can_speak": True}))

        async def out(f):
            pcm = (np.clip(f.audio, -1, 1) * 32767).astype("<i2").tobytes()
            await ws.send(pcm)
            if f.text:
                await ws.send(json.dumps({"type": "text", "text": f.text}))

        await out(frame)
        async for msg in ws:
            self.last_used = time.time()
            if isinstance(msg, (bytes, bytearray)):
                x = np.frombuffer(bytes(msg), dtype="<i2").astype(np.float32) / 32768.0
                if in_rate != 24000:
                    x = resample_poly(x, 24000, in_rate).astype(np.float32)
                await self.worker.run(s.feed, x)
                while s.frames_ready:
                    frame = await self.worker.run(s.step)
                    await out(frame)
                    if frame.done:
                        await ws.send(json.dumps({"type": "error", "message": "Haru's 60-minute conversation limit"}))
                        return
                continue
            m = json.loads(msg)
            if m.get("type") == "speak" and m.get("text"):
                n = await self.worker.run(s.force, str(m["text"]), int(self.args.pace))
                log.info("forced %d frames of text", n)
            elif m.get("type") == "end":
                return


async def main_async(args):
    from websockets.asyncio.server import serve

    engine = Engine(args)

    def http(connection, request):
        if request.path == "/health":
            return connection.respond(200, "ok\n")
        if request.path in ("/v1/models", "/models"):
            need = 0 if engine.loaded else args.need_gb
            return connection.respond(200, json.dumps({"data": [{"id": "haru-4b", "loaded": engine.loaded, "need_gb": need}]}))
        if request.path != "/duplex":
            return connection.respond(404, "not here\n")
        return None

    async def handler(ws):
        if engine.busy.locked():
            await ws.send(json.dumps({"type": "error", "message": "Haru is in another conversation (one at a time)"}))
            return
        async with engine.busy:
            try:
                first = json.loads(await ws.recv())
                if first.get("type") != "start":
                    await ws.send(json.dumps({"type": "error", "message": "send start first"}))
                    return
                await engine.session(ws, first)
            except Exception as e:
                log.warning("session: %s", e)
                try:
                    await ws.send(json.dumps({"type": "error", "message": str(e)[:300]}))
                except Exception:
                    pass
            finally:
                engine.last_used = time.time()

    async def idle():
        while True:
            await asyncio.sleep(30)
            if engine.loaded and not engine.busy.locked() and time.time() - engine.last_used > args.idle_exit:
                log.info("idle for %d s: exiting to free the memory (launchd starts an unloaded server)", args.idle_exit)
                os._exit(0)

    async with serve(handler, args.host, args.port, process_request=http, max_size=2**22):
        print(f"[haru] ready on ws://{args.host}:{args.port}/duplex (model loads on the first session)", flush=True)
        asyncio.create_task(idle())
        await asyncio.Future()


def main():
    p = argparse.ArgumentParser(description="Haru-4B (MLX) as mux's duplex engine haru-4b")
    p.add_argument("--host", default="127.0.0.1")
    p.add_argument("--port", type=int, default=8321)
    p.add_argument("--hf-repo", default="higurashi-ai/Haru-4B")
    p.add_argument("--quantize", choices=("8", "none"), default="8")
    p.add_argument("--voice", default=os.path.expanduser("~/.mux/haru/voice-en.wav"), help="the voice clip (3 s–3 min, one speaker, rights cleared)")
    p.add_argument("--pace", type=int, default=0, help="PAD frames after each forced token (see haru_forced_text.py)")
    p.add_argument("--need-gb", type=float, default=12.0, help="memory to have free before loading (8-bit ~5 GB + codec + cache, with room)")
    p.add_argument("--idle-exit", type=int, default=900)
    args = p.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s: %(message)s")
    asyncio.run(main_async(args))


if __name__ == "__main__":
    main()
