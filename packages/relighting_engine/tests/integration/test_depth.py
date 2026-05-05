"""Integration tests for the Depth Anything V3 adapter. Requires CUDA + model weights."""
from __future__ import annotations

import numpy as np
import pytest

torch = pytest.importorskip("torch")

if not torch.cuda.is_available():
    pytest.skip("CUDA required for depth tests", allow_module_level=True)

from relighting_engine.depth.depth_anything import DepthAnythingBackend


@pytest.fixture(scope="module")
def backend() -> DepthAnythingBackend:
    return DepthAnythingBackend(device="cuda")


def _gradient_image(h: int, w: int) -> np.ndarray:
    """Synthetic image: vertical gradient. Models will return some valid depth on it."""
    g = np.linspace(0.0, 1.0, h, dtype=np.float32)[:, None]
    rgb = np.broadcast_to(g[..., None], (h, w, 3)).astype(np.float32)
    return rgb.copy()


@pytest.mark.gpu
@pytest.mark.models
def test_interactive_mode_caps_long_side_at_1024(backend: DepthAnythingBackend) -> None:
    img = _gradient_image(1500, 2000)
    depth = backend.infer(img, mode="interactive")
    assert depth.shape == (1500, 2000)
    assert depth.dtype == np.float32
    # Internal inference happens at <=1024 long-side; output is upsampled back.
    assert backend.last_inference_long_side <= 1024


@pytest.mark.gpu
@pytest.mark.models
def test_quality_mode_runs_at_native_when_within_cap(backend: DepthAnythingBackend) -> None:
    img = _gradient_image(720, 1280)
    depth = backend.infer(img, mode="quality")
    assert depth.shape == (720, 1280)
    assert backend.last_inference_long_side == 1280


@pytest.mark.gpu
@pytest.mark.models
def test_depth_is_normalized_to_unit_interval(backend: DepthAnythingBackend) -> None:
    img = _gradient_image(256, 256)
    depth = backend.infer(img, mode="interactive")
    assert depth.min() >= 0.0 - 1e-4
    assert depth.max() <= 1.0 + 1e-4
    # And not collapsed to a single value
    assert (depth.max() - depth.min()) > 0.05
