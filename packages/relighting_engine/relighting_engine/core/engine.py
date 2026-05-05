"""RelightingEngine: orchestrates prepare (slow) and render (fast).

Singleton lifetime — instantiate once, reuse. Holds model instances after first use.
"""
from __future__ import annotations

import time
from pathlib import Path
from typing import Literal, Sequence

import numpy as np
import torch

from relighting_engine.core.prepared import PreparedImage
from relighting_engine.depth.depth_anything import DepthAnythingBackend
from relighting_engine.lighting.models import Light
from relighting_engine.lighting.shaders import render as shader_render
from relighting_engine.normals.from_depth import normals_from_depth
from relighting_engine.segmentation.rmbg import RMBGBackend

Mode = Literal["interactive", "quality"]
ASSETS_GOBOS = Path(__file__).resolve().parent.parent / "assets" / "gobos"


class RelightingEngine:
    def __init__(
        self,
        device: str = "cuda",
        depth_backend: str = "depth-anything-v3",
        seg_backend: str = "rmbg-2.0",
    ):
        if device == "cuda" and not torch.cuda.is_available():
            raise RuntimeError("CUDA requested but not available")
        self.device = device
        self._depth = DepthAnythingBackend(device=device)
        self._seg = RMBGBackend(device=device)
        self.depth_backend_name = depth_backend
        self.seg_backend_name = seg_backend
        self._gobo_textures: dict[str, torch.Tensor] | None = None

    def _gobos(self) -> dict[str, torch.Tensor]:
        if self._gobo_textures is not None:
            return self._gobo_textures
        from PIL import Image
        out: dict[str, torch.Tensor] = {}
        if ASSETS_GOBOS.exists():
            for p in sorted(ASSETS_GOBOS.glob("*.png")):
                arr = np.asarray(Image.open(p).convert("L"), dtype=np.float32) / 255.0
                out[f"preset:{p.stem}"] = torch.from_numpy(arr).to(self.device)
        self._gobo_textures = out
        return out

    def prepare(self, image: np.ndarray, mode: Mode = "interactive") -> PreparedImage:
        if image.dtype != np.float32 or image.ndim != 3 or image.shape[-1] != 3:
            raise ValueError("expected HxWx3 float32 linear-sRGB image")
        h, w = image.shape[:2]

        t0 = time.perf_counter()
        depth = self._depth.infer(image, mode=mode)
        t_depth = time.perf_counter() - t0

        t1 = time.perf_counter()
        try:
            mask = self._seg.infer(image)
            if float(mask.max()) < 0.05:
                mask = None  # nothing salient — let downstream treat as no subject
        except Exception:  # noqa: BLE001 — seg is best-effort
            mask = None
        t_seg = time.perf_counter() - t1

        t2 = time.perf_counter()
        normals = normals_from_depth(depth)
        t_norm = time.perf_counter() - t2

        prep_ms = int((time.perf_counter() - t0) * 1000)
        prepared = PreparedImage(
            original=image,
            depth=depth,
            normals=normals,
            mask=mask,
            width=w,
            height=h,
            metadata={
                "depth_model": self.depth_backend_name,
                "seg_model": self.seg_backend_name,
                "prep_ms": prep_ms,
                "depth_ms": int(t_depth * 1000),
                "seg_ms": int(t_seg * 1000),
                "normals_ms": int(t_norm * 1000),
                "mode": mode,
            },
        )
        prepared.validate()
        return prepared

    def render(
        self,
        prepared: PreparedImage,
        lights: Sequence[Light],
        ambient: float = 0.2,
        output_resolution: tuple[int, int] | None = None,
    ) -> np.ndarray:
        out = shader_render(
            prepared, lights, ambient=ambient,
            device=self.device, gobo_textures=self._gobos(),
        )
        if output_resolution is not None:
            import cv2
            tw, th = output_resolution
            out = cv2.resize(out, (tw, th), interpolation=cv2.INTER_LINEAR)
        return out
