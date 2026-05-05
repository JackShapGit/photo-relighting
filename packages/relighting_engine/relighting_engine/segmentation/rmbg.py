"""RMBG-2.0 background-removal adapter.

Returns a foreground mask (1 = subject, 0 = background) as (H, W) float32 in [0, 1].
Model loaded lazily on first call; weights cached in HF cache.
"""
from __future__ import annotations

import numpy as np
import torch
import torch.nn.functional as F


class RMBGBackend:
    REPO = "briaai/RMBG-2.0"

    def __init__(self, device: str = "cuda"):
        self.device = device
        self._model = None
        # RMBG-2.0 expects 1024x1024 input; we resize then upsample mask back.
        self.input_size = 1024

    def _load(self) -> None:
        if self._model is not None:
            return
        from transformers import AutoModelForImageSegmentation
        m = AutoModelForImageSegmentation.from_pretrained(self.REPO, trust_remote_code=True)
        self._model = m.to(self.device).eval()

    @torch.inference_mode()
    def infer(self, image: np.ndarray) -> np.ndarray:
        if image.dtype != np.float32 or image.ndim != 3 or image.shape[-1] != 3:
            raise ValueError("expected HxWx3 float32 image")
        self._load()
        h, w = image.shape[:2]

        x = torch.from_numpy(image).permute(2, 0, 1).unsqueeze(0).to(self.device)
        # RMBG-2.0 uses ImageNet normalization; consult the model card.
        mean = torch.tensor([0.485, 0.456, 0.406], device=self.device).view(1, 3, 1, 1)
        std  = torch.tensor([0.229, 0.224, 0.225], device=self.device).view(1, 3, 1, 1)
        x = F.interpolate(x, size=(self.input_size, self.input_size),
                          mode="bilinear", align_corners=False)
        x = (x - mean) / std

        out = self._model(x)
        # RMBG-2.0 returns a list whose last element is the binary mask logit map.
        if isinstance(out, (list, tuple)):
            logits = out[-1]
        else:
            logits = out
        if logits.ndim == 4:
            logits = logits[:, :1] if logits.shape[1] > 1 else logits
        mask = torch.sigmoid(logits)
        mask = F.interpolate(mask, size=(h, w), mode="bilinear", align_corners=False)
        return mask[0, 0].float().cpu().numpy().astype(np.float32)
