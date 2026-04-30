# Photo Relighting — MVP Design

**Date:** 2026-04-30
**Status:** Spec — pending review
**Scope:** MVP (Phase 1) — controllable, depth-based, classical relighting of 2D photos.
**Out of scope:** See `2026-04-30-photo-relighting-future-work.md`.

---

## 1. Goal

Build a **controllable photographic relighting studio** for 2D images. Users upload a photo and apply up to three studio lights (key / fill / rim) — each a directional, point, or spotlight — with control over color (gel), shape (gobo), intensity, falloff, cone, and softness. The result is rendered live in the browser and can be exported at full resolution and bit depth.

The MVP is the first piece of a larger system; this product becomes a **tab** in a Vite-based parent web app. The relighting engine is a Python library; the API is HTTP; the frontend is replaceable.

## 2. Non-goals (MVP)

- Cast shadows (subject blocking light from reaching the floor) — future spec.
- Diffusion-based realism polish (IC-Light) — future spec.
- ICC-aware color management — sRGB is assumed.
- Custom gobo upload — presets only in MVP.
- Multi-user / horizontal scaling, auth, rate limiting.
- Animation / video.
- Mobile or CPU-only inference.

The full deferred list lives in the future-work document.

## 3. High-level architecture

Four layers, strictly separated:

```
┌──────────────────────────────────────────────────────────┐
│ Layer 4 — Frontend                                       │
│   MVP: vanilla HTML + WebGL test page (web/)             │
│   Future: Vite tab in parent system                      │
│   Both share the same GLSL renderer                      │
├──────────────────────────────────────────────────────────┤
│ Layer 3 — HTTP API (FastAPI)                             │
│   POST /prepare  → run depth+seg+normals once per image  │
│   POST /render   → canonical Python render (export path) │
│   GET  /gobos    → list built-in gobo presets            │
│   DELETE /session/{id}                                   │
├──────────────────────────────────────────────────────────┤
│ Layer 2 — Relighting engine (pure Python package)        │
│   Importable as a library; no FastAPI/Gradio dependency  │
├──────────────────────────────────────────────────────────┤
│ Layer 1 — Models                                         │
│   Depth Anything V3 (DA3-BASE)                           │
│   RMBG-2.0                                               │
└──────────────────────────────────────────────────────────┘
```

**Invariants:**
- The engine never imports the API or any UI framework.
- The API contains no lighting math — only orchestration and session management.
- `/prepare` exposes depth/normals/mask as PNG URLs. This is the seam that lets WebGL render in the browser without going through Python.
- The interactive UI calls `/prepare` once and renders locally in WebGL; `/render` is reserved for export and parity testing.

**Render-path split:**
- **Preview = WebGL** in the browser. Buttery-smooth dragging at 60 fps using cached textures from `/prepare`.
- **Export = Python.** Full-precision, full-resolution. Future cast shadows / diffusion plug in here without touching the preview path.
- A **parity test** ensures WebGL output ≈ Python output within tolerance.

## 4. Engine — `relighting_engine`

Pure Python package. Importable from notebooks, scripts, tests, or the API.

### 4.1 Modules

```
relighting_engine/
  core/
    engine.py          # RelightingEngine — orchestrator
    prepared.py        # PreparedImage dataclass
    io.py              # JPEG/PNG/TIFF/HEIC reader+writer (8/16/32-bit)
  depth/
    depth_anything.py  # DA3-BASE adapter
  segmentation/
    rmbg.py            # RMBG-2.0 adapter
  normals/
    from_depth.py      # depth gradient → unit normals (gaussian smoothing)
  lighting/
    models.py          # Light, Gobo dataclasses
    shaders.py         # PyTorch tensor render — canonical implementation
    gels.py            # color presets, Kelvin → RGB
    gobo.py            # projection math (perspective / ortho / equirect)
  assets/
    gobos/             # 6 built-in gobo PNGs
```

### 4.2 Data shapes

```python
@dataclass
class Light:
    type: Literal["directional", "point", "spotlight"]
    position: tuple[float, float, float]   # normalized x,y,z; z=depth (0=screen, +=behind)
    direction: tuple[float, float, float]  # for directional + spotlight aim
    color: tuple[float, float, float]      # RGB 0..1 (this IS the gel)
    color_temperature: float | None        # optional: Kelvin; sets color when used
    gel_preset: str | None                 # optional: "CTO", "CTB", "Plus Green 1/2", etc.
    intensity: float                       # 0..3
    falloff: float                         # quadratic distance falloff coef (point/spot)
    cone_angle: float                      # spotlight half-angle, radians
    softness: float                        # spotlight edge softness
    gobo: Gobo | None                      # optional pattern projection
    affects: Literal["all", "subject", "background"]
    enabled: bool

@dataclass
class Gobo:
    texture_id: str                        # e.g. "preset:window-blinds"
    scale: float = 1.0
    rotation: float = 0.0                  # radians
    offset: tuple[float, float] = (0.0, 0.0)
    blur: float = 0.0
    invert: bool = False

@dataclass
class PreparedImage:
    original: np.ndarray                   # HxWx3 float32 (linear)
    depth: np.ndarray                      # HxW float32, normalized [0,1]
    normals: np.ndarray                    # HxWx3 float32 unit vectors
    mask: np.ndarray | None                # HxW float32 [0,1]; None when no subject
    width: int
    height: int
    metadata: dict                         # model versions, prep timing, original bit depth, ICC presence
```

### 4.3 Engine API

```python
class RelightingEngine:
    def __init__(self, device: str = "cuda",
                 depth_backend: str = "depth-anything-v3",
                 seg_backend: str = "rmbg-2.0"):
        ...

    def prepare(self,
                image: np.ndarray,
                mode: Literal["interactive", "quality"] = "interactive"
               ) -> PreparedImage:
        """Slow path. Runs depth + segmentation + normals.
           interactive: caps input at 1024 px max-side (~1.2 s on CUDA).
           quality:     runs at native up to 4096 px (~3–5 s)."""

    def render(self,
               prepared: PreparedImage,
               lights: list[Light],
               ambient: float = 0.2,
               output_resolution: tuple[int, int] | None = None
              ) -> np.ndarray:
        """Fast path. Shader-only render. ~50–150 ms on CUDA at 1024 px."""
```

### 4.4 Lighting math (per pixel, vectorized GPU op)

```
N  = normals[y, x]
P  = world_pos(x, y, depth[y, x])

total = ambient * original[y, x]

for L in lights where L.enabled:
    if L.type == directional:
        L_vec = -L.direction
        atten = 1
    else:
        d     = L.position - P
        L_vec = normalize(d)
        atten = 1 / (1 + L.falloff * |d|^2)

    if L.type == spotlight:
        cone_dot = dot(L.direction, -L_vec)
        cone     = smoothstep(cos(L.cone_angle + L.softness),
                              cos(L.cone_angle),
                              cone_dot)
    else:
        cone = 1

    if L.gobo is not None:
        uv  = project_to_light_space(P, L)              # see 4.5
        uv  = rotate(uv, L.gobo.rotation) * L.gobo.scale + L.gobo.offset
        g   = sample(L.gobo.texture, uv, blur=L.gobo.blur)
        if L.gobo.invert: g = 1 - g
    else:
        g = 1

    diffuse = max(dot(N, L_vec), 0)
    # Mask handling, with graceful fallback when no subject was detected
    # (PreparedImage.mask is None → mask treated as 1 everywhere):
    mask_w  = 1                                                if L.affects == "all"
              else (mask if mask is not None else 1)           if L.affects == "subject"
              else (1 - mask if mask is not None else 1)       if L.affects == "background"

    total += original[y, x] * L.color * L.intensity
                              * diffuse * atten * cone * g * mask_w

output[y, x] = clamp(total, 0, 1)
```

The whole loop is one vectorized PyTorch op, not a Python for-loop.

### 4.5 Gobo projection by light type

| Light type | Projection | Notes |
|---|---|---|
| Spotlight | Perspective through cone (standard projector) | UV maps to the cone aperture |
| Directional | Orthographic along direction | Sun-through-leaves pattern |
| Point | Equirectangular (spherical) | Light vector → (θ, φ) → texture sample. Custom point-light gobos look correct only when the texture is equirectangular; rectangular gobos are auto-wrapped (acceptable, stylized). |

Spotlight + directional get up to 6 built-in PNG presets. Point-light gobos use the same presets, wrapped equirectangularly.

### 4.6 Determinism contract

Same inputs → byte-identical Python outputs. Random-seeded model paths (where any) are fixed at engine init. This is the floor on which the WebGL parity test is built.

## 5. HTTP API — `relighting_api`

FastAPI service. Stateful: prepares an image once, serves cheap renders.

### 5.1 Endpoints

```
POST   /prepare
       multipart: image (jpg/png/tiff/heic), mode? ("interactive"|"quality")
       → 200 {
           session_id,
           width, height,
           assets: {
             original_png_url,     # 8-bit display version for browser texture
             depth_png_url,        # 16-bit grayscale
             normals_png_url,      # RGB8 with (n*0.5+0.5) encoding
             mask_png_url | null   # grayscale or null when no subject
           },
           metadata: { depth_model, seg_model, prep_ms,
                       original_bit_depth, original_format,
                       icc_profile_present }
         }

POST   /render
       json: {
         session_id,
         lights: [Light, ...],
         ambient: 0.2,
         output_format: "png" | "tiff" | "jpeg",
         output_bit_depth: 8 | 16 | 32,    # 32 only valid for tiff
         output_resolution?: [w, h]
       }
       → 200 image bytes (Content-Type matches output_format)

GET    /gobos
       → 200 {
           presets: [
             { gobo_id, name, thumbnail_url, projection: "spotlight"|"equirect" },
             ...
           ]
         }

DELETE /session/{session_id}
       → 204

GET    /healthz
       → 200 { ok: true, gpu: bool, depth_model_loaded: bool, ... }
```

### 5.2 Session model

- In-memory `dict[session_id → PreparedImage]` for the active set.
- Disk cache at `cache/sessions/{session_id}/` containing `original.png` (display), `original_full.{ext}` (preserved-precision source), `depth.npy`, `normals.npy`, `mask.npy` (or absence-marker), `meta.json`.
- TTL: 1 hour idle eviction (configurable). Disk cache survives restart; lazy-loaded on first hit.
- Single-process for MVP. Concurrent renders on the same session serialized via `asyncio.Lock`.

### 5.3 Light JSON over the wire

Mirrors the engine dataclass exactly. Pydantic validates and 422s on malformed input.

```json
{
  "type": "spotlight",
  "position": [0.5, 0.4, -0.3],
  "direction": [0.0, -0.2, 1.0],
  "color": [1.0, 0.85, 0.6],
  "color_temperature": 3200,
  "gel_preset": "CTO",
  "intensity": 1.5,
  "falloff": 0.8,
  "cone_angle": 0.5,
  "softness": 0.1,
  "gobo": {
    "texture_id": "preset:window-blinds",
    "scale": 1.2,
    "rotation": 0.3,
    "offset": [0, 0],
    "blur": 0.05,
    "invert": false
  },
  "affects": "all",
  "enabled": true
}
```

### 5.4 Errors

| Code | When |
|---|---|
| 413 | Image > 4096 × 4096 (configurable cap) |
| 404 | Unknown `session_id` |
| 415 | Unsupported input format on `/prepare` |
| 422 | Invalid light JSON (Pydantic); invalid `output_format` × `output_bit_depth` combo (e.g. JPEG with 16-bit, PNG with 32-float) |
| 503 | GPU OOM; includes `Retry-After`. Optional auto-downscale-and-retry behind a flag. |

### 5.5 Auth

None for MVP. Assumed local dev or behind the parent system's gateway. Adding bearer-token auth later is additive.

## 6. WebGL renderer + browser test page

`web/` — vanilla HTML + JS + GLSL. Replaceable when the Vite tab arrives; the renderer code (shaders + state model) ports directly.

### 6.1 Pipeline (per frame, during drag)

1. Bind textures: `original`, `depth`, `normals`, `mask`, plus a gobo texture per light that uses one.
2. Bind uniforms: array of light structs (up to 8 in MVP), ambient, viewport.
3. Single fullscreen quad → fragment shader runs the same per-pixel loop as `lighting/shaders.py`.
4. Output to canvas. ~1–3 ms on a modern desktop GPU.

### 6.2 Texture encoding from `/prepare`

| Asset | Encoding |
|---|---|
| `original_png_url` | 8-bit sRGB (always; preview only) |
| `depth_png_url` | 16-bit grayscale PNG |
| `normals_png_url` | RGB8 with `(n*0.5+0.5)` encoding |
| `mask_png_url` | grayscale 8-bit, or omitted |

### 6.3 GLSL shader

`web/src/webgl/shaders/relight.frag` mirrors the math in `lighting/shaders.py` exactly. Same projection rules for gobos. Same gel/Kelvin handling. The parity test is what guarantees this stays true.

### 6.4 Drag handling

- Each light gets a small colored handle absolutely positioned over the canvas.
- `pointermove` updates `light.position.x/y` (normalized) and triggers a WebGL redraw — no HTTP.
- `shift+drag` rotates an aim arrow that updates `direction`.
- Mouse wheel adjusts `position.z`.

### 6.5 State model

A single JS object `{ lights: [...], ambient }` is the source of truth. Any input mutation re-renders the canvas. **Export PNG** serializes the state and POSTs to `/render` for a full-precision Python render — that result is the deliverable; the WebGL canvas is the preview.

### 6.6 MVP UI scope

- 3 fixed slots in the UI (Key / Fill / Rim). Engine still supports up to 8 in shader uniforms; unlimited in the data model.
- Color picker as primary gel control; preset dropdown and Kelvin slider as alternatives.
- Gobo preset thumbnails with scale/rotation/offset controls.
- Click-on-image and drag-handle both supported.
- "Show depth / normals / mask" toggle for debugging.

## 7. Input / output formats & precision

### 7.1 Inputs

| Format | Bit depth | Library |
|---|---|---|
| JPEG | 8 | Pillow |
| PNG | 8, 16 | Pillow |
| TIFF | 8, 16, 32-float | `imageio[tifffile]` |
| HEIC | 8 (typical) | `pillow-heif` (registers as Pillow plugin) |

Hard cap: 4096 × 4096 (configurable).

### 7.2 Engine working space

- All internal tensors: **float32, linear RGB** (gamma-decoded from sRGB on load).
- ICC profiles: read and stored in metadata; **assumed sRGB if absent**. Wide-gamut inputs treated as sRGB in MVP with a metadata flag noting the limitation.
- Alpha channel on input: discarded (note in metadata). Future enhancement: alpha-as-mask.

### 7.3 Outputs

- JPEG → 8-bit only.
- PNG → 8 or 16-bit.
- TIFF → 8, 16, or 32-bit float.
- HEIC export not supported in MVP.

Output gamma-encoded back to sRGB. Bit depth and format selectable per `/render` call.

## 8. Models & dependencies

### 8.1 Models

| Purpose | Model | Approx. size | Notes |
|---|---|---|---|
| Depth | Depth Anything V3 (DA3-BASE, 0.12 B params) | ~400 MB | Apache 2.0. Custom package install (see deps). |
| Segmentation | RMBG-2.0 | ~180 MB | HuggingFace via `transformers`. |

Cached under `~/.cache/relighting_engine/`. Pre-warmed by `scripts/download_models.py`.

### 8.2 Tier control

DA3 ships only the BASE variant publicly. The engine uses **one model** at two working resolutions:
- `interactive` — cap input at 1024 px max-side, ~500–800 ms inference.
- `quality` — native resolution up to 4096 px, ~3–5 s inference.

Selectable per `/prepare` call.

### 8.3 Python dependencies

```
# Engine
torch>=2.2                                          # CUDA build
torchvision
depth_anything_3 @ git+https://github.com/ByteDance-Seed/depth-anything-3
transformers
huggingface_hub
numpy
opencv-python-headless
pillow
pillow-heif
imageio[tifffile]
scipy

# API
fastapi
uvicorn[standard]
pydantic>=2
python-multipart

# Test
pytest
pytest-asyncio
playwright
```

### 8.4 Footprint

- CUDA 12.x runtime.
- ~3 GB VRAM idle with both models loaded.
- ~5–7 GB VRAM peak during prep at 4096².
- ~4 GB disk for model weights + cache.

### 8.5 Loading discipline

- Lazy load on first request, keep resident.
- `RelightingEngine` is a singleton in the FastAPI process; created at app startup, not per-request.
- `DELETE /session` frees session cache only, not model weights.

## 9. Project layout

Single repo, multi-package.

```
phot-relighting/
├── pyproject.toml                     # workspace root
├── README.md
├── .python-version                    # 3.11
├── docs/
│   └── superpowers/specs/             # this doc + future-work doc
├── packages/
│   ├── relighting_engine/             # Layer 2
│   │   ├── pyproject.toml
│   │   ├── relighting_engine/...
│   │   └── tests/
│   │       ├── unit/
│   │       ├── integration/
│   │       ├── golden/                # fixture images + expected outputs
│   │       └── fixtures/
│   └── relighting_api/                # Layer 3
│       ├── pyproject.toml             # depends on relighting_engine
│       ├── relighting_api/...
│       └── tests/
├── web/                               # Layer 4 (MVP playground)
│   ├── playground.html
│   ├── playground.css
│   ├── src/
│   │   ├── main.js
│   │   ├── webgl/{renderer.js, shaders/{relight.vert, relight.frag}}
│   │   ├── lights.js
│   │   ├── controls.js
│   │   └── api.js
│   └── tests/                         # Playwright + parity
├── scripts/
│   ├── download_models.py
│   ├── run_dev.sh
│   └── parity_check.py
└── cache/                             # gitignored
    └── sessions/
```

The two-package split (`relighting_engine`, `relighting_api`) lets any consumer — including the future Vite tab repo — depend on the engine alone, no FastAPI.

## 10. Testing strategy

| Band | Where | What it guards | GPU? |
|---|---|---|---|
| Unit | `packages/*/tests/unit/` | Light JSON round-trip, gobo projection math, Kelvin→RGB, I/O format support, session TTL/persistence, Pydantic 422s | No |
| Integration | `packages/relighting_engine/tests/integration/` | `prepare()` shape; ambient-only render; directional-light brightness asymmetry; subject-only mask isolation; multi-light additivity | Yes |
| Golden | `packages/relighting_engine/tests/golden/` | 10 fixtures × 5 light configs = 50 reference PNGs. SSIM > 0.99 vs. golden. | Yes |
| API | `packages/relighting_api/tests/api/` | Every endpoint, success + error paths. Session lifecycle. Concurrent-render safety. 413/404/422 paths. | No |
| Parity | `web/tests/` (Playwright + headless WebGL) | WebGL output ≤ 2/255 per channel diff vs. Python golden across ≥99% of pixels | Yes (browser GPU) |

CI: unit + API on every push. GPU bands run on push to `main` and on relevant changes. Local `make test` runs all bands when CUDA present, otherwise skips with a warning.

## 11. Build & run

```bash
# one-time
python scripts/download_models.py        # ~600 MB total

# dev loop
./scripts/run_dev.sh
# → uvicorn relighting_api.main:app --reload  (port 8000)
# → opens http://localhost:8000/playground.html
```

## 12. Open questions / risks

- **DA3 install path is git-based, not PyPI.** Pin a commit SHA in `pyproject.toml` to avoid drift.
- **WebGL float-precision drift.** Mitigated by the parity test; if SSIM diff exceeds tolerance on commodity hardware, fall back to higher-precision shader textures.
- **HEIC platform variability.** `pillow-heif` bundles libheif via wheels but watch for ARM-only edge cases on dev machines.
- **Confidence map from DA3 unused in MVP.** Worth revisiting in a future iteration to fade lighting in low-confidence regions.

## 13. References

- Depth Anything V3 — <https://depth-anything-3.github.io/>, paper arXiv:2511.10647
- RMBG-2.0 — <https://huggingface.co/briaai/RMBG-2.0>
- IC-Light (future) — <https://github.com/lllyasviel/IC-Light>
- ComfyUI_Relight_Img (reference) — <https://github.com/yvann-ba/ComfyUI_Relight_Img>
- Awesome-Relighting (survey) — <https://github.com/AnsonZP/Awesome-Relighting>
