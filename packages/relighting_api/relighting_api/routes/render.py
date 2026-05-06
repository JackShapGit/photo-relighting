"""POST /render — render a prepared image under a lights array, return image bytes."""
from __future__ import annotations

import io

import numpy as np
import torch
from fastapi import APIRouter, HTTPException, Request, Response

from relighting_api.schemas import RenderRequest
from relighting_engine.core.io import _linear_to_srgb

router = APIRouter()

CONTENT_TYPES = {"png": "image/png", "jpeg": "image/jpeg", "tiff": "image/tiff"}


@router.post("/render")
async def render(req: RenderRequest, request: Request) -> Response:
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

    out_res = tuple(req.output_resolution) if req.output_resolution else None
    async with sessions.lock(req.session_id):
        try:
            arr = engine.render(prepared, lights=lights, ambient=req.ambient,
                                output_resolution=out_res)
        except torch.cuda.OutOfMemoryError as e:
            raise HTTPException(status_code=503, detail="GPU OOM",
                                headers={"Retry-After": "10"}) from e

    buf = io.BytesIO()
    _encode(arr, buf, fmt=req.output_format, bit_depth=req.output_bit_depth)
    return Response(content=buf.getvalue(), media_type=CONTENT_TYPES[req.output_format])


def _encode(arr: np.ndarray, buf: io.BytesIO, *, fmt: str, bit_depth: int) -> None:
    from PIL import Image
    import imageio.v3 as iio

    if bit_depth == 32:
        iio.imwrite(buf, np.clip(arr, 0, 1).astype(np.float32), extension=".tiff")
        return
    srgb = _linear_to_srgb(arr)
    if bit_depth == 16:
        u = np.clip(srgb * 65535 + 0.5, 0, 65535).astype(np.uint16)
    else:
        # FIX: clip ceiling is 255, not 65535 (the wide ceiling was misleading for uint8)
        u = np.clip(srgb * 255 + 0.5, 0, 255).astype(np.uint8)
    if fmt == "jpeg":
        Image.fromarray(u).save(buf, format="JPEG", quality=95)
    elif fmt == "png":
        if bit_depth == 16:
            # FIX: imageio's PNG backend (Pillow) cannot write 16-bit RGB PNG
            # (KeyError: ((1,1,3), '<u2')).  Use cv2 instead, same as session_store.py.
            import cv2
            bgr = cv2.cvtColor(u, cv2.COLOR_RGB2BGR)
            ok, png_bytes = cv2.imencode(".png", bgr)
            if not ok:
                raise RuntimeError("cv2 failed to encode 16-bit PNG")
            buf.write(png_bytes.tobytes())
        else:
            Image.fromarray(u).save(buf, format="PNG")
    elif fmt == "tiff":
        iio.imwrite(buf, u, extension=".tiff")
