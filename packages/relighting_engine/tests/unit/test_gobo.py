"""Unit tests for gobo projection — UV calculation per light type.

Coordinate convention (used everywhere in the engine):
    x: right (normalized 0..1 across image)
    y: down  (normalized 0..1 across image)
    z: away from camera (depth)
"""
from __future__ import annotations

import numpy as np
import pytest
import torch

from relighting_engine.lighting.gobo import project_uv
from relighting_engine.lighting.models import Light


@pytest.fixture
def grid() -> tuple[torch.Tensor, torch.Tensor]:
    """Return (P, L_vec) on CPU. P is (H, W, 3) world position, L_vec is to-light."""
    h, w = 4, 4
    xs = torch.linspace(0.0, 1.0, w)
    ys = torch.linspace(0.0, 1.0, h)
    Y, X = torch.meshgrid(ys, xs, indexing="ij")
    Z = torch.full_like(X, 0.5)
    P = torch.stack([X, Y, Z], dim=-1)
    return P, P  # for tests not needing L_vec


def test_spotlight_perspective_centered() -> None:
    """A spotlight aimed straight along +z from (0.5,0.5,-1): the screen-center
    pixel projects to UV (0.5, 0.5). Off-center pixels project away from center."""
    h, w = 5, 5
    xs = torch.linspace(0.0, 1.0, w)
    ys = torch.linspace(0.0, 1.0, h)
    Y, X = torch.meshgrid(ys, xs, indexing="ij")
    P = torch.stack([X, Y, torch.zeros_like(X)], dim=-1)  # all on z=0 screen plane

    light = Light(
        type="spotlight",
        position=(0.5, 0.5, -1.0),
        direction=(0.0, 0.0, 1.0),
        cone_angle=0.6,
    )
    uv = project_uv(P, light)
    assert uv.shape == (h, w, 2)
    # Center pixel (closest to (0.5,0.5))
    cy, cx = h // 2, w // 2
    assert abs(float(uv[cy, cx, 0]) - 0.5) < 0.05
    assert abs(float(uv[cy, cx, 1]) - 0.5) < 0.05


def test_directional_orthographic_constant_offset_under_translation() -> None:
    """For a directional gobo, two pixels that differ in z by the same amount
    should produce UVs identical in the orthographic plane (modulo direction)."""
    P1 = torch.tensor([[[0.5, 0.5, 0.0]]])
    P2 = torch.tensor([[[0.5, 0.5, 0.5]]])
    light = Light(type="directional", direction=(0.0, 0.0, 1.0))
    uv1 = project_uv(P1, light)
    uv2 = project_uv(P2, light)
    assert torch.allclose(uv1, uv2, atol=1e-5)


def test_point_equirectangular_uv_in_unit_square() -> None:
    """Equirect UV maps any direction to (u, v) in [0,1]^2."""
    h, w = 8, 8
    xs = torch.linspace(0.0, 1.0, w)
    ys = torch.linspace(0.0, 1.0, h)
    Y, X = torch.meshgrid(ys, xs, indexing="ij")
    P = torch.stack([X, Y, torch.zeros_like(X)], dim=-1)
    light = Light(type="point", position=(0.5, 0.5, -1.0))
    uv = project_uv(P, light)
    assert torch.all(uv >= 0.0)
    assert torch.all(uv <= 1.0 + 1e-5)
