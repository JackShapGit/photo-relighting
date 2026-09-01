"""POST /refine_mask — interactively refine a SAM2 mask via point prompts.

Requires the session to have been prepared with the SAM2 segmenter (so its
image embeddings were persisted alongside the other prepared assets). The
endpoint loads the cached embeddings, runs only the prompt-encoder + mask-
decoder path, and overwrites mask.png in the session dir with the result.
"""
from __future__ import annotations

import time
from pathlib import Path
from typing import Annotated

import numpy as np
from fastapi import APIRouter, HTTPException, Request
from PIL import Image

from relighting_engine.core.raw import decode_to_srgb_pil
from pydantic import BaseModel, Field

router = APIRouter()


class RefineMaskRequest(BaseModel):
    session_id: str
    points: list[list[float]] = Field(min_length=1)   # [[x, y], …] in source-image pixel coords
    labels: list[Annotated[int, Field(ge=0, le=1)]] = Field(min_length=1)


@router.post("/refine_mask")
async def refine_mask(req: RefineMaskRequest, request: Request) -> dict:
    if len(req.points) != len(req.labels):
        raise HTTPException(status_code=422, detail="points and labels length mismatch")

    sessions = request.app.state.sessions
    prepared = sessions.get(req.session_id)
    if prepared is None:
        raise HTTPException(status_code=404, detail="unknown session_id")

    sess_dir: Path = sessions.dir / req.session_id
    emb_path = sess_dir / "sam2_embeddings.pt"
    if not emb_path.exists():
        raise HTTPException(
            status_code=409,
            detail="this session was not prepared with SAM2 — re-segment with SAM2 first",
        )

    # Lazy import torch only inside the handler so cold-start cost stays in
    # /prepare for the typical RMBG flow.
    import torch
    engine = getattr(request.app.state, "engine", None)
    if engine is None:
        from relighting_api.deps import get_engine
        engine = get_engine()
    seg = engine.get_segmenter("sam2")
    seg._load()

    embeddings = torch.load(emb_path, map_location=engine.device)

    # Reload the source image to feed back into the SAM2 processor.
    source_files = sorted(sess_dir.glob("source.*"))
    if not source_files:
        raise HTTPException(status_code=409, detail="missing source image for session")
    # A raw upload persists as "source.raw", which Pillow cannot read; decode
    # it through LibRaw first and fall back to Pillow for ordinary formats.
    pil = decode_to_srgb_pil(source_files[0].read_bytes())
    if pil is None:
        pil = Image.open(source_files[0]).convert("RGB")
    h, w = pil.size[1], pil.size[0]

    ctx = {"embeddings": embeddings, "image_size": (h, w), "pil_image": pil}
    mask = seg.decode_with_points(ctx, req.points, req.labels)

    # Overwrite mask.png so the playground's texture refresh picks it up.
    mask_u8 = (np.asarray(mask) * 255.0).clip(0, 255).astype(np.uint8)
    if mask_u8.ndim != 2:
        mask_u8 = mask_u8.reshape(h, w)
    Image.fromarray(mask_u8, mode="L").save(sess_dir / "mask.png")

    # Update the in-memory PreparedImage so subsequent renders use the new mask.
    prepared.mask = mask.astype(np.float32)

    # Cache-bust query so the browser fetches the fresh PNG.
    return {
        "ok": True,
        "mask_png_url": f"/cache/sessions/{req.session_id}/mask.png?t={int(time.time() * 1000)}",
    }
