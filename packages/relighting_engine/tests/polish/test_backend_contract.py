"""PolishBackend interface contract: class exists, has the expected method
signature, and a GPU-gated smoke test that runs only when diffusers + a GPU
are available."""
from __future__ import annotations

import inspect

import numpy as np
import pytest

from relighting_engine.polish.backend import PolishBackend


def test_polish_backend_class_exists():
    assert inspect.isclass(PolishBackend)


def test_polish_signature():
    sig = inspect.signature(PolishBackend.polish)
    params = list(sig.parameters.keys())
    # self, classical_render, prompt, *, seed, strength
    assert params[:3] == ["self", "classical_render", "prompt"]
    assert "seed" in sig.parameters
    assert sig.parameters["seed"].kind == inspect.Parameter.KEYWORD_ONLY
    assert "strength" in sig.parameters
    assert sig.parameters["strength"].kind == inspect.Parameter.KEYWORD_ONLY


def _has_gpu_and_weights() -> bool:
    """True iff we can actually run the polish backend end-to-end on this machine."""
    from relighting_engine.polish.capabilities import is_available
    return is_available()


@pytest.mark.skipif(not _has_gpu_and_weights(),
                    reason="polish smoke test requires GPU + [diffusion] extra")
def test_polish_smoke_256():
    """End-to-end smoke: feed a 256x256 image and assert shape/dtype/range.

    Output values are NOT compared — diffusion is not byte-stable across
    torch/cudnn versions. Quality validation is by-eye during development.
    """
    backend = PolishBackend(device="cuda")
    classical = np.full((256, 256, 3), 0.5, dtype=np.float32)
    out = backend.polish(classical, prompt="", seed=42)
    assert out.shape == (256, 256, 3)
    assert out.dtype == np.float32
    assert float(out.min()) >= 0.0
    assert float(out.max()) <= 1.0
