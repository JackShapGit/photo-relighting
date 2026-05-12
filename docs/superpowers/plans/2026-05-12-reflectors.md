# Reflectors Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add passive light-bouncing reflectors (diffuse + glossy) as a new `LightNode.type === 'reflector'` entity, contributing real per-pixel illumination in both the Python engine and the WebGL preview.

**Architecture:** A reflector stores position, normal, size, tint, reflectance, and roughness. Each render: (1) CPU-side computes a per-reflector emission color + dominant reflected direction by walking the active emitters; (2) Shader-side adds a Lambertian diffuse component (weighted by `roughness`) plus a Phong-like glossy lobe (weighted by `1 - roughness`) using the precomputed values. Both the Python engine and the JS WebGL renderer implement identical Stage 1 math.

**Tech Stack:** Python 3.11 + numpy / torch (engine), FastAPI + Pydantic (API), vanilla JS ES modules + WebGL2 (frontend), Three.js (3D viewport).

**Reference spec:** `docs/superpowers/specs/2026-05-12-reflector-design.md`

---

## File Map

### Schema layer

Modify:
- `packages/relighting_api/relighting_api/schemas.py` — extend `LightModel` type literal + 4 new fields.
- `packages/relighting_engine/relighting_engine/lighting/models.py` — extend `Light` dataclass + `validate()` + `from_dict()`.

### Python engine math

Create:
- `packages/relighting_engine/relighting_engine/lighting/reflectors.py` — `compute_reflector_emission()` pure function.
- `packages/relighting_engine/tests/unit/test_reflector_emission.py` — unit tests.

Modify:
- `packages/relighting_engine/relighting_engine/lighting/shaders.py` — call `compute_reflector_emission()` and add reflector per-pixel contribution.
- `packages/relighting_engine/tests/unit/test_lighting_models.py` — reflector validation cases.

Add fixture:
- `packages/relighting_engine/tests/fixtures/expected/portrait_a__reflector_fill.png` — golden image.

### WebGL frontend math

Create:
- `web/src/webgl/reflector-emission.js` — JS mirror of Stage 1.

Modify:
- `web/src/webgl/renderer.js` — pass reflector uniforms.
- `web/src/webgl/shaders/relight.frag` — reflector loop.

### Frontend UI

Modify:
- `web/src/presets.js` — Reflector preset card.
- `web/src/lights.js` — handle reflector fields in `lightFromPreset` (already generic) and `defaultLight` (no reflector default needed).
- `web/src/controls.js` — props panel branch for reflectors.
- `web/src/handles.js` — 2D anchor styling for reflectors.
- `web/src/tree.js` — icon for reflectors.
- `web/src/3d/light-primitives.js` — plane primitive for reflectors.
- `web/src/3d/sync.js` — diff equality includes new fields.
- `web/src/3d/gizmos.js` — rotate writeback routes to `normal` for reflectors.

Modify (thumbnail generation):
- `scripts/make_preset_thumbs.py` — render reflector thumbnail.

---

# Stage A — Schema foundation

## Task 1: Add reflector fields to schemas + dataclass + validation

**Files:**
- Modify: `packages/relighting_api/relighting_api/schemas.py`
- Modify: `packages/relighting_engine/relighting_engine/lighting/models.py`
- Modify: `packages/relighting_engine/tests/unit/test_lighting_models.py`

- [ ] **Step 1: Write failing validation tests.**

Open `packages/relighting_engine/tests/unit/test_lighting_models.py`. Append:

```python
def test_reflector_defaults_validate() -> None:
    from relighting_engine.lighting.models import Light
    L = Light(
        type='reflector',
        position=(0.5, 0.5, -0.5),
        direction=(0, 0, -1),
        color=(1.0, 1.0, 1.0),
        normal=(0.0, 0.0, 1.0),
        size=(0.6, 0.4),
        reflectance=0.7,
        roughness=0.5,
    )
    L.validate()       # should not raise


def test_reflector_rejects_negative_size() -> None:
    from relighting_engine.lighting.models import Light
    import pytest
    L = Light(
        type='reflector',
        position=(0, 0, 0), direction=(0, 0, -1), color=(1, 1, 1),
        normal=(0, 0, 1), size=(-0.5, 0.4),
        reflectance=0.7, roughness=0.5,
    )
    with pytest.raises(Exception):
        L.validate()


def test_reflector_rejects_out_of_range_reflectance() -> None:
    from relighting_engine.lighting.models import Light
    import pytest
    L = Light(
        type='reflector',
        position=(0, 0, 0), direction=(0, 0, -1), color=(1, 1, 1),
        normal=(0, 0, 1), size=(0.6, 0.4),
        reflectance=1.5, roughness=0.5,
    )
    with pytest.raises(Exception):
        L.validate()


def test_reflector_zero_normal_rejected() -> None:
    from relighting_engine.lighting.models import Light
    import pytest
    L = Light(
        type='reflector',
        position=(0, 0, 0), direction=(0, 0, -1), color=(1, 1, 1),
        normal=(0, 0, 0), size=(0.6, 0.4),
        reflectance=0.7, roughness=0.5,
    )
    with pytest.raises(Exception):
        L.validate()


def test_regular_light_unaffected_by_reflector_fields() -> None:
    # Non-reflector types should still validate without setting the new fields.
    from relighting_engine.lighting.models import Light
    L = Light(
        type='spotlight',
        position=(0.5, 0.3, 1.5), direction=(-0.3, 0.3, -1),
        color=(1, 1, 1), intensity=1.2,
    )
    L.validate()
```

- [ ] **Step 2: Run tests to confirm they fail.**

Run: `cd packages/relighting_engine && pytest tests/unit/test_lighting_models.py -v -k reflector`
Expected: 4 FAILED (TypeError on `Light(...)` because `normal`/`size`/`reflectance`/`roughness` are not yet fields).

- [ ] **Step 3: Extend `Light` dataclass.**

Open `packages/relighting_engine/relighting_engine/lighting/models.py`. The `Light` dataclass currently has fields like `type`, `position`, `direction`, `color`, etc. Add immediately after the existing optional fields (before `validate()`):

```python
    # Reflector-only fields (ignored for non-reflector types).
    normal: tuple[float, float, float] = (0.0, 0.0, -1.0)
    size: tuple[float, float] = (0.6, 0.4)
    reflectance: float = 0.7
    roughness: float = 0.5
```

Update the `type` field's typing to include `'reflector'`:

```python
    type: Literal['directional', 'point', 'spotlight', 'reflector']
```

Update `validate()` to add reflector-specific checks at the end (before the existing `return self` or whatever final statement). Add:

```python
        if self.type == 'reflector':
            nx, ny, nz = self.normal
            if nx * nx + ny * ny + nz * nz < 1e-9:
                raise ValueError('reflector normal must be non-zero')
            if self.size[0] <= 0 or self.size[1] <= 0:
                raise ValueError('reflector size components must be positive')
            if not (0.0 <= self.reflectance <= 1.0):
                raise ValueError('reflector reflectance must be in [0, 1]')
            if not (0.0 <= self.roughness <= 1.0):
                raise ValueError('reflector roughness must be in [0, 1]')
```

Update `from_dict()` (the classmethod) to read the new fields. Find the existing `kwargs = dict(...)` or similar and add:

```python
            normal=tuple(d.get('normal', (0.0, 0.0, -1.0))),
            size=tuple(d.get('size', (0.6, 0.4))),
            reflectance=float(d.get('reflectance', 0.7)),
            roughness=float(d.get('roughness', 0.5)),
```

- [ ] **Step 4: Extend `LightModel` (Pydantic).**

Open `packages/relighting_api/relighting_api/schemas.py`. Update the `LightModel.type` field:

```python
    type: Literal["directional", "point", "spotlight", "reflector"]
```

Add new fields after the existing ones (before `to_engine()`):

```python
    normal: list[float] = Field(default_factory=lambda: [0.0, 0.0, -1.0])
    size: list[float] = Field(default_factory=lambda: [0.6, 0.4])
    reflectance: Annotated[float, Field(ge=0.0, le=1.0)] = 0.7
    roughness: Annotated[float, Field(ge=0.0, le=1.0)] = 0.5
```

Update `to_engine()` to forward the new fields. Find the existing `l = Light(...)` and add to the kwargs:

```python
            normal=(self.normal[0], self.normal[1], self.normal[2]),
            size=(self.size[0], self.size[1]),
            reflectance=self.reflectance,
            roughness=self.roughness,
```

- [ ] **Step 5: Run validation tests.**

Run: `cd packages/relighting_engine && pytest tests/unit/test_lighting_models.py -v -k reflector`
Expected: 5 PASS (the 4 new tests + `test_regular_light_unaffected_by_reflector_fields`).

- [ ] **Step 6: Run the full engine + API test suites.**

Run: `cd packages/relighting_engine && pytest tests --ignore=tests/polish/test_backend_contract.py`
Expected: All passing tests stay passing. Existing schema round-trip tests should now also accept reflector type in the literal without breaking.

Run: `cd packages/relighting_api && pytest tests`
Expected: All passing tests stay passing.

- [ ] **Step 7: Commit.**

```bash
git add packages/relighting_engine/relighting_engine/lighting/models.py \
        packages/relighting_engine/tests/unit/test_lighting_models.py \
        packages/relighting_api/relighting_api/schemas.py
git commit -m "feat(engine,api): add reflector type + normal/size/reflectance/roughness fields"
```

---

# Stage B — Python engine math

## Task 2: Stage 1 emission computation (pure function + tests)

**Files:**
- Create: `packages/relighting_engine/relighting_engine/lighting/reflectors.py`
- Create: `packages/relighting_engine/tests/unit/test_reflector_emission.py`

- [ ] **Step 1: Write failing unit tests.**

Create `packages/relighting_engine/tests/unit/test_reflector_emission.py`:

```python
"""Unit tests for compute_reflector_emission (Stage 1 of reflector math)."""
from __future__ import annotations

import numpy as np

from relighting_engine.lighting.models import Light
from relighting_engine.lighting.reflectors import compute_reflector_emission


def _refl(**kw):
    base = dict(
        type='reflector',
        position=(0.5, 0.5, -0.5),
        direction=(0, 0, -1),
        color=(1.0, 1.0, 1.0),
        normal=(0.0, 0.0, 1.0),
        size=(0.6, 0.4),
        reflectance=1.0,
        roughness=0.5,
    )
    base.update(kw)
    return Light(**base)


def _dir_light(direction=(0, 0, -1), color=(1, 1, 1), intensity=1.0):
    return Light(
        type='directional',
        position=(0, 0, 0),
        direction=direction,
        color=color,
        intensity=intensity,
    )


def test_emission_empty_inputs_returns_empty_list() -> None:
    assert compute_reflector_emission([], []) == []


def test_no_lights_yields_zero_emission() -> None:
    [(emission, _)] = compute_reflector_emission([_refl()], [])
    assert np.allclose(emission, [0, 0, 0])


def test_single_directional_light_perpendicular_to_reflector() -> None:
    # Reflector normal +z, light shining along -z (toward reflector).
    light = _dir_light(direction=(0, 0, -1), color=(1, 1, 1), intensity=1.0)
    [(emission, dom)] = compute_reflector_emission([_refl()], [light])
    # facing = dot(+z, +z) = 1, irradiance = 1 * 1 * 1 = 1.
    # emission = (1,1,1) * 1.0 (reflectance) * (1,1,1) (tint) = (1,1,1).
    assert np.allclose(emission, [1, 1, 1], atol=1e-6)
    # Dominant: reflect(-(-z), +z) = reflect(+z, +z) = -z, but we have
    # reflect(inc, n) where inc points from light toward reflector = -z.
    # reflected = inc - 2*(inc·n)*n = -z - 2*(-1)*+z = -z + 2z = +z.
    assert np.allclose(dom, [0, 0, 1], atol=1e-6)


def test_light_behind_reflector_contributes_zero() -> None:
    # Reflector normal +z; light shining from -z side toward reflector would
    # hit the back face. We define "L_dir" as the direction toward the light
    # from the reflector; for that to be on the front side, the light must be
    # on the +z side of the reflector. A directional light with direction +z
    # means rays travel +z, so the source is on the -z side → back of reflector.
    light = _dir_light(direction=(0, 0, 1))  # rays travel +z → source at -z
    [(emission, _)] = compute_reflector_emission([_refl()], [light])
    assert np.allclose(emission, [0, 0, 0])


def test_reflectance_scales_emission() -> None:
    light = _dir_light(direction=(0, 0, -1), intensity=1.0)
    [(emission, _)] = compute_reflector_emission(
        [_refl(reflectance=0.5)], [light]
    )
    assert np.allclose(emission, [0.5, 0.5, 0.5], atol=1e-6)


def test_tint_modulates_emission() -> None:
    light = _dir_light(direction=(0, 0, -1), color=(1, 1, 1), intensity=1.0)
    [(emission, _)] = compute_reflector_emission(
        [_refl(color=(1.0, 0.8, 0.6))], [light]
    )
    assert np.allclose(emission, [1.0, 0.8, 0.6], atol=1e-6)


def test_disabled_reflector_returns_zero() -> None:
    light = _dir_light(direction=(0, 0, -1), intensity=1.0)
    [(emission, _)] = compute_reflector_emission(
        [_refl(enabled=False)], [light]
    )
    assert np.allclose(emission, [0, 0, 0])


def test_disabled_light_does_not_contribute() -> None:
    light = _dir_light(direction=(0, 0, -1), intensity=1.0)
    light.enabled = False
    [(emission, _)] = compute_reflector_emission([_refl()], [light])
    assert np.allclose(emission, [0, 0, 0])


def test_two_perpendicular_lights_average_dominant_dir() -> None:
    # Reflector normal +z.
    # Light A: directional, dir = -z → reflects back along +z.
    # Light B: directional, dir = (-1, 0, -1)/sqrt(2) → reflects to (+1, 0, +1)/sqrt(2).
    # Equal intensities → dominant_dir averages to (sqrt(0.5)/2, 0, (1+sqrt(0.5))/2) normalized.
    a = _dir_light(direction=(0, 0, -1), intensity=1.0)
    b = _dir_light(direction=(-1, 0, -1), intensity=1.0)
    [(_, dom)] = compute_reflector_emission([_refl()], [a, b])
    # We don't pin the exact direction; just verify it's between the two
    # reflected rays (positive x and positive z).
    assert dom[0] > 0
    assert dom[2] > 0
    assert abs(np.linalg.norm(dom) - 1.0) < 1e-6


def test_reflector_inputs_ignored_as_emitters() -> None:
    # A reflector should not contribute to another reflector's emission.
    r = _refl()
    other = _refl(position=(0, 0, 0.5))
    [(emission, _)] = compute_reflector_emission([r], [other])
    assert np.allclose(emission, [0, 0, 0])
```

- [ ] **Step 2: Run tests to confirm failure.**

Run: `cd packages/relighting_engine && pytest tests/unit/test_reflector_emission.py -v`
Expected: ImportError or ModuleNotFoundError on `compute_reflector_emission`.

- [ ] **Step 3: Implement `compute_reflector_emission()`.**

Create `packages/relighting_engine/relighting_engine/lighting/reflectors.py`:

```python
"""Stage 1 of reflector math: per-reflector emission + dominant reflected direction.

For each enabled reflector, walks the active emitters and accumulates:
  - emission_rgb: total light bounced back from the reflector surface,
    in linear-sRGB, ready for the shader to use as a virtual area-light
    intensity.
  - dominant_dir: a single unit vector representing the average reflected
    ray direction (intensity-weighted). Drives the glossy lobe in Stage 2.

Reflector→reflector interactions are explicitly skipped (single-bounce).
"""
from __future__ import annotations

from typing import Iterable

import numpy as np

from relighting_engine.lighting.gels import resolve_color
from relighting_engine.lighting.models import Light


def _effective_light_color(light: Light) -> np.ndarray:
    """RGB (linear-sRGB) accounting for color, Kelvin, and gel."""
    rgb = resolve_color(
        base=light.color,
        kelvin=light.color_temperature,
        gel_preset=light.gel_preset,
    )
    return np.array(rgb, dtype=np.float32)


def compute_reflector_emission(
    reflectors: Iterable[Light],
    lights: Iterable[Light],
) -> list[tuple[np.ndarray, np.ndarray]]:
    """Return a list of (emission_rgb, dominant_dir_unit) per reflector.

    Reflectors not enabled or with no incident light produce (zeros(3), normal).
    `lights` is expected to contain only emitters (type != 'reflector');
    any entries with type=='reflector' are silently skipped.
    """
    reflectors = list(reflectors)
    lights = [L for L in lights if L.type != 'reflector' and L.enabled]
    out: list[tuple[np.ndarray, np.ndarray]] = []

    for R in reflectors:
        R_normal = np.array(R.normal, dtype=np.float32)
        n_len = float(np.linalg.norm(R_normal))
        if n_len < 1e-9:
            R_normal = np.array([0.0, 0.0, 1.0], dtype=np.float32)
        else:
            R_normal = R_normal / n_len
        R_pos = np.array(R.position, dtype=np.float32)

        if not R.enabled:
            out.append((np.zeros(3, dtype=np.float32), R_normal))
            continue

        accumulated = np.zeros(3, dtype=np.float32)
        total_irr = 0.0
        dominant = np.zeros(3, dtype=np.float32)

        for L in lights:
            if L.type == 'directional':
                ld = np.array(L.direction, dtype=np.float32)
                ld_len = float(np.linalg.norm(ld))
                if ld_len < 1e-9:
                    continue
                L_dir = -ld / ld_len               # toward light source
                dist_atten = 1.0
            else:
                L_pos = np.array(L.position, dtype=np.float32)
                delta = L_pos - R_pos
                dist = float(np.linalg.norm(delta))
                if dist < 1e-9:
                    continue
                L_dir = delta / dist
                dist_atten = 1.0 / (1.0 + L.falloff * dist * dist)

            facing = float(np.dot(R_normal, L_dir))
            if facing <= 0.0:
                continue

            L_color = _effective_light_color(L)
            irradiance = float(L.intensity) * dist_atten * facing
            accumulated += L_color * irradiance
            total_irr += irradiance

            # Reflected ray: reflect the *incoming* direction (-L_dir) across R_normal.
            inc = -L_dir
            refl = inc - 2.0 * float(np.dot(inc, R_normal)) * R_normal
            dominant += refl * irradiance

        R_color = np.array(R.color, dtype=np.float32)
        emission = accumulated * float(R.reflectance) * R_color

        if total_irr > 0.0:
            dom_len = float(np.linalg.norm(dominant))
            dom_unit = dominant / dom_len if dom_len > 1e-9 else R_normal
        else:
            dom_unit = R_normal

        out.append((emission.astype(np.float32), dom_unit.astype(np.float32)))

    return out
```

- [ ] **Step 4: Run tests to verify they pass.**

Run: `cd packages/relighting_engine && pytest tests/unit/test_reflector_emission.py -v`
Expected: 9 PASS.

- [ ] **Step 5: Commit.**

```bash
git add packages/relighting_engine/relighting_engine/lighting/reflectors.py \
        packages/relighting_engine/tests/unit/test_reflector_emission.py
git commit -m "feat(engine): Stage 1 reflector emission compute (pure function + tests)"
```

---

## Task 3: Reflector contribution in Python render + golden fixture

**Files:**
- Modify: `packages/relighting_engine/relighting_engine/lighting/shaders.py`
- Add: `packages/relighting_engine/tests/fixtures/expected/portrait_a__reflector_fill.png`
- Modify: `packages/relighting_engine/tests/integration/test_render_golden.py` (or wherever goldens are tested — adjust path if different)

- [ ] **Step 1: Investigate the existing render entry point.**

Read `packages/relighting_engine/relighting_engine/lighting/shaders.py` to find the main `render()` function and understand the per-light loop. The reflector contribution slots in next to (or wraps) that loop.

- [ ] **Step 2: Add reflector contribution to render.**

In `shaders.py`, near the top, add an import:

```python
from relighting_engine.lighting.reflectors import compute_reflector_emission
```

Inside `render()` (or the equivalent function that produces the lit output), separate `lights` into two lists immediately at the entry point:

```python
def render(prepared, lights, *, ambient, device, gobo_textures, shadow_style='off'):
    # Split inputs.
    emitters   = [L for L in lights if L.type != 'reflector']
    reflectors = [L for L in lights if L.type == 'reflector']

    # ... existing setup (depth, normals, mask, etc.) ...

    # ... existing per-emitter loop unchanged ...

    # Stage 1: reflector emission.
    refl_data = compute_reflector_emission(reflectors, emitters)

    # Stage 2: per-pixel reflector contribution.
    for R, (emission, dom_dir) in zip(reflectors, refl_data):
        if not R.enabled:
            continue
        if float((emission ** 2).sum()) < 1e-12:
            continue

        # Position in (uv.x, uv.y, depth) coords.
        R_pos    = torch.tensor(R.position, device=device, dtype=torch.float32)
        R_normal = torch.tensor(R.normal,   device=device, dtype=torch.float32)
        R_normal = R_normal / (R_normal.norm() + 1e-9)
        size_area = float(R.size[0] * R.size[1])

        # Per-pixel Lvec.
        Lvec = R_pos[None, None, :] - P                     # (H, W, 3)
        dist = Lvec.norm(dim=-1, keepdim=True) + 1e-6        # (H, W, 1)
        Lvec = Lvec / dist

        facing = (-Lvec * R_normal[None, None, :]).sum(dim=-1).clamp(min=0.0)  # (H, W)
        atten  = size_area / (dist.squeeze(-1) ** 2 + 1.0)                       # (H, W)
        ndotl  = (N * Lvec).sum(dim=-1).clamp(min=0.0)                           # (H, W)

        # Diffuse component.
        diffuse_w = float(R.roughness)
        diffuse   = ndotl * diffuse_w * facing * atten                            # (H, W)

        # Glossy component.
        glossy_w  = 1.0 - float(R.roughness)
        lobe_sharp = 2.0 + (1.0 - float(R.roughness)) * 48.0                      # in [2, 50]
        dom_t = torch.tensor(dom_dir, device=device, dtype=torch.float32)
        align = (Lvec * dom_t[None, None, :]).sum(dim=-1).clamp(min=0.0)          # (H, W)
        glossy = (align ** lobe_sharp) * glossy_w * facing * atten                # (H, W)

        # Apply mask gate (subject/background/all). Reuse the same affects-mask
        # helper the per-emitter loop uses; the variable name in the existing
        # code is typically `mask_affect` or computed inline.
        mask_affect = _affects_mask(R.affects, mask, prepared)   # adapt to local helper

        emit_t = torch.tensor(emission, device=device, dtype=torch.float32)
        contrib = (diffuse + glossy)[..., None] * emit_t[None, None, :]            # (H, W, 3)
        total = total + contrib * mask_affect[..., None]
```

If the existing render function uses different variable names for `total`, `P` (pixel positions), `N` (normals), or the affects-mask helper, adapt to those. The math stays the same.

If the local `_affects_mask` helper doesn't exist as a callable, look at how the existing per-emitter loop handles `affects` and replicate.

- [ ] **Step 3: Generate the golden fixture.**

Add a new fixture scenario in `packages/relighting_engine/tests/fixtures/scenarios.py` (or wherever the scenarios are defined — typically the file lists scenes for golden generation):

```python
PORTRAIT_A_REFLECTOR_FILL = SceneSpec(
    name='portrait_a__reflector_fill',
    image='portrait_a.png',
    ambient=0.15,
    lights=[
        Light(
            type='directional',
            position=(0.7, 0.3, -0.4),
            direction=(-0.5, 0.3, -1),
            color=(1.0, 0.95, 0.85),
            intensity=1.2,
            color_temperature=5500,
        ),
        Light(
            type='reflector',
            position=(0.25, 0.55, -0.4),
            direction=(0, 0, -1),    # unused for reflector
            color=(1.0, 0.95, 0.9),
            normal=(0.5, 0.0, 1.0),
            size=(0.6, 0.4),
            reflectance=0.7,
            roughness=0.6,
        ),
    ],
)
```

Add the scenario to whichever registry/list the golden generator iterates. Then regenerate the fixture:

Run: `python scripts/make_goldens.py --only portrait_a__reflector_fill`
Expected: writes `packages/relighting_engine/tests/fixtures/expected/portrait_a__reflector_fill.png`.

If `--only` isn't a supported flag, just run the script and it'll regenerate this scene along with the others (the existing fixtures are tracked in git, so committing just the new PNG is fine).

- [ ] **Step 4: Run the golden test.**

Find the test that compares rendered output to fixtures (likely in `tests/integration/test_render_golden.py` or `tests/test_goldens.py`). If the scenario list is data-driven, the new scene is picked up automatically. Otherwise add a test case mirroring an existing one:

```python
def test_portrait_a_reflector_fill_matches_golden() -> None:
    _run_golden_scene('portrait_a__reflector_fill')
```

Run: `cd packages/relighting_engine && pytest tests/integration -v -k reflector_fill`
Expected: PASS (a self-consistent regeneration test passes by construction).

- [ ] **Step 5: Run the full engine suite to confirm no regressions.**

Run: `cd packages/relighting_engine && pytest tests --ignore=tests/polish/test_backend_contract.py -x`
Expected: All previous tests pass; the new reflector_fill test passes.

- [ ] **Step 6: Commit.**

```bash
git add packages/relighting_engine/relighting_engine/lighting/shaders.py \
        packages/relighting_engine/tests/fixtures/expected/portrait_a__reflector_fill.png \
        packages/relighting_engine/tests/fixtures/scenarios.py \
        packages/relighting_engine/tests/integration/test_render_golden.py
git commit -m "feat(engine): add reflector per-pixel contribution + golden fixture"
```

If any of the adjusted file paths don't exist as named, omit them from `git add` — only commit what was actually changed.

---

# Stage C — WebGL frontend math

## Task 4: JS Stage 1 emission helper

**Files:**
- Create: `web/src/webgl/reflector-emission.js`

- [ ] **Step 1: Create the JS mirror of `compute_reflector_emission`.**

```javascript
/** Per-reflector emission + dominant reflected direction.
 *
 * Mirrors `relighting_engine/lighting/reflectors.py`. Inputs are the flat
 * `state.lights` array (mixed lights + reflectors). Output is an array of
 * { emission: [r, g, b], dominantDir: [x, y, z] } per reflector in input
 * order (preserves visual indexing into the shader's uniform arrays).
 */

import { kelvinToRgb } from './kelvin.js';   // already exists in the codebase

function vlen(v) { return Math.hypot(v[0], v[1], v[2]); }
function vnorm(v) {
  const L = vlen(v) || 1;
  return [v[0] / L, v[1] / L, v[2] / L];
}
function vdot(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
function vsub(a, b) { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]; }
function vmul(v, s) { return [v[0] * s, v[1] * s, v[2] * s]; }
function vadd(a, b) { return [a[0] + b[0], a[1] + b[1], a[2] + b[2]]; }

function effectiveLightColor(L) {
  // base color × Kelvin-derived RGB. Gel presets would multiply in too; if
  // the codebase has a JS helper, prefer that.
  const base = L.color || [1, 1, 1];
  let rgb = [base[0], base[1], base[2]];
  if (L.color_temperature != null) {
    const k = kelvinToRgb(L.color_temperature);
    rgb = [rgb[0] * k[0], rgb[1] * k[1], rgb[2] * k[2]];
  }
  return rgb;
}

export function computeReflectorEmission(lights) {
  const reflectors = lights.filter((L) => L.type === 'reflector');
  const emitters = lights.filter((L) => L.type !== 'reflector' && L.enabled !== false);

  return reflectors.map((R) => {
    let normal = R.normal || [0, 0, 1];
    if (vlen(normal) < 1e-9) normal = [0, 0, 1];
    normal = vnorm(normal);

    if (R.enabled === false) {
      return { emission: [0, 0, 0], dominantDir: normal };
    }

    let acc = [0, 0, 0];
    let totalIrr = 0;
    let dom = [0, 0, 0];

    for (const L of emitters) {
      let Ldir;
      let distAtten;
      if (L.type === 'directional') {
        const d = L.direction || [0, 0, -1];
        const dLen = vlen(d);
        if (dLen < 1e-9) continue;
        Ldir = vmul(d, -1 / dLen);
        distAtten = 1.0;
      } else {
        const delta = vsub(L.position, R.position);
        const dist = vlen(delta);
        if (dist < 1e-9) continue;
        Ldir = vmul(delta, 1 / dist);
        distAtten = 1.0 / (1.0 + (L.falloff ?? 1) * dist * dist);
      }

      const facing = vdot(normal, Ldir);
      if (facing <= 0) continue;

      const Lc = effectiveLightColor(L);
      const irr = (L.intensity ?? 1) * distAtten * facing;
      acc = vadd(acc, vmul(Lc, irr));
      totalIrr += irr;

      const inc = vmul(Ldir, -1);
      const refl = vsub(inc, vmul(normal, 2 * vdot(inc, normal)));
      dom = vadd(dom, vmul(refl, irr));
    }

    const tint = R.color || [1, 1, 1];
    const refl = R.reflectance ?? 0.7;
    const emission = [
      acc[0] * refl * tint[0],
      acc[1] * refl * tint[1],
      acc[2] * refl * tint[2],
    ];

    const dominantDir = totalIrr > 0 && vlen(dom) > 1e-9 ? vnorm(dom) : normal;
    return { emission, dominantDir };
  });
}
```

- [ ] **Step 2: Check `kelvin.js` exists.**

Run: `ls web/src/webgl/kelvin.js`
Expected: file exists. If not, find the actual file via:

Run: `grep -rn "kelvinToRgb\|kelvinTo" web/src/ | head -5`

Then update the import path accordingly.

- [ ] **Step 3: Commit.**

```bash
git add web/src/webgl/reflector-emission.js
git commit -m "feat(web): JS Stage 1 reflector-emission helper (mirrors Python)"
```

---

## Task 5: GLSL fragment shader: reflector loop

**Files:**
- Modify: `web/src/webgl/shaders/relight.frag`
- Modify: `web/src/webgl/renderer.js`

- [ ] **Step 1: Add reflector uniforms to the fragment shader.**

Open `web/src/webgl/shaders/relight.frag`. Near the existing `u_l_*` uniform declarations, add:

```glsl
#define MAX_REFLECTORS 4

uniform int   u_reflectorCount;
uniform vec3  u_r_position[MAX_REFLECTORS];
uniform vec3  u_r_normal[MAX_REFLECTORS];
uniform vec3  u_r_emission[MAX_REFLECTORS];
uniform vec3  u_r_dominant_dir[MAX_REFLECTORS];
uniform vec2  u_r_size[MAX_REFLECTORS];
uniform float u_r_roughness[MAX_REFLECTORS];
uniform int   u_r_enabled[MAX_REFLECTORS];
uniform int   u_r_affects[MAX_REFLECTORS];
```

In `main()`, immediately after the existing per-light loop, before the final fragColor write, add:

```glsl
  for (int i = 0; i < MAX_REFLECTORS; i++) {
    if (i >= u_reflectorCount) break;
    if (u_r_enabled[i] == 0) continue;

    // affects gating: 0=all, 1=subject, 2=background. Reuse existing helper if
    // present; otherwise inline:
    float maskAffect = 1.0;
    if (u_r_affects[i] == 1) maskAffect = maskV;
    else if (u_r_affects[i] == 2) maskAffect = 1.0 - maskV;
    if (maskAffect <= 0.0) continue;

    vec3  R_pos   = u_r_position[i];
    vec3  R_norm  = u_r_normal[i];
    vec3  R_emit  = u_r_emission[i];
    vec3  R_refl  = u_r_dominant_dir[i];
    float rough   = u_r_roughness[i];
    vec2  R_size  = u_r_size[i];

    vec3 Lvec = R_pos - P;
    float dist = length(Lvec) + 1e-6;
    Lvec /= dist;

    float facing = max(0.0, dot(R_norm, -Lvec));
    if (facing <= 0.0) continue;

    float area  = R_size.x * R_size.y;
    float atten = area / (dist * dist + 1.0);

    float diffuse_w = rough;
    float ndotl     = max(0.0, dot(N, Lvec));
    vec3  diffuse_c = R_emit * ndotl * diffuse_w * facing * atten;

    float glossy_w     = 1.0 - rough;
    float lobe_sharp   = mix(2.0, 50.0, 1.0 - rough);
    float align        = max(0.0, dot(Lvec, R_refl));
    float lobe         = pow(align, lobe_sharp);
    vec3  glossy_c     = R_emit * lobe * glossy_w * facing * atten;

    total += maskAffect * (diffuse_c + glossy_c);
  }
```

- [ ] **Step 2: Wire the uniforms in `renderer.js`.**

Open `web/src/webgl/renderer.js`. Find the `locs` object that maps uniform names to GL locations (where `u_l_position` etc. are looked up). After the existing lights block, add:

```javascript
  u_reflectorCount:  gl.getUniformLocation(program, 'u_reflectorCount'),
  u_r_position:      gl.getUniformLocation(program, 'u_r_position'),
  u_r_normal:        gl.getUniformLocation(program, 'u_r_normal'),
  u_r_emission:      gl.getUniformLocation(program, 'u_r_emission'),
  u_r_dominant_dir:  gl.getUniformLocation(program, 'u_r_dominant_dir'),
  u_r_size:          gl.getUniformLocation(program, 'u_r_size'),
  u_r_roughness:     gl.getUniformLocation(program, 'u_r_roughness'),
  u_r_enabled:       gl.getUniformLocation(program, 'u_r_enabled'),
  u_r_affects:       gl.getUniformLocation(program, 'u_r_affects'),
```

Add at the top of the file:

```javascript
import { computeReflectorEmission } from './reflector-emission.js';
```

In the `draw(state)` function, before the per-light uniform uploads, split lights and compute emission:

```javascript
  const allLights = state.lights || [];
  const reflectors = allLights.filter((L) => L.type === 'reflector');
  const emitters   = allLights.filter((L) => L.type !== 'reflector');
  const reflEmission = computeReflectorEmission(allLights);
```

Use `emitters` for the existing per-emitter uniform fill loop (replace the current `state.lights` reference there so reflectors are not erroneously included).

After the existing per-emitter uniform fill, add the reflector uniform fill:

```javascript
  const MAX_REFLECTORS = 4;
  const rCount = Math.min(reflectors.length, MAX_REFLECTORS);
  gl.uniform1i(locs.u_reflectorCount, rCount);

  const flatVec3 = (arr) => {
    const out = new Float32Array(MAX_REFLECTORS * 3);
    for (let i = 0; i < rCount; i++) {
      out[i*3+0] = arr[i][0];
      out[i*3+1] = arr[i][1];
      out[i*3+2] = arr[i][2];
    }
    return out;
  };
  const flatVec2 = (arr) => {
    const out = new Float32Array(MAX_REFLECTORS * 2);
    for (let i = 0; i < rCount; i++) {
      out[i*2+0] = arr[i][0];
      out[i*2+1] = arr[i][1];
    }
    return out;
  };

  const positions = reflectors.map((r) => r.position || [0,0,0]);
  const normals   = reflectors.map((r) => r.normal   || [0,0,1]);
  const emissions = reflEmission.map((r) => r.emission || [0,0,0]);
  const domDirs   = reflEmission.map((r) => r.dominantDir || [0,0,1]);
  const sizes     = reflectors.map((r) => r.size || [0.6, 0.4]);
  const rough     = new Float32Array(MAX_REFLECTORS);
  const enabled   = new Int32Array(MAX_REFLECTORS);
  const affects   = new Int32Array(MAX_REFLECTORS);
  for (let i = 0; i < rCount; i++) {
    rough[i]   = reflectors[i].roughness ?? 0.5;
    enabled[i] = reflectors[i].enabled === false ? 0 : 1;
    affects[i] = reflectors[i].affects === 'subject' ? 1
              : reflectors[i].affects === 'background' ? 2 : 0;
  }

  gl.uniform3fv(locs.u_r_position,     flatVec3(positions));
  gl.uniform3fv(locs.u_r_normal,       flatVec3(normals));
  gl.uniform3fv(locs.u_r_emission,     flatVec3(emissions));
  gl.uniform3fv(locs.u_r_dominant_dir, flatVec3(domDirs));
  gl.uniform2fv(locs.u_r_size,         flatVec2(sizes));
  gl.uniform1fv(locs.u_r_roughness,    rough);
  gl.uniform1iv(locs.u_r_enabled,      enabled);
  gl.uniform1iv(locs.u_r_affects,      affects);
```

- [ ] **Step 3: Smoke-check syntactically.**

Run: `node --check web/src/webgl/reflector-emission.js && node --check web/src/webgl/renderer.js && echo OK`
Expected: `OK`.

- [ ] **Step 4: Commit.**

```bash
git add web/src/webgl/shaders/relight.frag web/src/webgl/renderer.js
git commit -m "feat(web): GLSL + JS reflector uniforms and per-pixel contribution"
```

---

# Stage D — Frontend UI

## Task 6: Reflector preset card + thumbnail

**Files:**
- Modify: `web/src/presets.js`
- Modify: `scripts/make_preset_thumbs.py`
- Add: `web/preset-thumbs/reflector.jpg`

- [ ] **Step 1: Add the preset.**

Open `web/src/presets.js`. Add this entry at the end of the `PRESETS` array (after the Omni entry):

```javascript
  {
    id: 'reflector',
    name: 'Reflector',
    icon: '▭',
    description: 'Bounce card — silver/white, 5000 K',
    fields: {
      type: 'reflector',
      position: [0.25, 0.55, -0.4],
      direction: [0, 0, -1],
      color_temperature: 5000,
      intensity: 1.0,
      falloff: 1.0,
      cone_angle: 0.5,
      softness: 0.1,
      // Reflector-specific:
      normal: [0.5, 0.0, 1.0],
      size: [0.6, 0.4],
      reflectance: 0.7,
      roughness: 0.5,
    },
  },
```

Note: include the full `fields` block including the legacy non-reflector keys (`direction`, `intensity`, etc.) — `lightFromPreset` doesn't filter them, and they're harmless defaults.

- [ ] **Step 2: Verify `lightFromPreset` carries through the new fields.**

Open `web/src/lights.js`. Find `lightFromPreset`. Make sure it copies through `normal`, `size`, `reflectance`, `roughness` from `preset.fields`. If `lightFromPreset` enumerates fields explicitly, add the four new keys:

```javascript
    normal:       preset.fields.normal       ?? [0, 0, -1],
    size:         preset.fields.size         ?? [0.6, 0.4],
    reflectance:  preset.fields.reflectance  ?? 0.7,
    roughness:    preset.fields.roughness    ?? 0.5,
```

If `lightFromPreset` uses object spread, no change needed.

- [ ] **Step 3: Render the thumbnail.**

Update `scripts/make_preset_thumbs.py` to render a reflector preset thumbnail. Find the preset list inside the script and add an entry mirroring the JS preset:

```python
PRESETS_TO_RENDER.append({
    'id': 'reflector',
    'lights': [
        # A modest key so the reflector has something to bounce.
        Light(type='directional', position=(0.7, 0.3, -0.4),
              direction=(-0.3, 0.3, -1), color=(1, 1, 1),
              intensity=1.0, color_temperature=5500),
        # The reflector being demoed.
        Light(type='reflector', position=(0.25, 0.55, -0.4),
              direction=(0, 0, -1), color=(1.0, 0.95, 0.9),
              normal=(0.5, 0.0, 1.0), size=(0.6, 0.4),
              reflectance=0.7, roughness=0.5),
    ],
})
```

The exact API depends on how `make_preset_thumbs.py` is structured — adapt to it. If the script auto-discovers presets from a single JSON or matches the JS preset names, just add the matching entry.

Run: `python scripts/make_preset_thumbs.py`
Expected: writes `web/preset-thumbs/reflector.jpg`.

- [ ] **Step 4: Commit.**

```bash
git add web/src/presets.js web/src/lights.js scripts/make_preset_thumbs.py web/preset-thumbs/reflector.jpg
git commit -m "feat(web): Reflector preset card + thumbnail"
```

---

## Task 7: Properties panel branch for reflectors

**Files:**
- Modify: `web/src/controls.js`

- [ ] **Step 1: Add a reflector-specific branch in `renderProps`.**

Open `web/src/controls.js`. Find the main `renderProps()` function. Near the top, branch on the selected light's type:

```javascript
export function renderProps(state, container, onChange) {
  const L = state.lights.find((l) => l.id === state.selectedId);
  if (!L) {
    container.innerHTML = '<p class="props-empty">Select a light or the scene.</p>';
    return;
  }
  if (L.type === 'reflector') {
    renderReflectorProps(state, L, container, onChange);
    return;
  }
  // ... existing flow for directional / point / spotlight ...
}
```

Add the new `renderReflectorProps` function above (or next to) `renderProps`:

```javascript
function renderReflectorProps(state, L, container, onChange) {
  container.innerHTML = `
    <div class="props-header">
      <span class="tree-icon">▭</span>
      <h2 contenteditable="true" class="props-name">${escapeHtml(L.name)}</h2>
    </div>

    <label class="prop-row">
      <span class="prop-label">Enabled</span>
      <input type="checkbox" class="prop-input" data-prop="enabled"
             ${L.enabled === false ? '' : 'checked'} />
    </label>

    <label class="prop-row">
      <span class="prop-label">Affects</span>
      <select class="prop-input" data-prop="affects">
        <option value="all"        ${L.affects === 'all'        ? 'selected' : ''}>All</option>
        <option value="subject"    ${L.affects === 'subject'    ? 'selected' : ''}>Subject only</option>
        <option value="background" ${L.affects === 'background' ? 'selected' : ''}>Background only</option>
      </select>
    </label>

    <label class="prop-row">
      <span class="prop-label">Width</span>
      <input type="range" class="prop-input" data-prop="size[0]"
             min="0.1" max="2.0" step="0.05" value="${L.size?.[0] ?? 0.6}" />
    </label>

    <label class="prop-row">
      <span class="prop-label">Height</span>
      <input type="range" class="prop-input" data-prop="size[1]"
             min="0.1" max="2.0" step="0.05" value="${L.size?.[1] ?? 0.4}" />
    </label>

    <label class="prop-row">
      <span class="prop-label">Color</span>
      <input type="color" class="prop-input" data-prop="color"
             value="${rgbToHexAttr(L.color)}" />
    </label>

    <label class="prop-row">
      <span class="prop-label">Reflectance</span>
      <input type="range" class="prop-input" data-prop="reflectance"
             min="0" max="1" step="0.05" value="${L.reflectance ?? 0.7}" />
    </label>

    <label class="prop-row">
      <span class="prop-label">Glossy ←→ Matte</span>
      <input type="range" class="prop-input" data-prop="roughness"
             min="0" max="1" step="0.05" value="${L.roughness ?? 0.5}" />
    </label>
  `;

  // Wire change events. The existing renderProps does similar binding; mirror
  // whichever pattern is in use. A common approach:
  for (const el of container.querySelectorAll('.prop-input')) {
    el.addEventListener('input', () => applyReflectorEdit(L, el, onChange));
    el.addEventListener('change', () => applyReflectorEdit(L, el, onChange));
  }
  const nameEl = container.querySelector('.props-name');
  if (nameEl) {
    nameEl.addEventListener('blur', () => {
      L.name = nameEl.textContent.trim() || 'Reflector';
      onChange?.();
    });
  }
}

function applyReflectorEdit(L, el, onChange) {
  const prop = el.dataset.prop;
  if (prop === 'enabled') {
    L.enabled = el.checked;
  } else if (prop === 'affects') {
    L.affects = el.value;
  } else if (prop === 'size[0]') {
    L.size = [parseFloat(el.value), L.size?.[1] ?? 0.4];
  } else if (prop === 'size[1]') {
    L.size = [L.size?.[0] ?? 0.6, parseFloat(el.value)];
  } else if (prop === 'color') {
    L.color = hexToRgb(el.value);
  } else if (prop === 'reflectance') {
    L.reflectance = parseFloat(el.value);
  } else if (prop === 'roughness') {
    L.roughness = parseFloat(el.value);
  }
  onChange?.();
}
```

If `rgbToHexAttr`, `hexToRgb`, and `escapeHtml` don't exist locally, look at how the existing `renderProps` for spotlight/directional reads/writes color — reuse those helpers.

- [ ] **Step 2: Smoke-check syntax.**

Run: `node --check web/src/controls.js && echo OK`
Expected: `OK`.

- [ ] **Step 3: Commit.**

```bash
git add web/src/controls.js
git commit -m "feat(web): properties panel branch for reflectors (size, tint, reflectance, roughness)"
```

---

## Task 8: 2D anchor styling for reflectors

**Files:**
- Modify: `web/src/handles.js`
- Modify: `web/playground.css`

- [ ] **Step 1: Distinguish reflectors visually in the anchor renderer.**

Open `web/src/handles.js`. Find the loop that renders one DOM dot per `state.lights[i]`. The existing code likely creates a `<div class="handle handle--SLOT">` per light. Add a class based on type:

```javascript
// Inside the loop where each handle is created:
els[i].classList.toggle('handle--reflector', L.type === 'reflector');
```

If the existing code sets `class` via direct assignment, append `' handle--reflector'` when applicable.

- [ ] **Step 2: Add CSS for the reflector handle.**

Append to `web/playground.css`:

```css
/* ─── Reflector anchor ─────────────────────────────────────────────────── */

.handle.handle--reflector {
  background: #6acfff;                   /* light cyan, distinct from slot colors */
  border: 2px solid var(--handle-ring, #fff);
  /* Square the handle to hint at "bounce card" */
  border-radius: 3px;
  outline: 1px solid rgba(106, 207, 255, 0.4);
  outline-offset: 2px;
}
```

- [ ] **Step 3: Commit.**

```bash
git add web/src/handles.js web/playground.css
git commit -m "feat(web): cyan-square 2D anchor styling for reflectors"
```

---

## Task 9: 3D plane primitive for reflectors

**Files:**
- Modify: `web/src/3d/light-primitives.js`
- Modify: `web/src/3d/sync.js`

- [ ] **Step 1: Add a reflector branch in `buildLightPrimitive`.**

Open `web/src/3d/light-primitives.js`. Add a top-level import for `directionToWorld`:

```javascript
import { directionToWorld, lightToWorld } from './coords.js';
```

Inside `buildLightPrimitive(light)`, near the existing branching on `light.type`, before the existing `sphere`/`arrow`/`cone` construction (or, more cleanly, gate the existing construction on `light.type !== 'reflector'`), add:

```javascript
  if (light.type === 'reflector') {
    return buildReflectorPrimitive(light);
  }
```

Then add the new function below `buildLightPrimitive`:

```javascript
function buildReflectorPrimitive(light) {
  const group = new THREE.Group();
  group.userData.lightId = light.id;
  group.position.set(...lightToWorld(light.position));

  const sx = light.size?.[0] ?? 0.6;
  const sy = light.size?.[1] ?? 0.4;

  const planeGeo = new THREE.PlaneGeometry(sx, sy);
  const tintHex  = rgbToHex(light.color);

  const front = new THREE.MeshBasicMaterial({
    color: tintHex, transparent: true, opacity: 0.5, side: THREE.FrontSide,
  });
  const back  = new THREE.MeshBasicMaterial({
    color: 0x222222, side: THREE.BackSide,
  });

  const plane = new THREE.Mesh(planeGeo, front);
  plane.userData.lightId = light.id;
  group.add(plane);
  const planeBack = new THREE.Mesh(planeGeo, back);
  planeBack.userData.lightId = light.id;
  group.add(planeBack);

  // Orient so plane's local +Z (its normal) matches the engine normal in world.
  const worldNormal = new THREE.Vector3(...directionToWorld(light.normal));
  plane.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), worldNormal);
  planeBack.quaternion.copy(plane.quaternion);

  // Hit target: a slightly larger invisible plane for easier raycast.
  const hitGeo = new THREE.PlaneGeometry(sx * 1.1, sy * 1.1);
  const hitMat = new THREE.MeshBasicMaterial({ visible: false, side: THREE.DoubleSide });
  const hit = new THREE.Mesh(hitGeo, hitMat);
  hit.userData.lightId = light.id;
  hit.userData.isHitTarget = true;
  hit.quaternion.copy(plane.quaternion);
  group.add(hit);

  // Selection outline (rectangle wire).
  const outlineGeo = new THREE.EdgesGeometry(planeGeo);
  const outlineMat = new THREE.LineBasicMaterial({ color: 0xffff00 });
  const outline = new THREE.LineSegments(outlineGeo, outlineMat);
  outline.visible = false;
  outline.quaternion.copy(plane.quaternion);
  group.add(outline);

  const prim = {
    group, sphere: plane, hit, arrow: null, cone: null, outline,
  };
  prim.update = (next) => updateReflector(prim, next);
  return prim;
}

function updateReflector(prim, light) {
  prim.group.position.set(...lightToWorld(light.position));
  const sx = light.size?.[0] ?? 0.6;
  const sy = light.size?.[1] ?? 0.4;

  // Rebuild geometries if size changed (cheap).
  prim.sphere.geometry.dispose();
  prim.sphere.geometry = new THREE.PlaneGeometry(sx, sy);
  prim.hit.geometry.dispose();
  prim.hit.geometry = new THREE.PlaneGeometry(sx * 1.1, sy * 1.1);
  prim.outline.geometry.dispose();
  prim.outline.geometry = new THREE.EdgesGeometry(prim.sphere.geometry);

  prim.sphere.material.color.set(rgbToHex(light.color));
  const worldNormal = new THREE.Vector3(...directionToWorld(light.normal));
  prim.sphere.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), worldNormal);
  prim.hit.quaternion.copy(prim.sphere.quaternion);
  prim.outline.quaternion.copy(prim.sphere.quaternion);

  // Sync the second (back-side) plane mesh that was added in build.
  // It's the only other child in the group with userData.lightId set.
  for (const child of prim.group.children) {
    if (child !== prim.sphere && child !== prim.hit && child !== prim.outline &&
        child.isMesh) {
      child.quaternion.copy(prim.sphere.quaternion);
      child.geometry.dispose();
      child.geometry = prim.sphere.geometry;
    }
  }
}
```

The existing `disposeLightPrimitive(prim)` function should still work since it disposes whatever's attached, but make sure it doesn't assume `arrow` and `cone` exist (it should already null-check those — verify and add null guards if missing).

- [ ] **Step 2: Update `sync.js` so reflector field changes are picked up by diff.**

Open `web/src/3d/sync.js`. Find `shallowLightEqual()`. Add comparisons for the new fields after the existing `color` check:

```javascript
  if (!arrayEq(a.normal, b.normal)) return false;
  if (!arrayEq(a.size, b.size)) return false;
  if ((a.reflectance ?? null) !== (b.reflectance ?? null)) return false;
  if ((a.roughness ?? null) !== (b.roughness ?? null)) return false;
```

- [ ] **Step 3: Smoke-check syntax.**

Run: `node --check web/src/3d/light-primitives.js && node --check web/src/3d/sync.js && echo OK`
Expected: `OK`.

- [ ] **Step 4: Commit.**

```bash
git add web/src/3d/light-primitives.js web/src/3d/sync.js
git commit -m "feat(web): 3D plane primitive for reflectors + diff handles new fields"
```

---

## Task 10: Gizmo rotate writeback routes to `normal` for reflectors

**Files:**
- Modify: `web/src/3d/gizmos.js`

- [ ] **Step 1: Branch the rotate writeback.**

Open `web/src/3d/gizmos.js`. Find the `objectChange` listener that does the rotate writeback. Currently it computes `worldDir` from the rotated group's local -Y axis and writes it to `direction` via `onRotate(id, engDir)`. Update so that for reflectors:
- The world normal direction comes from the plane's local +Z (not -Y).
- The writeback target is `normal` rather than `direction`.

Modify the listener:

```javascript
  gizmo.addEventListener('objectChange', () => {
    if (!attachedLightId || !attachedPrimitive) return;
    const g = attachedPrimitive.group;
    if (gizmo.getMode() === 'translate') {
      const engPos = worldToLight([g.position.x, g.position.y, g.position.z]);
      onTranslate(attachedLightId, engPos);
    } else if (gizmo.getMode() === 'rotate' && attachedLightType !== 'point') {
      if (attachedLightType === 'reflector') {
        // The plane primitive's "front" is its local +Z axis. Rotate it and
        // read out the world-space normal, then convert back to engine.
        const worldDir = new THREE.Vector3(0, 0, 1).applyQuaternion(g.quaternion).normalize();
        const engNormal = worldToDirection([worldDir.x, worldDir.y, worldDir.z]);
        onRotate(attachedLightId, engNormal, 'normal');
      } else {
        const worldDir = new THREE.Vector3(0, -1, 0).applyQuaternion(g.quaternion).normalize();
        const engDir = worldToDirection([worldDir.x, worldDir.y, worldDir.z]);
        onRotate(attachedLightId, engDir, 'direction');
      }
    }
  });
```

Note: I added a third argument to `onRotate` indicating which field to patch (`'normal'` or `'direction'`). Update `onRotate`'s call site in `index.js` accordingly.

- [ ] **Step 2: Update the `onRotate` adapter in `index.js`.**

Open `web/src/3d/index.js`. Find:

```javascript
    onRotate: (id, dir) => {
      if (onLightChange) onLightChange(id, { direction: dir });
    },
```

Replace with:

```javascript
    onRotate: (id, vec, field) => {
      if (onLightChange) onLightChange(id, { [field]: vec });
    },
```

Also `main.js`'s `onUpdateLight` callback already destructures patch keys (`if (patch.position) ... if (patch.direction) ...`); add the symmetric line for normal:

In `web/src/main.js`, find:

```javascript
    onUpdateLight: (id, patch) => {
      const L = state.lights.find((l) => l.id === id);
      if (!L) return;
      if (patch.position) L.position = patch.position;
      if (patch.direction) L.direction = patch.direction;
      onChange();
    },
```

Replace with:

```javascript
    onUpdateLight: (id, patch) => {
      const L = state.lights.find((l) => l.id === id);
      if (!L) return;
      if (patch.position)  L.position  = patch.position;
      if (patch.direction) L.direction = patch.direction;
      if (patch.normal)    L.normal    = patch.normal;
      onChange();
    },
```

Also update `gizmos.js`'s `attach()` to allow rotate mode for reflectors (the existing guard probably says `if (mode === 'rotate' && attachedLightType === 'point') return;` — reflectors should permit rotate). Verify and adjust:

```javascript
  function setMode(mode) {
    if (mode === 'rotate' && attachedLightType === 'point') return;
    gizmo.setMode(mode);
  }
```

This already permits rotate for reflectors. Good.

- [ ] **Step 3: Smoke-check syntax.**

Run: `node --check web/src/3d/gizmos.js && node --check web/src/3d/index.js && node --check web/src/main.js && echo OK`
Expected: `OK`.

- [ ] **Step 4: Commit.**

```bash
git add web/src/3d/gizmos.js web/src/3d/index.js web/src/main.js
git commit -m "feat(web): gizmo rotate writeback targets light.normal for reflectors"
```

---

## Task 11: Tree pane icon for reflectors

**Files:**
- Modify: `web/src/tree.js`

- [ ] **Step 1: Add a reflector icon case.**

Open `web/src/tree.js`. Find the function that decides which icon glyph to show for a light row. It likely has a switch or ternary on `light.type`. Add a case for reflector:

```javascript
function lightIcon(L) {
  if (L.type === 'reflector')  return '▭';
  if (L.type === 'directional') return '☀';
  if (L.type === 'point')       return '⊙';
  if (L.type === 'spotlight')   return '◉';
  return '○';
}
```

Adapt to whatever the existing function structure is — if icons are looked up via a map, add `reflector: '▭'`.

- [ ] **Step 2: Commit.**

```bash
git add web/src/tree.js
git commit -m "feat(web): reflector icon in tree pane"
```

---

# Stage E — Verification

## Task 12: Manual checklist sweep

**Files:** None (verification only)

- [ ] **Step 1: Run the full Python test suite.**

Run: `cd packages/relighting_engine && pytest tests --ignore=tests/polish/test_backend_contract.py`
Expected: All tests pass (engine suite + new reflector tests + golden).

Run: `cd packages/relighting_api && pytest tests`
Expected: All tests pass.

- [ ] **Step 2: Manual UI walkthrough.**

Start the dev server, open the playground, then work through this checklist:

  1. Load any scene. Open **+ Light** picker — a **Reflector** card (▭ icon) is visible.
  2. Click Reflector. A new entry appears in the tree pane with the ▭ icon, and a cyan square dot appears on the photo at the preset position.
  3. Select the reflector in the tree. Props panel shows: name, enabled, affects, width, height, color, reflectance, roughness sliders — and does NOT show direction/intensity/cone/softness fields.
  4. In the 3D viewport, the reflector renders as a tinted translucent plane with a darker back face.
  5. Click the plane in 3D — selection outline appears on its edges.
  6. Drag the gizmo (translate, default) — both the 2D cyan anchor and the 3D plane move; the live render's lighting changes on the subject.
  7. Press **R** to switch to rotate gizmo. Drag the rotate handles — the plane's orientation changes, and the bounced-light effect on the subject shifts direction.
  8. Press **G** to switch back to translate. Continue to use both modes.
  9. Set `Glossy ←→ Matte` slider to 0 (full glossy) — see a directional streak from the reflector. Set to 1 (full matte) — see soft Lambertian fill instead.
  10. Set `Reflectance` to 0 — reflector stops contributing. Set to 1 — maximum bounce.
  11. Change `Color` tint to gold — bounced light picks up a warm cast.
  12. Toggle `Enabled` off — contribution disappears.
  13. Add 4 reflectors. All contribute. Add a 5th — the 5th's contribution silently truncates (no error, no contribution, no warning yet — acceptable for v1).
  14. Save the scene (auto-save fires on change). Reload the page. Reflectors load with all fields restored.
  15. Export a scene `.relight.zip`, re-import it. Reflectors round-trip correctly.

- [ ] **Step 3: If anything fails, fix and re-test.**

Common likely issues:
- **Reflector contribution not visible in 2D render:** verify `renderer.js` is splitting reflectors out of `state.lights` and passing the new uniforms; verify `relight.frag` is compiling with the new uniform declarations (check console for shader compile errors).
- **Plane doesn't rotate with gizmo:** verify the gizmo's rotate-mode writeback is routing to `normal` for reflectors and `onChange()` is called.
- **2D anchor doesn't show or shows in wrong color:** verify the `handle--reflector` class is being added and the CSS rule matched.
- **Reflectance/roughness slider doesn't trigger re-render:** verify `applyReflectorEdit` calls `onChange?.()` so the throttled render fires.

- [ ] **Step 4: Commit any fixes (if needed).**

```bash
git add <fixed files>
git commit -m "fix(web): reflector checklist fixes"
```

---

# Wrap-up

After Task 12 passes:

- Confirm full test suite still green: `pytest packages/relighting_engine/tests packages/relighting_api/tests --ignore=packages/relighting_engine/tests/polish/test_backend_contract.py`.
- README update is optional; defer if you have other pending README work.

---

# Self-Review Checklist (for the planner)

Verified before this plan was committed:

- **Spec coverage:** every section of the spec maps to a task.
  - Architecture (two-stage rendering) → Tasks 2 + 3 (Python), 4 + 5 (WebGL).
  - Data model + schema → Task 1.
  - Engine math Stage 1 → Task 2.
  - Engine math Stage 2 (Python) → Task 3.
  - Engine math Stage 2 (WebGL) → Task 5.
  - Preset card → Task 6.
  - Props panel branch → Task 7.
  - 2D anchor styling → Task 8.
  - 3D plane primitive → Task 9.
  - Gizmo rotate writeback for normal → Task 10.
  - Tree pane icon → Task 11.
  - Tests (unit + golden + manual) → Tasks 1, 2, 3, 12.

- **No placeholders:** every step has actual code or an exact command.

- **Type consistency:** Reflector field names (`normal`, `size`, `reflectance`, `roughness`) are consistent across Pydantic schema, engine dataclass, JS preset, props panel, primitive builder, sync diff, and the GLSL uniforms. The `(emission, dominantDir)` return shape from `computeReflectorEmission` matches between Python (`(np.ndarray, np.ndarray)`) and JS (`{emission, dominantDir}`).
