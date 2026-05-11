# IC-Light Polish Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship an opt-in "Polish" pass that runs IC-Light diffusion refinement on top of the classical relighting render, exposed via a new `/polish` API route and a Polish button + Classical/Polished toggle + lightbox in the web playground.

**Architecture:** New `ICLightBackend` in `relighting_engine/polish/` mirrors the existing segmentation-backend lazy-load pattern. New `RelightingEngine.polish()` orchestrator re-runs the classical shader and feeds its output into IC-Light as the lighting condition. New `/polish` FastAPI route reuses `/render`'s schema base and PNG encoder. Frontend gates on a new `capabilities.polish` field returned by `/healthz`.

**Tech Stack:** Python 3.11 / PyTorch / diffusers / FastAPI / Pydantic / vanilla JS + WebGL2 / HTML / CSS.

**Reference spec:** `docs/superpowers/specs/2026-05-11-ic-light-polish-design.md`

---

## File Map

### Stage A — Engine

Create:
- `packages/relighting_engine/relighting_engine/polish/__init__.py`
- `packages/relighting_engine/relighting_engine/polish/prompts.py`
- `packages/relighting_engine/relighting_engine/polish/capabilities.py`
- `packages/relighting_engine/relighting_engine/polish/iclight.py`
- `packages/relighting_engine/tests/polish/__init__.py`
- `packages/relighting_engine/tests/polish/test_capabilities.py`
- `packages/relighting_engine/tests/polish/test_iclight_contract.py`
- `packages/relighting_engine/tests/polish/test_engine_polish.py`

Modify:
- `packages/relighting_engine/pyproject.toml` — add `diffusion` extra
- `packages/relighting_engine/relighting_engine/core/engine.py` — add `polish()` method

### Stage B — API

Create:
- `packages/relighting_api/relighting_api/routes/polish.py`
- `packages/relighting_api/relighting_api/routes/_encoding.py` (shared image encoder, extracted from `render.py`)
- `packages/relighting_api/tests/api/test_polish.py`
- `packages/relighting_api/tests/api/test_healthz_capabilities.py`

Modify:
- `packages/relighting_api/relighting_api/schemas.py` — extract `RenderCommon`, add `PolishRequest`, extend `HealthResponse`
- `packages/relighting_api/relighting_api/routes/render.py` — use shared `_encode`
- `packages/relighting_api/relighting_api/routes/health.py` — include capabilities block
- `packages/relighting_api/relighting_api/main.py` — register polish route + wire `app.state.capabilities`
- `packages/relighting_api/tests/api/conftest.py` — add `polish()` to `FakeEngine`

### Stage C — Frontend

Create:
- `web/src/polish.js`
- `web/src/polish-lightbox.js`

Modify:
- `web/src/api.js` — add `polishScene` + `getCapabilities`
- `web/src/main.js` — wire polish state, button, toggle, invalidation, capability gate
- `web/playground.html` — add Polish button, prompt input, classical/polished toggle, canvas expand icon, lightbox container
- `web/playground.css` — styles for the above + shimmer overlay

---

# Stage A — Engine

## Task 1: Add the `diffusion` optional install extra

**Files:**
- Modify: `packages/relighting_engine/pyproject.toml`

- [ ] **Step 1: Edit `pyproject.toml` to add the extra.**

In the `[project.optional-dependencies]` table, alongside the existing `test = [...]` entry, add:

```toml
diffusion = [
    "diffusers>=0.27,<1.0",
    "accelerate>=0.30",
    "safetensors>=0.4",
]
```

`transformers` is already a top-level dependency, so it is not duplicated here.

- [ ] **Step 2: Verify pyproject parses.**

Run: `python -c "import tomllib; tomllib.loads(open('packages/relighting_engine/pyproject.toml').read())"`

Expected: no output, exit code 0.

- [ ] **Step 3: Commit.**

```bash
git add packages/relighting_engine/pyproject.toml
git commit -m "feat(engine): add [diffusion] optional install extra for IC-Light"
```

---

## Task 2: Create polish module skeleton (`__init__.py`, `prompts.py`, `capabilities.py`)

**Files:**
- Create: `packages/relighting_engine/relighting_engine/polish/__init__.py`
- Create: `packages/relighting_engine/relighting_engine/polish/prompts.py`
- Create: `packages/relighting_engine/relighting_engine/polish/capabilities.py`
- Create: `packages/relighting_engine/tests/polish/__init__.py`
- Create: `packages/relighting_engine/tests/polish/test_capabilities.py`

- [ ] **Step 1: Write the failing test for `is_available()`.**

Create `packages/relighting_engine/tests/polish/__init__.py` as an empty file.

Create `packages/relighting_engine/tests/polish/test_capabilities.py`:

```python
"""Tests for polish.capabilities.is_available() — boolean GPU/import check."""
from __future__ import annotations

from unittest import mock

import pytest

from relighting_engine.polish import capabilities


def test_is_available_returns_bool():
    result = capabilities.is_available()
    assert isinstance(result, bool)


def test_is_available_false_when_diffusers_missing():
    with mock.patch.object(capabilities, "_diffusers_importable", return_value=False):
        assert capabilities.is_available() is False


def test_is_available_false_when_no_cuda():
    with mock.patch.object(capabilities, "_diffusers_importable", return_value=True), \
         mock.patch.object(capabilities, "_cuda_available", return_value=False):
        assert capabilities.is_available() is False


def test_is_available_false_when_vram_below_threshold():
    with mock.patch.object(capabilities, "_diffusers_importable", return_value=True), \
         mock.patch.object(capabilities, "_cuda_available", return_value=True), \
         mock.patch.object(capabilities, "_free_vram_bytes", return_value=4 * 1024**3):
        assert capabilities.is_available() is False


def test_is_available_true_when_all_checks_pass():
    with mock.patch.object(capabilities, "_diffusers_importable", return_value=True), \
         mock.patch.object(capabilities, "_cuda_available", return_value=True), \
         mock.patch.object(capabilities, "_free_vram_bytes", return_value=10 * 1024**3):
        assert capabilities.is_available() is True
```

- [ ] **Step 2: Run the test to verify it fails (import error).**

Run: `pytest packages/relighting_engine/tests/polish/test_capabilities.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'relighting_engine.polish'`.

- [ ] **Step 3: Create the package + capabilities module.**

Create `packages/relighting_engine/relighting_engine/polish/__init__.py`:

```python
"""IC-Light diffusion polish — optional refinement pass on top of the classical render."""
```

Create `packages/relighting_engine/relighting_engine/polish/prompts.py`:

```python
"""Default text prompts for IC-Light when the user leaves the prompt field empty."""

DEFAULT_PROMPT = (
    "professional photograph, photorealistic, soft natural lighting, "
    "highly detailed, sharp focus"
)

DEFAULT_NEGATIVE_PROMPT = (
    "lowres, blurry, jpeg artifacts, distorted, deformed, ugly, washed out, "
    "oversaturated, cartoon, illustration"
)
```

Create `packages/relighting_engine/relighting_engine/polish/capabilities.py`:

```python
"""Capability detection for IC-Light polish.

is_available() runs three independent checks and is monkeypatch-friendly:
the helper functions are module-level so tests can override them.
"""
from __future__ import annotations

# Minimum free VRAM to consider polish usable. IC-Light + SD1.5 peaks around
# 6 GB; we leave headroom so an in-flight depth/SAM2 inference can coexist.
MIN_FREE_VRAM_BYTES = 8 * 1024**3


def _diffusers_importable() -> bool:
    try:
        import diffusers  # noqa: F401
    except ImportError:
        return False
    return True


def _cuda_available() -> bool:
    try:
        import torch
    except ImportError:
        return False
    return bool(torch.cuda.is_available())


def _free_vram_bytes() -> int:
    try:
        import torch
        free, _total = torch.cuda.mem_get_info()
        return int(free)
    except Exception:  # noqa: BLE001 — defensive, any failure means "unknown"
        return 0


def is_available() -> bool:
    if not _diffusers_importable():
        return False
    if not _cuda_available():
        return False
    if _free_vram_bytes() < MIN_FREE_VRAM_BYTES:
        return False
    return True
```

- [ ] **Step 4: Run the test to verify it passes.**

Run: `pytest packages/relighting_engine/tests/polish/test_capabilities.py -v`
Expected: 5 PASS.

- [ ] **Step 5: Commit.**

```bash
git add packages/relighting_engine/relighting_engine/polish/__init__.py \
        packages/relighting_engine/relighting_engine/polish/prompts.py \
        packages/relighting_engine/relighting_engine/polish/capabilities.py \
        packages/relighting_engine/tests/polish/__init__.py \
        packages/relighting_engine/tests/polish/test_capabilities.py
git commit -m "feat(engine): add polish module skeleton with capability detection"
```

---

## Task 3: `ICLightBackend` class + interface contract test

**Files:**
- Create: `packages/relighting_engine/relighting_engine/polish/iclight.py`
- Create: `packages/relighting_engine/tests/polish/test_iclight_contract.py`

This task creates the `ICLightBackend` class with its constructor and `polish()` signature, plus a contract test that asserts the return type/shape. The actual diffusion inference is filled in by Task 4 — for now `polish()` raises `NotImplementedError` and the contract test runs only against the type signature using `inspect`.

- [ ] **Step 1: Write the contract test (signature + import).**

Create `packages/relighting_engine/tests/polish/test_iclight_contract.py`:

```python
"""ICLightBackend interface contract: class exists, has the expected method
signature, and a GPU-gated smoke test that runs only when the diffusion
extra is installed and a GPU is available."""
from __future__ import annotations

import inspect

import numpy as np
import pytest

from relighting_engine.polish.iclight import ICLightBackend


def test_iclight_backend_class_exists():
    assert inspect.isclass(ICLightBackend)


def test_iclight_polish_signature():
    sig = inspect.signature(ICLightBackend.polish)
    params = list(sig.parameters.keys())
    # self, classical_render, foreground_rgba, prompt, *, seed
    assert params[:4] == ["self", "classical_render", "foreground_rgba", "prompt"]
    assert "seed" in sig.parameters
    assert sig.parameters["seed"].kind == inspect.Parameter.KEYWORD_ONLY


def _has_gpu_and_weights() -> bool:
    """True iff we can actually run IC-Light end-to-end on this machine."""
    from relighting_engine.polish.capabilities import is_available
    return is_available()


@pytest.mark.skipif(not _has_gpu_and_weights(),
                    reason="IC-Light smoke test requires GPU + [diffusion] extra")
def test_iclight_smoke_256():
    """End-to-end smoke: feed a 256x256 image and assert shape/dtype/range.

    Output values are NOT compared — diffusion is not byte-stable across
    torch/cudnn versions. Quality validation is by-eye during development.
    """
    backend = ICLightBackend(device="cuda")
    classical = np.full((256, 256, 3), 0.5, dtype=np.float32)
    fg_rgba = np.zeros((256, 256, 4), dtype=np.float32)
    fg_rgba[..., :3] = 0.5
    fg_rgba[..., 3] = 1.0
    out = backend.polish(classical, fg_rgba, prompt="", seed=42)
    assert out.shape == (256, 256, 3)
    assert out.dtype == np.float32
    assert float(out.min()) >= 0.0
    assert float(out.max()) <= 1.0
```

- [ ] **Step 2: Run the test to verify it fails (no `iclight` module).**

Run: `pytest packages/relighting_engine/tests/polish/test_iclight_contract.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'relighting_engine.polish.iclight'`.

- [ ] **Step 3: Create the skeleton `iclight.py`.**

Create `packages/relighting_engine/relighting_engine/polish/iclight.py`:

```python
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
```

- [ ] **Step 4: Run the test to verify the contract tests pass.**

Run: `pytest packages/relighting_engine/tests/polish/test_iclight_contract.py -v`
Expected: `test_iclight_backend_class_exists` PASS, `test_iclight_polish_signature` PASS, `test_iclight_smoke_256` either PASS or SKIPPED depending on the machine. On a CPU-only dev box it will be SKIPPED.

- [ ] **Step 5: Commit.**

```bash
git add packages/relighting_engine/relighting_engine/polish/iclight.py \
        packages/relighting_engine/tests/polish/test_iclight_contract.py
git commit -m "feat(engine): add ICLightBackend skeleton with contract test"
```

---

## Task 4: Implement IC-Light inference inside `ICLightBackend.polish()`

**Files:**
- Modify: `packages/relighting_engine/relighting_engine/polish/iclight.py`

This is the only task that depends on machine state (GPU + weights). The smoke test from Task 3 (`test_iclight_smoke_256`) gates this work: once it passes on a GPU box, the task is done.

**Reference implementation:** https://github.com/lllyasviel/IC-Light — specifically `gradio_demo.py` for the fc-with-light-condition workflow. The model card is at https://huggingface.co/lllyasviel/ic-light. We use the `iclight_sd15_fc.safetensors` weights on top of a Stable Diffusion 1.5 base, with the UNet's `conv_in` patched from 4 to 8 input channels (4 channels of noise + 4 channels of VAE-encoded conditioning).

**Resolution note:** SD1.5 base is 512×512 native. The first implementation runs at min(input, 768)×min(input, 768) and bilinearly resizes back up to the input HxW after decoding. Tiled diffusion is out of scope for v1 (deferred in the spec).

- [ ] **Step 1: Write the model-loading helper.**

Edit `iclight.py` — add a private `_load()` method and update `polish()` to call it lazily. Replace the placeholder body with the real loader:

```python
"""IC-Light diffusion polish backend.

Lazy model loading mirrors the segmentation backends (RMBG, SAM2): the
constructor stores config only, weights are downloaded and moved to GPU
on the first call to polish(). The weights stay resident afterwards so
subsequent polishes within the same process pay only the inference cost.
"""
from __future__ import annotations

from typing import Optional

import numpy as np

from relighting_engine.polish.prompts import DEFAULT_PROMPT, DEFAULT_NEGATIVE_PROMPT

# Resolution at which diffusion actually runs. SD1.5 is trained at 512;
# IC-Light works well up to 768. Anything larger is bilinearly upsampled
# after decoding rather than tiled.
_DIFFUSION_RES_MAX = 768

# HuggingFace repo IDs.
_SD15_REPO = "runwayml/stable-diffusion-v1-5"
_ICLIGHT_REPO = "lllyasviel/ic-light"
_ICLIGHT_FILENAME = "iclight_sd15_fc.safetensors"


class ICLightBackend:
    def __init__(self, device: str = "cuda"):
        self.device = device
        self._pipe = None

    def _load(self):
        """Build the patched SD1.5 + IC-Light pipeline.

        Mirrors lllyasviel/IC-Light's gradio_demo.py setup:
          1. Load SD1.5 components (VAE, text encoder, tokenizer, UNet, scheduler).
          2. Replace UNet's conv_in with a Conv2d(8, 320, 3, 1, 1) — IC-Light
             feeds VAE-encoded conditioning concatenated with noise.
          3. Load iclight_sd15_fc.safetensors into the patched UNet.
          4. Build a StableDiffusionImg2ImgPipeline-like wrapper. We don't use
             the high-level pipeline directly because IC-Light requires the
             concat-conditioning hook on conv_in.
        """
        if self._pipe is not None:
            return
        import torch
        from diffusers import AutoencoderKL, UNet2DConditionModel, DPMSolverMultistepScheduler
        from transformers import CLIPTextModel, CLIPTokenizer
        from huggingface_hub import hf_hub_download
        from safetensors.torch import load_file

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

        # Patch conv_in: 4 -> 8 input channels.
        with torch.no_grad():
            new_conv_in = torch.nn.Conv2d(
                8, unet.conv_in.out_channels,
                kernel_size=unet.conv_in.kernel_size,
                padding=unet.conv_in.padding,
            ).to(device=self.device, dtype=dtype)
            new_conv_in.weight.zero_()
            new_conv_in.weight[:, :4, :, :].copy_(unet.conv_in.weight)
            new_conv_in.bias.copy_(unet.conv_in.bias)
            unet.conv_in = new_conv_in
        unet.config.in_channels = 8

        # Apply IC-Light fc patch on top of the patched UNet.
        weights_path = hf_hub_download(repo_id=_ICLIGHT_REPO, filename=_ICLIGHT_FILENAME)
        state_dict = load_file(weights_path)
        unet.load_state_dict(state_dict, strict=False)

        scheduler = DPMSolverMultistepScheduler.from_pretrained(
            _SD15_REPO, subfolder="scheduler",
        )

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
        import torch

        self._load()
        p = self._pipe
        h_orig, w_orig = classical_render.shape[:2]

        # Resolve effective text prompts.
        positive = prompt.strip() if prompt and prompt.strip() else DEFAULT_PROMPT
        negative = DEFAULT_NEGATIVE_PROMPT

        # Downscale to diffusion resolution (multiple of 64 for SD UNet).
        scale = min(_DIFFUSION_RES_MAX / max(h_orig, w_orig), 1.0)
        h_d = int(round(h_orig * scale / 64)) * 64
        w_d = int(round(w_orig * scale / 64)) * 64
        h_d = max(h_d, 64)
        w_d = max(w_d, 64)

        # Resize inputs into diffusion res.
        import cv2
        classical_d = cv2.resize(classical_render, (w_d, h_d), interpolation=cv2.INTER_LINEAR)
        fg_d = cv2.resize(foreground_rgba, (w_d, h_d), interpolation=cv2.INTER_LINEAR)

        # Build the conditioning composite: subject composited on classical render.
        alpha = fg_d[..., 3:4]
        composite = fg_d[..., :3] * alpha + classical_d * (1.0 - alpha)
        cond_img = torch.from_numpy(composite).permute(2, 0, 1).unsqueeze(0).to(
            self.device, dtype=p["dtype"]
        )
        cond_img = cond_img * 2.0 - 1.0  # [0,1] -> [-1,1] for VAE.

        # Encode text prompts.
        def _encode_text(text: str):
            tokens = p["tokenizer"](
                text, padding="max_length", max_length=77, truncation=True,
                return_tensors="pt",
            ).input_ids.to(self.device)
            return p["text_encoder"](tokens).last_hidden_state

        cond_emb = _encode_text(positive)
        uncond_emb = _encode_text(negative)

        # Encode the conditioning composite to latent space (4-ch).
        with torch.no_grad():
            cond_latent = p["vae"].encode(cond_img).latent_dist.mode() * 0.18215

        # Initialize noise (4-ch) at the same spatial size as the latent.
        generator = torch.Generator(device=self.device)
        if seed is not None:
            generator.manual_seed(int(seed))
        noise = torch.randn(
            cond_latent.shape, generator=generator,
            device=self.device, dtype=p["dtype"],
        )

        # Set scheduler + sampling loop.
        num_steps = 25
        guidance_scale = 2.0  # IC-Light is gentler than typical SD.
        p["scheduler"].set_timesteps(num_steps, device=self.device)
        latents = noise

        for t in p["scheduler"].timesteps:
            latent_in_cond = torch.cat([latents, cond_latent], dim=1)
            latent_in_uncond = torch.cat([latents, torch.zeros_like(cond_latent)], dim=1)
            with torch.no_grad():
                pred_cond = p["unet"](
                    latent_in_cond, t, encoder_hidden_states=cond_emb,
                ).sample
                pred_uncond = p["unet"](
                    latent_in_uncond, t, encoder_hidden_states=uncond_emb,
                ).sample
            pred = pred_uncond + guidance_scale * (pred_cond - pred_uncond)
            latents = p["scheduler"].step(pred, t, latents).prev_sample

        # Decode latents back to pixel space.
        with torch.no_grad():
            decoded = p["vae"].decode(latents / 0.18215).sample
        decoded = (decoded.clamp(-1, 1) + 1.0) / 2.0
        out = decoded[0].permute(1, 2, 0).float().cpu().numpy()  # HxWx3 in [0,1]

        # Resize back to the original resolution.
        if (h_d, w_d) != (h_orig, w_orig):
            out = cv2.resize(out, (w_orig, h_orig), interpolation=cv2.INTER_LINEAR)

        return np.clip(out, 0.0, 1.0).astype(np.float32)
```

- [ ] **Step 2: Run the smoke test on a GPU box.**

Run: `pytest packages/relighting_engine/tests/polish/test_iclight_contract.py::test_iclight_smoke_256 -v`

Expected on a GPU box with `[diffusion]` installed: PASS (first run will take 60–180s for weight download). Expected on a CPU-only machine: SKIPPED.

If the test fails with diffusers version incompatibilities (`AttributeError` on `latent_dist`, `encoder_hidden_states`, etc.), pin the diffusers version in `pyproject.toml` (Task 1) more tightly. The lllyasviel IC-Light reference uses `diffusers==0.27.2`; if anything later diverges, lock to that.

- [ ] **Step 3: Manual quality check (by eye).**

Spin up a Python REPL and run:

```python
import numpy as np, imageio.v3 as iio
from relighting_engine.polish.iclight import ICLightBackend
backend = ICLightBackend(device="cuda")
classical = iio.imread("packages/relighting_engine/tests/fixtures/expected/portrait_a__key_plus_fill.png").astype(np.float32) / 255.0
fg = np.concatenate([classical, np.ones((*classical.shape[:2], 1), dtype=np.float32)], axis=-1)
out = backend.polish(classical, fg, prompt="warm cinematic lighting", seed=0)
iio.imwrite("scripts/polish_smoke.png", (out * 255).astype(np.uint8))
```

Open `scripts/polish_smoke.png` and confirm it looks like a coherent photograph (not noise). This is the only quality gate. If the output is noise, debug before committing.

- [ ] **Step 4: Commit.**

```bash
git add packages/relighting_engine/relighting_engine/polish/iclight.py
git commit -m "feat(engine): implement IC-Light fc-variant polish inference"
```

---

## Task 5: `RelightingEngine.polish()` orchestrator method

**Files:**
- Modify: `packages/relighting_engine/relighting_engine/core/engine.py`
- Create: `packages/relighting_engine/tests/polish/test_engine_polish.py`

This task adds the engine-level `polish()` that:
1. Re-runs the classical shader on the prepared image + lights.
2. Builds a foreground-RGBA composite from `prepared.original` + `prepared.mask`.
3. Hands both to a lazy `ICLightBackend` instance (via a new `_get_polisher()` accessor that mirrors `_get_segmenter()`).

The test injects a fake polisher that captures its inputs, so the real IC-Light model is never touched in CI.

- [ ] **Step 1: Write the failing engine test.**

Create `packages/relighting_engine/tests/polish/test_engine_polish.py`:

```python
"""Engine-level polish() orchestration test.

Uses a FakeICLightBackend that records its inputs and returns a deterministic
image, so the test runs without a GPU or model weights.
"""
from __future__ import annotations

import numpy as np
import pytest

from relighting_engine.core.engine import RelightingEngine
from relighting_engine.core.prepared import PreparedImage
from relighting_engine.lighting.models import Light


class FakeICLightBackend:
    def __init__(self, device: str = "cuda"):
        self.device = device
        self.calls = []

    def polish(self, classical_render, foreground_rgba, prompt, *, seed=None):
        self.calls.append({
            "classical_shape": classical_render.shape,
            "fg_shape": foreground_rgba.shape,
            "prompt": prompt,
            "seed": seed,
        })
        h, w = classical_render.shape[:2]
        return np.full((h, w, 3), 0.7, dtype=np.float32)


def _fake_prepared(w=64, h=64) -> PreparedImage:
    img = np.full((h, w, 3), 0.5, dtype=np.float32)
    mask = np.zeros((h, w), dtype=np.float32)
    mask[h // 4: 3 * h // 4, w // 4: 3 * w // 4] = 1.0
    return PreparedImage(
        original=img,
        depth=np.full((h, w), 0.5, dtype=np.float32),
        normals=np.tile(np.array([0.0, 0.0, 1.0], dtype=np.float32), (h, w, 1)),
        mask=mask,
        width=w,
        height=h,
        metadata={"depth_model": "fake", "seg_model": "fake", "prep_ms": 0,
                  "subject_median_depth": 0.5},
    )


@pytest.fixture
def engine_with_fake_polisher(monkeypatch):
    """Construct an engine and monkeypatch its polisher accessor."""
    # Skip the heavy depth-anything init in the constructor.
    monkeypatch.setattr(
        "relighting_engine.depth.depth_anything.DepthAnythingBackend.__init__",
        lambda self, device="cuda": None,
    )
    import torch
    monkeypatch.setattr(torch.cuda, "is_available", lambda: True)

    eng = RelightingEngine(device="cpu")
    fake = FakeICLightBackend(device="cpu")
    monkeypatch.setattr(eng, "_get_polisher", lambda: fake)
    return eng, fake


def test_engine_polish_returns_image_of_prepared_size(engine_with_fake_polisher):
    eng, fake = engine_with_fake_polisher
    prepared = _fake_prepared()
    out = eng.polish(prepared, lights=[], ambient=0.2, shadow_style="off")
    assert out.shape == (prepared.height, prepared.width, 3)
    assert out.dtype == np.float32


def test_engine_polish_forwards_prompt_and_seed(engine_with_fake_polisher):
    eng, fake = engine_with_fake_polisher
    prepared = _fake_prepared()
    eng.polish(prepared, lights=[], ambient=0.2, shadow_style="off",
               prompt="golden hour", seed=42)
    assert fake.calls[-1]["prompt"] == "golden hour"
    assert fake.calls[-1]["seed"] == 42


def test_engine_polish_uses_mask_for_foreground_alpha(engine_with_fake_polisher):
    eng, fake = engine_with_fake_polisher
    prepared = _fake_prepared(w=64, h=64)
    eng.polish(prepared, lights=[], ambient=0.2, shadow_style="off")
    fg_shape = fake.calls[-1]["fg_shape"]
    assert fg_shape == (64, 64, 4)


def test_engine_polish_respects_output_resolution(engine_with_fake_polisher):
    eng, fake = engine_with_fake_polisher
    prepared = _fake_prepared(w=64, h=64)
    out = eng.polish(prepared, lights=[], ambient=0.2, shadow_style="off",
                     output_resolution=(128, 96))
    assert out.shape == (96, 128, 3)
```

- [ ] **Step 2: Run the test to verify it fails.**

Run: `pytest packages/relighting_engine/tests/polish/test_engine_polish.py -v`
Expected: FAIL with `AttributeError: 'RelightingEngine' object has no attribute '_get_polisher'` (or similar — the method doesn't exist yet).

- [ ] **Step 3: Implement `polish()` and `_get_polisher()` on `RelightingEngine`.**

Edit `packages/relighting_engine/relighting_engine/core/engine.py`:

Add new imports at the top of the file (alongside the existing segmentation imports):

```python
from relighting_engine.polish.iclight import ICLightBackend
```

Add a new instance field at the end of `__init__` (after `self._gobo_textures = None`):

```python
        self._polisher: ICLightBackend | None = None
```

Add a new method beneath `_get_segmenter()`:

```python
    def _get_polisher(self) -> ICLightBackend:
        """Lazy-init the IC-Light backend. First call downloads weights."""
        if self._polisher is None:
            self._polisher = ICLightBackend(device=self.device)
        return self._polisher
```

Add the public `polish()` method at the end of the class (after `render()`):

```python
    def polish(
        self,
        prepared: PreparedImage,
        lights: Sequence[Light],
        *,
        ambient: float = 0.2,
        shadow_style: str = "off",
        prompt: str = "",
        seed: int | None = None,
        output_resolution: tuple[int, int] | None = None,
    ) -> np.ndarray:
        """Run the classical render, then refine with IC-Light.

        Returns HxWx3 float32 linear-sRGB in [0,1]. Output dimensions match
        prepared.height × prepared.width unless output_resolution is given.
        """
        # 1. Classical render — same call the /render route makes.
        classical = self.render(
            prepared, lights, ambient=ambient,
            output_resolution=None, shadow_style=shadow_style,
        )

        # 2. Compose foreground RGBA. The alpha channel is prepared.mask if
        # present, otherwise a fully-opaque field (IC-Light treats the
        # composite uniformly when there's no subject).
        h, w = prepared.height, prepared.width
        if prepared.mask is not None:
            alpha = prepared.mask.astype(np.float32)
        else:
            alpha = np.ones((h, w), dtype=np.float32)
        fg_rgba = np.concatenate(
            [prepared.original.astype(np.float32), alpha[..., None]],
            axis=-1,
        )

        # 3. Run the polisher.
        polisher = self._get_polisher()
        out = polisher.polish(classical, fg_rgba, prompt=prompt, seed=seed)

        # 4. Optional output resize.
        if output_resolution is not None:
            import cv2
            tw, th = output_resolution
            out = cv2.resize(out, (tw, th), interpolation=cv2.INTER_LINEAR)
        return out
```

- [ ] **Step 4: Run the test to verify it passes.**

Run: `pytest packages/relighting_engine/tests/polish/test_engine_polish.py -v`
Expected: 4 PASS.

- [ ] **Step 5: Run the full engine test suite to confirm no regressions.**

Run: `pytest packages/relighting_engine/tests -x`
Expected: All previously-passing tests still pass.

- [ ] **Step 6: Commit.**

```bash
git add packages/relighting_engine/relighting_engine/core/engine.py \
        packages/relighting_engine/tests/polish/test_engine_polish.py
git commit -m "feat(engine): add RelightingEngine.polish() orchestrator method"
```

---

# Stage B — API

## Task 6: Extract `RenderCommon` base schema + add `PolishRequest`

**Files:**
- Modify: `packages/relighting_api/relighting_api/schemas.py`

The existing `RenderRequest` and the new `PolishRequest` share most fields. We extract a `RenderCommon` base model, both subclass it. This is a refactor for `RenderRequest` (no behavior change) plus an addition (`PolishRequest`).

- [ ] **Step 1: Write the failing schema tests.**

Add tests at the bottom of `packages/relighting_api/tests/api/test_prepare.py` — actually, create a new file dedicated to schema unit tests since prepare's tests don't cover schema details:

Create `packages/relighting_api/tests/api/test_schemas.py`:

```python
"""Schema unit tests for RenderRequest/PolishRequest sharing RenderCommon."""
from __future__ import annotations

import pytest

from relighting_api.schemas import PolishRequest, RenderRequest


def test_render_request_still_accepts_existing_fields():
    req = RenderRequest(
        session_id="abc",
        lights=[],
        ambient=0.3,
        shadow_style="planar",
        output_format="png",
        output_bit_depth=8,
        output_resolution=[512, 512],
    )
    assert req.ambient == 0.3
    assert req.shadow_style == "planar"
    assert req.output_resolution == [512, 512]


def test_polish_request_minimal_construction():
    req = PolishRequest(session_id="abc", lights=[])
    assert req.session_id == "abc"
    assert req.prompt == ""
    assert req.seed is None
    assert req.ambient == 0.2
    assert req.shadow_style == "off"
    assert req.output_format == "png"
    assert req.output_bit_depth == 8


def test_polish_request_accepts_prompt_and_seed():
    req = PolishRequest(
        session_id="abc", lights=[], prompt="warm sunset", seed=42,
    )
    assert req.prompt == "warm sunset"
    assert req.seed == 42


def test_polish_request_validates_format_bitdepth():
    with pytest.raises(Exception):
        PolishRequest(session_id="abc", lights=[],
                      output_format="jpeg", output_bit_depth=16)
```

- [ ] **Step 2: Run the tests to verify they fail.**

Run: `pytest packages/relighting_api/tests/api/test_schemas.py -v`
Expected: FAIL with `ImportError: cannot import name 'PolishRequest' from 'relighting_api.schemas'`.

- [ ] **Step 3: Edit `schemas.py` to introduce `RenderCommon` and `PolishRequest`.**

Replace the `RenderRequest` class in `packages/relighting_api/relighting_api/schemas.py` with the following two classes (insert before the existing `GoboPreset` class). Delete the old `RenderRequest` body — it is replaced.

```python
class RenderCommon(BaseModel):
    """Shared base for /render and /polish — lights, ambient, shadow, output format."""
    session_id: str
    lights: list[LightModel] = Field(default_factory=list)
    ambient: Annotated[float, Field(ge=0.0)] = 0.2
    shadow_style: Literal["off", "heightfield", "planar"] = "off"
    output_format: Literal["png", "jpeg", "tiff"] = "png"
    output_bit_depth: Literal[8, 16, 32] = 8
    output_resolution: list[int] | None = None

    @model_validator(mode="after")
    def _validate_format_bitdepth(self) -> "RenderCommon":
        if self.output_format == "jpeg" and self.output_bit_depth != 8:
            raise ValueError("JPEG supports 8-bit only")
        if self.output_format == "png" and self.output_bit_depth not in (8, 16):
            raise ValueError("PNG supports 8 or 16-bit only")
        if self.output_format == "tiff" and self.output_bit_depth not in (8, 16, 32):
            raise ValueError("TIFF supports 8, 16, or 32-bit float")
        if self.output_resolution is not None and len(self.output_resolution) != 2:
            raise ValueError("output_resolution must be [w, h]")
        return self


class RenderRequest(RenderCommon):
    """POST /render body. No additional fields beyond RenderCommon today."""


class PolishRequest(RenderCommon):
    """POST /polish body — adds optional prompt + seed."""
    prompt: str = ""
    seed: int | None = None
```

- [ ] **Step 4: Run the schema tests.**

Run: `pytest packages/relighting_api/tests/api/test_schemas.py -v`
Expected: 4 PASS.

- [ ] **Step 5: Run the full API test suite to confirm `RenderRequest` consumers still work.**

Run: `pytest packages/relighting_api/tests -x`
Expected: All previously-passing tests still pass.

- [ ] **Step 6: Commit.**

```bash
git add packages/relighting_api/relighting_api/schemas.py \
        packages/relighting_api/tests/api/test_schemas.py
git commit -m "refactor(api): extract RenderCommon base, add PolishRequest schema"
```

---

## Task 7: Extract shared `_encode` image-encoder helper

**Files:**
- Create: `packages/relighting_api/relighting_api/routes/_encoding.py`
- Modify: `packages/relighting_api/relighting_api/routes/render.py`

The `_encode` and `_srgb_icc` helpers in `render.py` will be reused by the new `/polish` route. Move them into a shared module so both routes import the same code.

- [ ] **Step 1: Create the shared `_encoding.py` module.**

Create `packages/relighting_api/relighting_api/routes/_encoding.py` — copy the existing `_encode`, `_srgb_icc`, and `CONTENT_TYPES` from `render.py` verbatim:

```python
"""Shared image encoder for /render and /polish.

Encodes a HxWx3 float32 linear-sRGB array into PNG/JPEG/TIFF bytes with an
embedded sRGB ICC profile (8-bit PNG/JPEG only — 16-bit PNG goes through cv2
which doesn't write ICC).
"""
from __future__ import annotations

import io

import numpy as np

from relighting_engine.core.io import _linear_to_srgb

CONTENT_TYPES = {"png": "image/png", "jpeg": "image/jpeg", "tiff": "image/tiff"}


def encode(arr: np.ndarray, buf: io.BytesIO, *, fmt: str, bit_depth: int) -> None:
    from PIL import Image, PngImagePlugin
    import imageio.v3 as iio

    if bit_depth == 32:
        iio.imwrite(buf, np.clip(arr, 0, 1).astype(np.float32), extension=".tiff")
        return
    srgb = _linear_to_srgb(arr)
    if bit_depth == 16:
        u = np.clip(srgb * 65535 + 0.5, 0, 65535).astype(np.uint16)
    else:
        u = np.clip(srgb * 255 + 0.5, 0, 255).astype(np.uint8)
    if fmt == "jpeg":
        Image.fromarray(u).save(buf, format="JPEG", quality=95, icc_profile=srgb_icc())
    elif fmt == "png":
        if bit_depth == 16:
            import cv2
            bgr = cv2.cvtColor(u, cv2.COLOR_RGB2BGR)
            ok, png_bytes = cv2.imencode(".png", bgr)
            if not ok:
                raise RuntimeError("cv2 failed to encode 16-bit PNG")
            buf.write(png_bytes.tobytes())
        else:
            pnginfo = PngImagePlugin.PngInfo()
            pnginfo.add(b"sRGB", b"\x00")
            Image.fromarray(u).save(
                buf, format="PNG", pnginfo=pnginfo, icc_profile=srgb_icc()
            )
    elif fmt == "tiff":
        iio.imwrite(buf, u, extension=".tiff")


def srgb_icc() -> bytes:
    cached = getattr(srgb_icc, "_bytes", None)
    if cached is not None:
        return cached
    from PIL import ImageCms
    profile = ImageCms.createProfile("sRGB")
    data = ImageCms.ImageCmsProfile(profile).tobytes()
    srgb_icc._bytes = data
    return data
```

- [ ] **Step 2: Update `render.py` to import from the shared module.**

Edit `packages/relighting_api/relighting_api/routes/render.py`:

- Remove the local `_encode`, `_srgb_icc`, and `CONTENT_TYPES` definitions (lines ~15 and ~50–101).
- Add at the top alongside other imports: `from relighting_api.routes._encoding import CONTENT_TYPES, encode`.
- Update the call site `_encode(arr, buf, ...)` inside the route handler to `encode(arr, buf, ...)`.

The resulting `render.py` should be substantially shorter — the file just calls `engine.render()`, encodes via the shared helper, and returns the bytes.

- [ ] **Step 3: Run the full API test suite to verify no regressions.**

Run: `pytest packages/relighting_api/tests -x`
Expected: All tests pass — `/render` behavior is unchanged.

- [ ] **Step 4: Commit.**

```bash
git add packages/relighting_api/relighting_api/routes/_encoding.py \
        packages/relighting_api/relighting_api/routes/render.py
git commit -m "refactor(api): extract shared image-encoder helper module"
```

---

## Task 8: Add `polish()` to `FakeEngine` + write `/polish` route tests

**Files:**
- Modify: `packages/relighting_api/tests/api/conftest.py`
- Create: `packages/relighting_api/tests/api/test_polish.py`

We write the tests against a FakeEngine first (TDD), then implement the route in Task 9.

- [ ] **Step 1: Extend `FakeEngine` with `polish()`.**

Edit `packages/relighting_api/tests/api/conftest.py` — add a `polish()` method to `FakeEngine` alongside `render()`:

```python
    def polish(
        self, prepared, lights, *, ambient=0.2, shadow_style="off",
        prompt="", seed=None, output_resolution=None,
    ) -> np.ndarray:
        self.last_lights = list(lights)
        self.last_ambient = ambient
        self.last_shadow_style = shadow_style
        self.last_prompt = prompt
        self.last_seed = seed
        h = output_resolution[1] if output_resolution else prepared.height
        w = output_resolution[0] if output_resolution else prepared.width
        return np.full((h, w, 3), 0.7, dtype=np.float32)
```

Also add a class field for test injection of OOM / unavailable behavior:

```python
class FakeEngine:
    def __init__(self) -> None:
        self.last_lights: list = []
        self.last_ambient: float = 0.0
        self.polish_raises: Exception | None = None  # tests can set this to force errors
```

And update `polish()` to honor it:

```python
    def polish(
        self, prepared, lights, *, ambient=0.2, shadow_style="off",
        prompt="", seed=None, output_resolution=None,
    ) -> np.ndarray:
        if self.polish_raises is not None:
            raise self.polish_raises
        self.last_lights = list(lights)
        self.last_ambient = ambient
        self.last_shadow_style = shadow_style
        self.last_prompt = prompt
        self.last_seed = seed
        h = output_resolution[1] if output_resolution else prepared.height
        w = output_resolution[0] if output_resolution else prepared.width
        return np.full((h, w, 3), 0.7, dtype=np.float32)
```

- [ ] **Step 2: Write the route tests.**

Create `packages/relighting_api/tests/api/test_polish.py`:

```python
"""Tests for POST /polish — happy path, errors, capability gating."""
from __future__ import annotations

import numpy as np
import pytest
import torch
from fastapi.testclient import TestClient

from relighting_api.main import create_app
from relighting_engine.core.prepared import PreparedImage

from tests.api.conftest import FakeEngine


@pytest.fixture
def client_with_session(tmp_path, monkeypatch):
    """App + fake engine + a pre-populated session named 'sess-1'."""
    monkeypatch.setenv("RELIGHT_CACHE_DIR", str(tmp_path / "sessions"))
    monkeypatch.setenv("RELIGHT_SCENES_DB", str(tmp_path / "scenes.db"))
    app = create_app(skip_engine=True)
    fake = FakeEngine()
    app.state.engine = fake
    app.state.capabilities = {"polish": True, "segmenters": ["rmbg"]}

    # Inject a prepared image into the session store. SessionStore._mem is a
    # dict of (PreparedImage, timestamp) tuples — see session_store.py.
    import time
    prepared = PreparedImage(
        original=np.full((32, 32, 3), 0.5, dtype=np.float32),
        depth=np.full((32, 32), 0.5, dtype=np.float32),
        normals=np.tile(np.array([0.0, 0.0, 1.0], dtype=np.float32), (32, 32, 1)),
        mask=None,
        width=32,
        height=32,
        metadata={"depth_model": "fake", "seg_model": "fake", "prep_ms": 0,
                  "subject_median_depth": 0.5},
    )
    app.state.sessions._mem["sess-1"] = (prepared, time.monotonic())
    return TestClient(app), fake


def test_polish_happy_path_returns_png(client_with_session):
    client, fake = client_with_session
    r = client.post("/polish", json={"session_id": "sess-1", "lights": []})
    assert r.status_code == 200
    assert r.headers["content-type"] == "image/png"
    assert len(r.content) > 100  # actually returned bytes


def test_polish_forwards_prompt_and_seed(client_with_session):
    client, fake = client_with_session
    r = client.post("/polish", json={
        "session_id": "sess-1", "lights": [],
        "prompt": "golden hour", "seed": 7,
    })
    assert r.status_code == 200
    assert fake.last_prompt == "golden hour"
    assert fake.last_seed == 7


def test_polish_unknown_session_404(client_with_session):
    client, _ = client_with_session
    r = client.post("/polish", json={"session_id": "nope", "lights": []})
    assert r.status_code == 404


def test_polish_invalid_lights_422(client_with_session):
    client, _ = client_with_session
    r = client.post("/polish", json={
        "session_id": "sess-1",
        "lights": [{"type": "not-a-real-type"}],
    })
    assert r.status_code == 422


def test_polish_oom_503_with_retry_after(client_with_session):
    client, fake = client_with_session
    fake.polish_raises = torch.cuda.OutOfMemoryError("OOM")
    r = client.post("/polish", json={"session_id": "sess-1", "lights": []})
    assert r.status_code == 503
    assert r.headers.get("Retry-After") == "30"


def test_polish_capability_disabled_501(client_with_session):
    client, _ = client_with_session
    client.app.state.capabilities["polish"] = False
    r = client.post("/polish", json={"session_id": "sess-1", "lights": []})
    assert r.status_code == 501
    assert "polish unavailable" in r.json()["detail"].lower()


def test_polish_lock_contention_409(client_with_session):
    """Second concurrent polish on the same session returns 409.

    We can't easily hold an asyncio.Lock across the sync TestClient boundary,
    so we substitute the session's lock with one whose .locked() reports True.
    The route only consults .locked() before deciding to 409, so this
    accurately exercises the contention branch.
    """
    client, _ = client_with_session
    sessions = client.app.state.sessions

    class _PreLocked:
        def locked(self): return True
        async def __aenter__(self): raise AssertionError("should not enter")
        async def __aexit__(self, *exc): return False

    sessions._locks["sess-1"] = _PreLocked()
    r = client.post("/polish", json={"session_id": "sess-1", "lights": []})
    assert r.status_code == 409
```

- [ ] **Step 3: Run the tests to verify they fail.**

Run: `pytest packages/relighting_api/tests/api/test_polish.py -v`
Expected: FAIL — no `/polish` route registered yet, all tests return 404 or import errors.

- [ ] **Step 4: Commit the tests + FakeEngine extension.**

```bash
git add packages/relighting_api/tests/api/conftest.py \
        packages/relighting_api/tests/api/test_polish.py
git commit -m "test(api): add /polish route tests + FakeEngine.polish stub"
```

---

## Task 9: Implement the `/polish` route

**Files:**
- Create: `packages/relighting_api/relighting_api/routes/polish.py`

- [ ] **Step 1: Implement the route.**

Create `packages/relighting_api/relighting_api/routes/polish.py`:

```python
"""POST /polish — diffusion-refined render via IC-Light.

Mirrors /render's interface but routes through the engine's polish() method.
Long-running (5–15s typical); enforces single-in-flight per session via the
existing session lock and returns 409 on contention.
"""
from __future__ import annotations

import io

import numpy as np
import torch
from fastapi import APIRouter, HTTPException, Request, Response

from relighting_api.routes._encoding import CONTENT_TYPES, encode
from relighting_api.schemas import PolishRequest

router = APIRouter()


@router.post("/polish")
async def polish(req: PolishRequest, request: Request) -> Response:
    capabilities = getattr(request.app.state, "capabilities", {})
    if not capabilities.get("polish", False):
        raise HTTPException(status_code=501, detail="polish unavailable")

    sessions = request.app.state.sessions
    prepared = sessions.get(req.session_id)
    if prepared is None:
        raise HTTPException(status_code=404, detail="unknown session_id")

    try:
        lights = [l.to_engine() for l in req.lights]
    except Exception as e:  # noqa: BLE001
        raise HTTPException(status_code=422, detail=str(e)) from e

    engine = getattr(request.app.state, "engine", None)
    if engine is None:
        from relighting_api.deps import get_engine
        engine = get_engine()

    # 409 on contention: if the lock is held by another in-flight request for
    # this session, return immediately rather than blocking.
    lock = sessions.lock(req.session_id)
    if lock.locked():
        raise HTTPException(status_code=409, detail="polish already in flight")

    out_res = tuple(req.output_resolution) if req.output_resolution else None
    async with lock:
        try:
            arr = engine.polish(
                prepared, lights=lights,
                ambient=req.ambient, shadow_style=req.shadow_style,
                prompt=req.prompt, seed=req.seed,
                output_resolution=out_res,
            )
        except torch.cuda.OutOfMemoryError as e:
            raise HTTPException(
                status_code=503, detail="GPU OOM",
                headers={"Retry-After": "30"},
            ) from e

    buf = io.BytesIO()
    encode(arr, buf, fmt=req.output_format, bit_depth=req.output_bit_depth)
    return Response(content=buf.getvalue(), media_type=CONTENT_TYPES[req.output_format])
```

Note on the lock-contention check: this depends on `SessionStore.lock(session_id)` returning an asyncio Lock object that supports `.locked()`. Verify this by reading `packages/relighting_api/relighting_api/session_store.py` — if the existing `lock()` method returns a context manager that doesn't expose `.locked()`, add a `locked(session_id)` helper to `SessionStore` and use that here instead.

- [ ] **Step 2: Register the route in `main.py` (temporary — Task 11 finishes the wiring).**

Edit `packages/relighting_api/relighting_api/main.py`:

Add to the imports:
```python
from relighting_api.routes import polish as polish_route
```

Add to the router registration block:
```python
    app.include_router(polish_route.router)
```

- [ ] **Step 3: Run the polish tests.**

Run: `pytest packages/relighting_api/tests/api/test_polish.py -v`
Expected: 7 PASS. If the lock-contention test fails because `SessionStore.lock` doesn't expose `.locked()`, fix that first (see note in Step 1).

- [ ] **Step 4: Run the full API test suite to confirm no regressions.**

Run: `pytest packages/relighting_api/tests -x`
Expected: All tests pass.

- [ ] **Step 5: Commit.**

```bash
git add packages/relighting_api/relighting_api/routes/polish.py \
        packages/relighting_api/relighting_api/main.py
git commit -m "feat(api): add /polish route for IC-Light diffusion refinement"
```

---

## Task 10: Extend `/healthz` with `capabilities` block

**Files:**
- Modify: `packages/relighting_api/relighting_api/schemas.py`
- Modify: `packages/relighting_api/relighting_api/routes/health.py`
- Create: `packages/relighting_api/tests/api/test_healthz_capabilities.py`

- [ ] **Step 1: Write the failing tests.**

Create `packages/relighting_api/tests/api/test_healthz_capabilities.py`:

```python
"""Tests for /healthz capabilities block."""
from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from relighting_api.main import create_app


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setenv("RELIGHT_CACHE_DIR", str(tmp_path / "sessions"))
    monkeypatch.setenv("RELIGHT_SCENES_DB", str(tmp_path / "scenes.db"))
    app = create_app(skip_engine=True)
    app.state.capabilities = {"polish": True, "segmenters": ["rmbg", "sam2"]}
    return TestClient(app)


def test_healthz_includes_capabilities(client):
    r = client.get("/healthz")
    assert r.status_code == 200
    body = r.json()
    assert "capabilities" in body
    assert body["capabilities"]["polish"] is True
    assert "rmbg" in body["capabilities"]["segmenters"]


def test_healthz_capabilities_polish_false_when_disabled(client):
    client.app.state.capabilities["polish"] = False
    r = client.get("/healthz")
    body = r.json()
    assert body["capabilities"]["polish"] is False
```

- [ ] **Step 2: Run the tests to verify they fail.**

Run: `pytest packages/relighting_api/tests/api/test_healthz_capabilities.py -v`
Expected: FAIL — response body has no `capabilities` field.

- [ ] **Step 3: Update `HealthResponse` schema.**

Edit `packages/relighting_api/relighting_api/schemas.py` — extend `HealthResponse`:

```python
class Capabilities(BaseModel):
    polish: bool = False
    segmenters: list[str] = Field(default_factory=list)


class HealthResponse(BaseModel):
    ok: bool
    gpu: bool
    depth_model_loaded: bool
    seg_model_loaded: bool
    capabilities: Capabilities = Field(default_factory=Capabilities)
```

- [ ] **Step 4: Update `/healthz` route to populate capabilities from `app.state`.**

Edit `packages/relighting_api/relighting_api/routes/health.py`:

```python
"""GET /healthz — service liveness + GPU/model state + capabilities."""
from __future__ import annotations

import torch
from fastapi import APIRouter, Request

from relighting_api.schemas import Capabilities, HealthResponse

router = APIRouter()


@router.get("/healthz", response_model=HealthResponse)
def healthz(request: Request) -> HealthResponse:
    gpu = bool(torch.cuda.is_available())
    caps_dict = getattr(request.app.state, "capabilities", {}) or {}
    caps = Capabilities(
        polish=bool(caps_dict.get("polish", False)),
        segmenters=list(caps_dict.get("segmenters", [])),
    )
    return HealthResponse(
        ok=True,
        gpu=gpu,
        depth_model_loaded=False,
        seg_model_loaded=False,
        capabilities=caps,
    )
```

- [ ] **Step 5: Run the tests to verify they pass.**

Run: `pytest packages/relighting_api/tests/api/test_healthz_capabilities.py -v`
Expected: 2 PASS.

- [ ] **Step 6: Run the full API test suite.**

Run: `pytest packages/relighting_api/tests -x`
Expected: All tests pass.

- [ ] **Step 7: Commit.**

```bash
git add packages/relighting_api/relighting_api/schemas.py \
        packages/relighting_api/relighting_api/routes/health.py \
        packages/relighting_api/tests/api/test_healthz_capabilities.py
git commit -m "feat(api): extend /healthz with polish + segmenters capabilities"
```

---

## Task 11: Wire `app.state.capabilities` at startup

**Files:**
- Modify: `packages/relighting_api/relighting_api/main.py`

- [ ] **Step 1: Edit `main.py` to populate `app.state.capabilities`.**

In `create_app()`, after the existing `app.state.sessions = ...` and `app.state.scenes = ...` lines and before `app.state.skip_engine = skip_engine`, add:

```python
    # Detect optional capabilities once at startup. Polish requires the
    # [diffusion] extra + GPU + enough free VRAM; if any check fails the
    # /polish route returns 501 and the frontend hides the Polish UI.
    polish_available = False
    if not skip_engine:
        try:
            from relighting_engine.polish.capabilities import is_available
            polish_available = is_available()
        except ImportError:
            polish_available = False
    app.state.capabilities = {
        "polish": polish_available,
        "segmenters": ["rmbg", "sam2"],
    }
```

The `skip_engine` guard means tests can override `app.state.capabilities` directly (as they already do in `test_polish.py` and `test_healthz_capabilities.py`).

- [ ] **Step 2: Run the full API test suite.**

Run: `pytest packages/relighting_api/tests -x`
Expected: All tests pass — the tests bypass startup detection by setting `app.state.capabilities` directly.

- [ ] **Step 3: Commit.**

```bash
git add packages/relighting_api/relighting_api/main.py
git commit -m "feat(api): detect polish capability at app startup"
```

---

# Stage C — Frontend

## Task 12: API client — `polishScene` and `getCapabilities`

**Files:**
- Modify: `web/src/api.js`

- [ ] **Step 1: Add the two new functions.**

Append to `web/src/api.js`:

```javascript
// ─── Polish API ──────────────────────────────────────────────────────────

export async function getCapabilities() {
  const r = await fetch('/healthz');
  if (!r.ok) throw new Error(`/healthz: ${r.status}`);
  const body = await r.json();
  return body.capabilities || { polish: false, segmenters: [] };
}

export async function polishScene({ sessionId, lights, ambient, shadowStyle,
                                    prompt = '', seed = null,
                                    outputFormat = 'png', outputBitDepth = 8,
                                    outputResolution = null }) {
  const r = await fetch('/polish', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      session_id: sessionId,
      lights,
      ambient,
      shadow_style: shadowStyle,
      prompt,
      seed,
      output_format: outputFormat,
      output_bit_depth: outputBitDepth,
      output_resolution: outputResolution,
    }),
  });
  if (!r.ok) {
    const text = await r.text();
    const err = new Error(`/polish: ${r.status} ${text}`);
    err.status = r.status;
    throw err;
  }
  return r.blob();
}
```

- [ ] **Step 2: Smoke-test in the browser console.**

Start the dev server and load the playground. In the console:

```javascript
const caps = await (await fetch('/healthz')).json();
console.log(caps.capabilities);
```

Expected: object with `polish` and `segmenters` fields. (Actual `polish: true/false` depends on whether the dev box has the diffusion extra installed.)

- [ ] **Step 3: Commit.**

```bash
git add web/src/api.js
git commit -m "feat(web): add polishScene and getCapabilities API client functions"
```

---

## Task 13: `polish.js` state module + `polish-lightbox.js` UI module

**Files:**
- Create: `web/src/polish.js`
- Create: `web/src/polish-lightbox.js`

- [ ] **Step 1: Create `polish.js` with the state machine.**

Create `web/src/polish.js`:

```javascript
/** Polish state machine + side-effect orchestration.
 *
 * States: 'idle' | 'polishing' | 'ready' | 'error'.
 * Transitions are explicit; the main module subscribes via onChange().
 */
import { polishScene } from './api.js';

let state = {
  status: 'idle',
  blobUrl: null,
  prompt: '',
  error: null,
};
const listeners = new Set();

function emit() {
  for (const cb of listeners) cb(state);
}

export function onPolishChange(cb) {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export function getPolishState() {
  return state;
}

export function setPolishPrompt(prompt) {
  state = { ...state, prompt };
  emit();
}

/** Invalidate polished image — called when any classical render input changes. */
export function invalidatePolish() {
  if (state.blobUrl) URL.revokeObjectURL(state.blobUrl);
  state = { status: 'idle', blobUrl: null, prompt: state.prompt, error: null };
  emit();
}

/** Fire a polish request. Rejects if already in flight. */
export async function startPolish({ sessionId, lights, ambient, shadowStyle, seed = null }) {
  if (state.status === 'polishing') return;
  state = { ...state, status: 'polishing', error: null };
  emit();
  try {
    const blob = await polishScene({
      sessionId, lights, ambient, shadowStyle,
      prompt: state.prompt, seed,
    });
    const blobUrl = URL.createObjectURL(blob);
    state = { ...state, status: 'ready', blobUrl };
    emit();
  } catch (e) {
    state = { ...state, status: 'error', error: e.message || String(e) };
    emit();
  }
}
```

- [ ] **Step 2: Create `polish-lightbox.js`.**

Create `web/src/polish-lightbox.js`:

```javascript
/** Lightbox for viewing the polished image at native resolution.
 *
 * mount() attaches handlers to an existing DOM container. The HTML structure
 * lives in playground.html (see Task 14).
 */
export function mountLightbox({ rootEl, getBlobUrl }) {
  const imgEl = rootEl.querySelector('[data-polish-lightbox-img]');
  const closeBtn = rootEl.querySelector('[data-polish-lightbox-close]');
  const downloadPngBtn = rootEl.querySelector('[data-polish-lightbox-download-png]');
  const downloadJpegBtn = rootEl.querySelector('[data-polish-lightbox-download-jpeg]');

  function open() {
    const url = getBlobUrl();
    if (!url) return;
    imgEl.src = url;
    rootEl.classList.add('is-open');
  }

  function close() {
    rootEl.classList.remove('is-open');
    imgEl.src = '';
  }

  closeBtn.addEventListener('click', close);
  rootEl.addEventListener('click', (e) => {
    if (e.target === rootEl) close();  // click backdrop to close
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && rootEl.classList.contains('is-open')) close();
  });

  // Download buttons reuse the blob (PNG) or call /polish again for JPEG.
  // For v1, both download the same blob (the response is already PNG by
  // default). A JPEG-specific download path can be added later.
  function download(filename) {
    const url = getBlobUrl();
    if (!url) return;
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
  }
  downloadPngBtn.addEventListener('click', () => download('polished.png'));
  downloadJpegBtn.addEventListener('click', () => download('polished.png'));
  // Note: JPEG download served from PNG blob is a v1 shortcut. If users
  // request true JPEG export, refire the polish request with output_format='jpeg'.

  return { open, close };
}
```

- [ ] **Step 3: Commit.**

```bash
git add web/src/polish.js web/src/polish-lightbox.js
git commit -m "feat(web): add polish state module and lightbox UI module"
```

---

## Task 14: HTML + CSS for polish UI

**Files:**
- Modify: `web/playground.html`
- Modify: `web/playground.css`

- [ ] **Step 1: Add HTML elements to `playground.html`.**

Find the header element (where the existing "+ New Scene" button lives) and add the polish controls. Search for the header section — it'll be near a button group containing existing actions. Add these elements just after the existing buttons but inside the header bar:

```html
<!-- Polish UI (hidden until /healthz reports capabilities.polish = true) -->
<div class="polish-controls" data-polish-controls hidden>
  <div class="polish-toggle" data-polish-toggle hidden>
    <button type="button" data-polish-toggle-classical class="is-active">Classical</button>
    <button type="button" data-polish-toggle-polished>Polished</button>
  </div>
  <input
    type="text"
    placeholder="Polish prompt (optional)"
    class="polish-prompt"
    data-polish-prompt
  />
  <button type="button" class="polish-btn" data-polish-btn>Polish ▸</button>
</div>
```

Find the canvas container (search for the element wrapping the WebGL `<canvas>`) and add the expand icon and shimmer overlay:

```html
<!-- Inside the canvas stage container, after the <canvas> element -->
<div class="polish-shimmer" data-polish-shimmer hidden>
  <span class="polish-shimmer-text" data-polish-shimmer-text>Polishing…</span>
</div>
<button
  type="button"
  class="polish-expand-btn"
  data-polish-expand-btn
  title="Open polished image"
  hidden
>⤢</button>
```

At the bottom of the body (before the closing `</body>` and existing modal containers), add the lightbox:

```html
<div class="polish-lightbox" data-polish-lightbox role="dialog" aria-hidden="true">
  <button type="button" class="polish-lightbox-close" data-polish-lightbox-close aria-label="Close">×</button>
  <img class="polish-lightbox-img" data-polish-lightbox-img alt="Polished render" />
  <div class="polish-lightbox-actions">
    <button type="button" data-polish-lightbox-download-png>Download PNG</button>
    <button type="button" data-polish-lightbox-download-jpeg>Download JPEG</button>
  </div>
</div>
```

- [ ] **Step 2: Add CSS to `playground.css`.**

Append to `web/playground.css`:

```css
/* ─── Polish UI ──────────────────────────────────────────────────────────── */

.polish-controls {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-left: 16px;
}

.polish-toggle {
  display: inline-flex;
  border: 1px solid var(--border, #444);
  border-radius: 4px;
  overflow: hidden;
}
.polish-toggle button {
  background: transparent;
  border: none;
  color: var(--text, #ddd);
  padding: 4px 10px;
  cursor: pointer;
  font-size: 12px;
}
.polish-toggle button.is-active {
  background: var(--accent, #4a7);
  color: #fff;
}

.polish-prompt {
  width: 220px;
  padding: 4px 8px;
  background: var(--input-bg, #222);
  color: var(--text, #ddd);
  border: 1px solid var(--border, #444);
  border-radius: 4px;
  font-size: 12px;
}
.polish-prompt:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.polish-btn {
  background: var(--accent, #4a7);
  color: #fff;
  border: none;
  padding: 6px 14px;
  border-radius: 4px;
  cursor: pointer;
  font-size: 12px;
  font-weight: 600;
}
.polish-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.polish-shimmer {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0, 0, 0, 0.45);
  pointer-events: none;
  animation: polish-shimmer-pulse 1.6s ease-in-out infinite;
}
@keyframes polish-shimmer-pulse {
  0%, 100% { background: rgba(0, 0, 0, 0.45); }
  50% { background: rgba(0, 0, 0, 0.25); }
}
.polish-shimmer-text {
  color: #fff;
  font-size: 14px;
  font-weight: 500;
  letter-spacing: 0.5px;
}

.polish-expand-btn {
  position: absolute;
  top: 12px;
  right: 12px;
  background: rgba(0, 0, 0, 0.55);
  color: #fff;
  border: none;
  border-radius: 4px;
  width: 32px;
  height: 32px;
  font-size: 18px;
  cursor: pointer;
  z-index: 5;
}
.polish-expand-btn:hover { background: rgba(0, 0, 0, 0.8); }

.polish-lightbox {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.92);
  display: none;
  align-items: center;
  justify-content: center;
  flex-direction: column;
  z-index: 100;
}
.polish-lightbox.is-open { display: flex; }
.polish-lightbox-img {
  max-width: 92vw;
  max-height: 82vh;
  object-fit: contain;
}
.polish-lightbox-close {
  position: absolute;
  top: 16px;
  right: 16px;
  background: transparent;
  color: #fff;
  border: none;
  font-size: 28px;
  cursor: pointer;
}
.polish-lightbox-actions {
  margin-top: 16px;
  display: flex;
  gap: 12px;
}
.polish-lightbox-actions button {
  background: #444;
  color: #fff;
  border: none;
  padding: 8px 16px;
  border-radius: 4px;
  cursor: pointer;
}
.polish-lightbox-actions button:hover { background: #555; }
```

- [ ] **Step 3: Verify in the browser.**

Reload the playground. The polish controls should be invisible (the `data-polish-controls` element starts `hidden`). The lightbox should be invisible. No layout regressions on existing UI.

- [ ] **Step 4: Commit.**

```bash
git add web/playground.html web/playground.css
git commit -m "feat(web): add polish controls, shimmer overlay, and lightbox markup"
```

---

## Task 15: Wire polish into `main.js` — handlers, toggle, invalidation, capability gate

**Files:**
- Modify: `web/src/main.js`

This task connects the new `polish.js` state module to the UI elements, hooks invalidation into the existing render-trigger flow, and applies capability gating on page load.

- [ ] **Step 1: Add imports at the top of `main.js`.**

```javascript
import { getCapabilities } from './api.js';
import {
  invalidatePolish,
  onPolishChange,
  setPolishPrompt,
  startPolish,
} from './polish.js';
import { mountLightbox } from './polish-lightbox.js';
```

- [ ] **Step 2: Add the capability-gating + UI-wiring setup.**

Find the place in `main.js` where the playground is initialized (after the session is loaded and the WebGL renderer is mounted). Add a `setupPolishUI()` function and call it during init:

```javascript
async function setupPolishUI({ getSessionId, getCurrentLights, getAmbient,
                                getShadowStyle, getCanvasEl, render }) {
  const controls = document.querySelector('[data-polish-controls]');
  const toggle = document.querySelector('[data-polish-toggle]');
  const toggleClassicalBtn = document.querySelector('[data-polish-toggle-classical]');
  const togglePolishedBtn = document.querySelector('[data-polish-toggle-polished]');
  const promptInput = document.querySelector('[data-polish-prompt]');
  const polishBtn = document.querySelector('[data-polish-btn]');
  const shimmer = document.querySelector('[data-polish-shimmer]');
  const shimmerText = document.querySelector('[data-polish-shimmer-text]');
  const expandBtn = document.querySelector('[data-polish-expand-btn]');
  const lightboxEl = document.querySelector('[data-polish-lightbox]');

  let caps;
  try {
    caps = await getCapabilities();
  } catch {
    caps = { polish: false };
  }
  if (!caps.polish) {
    // Remove polish UI from the DOM entirely.
    controls?.remove();
    shimmer?.remove();
    expandBtn?.remove();
    lightboxEl?.remove();
    return;
  }

  controls.hidden = false;

  // Lightbox controller — needs a way to fetch the current blob URL.
  let currentBlobUrl = null;
  const lightbox = mountLightbox({
    rootEl: lightboxEl,
    getBlobUrl: () => currentBlobUrl,
  });
  expandBtn.addEventListener('click', () => lightbox.open());

  promptInput.addEventListener('input', (e) => setPolishPrompt(e.target.value));

  polishBtn.addEventListener('click', () => {
    startPolish({
      sessionId: getSessionId(),
      lights: getCurrentLights(),
      ambient: getAmbient(),
      shadowStyle: getShadowStyle(),
    });
  });

  // Shimmer timer — upgrade the message after 5s.
  let shimmerTimer = null;

  // Toggle between Classical and Polished views.
  let viewMode = 'classical';
  function applyViewMode() {
    toggleClassicalBtn.classList.toggle('is-active', viewMode === 'classical');
    togglePolishedBtn.classList.toggle('is-active', viewMode === 'polished');
    const canvas = getCanvasEl();
    if (viewMode === 'polished' && currentBlobUrl) {
      // Hide WebGL canvas, show an <img> overlay with the polished image.
      canvas.style.visibility = 'hidden';
      ensurePolishedImg().src = currentBlobUrl;
      ensurePolishedImg().style.display = 'block';
    } else {
      canvas.style.visibility = 'visible';
      const img = ensurePolishedImg();
      img.style.display = 'none';
      img.src = '';
    }
  }
  function ensurePolishedImg() {
    let img = document.querySelector('[data-polished-img]');
    if (!img) {
      img = document.createElement('img');
      img.dataset.polishedImg = '';
      img.style.position = 'absolute';
      img.style.inset = '0';
      img.style.width = '100%';
      img.style.height = '100%';
      img.style.objectFit = 'contain';
      img.style.pointerEvents = 'none';
      img.style.display = 'none';
      getCanvasEl().parentElement.appendChild(img);
    }
    return img;
  }
  toggleClassicalBtn.addEventListener('click', () => { viewMode = 'classical'; applyViewMode(); });
  togglePolishedBtn.addEventListener('click', () => { viewMode = 'polished'; applyViewMode(); });

  // Subscribe to polish state changes.
  onPolishChange((state) => {
    polishBtn.disabled = state.status === 'polishing';
    promptInput.disabled = state.status === 'polishing';

    if (state.status === 'polishing') {
      shimmer.hidden = false;
      shimmerText.textContent = 'Polishing…';
      clearTimeout(shimmerTimer);
      shimmerTimer = setTimeout(() => {
        shimmerText.textContent = 'Loading polish model (one-time, ~6 GB)…';
      }, 5000);
    } else {
      clearTimeout(shimmerTimer);
      shimmer.hidden = true;
    }

    if (state.status === 'ready') {
      currentBlobUrl = state.blobUrl;
      toggle.hidden = false;
      expandBtn.hidden = false;
      viewMode = 'polished';
      applyViewMode();
    }

    if (state.status === 'idle' || state.status === 'error') {
      currentBlobUrl = null;
      toggle.hidden = true;
      expandBtn.hidden = true;
      viewMode = 'classical';
      applyViewMode();
    }

    if (state.status === 'error') {
      console.error('polish error:', state.error);
      // Toast goes here if a toast system exists; otherwise a console error
      // is the v1 surface area.
    }
  });
}
```

- [ ] **Step 3: Call `setupPolishUI()` during init.**

In `main.js`, the playground state lives on a single `state` object with fields `sessionId`, `lights`, `ambient`, `shadowStyle` (see `state.sessionId`, `state.lights`, `state.ambient`, `state.shadowStyle` references in the file — e.g. the export-btn handler around line 400). After the existing initialization (where the renderer is mounted and the state is wired), add:

```javascript
await setupPolishUI({
  getSessionId: () => state.sessionId,
  getCurrentLights: () => state.lights,
  getAmbient: () => state.ambient,
  getShadowStyle: () => state.shadowStyle || 'off',
  getCanvasEl: () => document.querySelector('canvas'),
});
```

Place the call near the top-level module setup (after `state` and `tree`/`handles` are constructed but before any user interaction is possible). The `await` is fine at top level because `main.js` is loaded as a module.

- [ ] **Step 4: Hook invalidation into the existing render trigger.**

The central choke point for classical-render-triggering state changes is the `onChange()` function (around line 142):

```javascript
const onChange = () => {
  syncLights(state);
  if (state.sessionId) {
    handlesAPI = mountHandles(state, redrawAndSave, onCanvasSelect);
    redraw();
  }
  scheduleSave();
};
```

Add `invalidatePolish()` at the top of this function — every code path that mutates lights/tree state already routes through here. One line covers all invalidation:

```javascript
const onChange = () => {
  invalidatePolish();
  syncLights(state);
  if (state.sessionId) {
    handlesAPI = mountHandles(state, redrawAndSave, onCanvasSelect);
    redraw();
  }
  scheduleSave();
};
```

Also add `invalidatePolish()` to any direct state mutations that bypass `onChange()` — search for places that mutate `state.ambient`, `state.shadowStyle`, or `state.lights` and don't subsequently call `onChange()`. Typical candidates are the ambient slider and shadow-style selector handlers; if either updates state and calls `redraw()` directly without `onChange()`, add `invalidatePolish()` immediately after the mutation.

- [ ] **Step 5: Manual test checklist.**

Start the dev server. With the diffusion extra installed and a GPU available:

1. Open the playground. Polish controls visible in the header.
2. Click Polish. Shimmer appears. Button + prompt input disabled.
3. After 5s (the first time the model loads), shimmer text upgrades to "Loading polish model…"
4. Polish completes. Polished image swaps in on the canvas. Toggle appears, defaults to Polished.
5. Click Classical in the toggle. WebGL canvas shows. Click Polished. Polished image returns.
6. Click the expand icon. Lightbox opens at native res. Click Download PNG; file saves.
7. Press Escape. Lightbox closes.
8. Move any light handle. Polished image invalidates immediately, canvas reverts to classical, toggle and expand icon disappear.
9. Click Polish a second time while one is in flight (only possible if you click fast or open devtools and inspect): button is disabled, second click is a no-op.
10. Type a prompt ("warm sunset, soft shadows"), click Polish. Result reflects the prompt.

Without the diffusion extra (or on a machine where `/healthz` returns `capabilities.polish: false`):

11. Reload playground. Polish UI is absent from the DOM entirely.

- [ ] **Step 6: Commit.**

```bash
git add web/src/main.js
git commit -m "feat(web): wire polish button, toggle, lightbox, and invalidation"
```

---

# Wrap-up

After Task 15 passes its manual checklist:

- Run the full Python test suite once: `pytest packages/relighting_engine/tests packages/relighting_api/tests -x`.
- Manually exercise the end-to-end flow (Steps 1–11 above) on a fresh page load.
- Update the README's feature list to mention polish (one bullet under existing features).

---

# Self-Review Checklist (for the planner)

These were verified before this plan was committed:

- Spec coverage: every section of the spec maps to a task (capabilities → Task 2, ICLightBackend → Tasks 3+4, engine.polish → Task 5, optional install → Task 1, RenderCommon → Task 6, shared encoder → Task 7, /polish route → Task 9, /healthz extension → Task 10, app.state.capabilities → Task 11, API client → Task 12, state + lightbox modules → Task 13, HTML/CSS → Task 14, main.js integration → Task 15).
- No placeholders: every step contains actual code or an exact command.
- Type consistency: `ICLightBackend.polish(classical_render, foreground_rgba, prompt, *, seed)` matches across Tasks 3, 4, 5, 8. `RelightingEngine.polish(prepared, lights, *, ambient, shadow_style, prompt, seed, output_resolution)` matches Tasks 5, 8, 9. `PolishRequest` fields match across Tasks 6, 8, 9, 12.
