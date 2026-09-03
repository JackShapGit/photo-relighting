"""FastAPI app factory. The factory pattern lets tests skip engine init."""
from __future__ import annotations

import math
import os
from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles

from relighting_api import auth
from relighting_api.routes import gobos as gobos_route
from relighting_api.routes import health as health_route
from relighting_api.routes import layers as layers_route
from relighting_api.routes import polish as polish_route
from relighting_api.routes import prepare as prepare_route
from relighting_api.routes import refine as refine_route
from relighting_api.routes import render as render_route
from relighting_api.routes import scenes as scenes_route
from relighting_api.routes import session as session_route
from relighting_api.routes import venues as venues_route
from relighting_api.scene_store import SceneStore
from relighting_api.session_store import SessionStore
from relighting_api.venue_store import VenueStore

def _finite(obj):
    """Replace non-finite floats (and non-JSON objects) so an error body encodes."""
    if isinstance(obj, float):
        return obj if math.isfinite(obj) else str(obj)
    if isinstance(obj, dict):
        return {k: _finite(v) for k, v in obj.items()}
    if isinstance(obj, (list, tuple)):
        return [_finite(v) for v in obj]
    if isinstance(obj, (str, int, bool)) or obj is None:
        return obj
    return str(obj)


class _RevalidatingStaticFiles(StaticFiles):
    """StaticFiles that forces a conditional request on every asset.

    Starlette sends ETag and Last-Modified but no Cache-Control. With no
    directive, browsers fall back to HEURISTIC freshness and will reuse a
    cached ES module for a long stretch WITHOUT revalidating -- so a shipped
    UI change never reaches anyone who has visited before, even in a new tab.
    That is not theoretical: it silently hid a file-picker fix here.

    "no-cache" does not mean "do not store" -- it means "revalidate before
    reuse". The ETag still turns the check into a cheap 304, so this costs one
    round trip per asset rather than re-downloading anything.
    """

    def file_response(self, *args, **kwargs):  # type: ignore[override]
        resp = super().file_response(*args, **kwargs)
        resp.headers.setdefault("Cache-Control", "no-cache")
        return resp


def create_app(skip_engine: bool = False) -> FastAPI:
    # Read paths inside the factory so test fixtures can monkeypatch the env
    # vars before instantiation. Defaults match the production layout.
    cache_dir = Path(os.environ.get("RELIGHT_CACHE_DIR", "cache/sessions"))
    scenes_db = Path(os.environ.get("RELIGHT_SCENES_DB", "cache/scenes.db"))

    app = FastAPI(title="relighting-api", version="0.1.0")
    auth.install(app)

    @app.exception_handler(RequestValidationError)
    async def _validation_error(request: Request, exc: RequestValidationError) -> JSONResponse:
        # FastAPI echoes the offending input in the 422 body; a NaN/Infinity
        # float there is not JSON-encodable and would turn the 422 into a 500.
        return JSONResponse(status_code=422, content={"detail": _finite(exc.errors())})
    app.state.sessions = SessionStore(cache_dir=cache_dir)
    app.state.scenes = SceneStore(db_path=scenes_db)
    # Venues share the scenes database file so the delete guard can count
    # referencing scenes in one query.
    app.state.venues = VenueStore(db_path=scenes_db)

    # Detect optional capabilities once at startup. Polish requires the
    # [diffusion] extra + GPU + enough free VRAM; if any check fails the
    # /polish route returns 501 and the frontend hides the Polish UI.
    polish_available = False
    if not skip_engine:
        try:
            from relighting_engine.polish.capabilities import is_available
            polish_available = is_available()
        except ImportError:
            polish_available = False
    layers_available = False
    try:
        import pytoshop  # noqa: F401
        layers_available = True
    except ImportError:
        layers_available = False
    app.state.capabilities = {
        "polish": polish_available,
        "layers_export": layers_available,
        "segmenters": ["rmbg", "sam2"],
    }

    app.state.skip_engine = skip_engine

    app.include_router(health_route.router)
    app.include_router(gobos_route.router)
    app.include_router(polish_route.router)
    app.include_router(prepare_route.router)
    app.include_router(refine_route.router)
    app.include_router(render_route.router)
    app.include_router(layers_route.router)
    app.include_router(scenes_route.router)
    app.include_router(venues_route.router)
    app.include_router(session_route.router)

    # Serve gobo PNGs and per-session asset PNGs.
    static_root = (
        Path(__file__).resolve().parents[2]
        / "relighting_engine" / "relighting_engine" / "assets"
    )
    if static_root.exists():
        app.mount("/static", _RevalidatingStaticFiles(directory=static_root), name="static")
    cache_root = cache_dir.parent if cache_dir.name == "sessions" else cache_dir
    cache_root.mkdir(parents=True, exist_ok=True)
    app.mount("/cache", StaticFiles(directory=str(cache_root)), name="cache")

    web_dir = Path(__file__).resolve().parents[3] / "web"
    if web_dir.exists():
        app.mount("/web", _RevalidatingStaticFiles(directory=str(web_dir), html=True), name="web")

    return app


app = create_app()
