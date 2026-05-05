"""End-to-end test: prepare + render against a small synthetic input."""
from __future__ import annotations

import numpy as np
import pytest
import torch

if not torch.cuda.is_available():
    pytest.skip("CUDA required", allow_module_level=True)

from relighting_engine import RelightingEngine
from relighting_engine.lighting.models import Light


def _scene(h: int = 256, w: int = 256) -> np.ndarray:
    """A center disc on dark background — gives the segmentation model something to lock onto."""
    img = np.full((h, w, 3), 0.05, dtype=np.float32)
    Y, X = np.mgrid[:h, :w].astype(np.float32)
    cy, cx = h / 2, w / 2
    r = np.sqrt((Y - cy) ** 2 + (X - cx) ** 2)
    disc = r < min(h, w) * 0.3
    img[disc] = (0.7, 0.5, 0.4)
    return img


@pytest.fixture(scope="module")
def engine() -> "RelightingEngine":
    return RelightingEngine(device="cuda")


@pytest.mark.gpu
@pytest.mark.models
def test_prepare_returns_valid_prepared_image(engine: "RelightingEngine") -> None:
    img = _scene()
    p = engine.prepare(img, mode="interactive")
    p.validate()
    assert p.width == 256 and p.height == 256
    assert "depth_model" in p.metadata
    assert "seg_model" in p.metadata
    assert "prep_ms" in p.metadata


@pytest.mark.gpu
@pytest.mark.models
def test_render_produces_image_in_unit_range(engine: "RelightingEngine") -> None:
    p = engine.prepare(_scene(), mode="interactive")
    out = engine.render(p, lights=[
        Light(type="directional", direction=(0.0, 0.0, -1.0), intensity=1.0)
    ], ambient=0.1)
    assert out.shape == (256, 256, 3)
    assert out.dtype == np.float32
    assert out.min() >= 0.0 and out.max() <= 1.0


@pytest.mark.gpu
@pytest.mark.models
def test_render_is_deterministic(engine: "RelightingEngine") -> None:
    p = engine.prepare(_scene(), mode="interactive")
    a = engine.render(p, lights=[Light(type="directional", direction=(0.5, -0.5, -0.5))])
    b = engine.render(p, lights=[Light(type="directional", direction=(0.5, -0.5, -0.5))])
    np.testing.assert_array_equal(a, b)
