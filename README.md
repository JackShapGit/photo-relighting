# Photo Relighting

Controllable, depth-based, classical relighting for 2D photos.
Engine in Python (PyTorch) + FastAPI service + WebGL playground.

## Features

- **Classical relighting engine** — depth- and normal-aware, per-light
  contribution composited in linear space (point / directional / spot lights,
  Kelvin colour, cones, softness, falloff, gobos).
- **Reflectors** — diffuse + glossy plane primitives that bounce light into the
  scene, with per-pixel contribution matched between the Python engine and GLSL.
- **3D viewport** — optional Three.js pane showing a depth-displaced point cloud
  of the photo with draggable 3D light gizmos, kept in sync with the 2D canvas.
- **Layered PSD export** — decompose the result into per-light layers and
  download a Photoshop-ready `.psd` (capability-gated, requires `pytoshop`).
- **IC-Light polish** — optional diffusion refinement pass on top of the
  classical render.
- **Portable scenes** — auto-saved lighting trees, importable/exportable as
  `.relight.zip`.
- **Shared-password demo mode** — Basic Auth middleware for exposing a demo over
  a Cloudflare tunnel (see `docs/deployment/cloudflare-tunnel.md`).

See `docs/superpowers/specs/2026-04-30-photo-relighting-mvp-design.md`
for the full design and `docs/superpowers/plans/2026-05-01-photo-relighting-mvp-plan.md`
for the implementation plan that produced this codebase.

## Quick start (Windows + CUDA 12.x)

```powershell
# 1. Create venv and install
python -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install --upgrade pip wheel
pip install "torch>=2.7" torchvision --index-url https://download.pytorch.org/whl/cu128
pip install -e packages/relighting_engine[test]
pip install -e packages/relighting_api[test]
# (depth-anything-3 is pinned via the engine's pyproject; the editable install
# pulls it from GitHub commit 41736238f5bced4debf3f2a12375d2466874866d.
# RMBG-2.0 weights are gated on Hugging Face — accept the license at
# https://huggingface.co/briaai/RMBG-2.0 then `huggingface-cli login`.)
playwright install chromium

# 2. (Optional, for the WebGL ↔ Python parity test)
npm install

# 3. Pre-warm models (~600 MB)
python scripts/download_models.py

# 4. Run
.\scripts\run_dev.ps1
```

Open <http://localhost:8000/web/playground.html>.

## Playground UI

The playground is a 3-pane layout:

- **Left** — hierarchical tree of lights and groups. Right-click any row for
  Add Light / Add Group / Rename / Clone / Delete. Drag rows to reorder; drop
  on a group's middle to nest, drop on its top/bottom edge to insert as a
  sibling. The "Drop here to move to root" pile at the bottom moves things
  out of all groups.
- **Centre** — the canvas + draggable anchors. Click an anchor to select the
  matching light (a dashed ring spins around the selected anchor). Drag the
  anchor to move; shift-drag tilts direction; mouse-wheel adjusts depth.
- **Right** — context-sensitive properties. Selecting **Scene** (top of the
  tree) reveals **Ambient** and **Show** (Render / Depth / Normals / Mask).
  Selecting a light reveals its full controls (type, intensity, colour,
  Kelvin, cone, softness, falloff, gobo, affects, enabled).

### Scenes (auto-saved + portable)

Every edit is auto-saved (debounced 500 ms) to a SQLite DB at
`cache/scenes.db`. A **scene** = name + lighting tree + a pointer to the
prepared image session. The header has:

- **+ New Scene** — popup that takes a name and an image, runs `/prepare`,
  creates the scene row.
- **Scenes** — modal listing every saved scene with thumbnail + last-edit
  date. Click a row to load. Per-row **Export** downloads a portable
  `.relight.zip`; the toolbar **Import** accepts that zip on the receiving
  end (the image is re-prepared so it's engine-version-agnostic).
- **Scene name** — click to rename inline; persisted on blur or Enter.

### Themes & shortcuts

- **Theme toggle** in the top-right header (light/dark, persisted in
  localStorage).
- **F2** rename selected node, **Delete** delete (with confirm), **Ctrl/Cmd-D**
  clone.

### Polish (optional IC-Light diffusion pass)

After dialing in lights with the classical renderer, click **Polish ▸** in the
header to run an IC-Light diffusion refinement (5–15 s) on top of the current
scene. A Classical ⇄ Polished toggle appears once the result is ready; the
expand icon on the canvas opens a fullscreen lightbox with PNG/JPEG download.
Any light change invalidates the polish. The optional text field next to the
button accepts a freeform prompt (e.g. *"warm golden hour"*) to steer the look.

Polish requires `pip install -e packages/relighting_engine[diffusion]` and a
GPU with ≥8 GB free VRAM. First run downloads ~6 GB of weights. The Polish
UI is hidden when these aren't available (gated on `/healthz`'s
`capabilities.polish` field).

## Tests

```powershell
# CPU-only unit tests (no models, no CUDA)
pytest packages/relighting_engine/tests/unit packages/relighting_api/tests -v

# GPU + model integration + golden tests
pytest packages -v -m "gpu and models"

# WebGL ↔ Python parity
npx playwright test --config=web/tests/playwright.config.js
python scripts/parity_check.py test-results/webgl.png `
    packages/relighting_engine/tests/fixtures/expected/portrait_a__single_directional.png
```

## Layout

```
packages/relighting_engine/   pure-Python engine (importable, no FastAPI)
packages/relighting_api/      FastAPI service (depends on engine)
web/                          vanilla HTML/JS/GLSL playground
scripts/                      one-shot tools (download, run, parity, goldens)
docs/superpowers/             specs and plans
cache/                        gitignored; per-session prepared assets
```

## Out of scope (MVP)

See `docs/superpowers/specs/2026-04-30-photo-relighting-future-work.md`.

## Third-party models

This project's **code** is Apache-2.0 licensed (below), but it downloads and
runs third-party model weights at runtime, each under its own license. You are
responsible for complying with these — some are **non-commercial** and/or
require accepting terms before download:

- **RMBG-2.0** (background removal, BriaAI) — gated on Hugging Face; the weights
  are non-commercial. Accept the license at <https://huggingface.co/briaai/RMBG-2.0>.
- **Depth-Anything** — see its upstream repository for license terms.
- **IC-Light** (optional polish pass) — see its upstream repository.

No model weights are bundled in this repository.

## License

Licensed under the Apache License, Version 2.0. See [LICENSE](LICENSE).

Copyright 2026 Jack Shapiro.
