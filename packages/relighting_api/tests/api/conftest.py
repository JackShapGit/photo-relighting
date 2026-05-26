"""Shared FakeEngine used by /render, /session, and error-path tests."""
from __future__ import annotations

import numpy as np

from relighting_engine.core.prepared import PreparedImage


class FakeEngine:
    def __init__(self) -> None:
        self.last_lights: list = []
        self.last_ambient: float = 0.0
        self.polish_raises: Exception | None = None

    def prepare(self, img: np.ndarray, mode: str = "interactive",
                *, segmenter: str = "rmbg") -> PreparedImage:
        h, w = img.shape[:2]
        return PreparedImage(
            original=img.astype(np.float32),
            depth=np.full((h, w), 0.5, dtype=np.float32),
            normals=np.tile(np.array([0.0, 0.0, 1.0], dtype=np.float32), (h, w, 1)),
            mask=None,
            width=w,
            height=h,
            metadata={"depth_model": "fake", "seg_model": segmenter, "prep_ms": 0},
        )

    def render(
        self, prepared, lights, ambient=0.2, output_resolution=None,
        shadow_style="off",
        ambient_subject=None, ambient_background=None,
    ) -> np.ndarray:
        self.last_lights = list(lights)
        self.last_ambient = ambient
        self.last_ambient_subject = ambient_subject
        self.last_ambient_background = ambient_background
        self.last_shadow_style = shadow_style
        return np.full((prepared.height, prepared.width, 3), 0.5, dtype=np.float32)

    def render_layers(
        self, prepared, lights, ambient=0.2,
        ambient_subject=None, ambient_background=None,
        shadow_style="off", output_resolution=None,
    ) -> dict[str, np.ndarray]:
        self.last_lights = list(lights)
        self.last_ambient = ambient
        h = output_resolution[1] if output_resolution else prepared.height
        w = output_resolution[0] if output_resolution else prepared.width
        result = {"Ambient": np.full((h, w, 3), 0.3, dtype=np.float32)}
        for i, L in enumerate(lights):
            if L.enabled:
                name = getattr(L, "name", "") or f"Light {i+1}"
                result[name] = np.full((h, w, 3), 0.2, dtype=np.float32)
        return result

    def polish(
        self, prepared, lights, *, ambient=0.2,
        ambient_subject=None, ambient_background=None,
        shadow_style="off",
        prompt="", seed=None, output_resolution=None,
    ) -> np.ndarray:
        if self.polish_raises is not None:
            raise self.polish_raises
        self.last_lights = list(lights)
        self.last_ambient = ambient
        self.last_ambient_subject = ambient_subject
        self.last_ambient_background = ambient_background
        self.last_shadow_style = shadow_style
        self.last_prompt = prompt
        self.last_seed = seed
        h = output_resolution[1] if output_resolution else prepared.height
        w = output_resolution[0] if output_resolution else prepared.width
        return np.full((h, w, 3), 0.7, dtype=np.float32)
