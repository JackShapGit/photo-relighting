"""Diffusion polish backend — SD1.5 img2img at low denoising strength.

Takes the classical render as the init image and runs a few diffusion steps
to add photographic micro-detail (grain, soft highlight rolloff, slight
texture realism) while preserving the user's lighting setup. Low strength
(~0.25) means most of each pixel comes from the classical render and the
model fills in the rest with photoreal noise.

Previously this used IC-Light fc, but that variant is designed for
"flat-lit subject + text prompt → relit subject" and was rewriting our
renders far too aggressively — changing costume colors, fabricating
window light, mangling faces. Plain img2img is more predictable for the
"polish, don't restage" semantics we actually want.
"""
from __future__ import annotations

from typing import Optional

import numpy as np

from relighting_engine.polish.prompts import DEFAULT_NEGATIVE_PROMPT, DEFAULT_PROMPT

# Img2img at low strength preserves most pixels, so resolution drift hurts
# less than under full t2i. Cap at 1024 on the long edge — large enough
# for face detail to survive the bilinear round-trip on typical inputs.
_DIFFUSION_RES_MAX = 1024
_SD15_REPO = "stablediffusionapi/realistic-vision-v51"
_DEFAULT_STRENGTH = 0.25
_DEFAULT_NUM_STEPS = 30
_DEFAULT_GUIDANCE = 5.0


class PolishBackend:
    def __init__(self, device: str = "cuda"):
        self.device = device
        self._pipe = None

    def _load(self):
        if self._pipe is not None:
            return
        import torch
        from diffusers import DPMSolverMultistepScheduler, StableDiffusionImg2ImgPipeline

        dtype = torch.float16 if self.device == "cuda" else torch.float32

        pipe = StableDiffusionImg2ImgPipeline.from_pretrained(
            _SD15_REPO,
            torch_dtype=dtype,
            safety_checker=None,
            requires_safety_checker=False,
        ).to(self.device)

        pipe.scheduler = DPMSolverMultistepScheduler.from_config(
            pipe.scheduler.config,
            algorithm_type="sde-dpmsolver++",
            use_karras_sigmas=True,
        )
        pipe.set_progress_bar_config(disable=True)

        self._pipe = pipe

    def polish(
        self,
        classical_render: np.ndarray,   # HxWx3 float32 linear-sRGB, [0, 1]
        prompt: str = "",
        *,
        seed: Optional[int] = None,
        strength: float = _DEFAULT_STRENGTH,
    ) -> np.ndarray:
        """Run SD1.5 img2img on the classical render. Returns linear-sRGB."""
        import cv2
        import torch
        from PIL import Image

        from relighting_engine.core.io import _linear_to_srgb, _srgb_to_linear

        self._load()
        h_orig, w_orig = classical_render.shape[:2]

        positive = prompt.strip() if prompt and prompt.strip() else DEFAULT_PROMPT
        negative = DEFAULT_NEGATIVE_PROMPT

        # Resize to diffusion resolution, multiple of 8 for SD UNet.
        scale = min(_DIFFUSION_RES_MAX / max(h_orig, w_orig), 1.0)
        h_d = max(int(round(h_orig * scale / 8)) * 8, 64)
        w_d = max(int(round(w_orig * scale / 8)) * 8, 64)

        # Linear-sRGB float → encoded-sRGB uint8 for PIL/diffusers.
        srgb = _linear_to_srgb(classical_render)
        srgb_u8 = np.clip(srgb * 255 + 0.5, 0, 255).astype(np.uint8)
        srgb_resized = cv2.resize(srgb_u8, (w_d, h_d), interpolation=cv2.INTER_LINEAR)
        init_image = Image.fromarray(srgb_resized)

        generator = torch.Generator(device=self.device)
        if seed is not None:
            generator.manual_seed(int(seed))

        with torch.no_grad():
            result = self._pipe(
                prompt=positive,
                negative_prompt=negative,
                image=init_image,
                strength=float(strength),
                num_inference_steps=_DEFAULT_NUM_STEPS,
                guidance_scale=_DEFAULT_GUIDANCE,
                generator=generator,
            )
        out_srgb_u8 = np.asarray(result.images[0])

        if (h_d, w_d) != (h_orig, w_orig):
            out_srgb_u8 = cv2.resize(
                out_srgb_u8, (w_orig, h_orig), interpolation=cv2.INTER_LINEAR,
            )

        # Encoded-sRGB uint8 → linear-sRGB float32.
        out_srgb = out_srgb_u8.astype(np.float32) / 255.0
        out_linear = _srgb_to_linear(out_srgb)
        return np.clip(out_linear, 0.0, 1.0).astype(np.float32)
