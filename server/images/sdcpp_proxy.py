"""FLUX.2 [dev] for mux: OpenAI's POST /v1/images/generations and /v1/images/edits in front of stable-diffusion.cpp.

The owner (2026-11-17): "We want FLUX.2-dev running" — beside the fast FLUX.2 klein (server/images/image_server.py),
not instead of it. FLUX.2 [dev] is 32 B parameters: its GGUF (city96, Q4_K_M, 20 GB) and its text encoder (Mistral
Small 3.2 24B, Q4_K_M, 14 GB) take ~35 GB while they run, so they must not sit in memory beside the chat models all day.
mflux has no FLUX.2 [dev]; stable-diffusion.cpp's sd-server (Metal) runs it and speaks OpenAI's image API.

This front, on 127.0.0.1:8320 (launchd com.mux.images-dev), starts sd-server (127.0.0.1:8321) with the model on the first
request — only with MUX_SDCPP_MIN_FREE_GB (36) free, else a 503 at once that says why — passes the request through as
it came, one image at a time, and stops sd-server after MUX_SDCPP_IDLE_MIN (10) idle minutes so its memory goes back.
Licences: FLUX.2 [dev] Non-Commercial License (we are research: allowed, CLAUDE.md); Mistral Small 3.2 Apache-2.0.
Notes and measurements: docs/image-dev.md. Installed by deploy/flux2-dev.sh. Images are never written to disk.
"""
import json, os, subprocess, sys, threading, time, urllib.error, urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HOME = os.path.expanduser("~")
PORT = int(os.environ.get("MUX_IMAGES_DEV_PORT", "8320"))
SD_PORT = int(os.environ.get("MUX_SDCPP_PORT", "8321"))
SD_BIN = os.environ.get("MUX_SDCPP_BIN", f"{HOME}/.mux/sdcpp/sd-server")
DIR = os.environ.get("MUX_SDCPP_MODEL_DIR", f"{HOME}/.mux/models/flux2-dev-sdcpp")
DIFFUSION = os.environ.get("MUX_SDCPP_DIFFUSION", f"{DIR}/flux2-dev-Q4_K_M.gguf")
LLM = os.environ.get("MUX_SDCPP_LLM", f"{DIR}/Mistral-Small-3.2-24B-Instruct-2506-Q4_K_M.gguf")
VAE = os.environ.get("MUX_SDCPP_VAE", f"{DIR}/split_files/vae/flux2-vae.safetensors")
MODEL = os.environ.get("MUX_SDCPP_MODEL", "flux2-dev-q4")
STEPS = int(os.environ.get("MUX_SDCPP_STEPS", "28"))
IDLE_MIN = float(os.environ.get("MUX_SDCPP_IDLE_MIN", "10"))
MIN_FREE_GB = float(os.environ.get("MUX_SDCPP_MIN_FREE_GB", "36"))
# Measured 2026-11-17 (M3 Ultra, 1024x1024, Q4_K_M): ~30 s a step with the whole model in GPU memory; with the weights
# memory-mapped and at most 16 GB of them held (--mmap --offload-to-cpu --max-vram 16) 70-85 s a step, 35-40 minutes
# an image — unusable. So it runs whole (~35 GB) or not at all: without 36 GB free it refuses at once, and mux's route
# falls back to FLUX.2 klein. MUX_SDCPP_MAX_VRAM_GB caps it again if ever wanted ("" = no cap).
MAX_VRAM_GB = os.environ.get("MUX_SDCPP_MAX_VRAM_GB", "")
LOAD_TIMEOUT_S = 600
MAX_BODY = 48 * 1024 * 1024

_proc = None            # sd-server, while it runs
_last_used = 0.0
_gpu = threading.Lock()  # one image at a time; also guards starting and stopping
LOG = open(os.environ.get("MUX_SDCPP_LOG", f"{HOME}/.mux/logs/sdcpp-server.log"), "ab", buffering=0)


def log(msg):
    print(msg, file=sys.stderr, flush=True)


def available_gb():
    """What macOS could hand out now (free, inactive, purgeable, speculative pages); None where it cannot be read."""
    if sys.platform != "darwin":
        return None
    try:
        out = subprocess.run(["vm_stat"], capture_output=True, text=True, timeout=5).stdout
        page = int(out.split("page size of ")[1].split()[0])
        pages = {k.strip(): int(v.strip().rstrip(".")) for k, v in (ln.split(":", 1) for ln in out.splitlines()[1:] if ":" in ln)}
        return sum(pages.get(k, 0) for k in ("Pages free", "Pages inactive", "Pages purgeable", "Pages speculative")) * page / 1024**3
    except Exception:  # noqa: BLE001
        return None


def sd(path, timeout=10):
    with urllib.request.urlopen(f"http://127.0.0.1:{SD_PORT}{path}", timeout=timeout) as r:
        return json.loads(r.read() or b"{}")


def running():
    return _proc is not None and _proc.poll() is None


def start():
    """sd-server with FLUX.2 [dev] loaded, or an error to give the caller. Called holding _gpu."""
    global _proc
    if running():
        return None
    for f in (SD_BIN, DIFFUSION, LLM, VAE):
        if not os.path.exists(f):
            return f"missing {f}: run ./deploy/flux2-dev.sh"
    have = available_gb()
    if MIN_FREE_GB and have is not None and have < MIN_FREE_GB:
        return f"only {have:.0f} GB free on this Mac right now; FLUX.2 [dev] needs {MIN_FREE_GB:g} GB: try again in a few minutes, or use the fast image model"
    t = time.time()
    _proc = subprocess.Popen([SD_BIN, "--listen-ip", "127.0.0.1", "--listen-port", str(SD_PORT),
                              "--diffusion-model", DIFFUSION, "--llm", LLM, "--vae", VAE,
                              "--cfg-scale", "1.0", "--sampling-method", "euler", "--steps", str(STEPS), "--flash-attn", "auto"]
                             + (["--mmap", "--offload-to-cpu", "--max-vram", MAX_VRAM_GB] if MAX_VRAM_GB else []),
                             stdout=LOG, stderr=LOG, cwd=os.path.dirname(SD_BIN))
    while time.time() - t < LOAD_TIMEOUT_S:
        if _proc.poll() is not None:
            _proc = None
            return f"sd-server stopped while loading FLUX.2 [dev] (see {HOME}/.mux/logs/sdcpp-server.log)"
        try:
            st = sd("/sdcpp/v1/models/status", timeout=3)
            state = str(st.get("state") or st.get("status") or "").lower()
            if state in ("ready", "loaded"):
                log(f"loaded {MODEL} in {time.time() - t:.0f} s")
                return None
            if state in ("error", "failed"):
                stop()
                return f"FLUX.2 [dev] failed to load: {st.get('error') or st}"
        except (urllib.error.URLError, OSError, ValueError):
            pass
        time.sleep(2)
    stop()
    return f"FLUX.2 [dev] did not load in {LOAD_TIMEOUT_S} s"


def stop():
    global _proc
    if _proc is not None:
        _proc.terminate()
        try:
            _proc.wait(timeout=30)
        except subprocess.TimeoutExpired:
            _proc.kill()
        _proc = None
        log(f"let go of {MODEL}")


def idle_watch():
    while True:
        time.sleep(30)
        if running() and time.time() - _last_used > IDLE_MIN * 60 and _gpu.acquire(blocking=False):
            try:
                if running() and time.time() - _last_used > IDLE_MIN * 60:
                    stop()
            finally:
                _gpu.release()


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *a):  # quiet: prompts are not logged
        pass

    def _send(self, status, body, ctype="application/json"):
        data = body if isinstance(body, bytes) else json.dumps(body).encode()
        self.send_response(status)
        self.send_header("content-type", ctype)
        self.send_header("content-length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _error(self, status, message):
        self._send(status, {"error": {"message": message, "type": "invalid_request_error" if status < 500 else "server_error"}})

    def do_GET(self):
        if self.path.rstrip("/") in ("/health", "/v1/models"):
            return self._send(200, {"object": "list", "data": [{"id": MODEL, "object": "model", "loaded": running(), "steps": STEPS}]})
        self._error(404, "not found")

    def do_POST(self):
        global _last_used
        path = self.path.split("?")[0].rstrip("/")
        if not (path.endswith("/images/generations") or path.endswith("/images/edits")):
            return self._error(404, "POST /v1/images/generations or /v1/images/edits")
        length = int(self.headers.get("content-length") or 0)
        if length > MAX_BODY:
            return self._error(413, f"at most {MAX_BODY // 1024 // 1024} MB")
        raw = self.rfile.read(length)
        if not _gpu.acquire(timeout=900):
            return self._error(503, "FLUX.2 [dev] is busy with another image: try again shortly")
        try:
            err = start()
            if err:
                return self._error(503, err)
            _last_used = time.time()
            req = urllib.request.Request(f"http://127.0.0.1:{SD_PORT}/v1{path[path.index('/images'):]}", data=raw, method="POST",
                                         headers={"content-type": self.headers.get("content-type") or "application/json"})
            try:
                with urllib.request.urlopen(req, timeout=1800) as r:
                    body, status, ctype = r.read(), r.status, r.headers.get("content-type") or "application/json"
            except urllib.error.HTTPError as e:
                body, status, ctype = e.read(), e.code, e.headers.get("content-type") or "application/json"
            _last_used = time.time()
            if ctype.startswith("application/json"):
                try:  # answer as this model, whatever sd-server calls itself
                    j = json.loads(body)
                    if isinstance(j, dict) and "data" in j:
                        j["model"] = MODEL
                        body = json.dumps(j).encode()
                except ValueError:
                    pass
            self._send(status, body, ctype)
        except (urllib.error.URLError, OSError) as e:
            self._error(502, f"sd-server: {e}")
        finally:
            _gpu.release()


if __name__ == "__main__":
    threading.Thread(target=idle_watch, daemon=True).start()
    log(f"FLUX.2 [dev] via stable-diffusion.cpp on 127.0.0.1:{PORT} (sd-server :{SD_PORT}, {STEPS} steps, idle {IDLE_MIN:g} min, needs {MIN_FREE_GB:g} GB free)")
    ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
