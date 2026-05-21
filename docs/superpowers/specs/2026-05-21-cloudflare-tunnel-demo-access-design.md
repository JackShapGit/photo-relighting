# Cloudflare Tunnel Demo Access — Design

**Status:** approved (brainstorming)
**Date:** 2026-05-21
**Author:** Jack Shapiro (with Claude)

## Goal

Expose the photo-relighting FastAPI app at a stable, branded HTTPS URL so a small audience (friends, clients, collaborators) can reach it for occasional demos. The GPU stays on the existing Windows workstation; access is gated by a shared password.

Not in scope: always-on multi-user service, scaling beyond one GPU, hosted/remote-GPU deployment.

## Approach

Cloudflare Tunnel + custom domain + app-level HTTP Basic Auth.

- Cloudflare's `cloudflared` agent runs as a Windows service on the dev PC. It dials out to Cloudflare's edge over QUIC and forwards requests to `http://localhost:8000`.
- A Cloudflare-registered domain (~$10/yr) provides the public hostname `relight.<domain>` via a DNS-routed tunnel CNAME.
- A shared-password HTTP Basic Auth middleware in the FastAPI app gates all traffic. The middleware is gated on `RELIGHT_DEMO_PASSWORD`; when unset (local dev, tests), it is not installed and behavior is unchanged.

Rejected alternatives:
- **ngrok with reserved domain** — works fine but $8–18/mo for the equivalent feature set vs $10/yr for the domain alone.
- **Router port-forward + Caddy + Let's Encrypt** — exposes home IP, requires router admin, ISP/CGNAT risk, larger attack surface. Not justified for personal demo scope.

## Architecture

```
[guest browser]
    │  HTTPS to https://relight.<yourdomain>
    ▼
[Cloudflare edge]      (TLS termination, DDoS, caching off)
    │
    │  outbound QUIC tunnel ── initiated FROM the dev PC
    ▼
[cloudflared, Windows service]
    │  HTTP to 127.0.0.1:8000
    ▼
[uvicorn + FastAPI app]
    │  ← SharedPasswordMiddleware (when RELIGHT_DEMO_PASSWORD is set)
    ▼
[existing routes: /render /polish /prepare /web/* /static/* /cache/*]
```

The uvicorn server continues to bind to `127.0.0.1:8000`. The tunnel is the only inbound path. No router changes, no inbound ports opened, no public IP exposed.

## Components

### 1. Cloudflare account, domain, and tunnel (one-time setup)

Performed once, manually, via the runbook in `docs/deployment/cloudflare-tunnel.md` (to be authored during implementation).

Steps:
1. Register a domain at Cloudflare Registrar.
2. Install `cloudflared` for Windows from the official GitHub releases.
3. `cloudflared tunnel login` to mint a cert into `%USERPROFILE%\.cloudflared\`.
4. `cloudflared tunnel create relight` to mint a tunnel UUID and credentials JSON.
5. Author `%USERPROFILE%\.cloudflared\config.yml`:
   ```yaml
   tunnel: <UUID>
   credentials-file: C:\Users\Owner\.cloudflared\<UUID>.json
   ingress:
     - hostname: relight.<yourdomain>
       service: http://localhost:8000
     - service: http_status:404
   ```
6. `cloudflared tunnel route dns relight relight.<yourdomain>` to publish the CNAME.
7. `cloudflared service install` to register the Windows service (auto-start at boot, restart on crash).

### 2. SharedPasswordMiddleware

New file: `packages/relighting_api/relighting_api/auth.py`.

```python
"""Shared-password HTTP Basic Auth for tunnel-exposed deployments.

Enabled only when RELIGHT_DEMO_PASSWORD is set; absent → no-op so local dev
and tests are unaffected. Compares with secrets.compare_digest to dodge
timing attacks.
"""
from __future__ import annotations

import base64
import os
import secrets

from starlette.middleware.base import BaseHTTPMiddleware
from starlette.responses import Response


class SharedPasswordMiddleware(BaseHTTPMiddleware):
    def __init__(self, app, password: str) -> None:
        super().__init__(app)
        self._password = password

    async def dispatch(self, request, call_next):
        header = request.headers.get("authorization", "")
        if header.startswith("Basic "):
            try:
                decoded = base64.b64decode(header[6:]).decode("utf-8", "replace")
                _, _, supplied = decoded.partition(":")
            except Exception:
                supplied = ""
            if secrets.compare_digest(supplied, self._password):
                return await call_next(request)

        return Response(
            status_code=401,
            headers={"WWW-Authenticate": 'Basic realm="relight"'},
        )


def install(app) -> None:
    password = os.environ.get("RELIGHT_DEMO_PASSWORD")
    if password:
        app.add_middleware(SharedPasswordMiddleware, password=password)
```

Edit: `packages/relighting_api/relighting_api/main.py`, inside `create_app`, immediately after `app = FastAPI(...)`:
```python
from relighting_api import auth
auth.install(app)
```

Design notes:
- **Env-var gated.** No `RELIGHT_DEMO_PASSWORD` set → middleware not installed → zero behavior change for local dev, tests, and the existing `start.bat` flow.
- **Single password, username ignored.** Guests are told to type anything for username. The URL plus one secret is all they need.
- **No localhost bypass.** When `RELIGHT_DEMO_PASSWORD` is set, every request is gated. The dev environment simply does not set the env var.
- **`secrets.compare_digest`** for the comparison to avoid timing leaks.

### 3. Demo startup scripts and env

New file: `start-demo.bat` (repo root) — analogous to `start.bat` but loads `.env.demo` and invokes `scripts/run_demo.bat`.

New file: `scripts/run_demo.bat` — analogous to `scripts/run_dev.bat` but without `--reload`. `--reload` complicates a long-running tunnel-exposed process and provides no value when the audience is not editing code.

New file: `.env.demo.example` (committed, blank):
```
RELIGHT_DEMO_PASSWORD=
```

`.env.demo` is the live file with the real password. Added to `.gitignore`.

Password generation one-liner (PowerShell, documented in runbook):
```powershell
-join ((48..57) + (65..90) + (97..122) | Get-Random -Count 20 | ForEach-Object {[char]$_})
```

### 4. Operational runbook

New file: `docs/deployment/cloudflare-tunnel.md`. Covers:
- One-time setup steps from §1.
- Daily use: `start-demo.bat`, share URL + password, close window when done.
- Password rotation: edit `.env.demo`, restart app; no tunnel restart needed.
- Troubleshooting ladder: `Get-Service cloudflared` → `cloudflared tunnel info relight` → check DNS propagation → check app on `:8000`.

## Operational behavior

- **App and tunnel run as independent processes.** Tunnel is always on (service). App runs only during demos (manual launch).
- **Idle state during off hours:** tunnel up, app down → guests get HTTP 502 from Cloudflare. Acceptable — no GPU exposure when the operator isn't running the app.
- **After PC reboot:** tunnel auto-restarts; app does not. Demos are scheduled, so manual app launch is acceptable.
- **No metrics, no dashboards.** App logs to stdout as today.

## Known constraints

- **Cloudflare free-plan request body limit: 100 MB.** Guests uploading huge RAW files will hit 413. JPEGs under ~50 MB are fine. Documented in the runbook; not redesigned around.
- **Cloudflare default response timeout: 100 s.** Polish/diffusion is 5–15 s typical per `routes/polish.py` docstring; well within budget. Edge cases (very large output resolution) could approach the limit. If this becomes a real problem, the followup is an async job pattern with polling — out of scope for this design.
- **Cloudflare outages** take the demo down. Rare; nothing to do.

## Success criteria

1. From a phone on cellular, `https://relight.<domain>` returns an HTTP Basic Auth prompt.
2. Submitting the correct password loads the WebGL playground.
3. Submitting the wrong password keeps the prompt visible; no app content is reachable.
4. A `/render` call completes end-to-end through the tunnel and the result renders in the playground.
5. A `/polish` call completes end-to-end through the tunnel.
6. After a Windows reboot, `cloudflared` is running automatically (verified via `Get-Service cloudflared`).
7. Local dev — running `start.bat` with no `RELIGHT_DEMO_PASSWORD` in the environment — shows no auth prompt and behaves identically to today.

## Explicit non-goals

- Multi-user auth, per-user accounts, OAuth, email allowlists.
- Per-user quotas, rate limiting, abuse detection.
- Observability beyond app stdout.
- HTTPS cert management (Cloudflare handles it).
- CORS configuration (single-origin, not needed).
- Async job queue or polling pattern for long requests.
- Hosted/remote GPU deployment (the May 21 RunPod investigation remains separate).
- Chunked or resumable uploads.
- Auto-start of the FastAPI app at boot.

## File-by-file change list

New:
- `packages/relighting_api/relighting_api/auth.py`
- `start-demo.bat`
- `scripts/run_demo.bat`
- `.env.demo.example`
- `docs/deployment/cloudflare-tunnel.md`

Edited:
- `packages/relighting_api/relighting_api/main.py` — add `auth.install(app)` after `FastAPI(...)`.
- `.gitignore` — add `.env.demo`.
