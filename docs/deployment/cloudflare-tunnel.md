# Cloudflare Tunnel — demo access runbook

Expose `localhost:8001` at `https://relight.<yourdomain>` for occasional
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
    service: http://localhost:8001
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

> ⚠️ **Never run the tunnel with `RELIGHT_DEMO_PASSWORD` empty.** An empty (or
> unset) value disables auth entirely — the middleware is not installed, so
> anyone with the URL reaches the app and your GPU. An empty password is *only*
> for local-bound dev (e.g. `run_noauth.bat`), never for tunnel-facing use.
> Making the repo public does not expose the password (it lives only in the
> gitignored `.env.demo`); the tunnel is the real risk surface.

### Launch a demo

```powershell
.\start-demo.bat
```

Uvicorn starts on `127.0.0.1:8001`. Share with the audience:
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

3. **Is the app on :8001?**

   ```powershell
   curl.exe -i -u demo:$env:RELIGHT_DEMO_PASSWORD http://127.0.0.1:8001/healthz
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
- Venues (Spec 2 rigs: stage dimensions and hang positions) live in the same
  SQLite DB as scenes (`RELIGHT_SCENES_DB`, default `cache/scenes.db`), so
  back up or relocate scenes and venues together.

## Running the Playwright suite next to a dev server

`web/tests/playwright.config.js` starts its own uvicorn on port 8765 with
`reuseExistingServer: true`. If a dev server is already listening on 8765
(for example one started from the project root for manual checks), Playwright
silently reuses it: the parity and calibrated-smoke specs then create their
scenes and prepared sessions in that server's **real** `cache/scenes.db` and
`cache/sessions/`, and the run is invalid as evidence because it did not
exercise a fresh server. Run the suite only when nothing is listening on 8765
(`netstat -ano | findstr :8765` must be empty), and stop any dev server on
that port first; the demo server on 8001 is unaffected. Playwright's own
server runs with `web/tests/` as its working directory, so its scenes, venues
and sessions land in the gitignored `web/tests/cache/`, never in `cache/`.

## Uninstall

```powershell
cloudflared service uninstall
cloudflared tunnel delete relight
```

Delete the DNS record from the Cloudflare dashboard (Domain → DNS).
