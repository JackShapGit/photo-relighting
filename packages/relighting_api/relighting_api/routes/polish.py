"""POST /polish — diffusion-refined render via IC-Light.

Mirrors /render's interface but routes through the engine's polish() method.
Long-running (5–15s typical); enforces single-in-flight per session via the
existing session lock and returns 409 on contention.
"""
from __future__ import annotations

import io

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

    lock = sessions.lock(req.session_id)
    if lock.locked():
        raise HTTPException(status_code=409, detail="polish already in flight")

    out_res = tuple(req.output_resolution) if req.output_resolution else None
    calibration = req.calibration.to_engine(prepared.height / prepared.width) if req.calibration else None
    async with lock:
        try:
            arr = engine.polish(
                prepared, lights=lights,
                ambient=req.ambient,
                ambient_subject=req.ambient_subject,
                ambient_background=req.ambient_background,
                shadow_style=req.shadow_style,
                prompt=req.prompt, seed=req.seed,
                output_resolution=out_res,
                calibration=calibration,
            )
        except torch.cuda.OutOfMemoryError as e:
            raise HTTPException(
                status_code=503, detail="GPU OOM",
                headers={"Retry-After": "30"},
            ) from e

    buf = io.BytesIO()
    encode(arr, buf, fmt=req.output_format, bit_depth=req.output_bit_depth)
    return Response(content=buf.getvalue(), media_type=CONTENT_TYPES[req.output_format])
