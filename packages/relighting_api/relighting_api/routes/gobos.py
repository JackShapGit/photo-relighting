"""GET /gobos — list shipped gobo presets with thumbnail URLs."""
from __future__ import annotations

from pathlib import Path

from fastapi import APIRouter

from relighting_api.schemas import GoboList, GoboPreset

router = APIRouter()

PRESETS = [
    ("window-blinds", "Window Blinds", "spotlight"),
    ("leaves", "Leaves", "spotlight"),
    ("grid", "Grid", "spotlight"),
    ("clouds", "Clouds", "spotlight"),
    ("rays", "Rays", "spotlight"),
    ("dapple", "Dapple", "spotlight"),
]


@router.get("/gobos", response_model=GoboList)
def list_gobos() -> GoboList:
    presets = [
        GoboPreset(
            gobo_id=f"preset:{slug}",
            name=name,
            thumbnail_url=f"/static/gobos/{slug}.png",
            projection=projection,  # type: ignore[arg-type]
        )
        for slug, name, projection in PRESETS
    ]
    return GoboList(presets=presets)
