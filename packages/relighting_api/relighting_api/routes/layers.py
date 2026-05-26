"""POST /render/layers -- render per-light layers and return a PSD file."""
from __future__ import annotations

import re

import torch
from fastapi import APIRouter, HTTPException, Request, Response

from relighting_api.schemas import RenderLayersRequest

router = APIRouter()

_SANITIZE = re.compile(r'[/\\:*?"<>|]+')


@router.post("/render/layers")
async def render_layers(req: RenderLayersRequest, request: Request) -> Response:
    if not request.app.state.capabilities.get("layers_export", False):
        raise HTTPException(status_code=501, detail="layers export not available (pytoshop not installed)")

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
            layers = engine.render_layers(
                prepared, lights=lights, ambient=req.ambient,
                ambient_subject=req.ambient_subject,
                ambient_background=req.ambient_background,
                output_resolution=out_res,
                shadow_style=req.shadow_style,
            )
        except torch.cuda.OutOfMemoryError as e:
            raise HTTPException(status_code=503, detail="GPU OOM",
                                headers={"Retry-After": "10"}) from e

    from relighting_engine.lighting.psd import assemble_psd
    from relighting_api.routes._encoding import srgb_icc

    data = assemble_psd(layers, icc_profile=srgb_icc())

    name = _SANITIZE.sub("_", req.scene_name).strip("_") if req.scene_name else "relighting_export"
    filename = f"{name}.psd"

    return Response(
        content=data,
        media_type="application/x-photoshop",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )
