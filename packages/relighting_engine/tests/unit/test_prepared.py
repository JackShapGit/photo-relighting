"""Unit tests for the PreparedImage dataclass — shape and dtype invariants."""
from __future__ import annotations

import numpy as np
import pytest

from relighting_engine.core.prepared import PreparedImage


def _zero_prepared(h: int = 8, w: int = 8, with_mask: bool = True) -> PreparedImage:
    return PreparedImage(
        original=np.zeros((h, w, 3), dtype=np.float32),
        depth=np.zeros((h, w), dtype=np.float32),
        normals=np.tile(np.array([0.0, 0.0, 1.0], dtype=np.float32), (h, w, 1)),
        mask=np.zeros((h, w), dtype=np.float32) if with_mask else None,
        width=w,
        height=h,
        metadata={},
    )


def test_valid_shapes_pass_validation() -> None:
    p = _zero_prepared()
    p.validate()  # no raise


def test_mismatched_depth_shape_raises() -> None:
    p = _zero_prepared()
    p.depth = np.zeros((4, 4), dtype=np.float32)
    with pytest.raises(ValueError, match="depth shape"):
        p.validate()


def test_normals_must_be_unit_vectors_within_tolerance() -> None:
    p = _zero_prepared()
    p.normals = np.zeros_like(p.normals)  # zero-length vectors
    with pytest.raises(ValueError, match="unit vectors"):
        p.validate()


def test_mask_can_be_none() -> None:
    p = _zero_prepared(with_mask=False)
    p.validate()
    assert p.mask is None


def test_depth_must_be_in_unit_interval() -> None:
    p = _zero_prepared()
    p.depth = np.full((8, 8), 1.5, dtype=np.float32)
    with pytest.raises(ValueError, match="depth must be in"):
        p.validate()
