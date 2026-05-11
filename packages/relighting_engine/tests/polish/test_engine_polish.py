"""Engine-level polish() orchestration test.

Uses a FakePolishBackend that records its inputs and returns a deterministic
image, so the test runs without a GPU or model weights.
"""
from __future__ import annotations

import numpy as np
import pytest

from relighting_engine.core.engine import RelightingEngine
from relighting_engine.core.prepared import PreparedImage


class FakePolishBackend:
    def __init__(self, device: str = "cuda"):
        self.device = device
        self.calls = []

    def polish(self, classical_render, prompt="", *, seed=None, strength=0.25):
        self.calls.append({
            "classical_shape": classical_render.shape,
            "prompt": prompt,
            "seed": seed,
            "strength": strength,
        })
        h, w = classical_render.shape[:2]
        return np.full((h, w, 3), 0.7, dtype=np.float32)


def _fake_prepared(w=64, h=64) -> PreparedImage:
    img = np.full((h, w, 3), 0.5, dtype=np.float32)
    mask = np.zeros((h, w), dtype=np.float32)
    mask[h // 4: 3 * h // 4, w // 4: 3 * w // 4] = 1.0
    return PreparedImage(
        original=img,
        depth=np.full((h, w), 0.5, dtype=np.float32),
        normals=np.tile(np.array([0.0, 0.0, 1.0], dtype=np.float32), (h, w, 1)),
        mask=mask,
        width=w,
        height=h,
        metadata={"depth_model": "fake", "seg_model": "fake", "prep_ms": 0,
                  "subject_median_depth": 0.5},
    )


@pytest.fixture
def engine_with_fake_polisher(monkeypatch):
    """Construct an engine and monkeypatch its polisher accessor."""
    monkeypatch.setattr(
        "relighting_engine.depth.depth_anything.DepthAnythingBackend.__init__",
        lambda self, device="cuda": None,
    )
    import torch
    monkeypatch.setattr(torch.cuda, "is_available", lambda: True)

    eng = RelightingEngine(device="cpu")
    fake = FakePolishBackend(device="cpu")
    monkeypatch.setattr(eng, "_get_polisher", lambda: fake)
    return eng, fake


def test_engine_polish_returns_image_of_prepared_size(engine_with_fake_polisher):
    eng, _ = engine_with_fake_polisher
    prepared = _fake_prepared()
    out = eng.polish(prepared, lights=[], ambient=0.2, shadow_style="off")
    assert out.shape == (prepared.height, prepared.width, 3)
    assert out.dtype == np.float32


def test_engine_polish_forwards_prompt_and_seed(engine_with_fake_polisher):
    eng, fake = engine_with_fake_polisher
    prepared = _fake_prepared()
    eng.polish(prepared, lights=[], ambient=0.2, shadow_style="off",
               prompt="golden hour", seed=42)
    assert fake.calls[-1]["prompt"] == "golden hour"
    assert fake.calls[-1]["seed"] == 42


def test_engine_polish_passes_classical_render(engine_with_fake_polisher):
    eng, fake = engine_with_fake_polisher
    prepared = _fake_prepared(w=64, h=64)
    eng.polish(prepared, lights=[], ambient=0.2, shadow_style="off")
    assert fake.calls[-1]["classical_shape"] == (64, 64, 3)


def test_engine_polish_respects_output_resolution(engine_with_fake_polisher):
    eng, _ = engine_with_fake_polisher
    prepared = _fake_prepared(w=64, h=64)
    out = eng.polish(prepared, lights=[], ambient=0.2, shadow_style="off",
                     output_resolution=(128, 96))
    assert out.shape == (96, 128, 3)
