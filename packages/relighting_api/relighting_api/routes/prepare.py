"""POST /prepare — accept an image, run the engine, persist the session."""
from __future__ import annotations

import io
from typing import Literal

import numpy as np
from fastapi import APIRouter, File, Form, HTTPException, Request, UploadFile
from PIL import Image

from relighting_api.schemas import PreparedAssets, PrepareResponse
from relighting_engine.core.io import _srgb_to_linear  # internal helper, OK within repo

router = APIRouter()

ALLOWED_FORMATS = {"JPEG", "PNG", "TIFF", "HEIF", "HEIC", "WEBP"}
MAX_DIM = 4096


@router.post("/prepare", response_model=PrepareResponse)
async def prepare(
    request: Request,
    image: UploadFile = File(...),
    mode: Literal["interactive", "quality"] = Form("interactive"),
) -> PrepareResponse:
    raw = await image.read()
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

    engine = getattr(request.app.state, "engine", None)
    if engine is None:
        from relighting_api.deps import get_engine
        engine = get_engine()
    prepared = engine.prepare(arr, mode=mode)

    sessions = request.app.state.sessions
    sid = sessions.put(prepared)

    base = f"/cache/sessions/{sid}"
    assets = PreparedAssets(
        original_png_url=f"{base}/original.png",
        depth_png_url=f"{base}/depth.png",
        normals_png_url=f"{base}/normals.png",
        mask_png_url=f"{base}/mask.png" if prepared.mask is not None else None,
    )
    return PrepareResponse(
        session_id=sid,
        width=prepared.width,
        height=prepared.height,
        assets=assets,
        metadata=prepared.metadata,
    )
