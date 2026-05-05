"""Integration tests for the shader. CPU tensors are fine; GPU is faster."""
from __future__ import annotations

import numpy as np
import pytest
import torch

from relighting_engine.core.prepared import PreparedImage
from relighting_engine.lighting.models import Light
from relighting_engine.lighting.shaders import render

DEV = "cuda" if torch.cuda.is_available() else "cpu"


def _flat_prepared(h: int = 32, w: int = 32, color: float = 0.5) -> PreparedImage:
    return PreparedImage(
        original=np.full((h, w, 3), color, dtype=np.float32),
        depth=np.full((h, w), 0.5, dtype=np.float32),
        normals=np.tile(np.array([0.0, 0.0, 1.0], dtype=np.float32), (h, w, 1)),
        mask=np.zeros((h, w), dtype=np.float32),
        width=w,
        height=h,
        metadata={},
    )


def test_ambient_only_returns_ambient_times_original() -> None:
    p = _flat_prepared(color=0.5)
    out = render(p, lights=[], ambient=0.4, device=DEV)
    np.testing.assert_allclose(out, np.full_like(p.original, 0.2), atol=1e-5)


def test_directional_light_at_neg_z_brightens_flat_surface() -> None:
    p = _flat_prepared(color=0.5)
    light = Light(type="directional", direction=(0.0, 0.0, -1.0),
                  color=(1.0, 1.0, 1.0), intensity=1.0)
    out = render(p, lights=[light], ambient=0.0, device=DEV)
    # Surface normal is +z; light pointing -z means light vector to surface is +z.
    # diffuse = max(dot(N, L_vec), 0) = 1. So out = original * 1 = 0.5.
    np.testing.assert_allclose(out, np.full_like(p.original, 0.5), atol=1e-3)


def test_directional_light_aimed_away_yields_zero_contribution() -> None:
    p = _flat_prepared(color=0.5)
    light = Light(type="directional", direction=(0.0, 0.0, 1.0))
    out = render(p, lights=[light], ambient=0.0, device=DEV)
    np.testing.assert_allclose(out, np.zeros_like(p.original), atol=1e-3)


def test_two_lights_are_additive() -> None:
    p = _flat_prepared(color=0.4)
    l1 = Light(type="directional", direction=(0.0, 0.0, -1.0), intensity=0.5)
    l2 = Light(type="directional", direction=(0.0, 0.0, -1.0), intensity=0.5)
    out = render(p, lights=[l1, l2], ambient=0.0, device=DEV)
    # Each contributes 0.5 * 0.4 = 0.2; total 0.4
    np.testing.assert_allclose(out, np.full_like(p.original, 0.4), atol=1e-3)


def test_subject_only_isolation_with_mask() -> None:
    h, w = 8, 8
    p = _flat_prepared(h, w, color=0.6)
    mask = np.zeros((h, w), dtype=np.float32)
    mask[:, : w // 2] = 1.0
    p.mask = mask
    light = Light(type="directional", direction=(0.0, 0.0, -1.0),
                  intensity=1.0, affects="subject")
    out = render(p, lights=[light], ambient=0.0, device=DEV)
    assert out[0, 0, 0] > 0.5    # left half lit
    assert out[0, w - 1, 0] < 0.05  # right half dark


def test_disabled_light_contributes_nothing() -> None:
    p = _flat_prepared(color=0.5)
    light = Light(type="directional", direction=(0.0, 0.0, -1.0),
                  intensity=10.0, enabled=False)
    out = render(p, lights=[light], ambient=0.1, device=DEV)
    np.testing.assert_allclose(out, np.full_like(p.original, 0.05), atol=1e-3)


def test_output_is_clamped_to_unit_interval() -> None:
    p = _flat_prepared(color=1.0)
    lights = [Light(type="directional", direction=(0.0, 0.0, -1.0), intensity=10.0)]
    out = render(p, lights=lights, ambient=0.5, device=DEV)
    assert out.max() <= 1.0
    assert out.min() >= 0.0


def test_determinism_same_inputs_same_outputs() -> None:
    p = _flat_prepared(color=0.4)
    l = Light(type="spotlight", position=(0.5, 0.5, -1.0),
              direction=(0.0, 0.0, 1.0), cone_angle=0.5, intensity=1.0)
    a = render(p, lights=[l], ambient=0.2, device=DEV)
    b = render(p, lights=[l], ambient=0.2, device=DEV)
    np.testing.assert_array_equal(a, b)
