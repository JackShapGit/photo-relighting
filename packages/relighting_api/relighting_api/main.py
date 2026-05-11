"""FastAPI app factory. The factory pattern lets tests skip engine init."""
from __future__ import annotations

import os
from pathlib import Path

from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles

from relighting_api.routes import gobos as gobos_route
from relighting_api.routes import health as health_route
from relighting_api.routes import polish as polish_route
from relighting_api.routes import prepare as prepare_route
from relighting_api.routes import refine as refine_route
from relighting_api.routes import render as render_route
from relighting_api.routes import scenes as scenes_route
from relighting_api.routes import session as session_route
from relighting_api.scene_store import SceneStore
from relighting_api.session_store import SessionStore

def create_app(skip_engine: bool = False) -> FastAPI:
    # Read paths inside the factory so test fixtures can monkeypatch the env
    # vars before instantiation. Defaults match the production layout.
    cache_dir = Path(os.environ.get("RELIGHT_CACHE_DIR", "cache/sessions"))
    scenes_db = Path(os.environ.get("RELIGHT_SCENES_DB", "cache/scenes.db"))

    app = FastAPI(title="relighting-api", version="0.1.0")
    app.state.sessions = SessionStore(cache_dir=cache_dir)
    app.state.scenes = SceneStore(db_path=scenes_db)

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
    app.state.capabilities = {
        "polish": polish_available,
        "segmenters": ["rmbg", "sam2"],
    }

    app.state.skip_engine = skip_engine

    app.include_router(health_route.router)
    app.include_router(gobos_route.router)
    app.include_router(polish_route.router)
    app.include_router(prepare_route.router)
    app.include_router(refine_route.router)
    app.include_router(render_route.router)
    app.include_router(scenes_route.router)
    app.include_router(session_route.router)

    # Serve gobo PNGs and per-session asset PNGs.
    static_root = (
        Path(__file__).resolve().parents[2]
        / "relighting_engine" / "relighting_engine" / "assets"
    )
    if static_root.exists():
        app.mount("/static", StaticFiles(directory=static_root), name="static")
    cache_root = cache_dir.parent if cache_dir.name == "sessions" else cache_dir
    cache_root.mkdir(parents=True, exist_ok=True)
    app.mount("/cache", StaticFiles(directory=str(cache_root)), name="cache")

    web_dir = Path(__file__).resolve().parents[3] / "web"
    if web_dir.exists():
        app.mount("/web", StaticFiles(directory=str(web_dir), html=True), name="web")

    return app


app = create_app()
