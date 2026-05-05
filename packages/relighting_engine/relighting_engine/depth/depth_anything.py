"""Depth Anything V3 (DA3-BASE) adapter.

Public surface:
    DepthAnythingBackend(device).infer(image, mode) -> depth (H, W) float32 [0, 1]

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
    def infer(
        self,
        image: np.ndarray,
        mode: Literal["interactive", "quality"] = "interactive",
    ) -> np.ndarray:
        """Run depth estimation on a single image.

        Parameters
        ----------
        image:
            ``(H, W, 3) float32`` array in [0, 1] linear-sRGB.
        mode:
            ``"interactive"`` caps the inference long-side at 1024 px;
            ``"quality"`` caps at 4096 px (native resolution when smaller).

        Returns
        -------
        np.ndarray
            ``(H, W) float32`` depth map normalized to [0, 1].
            0 = nearest, 1 = farthest.
        """
        self._load()

        h, w = image.shape[:2]
        cap = _MODE_CAPS[mode]

        # Cap at the actual input long-side to avoid upsampling small images.
        # upper_bound_resize scales the longest side exactly to process_res, which
        # means a 720x1280 image with process_res=4096 would be upsampled 3.2x and
        # likely cause OOM. Always use native resolution when smaller than the cap.
        long_side = max(h, w)
        process_res = min(long_side, cap)
        self.last_inference_long_side = process_res

        # Convert float32 [0,1] -> uint8 [0,255] (DA3 trained on standard JPEG/PNG).
        # This is a small systematic shift accepted for MVP; DA3's normalization
        # handles the rest.
        image_uint8 = (image * 255.0).clip(0, 255).astype(np.uint8)

        prediction = self._model.inference(  # type: ignore[union-attr]
            [image_uint8],
            process_res=process_res,
            process_res_method="upper_bound_resize",
            export_dir=None,
        )

        depth = prediction.depth  # numpy ndarray, shape (N, H_out, W_out) float32
        if isinstance(depth, torch.Tensor):
            depth = depth.cpu().numpy()

        # Squeeze batch dimension -> (H_out, W_out)
        depth = depth[0]

        # Upsample back to original input resolution if inference resolution differs.
        if depth.shape != (h, w):
            depth = cv2.resize(depth, (w, h), interpolation=cv2.INTER_LINEAR)

        # Min-max normalize to [0, 1].
        d_min = float(depth.min())
        d_max = float(depth.max())
        if (d_max - d_min) < 1e-6:
            # Degenerate flat image — return zeros.
            return np.zeros((h, w), dtype=np.float32)

        depth = (depth - d_min) / (d_max - d_min)
        return depth.astype(np.float32)
