"""GET /healthz — service liveness + GPU/model state."""
from __future__ import annotations

import torch
from fastapi import APIRouter

from relighting_api.schemas import HealthResponse

router = APIRouter()


@router.get("/healthz", response_model=HealthResponse)
def healthz() -> HealthResponse:
    gpu = bool(torch.cuda.is_available())
    return HealthResponse(
        ok=True,
        gpu=gpu,
        depth_model_loaded=False,
        seg_model_loaded=False,
    )
