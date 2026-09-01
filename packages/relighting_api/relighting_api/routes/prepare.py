"""POST /prepare — accept an image, run the engine, persist the session.

The core image-validation + engine + persistence logic lives in
``prepare_image_bytes`` so other routes (notably ``/scenes/import``) can
re-use it without going through HTTP.
"""
from __future__ import annotations

import io
from pathlib import Path
from typing import Literal

import numpy as np
from fastapi import APIRouter, File, Form, HTTPException, Request, UploadFile
from PIL import Image

from relighting_api.schemas import PreparedAssets, PrepareResponse
from relighting_engine.core.io import (  # internal helpers, OK within repo
    _linear_to_srgb,
    _srgb_to_linear,
)
from relighting_engine.core.raw import NotRawError, decode_raw_linear

router = APIRouter()

ALLOWED_FORMATS = {"JPEG", "PNG", "TIFF", "HEIF", "HEIC", "WEBP"}
MAX_DIM = 16384


def _make_thumb(pil: Image.Image, out: Path, max_side: int = 256) -> None:
    """Write a max-256px JPEG thumbnail of the prepared image to `out`."""
    img = pil.copy()
    img.thumbnail((max_side, max_side), Image.LANCZOS)
    if img.mode != "RGB":
        img = img.convert("RGB")
    img.save(out, format="JPEG", quality=85)


def prepare_image_bytes(
    raw: bytes,
    *,
    engine,
    sessions,
    mode: Literal["interactive", "quality"] = "interactive",
    segmenter: Literal["rmbg", "sam2"] = "rmbg",
) -> PrepareResponse:
    """Validate, run the engine, persist the session+source+thumbnail.

    Returns the same ``PrepareResponse`` that ``POST /prepare`` produces.
    Raises ``HTTPException`` on validation failures.
    """
    # Camera raw is tried FIRST. Pillow opens a DNG as a plain TIFF -- often
    # resolving to its small embedded preview -- which passes ALLOWED_FORMATS
    # and silently relights a thumbnail. LibRaw rejects every ordinary format,
    # so raw-first cannot hijack a normal upload (see core/raw.py).
    try:
        arr = decode_raw_linear(raw)  # already linear-light; do NOT sRGB-convert
        fmt = "RAW"
    except NotRawError:
        arr = None

    if arr is not None:
        if max(arr.shape[:2]) > MAX_DIM:
            raise HTTPException(
                status_code=413,
                detail=f"image too large: max-side {max(arr.shape[:2])} > {MAX_DIM}",
            )
        pil = Image.fromarray(
            (_linear_to_srgb(arr) * 255.0 + 0.5).astype(np.uint8), mode="RGB"
        )
    else:
        try:
            pil = Image.open(io.BytesIO(raw))
            pil.load()
        except Exception as e:  # noqa: BLE001
            raise HTTPException(status_code=415, detail=f"unsupported image: {e}") from e
        fmt = (pil.format or "").upper()
        if fmt not in ALLOWED_FORMATS:
            raise HTTPException(status_code=415, detail=f"unsupported format: {fmt}")
        if max(pil.size) > MAX_DIM:
            raise HTTPException(
                status_code=413,
                detail=f"image too large: max-side {max(pil.size)} > {MAX_DIM}",
            )

        if pil.mode != "RGB":
            pil = pil.convert("RGB")
        arr = np.asarray(pil).astype(np.float32) / 255.0
        arr = _srgb_to_linear(arr)

    prepared = engine.prepare(arr, mode=mode, segmenter=segmenter)
    sid = sessions.put(prepared)

    sess_dir = sessions.dir / sid
    ext = fmt.lower()
    if ext == "jpeg":
        ext = "jpg"
    # "source.raw" keeps the ORIGINAL bytes: scene export zips source.* and
    # import feeds them back through this function, so the raw survives a
    # round trip at full fidelity rather than being flattened to 8-bit.
    (sess_dir / f"source.{ext}").write_bytes(raw)
    _make_thumb(pil, sess_dir / "thumb.jpg")

    # Persist SAM2 image embeddings (if SAM2 was the segmenter) so the
    # /refine_mask route can re-decode quickly without re-encoding.
    if segmenter == "sam2":
        try:
            seg = engine.get_segmenter("sam2")
            ctx = getattr(seg, "last_ctx", None)
            if ctx is not None and ctx.get("embeddings") is not None:
                import torch
                torch.save(ctx["embeddings"], sess_dir / "sam2_embeddings.pt")
        except Exception as e:  # noqa: BLE001 — best-effort persistence
            print(f"warning: failed to persist SAM2 embeddings: {e}")

    base = f"/cache/sessions/{sid}"
    assets = PreparedAssets(
        original_png_url=f"{base}/original.png",
        depth_png_url=f"{base}/depth.png",
        normals_png_url=f"{base}/normals.png",
        mask_png_url=f"{base}/mask.png" if prepared.mask is not None else None,
        confidence_png_url=(
            f"{base}/confidence.png" if prepared.confidence is not None else None
        ),
        thumbnail_url=f"{base}/thumb.jpg",
        source_url=f"{base}/source.{ext}",
    )
    return PrepareResponse(
        session_id=sid,
        width=prepared.width,
        height=prepared.height,
        assets=assets,
        metadata=prepared.metadata,
    )


@router.post("/prepare", response_model=PrepareResponse)
async def prepare(
    request: Request,
    image: UploadFile = File(...),
    mode: Literal["interactive", "quality"] = Form("interactive"),
    segmenter: Literal["rmbg", "sam2"] = Form("rmbg"),
) -> PrepareResponse:
    raw = await image.read()
    engine = getattr(request.app.state, "engine", None)
    if engine is None:
        from relighting_api.deps import get_engine
        engine = get_engine()
    return prepare_image_bytes(
        raw, engine=engine, sessions=request.app.state.sessions,
        mode=mode, segmenter=segmenter,
    )
