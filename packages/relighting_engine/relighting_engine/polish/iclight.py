"""IC-Light diffusion polish backend.

Lazy model loading mirrors the segmentation backends (RMBG, SAM2): the
constructor stores config only, weights are downloaded and moved to GPU
on the first call to polish(). The weights stay resident afterwards so
subsequent polishes within the same process pay only the inference cost.

The implementation of polish() is supplied in Task 4. Until then it raises
NotImplementedError; the contract test only exercises the signature.
"""
from __future__ import annotations

from typing import Optional

import numpy as np


class ICLightBackend:
    def __init__(self, device: str = "cuda"):
        self.device = device
        self._pipe = None  # diffusers pipeline; lazy-loaded on first polish()

    def polish(
        self,
        classical_render: np.ndarray,   # HxWx3 float32 linear-sRGB, [0, 1]
        foreground_rgba: np.ndarray,    # HxWx4 float32 linear-sRGB, [0, 1]
        prompt: str = "",
        *,
        seed: Optional[int] = None,
    ) -> np.ndarray:
        """Refine classical_render with IC-Light. See Task 4 for implementation."""
        raise NotImplementedError("Task 4 implements polish inference")
