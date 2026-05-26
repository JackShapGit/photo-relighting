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
        layers_export=bool(caps_dict.get("layers_export", False)),
        segmenters=list(caps_dict.get("segmenters", [])),
    )
    return HealthResponse(
        ok=True,
        gpu=gpu,
        depth_model_loaded=False,
        seg_model_loaded=False,
        capabilities=caps,
    )
