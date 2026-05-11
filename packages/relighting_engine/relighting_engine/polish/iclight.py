"""IC-Light diffusion polish backend.

Lazy model loading mirrors the segmentation backends (RMBG, SAM2): the
constructor stores config only, weights are downloaded and moved to GPU
on the first call to polish(). The weights stay resident afterwards so
subsequent polishes within the same process pay only the inference cost.

Implementation notes:
  - Base model: stablediffusionapi/realistic-vision-v51 (the SD1.5 derivative
    IC-Light's authors recommend for photorealistic output).
  - IC-Light fc weights are an *offset* added to the SD1.5 UNet, not a
    replacement — see lllyasviel/IC-Light/gradio_demo_fc.py for the
    canonical merge step.
  - The UNet's conv_in is patched from 4 to 8 input channels: 4 noise
    latents concatenated with 4 VAE-encoded conditioning latents.
  - Sampling runs at min(input, 768) on each side, rounded to multiples of
    64 for the UNet. Output is bilinearly upsampled back to the input HxW.
"""
from __future__ import annotations

from typing import Optional

import numpy as np

from relighting_engine.polish.prompts import DEFAULT_NEGATIVE_PROMPT, DEFAULT_PROMPT

_DIFFUSION_RES_MAX = 768
_SD15_REPO = "stablediffusionapi/realistic-vision-v51"
_ICLIGHT_REPO = "lllyasviel/ic-light"
_ICLIGHT_FILENAME = "iclight_sd15_fc.safetensors"


class ICLightBackend:
    def __init__(self, device: str = "cuda"):
        self.device = device
        self._pipe = None

    def _load(self):
        """Build the patched SD1.5 + IC-Light pipeline. Idempotent."""
        if self._pipe is not None:
            return
        import torch
        from diffusers import (
            AutoencoderKL,
            DPMSolverMultistepScheduler,
            UNet2DConditionModel,
        )
        from huggingface_hub import hf_hub_download
        from safetensors.torch import load_file
        from transformers import CLIPTextModel, CLIPTokenizer

        dtype = torch.float16 if self.device == "cuda" else torch.float32

        tokenizer = CLIPTokenizer.from_pretrained(_SD15_REPO, subfolder="tokenizer")
        text_encoder = CLIPTextModel.from_pretrained(
            _SD15_REPO, subfolder="text_encoder", torch_dtype=dtype,
        ).to(self.device)
        vae = AutoencoderKL.from_pretrained(
            _SD15_REPO, subfolder="vae", torch_dtype=dtype,
        ).to(self.device)
        unet = UNet2DConditionModel.from_pretrained(
            _SD15_REPO, subfolder="unet", torch_dtype=dtype,
        ).to(self.device)

        # Patch conv_in: 4 -> 8 input channels. The first 4 channels keep the
        # original SD1.5 weights so the model still functions as SD1.5 before
        # the IC-Light offset is applied; the new 4 channels start at zero.
        with torch.no_grad():
            new_conv_in = torch.nn.Conv2d(
                8, unet.conv_in.out_channels,
                kernel_size=unet.conv_in.kernel_size,
                stride=unet.conv_in.stride,
                padding=unet.conv_in.padding,
            ).to(device=self.device, dtype=dtype)
            new_conv_in.weight.zero_()
            new_conv_in.weight[:, :4, :, :].copy_(unet.conv_in.weight)
            new_conv_in.bias = unet.conv_in.bias
            unet.conv_in = new_conv_in
        unet.config.in_channels = 8

        # Load IC-Light offset weights and ADD to the UNet weights (not load).
        weights_path = hf_hub_download(
            repo_id=_ICLIGHT_REPO, filename=_ICLIGHT_FILENAME,
        )
        sd_offset = load_file(weights_path)
        sd_origin = unet.state_dict()
        sd_merged: dict = {}
        for k, v in sd_origin.items():
            if k in sd_offset:
                offset = sd_offset[k].to(dtype=v.dtype, device=v.device)
                sd_merged[k] = v + offset
            else:
                sd_merged[k] = v
        unet.load_state_dict(sd_merged, strict=True)
        del sd_offset, sd_origin, sd_merged

        # DPM-Solver++ SDE Karras — what the IC-Light reference uses.
        scheduler = DPMSolverMultistepScheduler(
            num_train_timesteps=1000,
            beta_start=0.00085,
            beta_end=0.012,
            algorithm_type="sde-dpmsolver++",
            use_karras_sigmas=True,
            steps_offset=1,
        )

        text_encoder.eval()
        vae.eval()
        unet.eval()

        self._pipe = {
            "tokenizer": tokenizer,
            "text_encoder": text_encoder,
            "vae": vae,
            "unet": unet,
            "scheduler": scheduler,
            "dtype": dtype,
        }

    def polish(
        self,
        classical_render: np.ndarray,
        foreground_rgba: np.ndarray,
        prompt: str = "",
        *,
        seed: Optional[int] = None,
    ) -> np.ndarray:
        import cv2
        import torch

        self._load()
        p = self._pipe
        h_orig, w_orig = classical_render.shape[:2]

        positive = prompt.strip() if prompt and prompt.strip() else DEFAULT_PROMPT
        negative = DEFAULT_NEGATIVE_PROMPT

        # Downscale to diffusion resolution (multiple of 64 for SD UNet).
        scale = min(_DIFFUSION_RES_MAX / max(h_orig, w_orig), 1.0)
        h_d = max(int(round(h_orig * scale / 64)) * 64, 64)
        w_d = max(int(round(w_orig * scale / 64)) * 64, 64)

        classical_d = cv2.resize(classical_render, (w_d, h_d), interpolation=cv2.INTER_LINEAR)
        fg_d = cv2.resize(foreground_rgba, (w_d, h_d), interpolation=cv2.INTER_LINEAR)

        # Composite: foreground on top of the classical render. This is the
        # "scene to relight" — IC-Light will treat it as the target lighting
        # condition and refine photorealistically.
        alpha = fg_d[..., 3:4]
        composite = fg_d[..., :3] * alpha + classical_d * (1.0 - alpha)
        composite = np.clip(composite, 0.0, 1.0).astype(np.float32)

        cond_img = (
            torch.from_numpy(composite)
            .permute(2, 0, 1)
            .unsqueeze(0)
            .to(self.device, dtype=p["dtype"])
        )
        cond_img = cond_img * 2.0 - 1.0  # VAE expects [-1, 1]

        # Encode text prompts.
        def _encode_text(text: str) -> torch.Tensor:
            tokens = p["tokenizer"](
                text,
                padding="max_length",
                max_length=p["tokenizer"].model_max_length,
                truncation=True,
                return_tensors="pt",
            ).input_ids.to(self.device)
            with torch.no_grad():
                return p["text_encoder"](tokens).last_hidden_state

        cond_emb = _encode_text(positive)
        uncond_emb = _encode_text(negative)
        text_emb = torch.cat([uncond_emb, cond_emb], dim=0)

        # Encode the conditioning composite to latent space (4-ch).
        scaling = p["vae"].config.scaling_factor
        with torch.no_grad():
            cond_latent = p["vae"].encode(cond_img).latent_dist.mode() * scaling
        cond_latent_batched = torch.cat([cond_latent, cond_latent], dim=0)

        # Initialize noise (4-ch) at the same spatial size as the latent.
        generator = torch.Generator(device=self.device)
        if seed is not None:
            generator.manual_seed(int(seed))
        latents = torch.randn(
            cond_latent.shape,
            generator=generator,
            device=self.device,
            dtype=p["dtype"],
        )

        num_steps = 25
        guidance_scale = 2.0  # IC-Light is gentler than typical SD.
        p["scheduler"].set_timesteps(num_steps, device=self.device)
        latents = latents * p["scheduler"].init_noise_sigma

        for t in p["scheduler"].timesteps:
            latent_input = torch.cat([latents] * 2, dim=0)
            latent_input = p["scheduler"].scale_model_input(latent_input, t)
            unet_input = torch.cat([latent_input, cond_latent_batched], dim=1)
            with torch.no_grad():
                pred = p["unet"](
                    unet_input, t, encoder_hidden_states=text_emb,
                ).sample
            pred_uncond, pred_cond = pred.chunk(2)
            pred = pred_uncond + guidance_scale * (pred_cond - pred_uncond)
            latents = p["scheduler"].step(pred, t, latents).prev_sample

        # Decode latents back to pixel space.
        with torch.no_grad():
            decoded = p["vae"].decode(latents / scaling).sample
        decoded = (decoded.clamp(-1, 1) + 1.0) / 2.0
        out = decoded[0].permute(1, 2, 0).float().cpu().numpy()

        if (h_d, w_d) != (h_orig, w_orig):
            out = cv2.resize(out, (w_orig, h_orig), interpolation=cv2.INTER_LINEAR)

        return np.clip(out, 0.0, 1.0).astype(np.float32)
