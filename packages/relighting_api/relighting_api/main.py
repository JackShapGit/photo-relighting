"""FastAPI app factory. The factory pattern lets tests skip engine init."""
from __future__ import annotations

import os
from pathlib import Path

from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles

from relighting_api.routes import gobos as gobos_route
from relighting_api.routes import health as health_route
from relighting_api.routes import prepare as prepare_route
from relighting_api.routes import render as render_route
from relighting_api.routes import session as session_route
from relighting_api.session_store import SessionStore

CACHE_DIR = Path(os.environ.get("RELIGHT_CACHE_DIR", "cache/sessions"))


def create_app(skip_engine: bool = False) -> FastAPI:
    app = FastAPI(title="relighting-api", version="0.1.0")
    app.state.sessions = SessionStore(cache_dir=CACHE_DIR)
    app.state.skip_engine = skip_engine

    app.include_router(health_route.router)
    app.include_router(gobos_route.router)
    app.include_router(prepare_route.router)
    app.include_router(render_route.router)
    app.include_router(session_route.router)

    # Serve gobo PNGs and per-session asset PNGs.
    static_root = (
        Path(__file__).resolve().parents[2]
        / "relighting_engine" / "relighting_engine" / "assets"
    )
    if static_root.exists():
        app.mount("/static", StaticFiles(directory=static_root), name="static")
    cache_root = CACHE_DIR.parent if CACHE_DIR.name == "sessions" else CACHE_DIR
    cache_root.mkdir(parents=True, exist_ok=True)
    app.mount("/cache", StaticFiles(directory=str(cache_root)), name="cache")

    web_dir = Path(__file__).resolve().parents[3] / "web"
    if web_dir.exists():
        app.mount("/web", StaticFiles(directory=str(web_dir), html=True), name="web")

    return app


app = create_app()
