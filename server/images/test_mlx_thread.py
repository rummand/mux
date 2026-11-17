"""Every MLX call must run on one thread (MLX keeps its default stream per thread). Run: python3 server/images/test_mlx_thread.py"""
import importlib.util, os, sys, threading

here = os.path.dirname(os.path.abspath(__file__))


def load(name):
    spec = importlib.util.spec_from_file_location(name, os.path.join(here, f"{name}.py"))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


class FakeImage:
    def save(self, buf, format):
        buf.write(b"png")


def check(mod, model_name, gen_name):
    seen = set()

    class FakePipeline:
        def generate_image(self, **_):
            seen.add(threading.get_ident())
            return type("R", (), {"image": FakeImage()})()

    def fake_model(*_):
        seen.add(threading.get_ident())
        return FakePipeline()

    setattr(mod, model_name, fake_model)
    gen = getattr(mod, gen_name)
    threads = [threading.Thread(target=gen, args=("a cat", "512x512", 1, 1, 1, None)) for _ in range(4)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert len(seen) == 1, f"{mod.__name__}: MLX work ran on {len(seen)} threads"
    assert threading.get_ident() not in seen
    print(f"ok {mod.__name__}: 4 request threads, 1 MLX thread")


check(load("image_server"), "model", "generate")
check(load("flux3_server"), "model", "generate")


# MLX's buffer cache: capped, emptied after every request (also a failed one) and when a pipeline is let go, always on
# the MLX thread. Uncapped it grew to 71 GB on 2026-11-17.
import types

calls = []
fake_mx = types.SimpleNamespace(
    set_cache_limit=lambda n: calls.append(("limit", n, threading.get_ident())),
    clear_cache=lambda: calls.append(("clear", None, threading.get_ident())),
    reset_peak_memory=lambda: None,
    get_active_memory=lambda: 5 * 1024**3, get_cache_memory=lambda: 9 * 1024**3, get_peak_memory=lambda: 12 * 1024**3)
im = load("image_server")
im._mx = lambda: fake_mx
im.on_mlx(im.cap_cache)
mlx_thread = calls[-1][2]
assert calls[-1][:2] == ("limit", int(im.CACHE_GB * 1024**3)) and im.CACHE_GB == 2.0, calls


class Pipe:
    fail = False

    def generate_image(self, **_):
        if Pipe.fail:
            raise RuntimeError("boom")
        return type("R", (), {"image": FakeImage()})()


im.model = lambda *_: Pipe()
im.generate("a cat", "512x512", 1, 1, 1, None)
assert calls[-1][:2] == ("clear", None) and calls[-1][2] == mlx_thread, calls
n = len(calls)
Pipe.fail = True
try:
    im.generate("a cat", "512x512", 1, 1, 1, None)
    raise AssertionError("the failure should reach the caller")
except RuntimeError:
    pass
assert len(calls) == n + 1 and calls[-1][0] == "clear", calls
print("ok image_server: MLX cache capped at 2 GB, emptied on the MLX thread after every request, also a failed one")
