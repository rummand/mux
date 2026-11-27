"""mux's hear sidecar: the listening half of a /v1/realtime cascade, on the Mac.

    ~/.mux/realtime-venv/bin/python server/realtime/hear_server.py --port 8326

One WebSocket per voice session at ws://127.0.0.1:8326/hear. mux sends {"type":"start", "sample_rate":16000,
"language":"en", "turn_silence_ms"?} and then binary frames of pcm16 mono at 16 kHz; this answers with
{"type":"ready","name":...} and then, as it hears:

    {"type":"vad.start","at_ms":...}     Silero VAD: speech began (at_ms on the session's input clock)
    {"type":"vad.end","at_ms":...}       Silero VAD: speech stopped (the end of the last voiced chunk)
    {"type":"partial","text":...}        parakeet-mlx streaming transcription, as it goes
    {"type":"turn.end","at_ms":...,"confidence":p}   Smart Turn v3 says the turn is complete (p > 0.5), or the
                                         silence ran past turn_silence_ms (confidence 0.5)
    {"type":"final","text":...}          the turn's words, right after turn.end

GET /v1/models says what it holds ({"data":[{"id":"hear","loaded":true,"need_gb":0}]}), GET /health answers ok.

Models (licences in docs/realtime.md): Silero VAD (MIT), Smart Turn v3.x ONNX (BSD-2-Clause, Daily), parakeet-tdt-0.6b-v3
through parakeet-mlx (weights CC-BY-4.0, NVIDIA; parakeet-mlx Apache-2.0). Nothing is logged or kept: the audio and the
words live only for the session.
"""

from __future__ import annotations

import argparse
import asyncio
import concurrent.futures
import glob
import json
import logging
import os
import time

import numpy as np

log = logging.getLogger("mux.hear")
RATE = 16_000
VAD_CHUNK = 512  # Silero VAD's window at 16 kHz (32 ms)
STT_STEP_S = 0.32  # how often new audio goes to the streaming transcriber


class Models:
    """Loaded once, used from one thread (MLX keeps its GPU streams per thread)."""

    def __init__(self, smart_turn_path: str, parakeet: str):
        import onnxruntime as ort
        from parakeet_mlx import from_pretrained
        from silero_vad import load_silero_vad
        from transformers import WhisperFeatureExtractor

        self.silero = load_silero_vad(onnx=True)
        so = ort.SessionOptions()
        so.execution_mode = ort.ExecutionMode.ORT_SEQUENTIAL
        so.inter_op_num_threads = 1
        self.turn = ort.InferenceSession(smart_turn_path, sess_options=so)
        self.features = WhisperFeatureExtractor(chunk_length=8)
        self.stt = from_pretrained(parakeet)

    def turn_probability(self, audio: np.ndarray) -> float:
        """Smart Turn v3: the last 8 s of the turn (padded at the start), Whisper features, P(complete). From its inference.py."""
        audio = audio[-8 * RATE :]
        if len(audio) < 8 * RATE:
            audio = np.concatenate([np.zeros(8 * RATE - len(audio), dtype=np.float32), audio])
        f = self.features(audio, sampling_rate=RATE, return_tensors="np", padding="max_length", max_length=8 * RATE, truncation=True, do_normalize=True)
        x = np.expand_dims(f.input_features.squeeze(0).astype(np.float32), 0)
        return float(self.turn.run(None, {"input_features": x})[0][0].item())


class Listener:
    """One session's hearing: VAD every 32 ms, words every 320 ms of speech, the turn decision on each pause."""

    def __init__(self, models: Models, pool: concurrent.futures.ThreadPoolExecutor, send, turn_silence_ms: int):
        from silero_vad import VADIterator

        self.m, self.pool, self.send = models, pool, send
        self.vad = VADIterator(models.silero, sampling_rate=RATE, threshold=0.5, min_silence_duration_ms=200, speech_pad_ms=30)
        self.turn_silence_ms = turn_silence_ms
        self.clock = 0  # samples received
        self.vad_base = 0  # VADIterator counts from its last reset_states(): its sample indexes are offset by this
        self.pending = np.zeros(0, dtype=np.float32)
        self.turn_audio: list[np.ndarray] = []
        self.in_speech = False
        self.in_turn = False
        self.last_voiced_end = 0
        self.stream = None  # parakeet's streaming context, for the turn
        self.stt_buf: list[np.ndarray] = []
        self.partial = ""
        self.asked_turn = False

    def ms(self, samples: int) -> int:
        return int(samples * 1000 / RATE)

    async def run(self, fn, *a):
        return await asyncio.get_running_loop().run_in_executor(self.pool, fn, *a)

    async def push(self, pcm16: bytes):
        x = np.frombuffer(pcm16, dtype="<i2").astype(np.float32) / 32768.0
        self.pending = np.concatenate([self.pending, x])
        while len(self.pending) >= VAD_CHUNK:
            chunk, self.pending = self.pending[:VAD_CHUNK], self.pending[VAD_CHUNK:]
            await self.chunk(chunk)

    async def chunk(self, chunk: np.ndarray):
        import torch

        self.clock += len(chunk)
        if self.in_turn:
            self.turn_audio.append(chunk)
            self.stt_buf.append(chunk)
        ev = self.vad(torch.from_numpy(chunk), return_seconds=False)
        if ev and "start" in ev:
            self.in_speech = True
            self.asked_turn = False
            if not self.in_turn:
                self.in_turn = True
                self.turn_audio = [chunk]
                self.stt_buf = [chunk]
                self.partial = ""
                self.stream = await self.run(self._open_stream)
            await self.send({"type": "vad.start", "at_ms": self.ms(self.vad_base + int(ev["start"]))})
        if self.in_speech:
            self.last_voiced_end = self.clock
        if ev and "end" in ev:
            self.in_speech = False
            self.last_voiced_end = self.vad_base + int(ev["end"])
            await self.send({"type": "vad.end", "at_ms": self.ms(self.last_voiced_end)})
            # Smart Turn on each pause: is the person done, or thinking?
            p = await self.run(self.m.turn_probability, np.concatenate(self.turn_audio))
            self.asked_turn = True
            if p > 0.5:
                return await self.end_turn(p)
        if self.in_turn and not self.in_speech:
            if self.ms(self.clock - self.last_voiced_end) >= self.turn_silence_ms:
                return await self.end_turn(0.5)
        if self.in_turn and sum(len(b) for b in self.stt_buf) >= STT_STEP_S * RATE:
            buf, self.stt_buf = np.concatenate(self.stt_buf), []
            text = await self.run(self._add, buf)
            if text and text != self.partial:
                self.partial = text
                await self.send({"type": "partial", "text": text})

    def _open_stream(self):
        s = self.m.stt.transcribe_stream(context_size=(256, 256))
        s.__enter__()
        return s

    def _add(self, audio: np.ndarray) -> str:
        import mlx.core as mx

        if self.stream is None:
            return ""
        self.stream.add_audio(mx.array(audio))
        return self.stream.result.text.strip()

    def _close(self, rest: np.ndarray | None) -> str:
        if self.stream is None:
            return ""
        text = self._add(rest) if rest is not None and len(rest) else self.stream.result.text.strip()
        try:
            self.stream.__exit__(None, None, None)
        finally:
            self.stream = None
        return text

    async def end_turn(self, confidence: float):
        rest = np.concatenate(self.stt_buf) if self.stt_buf else None
        self.stt_buf, self.in_turn, self.turn_audio = [], False, []
        await self.send({"type": "turn.end", "at_ms": self.ms(self.last_voiced_end), "confidence": round(confidence, 3)})
        text = await self.run(self._close, rest)
        await self.send({"type": "final", "text": text})
        self.vad.reset_states()
        self.vad_base = self.clock

    async def close(self):
        if self.stream is not None:
            await self.run(self._close, None)


async def main_async(args):
    from websockets.asyncio.server import serve

    pool = concurrent.futures.ThreadPoolExecutor(max_workers=1, thread_name_prefix="hear-mlx")
    t0 = time.time()
    models = await asyncio.get_running_loop().run_in_executor(pool, Models, args.smart_turn, args.parakeet)
    log.info("models loaded in %.1f s", time.time() - t0)

    def http(connection, request):
        if request.path == "/health":
            return connection.respond(200, "ok\n")
        if request.path == "/v1/models":
            return connection.respond(200, json.dumps({"data": [{"id": "hear", "loaded": True, "need_gb": 0}]}))
        if request.path != "/hear":
            return connection.respond(404, "not here\n")
        return None

    async def handler(ws):
        listener = None
        async def send(m):
            await ws.send(json.dumps(m))
        try:
            async for msg in ws:
                if isinstance(msg, (bytes, bytearray)):
                    if listener is not None:
                        await listener.push(bytes(msg))
                    continue
                m = json.loads(msg)
                if m.get("type") == "start" and listener is None:
                    if int(m.get("sample_rate", RATE)) != RATE:
                        await send({"type": "error", "message": "only 16 kHz pcm16 is heard"})
                        return
                    listener = Listener(models, pool, send, int(m.get("turn_silence_ms") or args.turn_silence_ms))
                    await send({"type": "ready", "name": "silero+smart-turn+parakeet"})
        except Exception as e:  # the session goes on without the sidecar's words; mux says so
            log.warning("session: %s", e)
            try:
                await send({"type": "error", "message": str(e)[:300]})
            except Exception:
                pass
        finally:
            if listener is not None:
                await listener.close()

    async with serve(handler, args.host, args.port, process_request=http, max_size=2**22):
        print(f"[hear] ready on ws://{args.host}:{args.port}/hear", flush=True)
        await asyncio.Future()


def find_smart_turn(path: str | None) -> str:
    if path and os.path.isfile(path):
        return path
    from huggingface_hub import snapshot_download

    d = snapshot_download("pipecat-ai/smart-turn-v3", allow_patterns=["*.onnx"])
    files = sorted(glob.glob(os.path.join(d, "*.onnx")))
    # The unquantized model if it is there, else the newest
    full = [f for f in files if "int8" not in os.path.basename(f) and "cpu" not in os.path.basename(f)]
    if not files:
        raise SystemExit("no Smart Turn ONNX file in pipecat-ai/smart-turn-v3")
    return (full or files)[-1]


def main():
    p = argparse.ArgumentParser(description="mux hear sidecar: Silero VAD + Smart Turn v3 + parakeet-mlx streaming")
    p.add_argument("--host", default="127.0.0.1")
    p.add_argument("--port", type=int, default=8326)
    p.add_argument("--smart-turn", default=None, help="path to the Smart Turn ONNX file (default: downloaded)")
    p.add_argument("--parakeet", default="mlx-community/parakeet-tdt-0.6b-v3")
    p.add_argument("--turn-silence-ms", type=int, default=1500, help="silence that ends a turn when Smart Turn says 'not yet'")
    args = p.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s: %(message)s")
    args.smart_turn = find_smart_turn(args.smart_turn)
    log.info("smart turn: %s", args.smart_turn)
    asyncio.run(main_async(args))


if __name__ == "__main__":
    main()
