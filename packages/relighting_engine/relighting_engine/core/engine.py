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
from relighting_engine.polish.backend import PolishBackend
from relighting_engine.segmentation.rmbg import RMBGBackend
from relighting_engine.segmentation.sam2 import SAM2Backend

Mode = Literal["interactive", "quality"]
Segmenter = Literal["rmbg", "sam2"]
ASSETS_GOBOS = Path(__file__).resolve().parent.parent / "assets" / "gobos"


class RelightingEngine:
    def __init__(
        self,
        device: str = "cuda",
        depth_backend: str = "depth-anything-v3",
        default_segmenter: Segmenter = "rmbg",
    ):
        if device == "cuda" and not torch.cuda.is_available():
            raise RuntimeError("CUDA requested but not available")
        self.device = device
        self._depth = DepthAnythingBackend(device=device)
        self.depth_backend_name = depth_backend
        self.default_segmenter = default_segmenter
        # Both segmentation backends are lazy-instantiated on first use so we
        # don't pay the import + weight-download cost for the one we don't use.
        self._segmenters: dict[str, object] = {}
        self._gobo_textures: dict[str, torch.Tensor] | None = None
        self._polisher: PolishBackend | None = None

    def _get_segmenter(self, name: str):
        if name not in self._segmenters:
            if name == "rmbg":
                self._segmenters[name] = RMBGBackend(device=self.device)
            elif name == "sam2":
                self._segmenters[name] = SAM2Backend(device=self.device)
            else:
                raise ValueError(f"unknown segmenter: {name!r}")
        return self._segmenters[name]

    # Public alias — used by the /refine_mask route to reach into the cached
    # SAM2Backend instance after a successful prepare.
    get_segmenter = _get_segmenter

    def _get_polisher(self) -> PolishBackend:
        """Lazy-init the polish backend. First call downloads weights."""
        if self._polisher is None:
            self._polisher = PolishBackend(device=self.device)
        return self._polisher

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

    def prepare(
        self,
        image: np.ndarray,
        mode: Mode = "interactive",
        *,
        segmenter: Segmenter | None = None,
    ) -> PreparedImage:
        if image.dtype != np.float32 or image.ndim != 3 or image.shape[-1] != 3:
            raise ValueError("expected HxWx3 float32 linear-sRGB image")
        h, w = image.shape[:2]
        seg_name = segmenter or self.default_segmenter

        t0 = time.perf_counter()
        depth, confidence = self._depth.infer_with_conf(image, mode=mode)
        t_depth = time.perf_counter() - t0

        t1 = time.perf_counter()
        try:
            seg = self._get_segmenter(seg_name)
            mask = seg.infer(image)
            if float(mask.max()) < 0.05:
                mask = None  # nothing salient — let downstream treat as no subject
        except Exception:  # noqa: BLE001 — seg is best-effort
            mask = None
        t_seg = time.perf_counter() - t1

        t2 = time.perf_counter()
        normals = normals_from_depth(depth)
        t_norm = time.perf_counter() - t2

        # Reference depth for the planar-shadow projection: the median depth
        # of the masked subject pixels (or a 0.3 fallback if there's no mask
        # or the mask is empty). Computed once here so the canvas preview
        # doesn't need to re-derive it client-side.
        if mask is not None:
            m = mask > 0.5
            subject_median_depth = float(np.median(depth[m])) if bool(m.any()) else 0.3
        else:
            subject_median_depth = 0.3

        prep_ms = int((time.perf_counter() - t0) * 1000)
        prepared = PreparedImage(
            original=image,
            depth=depth,
            normals=normals,
            mask=mask,
            confidence=confidence,
            width=w,
            height=h,
            metadata={
                "depth_model": self.depth_backend_name,
                "seg_model": seg_name,
                "prep_ms": prep_ms,
                "depth_ms": int(t_depth * 1000),
                "seg_ms": int(t_seg * 1000),
                "normals_ms": int(t_norm * 1000),
                "mode": mode,
                "subject_median_depth": subject_median_depth,
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
        shadow_style: str = "off",
        ambient_subject: float | None = None,
        ambient_background: float | None = None,
    ) -> np.ndarray:
        out = shader_render(
            prepared, lights, ambient=ambient,
            ambient_subject=ambient_subject,
            ambient_background=ambient_background,
            device=self.device, gobo_textures=self._gobos(),
            shadow_style=shadow_style,
        )
        if output_resolution is not None:
            import cv2
            tw, th = output_resolution
            out = cv2.resize(out, (tw, th), interpolation=cv2.INTER_LINEAR)
        return out

    def polish(
        self,
        prepared: PreparedImage,
        lights: Sequence[Light],
        *,
        ambient: float = 0.2,
        ambient_subject: float | None = None,
        ambient_background: float | None = None,
        shadow_style: str = "off",
        prompt: str = "",
        seed: int | None = None,
        output_resolution: tuple[int, int] | None = None,
    ) -> np.ndarray:
        """Run the classical render, then refine with SD1.5 img2img.

        Returns HxWx3 float32 linear-sRGB in [0,1]. Output dimensions match
        prepared.height × prepared.width unless output_resolution is given.
        """
        classical = self.render(
            prepared, lights, ambient=ambient,
            ambient_subject=ambient_subject,
            ambient_background=ambient_background,
            output_resolution=None, shadow_style=shadow_style,
        )

        polisher = self._get_polisher()
        out = polisher.polish(classical, prompt=prompt, seed=seed)

        if output_resolution is not None:
            import cv2
            tw, th = output_resolution
            out = cv2.resize(out, (tw, th), interpolation=cv2.INTER_LINEAR)
        return out
