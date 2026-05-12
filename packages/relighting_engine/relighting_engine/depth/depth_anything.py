"""Depth Anything V3 (DA3-BASE) adapter.

Public surface:
    DepthAnythingBackend(device).infer(image, mode) -> depth (H, W) float32 [0, 1]
    DepthAnythingBackend(device).infer_with_conf(image, mode)
        -> (depth, conf) both (H, W) float32 [0, 1]

Two modes:
    interactive  - input long-side capped at 1024 px before inference, then upsampled
    quality      - native long-side up to 4096 px

Model loading is lazy (first .infer() call). Weights cached under ~/.cache/huggingface/.
"""
from __future__ import annotations

from typing import Literal

import cv2
import numpy as np
import torch

INTERACTIVE_CAP = 1024
QUALITY_CAP = 4096

_MODE_CAPS: dict[str, int] = {
    "interactive": INTERACTIVE_CAP,
    "quality": QUALITY_CAP,
}


class DepthAnythingBackend:
    """Adapter around DepthAnything3 for single-image depth estimation.

    Parameters
    ----------
    device:
        PyTorch device string, e.g. ``"cuda"`` or ``"cpu"``.
    variant:
        HuggingFace model repo ID. Defaults to ``"depth-anything/da3-base"``.
    """

    def __init__(
        self,
        device: str = "cuda",
        variant: str = "depth-anything/da3-base",
    ) -> None:
        self.device = device
        self.variant = variant
        self._model: object | None = None
        self.last_inference_long_side: int = 0

    def _load(self) -> None:
        """Idempotently load model weights. First call downloads ~400 MB."""
        if self._model is not None:
            return
        from depth_anything_3.api import DepthAnything3  # noqa: PLC0415

        self._model = (
            DepthAnything3.from_pretrained(self.variant).to(self.device).eval()
        )

    @torch.inference_mode()
    def infer_with_conf(
        self,
        image: np.ndarray,
        mode: Literal["interactive", "quality"] = "interactive",
    ) -> tuple[np.ndarray, np.ndarray | None]:
        """Run depth estimation, returning (depth, confidence) both at input resolution.

        Parameters
        ----------
        image:
            ``(H, W, 3) float32`` array in [0, 1] linear-sRGB.
        mode:
            ``"interactive"`` caps the inference long-side at 1024 px;
            ``"quality"`` caps at 4096 px (native resolution when smaller).

        Returns
        -------
        tuple[np.ndarray, np.ndarray | None]
            ``depth``: ``(H, W) float32`` normalized to [0, 1] (0 = nearest, 1 = farthest).
            ``conf``: ``(H, W) float32`` per-pixel confidence min-max-normalized to [0, 1]
            (1 = most confident), or ``None`` if the model didn't return one.
        """
        self._load()

        h, w = image.shape[:2]
        cap = _MODE_CAPS[mode]

        long_side = max(h, w)
        process_res = min(long_side, cap)
        self.last_inference_long_side = process_res

        image_uint8 = (image * 255.0).clip(0, 255).astype(np.uint8)

        prediction = self._model.inference(  # type: ignore[union-attr]
            [image_uint8],
            process_res=process_res,
            process_res_method="upper_bound_resize",
            export_dir=None,
        )

        depth = prediction.depth
        if isinstance(depth, torch.Tensor):
            depth = depth.cpu().numpy()
        depth = depth[0]
        if depth.shape != (h, w):
            depth = cv2.resize(depth, (w, h), interpolation=cv2.INTER_LINEAR)

        d_min = float(depth.min())
        d_max = float(depth.max())
        if (d_max - d_min) < 1e-6:
            depth_norm = np.zeros((h, w), dtype=np.float32)
        else:
            depth_norm = ((depth - d_min) / (d_max - d_min)).astype(np.float32)

        conf = getattr(prediction, "conf", None)
        if conf is None:
            return depth_norm, None
        if isinstance(conf, torch.Tensor):
            conf = conf.cpu().numpy()
        conf = conf[0]
        if conf.shape != (h, w):
            conf = cv2.resize(conf, (w, h), interpolation=cv2.INTER_LINEAR)

        # DA3's confidence is bimodal — featureless smooth regions (skies,
        # walls) score low not because the depth is wrong but because there's
        # nothing to anchor on. Min-max normalization would crush lighting on
        # those regions, so we use a robust percentile-based ramp with a floor:
        # everything at-or-above the median gets full lighting; the bottom
        # decile is held at FLOOR; the 10th–50th percentile tier ramps smoothly.
        FLOOR = 0.5
        p10 = float(np.percentile(conf, 10))
        p50 = float(np.percentile(conf, 50))
        if (p50 - p10) < 1e-6:
            conf_norm = np.ones((h, w), dtype=np.float32)
        else:
            raw = np.clip((conf - p10) / (p50 - p10), 0.0, 1.0)
            conf_norm = (FLOOR + (1.0 - FLOOR) * raw).astype(np.float32)
        return depth_norm, conf_norm

    def infer(
        self,
        image: np.ndarray,
        mode: Literal["interactive", "quality"] = "interactive",
    ) -> np.ndarray:
        """Backward-compatible wrapper that returns depth only (see ``infer_with_conf``)."""
        depth, _ = self.infer_with_conf(image, mode=mode)
        return depth
