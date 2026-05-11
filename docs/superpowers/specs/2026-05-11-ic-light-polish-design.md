# IC-Light Polish — Design Spec

Date: 2026-05-11
Status: Approved, ready for implementation planning

## Goal

Add an optional, on-demand "Polish" pass that runs IC-Light diffusion refinement on top of the classical relighting render. The user opts in by clicking a button; the polished result is shown on the main canvas with a Classical ⇄ Polished toggle and can be opened in a fullscreen lightbox for inspection and download. The classical interactive path is untouched.

## Non-goals

- Real-time / interactive polish (latency is 5–15s; this is explicitly a "commit and refine" action).
- Persisting polished images across sessions (ephemeral; user downloads what they want to keep).
- A variants gallery / snapshot history (separate feature, separate design).
- Quality benchmarking against reference images in CI (diffusion outputs are not byte-stable).
- Background-conditioned IC-Light (`fbc` variant) or full advanced controls (negative prompt, strength, seed UI). Seed is wired through the API for testability but not exposed in the UI in v1.

## Architecture

Polish is a third pipeline stage that mirrors the existing two:

```
prepare (slow, one-time)   →   render (fast, interactive)   →   polish (slow, on-demand)
   depth + normals + mask        WebGL/CPU classical shader       IC-Light diffusion refinement
   ~5–30s, cached in session     <100ms per call                  ~5–15s per call, ephemeral
```

Key properties:

- Polish reads from the cached `PreparedImage`, not a rendered PNG round-trip. The polish route re-runs the classical render server-side from the prepared state + the current lights array, then feeds that into IC-Light as the lighting condition. This avoids quantization on the input and keeps the API stateless about pixel data.
- Optional install. IC-Light weights and the `diffusers` dependency go behind a `relighting_engine[diffusion]` extra. Default installs stay lean. Server detects availability at startup and exposes a capability flag the frontend reads.
- Single in-flight polish per session, enforced by the same `sessions.lock(session_id)` async lock that `/render` already uses. Second click while one is in flight gets a 409.
- Polished result is ephemeral. Returned as bytes in the response, held in browser memory only. No persistence in the session store, no scene-store entry.

## Package layout

New module in `relighting_engine`, parallel to `segmentation/`:

```
packages/relighting_engine/relighting_engine/
  polish/
    __init__.py
    iclight.py          # ICLightBackend class — load model, run inference
    prompts.py          # Default prompt + negative prompt constants
    capabilities.py     # is_available() — checks GPU + import-ability
```

`ICLightBackend` follows the same shape as `SAM2Backend` and `RMBGBackend`:

```python
class ICLightBackend:
    def __init__(self, device: str = "cuda"): ...
    def polish(
        self,
        classical_render: np.ndarray,   # HxWx3 linear-sRGB, the lighting condition
        foreground_rgba: np.ndarray,    # HxWx4 — subject + alpha from prepared.mask
        prompt: str = "",               # empty → use DEFAULT_PROMPT
        *,
        seed: int | None = None,
    ) -> np.ndarray:                    # HxWx3 linear-sRGB, polished result
        ...
```

Wired into `RelightingEngine` exactly like segmenters: lazy-loaded the first time `engine.polish(...)` is called, held on the engine instance so the model stays warm. Importing `diffusers` and loading weights is guarded by `try/except ImportError` in `capabilities.is_available()` so a missing extra never crashes startup.

New top-level engine method:

```python
def polish(
    self,
    prepared: PreparedImage,
    lights: Sequence[Light],
    *,
    ambient: float,
    shadow_style: str,
    prompt: str = "",
    seed: int | None = None,
    output_resolution: tuple[int, int] | None = None,
) -> np.ndarray:
    # 1. Re-run classical shader to get the lighting-conditioned render
    # 2. Compose foreground RGBA from prepared.image + prepared.mask
    # 3. Hand both to ICLightBackend.polish()
    # 4. Return polished linear-sRGB
```

## API surface

### `POST /polish` (new)

Request:

```json
{
  "session_id": "abc123",
  "lights": [ /* same shape as /render */ ],
  "ambient": 0.2,
  "shadow_style": "planar",
  "prompt": "",
  "seed": null,
  "output_resolution": [1024, 1024],
  "output_format": "png",
  "output_bit_depth": 8
}
```

Response: image bytes, same encoding path as `/render` (sRGB ICC profile embedded). Schema and encoding helpers are shared with `/render` — the `_encode` helper in `routes/render.py` moves to a shared module both routes import.

Errors:

- `404` — unknown session.
- `409` — polish already in flight for this session (lock contention).
- `422` — invalid lights / params.
- `503` with `Retry-After: 30` on `torch.cuda.OutOfMemoryError`.
- `501` with `{"detail": "polish unavailable"}` if IC-Light isn't installed or no GPU.

### `GET /health` (extend)

Health route gains a `capabilities` block so the frontend can decide whether to show the Polish button at all:

```json
{
  "status": "ok",
  "capabilities": {
    "polish": true,
    "segmenters": ["rmbg", "sam2"]
  }
}
```

`capabilities.polish` is computed once at startup (`ICLightBackend.is_available()` returns True iff `diffusers` imports cleanly *and* CUDA reports ≥8 GB free VRAM). Cached on `app.state.capabilities`.

### Schema additions

`PolishRequest` reuses `LightSchema` and shares ambient / shadow_style / output_* fields with `RenderRequest`. Extract a `RenderCommon` base model in `schemas.py` that both inherit from — small, well-scoped refactor that earns its keep here.

## UI / state model

### Components (new files in `web/src/`)

- `polish.js` — API client (`polishScene(sessionId, state, prompt, seed) → Blob`) plus the polish-state reducer (status: `idle | polishing | ready | error`, blob URL, prompt text, error msg).
- `polish-lightbox.js` — Fullscreen overlay opened from the canvas expand icon. Shows polished image at native res, download-as-PNG/JPEG buttons, close button.
- CSS additions in `playground.css` — header toggle, polish button, prompt input, "polishing…" shimmer overlay, lightbox.

### Header layout

```
[ Render ] [ + New Scene ] ...existing...   [Classical ⇄ Polished]   [Polish ▸] [prompt input ____________]
                                            └─ only visible when      └─ disabled while in flight or
                                               polish-state = ready      when capabilities.polish = false
```

### State flow

```
idle → user clicks Polish
  → state = polishing
  → canvas overlays a "polishing…" shimmer (semi-transparent, animated)
  → right panel (light controls) stays interactive but does NOT trigger re-renders
    (the throttled render loop is paused until polish resolves)
  → polish button disabled, prompt field disabled

polishing → response OK
  → state = ready, blob URL stored
  → main canvas swaps to polished image
  → header toggle appears, defaults to "Polished"
  → expand icon on canvas opens lightbox
  → render loop resumed

polishing → response error
  → state = error, show toast with detail
  → canvas reverts to classical, render loop resumed

ready → any light change / preset swap / ambient change / shadow toggle
  → state = idle
  → polished blob URL revoked
  → header toggle disappears
  → canvas shows live classical render again
```

The invalidation hook lives in the same place existing render-triggers live (the lights reducer). One line: when the classical render is invalidated, also invalidate polish.

### Loading-state messaging

The shimmer overlay text upgrades when the request crosses 5s:

- `t < 5s`: "Polishing…"
- `t ≥ 5s`: "Loading polish model (one-time, ~6 GB)…" — covers both first-ever download and first-of-session weight load.

### Capability gating

On page load, frontend fetches `/health` and reads `capabilities.polish`. If false, the Polish button + prompt input + toggle are removed from the DOM entirely (not just hidden). No "unavailable" tooltip — keeps the UI clean for users who'll never have a GPU.

## Hardware gating & install footprint

### Optional install extra

`pyproject.toml` in `relighting_engine`:

```toml
[project.optional-dependencies]
diffusion = [
  "diffusers>=0.27,<1.0",
  "transformers>=4.40",
  "accelerate>=0.30",
  "safetensors>=0.4",
]
```

Install:

```
pip install -e packages/relighting_engine[diffusion]
```

Without the extra, `relighting_engine.polish.iclight` raises `ImportError` on import. `capabilities.is_available()` catches that and returns False. Everything else in the engine keeps working.

### Weight management

- IC-Light `iclight_sd15_fc.safetensors` (~1.6 GB) + base SD1.5 (~4 GB) + VAE (~300 MB). Total ~6 GB on disk.
- Downloaded via `huggingface_hub.snapshot_download` on first `ICLightBackend(...)` instantiation. Cached under `HF_HOME` (default `~/.cache/huggingface/hub`).
- First polish on a fresh install: 60–180s of download + 3–8s of cache→GPU load + 5–15s inference.
- Subsequent polishes after server restart: 3–8s cache→GPU load + 5–15s inference.
- Subsequent polishes within the same server session: 5–15s inference only. Model stays warm on the engine instance.

### Startup detection

In `create_app()`:

```python
from relighting_engine.polish.capabilities import is_available as polish_available
app.state.capabilities = {
    "polish": polish_available(),
    "segmenters": ["rmbg", "sam2"],
}
```

`is_available()` does:

1. `try: import diffusers` → False if missing.
2. `torch.cuda.is_available()` → False if no GPU.
3. `torch.cuda.mem_get_info()[0] >= 8 * 1024**3` (8 GB free VRAM) → False otherwise.

The 8 GB threshold gives headroom over IC-Light's measured ~6 GB peak and avoids competing with an in-flight depth/SAM2 inference.

## Testing strategy

### Engine-level tests (`packages/relighting_engine/tests/polish/`)

- `test_iclight_contract.py` — `ICLightBackend.polish()` signature and return-shape contract. Skipped via `@pytest.mark.skipif(not has_gpu_and_weights())` so it only runs on dev machines with the extra installed. When it runs: smoke-test a single 256×256 call against a fixed seed, assert output is HxWx3 float32 in `[0, 1]`. No reference-image comparison.
- `test_engine_polish.py` — `RelightingEngine.polish()` end-to-end with a `FakeICLightBackend` that returns the classical render unchanged. Verifies prepared lookup works, lights are applied, foreground RGBA is composed correctly from `prepared.mask`, prompt and seed are forwarded.

### API tests (`packages/relighting_api/tests/api/test_polish.py`)

All run against `FakeEngine` — no GPU, no weights, fast.

- `test_polish_returns_png_bytes` — happy path.
- `test_polish_unknown_session_404`.
- `test_polish_invalid_lights_422`.
- `test_polish_lock_contention_409` — second concurrent polish on same session returns 409.
- `test_polish_oom_503_with_retry_after` — `FakeEngine.polish` raises `torch.cuda.OutOfMemoryError`, assert headers + status.
- `test_polish_capability_disabled_501` — when `app.state.capabilities["polish"] = False`, route returns 501.
- `test_health_capabilities_block` — `/health` includes `capabilities.polish` field.

`FakeEngine` in `tests/api/conftest.py` gets a `polish(...)` method matching the real signature. Both existing `FakeEngine` instances need the stub added.

### Frontend tests

The web playground has no test harness today. Testing is manual against a checklist:

- Click Polish → shimmer appears.
- Result swaps in on main canvas.
- Classical ⇄ Polished toggle works.
- Any light change invalidates the polished result and reverts canvas.
- Expand icon opens the lightbox at native resolution.
- Download buttons in the lightbox produce PNG and JPEG files with sRGB ICC profile.
- Clicking Polish a second time while one is in flight is a no-op (button disabled).
- When `/health` returns `polish: false`, the Polish UI is absent from the DOM.

### Out of scope for tests

- Image quality of IC-Light output. Diffusion outputs aren't deterministic across hardware.
- Download path mocking for `huggingface_hub`. First-install flow is exercised once per dev environment manually.

## Open questions deferred to implementation

- Exact prompt-condition strength / control-net hookup inside `ICLightBackend.polish()` — depends on which IC-Light variant we settle on once we read the model card carefully. The interface in this spec is stable regardless.
- Internal diffusion resolution vs. requested `output_resolution`. IC-Light is built on SD1.5 (512×512 native); larger outputs likely require tiled diffusion or SD-based upscaling. Strategy chosen during implementation; the API contract is unaffected.
- Whether to expose `Retry-After` headers as a frontend toast or silent retry. Default: surface the toast.

## Out of scope (future work)

- Async job queue for polish if we later want a variants gallery or multiple concurrent polishes per user. Today's sync-with-lock approach is intentionally simpler; revisit when we have evidence users want it.
- Background-conditioned IC-Light (`fbc`) — relighting to match a target environment image.
- Advanced controls panel (negative prompt, strength slider, seed UI).
