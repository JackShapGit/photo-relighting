"""Shared FakeEngine used by /render, /session, and error-path tests."""
from __future__ import annotations

import numpy as np

from relighting_engine.core.prepared import PreparedImage


class FakeEngine:
    def __init__(self) -> None:
        self.last_lights: list = []
        self.last_ambient: float = 0.0

    def prepare(self, img: np.ndarray, mode: str = "interactive") -> PreparedImage:
        h, w = img.shape[:2]
        return PreparedImage(
            original=img.astype(np.float32),
            depth=np.full((h, w), 0.5, dtype=np.float32),
            normals=np.tile(np.array([0.0, 0.0, 1.0], dtype=np.float32), (h, w, 1)),
            mask=None,
            width=w,
            height=h,
            metadata={"depth_model": "fake", "seg_model": "fake", "prep_ms": 0},
        )

    def render(self, prepared, lights, ambient=0.2, output_resolution=None) -> np.ndarray:
        self.last_lights = list(lights)
        self.last_ambient = ambient
        return np.full((prepared.height, prepared.width, 3), 0.5, dtype=np.float32)
