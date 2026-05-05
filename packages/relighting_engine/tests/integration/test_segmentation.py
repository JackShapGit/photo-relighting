"""Integration tests for RMBG-2.0 adapter."""
from __future__ import annotations

import numpy as np
import pytest

torch = pytest.importorskip("torch")
if not torch.cuda.is_available():
    pytest.skip("CUDA required", allow_module_level=True)

from relighting_engine.segmentation.rmbg import RMBGBackend


@pytest.fixture(scope="module")
def backend() -> RMBGBackend:
    return RMBGBackend(device="cuda")


def _solid_color(h: int, w: int, c: tuple[float, float, float]) -> np.ndarray:
    return np.full((h, w, 3), c, dtype=np.float32)


@pytest.mark.gpu
@pytest.mark.models
def test_mask_shape_and_range(backend: RMBGBackend) -> None:
    img = _solid_color(256, 256, (0.5, 0.5, 0.5))
    mask = backend.infer(img)
    assert mask.shape == (256, 256)
    assert mask.dtype == np.float32
    assert mask.min() >= 0.0 - 1e-4
    assert mask.max() <= 1.0 + 1e-4


@pytest.mark.gpu
@pytest.mark.models
def test_mask_or_none_for_empty_scene(backend: RMBGBackend) -> None:
    """A flat color background with no subject may return all-zero or near-zero mask.
    Adapter must NOT crash; caller decides whether to treat it as None."""
    img = _solid_color(128, 128, (1.0, 1.0, 1.0))
    mask = backend.infer(img)
    assert mask is not None
    assert mask.shape == (128, 128)
