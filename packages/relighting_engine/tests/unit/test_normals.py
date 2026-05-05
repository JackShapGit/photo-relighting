"""Unit tests for normals-from-depth. CPU-only."""
from __future__ import annotations

import numpy as np

from relighting_engine.normals.from_depth import normals_from_depth


def test_flat_depth_yields_plus_z_normals() -> None:
    h, w = 32, 32
    depth = np.full((h, w), 0.5, dtype=np.float32)
    n = normals_from_depth(depth)
    assert n.shape == (h, w, 3)
    assert n.dtype == np.float32
    # All normals point at +z (camera).
    assert np.allclose(n[..., 2], 1.0, atol=1e-3)
    assert np.allclose(n[..., 0], 0.0, atol=1e-3)
    assert np.allclose(n[..., 1], 0.0, atol=1e-3)


def test_normals_are_unit_length() -> None:
    rng = np.random.default_rng(0)
    depth = rng.random((48, 48)).astype(np.float32)
    n = normals_from_depth(depth)
    norms = np.linalg.norm(n, axis=-1)
    assert np.allclose(norms, 1.0, atol=1e-3)


def test_horizontal_ramp_tilts_normals_in_x() -> None:
    """Depth increases left→right (closer on left). Normals should tilt -x:
    surface points away from the +x direction."""
    h, w = 32, 32
    depth = np.tile(np.linspace(0.0, 1.0, w, dtype=np.float32), (h, 1))
    n = normals_from_depth(depth, sigma=0.0)
    assert n[..., 0].mean() < -0.1
    assert abs(n[..., 1].mean()) < 0.05
    assert n[..., 2].mean() > 0.5


def test_smoothing_reduces_high_freq_noise() -> None:
    rng = np.random.default_rng(1)
    depth = rng.random((64, 64)).astype(np.float32)
    n_raw = normals_from_depth(depth, sigma=0.0)
    n_smooth = normals_from_depth(depth, sigma=2.0)
    var_raw = np.var(n_raw[..., :2])
    var_smooth = np.var(n_smooth[..., :2])
    assert var_smooth < var_raw
