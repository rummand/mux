"""LingBot-World v2 1.3B causal-fast on Apple Silicon (PyTorch MPS), for mux's `video-camera` route.

Licence of THIS FILE: CC BY-NC-SA 4.0 (https://creativecommons.org/licenses/by-nc-sa/4.0/). It is adapted from
LingBot-World v2 by the Robbyant Team (Ant Group), https://github.com/robbyant/lingbot-world-v2 at commit
1895d300d8ac936401689b26389f51cbd36530eb, itself licensed CC BY-NC-SA 4.0 and built on Wan2.1/2.2 (Alibaba Wan team,
Apache-2.0). Credit: "Infinite Worlds with Versatile Interactions", Gao et al., arXiv:2607.07534 (2026). Non-commercial
use only; anything adapted from this file must keep this licence. The rest of mux is not under this licence.

What was changed from upstream (no upstream file is copied into mux; the pinned checkout is imported and patched at
run time, and the parts below are rewritten from wan/image2video.py, wan/modules/model_fast.py,
wan/modules/attention.py, wan/modules/vae2_1.py and wan/utils/cam_utils.py):
  - flash-attn (which asserts a CUDA device, and is called directly by the cross-attention) → PyTorch's
    scaled_dot_product_attention, in bf16 as flash-attn computes, split over the queries so the score matrix stays
    under MUX_CAMERA_ATTN_MB.
  - float64 (which MPS has not got): the 3D RoPE is applied in float32 real arithmetic instead of complex128; the
    sinusoidal timestep embedding is computed in float64 on the CPU and moved over in float32.
  - torch.cuda.current_device() as a default argument in wan/modules/t5.py ran at import and failed without CUDA.
  - torch.amp.autocast('cuda', …) is a no-op on a Mac, and an MPS matmul of float32 with bfloat16 aborts the process
    (a Metal assertion, not an exception). So by default the DiT runs in float32 (on an M3 Ultra float32 matmuls run at
    ~93 % of bfloat16's speed: 17.6 against 19.0 TFLOPS, measured), and the attention and its KV cache in bfloat16, as
    on CUDA. MUX_CAMERA_DTYPE=bf16 runs the DiT in bfloat16 under MPS autocast instead (half the weights' memory;
    the few layers upstream keeps in float32 then run in bfloat16).
  - one process and one device: no torchrun, NCCL, FSDP or Ulysses.
  - the causal-fast loop (_generate_causal_fast) as a generator: the first-frame condition is VAE-encoded and the
    latents decoded chunk by chunk (the Wan VAE is causal, so this is exact), frames come out as each chunk is done,
    and memory does not grow with the length of the take. Poses come in already converted (camera_poses.py).
  - T5: by default the same umT5-XXL weights from the diffusers copy mux already keeps for Wan2.1-VACE
    (transformers' UMT5EncoderModel), so ~11 GB are not stored twice; MUX_CAMERA_T5_PTH uses Wan's own .pth instead.
  - the text encoder is let go after each prompt is encoded (MUX_CAMERA_KEEP_T5=1 keeps it).
"""
import gc
import hashlib
import math
import os
import sys
import time
import types
from collections import OrderedDict

import numpy as np
import torch
import torch.nn.functional as F

UPSTREAM_COMMIT = "1895d300d8ac936401689b26389f51cbd36530eb"

# wan/configs/wan_i2v_1_3B.py and generate.py / README (the 1.3B causal-fast command)
DIT = dict(model_type="i2v", patch_size=(1, 2, 2), text_len=512, in_dim=36, dim=1536, ffn_dim=8960, freq_dim=256,
           text_dim=4096, out_dim=16, num_heads=12, num_layers=30, qk_norm=True, cross_attn_norm=True, eps=1e-6)
LOCAL_ATTN = 18          # --local_attn_size 18: latent frames of KV kept
SINK = 6                 # --sink_size 6: the first latent frames always kept
CHUNK = 4                # --chunk_size (default 4): latent frames per chunk
SHIFT = 5.0              # sample_shift of the 1.3B config
STEPS_INDEX = (0, 250, 500, 750)   # WanI2VCausal.generate's timesteps_index: 4 steps, no CFG
NUM_TRAIN_TIMESTEPS = 1000
VAE_STRIDE = (4, 8, 8)
TEXT_LEN = 512

ATTN_DTYPE = torch.bfloat16
ATTN_BYTES = int(float(os.environ.get("MUX_CAMERA_ATTN_MB", "1024")) * 1024 * 1024)


# ── importing the pinned upstream checkout, patched for MPS ───────────────────────────────────────────────────────

def _stub_package(name, path):
    mod = types.ModuleType(name)
    mod.__path__ = [path]
    sys.modules[name] = mod
    return mod


def import_wan(code_dir):
    """Import wan.modules.{model_fast, vae2_1} from the checkout without running wan/__init__.py (which pulls in the
    CUDA-only distributed code, torchvision and scipy), then patch them. Returns (model_fast, vae2_1)."""
    if "wan.modules.model_fast" in sys.modules:
        return sys.modules["wan.modules.model_fast"], sys.modules["wan.modules.vae2_1"]
    wan_dir = os.path.join(code_dir, "wan")
    if not os.path.isfile(os.path.join(wan_dir, "modules", "model_fast.py")):
        raise RuntimeError(f"no LingBot-World v2 checkout at {code_dir} (deploy/video-camera.sh clones it)")
    _stub_package("wan", wan_dir)
    _stub_package("wan.modules", os.path.join(wan_dir, "modules"))
    _stub_package("wan.utils", os.path.join(wan_dir, "utils"))
    import importlib
    attention = importlib.import_module("wan.modules.attention")
    model = importlib.import_module("wan.modules.model")
    model_fast = importlib.import_module("wan.modules.model_fast")
    vae2_1 = importlib.import_module("wan.modules.vae2_1")
    # upstream's own, kept for the parity tests (test_lingbot_mps.py)
    model_fast.upstream = types.SimpleNamespace(causal_rope_apply=model_fast.causal_rope_apply,
                                                sinusoidal_embedding_1d=model_fast.sinusoidal_embedding_1d)
    attention.flash_attention = sdpa_attention
    attention.attention = sdpa_attention
    model.flash_attention = sdpa_attention
    model_fast.flash_attention = sdpa_attention    # the cross-attention calls it directly
    model_fast.attention = sdpa_attention          # the causal self-attention
    model_fast.causal_rope_apply = causal_rope_apply_real
    model_fast.sinusoidal_embedding_1d = sinusoidal_embedding_1d_cpu64
    return model_fast, vae2_1


def import_wan_t5(code_dir):
    """wan.modules.t5 (only for MUX_CAMERA_T5_PTH): its T5EncoderModel has device=torch.cuda.current_device() as a
    default argument, evaluated at import; without CUDA that raises, so it is stood in for during the import."""
    import importlib
    import_wan(code_dir)
    real = torch.cuda.current_device
    torch.cuda.current_device = lambda: "cpu"
    try:
        return importlib.import_module("wan.modules.t5")
    finally:
        torch.cuda.current_device = real


# ── the MPS replacements ──────────────────────────────────────────────────────────────────────────────────────────

def sdpa_attention(q, k, v, q_lens=None, k_lens=None, dropout_p=0.0, softmax_scale=None, q_scale=None, causal=False,
                   window_size=(-1, -1), deterministic=False, dtype=torch.bfloat16, version=None, fa_version=None):
    """flash_attention / attention of wan/modules/attention.py on any device: q [B, Lq, N, C], k and v [B, Lk, N, C]
    → [B, Lq, N, C] in q's dtype. Computed in ATTN_DTYPE (bf16, as flash-attn), queries split so the scores stay
    under ATTN_BYTES. k_lens masks padded keys, as flash-attn's varlen call does; q_lens rows past their length are
    computed and left (callers never read them)."""
    if window_size != (-1, -1):
        raise NotImplementedError("sliding-window flash attention is not used by LingBot-World v2's 1.3B")
    out_dtype = q.dtype
    b, lq, n, _ = q.shape
    lk = k.shape[1]
    qh = q.transpose(1, 2).to(ATTN_DTYPE)
    kh = k.transpose(1, 2).to(ATTN_DTYPE)
    vh = v.transpose(1, 2).to(ATTN_DTYPE)
    if q_scale is not None:
        qh = qh * q_scale
    mask = None
    if k_lens is not None:
        keep = torch.arange(lk, device=k.device)[None, :] < k_lens.to(k.device)[:, None]
        mask = keep[:, None, None, :]
    per_row = b * n * lk * 2
    step = lq if causal else max(1, min(lq, ATTN_BYTES // max(1, per_row)))
    outs = []
    for i in range(0, lq, step):
        outs.append(F.scaled_dot_product_attention(qh[:, :, i:i + step], kh, vh, attn_mask=mask, dropout_p=dropout_p,
                                                   is_causal=causal, scale=softmax_scale))
    out = outs[0] if len(outs) == 1 else torch.cat(outs, dim=2)
    return out.transpose(1, 2).contiguous().to(out_dtype)


def rope_tables(freqs):
    """upstream's complex128 RoPE table [1024, C/2] → float32 [1024, C/2, 2] (cos, sin), computed in float64 first."""
    if torch.is_complex(freqs):
        return torch.view_as_real(freqs.to(torch.complex128)).to(torch.float32)
    return freqs


def causal_rope_apply_real(x, grid_sizes, freqs, start_frame=0):
    """model_fast.causal_rope_apply without complex128: x [B, L, N, C], freqs the (cos, sin) table of rope_tables."""
    n, c = x.size(2), x.size(3) // 2
    freqs = rope_tables(freqs).to(x.device)
    parts = freqs.split([c - 2 * (c // 3), c // 3, c // 3], dim=1)
    output = []
    for i, (f, h, w) in enumerate(grid_sizes.tolist()):
        seq_len = f * h * w
        fr = torch.cat([
            parts[0][start_frame:start_frame + f].view(f, 1, 1, -1, 2).expand(f, h, w, -1, 2),
            parts[1][:h].view(1, h, 1, -1, 2).expand(f, h, w, -1, 2),
            parts[2][:w].view(1, 1, w, -1, 2).expand(f, h, w, -1, 2),
        ], dim=3).reshape(seq_len, 1, c, 2)
        xi = x[i, :seq_len].to(torch.float32).reshape(seq_len, n, c, 2)
        a, bb = xi[..., 0], xi[..., 1]
        cos, sin = fr[..., 0], fr[..., 1]
        xr = torch.stack([a * cos - bb * sin, a * sin + bb * cos], dim=-1).flatten(2)
        output.append(torch.cat([xr, x[i, seq_len:].to(torch.float32)]))
    return torch.stack(output).type_as(x)


def sinusoidal_embedding_1d_cpu64(dim, position):
    """model.sinusoidal_embedding_1d (float64) on the CPU, returned in float32 on position's device."""
    assert dim % 2 == 0
    half = dim // 2
    # to the CPU first, then to float64: MPS asked for both at once hands back zeros (no float64 there)
    pos = position.detach().to("cpu").to(torch.float64)
    sinusoid = torch.outer(pos, torch.pow(10000, -torch.arange(half, dtype=torch.float64).div(half)))
    return torch.cat([torch.cos(sinusoid), torch.sin(sinusoid)], dim=1).to(position.device, torch.float32)


# ── the sampler: FlowUniPCMultistepScheduler(shift=1).set_timesteps(1000, shift=5), as image2video.py uses it ──────

def fast_schedule(shift=SHIFT, index=STEPS_INDEX, n=NUM_TRAIN_TIMESTEPS):
    """[(timestep, sigma for x0, sigma to re-noise to before the next step or None)] for the 4 causal-fast steps, the
    numbers image2video.py gets from the scheduler: timesteps are int64, x0 takes the sigma at the first matching
    timestep (argmin), add_noise the second match when a timestep repeats (index_for_timestep)."""
    sigma_max = float(np.float32(1 - 1 / n))        # the constructor's sigmas[0], through float32
    s = np.linspace(sigma_max, 0.0, n + 1)[:-1]
    s = shift * s / (1 + (shift - 1) * s)
    timesteps = (s * n).astype(np.int64)
    sigmas = np.concatenate([s, [0.0]]).astype(np.float32)
    out = []
    picked = [int(timesteps[i]) for i in index]
    for j, t in enumerate(picked):
        x0_sigma = float(sigmas[int(np.argmin(np.abs(timesteps - t)))])
        nxt = None
        if j + 1 < len(picked):
            hits = np.nonzero(timesteps == picked[j + 1])[0]
            nxt = float(sigmas[hits[1] if len(hits) > 1 else hits[0]])
        out.append((t, x0_sigma, nxt))
    return out


# ── camera rays (cam_utils.get_plucker_embeddings, then image2video.py's rearranges) ────────────────────────────────

def plucker_chunk(deltas, K, h, w, lat_h, lat_w, device, dtype):
    """deltas [f, 4, 4] (framewise OpenCV c2w), K (fx, fy, cx, cy) → [1, 6·s1·s2, f, lat_h, lat_w].

    Rays are o = the delta's translation, d = its rotation of the pixel's normalised direction; one K for all frames
    (upstream reads Ks[0]). The rearrange 'f (h c1) (w c2) c -> (f h w) (c c1 c2)' then 'b (f h w) c -> b c f h w'
    folds each 8×8 pixel block into the channels."""
    c2w = torch.as_tensor(np.asarray(deltas), dtype=torch.float32, device=device)
    fcount = c2w.shape[0]
    fx, fy, cx, cy = (float(v) for v in K)
    gy, gx = torch.meshgrid(torch.arange(h, device=device, dtype=torch.float32) + 0.5,
                            torch.arange(w, device=device, dtype=torch.float32) + 0.5, indexing="ij")
    dirs = torch.stack([(gx.reshape(-1) - cx) / fx, (gy.reshape(-1) - cy) / fy, torch.ones(h * w, device=device)], dim=-1)
    dirs = dirs / dirs.norm(dim=-1, keepdim=True)
    rays_d = (c2w[:, :3, :3] @ dirs.T).transpose(1, 2)
    rays_o = c2w[:, :3, 3].unsqueeze(1).expand_as(rays_d)
    emb = torch.cat([rays_o, rays_d], dim=-1).view(fcount, h, w, 6)
    c1, c2 = h // lat_h, w // lat_w
    emb = emb.view(fcount, lat_h, c1, lat_w, c2, 6).permute(0, 1, 3, 5, 2, 4).reshape(fcount, lat_h, lat_w, 6 * c1 * c2)
    return emb.permute(3, 0, 1, 2).unsqueeze(0).to(dtype)


# ── the Wan2.1 VAE, chunk by chunk (WanVAE_.encode / decode, kept across calls) ──────────────────────────────────────

class StreamEncoder:
    """Feeds frames as WanVAE_.encode does (1 frame, then 4 at a time) and keeps its causal cache between calls.
    Once two all-zero chunks in a row encode to the same latent, the cache holds nothing but zeros' features and every
    later zero chunk gives that latent too, so it is reused (exact: torch.equal, not a tolerance)."""

    def __init__(self, vae, vae2_1):
        self.vae, self.m = vae, vae.model
        self.cache = [None] * vae2_1.count_conv3d(self.m.encoder)
        self.first = True
        self._zero_prev = None
        self._zero_steady = None

    def _enc(self, x):
        idx = [0]
        out = self.m.encoder(x, feat_cache=self.cache, feat_idx=idx)
        mu, _ = self.m.conv1(out).chunk(2, dim=1)
        mean, inv_std = self.vae.scale
        return ((mu - mean.view(1, -1, 1, 1, 1)) * inv_std.view(1, -1, 1, 1, 1)).float()[0]

    def image(self, img):
        """img [3, h, w] in [-1, 1] → the first latent frame [16, 1, lh, lw]."""
        assert self.first
        self.first = False
        return self._enc(img[None, :, None].to(self.vae.device, torch.float32))

    def zeros(self, h, w):
        """The next latent frame of the all-zero video that follows the first frame (image2video.py's y)."""
        if self._zero_steady is not None:
            return self._zero_steady
        z = self._enc(torch.zeros(1, 3, VAE_STRIDE[0], h, w, device=self.vae.device))
        if self._zero_prev is not None and torch.equal(z, self._zero_prev):
            self._zero_steady = z
        self._zero_prev = z
        return z


class StreamDecoder:
    """WanVAE_.decode one latent frame at a time, its cache kept across chunks: frames as uint8 [n, h, w, 3]."""

    def __init__(self, vae, vae2_1):
        self.vae, self.m = vae, vae.model
        self.cache = [None] * vae2_1.count_conv3d(self.m.decoder)

    def __call__(self, z):
        mean, inv_std = self.vae.scale
        z = z[None].to(self.vae.device, torch.float32) / inv_std.view(1, -1, 1, 1, 1) + mean.view(1, -1, 1, 1, 1)
        x = self.m.conv2(z)
        outs = []
        for i in range(x.shape[2]):
            idx = [0]
            outs.append(self.m.decoder(x[:, :, i:i + 1], feat_cache=self.cache, feat_idx=idx))
        video = torch.cat(outs, 2).float().clamp_(-1, 1)[0]          # [3, n, h, w]
        frames = ((video.permute(1, 2, 3, 0) + 1) * 127.5).round().clamp_(0, 255).to(torch.uint8)
        return frames.cpu().numpy()


# ── text ─────────────────────────────────────────────────────────────────────────────────────────────────────────

def clean_prompt(text):
    """Wan's HuggingfaceTokenizer(clean='whitespace'): ftfy, HTML entities twice, whitespace collapsed."""
    import html
    import re
    try:
        import ftfy
        text = ftfy.fix_text(text)
    except ImportError:
        pass
    text = html.unescape(html.unescape(text)).strip()
    return re.sub(r"\s+", " ", text).strip()


class TextEncoder:
    """umT5-XXL in bf16 → [L, 4096] (L = the prompt's tokens; the DiT pads to 512 itself)."""

    def __init__(self, device, diffusers_dir=None, pth=None, code_dir=None):
        self.device = device
        if pth:
            t5 = import_wan_t5(code_dir)
            tok = os.path.join(os.path.dirname(pth), "google", "umt5-xxl")
            self.wan = t5.T5EncoderModel(text_len=TEXT_LEN, dtype=torch.bfloat16, device=device, checkpoint_path=pth, tokenizer_path=tok)
            self.hf = None
        else:
            from transformers import AutoTokenizer, UMT5EncoderModel
            self.wan = None
            self.tok = AutoTokenizer.from_pretrained(os.path.join(diffusers_dir, "tokenizer"))
            self.hf = UMT5EncoderModel.from_pretrained(os.path.join(diffusers_dir, "text_encoder"), dtype=torch.bfloat16).to(device).eval()

    @torch.no_grad()
    def __call__(self, prompt):
        if self.wan is not None:
            return self.wan([prompt], self.device)[0]
        t = self.tok([clean_prompt(prompt)], padding="max_length", max_length=TEXT_LEN, truncation=True,
                     add_special_tokens=True, return_attention_mask=True, return_tensors="pt")
        ids, mask = t.input_ids.to(self.device), t.attention_mask.to(self.device)
        out = self.hf(ids, mask).last_hidden_state[0]
        return out[: int(mask.sum())]


# ── the model ────────────────────────────────────────────────────────────────────────────────────────────────────

def load_dit(model_fast, dit_dir, device, dtype):
    """WanModelFast built on the meta device and filled from the sharded safetensors (the 1.3B upload has no
    config.json: image2video.load_dit_model's path for it). Missing weights are an error, not a warning."""
    import json
    from safetensors.torch import load_file
    with open(os.path.join(dit_dir, "model.safetensors.index.json")) as f:
        shards = sorted(set(json.load(f)["weight_map"].values()))
    with torch.device("meta"):
        model = model_fast.WanModelFast(**DIT, local_attn_size=LOCAL_ATTN, sink_size=SINK)
    state = {}
    for s in shards:
        state.update(load_file(os.path.join(dit_dir, s)))
    missing, unexpected = model.load_state_dict(state, strict=False, assign=True)
    if missing:
        raise RuntimeError(f"the DiT weights lack {len(missing)} tensors (first: {missing[0]})")
    if unexpected:
        print(f"lingbot: {len(unexpected)} unused tensors in the weights (first: {unexpected[0]})", file=sys.stderr, flush=True)
    del state
    d = model.dim // model.num_heads
    model.freqs = rope_tables(torch.cat([model_fast.rope_params(1024, d - 4 * (d // 6)), model_fast.rope_params(1024, 2 * (d // 6)),
                                         model_fast.rope_params(1024, 2 * (d // 6))], dim=1))
    return model.eval().requires_grad_(False).to(device=device, dtype=dtype)


class LingBotCamera:
    """The loaded model and one take at a time. Every call runs on the server's one device thread."""

    def __init__(self, code_dir, dit_dir, vae_pth, t5_diffusers_dir=None, t5_pth=None, device="mps",
                 dtype=os.environ.get("MUX_CAMERA_DTYPE", "fp32"), keep_t5=os.environ.get("MUX_CAMERA_KEEP_T5") == "1"):
        t0 = time.time()
        self.device = torch.device(device)
        self.code_dir, self.t5_diffusers_dir, self.t5_pth, self.keep_t5 = code_dir, t5_diffusers_dir, t5_pth, keep_t5
        self.dtype = torch.bfloat16 if dtype == "bf16" else torch.float32
        self.model_fast, self.vae2_1 = import_wan(code_dir)
        self.model = load_dit(self.model_fast, dit_dir, self.device, self.dtype)
        self.vae = self.vae2_1.Wan2_1_VAE(vae_pth=vae_pth, device=self.device)
        self.text = None
        self._ctx = OrderedDict()   # sha256(prompt) → embedding; never the prompt itself
        self.schedule = fast_schedule()
        self.load_s = time.time() - t0

    def encode(self, prompt):
        key = hashlib.sha256(prompt.encode("utf-8")).hexdigest()
        if key in self._ctx:
            self._ctx.move_to_end(key)
            return self._ctx[key]
        if self.text is None:
            self.text = TextEncoder(self.device, self.t5_diffusers_dir, self.t5_pth, self.code_dir)
        ctx = self.text(prompt).to(self.dtype if self.dtype == torch.float32 else torch.bfloat16)
        self._ctx[key] = ctx
        while len(self._ctx) > 8:
            self._ctx.popitem(last=False)
        if not self.keep_t5:
            self.text = None
            gc.collect()
            empty_cache(self.device)
        return ctx

    def _autocast(self):
        if self.dtype == torch.bfloat16:
            return torch.autocast(self.device.type, dtype=torch.bfloat16)
        import contextlib
        return contextlib.nullcontext()

    @torch.no_grad()
    def segment(self, ctx, image, deltas, K, seed, on_step=None):
        """One run of the causal-fast loop from `image` (PIL RGB at the output size) along `deltas` ([latent frames,
        4, 4], a whole number of chunks). Yields uint8 frames [n, h, w, 3] chunk by chunk (13, then 16 each) and
        then nothing; on_step(done, total) is called after every DiT forward and may raise to stop."""
        dev = self.device
        w, h = image.size
        lat_h, lat_w = h // VAE_STRIDE[1], w // VAE_STRIDE[2]
        lat_f = len(deltas)
        assert lat_f % CHUNK == 0
        m = self.model
        frame_seqlen = lat_h * lat_w // (m.patch_size[1] * m.patch_size[2])
        max_seq_len = CHUNK * frame_seqlen
        kv_size = frame_seqlen * (m.local_attn_size if m.local_attn_size > 0 else lat_f)
        heads, head_dim, layers = m.num_heads, m.dim // m.num_heads, len(m.blocks)
        kv = [{"k": torch.zeros(1, kv_size, heads, head_dim, dtype=ATTN_DTYPE, device=dev),
               "v": torch.zeros(1, kv_size, heads, head_dim, dtype=ATTN_DTYPE, device=dev),
               "global_end_index": torch.tensor([0], dtype=torch.long, device=dev),
               "local_end_index": torch.tensor([0], dtype=torch.long, device=dev)} for _ in range(layers)]
        cross = [{"k": torch.zeros(1, m.text_len, heads, head_dim, dtype=ATTN_DTYPE, device=dev),
                  "v": torch.zeros(1, m.text_len, heads, head_dim, dtype=ATTN_DTYPE, device=dev),
                  "is_init": torch.tensor(0, dtype=torch.int32, device=dev)} for _ in range(layers)]
        try:
            gen = torch.Generator(device=dev)
            gen.manual_seed(seed)
            noise_dev = dev
        except RuntimeError:  # a device without its own generator: draw on the CPU
            gen = torch.Generator().manual_seed(seed)
            noise_dev = torch.device("cpu")

        def randn(shape):
            return torch.randn(shape, generator=gen, device=noise_dev, dtype=torch.float32).to(dev)

        img = torch.from_numpy(np.asarray(image.convert("RGB"), dtype=np.float32) / 127.5 - 1.0).permute(2, 0, 1)
        enc = StreamEncoder(self.vae, self.vae2_1)
        dec = StreamDecoder(self.vae, self.vae2_1)
        pdtype = torch.float32 if self.dtype == torch.float32 else torch.bfloat16
        total = lat_f // CHUNK * (len(self.schedule) + 1)
        done = 0
        first_cross = True
        for c in range(lat_f // CHUNK):
            # the first-frame condition: mask 1 on latent frame 0 (its 4 sub-frames), the image's latent there, the
            # all-zero video's latents after it (image2video.py's msk and y)
            lats = []
            for j in range(c * CHUNK, (c + 1) * CHUNK):
                lats.append(enc.image(img) if j == 0 else enc.zeros(h, w))
            y_lat = torch.cat(lats, dim=1)
            msk = torch.zeros(4, CHUNK, lat_h, lat_w, device=dev)
            if c == 0:
                msk[:, 0] = 1
            cond = torch.cat([msk, y_lat])
            pl = plucker_chunk(deltas[c * CHUNK:(c + 1) * CHUNK], K, h, w, lat_h, lat_w, dev, pdtype)
            kw = dict(context=[ctx], seq_len=max_seq_len, y=[cond], dit_cond_dict={"c2ws_plucker_emb": (pl,)},
                      kv_cache=kv, crossattn_cache=cross, current_start=c * CHUNK * frame_seqlen,
                      max_attention_size=kv_size, frame_seqlen=frame_seqlen)
            latent = randn((m.out_dim, CHUNK, lat_h, lat_w))
            x0 = latent
            for t, x0_sigma, next_sigma in self.schedule:
                with self._autocast():
                    flow = m(x=[latent], t=torch.tensor([t], device=dev), cross_attn_first_call=first_cross, **kw)[0]
                first_cross = False
                x0 = latent - x0_sigma * flow.float()
                done += 1
                if on_step:
                    on_step(done, total)
                if next_sigma is None:
                    break
                latent = (1 - next_sigma) * x0 + next_sigma * randn(x0.shape)
            # the KV cache learns the clean chunk (timestep 0), as upstream does after each chunk
            with self._autocast():
                m(x=[x0], t=torch.tensor([0.0], device=dev), cross_attn_first_call=False, **kw)
            done += 1
            if on_step:
                on_step(done, total)
            yield dec(x0)
        del kv, cross


def empty_cache(device):
    try:
        if torch.device(device).type == "mps":
            torch.mps.empty_cache()
    except Exception:  # noqa: BLE001
        pass


def memory_gb():
    """What the MPS driver has handed this process, GB (None off MPS)."""
    try:
        return torch.mps.driver_allocated_memory() / 1024 ** 3
    except Exception:  # noqa: BLE001
        return None
