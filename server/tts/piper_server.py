"""Text to speech for mux: OpenAI's POST /v1/audio/speech in front of Piper (rhasspy/piper, open source).

Runs in ~/.mux/tts-venv (python3.11 -m venv ~/.mux/tts-venv && ~/.mux/tts-venv/bin/pip install piper-tts).
Voices are Piper .onnx files in ~/.mux/models/piper; the request's `voice` (or `model`) names one, e.g.
"da_DK-talesyntese-medium" (Danish, CC0). Each voice is loaded once and kept. mp3 and opus go through ffmpeg;
wav and pcm come straight from Piper. Started by deploy/audio.sh as launchd agent com.mux.tts on 127.0.0.1:8311.
"""
import io, json, os, subprocess, sys, threading, wave
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from piper import PiperVoice

VOICES = os.path.expanduser(os.environ.get("MUX_PIPER_DIR", "~/.mux/models/piper"))
DEFAULT = os.environ.get("MUX_PIPER_VOICE", "da_DK-talesyntese-medium")
PORT = int(os.environ.get("MUX_TTS_PORT", "8311"))
MAX_CHARS = 4000

_voices: dict[str, PiperVoice] = {}
_lock = threading.Lock()

def voice(name: str) -> PiperVoice:
    name = name if os.path.exists(os.path.join(VOICES, f"{name}.onnx")) else DEFAULT
    with _lock:
        if name not in _voices:
            _voices[name] = PiperVoice.load(os.path.join(VOICES, f"{name}.onnx"))
        return _voices[name]

def wav_bytes(text: str, v: PiperVoice) -> bytes:
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        v.synthesize_wav(text, w)
    return buf.getvalue()

FORMATS = {"mp3": ("audio/mpeg", ["-f", "mp3", "-b:a", "64k"]), "opus": ("audio/ogg", ["-f", "ogg", "-c:a", "libopus", "-b:a", "32k"])}

class Handler(BaseHTTPRequestHandler):
    def _send(self, status: int, body: bytes, kind: str = "application/json"):
        self.send_response(status)
        self.send_header("content-type", kind)
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _error(self, status: int, message: str):
        self._send(status, json.dumps({"error": {"message": message, "type": "invalid_request_error" if status < 500 else "server_error"}}).encode())

    def do_GET(self):
        if self.path.rstrip("/") in ("", "/health", "/v1/models"):
            names = sorted(f[:-5] for f in os.listdir(VOICES) if f.endswith(".onnx"))
            return self._send(200, json.dumps({"object": "list", "data": [{"id": n, "object": "model"} for n in names]}).encode())
        self._error(404, "not found")

    def do_POST(self):
        if not self.path.split("?")[0].rstrip("/").endswith("/audio/speech"):
            return self._error(404, "not found")
        try:
            body = json.loads(self.rfile.read(int(self.headers.get("content-length") or 0)) or b"{}")
        except ValueError:
            return self._error(400, "body is not JSON")
        text = str(body.get("input") or "").strip()
        if not text or len(text) > MAX_CHARS:
            return self._error(400, f"input is required, at most {MAX_CHARS} characters")
        try:
            audio = wav_bytes(text, voice(str(body.get("voice") or body.get("model") or DEFAULT)))
            fmt = body.get("response_format") or "mp3"
            if fmt in FORMATS:
                kind, args = FORMATS[fmt]
                audio = subprocess.run(["ffmpeg", "-loglevel", "error", "-i", "pipe:0", *args, "pipe:1"], input=audio, capture_output=True, check=True).stdout
            elif fmt == "pcm":
                kind, audio = "audio/pcm", audio[44:]
            else:
                kind = "audio/wav"
            self._send(200, audio, kind)
        except Exception as e:  # noqa: BLE001 – the caller gets the reason, mux falls through to the next model
            self._error(500, str(e)[:300])

    def log_message(self, *_):
        pass

if __name__ == "__main__":
    voice(DEFAULT)  # warm the default voice
    print(f"piper tts on 127.0.0.1:{PORT}, voices in {VOICES}", file=sys.stderr, flush=True)
    ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
