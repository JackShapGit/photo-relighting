"""ICLightBackend interface contract: class exists, has the expected method
signature, and a GPU-gated smoke test that runs only when the diffusion
extra is installed and a GPU is available."""
from __future__ import annotations

import inspect

import numpy as np
import pytest

from relighting_engine.polish.iclight import ICLightBackend


def test_iclight_backend_class_exists():
    assert inspect.isclass(ICLightBackend)


def test_iclight_polish_signature():
    sig = inspect.signature(ICLightBackend.polish)
    params = list(sig.parameters.keys())
    # self, classical_render, foreground_rgba, prompt, *, seed
    assert params[:4] == ["self", "classical_render", "foreground_rgba", "prompt"]
    assert "seed" in sig.parameters
    assert sig.parameters["seed"].kind == inspect.Parameter.KEYWORD_ONLY


def _has_gpu_and_weights() -> bool:
    """True iff we can actually run IC-Light end-to-end on this machine."""
    from relighting_engine.polish.capabilities import is_available
    return is_available()


@pytest.mark.skipif(not _has_gpu_and_weights(),
                    reason="IC-Light smoke test requires GPU + [diffusion] extra")
def test_iclight_smoke_256():
    """End-to-end smoke: feed a 256x256 image and assert shape/dtype/range.

    Output values are NOT compared — diffusion is not byte-stable across
    torch/cudnn versions. Quality validation is by-eye during development.
    """
    backend = ICLightBackend(device="cuda")
    classical = np.full((256, 256, 3), 0.5, dtype=np.float32)
    fg_rgba = np.zeros((256, 256, 4), dtype=np.float32)
    fg_rgba[..., :3] = 0.5
    fg_rgba[..., 3] = 1.0
    out = backend.polish(classical, fg_rgba, prompt="", seed=42)
    assert out.shape == (256, 256, 3)
    assert out.dtype == np.float32
    assert float(out.min()) >= 0.0
    assert float(out.max()) <= 1.0
