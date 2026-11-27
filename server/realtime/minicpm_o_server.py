"""MiniCPM-o 4.5 full duplex as mux's duplex engine `minicpm-o-4.5`: a trial behind /v1/realtime.

    ~/.mux/minicpm-o/demo/.venv/base/bin/python server/realtime/minicpm_o_server.py --port 8322 --demo ~/.mux/minicpm-o/demo

On the Mac, MiniCPM-o's duplex mode runs in llama.cpp-omni (C++, Metal, GGUF Q4_K_M), driven by the official demo's
Python worker (OpenBMB/MiniCPM-o-Demo, branch Comni: worker.py spawns llama-omni-server and serves /ws/duplex). This
wrapper speaks mux's engine protocol on ws://127.0.0.1:8322/duplex (the same one haru_server.py speaks; see
docs/realtime.md) and translates:

    mux start              → worker {"type":"prepare","system_prompt":…,"ref_audio_path":…}; its "prepared" → ready
    binary pcm16 16 kHz    → worker {"type":"audio_chunk","audio_base64": float32 16 kHz, 1 s per chunk}
    worker "result"        → {"type":"text"} for what it says (is_listen false) and its audio_data as binary pcm16
    worker "audio_only"    → binary pcm16
    mux end                → worker {"type":"stop"}

The worker (and the ~10 GB of models it loads) starts on the first session and is stopped after --idle-exit seconds
without one; GET /v1/models says loaded and need_gb, which mux's memory floor reads before it admits a session.
The output sample rate is taken as 24 kHz (the model card's duplex example writes 24 kHz); not verified on this Mac.

MiniCPM-o 4.5 weights and code: Apache-2.0 (OpenBMB). llama.cpp-omni: MIT. The Comni demo has no licence file
(checked 27 November 2026): it runs here unmodified, for research, and is not redistributed. docs/minicpm-o.md.
"""

from __future__ import annotations

import argparse
import asyncio
import base64
import json
import logging
import os
import signal
import subprocess
import time
import urllib.request

import numpy as np

log = logging.getLogger("mux.minicpm-o")
IN_RATE = 16_000
OUT_RATE = 24_000
CHUNK = IN_RATE  # 1 s, the audio encoder's own chunk


class Worker:
    def __init__(self, args):
        self.args = args
        self.proc: subprocess.Popen | None = None
        self.busy = asyncio.Lock()
        self.last_used = time.time()

    @property
    def url(self):
        return f"http://127.0.0.1:{self.args.worker_port}"

    def healthy(self) -> bool:
        try:
            with urllib.request.urlopen(f"{self.url}/health", timeout=2) as r:
                return r.status == 200
        except Exception:
            return False

    @property
    def loaded(self) -> bool:
        return self.proc is not None and self.proc.poll() is None

    async def ensure(self):
        if self.loaded and self.healthy():
            return
        demo = os.path.expanduser(self.args.demo)
        py = os.path.join(demo, ".venv", "base", "bin", "python")
        log.info("starting the MiniCPM-o worker (llama.cpp-omni loads the models)")
        self.proc = subprocess.Popen([py, "worker.py", "--port", str(self.args.worker_port), "--worker-index", "0"], cwd=demo,
                                     stdout=open(os.path.expanduser("~/.mux/logs/minicpm-o-worker.log"), "ab"), stderr=subprocess.STDOUT,
                                     start_new_session=True)
        t0 = time.time()
        while time.time() - t0 < self.args.load_timeout:
            if self.proc.poll() is not None:
                raise RuntimeError(f"the worker exited ({self.proc.returncode}): see ~/.mux/logs/minicpm-o-worker.log")
            if await asyncio.to_thread(self.healthy):
                log.info("worker up in %.0f s", time.time() - t0)
                return
            await asyncio.sleep(2)
        self.stop()
        raise RuntimeError(f"the worker was not up after {self.args.load_timeout} s")

    def stop(self):
        if self.proc and self.proc.poll() is None:
            os.killpg(self.proc.pid, signal.SIGTERM)
            try:
                self.proc.wait(20)
            except subprocess.TimeoutExpired:
                os.killpg(self.proc.pid, signal.SIGKILL)
        self.proc = None


def f32_to_pcm16(b64: str) -> bytes:
    x = np.frombuffer(base64.b64decode(b64), dtype=np.float32)
    return (np.clip(x, -1, 1) * 32767).astype("<i2").tobytes()


async def bridge(mux_ws, worker: Worker, start: dict, args):
    from websockets.asyncio.client import connect

    await worker.ensure()
    async with connect(f"ws://127.0.0.1:{args.worker_port}/ws/duplex?session_id=mux_{int(time.time())}", max_size=2**24) as w:
        prepare = {"type": "prepare", "system_prompt": start.get("instructions") or "You are Bloom, a helpful assistant. Speak English.", "config": {}}
        if start.get("voice") and os.path.isfile(str(start["voice"])):
            prepare["ref_audio_path"] = str(start["voice"])
        await w.send(json.dumps(prepare))
        while True:
            m = json.loads(await w.recv())
            if m.get("type") == "prepared":
                break
            if m.get("type") == "error":
                raise RuntimeError(m.get("error", "prepare failed"))
        await mux_ws.send(json.dumps({"type": "ready", "sample_rate": OUT_RATE, "frame_ms": 1000, "can_speak": False}))

        async def from_worker():
            async for raw in w:
                m = json.loads(raw)
                t = m.get("type")
                if t == "result":
                    if not m.get("is_listen") and m.get("text"):
                        await mux_ws.send(json.dumps({"type": "text", "text": m["text"]}))
                    if m.get("audio_data"):
                        await mux_ws.send(f32_to_pcm16(m["audio_data"]))
                elif t == "audio_only" and m.get("audio_data"):
                    await mux_ws.send(f32_to_pcm16(m["audio_data"]))
                elif t in ("error", "timeout"):
                    await mux_ws.send(json.dumps({"type": "error", "message": str(m.get("error") or m.get("reason"))[:300]}))

        reader = asyncio.create_task(from_worker())
        buf = np.zeros(0, dtype=np.float32)
        try:
            async for msg in mux_ws:
                worker.last_used = time.time()
                if isinstance(msg, (bytes, bytearray)):
                    buf = np.concatenate([buf, np.frombuffer(bytes(msg), dtype="<i2").astype(np.float32) / 32768.0])
                    while len(buf) >= CHUNK:
                        chunk, buf = buf[:CHUNK], buf[CHUNK:]
                        await w.send(json.dumps({"type": "audio_chunk", "audio_base64": base64.b64encode(chunk.astype(np.float32).tobytes()).decode()}))
                    continue
                m = json.loads(msg)
                if m.get("type") == "speak":
                    await mux_ws.send(json.dumps({"type": "error", "message": "MiniCPM-o cannot be made to say a given sentence"}))
                elif m.get("type") == "end":
                    break
        finally:
            try:
                await w.send(json.dumps({"type": "stop"}))
            except Exception:
                pass
            reader.cancel()


async def main_async(args):
    from websockets.asyncio.server import serve

    worker = Worker(args)

    def http(connection, request):
        if request.path == "/health":
            return connection.respond(200, "ok\n")
        if request.path in ("/v1/models", "/models"):
            return connection.respond(200, json.dumps({"data": [{"id": "minicpm-o-4.5", "loaded": worker.loaded, "need_gb": 0 if worker.loaded else args.need_gb}]}))
        if request.path != "/duplex":
            return connection.respond(404, "not here\n")
        return None

    async def handler(ws):
        if worker.busy.locked():
            await ws.send(json.dumps({"type": "error", "message": "MiniCPM-o is in another conversation (one at a time)"}))
            return
        async with worker.busy:
            try:
                first = json.loads(await ws.recv())
                if first.get("type") != "start":
                    await ws.send(json.dumps({"type": "error", "message": "send start first"}))
                    return
                await bridge(ws, worker, first, args)
            except Exception as e:
                log.warning("session: %s", e)
                try:
                    await ws.send(json.dumps({"type": "error", "message": str(e)[:300]}))
                except Exception:
                    pass
            finally:
                worker.last_used = time.time()

    async def idle():
        while True:
            await asyncio.sleep(30)
            if worker.loaded and not worker.busy.locked() and time.time() - worker.last_used > args.idle_exit:
                log.info("idle for %d s: stopping the worker to free its memory", args.idle_exit)
                worker.stop()

    async with serve(handler, args.host, args.port, process_request=http, max_size=2**22):
        print(f"[minicpm-o] ready on ws://{args.host}:{args.port}/duplex (the worker starts on the first session)", flush=True)
        asyncio.create_task(idle())
        try:
            await asyncio.Future()
        finally:
            worker.stop()


def main():
    p = argparse.ArgumentParser(description="MiniCPM-o 4.5 (llama.cpp-omni, Comni worker) as mux's duplex engine minicpm-o-4.5")
    p.add_argument("--host", default="127.0.0.1")
    p.add_argument("--port", type=int, default=8322)
    p.add_argument("--demo", default="~/.mux/minicpm-o/demo", help="the MiniCPM-o-Demo (Comni) checkout, with its config.json and venv")
    p.add_argument("--worker-port", type=int, default=22440)
    p.add_argument("--need-gb", type=float, default=14.0, help="memory to have free before loading (the CookBook: ~10 GB at Q4_K_M, with room)")
    p.add_argument("--load-timeout", type=int, default=240)
    p.add_argument("--idle-exit", type=int, default=900)
    args = p.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s: %(message)s")
    asyncio.run(main_async(args))


if __name__ == "__main__":
    main()
