"""Venues CRUD: GET/POST /venues, GET/PUT/DELETE /venues/{id}, POST /venues/{id}/duplicate.

Workspace-scoped exactly like scenes (``?workspace=``). A venue posted with
no positions gets the starter rig scaled to its dimensions. DELETE refuses
with 409 ``{detail, scene_count}`` while any scene in the workspace still
references the venue, unless ``?force=1``; those scenes keep their embedded
snapshot.
"""
from __future__ import annotations

from typing import Any

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

from relighting_api.routes.scenes import _workspace
from relighting_api.schemas import VenueModel
from relighting_api.venue_store import starter_positions

router = APIRouter(prefix="/venues")


class DuplicateVenueRequest(BaseModel):
    name: str = Field(min_length=1)


def _truthy(v: str | None) -> bool:
    return (v or "").strip().lower() in ("1", "true", "yes")


@router.get("")
async def list_venues(request: Request) -> list[dict[str, Any]]:
    return request.app.state.venues.list_recent(workspace_id=_workspace(request))


@router.post("")
async def create_venue(req: VenueModel, request: Request) -> dict[str, Any]:
    data = req.model_dump()
    if not data["positions"]:
        data["positions"] = starter_positions(data["width_ft"], data["height_ft"], data["depth_ft"])
    return request.app.state.venues.create(
        name=req.name.strip(), venue=data, workspace_id=_workspace(request),
    )


@router.get("/{venue_id}")
async def get_venue(venue_id: str, request: Request) -> dict[str, Any]:
    v = request.app.state.venues.get(venue_id, workspace_id=_workspace(request))
    if v is None:
        raise HTTPException(status_code=404, detail="venue not found")
    return v


@router.put("/{venue_id}")
async def update_venue(venue_id: str, req: VenueModel, request: Request) -> dict[str, Any]:
    store = request.app.state.venues
    ws = _workspace(request)
    data = req.model_dump()
    data["name"] = req.name.strip()
    if not store.update(venue_id, data, workspace_id=ws):
        raise HTTPException(status_code=404, detail="venue not found")
    return store.get(venue_id, workspace_id=ws)


@router.delete("/{venue_id}")
async def delete_venue(venue_id: str, request: Request, force: str | None = None):
    store = request.app.state.venues
    ws = _workspace(request)
    if store.get(venue_id, workspace_id=ws) is None:
        raise HTTPException(status_code=404, detail="venue not found")
    n = store.count_scene_refs(venue_id, workspace_id=ws)
    if n and not _truthy(force):
        return JSONResponse(
            status_code=409,
            content={"detail": f"venue is used by {n} scene(s); pass ?force=1 to delete anyway",
                     "scene_count": n},
        )
    store.delete(venue_id, workspace_id=ws)
    return {"ok": True}


@router.post("/{venue_id}/duplicate")
async def duplicate_venue(venue_id: str, req: DuplicateVenueRequest, request: Request) -> dict[str, Any]:
    v = request.app.state.venues.duplicate(
        venue_id, req.name.strip(), workspace_id=_workspace(request),
    )
    if v is None:
        raise HTTPException(status_code=404, detail="venue not found")
    return v
