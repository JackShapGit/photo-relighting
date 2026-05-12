"""SAM2 (Segment Anything v2) adapter — alternative to RMBG-2.0.

Returns a foreground mask (1 = subject, 0 = background) as (H, W) float32.

Two interaction modes:
    - infer(image)               — auto-mask via a positive click at image center
    - embed(image) → ctx          — encode image once (slow; cache in session dir)
      decode_with_points(ctx, pts, labels) → mask
                                  — refine fast from cached embeddings

Model loaded lazily on first call; weights cached under HF cache.

API note (transformers 4.x): ``Sam2Processor`` expects
``input_points`` shaped [image, object, point, [x, y]] (4 levels nested) and
``input_labels`` shaped [image, object, point] (3 levels). The inputs dict
contains pixel_values, original_sizes, input_points, input_labels — there is
no ``reshaped_input_sizes`` key.
"""
from __future__ import annotations

from typing import Any, Sequence

import numpy as np
import torch


class SAM2Backend:
    REPO = "facebook/sam2-hiera-small"

    def __init__(self, device: str = "cuda"):
        self.device = device
        self._model = None
        self._processor = None
        # Cached context from the most recent embed/infer call. Used by the
        # API layer to persist embeddings into the session dir without re-
        # encoding the image just to grab them.
        self.last_ctx: dict | None = None

    def _load(self) -> None:
        if self._model is not None:
            return
        from transformers import Sam2Model, Sam2Processor
        self._processor = Sam2Processor.from_pretrained(self.REPO)
        self._model = Sam2Model.from_pretrained(self.REPO).to(self.device).eval()

    @torch.inference_mode()
    def infer(self, image: np.ndarray) -> np.ndarray:
        """Auto-mask using a single positive click at the image centre."""
        if image.dtype != np.float32 or image.ndim != 3 or image.shape[-1] != 3:
            raise ValueError("expected HxWx3 float32 image")
        h, w = image.shape[:2]
        ctx = self.embed(image)
        return self.decode_with_points(ctx, [(w / 2, h / 2)], [1])

    @torch.inference_mode()
    def embed(self, image: np.ndarray) -> dict[str, Any]:
        """Run the slow image encoder once. Returns a context dict that
        ``decode_with_points`` reuses for fast prompt-based refinement.

        The dict contains tensors on the model's device — pickling/moving
        across devices needs care.
        """
        if image.dtype != np.float32 or image.ndim != 3 or image.shape[-1] != 3:
            raise ValueError("expected HxWx3 float32 image")
        self._load()
        h, w = image.shape[:2]

        from PIL import Image as PILImage
        img_u8 = (image * 255.0).clip(0, 255).astype(np.uint8)
        pil = PILImage.fromarray(img_u8)

        # Just the pixel_values — we'll feed prompts when decoding.
        pixel_inputs = self._processor(images=pil, return_tensors="pt").to(self.device)
        embeddings = self._model.get_image_embeddings(pixel_inputs["pixel_values"])
        ctx = {
            "embeddings": embeddings,
            "image_size": (h, w),
            "pil_image": pil,
        }
        self.last_ctx = ctx
        return ctx

    @torch.inference_mode()
    def decode_with_points(
        self,
        ctx: dict[str, Any],
        points: Sequence[Sequence[float]],
        labels: Sequence[int],
    ) -> np.ndarray:
        """Decode a mask given image-encoder embeddings and click prompts.

        ``points`` are (x, y) in pixel coords in the original image. ``labels``
        are 1 (positive — include) or 0 (negative — exclude).

        Returns (H, W) float32 mask in [0, 1].
        """
        self._load()
        if not points:
            raise ValueError("decode_with_points requires at least one point")
        if len(points) != len(labels):
            raise ValueError("points and labels must be the same length")

        # Sam2Processor expects [image, object, point, [x, y]] nesting.
        input_points = [[[[float(p[0]), float(p[1])] for p in points]]]
        input_labels = [[[int(l) for l in labels]]]
        inputs = self._processor(
            images=ctx["pil_image"],
            input_points=input_points,
            input_labels=input_labels,
            return_tensors="pt",
        ).to(self.device)

        # Reuse cached embeddings if the model accepts an image_embeddings kwarg.
        kwargs: dict[str, Any] = {"multimask_output": False}
        if ctx.get("embeddings") is not None:
            try:
                outputs = self._model(
                    input_points=inputs["input_points"],
                    input_labels=inputs["input_labels"],
                    image_embeddings=ctx["embeddings"],
                    **kwargs,
                )
            except TypeError:
                outputs = self._model(**inputs, **kwargs)
        else:
            outputs = self._model(**inputs, **kwargs)

        masks = self._processor.post_process_masks(
            outputs.pred_masks.cpu(), inputs["original_sizes"],
        )
        # masks is [batch, num_objects, num_masks, H, W] in newer transformers.
        # Squeeze to a 2D float mask. The exact shape varies by version.
        m = masks[0]
        if hasattr(m, "cpu"):
            m = m.cpu().numpy()
        else:
            m = np.asarray(m)
        while m.ndim > 2:
            m = m[0]
        return m.astype(np.float32)
