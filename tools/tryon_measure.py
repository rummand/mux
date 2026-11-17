"""Thread's try-on, measured (docs/image-edit.md): one edit through this checkout's server/images/image_server.py on a spare port
(8322), a fresh process per run, so the peak footprint (lifetime max, load included) is the run's own.
In out_dir: person.png (or PERSON=…), garment-jacket.png, garment-sweater.png, garment-trousers.png (GSUF=-512 picks
garment-*-512.png); PROMPT_FILE=… for another prompt (docs/identity/tryon-prompt-b.txt). Synthetic people only.
argv: out_dir label model_name steps [size]. Prints time, peak footprint (lifetime max, load included), swap before/after."""
import ctypes, json, os, subprocess, sys, time, urllib.request, base64, uuid
out, label, name, steps = sys.argv[1], sys.argv[2], sys.argv[3], int(sys.argv[4])
size = sys.argv[5] if len(sys.argv) > 5 else "832x1248"
SRV = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "server", "images", "image_server.py")
PORT = 8322
env = dict(os.environ, MUX_IMAGES_PORT=str(PORT), HF_HUB_OFFLINE="1", HF_HUB_CACHE=os.path.expanduser("~/.mux/models/hf"),
           MUX_IMAGE_MODEL="flux2-klein-4b-q4", MUX_IMAGE_BASE_MODEL="flux2-klein-4b",
           MUX_IMAGE_MODEL_PATH=os.path.expanduser("~/.mux/models/flux2-klein-4b-mflux-q4"),
           MUX_IMAGE_HQ_MODEL="flux3-image-klein-q8", MUX_IMAGE_HQ_BASE_MODEL="flux3-image-klein",
           MUX_IMAGE_HQ_MODEL_PATH=os.path.expanduser("~/.mux/models/flux-3-image-klein-mflux-q8"))
PROMPT = ("Full-length studio photograph of the woman from image 1: the same face, the same short asymmetric black bob with a silver streak at "
  "the left temple, the same freckles, mole, eyebrows and hazel eyes, the same slim body with broad shoulders, standing in the same pose, arms at her sides. "
  "She now wears the rust-orange 8-wale corduroy chore jacket from image 2 (four round brass buttons, two chest and two hip patch pockets, pointed collar), "
  "worn open over the cream chunky cable-knit wool crew-neck sweater from image 3, and the olive-green high-waisted wide-leg wool trousers from image 4 "
  "(single front pleat, turned-up cuffs, brown horn button), with white canvas sneakers. Seamless light grey paper backdrop, soft north-window daylight "
  "from the left, 50mm lens at f/5.6, natural skin texture with visible pores, real fabric texture, photorealistic.")
GSUF = os.environ.get("GSUF", "")
IMAGES = [os.environ.get("PERSON", "person.png")] + [f"garment-{g}{GSUF}.png" for g in ("jacket", "sweater", "trousers")]

class RU(ctypes.Structure):
    _fields_ = [("uuid", ctypes.c_uint8 * 16)] + [(n, ctypes.c_uint64) for n in (
        "user_time system_time pkg_idle_wkups interrupt_wkups pageins wired_size resident_size phys_footprint "
        "proc_start_abstime proc_exit_abstime child_user_time child_system_time child_pkg_idle_wkups "
        "child_interrupt_wkups child_pageins child_elapsed_abstime diskio_bytesread diskio_byteswritten "
        "cpu_time_qos_default cpu_time_qos_maintenance cpu_time_qos_background cpu_time_qos_utility "
        "cpu_time_qos_legacy cpu_time_qos_user_initiated cpu_time_qos_user_interactive billed_system_time "
        "serviced_system_time logical_writes lifetime_max_phys_footprint instructions cycles billed_energy "
        "serviced_energy interval_max_phys_footprint runnable_time").split()]
libc = ctypes.CDLL("/usr/lib/libSystem.dylib")
def usage(pid):
    ru = RU(); libc.proc_pid_rusage(pid, 4, ctypes.byref(ru)); return ru
swap = lambda: subprocess.run(["sysctl", "-n", "vm.swapusage"], capture_output=True, text=True).stdout.split()[5]

log = open(f"{out}/{label}.log", "w")
p = subprocess.Popen([os.path.expanduser("~/.mux/images-venv/bin/python"), SRV], env=env, stderr=log, stdout=log)
try:
    for _ in range(60):
        try: urllib.request.urlopen(f"http://127.0.0.1:{PORT}/health", timeout=1); break
        except Exception: time.sleep(0.5)
    b = uuid.uuid4().hex
    PR = open(os.environ["PROMPT_FILE"]).read().strip() if os.environ.get("PROMPT_FILE") else PROMPT
    fields = {"prompt": PR, "model": name, "seed": "11", "steps": str(steps), "size": size}
    body = b"".join(f"--{b}\r\nContent-Disposition: form-data; name=\"{k}\"\r\n\r\n{v}\r\n".encode() for k, v in fields.items())
    for f in IMAGES:
        body += f"--{b}\r\nContent-Disposition: form-data; name=\"image[]\"; filename=\"{f}\"\r\nContent-Type: image/png\r\n\r\n".encode() + open(f"{out}/{f}", "rb").read() + b"\r\n"
    body += f"--{b}--\r\n".encode()
    s0 = swap(); t = time.time()
    req = urllib.request.Request(f"http://127.0.0.1:{PORT}/v1/images/edits", data=body, headers={"content-type": f"multipart/form-data; boundary={b}"})
    with urllib.request.urlopen(req, timeout=3600) as r:
        d = json.loads(r.read())
    dt = time.time() - t
    open(f"{out}/{label}.png", "wb").write(base64.b64decode(d["data"][0]["b64_json"]))
    peak = usage(p.pid).lifetime_max_phys_footprint / 1024**3
    res = {"label": label, "model": d["model"], "steps": steps, "size": size, "seconds_incl_load": round(dt, 1), "peak_footprint_gb": round(peak, 1), "swap_before": s0, "swap_after": swap()}
    print(json.dumps(res), flush=True)
    open(f"{out}/results.jsonl", "a").write(json.dumps(res) + "\n")
finally:
    p.terminate(); p.wait(30); log.close()
