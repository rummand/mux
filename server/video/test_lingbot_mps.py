"""The MPS port of LingBot-World v2 against upstream's own code, with tiny random weights (no download, a few MB).

Run:  MUX_CAMERA_CODE=~/.mux/lingbot-world-v2 ~/.mux/video-camera-venv/bin/python server/video/test_lingbot_mps.py
Needs torch, einops and diffusers (the camera venv has them) and the pinned checkout (deploy/video-camera.sh clones it;
`git clone https://github.com/robbyant/lingbot-world-v2 && git checkout 1895d30` is the same). Skips without them.

What it proves: each replaced piece (attention, RoPE, the timestep embedding, the sampler's numbers, the camera rays,
the chunked VAE) gives upstream's numbers; a small DiT with upstream's code runs its causal KV-cache loop on MPS and
matches the CPU reference; the whole take loop (segment) runs on MPS past the KV window. What it cannot prove: that the
real 1.3B weights make good video, or their speed and memory (deploy/video-camera.sh's test clip and --measure).
"""
import importlib.util, os, sys, types, unittest

here = os.path.dirname(os.path.abspath(__file__))
CODE = os.path.expanduser(os.environ.get("MUX_CAMERA_CODE", "~/.mux/lingbot-world-v2"))

try:
    import numpy as np
    import torch
    import einops  # noqa: F401  (upstream's model needs it)
    import diffusers  # noqa: F401
    HAVE = os.path.isfile(os.path.join(CODE, "wan", "modules", "model_fast.py"))
except ImportError:
    HAVE = False


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


@unittest.skipUnless(HAVE, f"needs torch, einops, diffusers and the LingBot checkout at {CODE}")
class Port(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.lb = load("lingbot_mps", os.path.join(here, "lingbot_mps.py"))
        cls.poses = load("camera_poses", os.path.join(here, "camera_poses.py"))
        cls.mf, cls.vae2_1 = cls.lb.import_wan(CODE)
        cls.model = sys.modules["wan.modules.model"]
        cls.orig = cls.mf.upstream   # upstream's causal_rope_apply and sinusoidal_embedding_1d
        # cam_utils imports scipy at the top for its interpolation, which the rays and poses do not use
        for n in ("scipy", "scipy.interpolate", "scipy.spatial", "scipy.spatial.transform"):
            sys.modules.setdefault(n, types.ModuleType(n))
        sys.modules["scipy.interpolate"].interp1d = None
        sys.modules["scipy.spatial.transform"].Rotation = sys.modules["scipy.spatial.transform"].Slerp = None
        cls.cam = load("lingbot_cam_utils", os.path.join(CODE, "wan", "utils", "cam_utils.py"))
        cls.mps = torch.backends.mps.is_available()

    def test_rope_matches_upstream(self):
        torch.manual_seed(0)
        d = 128
        freqs = torch.cat([self.model.rope_params(1024, d - 4 * (d // 6)), self.model.rope_params(1024, 2 * (d // 6)), self.model.rope_params(1024, 2 * (d // 6))], dim=1)
        x = torch.randn(1, 2 * 3 * 4 + 5, 2, d)
        grid = torch.tensor([[2, 3, 4]])
        want = self.orig.causal_rope_apply(x, grid, freqs, start_frame=7)
        got = self.lb.causal_rope_apply_real(x, grid, self.lb.rope_tables(freqs), start_frame=7)
        self.assertLess((got - want).abs().max().item(), 1e-5)
        if self.mps:
            got_mps = self.lb.causal_rope_apply_real(x.to("mps"), grid, self.lb.rope_tables(freqs).to("mps"), start_frame=7).cpu()
            self.assertLess((got_mps - want).abs().max().item(), 1e-4)

    def test_timestep_embedding_matches_upstream(self):
        t = torch.tensor([0, 1, 250, 999, 937], dtype=torch.long)
        want = self.orig.sinusoidal_embedding_1d(256, t).float()
        self.assertLess((self.lb.sinusoidal_embedding_1d_cpu64(256, t) - want).abs().max().item(), 1e-6)
        if self.mps:
            got = self.lb.sinusoidal_embedding_1d_cpu64(256, t.to("mps"))
            self.assertEqual(got.device.type, "mps")
            self.assertLess((got.cpu() - want).abs().max().item(), 1e-6)

    def test_attention_split_and_masked(self):
        torch.manual_seed(1)
        q, k, v = torch.randn(1, 300, 2, 64), torch.randn(1, 500, 2, 64), torch.randn(1, 500, 2, 64)
        ref = torch.nn.functional.scaled_dot_product_attention(q.transpose(1, 2), k.transpose(1, 2), v.transpose(1, 2)).transpose(1, 2)
        old = self.lb.ATTN_BYTES
        try:
            self.lb.ATTN_BYTES = 2 * 500 * 2 * 7   # 7 queries at a time
            got = self.lb.sdpa_attention(q, k, v)
        finally:
            self.lb.ATTN_BYTES = old
        self.assertEqual(got.dtype, q.dtype)
        self.assertLess((got - ref).abs().max().item(), 3e-2)   # bf16, as flash-attn
        masked = self.lb.sdpa_attention(q, k, v, k_lens=torch.tensor([200]))
        ref2 = torch.nn.functional.scaled_dot_product_attention(q.transpose(1, 2), k[:, :200].transpose(1, 2), v[:, :200].transpose(1, 2)).transpose(1, 2)
        self.assertLess((masked - ref2).abs().max().item(), 3e-2)

    def test_schedule_matches_upstreams_scheduler(self):
        sys.modules.setdefault("scipy.stats", types.ModuleType("scipy.stats"))
        fm = load("lingbot_fm_unipc", os.path.join(CODE, "wan", "utils", "fm_solvers_unipc.py"))
        s = fm.FlowUniPCMultistepScheduler(num_train_timesteps=1000, shift=1, use_dynamic_shifting=False)
        s.set_timesteps(1000, shift=5.0)
        ts = s.timesteps[list(self.lb.STEPS_INDEX)]
        sched = self.lb.fast_schedule()
        self.assertEqual([t for t, _, _ in sched], [int(t) for t in ts])
        for j, (t, x0s, nxt) in enumerate(sched):
            i = int(torch.argmin((s.timesteps.double() - ts[j].double()).abs()))   # _convert_flow_pred_to_x0
            self.assertAlmostEqual(x0s, float(s.sigmas[i]), places=6)
            if nxt is not None:
                x0 = torch.ones(1, 1, 1, 1)
                noisy = s.add_noise(x0, torch.zeros_like(x0), ts[j + 1])          # (1 - sigma) * x0
                self.assertAlmostEqual(1 - nxt, float(noisy.flatten()[0]), places=6)

    def test_rays_match_upstream(self):
        rng = np.random.default_rng(2)
        frames = [(i * 0.25, rng.normal(size=3), rng.normal(size=4), 35.0) for i in range(8)]
        frames = [(t, p, q / np.linalg.norm(q), f) for t, p, q, f in frames]
        c2ws = np.stack([self.poses.opencv_c2w(p, q) for _, p, q, _ in frames])
        ours = self.poses.framewise(c2ws)
        theirs = self.cam.compute_relative_poses(torch.from_numpy(c2ws).float(), framewise=True, normalize_trans=False).numpy()
        self.assertLess(np.abs(ours - theirs).max(), 1e-4)
        K = (500.0, 480.0, 416.0, 240.0)
        h, w, lh, lw = 48, 64, 6, 8
        got = self.lb.plucker_chunk(ours[:4], K, h, w, lh, lw, "cpu", torch.float32)
        from einops import rearrange
        emb = self.cam.get_plucker_embeddings(torch.from_numpy(ours[:4]).float(), torch.tensor([K] * 4), h, w)
        emb = rearrange(emb, "f (h c1) (w c2) c -> (f h w) (c c1 c2)", c1=h // lh, c2=w // lw)[None]
        emb = rearrange(emb, "b (f h w) c -> b c f h w", f=4, h=lh, w=lw)
        self.assertEqual(tuple(got.shape), tuple(emb.shape))
        self.assertLess((got - emb).abs().max().item(), 1e-5)

    def tiny_vae(self):
        torch.manual_seed(3)
        m = self.vae2_1.WanVAE_(dim=8, z_dim=16, dim_mult=[1, 2, 4, 4], num_res_blocks=1, attn_scales=[], temperal_downsample=[False, True, True]).eval()
        vae = types.SimpleNamespace(model=m, device=torch.device("cpu"))
        vae.scale = [torch.randn(16) * 0.1, 1 + torch.rand(16)]
        return vae

    def test_vae_in_chunks_is_upstreams_vae(self):
        vae = self.tiny_vae()
        with torch.no_grad():
            img = torch.rand(3, 32, 48) * 2 - 1
            video = torch.cat([img[:, None], torch.zeros(3, 4 * 5, 32, 48)], dim=1)
            want = vae.model.encode(video[None], vae.scale)[0]
            enc = self.lb.StreamEncoder(vae, self.vae2_1)
            got = torch.cat([enc.image(img)] + [enc.zeros(32, 48) for _ in range(5)], dim=1)
            self.assertLess((got - want).abs().max().item(), 1e-5)
            z = torch.randn(16, 7, 4, 6)
            want = ((vae.model.decode(z[None], vae.scale)[0].clamp(-1, 1).permute(1, 2, 3, 0) + 1) * 127.5).round().to(torch.uint8).numpy()
            dec = self.lb.StreamDecoder(vae, self.vae2_1)
            got = np.concatenate([dec(z[:, :3]), dec(z[:, 3:])])
            self.assertEqual(got.shape, (1 + 6 * 4, 32, 48, 3))
            self.assertLessEqual(np.abs(got.astype(int) - want.astype(int)).max(), 1)

    def tiny_dit(self, device, local=6, sink=1):
        torch.manual_seed(4)
        cfg = dict(self.lb.DIT, dim=128, ffn_dim=256, text_dim=32, num_heads=2, num_layers=2, freq_dim=32)
        m = self.mf.WanModelFast(**cfg, local_attn_size=local, sink_size=sink)
        for p in m.parameters():   # the head starts at zero; give every weight something to do
            torch.nn.init.normal_(p, std=0.05)
        m.freqs = self.lb.rope_tables(m.freqs)
        return m.eval().to(device)

    def run_chunks(self, m, device, chunks=3, attn=None):
        """Upstream's per-chunk calls (image2video.py) on a tiny model: 2 steps then the cache update."""
        torch.manual_seed(5)
        lh, lw, C = 4, 6, 4
        fsl = lh * lw // 4
        kv_size = fsl * m.local_attn_size
        heads, hd = m.num_heads, m.dim // m.num_heads
        kv = [{"k": torch.zeros(1, kv_size, heads, hd, dtype=torch.bfloat16, device=device), "v": torch.zeros(1, kv_size, heads, hd, dtype=torch.bfloat16, device=device),
               "global_end_index": torch.tensor([0], device=device), "local_end_index": torch.tensor([0], device=device)} for _ in m.blocks]
        cross = [{"k": torch.zeros(1, 512, heads, hd, dtype=torch.bfloat16, device=device), "v": torch.zeros(1, 512, heads, hd, dtype=torch.bfloat16, device=device),
                  "is_init": torch.tensor(0, dtype=torch.int32, device=device)} for _ in m.blocks]
        ctx = torch.randn(9, 32).to(device)
        outs = []
        for c in range(chunks):
            x = torch.randn(16, C, lh, lw).to(device)
            y = torch.randn(20, C, lh, lw).to(device)
            pl = torch.randn(1, 384, C, lh, lw).to(device)
            kw = dict(context=[ctx], seq_len=C * fsl, y=[y], dit_cond_dict={"c2ws_plucker_emb": (pl,)}, kv_cache=kv, crossattn_cache=cross,
                      current_start=c * C * fsl, max_attention_size=kv_size, frame_seqlen=fsl)
            for t in (999, 500):
                outs.append(m(x=[x], t=torch.tensor([t], device=device), cross_attn_first_call=(c == 0 and t == 999), **kw)[0].cpu())
            m(x=[x], t=torch.tensor([0.0], device=device), cross_attn_first_call=False, **kw)
        return outs

    def test_dit_on_mps_matches_cpu(self):
        if not self.mps:
            self.skipTest("no MPS here")
        with torch.no_grad():
            cpu = self.run_chunks(self.tiny_dit("cpu"), "cpu")
            mps = self.run_chunks(self.tiny_dit("mps"), "mps")
        for a, b in zip(cpu, mps):
            self.assertTrue(torch.isfinite(b).all())
            rel = ((a - b).norm() / a.norm()).item()
            self.assertLess(rel, 2e-2, f"MPS drifts from the CPU by {rel:.3%}")

    def test_dit_cpu_with_upstreams_float64_rope(self):
        """The patched model against upstream's own float64 RoPE and timestep embedding, on the CPU."""
        with torch.no_grad():
            ours = self.run_chunks(self.tiny_dit("cpu"), "cpu")
            self.mf.causal_rope_apply, self.mf.sinusoidal_embedding_1d = self.orig.causal_rope_apply, self.orig.sinusoidal_embedding_1d
            try:
                m = self.tiny_dit("cpu")
                d = m.dim // m.num_heads
                m.freqs = torch.cat([self.model.rope_params(1024, d - 4 * (d // 6)), self.model.rope_params(1024, 2 * (d // 6)), self.model.rope_params(1024, 2 * (d // 6))], dim=1)
                theirs = self.run_chunks(m, "cpu")
            finally:
                self.mf.causal_rope_apply, self.mf.sinusoidal_embedding_1d = self.lb.causal_rope_apply_real, self.lb.sinusoidal_embedding_1d_cpu64
        for a, b in zip(theirs, ours):
            self.assertLess(((a - b).norm() / a.norm()).item(), 1e-4)

    def test_whole_take_loop_on_mps(self):
        """LingBotCamera.segment with a tiny DiT and VAE: 4 chunks (past the 6-frame KV window), frames come out."""
        if not self.mps:
            self.skipTest("no MPS here")
        from PIL import Image
        cam = self.lb.LingBotCamera.__new__(self.lb.LingBotCamera)
        cam.device, cam.dtype, cam.vae2_1, cam.schedule = torch.device("mps"), torch.float32, self.vae2_1, self.lb.fast_schedule()
        cam.model = self.tiny_dit("mps")
        vae = self.tiny_vae()
        vae.model.to("mps")
        vae.device = torch.device("mps")
        vae.scale = [s.to("mps") for s in vae.scale]
        cam.vae = vae
        frames = [(0, np.zeros(3), np.array([0, 0, 0, 1.0]), 35.0), (4, np.array([0, 0, -2.0]), np.array([0, 0.2588, 0, 0.9659]), 35.0)]
        cam_req = {"sensor": [36, 24], "aspect": "16:9", "principal": [0.5, 0.5], "frames": frames}
        p = self.poses.plan(cam_req, 3.5, 48, 32)
        seg = p["segments"][0]
        steps = []
        img = Image.fromarray((np.random.default_rng(6).random((32, 48, 3)) * 255).astype("uint8"))
        with torch.no_grad():
            out = list(cam.segment(torch.randn(9, 32, device="mps"), img, seg["deltas"], p["K"], 7, lambda d, t: steps.append((d, t))))
        self.assertEqual(len(out), seg["latent"] // 4)
        self.assertEqual(sum(len(o) for o in out), (seg["latent"] - 1) * 4 + 1)
        self.assertEqual(out[0].shape[1:], (32, 48, 3))
        self.assertEqual(steps[-1], (len(out) * 5, len(out) * 5))


if __name__ == "__main__":
    unittest.main(verbosity=2)
