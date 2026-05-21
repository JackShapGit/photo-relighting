# Cloudflare Tunnel Demo Access Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expose the photo-relighting FastAPI app at a stable HTTPS URL (`https://relight.<yourdomain>`) via Cloudflare Tunnel, gated by a shared password, so a small audience can reach demos without touching the router or exposing the home IP.

**Architecture:** A Cloudflare-Registrar domain + `cloudflared` Windows service forwards `localhost:8000` traffic out to Cloudflare's edge. A new `SharedPasswordMiddleware` in `relighting_api`, installed only when `RELIGHT_DEMO_PASSWORD` is set, gates every request with HTTP Basic Auth. Demo runs are launched via a new `start-demo.bat` that loads `.env.demo` and invokes a non-reload uvicorn. Local dev is untouched because no env var → no middleware.

**Tech Stack:** Python 3.11, FastAPI, Starlette (BaseHTTPMiddleware), uvicorn, pytest, Cloudflare Tunnel (`cloudflared`), Windows batch scripts.

**Spec:** `docs/superpowers/specs/2026-05-21-cloudflare-tunnel-demo-access-design.md`.

---

## Task 1: SharedPasswordMiddleware unit tests

We test the middleware before writing it. The middleware is fully synchronous in its decision logic (env-var read happens at install time, not per-request), so the tests just need a FastAPI app with the middleware attached and a `TestClient`.

**Files:**
- Create: `packages/relighting_api/tests/api/test_auth_middleware.py`

- [ ] **Step 1: Write failing tests**

Create `packages/relighting_api/tests/api/test_auth_middleware.py` with the following contents:

```python
"""Tests for the shared-password Basic Auth middleware.

The middleware is installed at app-factory time when RELIGHT_DEMO_PASSWORD is
set in the environment. These tests use monkeypatch to set/unset the env var
around create_app() calls.
"""
from __future__ import annotations

import base64

from fastapi.testclient import TestClient

from relighting_api.main import create_app


def _basic_auth_header(password: str, username: str = "demo") -> dict[str, str]:
    raw = f"{username}:{password}".encode("utf-8")
    return {"Authorization": "Basic " + base64.b64encode(raw).decode("ascii")}


def test_no_env_var_means_no_auth_required(monkeypatch) -> None:
    monkeypatch.delenv("RELIGHT_DEMO_PASSWORD", raising=False)
    client = TestClient(create_app(skip_engine=True))
    r = client.get("/healthz")
    assert r.status_code == 200


def test_env_var_set_unauthenticated_request_returns_401(monkeypatch) -> None:
    monkeypatch.setenv("RELIGHT_DEMO_PASSWORD", "hunter2")
    client = TestClient(create_app(skip_engine=True))
    r = client.get("/healthz")
    assert r.status_code == 401
    assert r.headers.get("www-authenticate", "").lower().startswith("basic")


def test_env_var_set_correct_password_allows_request(monkeypatch) -> None:
    monkeypatch.setenv("RELIGHT_DEMO_PASSWORD", "hunter2")
    client = TestClient(create_app(skip_engine=True))
    r = client.get("/healthz", headers=_basic_auth_header("hunter2"))
    assert r.status_code == 200


def test_env_var_set_wrong_password_returns_401(monkeypatch) -> None:
    monkeypatch.setenv("RELIGHT_DEMO_PASSWORD", "hunter2")
    client = TestClient(create_app(skip_engine=True))
    r = client.get("/healthz", headers=_basic_auth_header("wrong"))
    assert r.status_code == 401


def test_env_var_set_username_is_ignored(monkeypatch) -> None:
    monkeypatch.setenv("RELIGHT_DEMO_PASSWORD", "hunter2")
    client = TestClient(create_app(skip_engine=True))
    r = client.get("/healthz", headers=_basic_auth_header("hunter2", username="anything"))
    assert r.status_code == 200


def test_env_var_set_malformed_authorization_header_returns_401(monkeypatch) -> None:
    monkeypatch.setenv("RELIGHT_DEMO_PASSWORD", "hunter2")
    client = TestClient(create_app(skip_engine=True))
    r = client.get("/healthz", headers={"Authorization": "Basic !!!not-base64!!!"})
    assert r.status_code == 401


def test_env_var_set_non_basic_scheme_returns_401(monkeypatch) -> None:
    monkeypatch.setenv("RELIGHT_DEMO_PASSWORD", "hunter2")
    client = TestClient(create_app(skip_engine=True))
    r = client.get("/healthz", headers={"Authorization": "Bearer some-token"})
    assert r.status_code == 401
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pytest packages/relighting_api/tests/api/test_auth_middleware.py -v`

Expected: All 7 tests FAIL. The "no env var" test passes if the import succeeds, but the 6 env-var-set tests fail because there is no middleware yet — they all hit `/healthz` and get 200 instead of 401.

(If `test_no_env_var_means_no_auth_required` is the only one passing, that's fine — it's testing that absence-of-env-var is a no-op, which is true today.)

- [ ] **Step 3: Commit the failing tests**

```
git add packages/relighting_api/tests/api/test_auth_middleware.py
git commit -m "test(api): failing tests for shared-password Basic Auth middleware"
```

---

## Task 2: Implement SharedPasswordMiddleware

**Files:**
- Create: `packages/relighting_api/relighting_api/auth.py`
- Modify: `packages/relighting_api/relighting_api/main.py`

- [ ] **Step 1: Create the middleware module**

Create `packages/relighting_api/relighting_api/auth.py` with the following contents:

```python
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
```

- [ ] **Step 2: Wire the middleware into create_app**

Edit `packages/relighting_api/relighting_api/main.py`. Add an import alongside the existing route imports near the top:

```python
from relighting_api import auth
```

Then, inside `create_app`, immediately after the line `app = FastAPI(title="relighting-api", version="0.1.0")` (currently line 27), insert:

```python
    auth.install(app)
```

The surrounding context after the edit should read:

```python
    app = FastAPI(title="relighting-api", version="0.1.0")
    auth.install(app)
    app.state.sessions = SessionStore(cache_dir=cache_dir)
```

- [ ] **Step 3: Run the new tests**

Run: `pytest packages/relighting_api/tests/api/test_auth_middleware.py -v`

Expected: all 7 tests PASS.

- [ ] **Step 4: Run the full API test suite to verify no regressions**

Run: `pytest packages/relighting_api/tests/api -v`

Expected: all tests pass. Specifically, the pre-existing tests in `test_health_and_gobos.py`, `test_render.py`, etc., must still pass — they should, because none of them set `RELIGHT_DEMO_PASSWORD` and the middleware is install-time-gated, so it never attaches in those tests.

- [ ] **Step 5: Commit**

```
git add packages/relighting_api/relighting_api/auth.py packages/relighting_api/relighting_api/main.py
git commit -m "feat(api): shared-password Basic Auth middleware for tunnel deployments"
```

---

## Task 3: Demo startup scripts and gitignored env file

Mirror the existing `start.bat` / `scripts/run_dev.bat` pattern but for a tunnel-facing run: no `--reload`, and `RELIGHT_DEMO_PASSWORD` loaded from `.env.demo`.

**Files:**
- Create: `scripts/run_demo.bat`
- Create: `start-demo.bat`
- Create: `.env.demo.example`
- Modify: `.gitignore`

- [ ] **Step 1: Add `.env.demo` to .gitignore**

Open `.gitignore`. Find the `# Project` section. Append `.env.demo` so the section reads:

```
# Project
cache/
~/.cache/relighting_engine/
node_modules/
.playwright/
test-results/
playwright-report/
.env.demo
```

- [ ] **Step 2: Create the example env file (committed, blank)**

Create `.env.demo.example`:

```
# Copy to .env.demo and set a strong password before running start-demo.bat.
# Generate one in PowerShell:
#   -join ((48..57) + (65..90) + (97..122) | Get-Random -Count 20 | ForEach-Object {[char]$_})
RELIGHT_DEMO_PASSWORD=
```

- [ ] **Step 3: Create the run script (no --reload)**

Create `scripts/run_demo.bat`:

```
@echo off
REM Activate venv, then start uvicorn for tunnel-facing demo use (no --reload).
setlocal
set "ROOT=%~dp0.."
call "%ROOT%\.venv\Scripts\activate.bat" || exit /b 1
set "RELIGHT_CACHE_DIR=%ROOT%\cache\sessions"
uvicorn relighting_api.main:app --host 127.0.0.1 --port 8000
endlocal
```

- [ ] **Step 4: Create the demo entry point that loads `.env.demo`**

Create `start-demo.bat` in the repo root:

```
@echo off
REM Launch the photo-relighting server for Cloudflare-Tunnel-facing demo use.
REM Loads RELIGHT_DEMO_PASSWORD from .env.demo and starts uvicorn (no reload).
setlocal EnableDelayedExpansion
set "ROOT=%~dp0"

if not exist "%ROOT%.env.demo" (
    echo ERROR: .env.demo not found. Copy .env.demo.example to .env.demo and set RELIGHT_DEMO_PASSWORD.
    exit /b 1
)

for /f "usebackq tokens=1,* delims==" %%A in ("%ROOT%.env.demo") do (
    set "key=%%A"
    set "val=%%B"
    if not "!key:~0,1!"=="#" if not "!key!"=="" set "!key!=!val!"
)

if "!RELIGHT_DEMO_PASSWORD!"=="" (
    echo ERROR: RELIGHT_DEMO_PASSWORD is empty in .env.demo.
    exit /b 1
)

call "%ROOT%scripts\run_demo.bat"
endlocal
```

- [ ] **Step 5: Smoke test the script flow (without a tunnel)**

Run the following manually in PowerShell:

```powershell
Copy-Item .env.demo.example .env.demo
(Get-Content .env.demo) -replace 'RELIGHT_DEMO_PASSWORD=$','RELIGHT_DEMO_PASSWORD=smoketestpw' | Set-Content .env.demo
.\start-demo.bat
```

Expected: uvicorn starts and logs `Uvicorn running on http://127.0.0.1:8000`. In another shell:

```powershell
curl.exe -i http://127.0.0.1:8000/healthz
```

Expected: HTTP 401 with `WWW-Authenticate: Basic realm="relight"`.

```powershell
curl.exe -i -u demo:smoketestpw http://127.0.0.1:8000/healthz
```

Expected: HTTP 200 with the healthz JSON body.

Stop uvicorn (Ctrl+C). Delete the test `.env.demo`:

```powershell
Remove-Item .env.demo
```

(Or set the password back to blank — `.env.demo` is gitignored so it won't be committed either way.)

- [ ] **Step 6: Commit**

```
git add .gitignore .env.demo.example scripts/run_demo.bat start-demo.bat
git commit -m "feat(scripts): demo-mode launch scripts that load .env.demo"
```

---

## Task 4: Operational runbook

This is the single document the operator follows to do the one-time Cloudflare setup and to launch demos. Written for an engineer who has never used `cloudflared` before.

**Files:**
- Create: `docs/deployment/cloudflare-tunnel.md`

- [ ] **Step 1: Create the runbook**

Create `docs/deployment/cloudflare-tunnel.md`:

```markdown
# Cloudflare Tunnel — demo access runbook

Expose `localhost:8000` at `https://relight.<yourdomain>` for occasional
demos, gated by a shared password. Reflects the design in
`docs/superpowers/specs/2026-05-21-cloudflare-tunnel-demo-access-design.md`.

## One-time setup (~30 min)

### 1. Register a domain at Cloudflare Registrar

Cloudflare dashboard → Registrar → search → checkout (~$10/yr).
Cloudflare DNS becomes authoritative automatically. No nameserver dance.

### 2. Install cloudflared

Download the Windows MSI from
<https://github.com/cloudflare/cloudflared/releases> and install.
Verify in PowerShell:

```powershell
cloudflared --version
```

### 3. Authenticate

```powershell
cloudflared tunnel login
```

Browser opens. Pick the zone you just registered. A cert lands in
`%USERPROFILE%\.cloudflared\cert.pem`.

### 4. Create the tunnel

```powershell
cloudflared tunnel create relight
```

Output includes a UUID. A credentials file `<UUID>.json` is written to
`%USERPROFILE%\.cloudflared\`. Note the UUID for the next step.

### 5. Write the tunnel config

Create `%USERPROFILE%\.cloudflared\config.yml`:

```yaml
tunnel: <UUID-from-step-4>
credentials-file: C:\Users\Owner\.cloudflared\<UUID>.json
ingress:
  - hostname: relight.<yourdomain>
    service: http://localhost:8000
  - service: http_status:404
```

### 6. Route DNS

```powershell
cloudflared tunnel route dns relight relight.<yourdomain>
```

Creates a CNAME `relight.<yourdomain>` → `<UUID>.cfargotunnel.com`.

### 7. Install as a Windows service

```powershell
cloudflared service install
```

The service runs as SYSTEM, auto-starts at boot, and restarts on crash.
Verify:

```powershell
Get-Service cloudflared
```

Expected: `Status: Running`.

## Daily use

### Pick / rotate a password

In PowerShell:

```powershell
-join ((48..57) + (65..90) + (97..122) | Get-Random -Count 20 | ForEach-Object {[char]$_})
```

Copy the output. First time:

```powershell
Copy-Item .env.demo.example .env.demo
```

Edit `.env.demo` and paste the password after `RELIGHT_DEMO_PASSWORD=`.

To rotate later, edit `.env.demo` and restart the app (`start-demo.bat`).
No tunnel restart needed.

### Launch a demo

```powershell
.\start-demo.bat
```

Uvicorn starts on `127.0.0.1:8000`. Share with the audience:
- URL: `https://relight.<yourdomain>`
- Username: anything
- Password: the value in `.env.demo`

### End a demo

Close the uvicorn window (or Ctrl+C). The tunnel stays up; guests now get
HTTP 502 (no upstream). This is the intended idle state — the GPU is not
exposed when you are not running the app.

## Troubleshooting

If `https://relight.<yourdomain>` does not work, walk this ladder:

1. **Is the tunnel running?**

   ```powershell
   Get-Service cloudflared
   cloudflared tunnel info relight
   ```

   Expect Running, and an active connector.

2. **Is DNS published?**

   ```powershell
   nslookup relight.<yourdomain>
   ```

   Expect a CNAME to `<UUID>.cfargotunnel.com`.

3. **Is the app on :8000?**

   ```powershell
   curl.exe -i -u demo:$env:RELIGHT_DEMO_PASSWORD http://127.0.0.1:8000/healthz
   ```

   Expect HTTP 200. If 401, the password in your shell does not match the
   one the app loaded — restart `start-demo.bat`.

4. **Is `RELIGHT_DEMO_PASSWORD` set in the app's process?**

   It is loaded only via `start-demo.bat`. Running `start.bat` (or plain
   `uvicorn`) does NOT set it, so those processes will not require auth.

## Known constraints

- Cloudflare free plan: **100 MB request body limit**. Guests uploading
  RAW files over that will get HTTP 413. JPEGs under ~50 MB are fine.
- Cloudflare default **100 s HTTP timeout**. Polish/diffusion is 5–15 s
  typical; edge cases with very large output resolution could approach
  the limit and return HTTP 524.
- Cloudflare outage takes the demo down. Rare, no remediation.

## Uninstall

```powershell
cloudflared service uninstall
cloudflared tunnel delete relight
```

Delete the DNS record from the Cloudflare dashboard (Domain → DNS).
```

- [ ] **Step 2: Commit**

```
git add docs/deployment/cloudflare-tunnel.md
git commit -m "docs(deploy): cloudflare tunnel demo access runbook"
```

---

## Task 5: End-to-end verification

This task is **manual** because it requires actual Cloudflare setup, a real domain, and an external device. Skip it during automated execution; perform it once after the implementation tasks are merged and you have completed the runbook's one-time setup.

**Files:** none (verification only)

- [ ] **Step 1: Verify success criteria from the spec**

After completing the one-time Cloudflare setup in the runbook, run `start-demo.bat` and check each of the 7 success criteria from the spec:

1. From a phone on cellular, `https://relight.<domain>` returns an HTTP Basic Auth prompt.
2. Submitting the correct password loads the WebGL playground.
3. Submitting the wrong password keeps the prompt visible; no app content is reachable.
4. A `/render` call completes end-to-end through the tunnel and the result renders in the playground.
5. A `/polish` call completes end-to-end through the tunnel.
6. After a Windows reboot, `cloudflared` is running automatically (`Get-Service cloudflared` → Running).
7. Local dev — running `start.bat` with no `RELIGHT_DEMO_PASSWORD` — shows no auth prompt and behaves identically to before.

- [ ] **Step 2: Record any deviations**

If any of the seven criteria fail, file the gap as a followup before declaring the work done. Do NOT mark the task complete on partial success.

---

## Self-Review Notes

**Spec coverage check:**

| Spec section | Covered by |
|---|---|
| §1 Cloudflare account, domain, tunnel | Task 4 (runbook) |
| §2 SharedPasswordMiddleware | Tasks 1, 2 |
| §3 Demo startup scripts and env | Task 3 |
| §4 Operational runbook | Task 4 |
| Success criteria 1–7 | Task 5 |

**Type/signature consistency:** `SharedPasswordMiddleware`, `install(app)`, `RELIGHT_DEMO_PASSWORD`, `.env.demo`, `start-demo.bat`, `scripts/run_demo.bat` — names match between tasks and spec.

**Placeholder scan:** `<UUID>` and `<yourdomain>` in the runbook are intentional user-fills, documented as such. No TBD/TODO/"implement later" anywhere.
