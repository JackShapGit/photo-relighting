"""Scenes CRUD: POST /scenes, GET /scenes, GET/PUT/PATCH/DELETE /scenes/{id}.

Auto-save is implemented client-side as a debounced PUT on every edit.

GET /scenes/{id} enriches the response with the prepared-image asset URLs
and dimensions so the frontend can re-mount the canvas without a separate
roundtrip.

Export/import: POST /scenes/{id}/export returns a .relight.zip bundling the
scene state + the original source image. POST /scenes/import accepts that
zip, re-prepares the image (so the recipient's engine version is canonical),
and creates a new scene row.
"""
from __future__ import annotations

import io
import json
import logging
import re
import zipfile
from typing import Any

from fastapi import APIRouter, File, HTTPException, Request, Response, UploadFile
from pydantic import BaseModel, Field
from starlette.concurrency import run_in_threadpool

from relighting_api.scene_store import DEFAULT_WORKSPACE
from relighting_api.schemas import CalibrationModel

router = APIRouter(prefix="/scenes")
logger = logging.getLogger(__name__)

# Workspaces are user-supplied URL strings, so we clamp them to a safe set —
# alphanum + dash + underscore, 1..32 chars. Anything else 400s.
_WORKSPACE_RE = re.compile(r"^[A-Za-z0-9_-]{1,32}$")


def _workspace(request: Request) -> str:
    ws = request.query_params.get("workspace") or DEFAULT_WORKSPACE
    if not _WORKSPACE_RE.match(ws):
        raise HTTPException(status_code=400, detail="invalid workspace name")
    return ws


class CreateSceneRequest(BaseModel):
    name: str = Field(min_length=1)
    session_id: str
    state: dict[str, Any]


class UpdateSceneRequest(BaseModel):
    state: dict[str, Any]


class RenameSceneRequest(BaseModel):
    name: str = Field(min_length=1)


@router.post("")
async def create_scene(req: CreateSceneRequest, request: Request) -> dict[str, Any]:
    sessions = request.app.state.sessions
    if sessions.get(req.session_id) is None:
        raise HTTPException(status_code=404, detail="unknown session_id")
    return request.app.state.scenes.create(
        name=req.name.strip(),
        session_id=req.session_id,
        state=req.state,
        workspace_id=_workspace(request),
    )


@router.get("")
async def list_scenes(request: Request) -> list[dict[str, Any]]:
    scenes = request.app.state.scenes.list_recent(workspace_id=_workspace(request))
    sessions = request.app.state.sessions
    for s in scenes:
        sess_dir = sessions.dir / s["session_id"]
        if (sess_dir / "thumb.jpg").exists():
            s["thumbnail_url"] = f"/cache/sessions/{s['session_id']}/thumb.jpg"
    return scenes


@router.get("/{scene_id}")
async def get_scene(scene_id: str, request: Request) -> dict[str, Any]:
    scene = request.app.state.scenes.get(scene_id, workspace_id=_workspace(request))
    if scene is None:
        raise HTTPException(status_code=404, detail="scene not found")

    # Enrich with the prepared-image assets so the frontend doesn't have to
    # guess URLs or do a second roundtrip. If the session directory has been
    # cleaned up, mark session_missing — the frontend will surface that.
    sessions = request.app.state.sessions
    sess_dir = sessions.dir / scene["session_id"]
    if not sess_dir.exists():
        scene["session_missing"] = True
        return scene

    base = f"/cache/sessions/{scene['session_id']}"
    assets = {
        "original_png_url": f"{base}/original.png",
        "depth_png_url":    f"{base}/depth.png",
        "normals_png_url":  f"{base}/normals.png",
    }
    if (sess_dir / "mask.png").exists():
        assets["mask_png_url"] = f"{base}/mask.png"
    if (sess_dir / "confidence.png").exists():
        assets["confidence_png_url"] = f"{base}/confidence.png"
    if (sess_dir / "thumb.jpg").exists():
        assets["thumbnail_url"] = f"{base}/thumb.jpg"
    scene["assets"] = assets

    meta_path = sess_dir / "meta.json"
    if meta_path.exists():
        meta = json.loads(meta_path.read_text())
        scene["width"]  = meta.get("width")
        scene["height"] = meta.get("height")
        scene["session_metadata"] = meta.get("metadata") or {}
    return scene


@router.put("/{scene_id}")
async def update_scene(scene_id: str, req: UpdateSceneRequest, request: Request) -> dict[str, bool]:
    if not request.app.state.scenes.update_state(
        scene_id, req.state, workspace_id=_workspace(request),
    ):
        raise HTTPException(status_code=404, detail="scene not found")
    return {"ok": True}


@router.patch("/{scene_id}/name")
async def rename_scene(
    scene_id: str, req: RenameSceneRequest, request: Request,
) -> dict[str, bool]:
    if not request.app.state.scenes.rename(
        scene_id, req.name.strip(), workspace_id=_workspace(request),
    ):
        raise HTTPException(status_code=404, detail="scene not found")
    return {"ok": True}


@router.delete("/{scene_id}")
async def delete_scene(scene_id: str, request: Request) -> dict[str, bool]:
    if not request.app.state.scenes.delete(scene_id, workspace_id=_workspace(request)):
        raise HTTPException(status_code=404, detail="scene not found")
    return {"ok": True}


# ─── Calibration cross-check ────────────────────────────────────────────────

class CalibrationCheckRequest(BaseModel):
    calibration: CalibrationModel


@router.post("/{scene_id}/calibration/check")
async def check_calibration(
    scene_id: str, req: CalibrationCheckRequest, request: Request,
) -> dict[str, Any]:
    """Optional metric-depth cross-check of a stage calibration.

    Answers ``{available: false, median_error_pct: null}`` whenever the metric
    checkpoint is not installed (the default), without touching the scene.
    """
    from relighting_engine.depth import metric_check
    if not metric_check.available():
        return {"available": False, "median_error_pct": None}
    scene = request.app.state.scenes.get(scene_id, workspace_id=_workspace(request))
    if scene is None:
        raise HTTPException(status_code=404, detail="scene not found")
    sessions = request.app.state.sessions
    prepared = sessions.get(scene["session_id"])
    if prepared is None:
        raise HTTPException(status_code=409, detail="image session missing")
    cal = req.calibration.to_engine(prepared.height / prepared.width)
    # Same per-session lock the render routes take, so the metric model never
    # runs alongside a render on the same session; any failure inside the
    # model is "no opinion", never an error (spec §Error handling).
    async with sessions.lock(scene["session_id"]):
        try:
            result = await run_in_threadpool(metric_check.compare, prepared, cal, req.calibration.marks)
        except Exception:  # noqa: BLE001
            logger.warning("calibration cross-check failed for scene %s", scene_id, exc_info=True)
            return {"available": False, "median_error_pct": None}
    return {
        "available": result is not None,
        "median_error_pct": result["median_error_pct"] if result else None,
    }


# ─── Export / Import ────────────────────────────────────────────────────────

def _safe_filename(name: str) -> str:
    return re.sub(r"[^A-Za-z0-9_-]+", "_", name).strip("_") or "scene"


@router.get("/{scene_id}/export")
async def export_scene(scene_id: str, request: Request) -> Response:
    """Return a .relight.zip with scene.json + source image + thumb."""
    scene = request.app.state.scenes.get(scene_id, workspace_id=_workspace(request))
    if scene is None:
        raise HTTPException(status_code=404, detail="scene not found")
    sessions = request.app.state.sessions
    sess_dir = sessions.dir / scene["session_id"]
    if not sess_dir.exists():
        raise HTTPException(status_code=409, detail="image session missing — cannot export")

    source_files = sorted(sess_dir.glob("source.*"))
    if not source_files:
        raise HTTPException(status_code=409, detail="source image missing from session")
    source = source_files[0]

    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        # The exported manifest carries name + state only — recipient regenerates
        # ids/timestamps and runs /prepare on the source image to produce a
        # fresh session.
        z.writestr("scene.json", json.dumps({
            "name":  scene["name"],
            "state": scene["state"],
            "version": 1,
        }))
        z.write(source, source.name)
        thumb = sess_dir / "thumb.jpg"
        if thumb.exists():
            z.write(thumb, "thumb.jpg")

    fname = f"{_safe_filename(scene['name'])}.relight.zip"
    return Response(
        content=buf.getvalue(),
        media_type="application/zip",
        headers={"Content-Disposition": f'attachment; filename="{fname}"'},
    )


@router.post("/import")
async def import_scene(
    request: Request,
    file: UploadFile = File(...),
) -> dict[str, Any]:
    """Accept a .relight.zip; re-prepare the bundled image; create a scene."""
    raw = await file.read()
    try:
        zf = zipfile.ZipFile(io.BytesIO(raw))
    except zipfile.BadZipFile as e:
        raise HTTPException(status_code=400, detail=f"not a valid zip: {e}") from e

    names = set(zf.namelist())
    if "scene.json" not in names:
        raise HTTPException(status_code=400, detail="zip missing scene.json")
    source_name = next((n for n in names if n.startswith("source.")), None)
    if source_name is None:
        raise HTTPException(status_code=400, detail="zip missing source image")

    try:
        manifest = json.loads(zf.read("scene.json").decode("utf-8"))
    except (json.JSONDecodeError, UnicodeDecodeError) as e:
        raise HTTPException(status_code=400, detail=f"scene.json is not valid JSON: {e}") from e
    name = (manifest.get("name") or "").strip() or "Imported scene"
    state = manifest.get("state") or {}
    if not isinstance(state, dict):
        raise HTTPException(status_code=400, detail="scene.json: state must be an object")

    image_bytes = zf.read(source_name)

    # Re-prepare the image on this server (engine-version-agnostic import).
    from relighting_api.routes.prepare import prepare_image_bytes
    engine = getattr(request.app.state, "engine", None)
    if engine is None:
        from relighting_api.deps import get_engine
        engine = get_engine()
    prepared = prepare_image_bytes(
        image_bytes, engine=engine, sessions=request.app.state.sessions,
    )
    return request.app.state.scenes.create(
        name=name,
        session_id=prepared.session_id,
        state=state,
        workspace_id=_workspace(request),
    )
