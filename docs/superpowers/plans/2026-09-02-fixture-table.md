# Fixture Table Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Table-driven rig entry for calibrated scenes: venues with hang positions, fixtures of real types focused on acting areas, a linear light for cyc/strip units, and a renderer that handles up to 64 lights.

**Architecture:** Fixtures are the existing light objects plus a `fixture` block (type, position, offset, area). A pure geometry module derives feet positions and targets from a venue's positions and grid; presets set engine parameters per fixture type. Venues are a new workspace-scoped SQLite store with CRUD routes; scenes reference a venue and keep a snapshot. The engine gains a `linear` light type (segment light) in both GLSL and Python; the WebGL renderer accumulates chunks of 8 lights into a float framebuffer. UI: left-pane tabs with a draggable divider, a Rig tab with positions and fixtures tables, a venue editor, tree groups generated from positions, and grid overlays.

**Tech Stack:** Vanilla ES modules, WebGL2 (EXT_color_buffer_float for accumulation), Three.js 0.165, node:test, Playwright (`web/tests/playwright.config.js`), FastAPI + Pydantic, SQLite via the existing `SceneStore` pattern, PyTorch engine, pytest.

**Spec:** `docs/superpowers/specs/2026-09-02-fixture-table-design.md`

## Global Constraints

- World frame and feet fields from Spec 1: +X audience right (stage left), +Y up, +Z upstage; `position_ft`/`target_ft`/`direction_ft` are engine truth; `syncLightFromFeet` (web/src/metric/light-metric.js) must run after any feet change.
- Position kinds → fixture world position: `pipe` `[offset, trim, upstage]`; `boom` `[offset, height, upstage]` (fixture `offset_ft` is the height on a boom); `floor` `[offset, 0.5, upstage]`.
- Acting areas: labels `1..rows×cols`; house-view numbering: row 1 downstage, column 1 audience-left (negative X); `number_from_stage_left` mirrors columns. Target = cell center at `focus_height_ft` (default 5).
- Type presets exactly as the spec's table; engine `cone_angle` = field angle / 2 in radians; changing type preserves position, offset, area, name, enabled, intensity.
- Linear light: `type: 'linear'`, endpoints `endpoint_a_ft`/`endpoint_b_ft` (feet) and `endpoint_a`/`endpoint_b` (engine); shading from the closest point Q on the segment; wrap diffuse `max(dot(N,L)+s,0)/(1+s)`; no cone, no gobo; shadows march toward Q's engine proxy. Shader type id 3; `u_l_position` carries endpoint A, `u_l_endpoint_b` carries B.
- Multi-pass: `MAX_LIGHTS` stays 8 per pass; ≤ 8 enabled emitters must render through today's single pass bit-identically; cap 64 enabled emitters; ambient only in pass 1; half-float accumulation with RGBA8 fallback and a console warning.
- Venues are workspace-scoped like scenes; delete is 409 while referenced unless `?force=1`; scenes keep `venue_snapshot`.
- Tests: `npm run test:unit`; `.venv/Scripts/python -m pytest packages/relighting_engine/tests -q`; `.venv/Scripts/python -m pytest packages/relighting_api/tests -q`; Playwright `npx playwright test --config=web/tests/playwright.config.js --reporter=list` with no dev server on :8765.
- Per CLAUDE.md run `impact` before modifying existing symbols and `detect_changes` before committing (log the results in the task report; do not relay flags to the user, per their instruction). Commit trailers as in commit `1c67066`.
- Synthetic venue for tests (`SYNTHETIC_VENUE` exported from `web/src/rig/geometry.js`): 40 × 20 × 30 ft, grid 3×3, focus 5 ft, positions `FOH` pipe upstage −52 trim 22, `1E` pipe upstage 6 trim 20, `2E` pipe 14/20, `3E` pipe 22/20, `BSR` boom offset −22 upstage 8, `BSL` boom offset 22 upstage 8.

---

## File map

Create: `web/src/rig/geometry.js`, `web/src/rig/presets.js`, `web/src/rig/venue-api.js` (client), `web/src/rig/rig-tab.js`, `web/src/rig/venue-editor.js`, `web/src/rig/tree-mirror.js`, `web/src/pane-divider.js`, `web/src/3d/rig-overlay.js`, `web/src/areas-overlay-2d.js`; `web/tests/unit/rig/*.test.js`, `web/tests/smoke-rig.spec.js`; `packages/relighting_api/relighting_api/venue_store.py`, `routes/venues.py`, `tests/api/test_venues.py`; `packages/relighting_engine/tests/unit/test_linear_light.py`.

Modify: `web/src/webgl/shaders/relight.frag`, `web/src/webgl/renderer.js`, `web/src/main.js`, `web/src/lights.js`, `web/src/tree.js`, `web/src/controls.js`, `web/src/new-scene-popup.js`, `web/src/api.js`, `web/src/split-view.js` (extract drag helper), `web/src/3d/index.js`, `web/src/3d/light-primitives.js`, `web/src/3d/stage.js`, `web/src/metric/light-metric.js`, `web/playground.html`, `web/playground.css`; `packages/relighting_engine/relighting_engine/lighting/models.py`, `lighting/shaders.py`; `packages/relighting_api/relighting_api/schemas.py`, `main.py`, `routes/scenes.py`; `packages/relighting_engine/tests/golden/configs.py`; `web/tests/parity.spec.js`.

---

### Task 1: Rig geometry and presets (pure)

**Files:**
- Create: `web/src/rig/geometry.js`, `web/src/rig/presets.js`
- Test: `web/tests/unit/rig/geometry.test.js`, `web/tests/unit/rig/presets.test.js`
- Modify: `package.json` test glob → add `web/tests/unit/rig/*.test.js`

**Interfaces (produces):**
- `POSITION_KINDS = ['pipe','boom','floor']`, `positionToWorld(position, offsetFt) → [X,Y,Z]`, `nearestOffset(position, worldFt) → number` (X for pipe/floor, Y for boom), `areaLabels(grid) → string[]`, `areaCenter(venue, label) → [X,Y,Z]|null`, `linearEndpoints(position, offsetFt, lengthFt) → [[X,Y,Z],[X,Y,Z]]`, `starterPositions(venue) → position[]`, `defaultFixtureName(position, index) → string` (e.g. `1E-3`; short name = initials/digits of the position name, max 4 chars), `SYNTHETIC_VENUE`.
- `FIXTURE_TYPES` (ordered array of `{id,label}`), `PRESETS[id]` = `{ engineType, fieldDeg | options, softness, kelvin, aimed: 'always'|'optional'|'none', gobo: bool, optionKey, optionValues }`, `applyFixturePreset(light, typeId, option) → light` (mutates; sets `type`, `cone_angle` = field/2 in radians, `softness`, `kelvin`, `color_temperature`, removes `gobo` when unsupported, sets `fixture.type` and the option field), `fieldAngleFor(typeId, option) → degrees`.

- [ ] **Step 1: Tests**

`web/tests/unit/rig/geometry.test.js`:
```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { positionToWorld, nearestOffset, areaLabels, areaCenter, linearEndpoints, starterPositions, defaultFixtureName, SYNTHETIC_VENUE } from '../../../src/rig/geometry.js';
const near = (a, b, t = 1e-9) => assert.ok(Math.abs(a - b) <= t, `${a} !~ ${b}`);
const V = SYNTHETIC_VENUE;
const pos = (name) => V.positions.find((p) => p.name === name);

test('pipe, boom, floor map to world feet', () => {
  assert.deepEqual(positionToWorld(pos('1E'), 4), [4, 20, 6]);
  assert.deepEqual(positionToWorld(pos('FOH'), -10), [-10, 22, -52]);
  assert.deepEqual(positionToWorld(pos('BSR'), 12), [-22, 12, 8]);
  assert.deepEqual(positionToWorld({ kind: 'floor', upstage_ft: 28 }, 3), [3, 0.5, 28]);
});

test('nearestOffset projects onto the pipe or boom axis', () => {
  near(nearestOffset(pos('1E'), [7.5, 18, 9]), 7.5);
  near(nearestOffset(pos('BSL'), [20, 9.25, 7]), 9.25);
});

test('area labels and centers, house-view numbering', () => {
  assert.deepEqual(areaLabels({ rows: 3, cols: 3 }), ['1','2','3','4','5','6','7','8','9']);
  // 40 wide: columns centred at -13.33, 0, 13.33; 30 deep: rows at 5, 15, 25
  const c1 = areaCenter(V, '1'); near(c1[0], -40/3, 1e-6); near(c1[1], 5); near(c1[2], 5);
  const c5 = areaCenter(V, '5'); near(c5[0], 0); near(c5[2], 15);
  const c9 = areaCenter(V, '9'); near(c9[0], 40/3, 1e-6); near(c9[2], 25);
  assert.equal(areaCenter(V, '10'), null);
});

test('number_from_stage_left mirrors columns', () => {
  const W = { ...V, grid: { rows: 3, cols: 3, number_from_stage_left: true } };
  near(areaCenter(W, '1')[0], 40/3, 1e-6);
  near(areaCenter(W, '3')[0], -40/3, 1e-6);
});

test('4x5 grid labels count and last cell', () => {
  const W = { ...V, grid: { rows: 4, cols: 5, number_from_stage_left: false } };
  assert.equal(areaLabels(W.grid).length, 20);
  const c = areaCenter(W, '20'); near(c[0], 16); near(c[2], 26.25);
});

test('linearEndpoints along X on a pipe and along Y on a boom', () => {
  assert.deepEqual(linearEndpoints(pos('3E'), 0, 4), [[-2, 20, 22], [2, 20, 22]]);
  assert.deepEqual(linearEndpoints(pos('BSL'), 10, 4), [[22, 8, 8], [22, 12, 8]]);
});

test('starterPositions scale with the venue', () => {
  const p = starterPositions({ width_ft: 40, height_ft: 20, depth_ft: 30 });
  assert.equal(p.length, 6);
  const foh = p.find((x) => x.name === 'FOH truss');
  near(foh.upstage_ft, -39); near(foh.trim_ft, 22);
  near(p.find((x) => x.name === '1st electric').upstage_ft, 6);
  near(p.find((x) => x.name === 'Boom SR').offset_ft, -22);
});

test('defaultFixtureName uses a short position name', () => {
  assert.equal(defaultFixtureName({ name: '1st electric' }, 3), '1E-3');
  assert.equal(defaultFixtureName({ name: 'FOH truss' }, 1), 'FT-1');
  assert.equal(defaultFixtureName({ name: 'Boom SR' }, 2), 'BSR-2');
});
```

`web/tests/unit/rig/presets.test.js`:
```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FIXTURE_TYPES, PRESETS, applyFixturePreset, fieldAngleFor } from '../../../src/rig/presets.js';
const near = (a, b, t = 1e-9) => assert.ok(Math.abs(a - b) <= t, `${a} !~ ${b}`);
const base = () => ({ type: 'spotlight', name: 'X', enabled: true, intensity: 0.7, position_ft: [1,2,3], target_ft: [0,5,10], gobo: { texture_id: 'preset:window-blinds' }, fixture: { type: 'other', position_id: 'p', offset_ft: 4, area: '5' } });

test('seven types in order', () => {
  assert.deepEqual(FIXTURE_TYPES.map((t) => t.id), ['ers','fresnel','par','followspot','moving_head','cyc','other']);
});

test('ERS preset: 26° barrel → half angle, hard edge, 3200 K, gobo kept', () => {
  const L = applyFixturePreset(base(), 'ers', 26);
  near(L.cone_angle, (26 / 2) * Math.PI / 180, 1e-12);
  assert.equal(L.softness, 0.05); assert.equal(L.kelvin, 3200); assert.equal(L.type, 'spotlight');
  assert.ok(L.gobo); assert.equal(L.fixture.barrel_deg, 26);
});

test('Fresnel removes an unsupported gobo and keeps rig fields', () => {
  const L = applyFixturePreset(base(), 'fresnel', 30);
  assert.equal(L.gobo, null); assert.equal(L.softness, 0.4);
  assert.deepEqual(L.position_ft, [1,2,3]); assert.equal(L.fixture.area, '5'); assert.equal(L.intensity, 0.7); assert.equal(L.name, 'X');
});

test('PAR lamps, followspot and moving head defaults', () => {
  assert.equal(fieldAngleFor('par', 'WFL'), 55);
  near(applyFixturePreset(base(), 'followspot').cone_angle, 4 * Math.PI / 180, 1e-12);
  assert.equal(PRESETS.followspot.aimed, 'always'); assert.equal(PRESETS.moving_head.kelvin, 5600);
});

test('cyc preset makes a linear light with length', () => {
  const L = applyFixturePreset(base(), 'cyc');
  assert.equal(L.type, 'linear'); assert.equal(L.fixture.length_ft, 4); assert.equal(L.softness, 0.6); assert.equal(L.gobo, null);
});
```

- [ ] **Step 2: Run** `npm run test:unit` → FAIL (module not found).

- [ ] **Step 3: Implement**

`web/src/rig/geometry.js`:
```js
export const POSITION_KINDS = ['pipe', 'boom', 'floor'];
export const FLOOR_LIFT_FT = 0.5;

export function positionToWorld(p, offsetFt) {
  switch (p.kind) {
    case 'pipe':  return [offsetFt, p.trim_ft, p.upstage_ft];
    case 'boom':  return [p.offset_ft, offsetFt, p.upstage_ft];
    case 'floor': return [offsetFt, FLOOR_LIFT_FT, p.upstage_ft];
    default: throw new Error(`unknown position kind ${p.kind}`);
  }
}

export function nearestOffset(p, [X, Y]) { return p.kind === 'boom' ? Y : X; }

export function areaLabels(grid) {
  const n = grid.rows * grid.cols; const out = [];
  for (let i = 1; i <= n; i++) out.push(String(i));
  return out;
}

export function areaCenter(venue, label) {
  const g = venue.grid; const i = parseInt(label, 10);
  if (!Number.isInteger(i) || i < 1 || i > g.rows * g.cols) return null;
  const row = Math.floor((i - 1) / g.cols);            // 0 = downstage
  let col = (i - 1) % g.cols;                          // 0 = audience-left (−X)
  if (g.number_from_stage_left) col = g.cols - 1 - col;
  const cellW = venue.width_ft / g.cols, cellD = venue.depth_ft / g.rows;
  const X = -venue.width_ft / 2 + (col + 0.5) * cellW;
  const Z = (row + 0.5) * cellD;
  return [X, venue.focus_height_ft ?? 5, Z];
}

export function linearEndpoints(p, offsetFt, lengthFt) {
  const c = positionToWorld(p, offsetFt); const h = lengthFt / 2;
  return p.kind === 'boom'
    ? [[c[0], c[1] - h, c[2]], [c[0], c[1] + h, c[2]]]
    : [[c[0] - h, c[1], c[2]], [c[0] + h, c[1], c[2]]];
}

let _pid = 0;
const pid = () => `pos_${Date.now().toString(36)}_${(_pid++).toString(36)}`;

export function starterPositions({ width_ft, height_ft, depth_ft }) {
  const r = (v) => Math.round(v * 10) / 10;
  return [
    { id: pid(), name: 'FOH truss',    kind: 'pipe', upstage_ft: r(-depth_ft * 1.3), trim_ft: r(height_ft + 2) },
    { id: pid(), name: '1st electric', kind: 'pipe', upstage_ft: r(depth_ft * 0.20), trim_ft: r(height_ft) },
    { id: pid(), name: '2nd electric', kind: 'pipe', upstage_ft: r(depth_ft * 0.47), trim_ft: r(height_ft) },
    { id: pid(), name: '3rd electric', kind: 'pipe', upstage_ft: r(depth_ft * 0.73), trim_ft: r(height_ft) },
    { id: pid(), name: 'Boom SR', kind: 'boom', offset_ft: r(-(width_ft / 2 + 2)), upstage_ft: r(depth_ft * 0.27) },
    { id: pid(), name: 'Boom SL', kind: 'boom', offset_ft: r(width_ft / 2 + 2),  upstage_ft: r(depth_ft * 0.27) },
  ];
}

export function shortName(name) {
  const words = String(name).trim().split(/\s+/);
  let s = words.map((w) => (/^\d/.test(w) ? w.match(/^\d+/)[0] : w[0].toUpperCase())).join('');
  if (words.length === 1) s = words[0].replace(/[^A-Za-z0-9]/g, '').slice(0, 3).toUpperCase();
  return s.slice(0, 4);
}
export function defaultFixtureName(position, index) { return `${shortName(position.name)}-${index}`; }

export const SYNTHETIC_VENUE = {
  id: 'venue_test', name: 'Test House', width_ft: 40, height_ft: 20, depth_ft: 30,
  grid: { rows: 3, cols: 3, number_from_stage_left: false }, focus_height_ft: 5,
  positions: [
    { id: 'p_foh', name: 'FOH', kind: 'pipe', upstage_ft: -52, trim_ft: 22 },
    { id: 'p_1e', name: '1E', kind: 'pipe', upstage_ft: 6, trim_ft: 20 },
    { id: 'p_2e', name: '2E', kind: 'pipe', upstage_ft: 14, trim_ft: 20 },
    { id: 'p_3e', name: '3E', kind: 'pipe', upstage_ft: 22, trim_ft: 20 },
    { id: 'p_bsr', name: 'BSR', kind: 'boom', offset_ft: -22, upstage_ft: 8 },
    { id: 'p_bsl', name: 'BSL', kind: 'boom', offset_ft: 22, upstage_ft: 8 },
  ],
};
```
(Note `shortName('1st electric')` → `1E`, `'FOH truss'` → `FT`, `'Boom SR'` → `BSR`; the test asserts these.)

`web/src/rig/presets.js`:
```js
const deg = (d) => (d / 2) * Math.PI / 180;   // field angle → engine half-angle (radians)

export const FIXTURE_TYPES = [
  { id: 'ers', label: 'ERS / Leko' }, { id: 'fresnel', label: 'Fresnel' }, { id: 'par', label: 'PAR' },
  { id: 'followspot', label: 'Followspot' }, { id: 'moving_head', label: 'Moving head' },
  { id: 'cyc', label: 'Cyc / strip' }, { id: 'other', label: 'Other' },
];

export const PAR_LAMPS = { VNSP: 12, NSP: 20, MFL: 35, WFL: 55 };

export const PRESETS = {
  ers:         { engineType: 'spotlight', optionKey: 'barrel_deg', optionValues: [19, 26, 36, 50], defaultOption: 26, softness: 0.05, kelvin: 3200, aimed: 'optional', gobo: true },
  fresnel:     { engineType: 'spotlight', optionKey: 'beam_deg', range: [10, 60], defaultOption: 30, softness: 0.4, kelvin: 3200, aimed: 'optional', gobo: false },
  par:         { engineType: 'spotlight', optionKey: 'lamp', optionValues: Object.keys(PAR_LAMPS), defaultOption: 'MFL', softness: 0.25, kelvin: 3200, aimed: 'optional', gobo: false },
  followspot:  { engineType: 'spotlight', fieldDeg: 8, softness: 0.05, kelvin: 5600, aimed: 'always', gobo: false },
  moving_head: { engineType: 'spotlight', optionKey: 'beam_deg', range: [10, 50], defaultOption: 20, softness: 0.2, kelvin: 5600, aimed: 'always', gobo: true },
  cyc:         { engineType: 'linear', optionKey: 'length_ft', defaultOption: 4, softness: 0.6, kelvin: 3200, aimed: 'none', gobo: false },
  other:       { engineType: 'spotlight', optionKey: 'beam_deg', range: [5, 90], defaultOption: 30, softness: 0.2, kelvin: 5600, aimed: 'optional', gobo: true },
};

export function fieldAngleFor(typeId, option) {
  const p = PRESETS[typeId];
  if (p.fieldDeg != null) return p.fieldDeg;
  if (typeId === 'par') return PAR_LAMPS[option ?? p.defaultOption];
  if (typeId === 'cyc') return null;
  return option ?? p.defaultOption;
}

export function applyFixturePreset(L, typeId, option) {
  const p = PRESETS[typeId]; if (!p) throw new Error(`unknown fixture type ${typeId}`);
  const opt = option ?? p.defaultOption;
  L.fixture = { ...(L.fixture || {}), type: typeId };
  if (p.optionKey) L.fixture[p.optionKey] = opt;
  L.type = p.engineType;
  const fa = fieldAngleFor(typeId, opt);
  if (fa != null) L.cone_angle = deg(fa);
  L.softness = p.softness;
  L.kelvin = p.kelvin; L.color_temperature = p.kelvin; L.gel_preset = null;
  if (!p.gobo) L.gobo = null;
  return L;
}
```

- [ ] **Step 4: Run** `npm run test:unit` → all pass. **Step 5: Commit** `feat(rig): geometry and fixture presets (pure)`.

---

### Task 2: Linear light in shader and Python, with golden and parity

**Files:**
- Modify: `web/src/webgl/shaders/relight.frag` (light loop ~lines 212-260), `web/src/webgl/renderer.js` (`uploadLights`), `packages/relighting_engine/relighting_engine/lighting/models.py` (`Light`, `validate`), `lighting/shaders.py` (per-light block ~299-395), `packages/relighting_api/relighting_api/schemas.py` (`LightModel`), `packages/relighting_engine/tests/golden/configs.py`, `web/tests/parity.spec.js`, `web/src/metric/light-metric.js`, `web/src/3d/light-primitives.js`
- Test: `packages/relighting_engine/tests/unit/test_linear_light.py`, new golden `portrait_a__linear_cyc.png`, parity test

**Interfaces:**
- `Light.type` accepts `'linear'`; fields `endpoint_a_ft`, `endpoint_b_ft`, `endpoint_a`, `endpoint_b` (tuples or None). `LightModel` mirrors them (`list[float] | None`, length 3).
- Shader: type id 3; new uniform `vec3 u_l_endpoint_b[MAX_LIGHTS]`; `u_l_position` = endpoint A (feet when metric, engine otherwise); `u_l_position_eng` = A's engine proxy; `u_l_endpoint_b_eng` = B's engine proxy.
- `light-metric.js`: `syncLightFromFeet` also derives `endpoint_a`/`endpoint_b` engine proxies from `endpoint_*_ft` via `worldToEngine` (null-safe: fall back to direction marching like other lights).
- 3D: a linear light draws as a bar between endpoints (in `light-primitives.js`, using `worldFtToThree` when calibrated).

- [ ] **Step 1: Python test**

```python
import numpy as np, torch
from relighting_engine.core.prepared import PreparedImage
from relighting_engine.lighting import shaders
from relighting_engine.lighting.models import Light
from relighting_engine.metric.calibration import Calibration
from relighting_engine.tests.unit.test_metric_render import RECORD, ASPECT, _prepared   # reuse Task-5 fixtures from Spec 1

def test_linear_light_lights_from_closest_point_and_is_symmetric():
    cal = Calibration.from_dict(RECORD, ASPECT)
    L = Light(type="linear", intensity=1.0, falloff=1.0, softness=0.6,
              endpoint_a_ft=(-10.0, 20.0, 6.0), endpoint_b_ft=(10.0, 20.0, 6.0))
    out = shaders.render(_prepared(h=4, w=8), [L], ambient=0.0, device="cpu", calibration=cal)
    assert out.mean() > 0.01
    # symmetric about the centre column
    assert np.allclose(out[:, :4], out[:, ::-1][:, :4], atol=1e-4)

def test_linear_light_uncalibrated_engine_space():
    L = Light(type="linear", intensity=1.0, endpoint_a=(0.2, 0.5, 1.0), endpoint_b=(0.8, 0.5, 1.0))
    out = shaders.render(_prepared(), [L], ambient=0.0, device="cpu")
    assert out.max() > 0.01

def test_linear_validate_requires_endpoints():
    import pytest
    with pytest.raises(ValueError):
        Light(type="linear").validate()
```

- [ ] **Step 2: Run** → FAIL (`unknown light type linear`).

- [ ] **Step 3: Implement Python**

`models.py`: add `endpoint_a_ft`, `endpoint_b_ft`, `endpoint_a`, `endpoint_b` (all `tuple[float,float,float] | None = None`); `validate`: allow `'linear'`, require `endpoint_a_ft and endpoint_b_ft` or `endpoint_a and endpoint_b`.
`shaders.py`: in the per-light loop add a `linear` branch before the spotlight logic:
```python
        if L.type == "linear":
            if metric:
                A = torch.tensor(L.endpoint_a_ft, device=device, dtype=torch.float32)
                B = torch.tensor(L.endpoint_b_ft, device=device, dtype=torch.float32)
                falloff = falloff_to_metric(L.falloff, calibration.width_ft)
                a_eng = world_to_engine(L.endpoint_a_ft, calibration.camera, effective_fit(calibration))
                b_eng = world_to_engine(L.endpoint_b_ft, calibration.camera, effective_fit(calibration))
            else:
                A = torch.tensor(L.endpoint_a, device=device, dtype=torch.float32)
                B = torch.tensor(L.endpoint_b, device=device, dtype=torch.float32)
                falloff = L.falloff; a_eng, b_eng = L.endpoint_a, L.endpoint_b
            AB = B - A
            t = torch.clamp(((Pw - A) * AB).sum(-1, keepdim=True) / (AB * AB).sum().clamp_min(1e-9), 0.0, 1.0)
            Q = A + t * AB
            diff_vec = Q - Pw
            dist = diff_vec.norm(dim=-1, keepdim=True) + 1e-6
            L_vec = diff_vec / dist
            atten = 1.0 / (1.0 + falloff * (dist.squeeze(-1) ** 2))
            s = L.softness
            diff = torch.clamp((Nw * L_vec).sum(-1) + s, min=0.0) / (1.0 + s)
            cone = torch.ones_like(diff); g = torch.ones_like(diff)
            if a_eng is not None and b_eng is not None:
                Ae = torch.tensor(a_eng, device=device, dtype=torch.float32); Be = torch.tensor(b_eng, device=device, dtype=torch.float32)
                ABe = Be - Ae
                te = torch.clamp(((P - Ae) * ABe).sum(-1, keepdim=True) / (ABe * ABe).sum().clamp_min(1e-9), 0.0, 1.0)
                L_vec_eng = torch.nn.functional.normalize(Ae + te * ABe - P, dim=-1)
            else:
                L_vec_eng = L_vec
            # then fall through to the shared mask/shadow/accumulate code with diff, atten, cone, g, L_vec_eng
```
Restructure the loop so the shared tail (mask weighting, shadow, accumulate) runs for all types; keep uncalibrated/other-type output bit-identical (goldens prove it).

- [ ] **Step 4: Shader**

Add `uniform vec3 u_l_endpoint_b[MAX_LIGHTS]; uniform vec3 u_l_endpoint_b_eng[MAX_LIGHTS];`. In the loop, before the directional/point branch:
```glsl
    float wrapDiff = -1.0;                       // <0 = not a linear light
    if (u_l_type[i] == 3) {
      vec3 A = u_l_position[i], B = u_l_endpoint_b[i];
      vec3 AB = B - A;
      float t = clamp(dot(Pw - A, AB) / max(dot(AB, AB), 1e-9), 0.0, 1.0);
      vec3 Q = A + t * AB;
      vec3 d = Q - Pw; float dist = length(d) + 1e-6;
      Lvec = d / dist;
      atten = 1.0 / (1.0 + u_l_falloff[i] * dist * dist);
      float s = u_l_softness[i];
      wrapDiff = max(dot(Nw, Lvec) + s, 0.0) / (1.0 + s);
      vec3 Ae = u_l_position_eng[i], Be = u_l_endpoint_b_eng[i]; vec3 ABe = Be - Ae;
      float te = clamp(dot(P - Ae, ABe) / max(dot(ABe, ABe), 1e-9), 0.0, 1.0);
      Lvec_eng = (u_metric == 1 && u_l_shadowDir[i] == 0) ? normalize(Ae + te * ABe - P) : Lvec;
    } else if (u_l_type[i] == 0) { ...existing... } else { ...existing... }
    ...
    float diff = wrapDiff >= 0.0 ? wrapDiff : max(dot(Nw, Lvec), 0.0);
    // cone and gobo blocks already test u_l_type == 2 / u_l_hasGobo; linear lights have hasGobo 0
```
`renderer.js uploadLights`: `types[i]` map gains `linear: 3`; pack `endpoint_b` (feet when metric: `L.endpoint_b_ft`, else `L.endpoint_b`) and `endpoint_b_eng` (`L.endpoint_b || fallback`); position packs `endpoint_a_ft`/`endpoint_a` for linear lights; `shadowDir[i]` = 1 when either engine endpoint is null.

- [ ] **Step 5: Client sync + 3D + schema + golden + parity**

- `light-metric.js syncLightFromFeet`: when `L.type === 'linear'`, derive `endpoint_a`/`endpoint_b` via `worldToEngine` (each may be null); set `position_ft` = midpoint so existing code that reads position_ft keeps working; `direction_ft` = `[0,-1,0]` placeholder (unused).
- `light-primitives.js`: for `type === 'linear'`, draw a `THREE.Mesh(CylinderGeometry(0.15, 0.15, length))` oriented A→B (feet via `worldFtToThree`, engine via `lightToWorld` scaled as other primitives), same hit mesh/selection.
- `schemas.py LightModel`: add the four endpoint fields with the length-3 validator; `to_engine` passes them.
- `configs.py`: add `("linear_cyc", [Light(type="linear", endpoint_a_ft=(-15,20,26), endpoint_b_ft=(15,20,26), intensity=4.0, softness=0.6)], 0.1, CALIBRATION_FIXTURE_FIT)` where the calibration dict is the fixture-matched one from Spec 1 (`a −0.027778, b 0.030556`). Generate `portrait_a__linear_cyc.png` with `RELIGHT_WRITE_GOLDENS=1`.
- `parity.spec.js`: third test mirroring the config (calibration + linear light, ambient 0.1) with `toMatchSnapshot(['portrait_a__linear_cyc.png'], { maxDiffPixelRatio: 0.02, threshold: 0.1 })`.

- [ ] **Step 6: Run** engine unit + goldens (existing goldens unchanged), API suite, JS unit, full Playwright (5 tests). **Step 7: Commit** `feat(engine,webgl): linear light type for cyc/strip units` (one commit; golden PNG included).

---

### Task 3: Multi-pass accumulation (64-light cap)

**Files:**
- Modify: `web/src/webgl/renderer.js` (`draw`, init), `web/src/webgl/shaders/relight.frag` (output stage), `packages/relighting_engine/tests/golden/configs.py`, `web/tests/parity.spec.js`
- Test: parity `twelve_lights`; JS unit for `chunkEmitters`

**Interfaces:**
- `MAX_EMITTERS = 64` exported from `renderer.js`; `chunkEmitters(emitters) → emitters[][]` (enabled only, chunks of 8; pure, exported for tests).
- Shader gains `uniform int u_outputMode;` 0 = today (sRGB encode to canvas), 1 = linear accumulate (no clamp, no sRGB, `fragColor = vec4(total, 1)`); and `uniform int u_skipAmbient;` (1 → `ambient_v = 0`, and reflectors/mask-overlay skipped). A second tiny program `blit.frag` reads the accumulation texture, clamps, applies the mask overlay and the sRGB encode (moved from `relight.frag` into a shared GLSL snippet string in `renderer.js` so both programs use identical code).
- `draw()`: `chunks = chunkEmitters(emitters)`; if `chunks.length <= 1` → today's path (`u_outputMode 0`), unchanged. Else: ensure an FBO with a `RGBA16F` color texture (via `EXT_color_buffer_float`; if unavailable, `RGBA8` and `console.warn('multi-pass accumulation without float render targets; banding possible')` once); pass k renders chunk k with `u_skipAmbient = k > 0`, additive blending (`gl.blendFunc(ONE, ONE)`) for k > 0; then blit to the canvas.
- Enabled-count enforcement is UI-side (Task 7); the renderer additionally truncates to 64 defensively.

- [ ] **Step 1: Unit test** `web/tests/unit/rig/chunk.test.js`: 0 enabled → `[]`; 8 → one chunk; 9 → `[8,1]`; disabled lights excluded; 70 enabled → 8 chunks and total 64.
- [ ] **Step 2: Implement** as in Interfaces. Keep `draw()`'s existing uniform uploads in a helper called per pass; textures bound once.
- [ ] **Step 3: Golden + parity**: `("twelve_lights", [12 spotlights on a 4×3 grid over the deck at trim 20, positions_ft (x∈{-15,-5,5,15}, z∈{6,14,22}), target_ft straight down at (x,5,z), intensity 1.2, cone 0.35], 0.1, CALIBRATION_FIXTURE_FIT)`; parity test 4 with the same lights via `window.__state` (build them in the test from the same grid).
- [ ] **Step 4: Bit-identity check**: with ≤ 8 lights, hash the canvas before/after the change on the Leica scene (as in Spec 1 Task 4) and paste both.
- [ ] **Step 5: Run** all suites + Playwright (6 tests). **Commit** `feat(webgl): multi-pass light accumulation, 64-light cap`.

---

### Task 4: Venue API, store, scene migration, new-scene picker

**Files:**
- Create: `packages/relighting_api/relighting_api/venue_store.py`, `routes/venues.py`, `tests/api/test_venues.py`, `web/src/rig/venue-api.js`
- Modify: `main.py` (`app.state.venues = VenueStore(db_path=scenes_db)` same file), `schemas.py` (`VenueModel`, `PositionModel`), `routes/scenes.py` (delete guard helper: count scenes referencing a venue), `web/src/api.js` (re-export), `web/src/new-scene-popup.js` (venue picker), `web/src/main.js` (migration on load, `state.venue`)

**Interfaces:**
- Table `venues(id, name, workspace_id, created_at, updated_at, venue_json)`; store methods `create/get/list/update/delete/duplicate`, `count_scene_refs(venue_id)` (scans `scenes.state_json` for `"venue_id": "<id>"` via `json_extract`).
- `VenueModel(name, width_ft>0, height_ft>0, depth_ft>0, grid: GridModel(rows 1..6, cols 1..6, number_from_stage_left=False), focus_height_ft>=0 default 5, positions: list[PositionModel])`; `PositionModel(id, name, kind: Literal['pipe','boom','floor'], upstage_ft: float, trim_ft: float|None, offset_ft: float|None)` with a validator requiring `trim_ft` for pipe and `offset_ft` for boom.
- Routes: `GET /venues`, `POST /venues` (body VenueModel; empty `positions` → server fills `starterPositions` equivalent — implement `starter_positions()` in Python mirroring Task 1 numbers), `GET/PUT/DELETE /venues/{id}` (DELETE: 409 `{detail, scene_count}` unless `?force=1`), `POST /venues/{id}/duplicate` (`{name}`).
- Client: `listVenues()`, `createVenue(v)`, `getVenue(id)`, `updateVenue(id, v)`, `deleteVenue(id, {force})`, `duplicateVenue(id, name)`.
- Scene: `state.venue_id`, `state.venue_snapshot`, `state.venue` (live object, not persisted); `serializeSceneState` adds `venue_id`, `venue_snapshot`.
- Migration in `applyScene`: if `calibration?.width_ft && !venue_id` → `createVenue({ name: sceneName, dims from calibration, grid default, positions: [] })` → set `venue_id`, `venue_snapshot`, and save. Then `state.venue = getVenue(id)` (fallback to snapshot on 404, flag `state.venueMissing = true`). `state.calibration.{width,height,depth}_ft` are overwritten from the venue before `solveRecord`.
- New-scene popup: `<select id="ns-venue">` with "New venue…" first (creates on scene create with the entered dimensions? No: "New venue" opens the venue editor after the scene is created — the calibration panel's dimension fields write to the venue). Existing venues listed by name.

- [ ] Tests (pytest): CRUD round trip; workspace isolation (venue in ws A not visible in ws B); POST with empty positions returns 6 starter positions; DELETE referenced → 409 with `scene_count`; `?force=1` deletes; duplicate copies positions with new ids; validation errors (rows 7, pipe without trim) → 422.
- [ ] Implement store mirroring `scene_store.py` (same `_conn`, migration style), routes, schemas, client, popup, migration.
- [ ] JS unit: `serializeSceneState` includes `venue_id`/`venue_snapshot` (test via the pure helper if one exists; otherwise test `mergeVenueIntoCalibration(calibration, venue)` which you add to `web/src/rig/geometry.js`).
- [ ] Run API suite, JS unit, smoke. Commit `feat(api,web): venues store and routes; scene venue reference and migration`.

---

### Task 5: Fixtures on lights, tree mirroring, detaching rules

**Files:**
- Create: `web/src/rig/tree-mirror.js`, `web/src/rig/fixture-sync.js`
- Modify: `web/src/lights.js` (`newLightNode` accepts `fixture`), `web/src/main.js` (call `syncFixtures` before every redraw/save alongside `syncLightsFromEngineEdits`; detach on direct moves), `web/src/tree.js` (disable group ops in rig mode), `web/src/metric/light-metric.js` (export a `markCustom(L)` hook)
- Test: `web/tests/unit/rig/fixture-sync.test.js`, `tree-mirror.test.js`

**Interfaces:**
- `fixture-sync.js`: `syncFixtureFromRig(L, venue)` — if `L.fixture?.position_id` resolves to a position: set `position_ft = positionToWorld(pos, offset)` (or endpoints for linear via `linearEndpoints`), set `target_ft = areaCenter(venue, area)` when `area` is set and the preset is aimed (`optional` or `always`), then `syncLightFromFeet`. `syncAllFixtures(lights, venue)`. `detachFixture(L)` sets `position_id = null` keeping coordinates. `attachFixture(L, position, venue)` sets `position_id` and `offset_ft = nearestOffset(position, L.position_ft)` then syncs. `enabledEmitterCount(lights)`; `canEnable(lights, L)` (false when 64 already enabled and `L` disabled).
- `tree-mirror.js`: `buildRigTree(lights, venue) → tree` producing group nodes `{ kind:'group', id:'pos:'+position.id, name, enabled, children:[lights…] }` in venue order, then `{ id:'custom', name:'Custom' }`, then reflectors at top level; group `enabled` derived (all children enabled) and stored on `venue.positions[i]._enabled` is NOT persisted — group toggles cascade to children as today via existing `cascadeEnabled`. `rigMode(state)` = `!!(state.calibration && state.venue)`.
- Direct-move detach: `main.js` paths that already call `syncLightFromEngine`/`syncLightsFromEngineEdits` (2D drag, gizmo, typed feet, placement) call `detachFixture(L)` first when `L.fixture?.position_id`.
- `tree.js`: when `rigMode`, hide `#add-group-btn`, disable drag-to-regroup and rename-group with a tooltip "Groups follow hang positions in a calibrated scene"; `+ Light` adds a Custom fixture of type `other` at the placement or default position.

- [ ] Tests: sync places a fixture on `1E` at offset 4 → `position_ft [4,20,6]`, area `'5'` → `target_ft [0,5,15]`; cyc fixture gets endpoints; detach keeps coordinates and nulls position; attach snaps to nearest offset; `canEnable` at the cap; `buildRigTree` groups by position order and puts unpositioned lights in Custom; reflectors untouched.
- [ ] Implement; wire `main.js`; ensure `syncLightsFromEngineEdits` (Spec 1) runs after `syncAllFixtures` so custom edits win.
- [ ] Run JS unit + smoke + a real-input check (assign `window.__state.venue` from the console with `SYNTHETIC_VENUE`, set a light's fixture block, confirm it moves). Commit `feat(web): fixtures on lights, rig tree mirroring, detach/attach`.

---

### Task 6: Left-pane tabs and draggable divider

**Files:**
- Create: `web/src/pane-divider.js`
- Modify: `web/src/split-view.js` (extract `createDragDivider({ dividerEl, onDrag(clientX), onEnd, onDblClick })` from `createSplitView` and reuse it there), `web/playground.html` (`#tree-pane` gets a tab strip `<div class="pane-tabs"><button data-tab="lights" aria-pressed="true">Lights</button><button data-tab="rig">Rig</button></div>`, a `#rig-root` container, and a `<div id="pane-divider" class="pane-divider"></div>` between `#tree-pane` and `#stage`), `web/playground.css`, `web/src/main.js`
- Test: `web/tests/unit/pane-divider.test.js` (clamp math; per-tab persistence keys)

**Interfaces:**
- `createPaneDivider({ paneEl, dividerEl, getTab, storage })` — width in px on `paneEl.style.width`; min 220; max 60% of window; defaults `{ lights: 260, rig: 520 }`; keys `photo-relight:left-pane-width:<tab>`; on tab switch applies that tab's width; dispatches window `resize` on change (same as the stage split).
- Tabs: `setLeftTab('lights'|'rig')`; Rig disabled (`aria-disabled`, tooltip) unless `rigMode(state)`; Rig auto-selected when a calibrated scene loads; `#tree-root` hidden on Rig, `#rig-root` hidden on Lights.

- [ ] Tests for `clampPaneWidth(px, windowWidth)` and `resolveTabWidth(stored, tab)`.
- [ ] Implement; refactor `split-view.js` without behaviour change (existing split-view tests must still pass; smoke spec covers the divider).
- [ ] Real-input check: drag both dividers; widths persist per tab across reload. Commit `feat(web): left-pane tabs and draggable divider`.

---

### Task 7: Rig tab — positions and fixtures tables

**Files:**
- Create: `web/src/rig/rig-tab.js`
- Modify: `web/src/main.js` (mount, wiring), `web/playground.css`, `web/src/controls.js` (props pane shows fixture type/option/position/area controls for fixtures too — a compact "Rig" fieldset above the light controls)
- Test: `web/tests/unit/rig/rig-tab-model.test.js` (pure view-model helpers exported from `rig-tab.js`: `rowsForVenue`, `nextOffset`, `positionLabels(kind, units)`)

**Interfaces:**
- `mountRigTab({ rootEl, getState, onVenueChange(venue), onLightsChange(), onSelect(id), openVenueEditor })` → `{ render() }`. Rendered from `state.venue` and `state.lights` on every `render()`; `main.js` calls it on `relight:calibration`, after venue edits, and on the same structural updates that re-render the tree.
- Positions table: inline `contenteditable`/inputs; edits call `onVenueChange` (which `updateVenue`s, sets `state.venue_snapshot`, re-syncs fixtures, redraws). Kind change resets the numeric labels (`Upstage/Trim`, `Offset/Upstage`, `Upstage/—`). "Add position": pipe at last upstage + 8 ft, trim = venue height. "Load from venue…": `listVenues()` picker → append positions with new ids. Delete: `confirm` only when fixtures hang on it; those become Custom.
- Fixtures table: grouped by position; columns name, type (select), option (barrel/beam/lamp/length per type), position (select incl. Custom), offset (number in current unit; boom → "Height"), area (select of `areaLabels` + "—"), enabled (checkbox honoring `canEnable`), actions clone/remove. Row click → `onSelect`. "Add fixture": copies last row's position/type, offset + 2 ft, name `defaultFixtureName(position, n)`. Clone: same with offset + 2. Status line `N of 64 enabled · venue: <name>`, with the 65th enable refused inline.
- Units: all numbers through `toDisplay/parseLength` (Spec 1 units.js); re-render on `relight:units`.

- [ ] Tests for the pure helpers (rows grouped in venue order with Custom last; `nextOffset` = last + 2 or 0; labels per kind/unit).
- [ ] Implement tables (plain DOM, no framework; follow `tree.js`'s style); CSS for `.rig-table` (compact, 12px, sticky headers).
- [ ] Real-input pass: build a six-ERS FOH truss via the table with real clicks (add fixture ×5), set areas 1–6, change trim → all six move in 3D; clone/remove; refuse the 65th enable (use a loop in the console to add 64 fixtures, then click enable on one more). Commit `feat(web): rig tab with positions and fixtures tables`.

---

### Task 8: Venue editor and badge

**Files:**
- Create: `web/src/rig/venue-editor.js`
- Modify: `web/src/main.js` (badge text `<venue> · W × H × D <unit>`, click → editor), `web/src/metric/calibration-panel.js` (dimension fields write to the venue via a `getVenue/setVenueDims` hook instead of the record; record mirrors), `web/playground.css`

**Interfaces:** `openVenueEditor({ venue, onSave(venue), onDuplicate(name), onDelete() })` modal: name, W/H/D (current unit), grid rows/cols (1–6), focus height, "Number areas from stage left" checkbox, positions table (reuse the Rig tab's positions table component: export `renderPositionsTable(container, venue, onChange)` from `rig-tab.js`). Save → `updateVenue`, then: snapshot, re-solve calibration on the current scene (dims may have changed), re-sync fixtures, re-render everything. Delete → `deleteVenue(id)`; on 409 show the count and offer force; on force the current scene keeps its snapshot and shows "venue missing".

- [ ] Implement; JS unit test for `venueFromForm(values, units)` (parse + clamp) and `badgeText(venue, units)`.
- [ ] Real-input pass: edit width 40 → 50, Save, calibration re-solves (dist changes), fixtures re-sync; delete while referenced → 409 → force → badge "venue missing" → "Recreate from snapshot" works. Commit `feat(web): venue editor and badge`.

---

### Task 9: Grid overlays (3D cells and position bars; 2D areas toggle)

**Files:**
- Create: `web/src/3d/rig-overlay.js`, `web/src/areas-overlay-2d.js`
- Modify: `web/src/3d/index.js` (build/refresh overlay on `relight:calibration` and venue change), `web/src/3d/stage.js` (call-through), `web/playground.html` (header checkbox `<label class="header-toggle"><input type="checkbox" id="show-areas" /> Areas</label>`), `web/src/main.js`

**Interfaces:**
- `buildRigOverlay(venue, units) → THREE.Group` named `'rig-overlay'`: cell outlines on the deck (`LineSegments`), a `Sprite` label per cell (canvas-texture text) at the cell center, position bars: pipes/floor rows as thin boxes along X spanning `±0.5·width` (pipes at trim height), booms as vertical boxes 0..trim-or-20 ft at their X/Z. `updateRigOverlay(scene, venue, units)` replaces it.
- 2D: `mountAreasOverlay({ overlayEl, getState })` draws cell polygons by projecting the four deck corners of each cell with `worldToPixel` (Spec 1) into an SVG sized to `#canvas-wrap`, labels at the projected centers; hidden unless `#show-areas` is checked and `rigMode`.

- [ ] Unit test the pure `cellCorners(venue, label) → [[X,0,Z]×4]`.
- [ ] Implement; real-input check that area 5 sits mid-stage in both panes and pipes appear as bars at trim height. Commit `feat(web,3d): acting-area and hang-position overlays`.

---

### Task 10: Smoke/E2E, docs, spec status

**Files:**
- Create: `web/tests/smoke-rig.spec.js`
- Modify: `docs/superpowers/specs/2026-09-02-fixture-table-design.md` (Status → Implemented; Deviations section), `docs/deployment/cloudflare-tunnel.md` (one line: venues live in the same SQLite DB as scenes)

- [ ] Smoke test: reuse `web/tests/helpers.js` scene creation; apply the synthetic calibration (as in `smoke-calibrated.spec.js`); create a venue via the API (`page.request.post('/venues', …)` with SYNTHETIC_VENUE dims and empty positions); set `window.__state.venue_id` and reload; assert Rig tab enabled and selected, 6 position rows, click "Add fixture" (real click) → one fixture row, the light exists in `window.__state.lights` with `fixture.position_id`, and `window.__scene3d.getObjectByName('rig-overlay')` exists; zero console errors. Then enable-cap: via `page.evaluate` add 64 enabled fixtures through the exported helper and assert the 65th checkbox click leaves it disabled.
- [ ] Run everything: JS unit, both pytest suites, goldens, full Playwright twice. `detect_changes({scope:'compare', base_ref:'main'})` summary into the report.
- [ ] Spec status + deviations; commit `test: rig smoke; mark fixture-table spec implemented`.

---

## Self-review notes

- Spec coverage: data model (T1 geometry, T4 venue/scene, T5 fixture block), presets (T1), linear light (T2), multi-pass + cap (T3, cap enforcement T5/T7), venue API + migration + picker (T4), tree mirroring + detaching (T5), tabs + divider (T6), rig tab tables + status + cap message (T7), venue editor + badge (T8), overlays (T9), error handling (T4 409/force, T5 canEnable, T7 inline validation, T3 RGBA8 fallback, T8 venue missing), testing (each task; parity goldens T2/T3; smoke T10), implementation order matches the spec.
- Type consistency: `fixture` block keys `type, position_id, offset_ft, area, barrel_deg|beam_deg|lamp, length_ft`; venue keys `width_ft,height_ft,depth_ft,grid{rows,cols,number_from_stage_left},focus_height_ft,positions[{id,name,kind,upstage_ft,trim_ft?,offset_ft?}]`; light endpoints `endpoint_a_ft/endpoint_b_ft/endpoint_a/endpoint_b`; shader type id 3 and `u_l_endpoint_b(_eng)`; renderer `MAX_EMITTERS`, `chunkEmitters`.
- Known judgment calls to confirm during execution: the props pane "Rig" fieldset (T7) duplicates table controls by design so a selected light is editable from either place; `starter_positions()` exists in both JS (T1) and Python (T4) with the same numbers (test both against the same expected values).
