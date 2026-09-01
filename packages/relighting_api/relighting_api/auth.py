"""Shared-secret access control for tunnel-exposed deployments.

Installed by ``install(app)`` only when ``RELIGHT_DEMO_PASSWORD`` is set in the
environment. Absent -> no-op, so local dev and tests are unaffected.

Three ways in, checked in this order:

1. **Session cookie** -- set by (2), so the secret leaves the URL after the
   first request.
2. **``?k=<password>`` in the query string** -- the link IS the credential.
   On a match the middleware sets the cookie and 303s to the same URL with
   ``k`` stripped, so the secret does not linger in the address bar, in later
   history entries, or in ``Referer`` headers to third parties.
3. **HTTP Basic** -- retained so existing links, curl invocations and scripts
   keep working.

No ``WWW-Authenticate`` header is ever sent. That header is precisely what
makes a browser raise its native sign-in dialog, and the goal here is a demo
link a recipient can click with nothing to type. A failed request therefore
gets a plain 401 page instead of a prompt.

The cookie stores a digest of the password, never the password itself, so a
copy of the cookie does not hand over the shared secret. ``Secure`` is set
only when the request actually arrived over HTTPS (honouring
``X-Forwarded-Proto`` from the tunnel), so plain-http local use still works.
"""
from __future__ import annotations

import base64
import hashlib
import os
import secrets

from starlette.middleware.base import BaseHTTPMiddleware
from starlette.responses import RedirectResponse, Response
from starlette.types import ASGIApp

COOKIE_NAME = "relight_demo"
QUERY_PARAM = "k"
COOKIE_MAX_AGE = 60 * 60 * 24 * 30  # 30 days

_DENIED_HTML = (
    "<!doctype html><meta charset=utf-8><title>Not authorised</title>"
    "<style>body{font:15px/1.5 system-ui,sans-serif;margin:15vh auto;max-width:32rem;"
    "padding:0 1.5rem;color:#222}h1{font-size:1.1rem}code{background:#f1f0ee;"
    "padding:.1rem .35rem;border-radius:3px}</style>"
    "<h1>Not authorised</h1><p>This demo needs the access link. Ask whoever "
    "shared it for the full URL, including the <code>?k=</code> part.</p>"
)


def _digest(password: str) -> str:
    return hashlib.sha256(f"relight-demo-v1:{password}".encode("utf-8")).hexdigest()


class SharedPasswordMiddleware(BaseHTTPMiddleware):
    def __init__(self, app: ASGIApp, password: str) -> None:
        super().__init__(app)
        self._password = password
        self._cookie_value = _digest(password)

    def _cookie_ok(self, request) -> bool:
        supplied = request.cookies.get(COOKIE_NAME, "")
        return bool(supplied) and secrets.compare_digest(supplied, self._cookie_value)

    def _basic_ok(self, request) -> bool:
        header = request.headers.get("authorization", "")
        if not header.startswith("Basic "):
            return False
        try:
            decoded = base64.b64decode(header[6:], validate=True).decode("utf-8", "replace")
            _, _, supplied = decoded.partition(":")
        except Exception:  # noqa: BLE001 -- any decode failure means unauthorized
            return False
        return secrets.compare_digest(supplied, self._password)

    @staticmethod
    def _denied() -> Response:
        # Deliberately no WWW-Authenticate -- see module docstring.
        return Response(status_code=401, content=_DENIED_HTML, media_type="text/html")

    async def dispatch(self, request, call_next):
        if self._cookie_ok(request):
            return await call_next(request)

        token = request.query_params.get(QUERY_PARAM)
        if token is not None:
            if not secrets.compare_digest(token, self._password):
                return self._denied()
            clean = request.url.remove_query_params(QUERY_PARAM)
            # Relative target: behind the tunnel the app sees http://<host>,
            # so echoing an absolute URL would downgrade the scheme.
            target = clean.path + (f"?{clean.query}" if clean.query else "")
            response = RedirectResponse(url=target, status_code=303)
            forwarded = request.headers.get("x-forwarded-proto", request.url.scheme)
            response.set_cookie(
                COOKIE_NAME,
                self._cookie_value,
                max_age=COOKIE_MAX_AGE,
                httponly=True,
                secure=(forwarded == "https"),
                samesite="lax",
                path="/",
            )
            return response

        if self._basic_ok(request):
            return await call_next(request)

        return self._denied()


def install(app) -> None:
    """Install the middleware on ``app`` if RELIGHT_DEMO_PASSWORD is set."""
    password = os.environ.get("RELIGHT_DEMO_PASSWORD")
    if password:
        app.add_middleware(SharedPasswordMiddleware, password=password)
