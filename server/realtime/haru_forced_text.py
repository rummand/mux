"""The deciding test of the duplex track: can Haru-4B be made to say a sentence an LLM wrote?

    ~/.mux/haru-venv/bin/python server/realtime/haru_forced_text.py [--quantize 8] [--voice ~/.mux/haru/voice-en.wav]

For each test sentence it runs three conversations of silence from the caller, with the same seed:
  control   Haru on its own (no forcing): what it says unprompted. A broken setup shows here, not as a FAIL below.
  dense     the sentence's tokens forced one per frame (133 ms each), after an EOP.
  paced     each token followed by one PAD frame (half the text rate).
The model's audio is saved under ~/.mux/haru/forced/ and transcribed through mux's `transcribe` route (whisper), and
the word error rate against the sentence is printed. PASS when the better forced mode has WER ≤ 0.25 on every
sentence; the time per frame is printed too (a forced frame must still fit in 133 ms to be usable live).

Needs: the Haru venv (deploy/haru.sh), mux running on :7070, and a key for a tenant that may use `transcribe` in
MUX_KEY (deploy/haru.sh --forced-text makes a one-day key and revokes it after).
"""

from __future__ import annotations

import argparse
import io
import json
import os
import re
import sys
import time
import urllib.request
import uuid
import wave

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from haru_forced import forced_session_class  # noqa: E402

SENTENCES = [
    "You have three invoices that are more than thirty days late.",
    "Your next meeting is with Anna at two o'clock on Thursday.",
    "I have drafted the reply and put it on your desk for review.",
]


def wav_bytes(audio: np.ndarray, rate: int = 24000) -> bytes:
    b = io.BytesIO()
    with wave.open(b, "wb") as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(rate)
        w.writeframes((np.clip(audio, -1, 1) * 32767).astype("<i2").tobytes())
    return b.getvalue()


def transcribe(base: str, key: str, wav: bytes) -> str:
    boundary = uuid.uuid4().hex
    parts = []
    for name, value in (("model", "transcribe"), ("language", "en"), ("response_format", "json")):
        parts.append(f"--{boundary}\r\nContent-Disposition: form-data; name=\"{name}\"\r\n\r\n{value}\r\n".encode())
    parts.append(f"--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"haru.wav\"\r\nContent-Type: audio/wav\r\n\r\n".encode() + wav + b"\r\n")
    parts.append(f"--{boundary}--\r\n".encode())
    req = urllib.request.Request(f"{base}/v1/audio/transcriptions", data=b"".join(parts), method="POST",
                                 headers={"Authorization": f"Bearer {key}", "Content-Type": f"multipart/form-data; boundary={boundary}"})
    with urllib.request.urlopen(req, timeout=120) as r:
        return str(json.loads(r.read()).get("text", "")).strip()


def words(s: str) -> list[str]:
    return re.sub(r"[^a-z0-9' ]+", " ", s.lower().replace("o'clock", "oclock")).split()


def wer(ref: str, hyp: str) -> float:
    r, h = words(ref), words(hyp)
    d = np.zeros((len(r) + 1, len(h) + 1), dtype=int)
    d[:, 0] = range(len(r) + 1)
    d[0, :] = range(len(h) + 1)
    for i in range(1, len(r) + 1):
        for j in range(1, len(h) + 1):
            d[i, j] = min(d[i - 1, j] + 1, d[i, j - 1] + 1, d[i - 1, j - 1] + (r[i - 1] != h[j - 1]))
    return d[len(r), len(h)] / max(1, len(r))


def main():
    p = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    p.add_argument("--hf-repo", default="higurashi-ai/Haru-4B")
    p.add_argument("--quantize", choices=("8", "none"), default="8")
    p.add_argument("--voice", default=os.path.expanduser("~/.mux/haru/voice-en.wav"))
    p.add_argument("--mux", default=os.environ.get("MUX_URL", "http://127.0.0.1:7070"))
    p.add_argument("--seed", type=int, default=7)
    p.add_argument("--out", default=os.path.expanduser("~/.mux/haru/forced"))
    p.add_argument("--sentence", action="append", help="test this sentence instead (repeatable)")
    args = p.parse_args()
    key = os.environ.get("MUX_KEY", "")
    if not key:
        sys.exit("MUX_KEY: a mux key that may use the transcribe route")
    os.makedirs(args.out, exist_ok=True)

    from haru_mlx import DuplexConfig, HaruModel
    from haru_mlx.audio import load_audio, prepare_reference

    t0 = time.time()
    model = HaruModel.from_pretrained(args.hf_repo, quantize=8) if args.quantize == "8" else HaruModel.from_pretrained(args.hf_repo)
    print(f"Haru loaded in {time.time() - t0:.1f} s ({'8-bit' if args.quantize == '8' else 'bf16'})")
    voice = prepare_reference(load_audio(args.voice)) if os.path.isfile(args.voice) else None
    if voice is None:
        print(f"  (no voice clip at {args.voice}: Haru picks a voice of its own)")
    Session = forced_session_class()
    silence = np.zeros(model.config.frame_samples, dtype=np.float32)

    def run(sentence: str, mode: str):
        s = Session(model, system_prompt="You are Bloom, a helpful assistant. You speak English.", reference=voice, config=DuplexConfig(seed=args.seed))
        frames, texts, step_ms = [], [], []
        f = s.start()
        frames.append(f.audio)
        n = 0
        if mode != "control":
            # Three frames of quiet first, as if the back-brain's sentence arrived mid-call
            for _ in range(3):
                f = s.step(silence); frames.append(f.audio); texts.append(f.text)
            n = s.force(sentence, pace=0 if mode == "dense" else 1)
        for _ in range(n + 40):  # the forced frames and ~5 s for the voice to finish
            t = time.perf_counter()
            f = s.step(silence)
            step_ms.append((time.perf_counter() - t) * 1000)
            frames.append(f.audio); texts.append(f.text)
        audio = np.concatenate(frames)
        path = os.path.join(args.out, f"{abs(hash(sentence)) % 10**6}-{mode}.wav")
        data = wav_bytes(audio)
        with open(path, "wb") as fh:
            fh.write(data)
        heard = transcribe(args.mux, key, data)
        return heard, "".join(texts).strip(), float(np.median(step_ms)), path

    rows, passed = [], True
    for sentence in args.sentence or SENTENCES:
        best = 9.0
        for mode in ("control", "dense", "paced"):
            heard, text, ms, path = run(sentence, mode)
            w = wer(sentence, heard)
            if mode != "control":
                best = min(best, w)
            rows.append((mode, w, ms, heard, text, path))
            print(f"[{mode:7}] WER {w:4.2f}  step p50 {ms:5.1f} ms  heard: {heard!r}\n          text stream: {text[:120]!r}\n          {path}")
        passed &= best <= 0.25
        print(f"→ {sentence!r}: best forced WER {best:.2f}\n")
    steps = [r[2] for r in rows if r[0] != "control"]
    print(f"Forced-text test: {'PASS' if passed else 'FAIL'} (best forced WER ≤ 0.25 on every sentence); forced step p50 {np.median(steps):.1f} ms of a 133 ms frame")
    sys.exit(0 if passed else 1)


if __name__ == "__main__":
    main()
