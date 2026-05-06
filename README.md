# Photo Relighting

Controllable, depth-based, classical relighting for 2D photos.
Engine in Python (PyTorch) + FastAPI service + WebGL playground.

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
