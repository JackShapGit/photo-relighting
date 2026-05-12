"""PreparedImage — frozen output of the slow `engine.prepare()` call.

All arrays are float32. Coordinates are (H, W) row-major. Depth is normalized
to [0, 1] (0 = nearest, 1 = farthest). Normals are unit-length world-space
vectors with +z pointing toward the viewer.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

import numpy as np


@dataclass
class PreparedImage:
    original: np.ndarray            # (H, W, 3) float32 linear sRGB
    depth: np.ndarray               # (H, W) float32 in [0, 1]
    normals: np.ndarray             # (H, W, 3) float32 unit vectors
    mask: np.ndarray | None         # (H, W) float32 in [0, 1], or None
    width: int
    height: int
    metadata: dict[str, Any] = field(default_factory=dict)
    confidence: np.ndarray | None = None  # (H, W) float32 in [0, 1], or None

    def validate(self) -> None:
        h, w = self.height, self.width
        if self.original.shape != (h, w, 3) or self.original.dtype != np.float32:
            raise ValueError(f"original shape/dtype: {self.original.shape}/{self.original.dtype}")
        if self.depth.shape != (h, w) or self.depth.dtype != np.float32:
            raise ValueError(f"depth shape/dtype: {self.depth.shape}/{self.depth.dtype}")
        if not (self.depth.min() >= -1e-4 and self.depth.max() <= 1 + 1e-4):
            raise ValueError("depth must be in [0, 1]")
        if self.normals.shape != (h, w, 3) or self.normals.dtype != np.float32:
            raise ValueError(f"normals shape/dtype: {self.normals.shape}/{self.normals.dtype}")
        norms = np.linalg.norm(self.normals, axis=-1)
        if not np.allclose(norms, 1.0, atol=1e-3):
            raise ValueError("normals must be unit vectors")
        if self.mask is not None:
            if self.mask.shape != (h, w) or self.mask.dtype != np.float32:
                raise ValueError(f"mask shape/dtype: {self.mask.shape}/{self.mask.dtype}")
            if self.mask.min() < -1e-4 or self.mask.max() > 1 + 1e-4:
                raise ValueError("mask must be in [0, 1]")
        if self.confidence is not None:
            if self.confidence.shape != (h, w) or self.confidence.dtype != np.float32:
                raise ValueError(
                    f"confidence shape/dtype: {self.confidence.shape}/{self.confidence.dtype}")
            if self.confidence.min() < -1e-4 or self.confidence.max() > 1 + 1e-4:
                raise ValueError("confidence must be in [0, 1]")
