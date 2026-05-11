"""POST /render — render a prepared image under a lights array, return image bytes."""
from __future__ import annotations

import io

import torch
from fastapi import APIRouter, HTTPException, Request, Response

from relighting_api.routes._encoding import CONTENT_TYPES, encode
from relighting_api.schemas import RenderRequest

router = APIRouter()


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
                                output_resolution=out_res,
                                shadow_style=req.shadow_style)
        except torch.cuda.OutOfMemoryError as e:
            raise HTTPException(status_code=503, detail="GPU OOM",
                                headers={"Retry-After": "10"}) from e

    buf = io.BytesIO()
    encode(arr, buf, fmt=req.output_format, bit_depth=req.output_bit_depth)
    return Response(content=buf.getvalue(), media_type=CONTENT_TYPES[req.output_format])
