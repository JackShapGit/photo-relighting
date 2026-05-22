"""Shared-password HTTP Basic Auth for tunnel-exposed deployments.

Installed by ``install(app)`` only when ``RELIGHT_DEMO_PASSWORD`` is set in
the environment. Absent → no-op so local dev and tests are unaffected.

Compares the supplied password with ``secrets.compare_digest`` to avoid
timing side-channels. Username is ignored: any string is accepted so the
URL-plus-password is the only shared secret guests need.
"""
from __future__ import annotations

import base64
import os
import secrets

from starlette.middleware.base import BaseHTTPMiddleware
from starlette.responses import Response
from starlette.types import ASGIApp


class SharedPasswordMiddleware(BaseHTTPMiddleware):
    def __init__(self, app: ASGIApp, password: str) -> None:
        super().__init__(app)
        self._password = password

    async def dispatch(self, request, call_next):
        header = request.headers.get("authorization", "")
        if header.startswith("Basic "):
            try:
                decoded = base64.b64decode(header[6:], validate=True).decode(
                    "utf-8", "replace"
                )
                _, _, supplied = decoded.partition(":")
            except Exception:  # noqa: BLE001 — any decode failure means unauthorized
                supplied = ""
            if secrets.compare_digest(supplied, self._password):
                return await call_next(request)

        return Response(
            status_code=401,
            headers={"WWW-Authenticate": 'Basic realm="relight"'},
        )


def install(app) -> None:
    """Install the middleware on ``app`` if RELIGHT_DEMO_PASSWORD is set."""
    password = os.environ.get("RELIGHT_DEMO_PASSWORD")
    if password:
        app.add_middleware(SharedPasswordMiddleware, password=password)
