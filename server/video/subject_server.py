"""Subject video for mux: a subject from 1–4 reference pictures becomes a clip (Phantom-Wan 1.3B, ByteDance, Apache-2.0).

Why, what it costs, its licence and what was measured: docs/identity.md. Thread's Studio Cast in Sets asked for it (P3):
can a model on mux keep a subject's look from reference pictures alone?

Phantom-Wan 1.3B is Wan2.1-T2V-1.3B's DiT, unchanged in shape, trained to take its subjects from reference pictures.
Each picture (letterboxed on white to the frame) is VAE-encoded to one latent frame and laid after the clip's latent
frames; at every step those frames are put back clean, and the step's three forwards — text and pictures, pictures
alone, neither — are mixed with two guidance scales (pictures 5.0, text 7.5), as upstream's `subject2video.py`
(github.com/Phantom-video/Phantom at bd84b60). The port: upstream's DiT weights are loaded into diffusers'
`WanTransformer3DModel` (diffusers' own converter for original Wan checkpoints), and the text encoder, tokenizer and VAE
are the Wan2.1 ones already on the Mac in the VACE folder; so there is no flash-attn, xfuser, torchrun, float64 or CUDA
code here, only diffusers on MPS as the Wan server runs it. Upstream's sampler (~40 lines) is written again below.

Runs in ~/.mux/video-venv (the Wan server's), its own process on 127.0.0.1:8317 (launchd com.mux.video-subject,
deploy/video-subject.sh). The job API, the queue, the Mac-wide GPU lock, the AI label and the mp4 are the Wan server's
(video_server.py), so this file is only the model.

  POST /v1/videos/generations {model: "video-subject", prompt, negative_prompt?, seed?, seconds (1–5), fps (8–24),
       size ("832x480" | "1280x720"), reference_images_b64: [1–4 pictures of the subject, on white], steps? (10–50),
       label?}                                         → 202 {id, status: "queued", model}
  GET  /v1/videos/{id}, /content, POST /cancel         → as video_server.py
"""
import importlib.util, os, sys, time

here = os.path.dirname(os.path.abspath(__file__))
_spec = importlib.util.spec_from_file_location("video_server", os.path.join(here, "video_server.py"))
vs = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(vs)

_wan_validate = vs.validate   # the Wan server's checks (prompt, seconds, fps, size, seed, label), before ours replace it

PORT = int(os.environ.get("MUX_SUBJECT_PORT", "8317"))
MODEL = os.environ.get("MUX_SUBJECT_MODEL", "phantom-wan-1.3b")
CKPT = os.path.expanduser(os.environ.get("MUX_SUBJECT_CKPT", "~/.mux/models/phantom-wan-1.3b/Phantom-Wan-1.3B.pth"))
CODE = os.path.expanduser(os.environ.get("MUX_SUBJECT_CODE", "~/.mux/phantom"))  # upstream at bd84b60: its sampler
WAN = os.path.expanduser(os.environ.get("MUX_SUBJECT_WAN", "~/.mux/models/wan2.1-vace-1.3b-diffusers"))  # T5, tokenizer, VAE
STEPS = int(os.environ.get("MUX_SUBJECT_STEPS", "30"))   # upstream's default is 50: 150 forwards; 30 for a draft
SHIFT = float(os.environ.get("MUX_SUBJECT_SHIFT", "5.0"))  # upstream's s2v shift, at 480p too
GUIDE_IMG = float(os.environ.get("MUX_SUBJECT_GUIDE_IMG", "5.0"))
GUIDE_TEXT = float(os.environ.get("MUX_SUBJECT_GUIDE_TEXT", "7.5"))
MAX_REFS = 4
MAX_SECONDS = 5  # trained on 81 frames at 16 fps
# Upstream's negative prompt (Wan's own, in Chinese, as the model was trained with): a model input, never shown to anyone
NEGATIVE = ("色调艳丽，过曝，静态，细节模糊不清，字幕，风格，作品，画作，画面，静止，整体发灰，最差质量，低质量，JPEG压缩残留，丑陋的，残缺的，"
            "多余的手指，画得不好的手部，画得不好的脸部，畸形的，毁容的，形态畸形的肢体，手指融合，静止不动的画面，杂乱的背景，三条腿，背景人很多，倒着走")
# Wan2.1-T2V-1.3B's transformer, as diffusers names it (Phantom's configs/wan_s2v_1_3B.py: dim 1536, ffn 8960, 12 heads, 30 layers)
TRANSFORMER = dict(patch_size=(1, 2, 2), num_attention_heads=12, attention_head_dim=128, in_channels=16, out_channels=16,
                   text_dim=4096, freq_dim=256, ffn_dim=8960, num_layers=30, cross_attn_norm=True, qk_norm="rms_norm_across_heads",
                   eps=1e-6, image_dim=None, added_kv_proj_dim=None, rope_max_seq_len=1024)


def load_transformer(path, dtype):
    """Phantom's .pth (upstream's WanModel keys) → diffusers' WanTransformer3DModel, every tensor accounted for."""
    import torch
    from diffusers import WanTransformer3DModel
    from diffusers.loaders.single_file_utils import convert_wan_transformer_to_diffusers
    sd = torch.load(path, map_location="cpu", weights_only=True, mmap=True)  # weights only: no pickled code runs
    sd = convert_wan_transformer_to_diffusers(dict(sd))
    model = WanTransformer3DModel(**TRANSFORMER)   # on the CPU: its RoPE tables are buffers outside the checkpoint
    missing, unexpected = model.load_state_dict(sd, strict=False)
    if missing or unexpected:
        raise RuntimeError(f"the Phantom checkpoint does not fit Wan2.1-1.3B: missing {missing[:4]}, unexpected {unexpected[:4]}")
    # as from_pretrained(torch_dtype=bf16) does: the modules diffusers keeps in float32 stay float32
    keep = set(getattr(model, "_keep_in_fp32_modules", None) or ())
    for name, p in model.named_parameters():
        p.data = p.data.to(torch.float32 if keep & set(name.split(".")) else dtype)
    return model.eval().requires_grad_(False)


def load_pipeline():
    need = float(os.environ.get("MUX_SUBJECT_MIN_FREE_GB", "24"))
    have = vs.available_gb()
    if need and have is not None and have < need:
        raise MemoryError(f"only {have:.0f} GB free on this Mac; the subject model wants {need:g} GB: try again when other models have been let go")
    import torch
    from diffusers import AutoencoderKLWan, WanPipeline
    from diffusers.schedulers.scheduling_unipc_multistep import UniPCMultistepScheduler
    from transformers import AutoTokenizer, UMT5EncoderModel
    device = vs.DEVICE
    if device == "mps":
        if not torch.backends.mps.is_available():
            raise RuntimeError("PyTorch has no MPS device here (Apple Silicon with macOS 14 or later is needed)")
        if os.environ.get("MUX_VIDEO_CONV3D", "frames") == "frames":
            vs.use_conv3d_by_frames()   # the Wan VAE's conv3d on MPS: docs/video.md
    t = time.time()
    pipe = WanPipeline(
        tokenizer=AutoTokenizer.from_pretrained(WAN, subfolder="tokenizer"),
        text_encoder=UMT5EncoderModel.from_pretrained(WAN, subfolder="text_encoder", torch_dtype=torch.bfloat16),
        vae=AutoencoderKLWan.from_pretrained(WAN, subfolder="vae", torch_dtype=torch.float32),
        scheduler=UniPCMultistepScheduler.from_pretrained(WAN, subfolder="scheduler"),
        transformer=load_transformer(CKPT, torch.bfloat16))
    pipe.to(device)
    pipe.set_progress_bar_config(disable=True)
    print(f"loaded {MODEL} in {time.time() - t:.0f} s", file=sys.stderr, flush=True)
    return pipe


def letterbox(im, w, h):
    """Upstream's load_ref_images: fit inside w×h, keep the aspect, pad with white, centred."""
    from PIL import Image, ImageOps
    im = im.convert("RGB")
    if im.width / im.height > w / h:
        nw, nh = w, int(w / (im.width / im.height))
    else:
        nw, nh = int(h * (im.width / im.height)), h
    im = im.resize((nw, nh), Image.Resampling.LANCZOS)
    dw, dh = w - nw, h - nh
    return ImageOps.expand(im, (dw // 2, dh // 2, dw - dw // 2, dh - dh // 2), fill=(255, 255, 255))


def upstream_scheduler(steps, device):
    """Upstream's own FlowUniPCMultistepScheduler (the checkout's phantom_wan/utils/fm_solvers_unipc.py, Wan's, Apache-2.0),
    set as subject2video.py sets it: diffusers' UniPC with flow_shift is close but not equal (timesteps up to 4 apart)."""
    spec = importlib.util.spec_from_file_location("phantom_fm_solvers_unipc", os.path.join(CODE, "phantom_wan", "utils", "fm_solvers_unipc.py"))
    if spec is None or not os.path.exists(spec.origin):
        raise RuntimeError(f"Phantom's code is not at {CODE} (deploy/video-subject.sh clones it)")
    m = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m)
    sched = m.FlowUniPCMultistepScheduler(num_train_timesteps=1000, shift=1, use_dynamic_shifting=False)
    sched.set_timesteps(steps, device=device, shift=SHIFT)
    return sched


def latent_norm(vae, device):
    import torch
    mean = torch.tensor(vae.config.latents_mean, device=device, dtype=torch.float32).view(1, vae.config.z_dim, 1, 1, 1)
    inv_std = 1.0 / torch.tensor(vae.config.latents_std, device=device, dtype=torch.float32).view(1, vae.config.z_dim, 1, 1, 1)
    return mean, inv_std


def render(pipe, req, on_step):
    """Upstream's Phantom_Wan_S2V.generate on diffusers' parts. → uint8 (n, h, w, 3)."""
    import numpy as np
    import torch
    device = vs.DEVICE
    w, h = vs.SIZES[req["size"]]
    n = req["frames"]
    n4 = vs.frames_for(n)
    steps = req["steps"]
    vae, model = pipe.vae, pipe.transformer
    mean, inv_std = latent_norm(vae, device)
    with torch.no_grad():
        ctx, ctx_null = pipe.encode_prompt(req["prompt"], req["negative_prompt"], do_classifier_free_guidance=True,
                                           max_sequence_length=512, device=device, dtype=torch.bfloat16)
        # each reference: one latent frame, as upstream's get_vae_latents (TF.to_tensor, then [-1, 1])
        refs = []
        for im in req["refs"]:
            x = torch.from_numpy(np.asarray(letterbox(im, w, h), dtype=np.float32) / 127.5 - 1.0).permute(2, 0, 1)
            z = vae.encode(x[None, :, None].to(device, torch.float32)).latent_dist.mode()
            refs.append(((z.float() - mean) * inv_std))
        ref = torch.cat(refs, dim=2)                       # [1, 16, r, h/8, w/8]
        r = ref.shape[2]
        t_lat = (n4 - 1) // 4 + 1
        g = torch.Generator(device="cpu").manual_seed(req["seed"])
        latents = torch.randn((1, 16, t_lat + r, h // 8, w // 8), generator=g, dtype=torch.float32).to(device)
        sched = upstream_scheduler(steps, device)
        zeros = torch.zeros_like(ref)

        def fwd(x, c):
            return model(hidden_states=x.to(torch.bfloat16), timestep=t.expand(1), encoder_hidden_states=c,
                         return_dict=False)[0].float()

        for i, t in enumerate(sched.timesteps):
            with_ref = torch.cat([latents[:, :, :-r], ref], dim=2)
            pos_it = fwd(with_ref, ctx)
            pos_i = fwd(with_ref, ctx_null)
            neg = fwd(torch.cat([latents[:, :, :-r], zeros], dim=2), ctx_null)
            pred = neg + GUIDE_IMG * (pos_i - neg) + GUIDE_TEXT * (pos_it - pos_i)
            latents = sched.step(pred, t, latents, return_dict=False)[0]
            on_step(i + 1, steps)
        x0 = latents[:, :, :-r] / inv_std + mean
        video = vae.decode(x0.to(vae.dtype), return_dict=False)[0]
        frames = pipe.video_processor.postprocess_video(video, output_type="np")[0]
    return (np.clip(frames[:n], 0, 1) * 255).round().astype("uint8")


def validate(b):
    """The body → what a job needs. BadInput (400) names what is wrong."""
    if not isinstance(b, dict):
        raise vs.BadInput("the body must be a JSON object")
    if b.get("model", "video-subject") not in ("video-subject", MODEL):
        raise vs.BadInput(f"model must be video-subject (got {str(b.get('model'))[:40]})")
    for key in ("control", "image_b64"):
        if b.get(key) is not None:
            raise vs.BadInput(f"{key} is not taken by video-subject: the subject comes from reference_images_b64 (use video or video-depth for a first frame or depth)")
    refs = b.get("reference_images_b64")
    if not isinstance(refs, list) or not 1 <= len(refs) <= MAX_REFS:
        raise vs.BadInput(f"reference_images_b64 must be a list of 1 to {MAX_REFS} pictures of the subject, on white")
    body = {k: v for k, v in b.items() if k not in ("reference_images_b64", "steps")}
    body["model"] = "video-subject"
    if isinstance(body.get("seconds"), (int, float)) and not isinstance(body.get("seconds"), bool) and body["seconds"] > MAX_SECONDS:
        raise vs.BadInput(f"seconds must be from 1 to {MAX_SECONDS} (got {body['seconds']}): Phantom was trained on 81 frames")
    req = _wan_validate(body)
    req["refs"] = [vs.reference_image(vs.b64(x, f"reference_images_b64[{i}]"), i) for i, x in enumerate(refs)]
    req["steps"] = vs.number(b, "steps", 10, 50, integer=True) if b.get("steps") is not None else STEPS
    if not (b.get("negative_prompt") or "").strip():
        req["negative_prompt"] = NEGATIVE
    return req


# The Wan server's job machinery, with this model in it
vs.MODEL = MODEL
vs.NAMES = {"video-subject", MODEL}
vs.load_pipeline = load_pipeline
vs.render = render
vs.validate = validate
start = vs.start

if __name__ == "__main__":
    if "--warm" in sys.argv:  # deploy/video-subject.sh: load once to check the weights, then exit
        vs.on_device(vs.pipeline)
        sys.exit(0)
    print(f"subject video on 127.0.0.1:{PORT}: {MODEL} ({vs.DEVICE}), {STEPS} steps, guidance {GUIDE_IMG:g}/{GUIDE_TEXT:g}, "
          f"idle {vs.IDLE_MIN:g} min", file=sys.stderr, flush=True)
    start(PORT).serve_forever()
