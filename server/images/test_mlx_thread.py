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
