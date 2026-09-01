# Stage Calibration and Metric Lights Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a calibrated scene metric (feet, meters toggle) so lights can be placed at real front-of-house, overhead, side, and behind-stage positions and rendered from there by both the web shader and the Python engine.

**Architecture:** A pure calibration module (JS and a numpy mirror in Python) solves a pinhole camera from three stage dimensions and five marked points, fits the relative depth map to feet in inverse-depth space, and converts between feet, image pixels, and today's normalized engine space. The shader and Python engine gain a metric mode that computes per-pixel positions in feet and takes light positions in feet; shadows keep marching in engine space using a projected proxy position. UI layers (props fields, calibration panel, 3D stage grid, 2D edge arrows) sit on top and are no-ops for uncalibrated scenes.

**Tech Stack:** Vanilla ES modules (no build step), WebGL2 GLSL ES 3.00, Three.js 0.165 via import map, node:test (`npm run test:unit`), Playwright (`web/tests/playwright.config.js`, server on :8765), FastAPI + Pydantic, PyTorch engine, pytest (`.venv/Scripts/python -m pytest`).

**Spec:** `docs/superpowers/specs/2026-09-01-stage-calibration-metric-lights-design.md`

## Global Constraints

- Internal unit is feet. Meters is display-only: `1 ft = 0.3048 m`. One formatting helper (`web/src/metric/units.js`) is the only place conversion happens in the UI.
- World frame: origin center of lip on deck; +X audience right ("Stage L" label); +Y up; +Z upstage; negative Z into the house.
- Engine→world transform for normals and directions: `(x, y, z) → (x, −y, −z)`.
- Uncalibrated scenes (no `calibration` in state) must behave bit-identically to today in shader, Python engine, 3D viewport, 2D handles.
- Metric mode in the shader and Python engine must match within the existing parity tolerance; the metric-mode engine change is its own commit and lands before any UI.
- `Z_cam` clamp: `[0.5, 10000]` ft. `worldToPixel` returns `null` when `Z_cam < 0.5`.
- Depth fit: `1/Z_cam = a·d + b`, `d` = depth map value (0 nearest, 1 farthest). Fit is `null` when `|d_lip − d_back| < 0.02`.
- Falloff rescale in metric mode: `falloff_ft = falloff / width_ft²`.
- Unit test command: `npm run test:unit` (runs `node --test web/tests/unit/*.test.js`; new tests under `web/tests/unit/metric/` must be added to that glob, see Task 1). Python: `.venv/Scripts/python -m pytest packages/relighting_engine/tests/unit -q` and `.venv/Scripts/python -m pytest packages/relighting_api/tests -q`.
- Per CLAUDE.md: run GitNexus `impact({target, direction: "upstream"})` before modifying any existing function; run `detect_changes()` before every commit. Commit messages end with the Co-Authored-By and Claude-Session trailers used in commit `1c67066`.
- Synthetic stage used by every math test (JS and Python must use the same numbers):
  - Stage 40 × 20 × 30 ft. Camera 60 ft from lip, 8 ft above deck. Image aspect `A = H/W = 0.75`. Focal `f = 1.2` (u-units). Horizon `va_h = 0.3`, `u_c = 0.5`.
  - Marks: `lipL=[0.1, 0.61333]`, `lipR=[0.9, 0.61333]`, `top=[0.5, 0.08]`, `backL=[0.23333, 0.54222]`, `backR=[0.76667, 0.54222]`.
  - Expected solve: `dist_ft=60`, `height_ft=8`, `f=1.2`, `k_y=1.0`, `va_h=0.3`, `u_c=0.5` (tolerance 0.5%).
  - Depth samples for the fit: `d_lip = 0.20`, `d_back = 0.35` → `a = (1/60 − 1/90)/(0.20 − 0.35) = −0.037037`, `b = 1/60 − a·0.20 = 0.024074`.

---

## File map

Create:
- `web/src/metric/units.js` — feet/meters formatting and parsing.
- `web/src/metric/calibration.js` — pure camera solve, depth fit, transforms.
- `web/src/metric/marking.js` — five-click marking state machine (pure).
- `web/src/metric/calibration-panel.js` — panel DOM + marking overlay.
- `web/src/metric/light-metric.js` — light ↔ feet sync helpers used by main.js.
- `web/src/3d/stage.js` — deck grid, plaster line, centerline, fixture marker.
- `web/tests/unit/metric/units.test.js`, `calibration.test.js`, `marking.test.js`, `light-metric.test.js`.
- `web/tests/smoke-calibrated.spec.js`.
- `packages/relighting_engine/relighting_engine/metric/__init__.py`, `calibration.py`.
- `packages/relighting_engine/relighting_engine/depth/metric_check.py`.
- `packages/relighting_engine/tests/unit/test_metric_calibration.py`, `test_metric_render.py`.
- `packages/relighting_api/tests/api/test_calibration_schema.py`.

Modify:
- `package.json` (test glob), `web/playground.html`, `web/playground.css`.
- `web/src/webgl/shaders/relight.frag`, `web/src/webgl/renderer.js`.
- `web/src/main.js`, `web/src/lights.js`, `web/src/targeting.js`, `web/src/controls.js`, `web/src/handles.js`, `web/src/placement.js` (call site only, in main.js).
- `web/src/3d/index.js`, `web/src/3d/point-cloud.js`, `web/src/3d/light-primitives.js`, `web/src/3d/scene.js`, `web/src/3d/gizmos.js`.
- `web/tests/parity.spec.js`.
- `packages/relighting_engine/relighting_engine/lighting/models.py`, `lighting/shaders.py`, `core/engine.py`.
- `packages/relighting_api/relighting_api/schemas.py`, `routes/render.py`, `routes/layers.py`, `routes/polish.py`, `routes/scenes.py`.
- `packages/relighting_engine/tests/golden/configs.py`.

---

### Task 1: Units helper

**Files:**
- Create: `web/src/metric/units.js`
- Test: `web/tests/unit/metric/units.test.js`
- Modify: `package.json:8` (`test:unit` glob)

**Interfaces:**
- Produces: `FT_PER_M = 3.280839895`, `formatLength(ft, unit, { precision = 1 } = {}) → string` (e.g. `"12.5 ft"`, `"3.8 m"`), `parseLength(text, unit) → number|null` (returns feet; accepts `"12.5"`, `"12.5 ft"`, `"3.8 m"`, `"12'6\""`), `toDisplay(ft, unit) → number`, `fromDisplay(value, unit) → number`.

- [ ] **Step 1: Add the test glob**

In `package.json` change the `test:unit` script to:
```json
"test:unit": "node --test web/tests/unit/*.test.js web/tests/unit/metric/*.test.js"
```

- [ ] **Step 2: Write the failing test**

`web/tests/unit/metric/units.test.js`:
```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FT_PER_M, formatLength, parseLength, toDisplay, fromDisplay } from '../../../src/metric/units.js';

test('FT_PER_M is the exact international foot', () => {
  assert.ok(Math.abs(FT_PER_M - 1 / 0.3048) < 1e-9);
});

test('formatLength in feet and meters', () => {
  assert.equal(formatLength(12.5, 'ft'), '12.5 ft');
  assert.equal(formatLength(12.5, 'm'), '3.8 m');
  assert.equal(formatLength(12.5, 'm', { precision: 2 }), '3.81 m');
  assert.equal(formatLength(-60, 'ft'), '-60.0 ft');
});

test('toDisplay / fromDisplay round trip', () => {
  assert.ok(Math.abs(fromDisplay(toDisplay(17, 'm'), 'm') - 17) < 1e-9);
  assert.equal(toDisplay(17, 'ft'), 17);
});

test('parseLength accepts plain numbers in the current unit', () => {
  assert.equal(parseLength('12.5', 'ft'), 12.5);
  assert.ok(Math.abs(parseLength('3.81', 'm') - 12.5) < 0.01);
});

test('parseLength honors explicit unit suffixes and feet-inches', () => {
  assert.ok(Math.abs(parseLength('3.81 m', 'ft') - 12.5) < 0.01);
  assert.equal(parseLength('12 ft', 'm'), 12);
  assert.equal(parseLength(`12'6"`, 'ft'), 12.5);
});

test('parseLength rejects garbage', () => {
  assert.equal(parseLength('', 'ft'), null);
  assert.equal(parseLength('abc', 'ft'), null);
  assert.equal(parseLength(undefined, 'ft'), null);
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npm run test:unit`
Expected: FAIL, `Cannot find module '.../web/src/metric/units.js'`.

- [ ] **Step 4: Implement**

`web/src/metric/units.js`:
```js
// Single source of unit conversion for the UI. Stored values are ALWAYS feet.
export const FT_PER_M = 1 / 0.3048;
export const UNITS = ['ft', 'm'];

export function toDisplay(ft, unit) {
  return unit === 'm' ? ft / FT_PER_M : ft;
}

export function fromDisplay(value, unit) {
  return unit === 'm' ? value * FT_PER_M : value;
}

export function formatLength(ft, unit, { precision = 1 } = {}) {
  const v = toDisplay(ft, unit);
  return `${v.toFixed(precision)} ${unit}`;
}

const FT_IN = /^\s*(-?\d+(?:\.\d+)?)\s*'\s*(?:(\d+(?:\.\d+)?)\s*"?)?\s*$/;
const NUM_UNIT = /^\s*(-?\d+(?:\.\d+)?)\s*(ft|feet|m|meters?)?\s*$/i;

/** Parse user text into feet. `unit` is assumed when no suffix is given. */
export function parseLength(text, unit) {
  if (typeof text !== 'string') return null;
  const fi = text.match(FT_IN);
  if (fi) return parseFloat(fi[1]) + (fi[2] ? parseFloat(fi[2]) / 12 : 0);
  const m = text.match(NUM_UNIT);
  if (!m) return null;
  const v = parseFloat(m[1]);
  if (!Number.isFinite(v)) return null;
  const suffix = (m[2] || '').toLowerCase();
  if (suffix.startsWith('m')) return v * FT_PER_M;
  if (suffix) return v;
  return fromDisplay(v, unit);
}
```

- [ ] **Step 5: Run tests**

Run: `npm run test:unit`
Expected: all pass (existing 35 + 6 new).

- [ ] **Step 6: Commit**

```bash
git add package.json web/src/metric/units.js web/tests/unit/metric/units.test.js
git commit -m "feat(metric): units helper for feet/meters display"
```

---

### Task 2: Calibration math (JS)

**Files:**
- Create: `web/src/metric/calibration.js`
- Test: `web/tests/unit/metric/calibration.test.js`

**Interfaces:**
- Produces:
  - `validateMarks(record) → { ok: boolean, errors: string[] }`
  - `solveCamera(record, aspect) → { f, dist_ft, height_ft, u_c, va_h, k_y, aspect, height_check_pct }`
  - `pixelToWorld(u, v, zCam, cam) → [X, Y, Z]`
  - `worldToPixel([X, Y, Z], cam) → [u, v, zCam] | null`
  - `fitDepth(record, cam, sampleDepth) → { a, b } | null` where `sampleDepth(u, v) → number`
  - `depthToZcam(d, fit) → number` (clamped 0.5..10000)
  - `zcamToDepth(zCam, fit) → number`
  - `worldToEngine([X,Y,Z], cam, fit) → [x, y, z] | null`
  - `engineToWorld([x,y,z], cam, fit) → [X, Y, Z]`
  - `engineDirToWorld([x,y,z]) → [x, −y, −z]`, `worldDirToEngine` (same op)
  - `falloffToMetric(falloff, record) → falloff / record.width_ft²`
  - `SYNTHETIC_STAGE` test fixture export (record + expected values from Global Constraints) so other tests reuse it.

- [ ] **Step 1: Write the failing tests**

`web/tests/unit/metric/calibration.test.js`:
```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  validateMarks, solveCamera, pixelToWorld, worldToPixel, fitDepth,
  depthToZcam, zcamToDepth, worldToEngine, engineToWorld,
  engineDirToWorld, worldDirToEngine, falloffToMetric, SYNTHETIC_STAGE,
} from '../../../src/metric/calibration.js';

const near = (a, b, tol = 1e-6) => assert.ok(Math.abs(a - b) <= tol, `${a} !~ ${b}`);
const nearPct = (a, b, pct) => assert.ok(Math.abs(a - b) <= Math.abs(b) * pct / 100, `${a} !~ ${b} (${pct}%)`);

const { record, aspect, expected } = SYNTHETIC_STAGE;

test('validateMarks accepts the synthetic stage', () => {
  assert.deepEqual(validateMarks(record), { ok: true, errors: [] });
});

test('validateMarks rejects lip points too close', () => {
  const r = { ...record, marks: { ...record.marks, lipR: [0.13, 0.61333] } };
  const v = validateMarks(r);
  assert.equal(v.ok, false);
  assert.ok(v.errors.some((e) => /lip/i.test(e)));
});

test('validateMarks rejects top mark below the lip line', () => {
  const r = { ...record, marks: { ...record.marks, top: [0.5, 0.7] } };
  assert.equal(validateMarks(r).ok, false);
});

test('validateMarks rejects back line wider than or equal to lip', () => {
  const r = { ...record, marks: { ...record.marks, backL: [0.05, 0.54], backR: [0.95, 0.54] } };
  assert.equal(validateMarks(r).ok, false);
});

test('validateMarks rejects back line below the lip line', () => {
  const r = { ...record, marks: { ...record.marks, backL: [0.3, 0.7], backR: [0.7, 0.7] } };
  assert.equal(validateMarks(r).ok, false);
});

test('validateMarks rejects non-positive dimensions', () => {
  assert.equal(validateMarks({ ...record, depth_ft: 0 }).ok, false);
});

test('solveCamera recovers the synthetic camera', () => {
  const cam = solveCamera(record, aspect);
  nearPct(cam.dist_ft, expected.dist_ft, 0.5);
  nearPct(cam.height_ft, expected.height_ft, 0.5);
  nearPct(cam.f, expected.f, 0.5);
  near(cam.k_y, 1.0, 0.01);
  near(cam.u_c, 0.5, 1e-9);
  near(cam.va_h, 0.3, 0.002);
  assert.ok(cam.height_check_pct < 1);
  near(cam.perspective_ratio, 2 / 3, 1e-3);
});

test('solveCamera flags a shallow stage via perspective_ratio', () => {
  // 10 ft deep stage seen from 60 ft: back line is 60/70 of the lip width.
  const shallow = { ...record, depth_ft: 10, marks: { ...record.marks, backL: [0.5 - 0.4 * 60 / 70, 0.6], backR: [0.5 + 0.4 * 60 / 70, 0.6] } };
  const cam = solveCamera(shallow, aspect);
  nearPct(cam.dist_ft, 60, 1);
  assert.ok(cam.perspective_ratio > 0.85);
});

test('pixelToWorld puts the lip corners on the deck at ±20 ft, Z = 0', () => {
  const cam = solveCamera(record, aspect);
  const L = pixelToWorld(record.marks.lipL[0], record.marks.lipL[1], cam.dist_ft, cam);
  const R = pixelToWorld(record.marks.lipR[0], record.marks.lipR[1], cam.dist_ft, cam);
  nearPct(L[0], -20, 0.5); near(L[1], 0, 0.05); near(L[2], 0, 1e-6);
  nearPct(R[0], 20, 0.5);
});

test('pixelToWorld puts the top mark at Y = 20 ft', () => {
  const cam = solveCamera(record, aspect);
  const T = pixelToWorld(record.marks.top[0], record.marks.top[1], cam.dist_ft, cam);
  nearPct(T[1], 20, 0.5);
});

test('pixelToWorld puts the back line at Z = 30 ft on the deck', () => {
  const cam = solveCamera(record, aspect);
  const B = pixelToWorld(record.marks.backL[0], record.marks.backL[1], cam.dist_ft + 30, cam);
  nearPct(B[0], -20, 0.5); near(B[1], 0, 0.05); near(B[2], 30, 1e-6);
});

test('worldToPixel inverts pixelToWorld and is null behind the camera', () => {
  const cam = solveCamera(record, aspect);
  const p = [7, 3, 12];
  const [u, v, zc] = worldToPixel(p, cam);
  const back = pixelToWorld(u, v, zc, cam);
  near(back[0], 7, 1e-6); near(back[1], 3, 1e-6); near(back[2], 12, 1e-6);
  assert.equal(worldToPixel([0, 10, -60], cam), null);     // at the camera
  assert.equal(worldToPixel([0, 10, -80], cam), null);     // behind it
});

test('fitDepth solves a and b from lip/back medians', () => {
  const cam = solveCamera(record, aspect);
  const sample = (u, v) => (v > 0.6 ? 0.20 : 0.35);        // lip line lower in image than back line
  const fit = fitDepth(record, cam, sample);
  near(fit.a, -0.037037, 1e-5);
  near(fit.b, 0.024074, 1e-5);
  near(depthToZcam(0.20, fit), 60, 1e-3);
  near(depthToZcam(0.35, fit), 90, 1e-3);
  near(zcamToDepth(90, fit), 0.35, 1e-6);
});

test('fitDepth returns null on flat depth', () => {
  const cam = solveCamera(record, aspect);
  assert.equal(fitDepth(record, cam, () => 0.3), null);
});

test('depthToZcam clamps to [0.5, 10000]', () => {
  const fit = { a: -0.037037, b: 0.024074 };
  assert.ok(depthToZcam(0.65, fit) <= 10000);
  assert.ok(depthToZcam(-5, fit) >= 0.5);
});

test('worldToEngine / engineToWorld round trip inside the frame', () => {
  const cam = solveCamera(record, aspect);
  const fit = { a: -0.037037, b: 0.024074 };
  const w = [5, 4, 10];
  const e = worldToEngine(w, cam, fit);
  assert.ok(e[0] > 0 && e[0] < 1 && e[1] > 0 && e[1] < 1);
  const back = engineToWorld(e, cam, fit);
  near(back[0], 5, 1e-6); near(back[1], 4, 1e-6); near(back[2], 10, 1e-6);
  assert.equal(worldToEngine([0, 20, -70], cam, fit), null);
});

test('direction transforms flip y and z', () => {
  assert.deepEqual(engineDirToWorld([0.1, 0.2, -0.9]), [0.1, -0.2, 0.9]);
  assert.deepEqual(worldDirToEngine([0.1, -0.2, 0.9]), [0.1, 0.2, -0.9]);
});

test('falloffToMetric divides by width squared', () => {
  near(falloffToMetric(1.0, record), 1 / 1600, 1e-12);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npm run test:unit`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement**

`web/src/metric/calibration.js`:
```js
/**
 * Pure calibration math. No DOM, no Three.js.
 *
 * Image coords: u in [0,1] left→right, v in [0,1] top→bottom. All camera
 * quantities are in "u units": v is scaled by aspect = H/W (va = v * aspect)
 * so a square patch has equal extent in u and va.
 *
 * World frame (feet): origin at the center of the lip on the deck, +X toward
 * audience right, +Y up, +Z upstage (negative Z into the house).
 */
export const Z_CAM_MIN = 0.5;
export const Z_CAM_MAX = 10000;
const MIN_LIP_FRACTION = 0.05;
const FLAT_DEPTH_EPS = 0.02;

export function validateMarks(record) {
  const errors = [];
  const m = record?.marks || {};
  for (const k of ['lipL', 'lipR', 'top', 'backL', 'backR']) {
    if (!Array.isArray(m[k]) || m[k].length !== 2 || !m[k].every(Number.isFinite)) {
      errors.push(`Missing mark: ${k}`);
    }
  }
  for (const k of ['width_ft', 'height_ft', 'depth_ft']) {
    if (!(record?.[k] > 0)) errors.push(`${k.replace('_ft', '')} must be greater than zero`);
  }
  if (errors.length) return { ok: false, errors };
  const wLip = Math.abs(m.lipR[0] - m.lipL[0]);
  const wBack = Math.abs(m.backR[0] - m.backL[0]);
  const vLip = (m.lipL[1] + m.lipR[1]) / 2;
  const vBack = (m.backL[1] + m.backR[1]) / 2;
  if (wLip < MIN_LIP_FRACTION) errors.push('Lip marks are too close together');
  if (m.top[1] >= vLip) errors.push('Top of opening must be above the lip');
  if (wBack >= wLip) errors.push('Back line must be narrower than the lip (is the photo head-on from the house?)');
  if (vBack >= vLip) errors.push('Back line must appear above the lip line');
  return { ok: errors.length === 0, errors };
}

export function solveCamera(record, aspect) {
  const m = record.marks;
  const wLip = Math.abs(m.lipR[0] - m.lipL[0]);
  const wBack = Math.abs(m.backR[0] - m.backL[0]);
  const r = wBack / wLip;
  const dist = record.depth_ft * r / (1 - r);
  const f = wLip * dist / record.width_ft;
  const vaLip = ((m.lipL[1] + m.lipR[1]) / 2) * aspect;
  const vaBack = ((m.backL[1] + m.backR[1]) / 2) * aspect;
  const vaTop = m.top[1] * aspect;
  const h = (vaLip - vaBack) / (f * (1 / dist - 1 / (dist + record.depth_ft)));
  const vaH = vaLip - f * h / dist;
  const predictedOpening = f * record.height_ft / dist;
  const observedOpening = vaLip - vaTop;
  const kY = predictedOpening / observedOpening;
  return {
    f, dist_ft: dist, height_ft: h, u_c: (m.lipL[0] + m.lipR[0]) / 2,
    va_h: vaH, k_y: kY, aspect,
    height_check_pct: Math.abs(kY - 1) * 100,
    perspective_ratio: r,     // back-line width / lip width; > 0.9 means a shallow stage relative to camera distance
  };
}

export function pixelToWorld(u, v, zCam, cam) {
  const X = (u - cam.u_c) * zCam / cam.f;
  const Y = cam.k_y * (cam.height_ft - (v * cam.aspect - cam.va_h) * zCam / cam.f);
  const Z = zCam - cam.dist_ft;
  return [X, Y, Z];
}

export function worldToPixel([X, Y, Z], cam) {
  const zCam = Z + cam.dist_ft;
  if (!(zCam >= Z_CAM_MIN)) return null;
  const u = cam.u_c + X * cam.f / zCam;
  const va = cam.va_h + (cam.height_ft - Y / cam.k_y) * cam.f / zCam;
  return [u, va / cam.aspect, zCam];
}

function medianAlong(a, b, sample, n = 64) {
  const vals = [];
  for (let i = 0; i < n; i++) {
    const t = (i + 0.5) / n;
    vals.push(sample(a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t));
  }
  vals.sort((x, y) => x - y);
  return vals[Math.floor(n / 2)];
}

export function fitDepth(record, cam, sampleDepth) {
  const m = record.marks;
  const dLip = medianAlong(m.lipL, m.lipR, sampleDepth);
  const dBack = medianAlong(m.backL, m.backR, sampleDepth);
  if (!Number.isFinite(dLip) || !Number.isFinite(dBack)) return null;
  if (Math.abs(dLip - dBack) < FLAT_DEPTH_EPS) return null;
  const invLip = 1 / cam.dist_ft;
  const invBack = 1 / (cam.dist_ft + record.depth_ft);
  const a = (invLip - invBack) / (dLip - dBack);
  const b = invLip - a * dLip;
  return { a, b };
}

export function depthToZcam(d, fit) {
  const inv = fit.a * d + fit.b;
  const z = 1 / Math.max(inv, 1 / Z_CAM_MAX);
  return Math.min(Z_CAM_MAX, Math.max(Z_CAM_MIN, z));
}

export function zcamToDepth(zCam, fit) {
  return (1 / zCam - fit.b) / fit.a;
}

/** World feet → engine [x, y, z] (z = 1 − depth). null if no projection. */
export function worldToEngine(w, cam, fit) {
  const p = worldToPixel(w, cam);
  if (!p) return null;
  const [u, v, zCam] = p;
  return [u, v, 1 - zcamToDepth(zCam, fit)];
}

/** Engine [x, y, z] → world feet (used to migrate existing lights). */
export function engineToWorld([x, y, z], cam, fit) {
  const zCam = depthToZcam(1 - z, fit);
  return pixelToWorld(x, y, zCam, cam);
}

export function engineDirToWorld([x, y, z]) { return [x, -y, -z]; }
export function worldDirToEngine([x, y, z]) { return [x, -y, -z]; }

export function falloffToMetric(falloff, record) {
  return falloff / (record.width_ft * record.width_ft);
}

/** Shared synthetic fixture (see plan Global Constraints). */
export const SYNTHETIC_STAGE = {
  aspect: 0.75,
  record: {
    version: 1, units: 'ft', width_ft: 40, height_ft: 20, depth_ft: 30,
    marks: {
      lipL: [0.1, 0.61333], lipR: [0.9, 0.61333], top: [0.5, 0.08],
      backL: [0.23333, 0.54222], backR: [0.76667, 0.54222],
    },
    depth_fit: null, depth_check: null,
  },
  expected: { dist_ft: 60, height_ft: 8, f: 1.2 },
};
```

- [ ] **Step 4: Run tests**

Run: `npm run test:unit`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add web/src/metric/calibration.js web/tests/unit/metric/calibration.test.js
git commit -m "feat(metric): pinhole camera solve, depth fit, and feet/engine transforms"
```

---

### Task 3: Calibration math (Python mirror)

**Files:**
- Create: `packages/relighting_engine/relighting_engine/metric/__init__.py`, `packages/relighting_engine/relighting_engine/metric/calibration.py`
- Test: `packages/relighting_engine/tests/unit/test_metric_calibration.py`

**Interfaces:**
- Produces: `@dataclass CameraModel(f, dist_ft, height_ft, u_c, va_h, k_y, aspect)`, `@dataclass DepthFit(a, b)`, `@dataclass Calibration(width_ft, height_ft, depth_ft, camera: CameraModel, fit: DepthFit | None)` with `Calibration.from_dict(d, aspect)`; functions `solve_camera(record: dict, aspect: float) → CameraModel`, `depth_to_zcam(d, fit)` (numpy/torch broadcast), `pixel_to_world(u, v, zcam, cam)` (broadcast), `world_to_pixel(xyz, cam) → tuple | None`, `world_to_engine(xyz, cam, fit) → tuple | None`, `engine_dir_to_world(v)`, `falloff_to_metric(falloff, width_ft)`. Same formulas as Task 2, no validation (the API validates).

- [ ] **Step 1: Write the failing test**

`packages/relighting_engine/tests/unit/test_metric_calibration.py`:
```python
from __future__ import annotations

import math

import numpy as np
import pytest

from relighting_engine.metric.calibration import (
    Calibration, DepthFit, depth_to_zcam, engine_dir_to_world, falloff_to_metric,
    pixel_to_world, solve_camera, world_to_engine, world_to_pixel,
)

ASPECT = 0.75
RECORD = {
    "version": 1, "units": "ft", "width_ft": 40, "height_ft": 20, "depth_ft": 30,
    "marks": {
        "lipL": [0.1, 0.61333], "lipR": [0.9, 0.61333], "top": [0.5, 0.08],
        "backL": [0.23333, 0.54222], "backR": [0.76667, 0.54222],
    },
    "depth_fit": {"a": -0.037037, "b": 0.024074},
    "depth_check": None,
}


def test_solve_camera_recovers_synthetic_stage():
    cam = solve_camera(RECORD, ASPECT)
    assert cam.dist_ft == pytest.approx(60, rel=0.005)
    assert cam.height_ft == pytest.approx(8, rel=0.005)
    assert cam.f == pytest.approx(1.2, rel=0.005)
    assert cam.k_y == pytest.approx(1.0, abs=0.01)
    assert cam.u_c == 0.5
    assert cam.va_h == pytest.approx(0.3, abs=0.002)


def test_pixel_to_world_lip_corners_and_top():
    cam = solve_camera(RECORD, ASPECT)
    X, Y, Z = pixel_to_world(np.array([0.1, 0.9]), np.array([0.61333, 0.61333]), np.array([60.0, 60.0]), cam)
    assert X[0] == pytest.approx(-20, rel=0.005) and X[1] == pytest.approx(20, rel=0.005)
    assert abs(Y[0]) < 0.05 and abs(Z[0]) < 1e-6
    _, Yt, _ = pixel_to_world(0.5, 0.08, 60.0, cam)
    assert Yt == pytest.approx(20, rel=0.005)


def test_world_to_pixel_round_trip_and_none_behind_camera():
    cam = solve_camera(RECORD, ASPECT)
    u, v, zc = world_to_pixel((7.0, 3.0, 12.0), cam)
    X, Y, Z = pixel_to_world(u, v, zc, cam)
    assert (X, Y, Z) == pytest.approx((7.0, 3.0, 12.0), abs=1e-6)
    assert world_to_pixel((0.0, 10.0, -60.0), cam) is None
    assert world_to_pixel((0.0, 10.0, -80.0), cam) is None


def test_depth_to_zcam_matches_js_numbers_and_clamps():
    fit = DepthFit(a=-0.037037, b=0.024074)
    assert depth_to_zcam(0.20, fit) == pytest.approx(60, abs=1e-2)
    assert depth_to_zcam(0.35, fit) == pytest.approx(90, abs=1e-2)
    z = depth_to_zcam(np.array([-5.0, 0.65]), fit)
    assert z[0] >= 0.5 and z[1] <= 10000


def test_world_to_engine_and_dir_transform():
    cam = solve_camera(RECORD, ASPECT)
    fit = DepthFit(a=-0.037037, b=0.024074)
    e = world_to_engine((5.0, 4.0, 10.0), cam, fit)
    assert 0 < e[0] < 1 and 0 < e[1] < 1
    assert world_to_engine((0.0, 20.0, -70.0), cam, fit) is None
    assert engine_dir_to_world((0.1, 0.2, -0.9)) == (0.1, -0.2, 0.9)


def test_calibration_from_dict_and_falloff():
    cal = Calibration.from_dict(RECORD, ASPECT)
    assert cal.fit is not None and cal.camera.dist_ft == pytest.approx(60, rel=0.005)
    assert falloff_to_metric(1.0, cal.width_ft) == pytest.approx(1 / 1600)
    no_fit = Calibration.from_dict({**RECORD, "depth_fit": None}, ASPECT)
    assert no_fit.fit is None
```

- [ ] **Step 2: Run to verify failure**

Run: `.venv/Scripts/python -m pytest packages/relighting_engine/tests/unit/test_metric_calibration.py -q`
Expected: FAIL, `ModuleNotFoundError: relighting_engine.metric`.

- [ ] **Step 3: Implement**

`packages/relighting_engine/relighting_engine/metric/__init__.py`:
```python
"""Real-world (feet) calibration: pinhole camera from stage marks, depth fit."""
```

`packages/relighting_engine/relighting_engine/metric/calibration.py`:
```python
"""Mirror of web/src/metric/calibration.js. Keep the formulas identical.

Image coords u in [0,1] left→right, v in [0,1] top→bottom; va = v * aspect.
World frame (feet): origin center of lip on the deck, +X audience right,
+Y up, +Z upstage.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any

import numpy as np

Z_CAM_MIN = 0.5
Z_CAM_MAX = 10000.0


@dataclass(frozen=True)
class CameraModel:
    f: float
    dist_ft: float
    height_ft: float
    u_c: float
    va_h: float
    k_y: float
    aspect: float


@dataclass(frozen=True)
class DepthFit:
    a: float
    b: float


@dataclass(frozen=True)
class Calibration:
    width_ft: float
    height_ft: float
    depth_ft: float
    camera: CameraModel
    fit: DepthFit | None

    @classmethod
    def from_dict(cls, d: dict[str, Any], aspect: float) -> "Calibration":
        fit = d.get("depth_fit")
        return cls(
            width_ft=float(d["width_ft"]), height_ft=float(d["height_ft"]),
            depth_ft=float(d["depth_ft"]),
            camera=solve_camera(d, aspect),
            fit=DepthFit(a=float(fit["a"]), b=float(fit["b"])) if fit else None,
        )


def solve_camera(record: dict[str, Any], aspect: float) -> CameraModel:
    m = record["marks"]
    w_lip = abs(m["lipR"][0] - m["lipL"][0])
    w_back = abs(m["backR"][0] - m["backL"][0])
    r = w_back / w_lip
    dist = record["depth_ft"] * r / (1.0 - r)
    f = w_lip * dist / record["width_ft"]
    va_lip = (m["lipL"][1] + m["lipR"][1]) / 2.0 * aspect
    va_back = (m["backL"][1] + m["backR"][1]) / 2.0 * aspect
    va_top = m["top"][1] * aspect
    h = (va_lip - va_back) / (f * (1.0 / dist - 1.0 / (dist + record["depth_ft"])))
    va_h = va_lip - f * h / dist
    k_y = (f * record["height_ft"] / dist) / (va_lip - va_top)
    return CameraModel(f=f, dist_ft=dist, height_ft=h, u_c=(m["lipL"][0] + m["lipR"][0]) / 2.0,
                       va_h=va_h, k_y=k_y, aspect=aspect)


def depth_to_zcam(d, fit: DepthFit):
    inv = np.maximum(fit.a * np.asarray(d, dtype=np.float64) + fit.b, 1.0 / Z_CAM_MAX)
    return np.clip(1.0 / inv, Z_CAM_MIN, Z_CAM_MAX)


def zcam_to_depth(zcam, fit: DepthFit):
    return (1.0 / np.asarray(zcam, dtype=np.float64) - fit.b) / fit.a


def pixel_to_world(u, v, zcam, cam: CameraModel):
    u = np.asarray(u, dtype=np.float64); v = np.asarray(v, dtype=np.float64)
    zcam = np.asarray(zcam, dtype=np.float64)
    X = (u - cam.u_c) * zcam / cam.f
    Y = cam.k_y * (cam.height_ft - (v * cam.aspect - cam.va_h) * zcam / cam.f)
    Z = zcam - cam.dist_ft
    return X, Y, Z


def world_to_pixel(xyz, cam: CameraModel):
    X, Y, Z = (float(c) for c in xyz)
    zcam = Z + cam.dist_ft
    if not zcam >= Z_CAM_MIN:
        return None
    u = cam.u_c + X * cam.f / zcam
    va = cam.va_h + (cam.height_ft - Y / cam.k_y) * cam.f / zcam
    return (u, va / cam.aspect, zcam)


def world_to_engine(xyz, cam: CameraModel, fit: DepthFit):
    p = world_to_pixel(xyz, cam)
    if p is None:
        return None
    u, v, zcam = p
    return (u, v, 1.0 - float(zcam_to_depth(zcam, fit)))


def engine_to_world(xyz, cam: CameraModel, fit: DepthFit):
    x, y, z = (float(c) for c in xyz)
    zcam = float(depth_to_zcam(1.0 - z, fit))
    X, Y, Z = pixel_to_world(x, y, zcam, cam)
    return (float(X), float(Y), float(Z))


def engine_dir_to_world(v):
    x, y, z = (float(c) for c in v)
    return (x, -y, -z)


def falloff_to_metric(falloff: float, width_ft: float) -> float:
    return falloff / (width_ft * width_ft)
```

- [ ] **Step 4: Run tests**

Run: `.venv/Scripts/python -m pytest packages/relighting_engine/tests/unit/test_metric_calibration.py -q`
Expected: 6 passed.

- [ ] **Step 5: Commit**

```bash
git add packages/relighting_engine/relighting_engine/metric packages/relighting_engine/tests/unit/test_metric_calibration.py
git commit -m "feat(engine): metric calibration math mirroring the web module"
```

---

### Task 4: Shader metric mode

**Files:**
- Modify: `web/src/webgl/shaders/relight.frag` (uniform block near line 26, `main()` from line 155)
- Modify: `web/src/webgl/renderer.js` (`getUniformLocation` setup near line 103, `draw` line 176, `uploadLights` line 219)

**Interfaces:**
- Consumes from `state`: `state.calibration` (the CalibrationRecord or null), `state.width/height`, per light `position_ft`, `direction_ft` (world unit vector; set by Task 8's sync helper), `position_eng`/`direction_eng` proxies (also set by Task 8; before Task 8 exists the renderer falls back to `position`/`direction`).
- Produces: shader uniforms `u_metric`, `u_cam` (vec4 f, dist, h, u_c), `u_cam2` (vec4 va_h, k_y, aspect, unused), `u_fit` (vec3 a, b, hasFit), `u_l_position_eng[8]`, `u_l_direction_eng[8]`, `u_l_shadowDir[8]`.
- Depth without a fit (`hasFit = 0`): `zCam = dist + depth * depth_ft` (linear fallback per spec).

Run first: `impact({target: "draw", direction: "upstream"})` and `impact({target: "uploadLights", direction: "upstream"})`; report in the task summary.

- [ ] **Step 1: Add uniforms and metric position/normal to the shader**

After line 31 (`uniform float u_l_cone_angle[MAX_LIGHTS];`) add:
```glsl
// ── Metric mode (calibrated scenes) ──────────────────────────────────────
uniform int   u_metric;                 // 1 = positions in feet
uniform vec4  u_cam;                    // f, dist_ft, height_ft, u_c
uniform vec4  u_cam2;                   // va_h, k_y, aspect, depth_ft
uniform vec3  u_fit;                    // a, b, hasFit(0/1)
uniform vec3  u_l_position_eng[MAX_LIGHTS];   // engine-space proxy for shadow marching
uniform vec3  u_l_direction_eng[MAX_LIGHTS];
uniform int   u_l_shadowDir[MAX_LIGHTS];      // 1 = march along direction (light has no projection)

float metric_zcam(float d) {
  if (u_fit.z < 0.5) return u_cam.y + d * u_cam2.w;     // no depth fit: linear over stage depth
  float inv = max(u_fit.x * d + u_fit.y, 1.0 / 10000.0);
  return clamp(1.0 / inv, 0.5, 10000.0);
}

vec3 metric_pixel_to_world(vec2 uv, float d) {
  float zc = metric_zcam(d);
  float X = (uv.x - u_cam.w) * zc / u_cam.x;
  float Y = u_cam2.y * (u_cam.z - (uv.y * u_cam2.z - u_cam2.x) * zc / u_cam.x);
  return vec3(X, Y, zc - u_cam.y);
}
```

In `main()` replace the single line `vec3 P = vec3(v_uv.x, v_uv.y, depth);` with:
```glsl
  vec3 P = vec3(v_uv.x, v_uv.y, depth);            // engine space (shadows, gobo ortho)
  vec3 Pw = P;                                      // lighting-space position
  vec3 Nw = N;                                      // lighting-space normal
  if (u_metric == 1) {
    Pw = metric_pixel_to_world(v_uv, depth);
    Nw = vec3(N.x, -N.y, -N.z);
  }
```

In the light loop, change the light-vector block to:
```glsl
    vec3 Lvec; float atten;
    vec3 Lvec_eng;                                   // engine-space vector for shadow marching
    if (u_l_type[i] == 0) {  // directional
      Lvec = normalize(-u_l_direction[i]);
      atten = 1.0;
      Lvec_eng = (u_metric == 1) ? normalize(-u_l_direction_eng[i]) : Lvec;
    } else {
      vec3 d = u_l_position[i] - Pw;
      float dist = length(d) + 1e-6;
      Lvec = d / dist;
      atten = 1.0 / (1.0 + u_l_falloff[i] * dist * dist);
      if (u_metric == 1) {
        Lvec_eng = (u_l_shadowDir[i] == 1)
          ? normalize(-u_l_direction_eng[i])
          : normalize(u_l_position_eng[i] - P);
      } else {
        Lvec_eng = Lvec;
      }
    }
```
Then, in the rest of the loop body: every use of `N` in the diffuse term becomes `Nw`; the cone term keeps `Lvec` and `u_l_direction[i]` (both lighting-space); `perspective_uv(P, u_l_position[i], u_l_direction[i], ...)` and `equirect_uv(P, u_l_position[i])` become `perspective_uv(Pw, ...)` / `equirect_uv(Pw, ...)`; `ortho_uv(P, ...)` stays engine-space; `shadow_factor(P, Lvec, maskV)` becomes `shadow_factor(P, Lvec_eng, maskV)`. Reflector code (after the loop) is unchanged in this task: reflectors stay engine-space and are documented as uncalibrated in the panel.

- [ ] **Step 2: Upload the uniforms from the renderer**

In `renderer.js` where light uniform locations are gathered (line ~103) extend `fields` with `position_eng`, `direction_eng`, `shadowDir`, and add scalar locations:
```js
for (const name of ['u_metric', 'u_cam', 'u_cam2', 'u_fit']) locs[name] = gl.getUniformLocation(program, name);
```
In `draw(state)` after the ambient uniforms:
```js
  const cal = state.calibration;
  if (cal && cal.camera) {
    const c = cal.camera;
    gl.uniform1i(locs.u_metric, 1);
    gl.uniform4f(locs.u_cam, c.f, c.dist_ft, c.height_ft, c.u_c);
    gl.uniform4f(locs.u_cam2, c.va_h, c.k_y, c.aspect, cal.depth_ft);
    const fit = cal.depth_fit;
    gl.uniform3f(locs.u_fit, fit ? fit.a : 0, fit ? fit.b : 0, fit ? 1 : 0);
  } else {
    gl.uniform1i(locs.u_metric, 0);
  }
```
(`cal.camera` is the solved CameraModel stored on the record by Task 8; the renderer never solves.)

In `uploadLights`, pack per light:
```js
    const metric = !!(lights.metricMode);
    const posSrc = metric && L.position_ft ? L.position_ft : L.position;
    const dirSrc = metric && L.direction_ft ? L.direction_ft : L.direction;
    pos.set(posSrc, i * 3); dir.set(dirSrc, i * 3);
    posEng.set(L.position_eng || L.position, i * 3);
    dirEng.set(L.direction_eng || L.direction, i * 3);
    shadowDir[i] = metric && !L.position_eng ? 1 : 0;
    falloff[i] = metric && L.falloff_ft != null ? L.falloff_ft : L.falloff;
```
with `posEng`, `dirEng` (`Float32Array(24)`) and `shadowDir` (`Int32Array(8)`) declared alongside the existing arrays and uploaded via `gl.uniform3fv(locs.position_eng, posEng)`, `gl.uniform3fv(locs.direction_eng, dirEng)`, `gl.uniform1iv(locs.shadowDir, shadowDir)`. Set `emitters.metricMode = !!(state.calibration && state.calibration.camera)` in `draw` before calling `uploadLights(emitters, ...)`.

- [ ] **Step 3: Verify uncalibrated behavior is unchanged**

Run: `npx playwright test --config=web/tests/playwright.config.js smoke.spec.js --reporter=list`
Expected: 1 passed, zero console errors (a shader compile error surfaces as a console error).
Then run the parity spec (it fails on `#file` today; Task 7 fixes it) only to confirm the failure is still the selector, not a shader compile error: `npx playwright test --config=web/tests/playwright.config.js parity.spec.js --reporter=list`.

- [ ] **Step 4: Commit**

```bash
git add web/src/webgl/shaders/relight.frag web/src/webgl/renderer.js
git commit -m "feat(webgl): metric mode — per-pixel positions in feet, lights in feet, engine-space shadow proxy"
```

---

### Task 5: Python engine metric mode

**Files:**
- Modify: `packages/relighting_engine/relighting_engine/lighting/models.py:36-66` (`Light`)
- Modify: `packages/relighting_engine/relighting_engine/lighting/shaders.py:32-37` (`_make_world_pos`), `:189-260` (`render`)
- Modify: `packages/relighting_engine/relighting_engine/core/engine.py` (`render` passthrough — locate with `grep -n "def render" packages/relighting_engine/relighting_engine/core/engine.py`)
- Test: `packages/relighting_engine/tests/unit/test_metric_render.py`

**Interfaces:**
- `Light` gains `position_ft: tuple[float,float,float] | None = None`, `target_ft: ... | None = None`, `direction_ft: ... | None = None`.
- `shaders.render(..., calibration: Calibration | None = None)`; `engine.RelightingEngine.render(...)` passes it through.
- In metric mode: `P_w = pixel_to_world(...)` in feet, `N_w = (nx, −ny, −nz)`, light vectors use `position_ft`/`direction_ft`, attenuation uses `falloff_to_metric(L.falloff, cal.width_ft)`, shadows use the engine-space proxy `world_to_engine(position_ft)` or direction when the proxy is `None`. Reflectors unchanged.

Run first: `impact({target: "render", direction: "upstream"})` (expect HIGH/CRITICAL — this is the planned, isolated engine change) and report.

- [ ] **Step 1: Write the failing test**

`packages/relighting_engine/tests/unit/test_metric_render.py`:
```python
from __future__ import annotations

import numpy as np
import pytest
import torch

from relighting_engine.core.prepared import PreparedImage
from relighting_engine.lighting import shaders
from relighting_engine.lighting.models import Light
from relighting_engine.metric.calibration import Calibration

ASPECT = 1.0
RECORD = {
    "width_ft": 40, "height_ft": 20, "depth_ft": 30,
    "marks": {"lipL": [0.1, 0.61333 * 0.75], "lipR": [0.9, 0.61333 * 0.75], "top": [0.5, 0.08 * 0.75],
              "backL": [0.23333, 0.54222 * 0.75], "backR": [0.76667, 0.54222 * 0.75]},
    "depth_fit": {"a": -0.037037, "b": 0.024074},
}


def _prepared(h=4, w=4):
    original = np.full((h, w, 3), 0.5, dtype=np.float32)
    depth = np.full((h, w), 0.2, dtype=np.float32)          # everything at the lip plane (60 ft)
    normals = np.zeros((h, w, 3), dtype=np.float32); normals[..., 2] = 1.0   # facing camera
    return PreparedImage(original=original, depth=depth, normals=normals, mask=None, confidence=None,
                         width=w, height=h)


def test_front_of_house_light_illuminates_camera_facing_surface():
    cal = Calibration.from_dict(RECORD, ASPECT)
    L = Light(type="point", position=(0.5, 0.5, 1.0), intensity=1.0, falloff=1.0,
              position_ft=(0.0, 20.0, -60.0))
    out = shaders.render(_prepared(), [L], ambient=0.0, device="cpu", calibration=cal)
    assert out.mean() > 0.05


def test_behind_stage_light_does_not_illuminate_camera_facing_surface():
    cal = Calibration.from_dict(RECORD, ASPECT)
    L = Light(type="point", position=(0.5, 0.5, 0.0), intensity=1.0, falloff=1.0,
              position_ft=(0.0, 20.0, 90.0))
    out = shaders.render(_prepared(), [L], ambient=0.0, device="cpu", calibration=cal)
    assert out.max() < 1e-4


def test_uncalibrated_path_is_unchanged():
    L = Light(type="directional", direction=(0.5, -0.5, -0.5), intensity=1.0)
    a = shaders.render(_prepared(), [L], ambient=0.15, device="cpu")
    b = shaders.render(_prepared(), [L], ambient=0.15, device="cpu", calibration=None)
    assert np.array_equal(a, b)


def test_metric_falloff_uses_feet():
    cal = Calibration.from_dict(RECORD, ASPECT)
    near = Light(type="point", position=(0.5, 0.5, 1.0), intensity=1.0, falloff=1.0, position_ft=(0.0, 5.0, -10.0))
    far = Light(type="point", position=(0.5, 0.5, 1.0), intensity=1.0, falloff=1.0, position_ft=(0.0, 5.0, -40.0))
    a = shaders.render(_prepared(), [near], ambient=0.0, device="cpu", calibration=cal).mean()
    b = shaders.render(_prepared(), [far], ambient=0.0, device="cpu", calibration=cal).mean()
    assert a > b
```
(If `PreparedImage` requires other fields, construct it the way `tests/unit/test_prepared.py` does; keep depth constant 0.2 and normals facing the camera.)

- [ ] **Step 2: Run to verify failure**

Run: `.venv/Scripts/python -m pytest packages/relighting_engine/tests/unit/test_metric_render.py -q`
Expected: FAIL, `TypeError: render() got an unexpected keyword argument 'calibration'` (or `Light.__init__` unexpected `position_ft`).

- [ ] **Step 3: Extend `Light`**

In `models.py` after `name: str = ""` add:
```python
    # Metric (calibrated) fields — feet in the world frame. None when uncalibrated.
    position_ft: tuple[float, float, float] | None = None
    target_ft: tuple[float, float, float] | None = None
    direction_ft: tuple[float, float, float] | None = None
```

- [ ] **Step 4: Metric mode in `shaders.render`**

Add imports at the top of `shaders.py`:
```python
from relighting_engine.metric.calibration import (
    Calibration, depth_to_zcam, engine_dir_to_world, falloff_to_metric, pixel_to_world, world_to_engine,
)
```
Add after `_make_world_pos`:
```python
def _make_metric_pos(h: int, w: int, depth: torch.Tensor, cal: Calibration) -> torch.Tensor:
    """(H, W, 3) positions in feet. Mirrors relight.frag metric_pixel_to_world."""
    ys = torch.linspace(0.0, 1.0, h, device=depth.device, dtype=depth.dtype)
    xs = torch.linspace(0.0, 1.0, w, device=depth.device, dtype=depth.dtype)
    V, U = torch.meshgrid(ys, xs, indexing="ij")
    cam = cal.camera
    if cal.fit is None:
        zc = cam.dist_ft + depth * cal.depth_ft
    else:
        inv = torch.clamp(cal.fit.a * depth + cal.fit.b, min=1.0 / 10000.0)
        zc = torch.clamp(1.0 / inv, 0.5, 10000.0)
    X = (U - cam.u_c) * zc / cam.f
    Y = cam.k_y * (cam.height_ft - (V * cam.aspect - cam.va_h) * zc / cam.f)
    Z = zc - cam.dist_ft
    return torch.stack([X, Y, Z], dim=-1)


def _metric_light_vectors(L: Light, cal: Calibration):
    """Lighting-space (feet) position/direction plus the engine-space shadow proxy."""
    pos_ft = L.position_ft if L.position_ft is not None else (0.0, 0.0, -cal.camera.dist_ft)
    if L.target_ft is not None:
        d = np.array(L.target_ft, dtype=np.float64) - np.array(pos_ft, dtype=np.float64)
        n = np.linalg.norm(d)
        dir_ft = tuple((d / n).tolist()) if n > 1e-9 else engine_dir_to_world(L.direction)
    elif L.direction_ft is not None:
        dir_ft = L.direction_ft
    else:
        dir_ft = engine_dir_to_world(L.direction)
    proxy = world_to_engine(pos_ft, cal.camera, cal.fit) if cal.fit is not None else None
    return pos_ft, dir_ft, proxy
```
In `render(...)` add the keyword `calibration: Calibration | None = None` and, after `P = _make_world_pos(h, w, depth)`:
```python
    metric = calibration is not None
    if metric:
        Pw = _make_metric_pos(h, w, depth, calibration)
        Nw = torch.stack([normals[..., 0], -normals[..., 1], -normals[..., 2]], dim=-1)
    else:
        Pw, Nw = P, normals
```
Then in the per-light block (lines ~246-260): where the code builds `pos = torch.tensor(L.position, ...)` and `diff_vec = pos - P`, use `Pw` and the metric position/direction:
```python
            if metric:
                pos_ft, dir_ft, proxy = _metric_light_vectors(L, calibration)
                light_pos = torch.tensor(pos_ft, device=device, dtype=torch.float32)
                light_dir = torch.tensor(dir_ft, device=device, dtype=torch.float32)
                falloff = falloff_to_metric(L.falloff, calibration.width_ft)
            else:
                light_pos = torch.tensor(L.position, device=device, dtype=torch.float32)
                light_dir = torch.tensor(effective_direction(L), device=device, dtype=torch.float32)
                falloff = L.falloff
```
and compute `diff_vec = light_pos - Pw`, `atten = 1.0 / (1.0 + falloff * dist²)`, `diff = clamp(dot(Nw, L_vec))`, cone from `light_dir`. For the shadow call, pass an engine-space vector: when `metric` and `proxy is not None`, `L_vec_eng = normalize(tensor(proxy) - P)`; when `metric` and `proxy is None`, `L_vec_eng = normalize(-tensor(L.direction))`; otherwise `L_vec_eng = L_vec`. Gobo `project_uv` receives `Pw` and a light whose `position`/`direction` are the lighting-space values (build `L_for_gobo = dataclasses.replace(L, position=pos_ft, direction=dir_ft)` in metric mode). Directional lights: `L_vec = normalize(-light_dir)`, `atten = 1`.

- [ ] **Step 5: Pass through `engine.py`**

In `core/engine.py`, the `render` method that calls `shaders.render(...)` gains `calibration: Calibration | None = None` and forwards it. (Find it with grep; keep the signature order: add the kwarg last.)

- [ ] **Step 6: Run tests**

Run: `.venv/Scripts/python -m pytest packages/relighting_engine/tests/unit -q`
Expected: all pass, including the 4 new tests. Also run `.venv/Scripts/python -m pytest packages/relighting_engine/tests/golden -q` to confirm uncalibrated goldens are unchanged.

- [ ] **Step 7: Commit**

```bash
git add packages/relighting_engine/relighting_engine/lighting/models.py packages/relighting_engine/relighting_engine/lighting/shaders.py packages/relighting_engine/relighting_engine/core/engine.py packages/relighting_engine/tests/unit/test_metric_render.py
git commit -m "feat(engine): metric mode — positions in feet, world-frame normals, engine-space shadow proxy"
```

---

### Task 6: API schema and routes

**Files:**
- Modify: `packages/relighting_api/relighting_api/schemas.py:36-78` (`LightModel`), `:82-125` (`RenderCommon`, `RenderLayersRequest`)
- Modify: `packages/relighting_api/relighting_api/routes/render.py:16-40`, `routes/layers.py:27-45`, `routes/polish.py:32-55`
- Test: `packages/relighting_api/tests/api/test_calibration_schema.py`

**Interfaces:**
- `CalibrationModel(version:int=1, units:Literal['ft','m']='ft', width_ft:float>0, height_ft:float>0, depth_ft:float>0, marks: dict[str, list[float]], depth_fit: DepthFitModel|None=None, depth_check: dict|None=None)` with `to_engine(aspect) → Calibration`.
- `LightModel` gains `position_ft`, `target_ft`, `direction_ft` (all `list[float] | None = None`, length 3 when present) and passes them to `Light`.
- `RenderCommon.calibration: CalibrationModel | None = None`; `RenderLayersRequest.calibration` likewise. Routes compute `aspect = prepared.height / prepared.width` and pass `calibration=req.calibration.to_engine(aspect)` when present.

- [ ] **Step 1: Write the failing test**

`packages/relighting_api/tests/api/test_calibration_schema.py`:
```python
from __future__ import annotations

import pytest
from pydantic import ValidationError

from relighting_api.schemas import CalibrationModel, LightModel, RenderRequest

MARKS = {"lipL": [0.1, 0.61], "lipR": [0.9, 0.61], "top": [0.5, 0.08], "backL": [0.23, 0.54], "backR": [0.77, 0.54]}


def test_calibration_model_round_trips_to_engine():
    cal = CalibrationModel(width_ft=40, height_ft=20, depth_ft=30, marks=MARKS,
                           depth_fit={"a": -0.037, "b": 0.024})
    eng = cal.to_engine(aspect=0.75)
    assert eng.width_ft == 40 and eng.fit is not None and eng.camera.dist_ft > 0


def test_calibration_model_rejects_missing_mark_and_bad_dims():
    with pytest.raises(ValidationError):
        CalibrationModel(width_ft=40, height_ft=20, depth_ft=30, marks={k: v for k, v in MARKS.items() if k != "top"})
    with pytest.raises(ValidationError):
        CalibrationModel(width_ft=0, height_ft=20, depth_ft=30, marks=MARKS)


def test_light_model_carries_feet_fields():
    L = LightModel(type="spotlight", position_ft=[0, 20, -60], target_ft=[0, 5, 10]).to_engine()
    assert L.position_ft == (0, 20, -60) and L.target_ft == (0, 5, 10)
    with pytest.raises(ValidationError):
        LightModel(type="spotlight", position_ft=[0, 20])


def test_render_request_accepts_optional_calibration():
    req = RenderRequest(session_id="s", lights=[], calibration=None)
    assert req.calibration is None
    req = RenderRequest(session_id="s", lights=[],
                        calibration={"width_ft": 40, "height_ft": 20, "depth_ft": 30, "marks": MARKS})
    assert req.calibration.width_ft == 40
```

- [ ] **Step 2: Run to verify failure**

Run: `.venv/Scripts/python -m pytest packages/relighting_api/tests/api/test_calibration_schema.py -q`
Expected: FAIL, `ImportError: cannot import name 'CalibrationModel'`.

- [ ] **Step 3: Implement schema**

In `schemas.py` add (before `LightModel`):
```python
from relighting_engine.metric.calibration import Calibration

_MARK_KEYS = ("lipL", "lipR", "top", "backL", "backR")


class DepthFitModel(BaseModel):
    a: float
    b: float


class CalibrationModel(BaseModel):
    version: int = 1
    units: Literal["ft", "m"] = "ft"
    width_ft: Annotated[float, Field(gt=0.0)]
    height_ft: Annotated[float, Field(gt=0.0)]
    depth_ft: Annotated[float, Field(gt=0.0)]
    marks: dict[str, list[float]]
    depth_fit: DepthFitModel | None = None
    depth_check: dict[str, Any] | None = None

    @model_validator(mode="after")
    def _validate_marks(self) -> "CalibrationModel":
        for k in _MARK_KEYS:
            v = self.marks.get(k)
            if not (isinstance(v, list) and len(v) == 2):
                raise ValueError(f"marks.{k} must be [u, v]")
        return self

    def to_engine(self, aspect: float) -> Calibration:
        return Calibration.from_dict(self.model_dump(), aspect)
```
In `LightModel` add after `name: str = ""`:
```python
    position_ft: list[float] | None = None
    target_ft: list[float] | None = None
    direction_ft: list[float] | None = None

    @model_validator(mode="after")
    def _validate_ft(self) -> "LightModel":
        for k in ("position_ft", "target_ft", "direction_ft"):
            v = getattr(self, k)
            if v is not None and len(v) != 3:
                raise ValueError(f"{k} must have 3 components")
        return self
```
and in `to_engine` pass `position_ft=tuple(self.position_ft) if self.position_ft else None` (same for `target_ft`, `direction_ft`). Add `calibration: CalibrationModel | None = None` to `RenderCommon` and `RenderLayersRequest`. Add `from typing import Any` if missing.

- [ ] **Step 4: Routes**

In each of `render.py`, `layers.py`, `polish.py`, where `lights = [l.to_engine() for l in req.lights]` is followed by the engine call, add:
```python
        calibration = req.calibration.to_engine(prepared.height / prepared.width) if req.calibration else None
```
and pass `calibration=calibration` to the engine render call. (`prepared` is the session's `PreparedImage`, already looked up in each route.) For `polish.py`, only the classical pre-render uses it.

- [ ] **Step 5: Run tests**

Run: `.venv/Scripts/python -m pytest packages/relighting_api/tests -q`
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add packages/relighting_api/relighting_api/schemas.py packages/relighting_api/relighting_api/routes/render.py packages/relighting_api/relighting_api/routes/layers.py packages/relighting_api/relighting_api/routes/polish.py packages/relighting_api/tests/api/test_calibration_schema.py
git commit -m "feat(api): accept calibration and feet positions on render, layers, and polish"
```

---

### Task 7: Parity — fix the stale selector and add a calibrated golden

**Files:**
- Modify: `web/tests/parity.spec.js:19` (`#file` → `#ns-file`), plus a second test block
- Modify: `packages/relighting_engine/tests/golden/configs.py` (new config)
- Modify: `web/src/main.js` — expose `window.__state` if not already (grep `__state`; it is referenced by the parity spec, keep it)

**Interfaces:**
- New golden config name `calibrated_foh_spot`: one spotlight with `position_ft=(0, 20, -60)`, `target_ft=(0, 5, 10)`, `intensity=1.5`, `cone_angle=0.35`, ambient 0.1, calibration = the API `RECORD` from Task 3 with aspect from the fixture image. `test_goldens.py` must pass `calibration` when a config carries it (extend the tuple to `(name, lights, ambient, calibration_dict|None)` and update the two existing consumers).
- Golden regeneration: `test_goldens.py` writes goldens when the expected file is missing (check its behavior with `grep -n "expected" packages/relighting_engine/tests/golden/test_goldens.py`; if it only compares, add an env var `RELIGHT_WRITE_GOLDENS=1` path that writes the file). Document the command used in the task summary.

- [ ] **Step 1: Fix the selector and confirm the old parity test runs**

Change line 19 to `await page.setInputFiles('#ns-file', FIXTURE);`. The new-scene popup is open on a fresh server, so the input is present. Run:
`npx playwright test --config=web/tests/playwright.config.js parity.spec.js --reporter=list`
Expected: 1 passed. If the upload flow needs a name field or confirm click before `__state.width` is set, add exactly those steps (read `web/src/new-scene-popup.js` to find the ids) and note them.

- [ ] **Step 2: Add the calibrated golden config**

In `configs.py` extend each tuple with a fourth element `None` and append:
```python
CALIBRATION = {
    "width_ft": 40, "height_ft": 20, "depth_ft": 30,
    "marks": {"lipL": [0.1, 0.61333], "lipR": [0.9, 0.61333], "top": [0.5, 0.08],
              "backL": [0.23333, 0.54222], "backR": [0.76667, 0.54222]},
    "depth_fit": {"a": -0.037037, "b": 0.024074},
}
...
        ("calibrated_foh_spot", [
            Light(type="spotlight", position=(0.5, 0.2, 1.0), direction=(0.0, 0.3, -1.0),
                  position_ft=(0.0, 20.0, -60.0), target_ft=(0.0, 5.0, 10.0),
                  intensity=1.5, cone_angle=0.35, softness=0.1),
        ], 0.1, CALIBRATION),
```
Update `test_goldens.py` to build `Calibration.from_dict(cfg[3], h / w)` when `cfg[3]` is not None and pass `calibration=` to the engine. Generate the golden for `portrait_a.jpg` and commit the PNG.

- [ ] **Step 3: Add the calibrated parity test**

Append to `parity.spec.js` a second `test(...)` identical in structure to the first but: golden path `portrait_a__calibrated_foh_spot.png`; after upload set
```js
    s.calibration = { version: 1, units: 'ft', width_ft: 40, height_ft: 20, depth_ft: 30,
      marks: { lipL: [0.1, 0.61333], lipR: [0.9, 0.61333], top: [0.5, 0.08], backL: [0.23333, 0.54222], backR: [0.76667, 0.54222] },
      depth_fit: { a: -0.037037, b: 0.024074 }, depth_check: null };
    window.__applyCalibration();   // Task 8 exposes this: solves camera, syncs lights
    s.lights = [{ type: 'spotlight', position: [0.5, 0.2, 1.0], direction: [0, 0.3, -1],
      position_ft: [0, 20, -60], target_ft: [0, 5, 10], intensity: 1.5, falloff: 1.0,
      cone_angle: 0.35, softness: 0.1, color: [1,1,1], color_temperature: null, gel_preset: null,
      gobo: null, affects: 'all', enabled: true }];
    window.__syncMetricLights();   // Task 8 exposes this
```
then trigger a redraw the way the first test does (Task 8 replaces the dead `relight:redraw` dispatch with `window.__redraw()`; update both tests to call it).

This test is expected to fail until Task 8 lands; mark it `test.fixme` in this commit and un-fixme it in Task 8.

- [ ] **Step 4: Commit**

```bash
git add web/tests/parity.spec.js packages/relighting_engine/tests/golden/configs.py packages/relighting_engine/tests/golden/test_goldens.py packages/relighting_engine/tests/fixtures/expected/portrait_a__calibrated_foh_spot.png
git commit -m "test(parity): fix stale #file selector; add calibrated FOH spotlight golden"
```

---

### Task 8: Light data model, metric sync, and persistence

**Files:**
- Create: `web/src/metric/light-metric.js`
- Test: `web/tests/unit/metric/light-metric.test.js`
- Modify: `web/src/lights.js:229-254` (`newState`: add `calibration: null`, `units: 'ft'`)
- Modify: `web/src/targeting.js` (`applyTargeting` becomes metric-aware)
- Modify: `web/src/main.js:65-76` (`serializeSceneState`), `:271-330` (`applyScene`), `:517-530` (`onUpdateLight`), the resize listener, and a new `applyCalibration(record)` function.

**Interfaces:**
- `light-metric.js` exports:
  - `solveRecord(record, aspect) → record` (returns a copy with `camera` = `solveCamera(...)` attached; the renderer reads `record.camera`).
  - `syncLightFromFeet(L, record)` — given `position_ft` (and `target_ft`), sets `direction_ft` (from target or from `engineDirToWorld(direction)`), `position_eng` (`worldToEngine` or `null`), `direction_eng` (`worldDirToEngine(direction_ft)`), `falloff_ft`, and updates `position`/`target`/`direction` (engine) when a projection exists so 2D handles and the 3D fallback stay coherent.
  - `syncLightFromEngine(L, record)` — after a 2D drag or click-placement: sets `position_ft = engineToWorld(position)`, `target_ft` likewise when targeted, then calls `syncLightFromFeet`.
  - `migrateLightsToFeet(lights, record)` — for lights without `position_ft`, calls `syncLightFromEngine`.
  - `clearMetric(L)` — deletes the `_ft`/`_eng` fields (used when calibration is removed).
- `targeting.applyTargeting(light)` unchanged for uncalibrated lights; when `light.position_ft && light.target_ft` it also derives `direction_ft`.
- `main.js` exposes `window.__applyCalibration()`, `window.__syncMetricLights()`, `window.__redraw()` for the parity spec.
- `state.calibration` persists in `serializeSceneState`; `applyScene` restores it (solving the camera again from marks) and migrates lights.

Run first: `impact` on `applyTargeting`, `serializeSceneState`, `applyScene`, and the `onUpdateLight` closure; report.

- [ ] **Step 1: Write the failing test**

`web/tests/unit/metric/light-metric.test.js`:
```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { solveRecord, syncLightFromFeet, syncLightFromEngine, migrateLightsToFeet, clearMetric } from '../../../src/metric/light-metric.js';
import { SYNTHETIC_STAGE } from '../../../src/metric/calibration.js';

const near = (a, b, tol = 1e-6) => assert.ok(Math.abs(a - b) <= tol, `${a} !~ ${b}`);
const record = solveRecord({ ...SYNTHETIC_STAGE.record, depth_fit: { a: -0.037037, b: 0.024074 } }, SYNTHETIC_STAGE.aspect);

test('solveRecord attaches a camera', () => {
  assert.ok(record.camera && Math.abs(record.camera.dist_ft - 60) < 0.5);
});

test('syncLightFromFeet derives direction from target and engine proxies', () => {
  const L = { type: 'spotlight', position: [0.5, 0.5, 1], direction: [0, 0, -1], target: null,
    falloff: 1, position_ft: [0, 20, -60], target_ft: [0, 5, 10] };
  syncLightFromFeet(L, record);
  near(Math.hypot(...L.direction_ft), 1, 1e-9);
  assert.ok(L.direction_ft[2] > 0, 'points upstage');
  assert.equal(L.position_eng, null, 'FOH light at the camera plane has no projection');
  assert.deepEqual(L.direction_eng, [L.direction_ft[0], -L.direction_ft[1], -L.direction_ft[2]]);
  near(L.falloff_ft, 1 / 1600, 1e-12);
});

test('syncLightFromFeet updates engine position when the light projects', () => {
  const L = { type: 'point', position: [0.1, 0.1, 0.1], direction: [0, 0, -1], target: null, falloff: 1,
    position_ft: [0, 5, 10] };
  syncLightFromFeet(L, record);
  assert.ok(L.position_eng && L.position[0] > 0.4 && L.position[0] < 0.6);
  assert.deepEqual(L.position, L.position_eng);
});

test('syncLightFromEngine derives feet from an in-frame engine position', () => {
  const L = { type: 'spotlight', position: [0.5, 0.6, 0.8], direction: [0, 0, -1], target: [0.5, 0.5, 0.65], falloff: 1 };
  syncLightFromEngine(L, record);
  assert.ok(Array.isArray(L.position_ft) && Array.isArray(L.target_ft));
  assert.ok(Math.abs(L.position_ft[0]) < 1, 'centered light is near X = 0');
});

test('migrateLightsToFeet only touches lights without position_ft', () => {
  const a = { type: 'point', position: [0.5, 0.5, 0.5], direction: [0, 0, -1], target: null, falloff: 1 };
  const b = { ...a, position_ft: [1, 2, 3] };
  migrateLightsToFeet([a, b], record);
  assert.ok(a.position_ft);
  assert.deepEqual(b.position_ft, [1, 2, 3]);
});

test('clearMetric removes metric fields', () => {
  const L = { position_ft: [1, 2, 3], target_ft: [0, 0, 0], direction_ft: [0, 0, 1], position_eng: [0.5, 0.5, 0.5], direction_eng: [0, 0, -1], falloff_ft: 0.1 };
  clearMetric(L);
  for (const k of ['position_ft', 'target_ft', 'direction_ft', 'position_eng', 'direction_eng', 'falloff_ft']) assert.equal(k in L, false);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npm run test:unit` — Expected: FAIL, module not found.

- [ ] **Step 3: Implement `light-metric.js`**

```js
import {
  solveCamera, worldToEngine, engineToWorld, engineDirToWorld, worldDirToEngine, falloffToMetric,
} from './calibration.js';

const EPS = 1e-9;
const norm = (v) => { const n = Math.hypot(...v) || 1; return v.map((c) => c / n); };

export function solveRecord(record, aspect) {
  return { ...record, camera: solveCamera(record, aspect) };
}

function fitOf(record) { return record.depth_fit || null; }

export function syncLightFromFeet(L, record) {
  const cam = record.camera, fit = fitOf(record);
  if (L.target_ft) {
    const d = [0, 1, 2].map((i) => L.target_ft[i] - L.position_ft[i]);
    L.direction_ft = Math.hypot(...d) > EPS ? norm(d) : engineDirToWorld(L.direction);
  } else if (!L.direction_ft) {
    L.direction_ft = norm(engineDirToWorld(L.direction));
  }
  L.direction_eng = worldDirToEngine(L.direction_ft);
  L.falloff_ft = falloffToMetric(L.falloff ?? 1, record);
  L.position_eng = fit ? worldToEngine(L.position_ft, cam, fit) : null;
  if (L.position_eng) L.position = L.position_eng.slice();
  if (L.target_ft && fit) {
    const t = worldToEngine(L.target_ft, cam, fit);
    if (t) L.target = t;
  }
  if (L.position_eng || L.target) L.direction = L.direction_eng.slice();
  return L;
}

export function syncLightFromEngine(L, record) {
  const cam = record.camera, fit = fitOf(record);
  if (!fit) return L;
  L.position_ft = engineToWorld(L.position, cam, fit);
  if (Array.isArray(L.target)) L.target_ft = engineToWorld(L.target, cam, fit);
  else delete L.target_ft;
  delete L.direction_ft;
  return syncLightFromFeet(L, record);
}

export function migrateLightsToFeet(lights, record) {
  for (const L of lights) {
    if (L.type === 'reflector') continue;
    if (!L.position_ft) syncLightFromEngine(L, record);
    else syncLightFromFeet(L, record);
  }
}

export function clearMetric(L) {
  for (const k of ['position_ft', 'target_ft', 'direction_ft', 'position_eng', 'direction_eng', 'falloff_ft']) delete L[k];
}
```

- [ ] **Step 4: Wire `main.js` and `lights.js`**

- `lights.js newState`: add `calibration: null,` and `units: 'ft',`.
- `serializeSceneState`: add `calibration: state.calibration ? stripCamera(state.calibration) : null` where `stripCamera` returns the record without `camera` (it is re-solved on load).
- `applyScene(scene)`: after `state.width/height` are known, `state.calibration = scene.state.calibration ? solveRecord(scene.state.calibration, state.height / state.width) : null;` then, after `for (const L of state.lights) applyTargeting(L);`, add `if (state.calibration) migrateLightsToFeet(state.lights, state.calibration);`.
- New function:
```js
function applyCalibration(record) {
  state.calibration = record ? solveRecord(record, state.height / state.width) : null;
  if (state.calibration) migrateLightsToFeet(state.lights, state.calibration);
  else for (const L of state.lights) clearMetric(L);
  document.dispatchEvent(new CustomEvent('relight:calibration', { detail: state.calibration }));
  redrawAndSave();
}
window.__applyCalibration = () => applyCalibration(state.calibration);
window.__syncMetricLights = () => { if (state.calibration) migrateLightsToFeet(state.lights, state.calibration); };
window.__redraw = () => redraw();
```
- `onUpdateLight` (3D gizmo drags arrive in engine space today): after `applyTargeting(L)`, add `if (state.calibration) syncLightFromEngine(L, state.calibration);`. Task 11 changes the 3D side to send `position_ft` patches; support both: `if (patch.position_ft) { L.position_ft = patch.position_ft; if ('target_ft' in patch) L.target_ft = patch.target_ft; syncLightFromFeet(L, state.calibration); } else if (state.calibration) syncLightFromEngine(L, state.calibration);`.
- 2D handle drags and click-placement call `onChange`-style paths in `handles.js`/`placement`; in `main.js` wrap the existing redraw callback passed to `mountHandles` and the placement `onPlaced` so they call `syncLightFromEngine(L, state.calibration)` for the affected light when calibrated (grep for `mountHandles(` and the placement `onPlace`/`accept` callback names in main.js and add the call there).
- Where the 2D pane submits lights to the server (`export-btn`, `export-layers-btn`, polish), add `calibration: state.calibration ? stripCamera(state.calibration) : null` to the body.
- `targeting.js applyTargeting`: after the existing line add
```js
  if (light.position_ft && light.target_ft) {
    const d = [0, 1, 2].map((i) => light.target_ft[i] - light.position_ft[i]);
    const n = Math.hypot(...d);
    if (n > EPS) light.direction_ft = d.map((c) => c / n);
  }
```

- [ ] **Step 5: Un-fixme the calibrated parity test and run everything**

Run: `npm run test:unit` — Expected: all pass.
Run: `npx playwright test --config=web/tests/playwright.config.js --reporter=list` — Expected: smoke + both parity tests pass. If the calibrated parity exceeds tolerance, compare the Python and GLSL formulas line by line before touching either; the most likely divergence is the `v * aspect` term or the normal flip.

- [ ] **Step 6: Commit**

```bash
git add web/src/metric/light-metric.js web/tests/unit/metric/light-metric.test.js web/src/lights.js web/src/targeting.js web/src/main.js web/tests/parity.spec.js
git commit -m "feat(web): lights carry feet positions; calibration persists with the scene; metric parity passes"
```

---

### Task 9: Props-pane fields, unit toggle, header badge

**Files:**
- Modify: `web/src/controls.js:212-300` (`renderLightProps`)
- Modify: `web/playground.html:33-37` (header: add unit toggle and Calibrate button/badge next to the view-mode control)
- Modify: `web/playground.css` (`.unit-toggle` reuses `.view-mode` styling; `.calib-badge`)
- Modify: `web/src/main.js` (unit toggle wiring, badge text)

**Interfaces:**
- Header: `<div class="view-mode" id="unit-toggle" role="group" aria-label="Units"><button data-unit="ft" aria-pressed="true">ft</button><button data-unit="m" aria-pressed="false">m</button></div>` and `<button id="calibrate-btn" type="button">Calibrate</button>`.
- `state.units` persisted under `localStorage['photo-relight:units']`; changing it dispatches `relight:units` and re-renders props.
- `renderLightProps` shows, when `state.calibration && L.position_ft`, a "Position (ft|m)" block with three number inputs `.pos-x`, `.pos-y`, `.pos-z` labeled "Stage L/R", "Height", "Upstage", and when `L.target_ft` a "Target" block `.tgt-x/.tgt-y/.tgt-z`. On change: parse via `parseLength`, write `position_ft`/`target_ft`, call `syncLightFromFeet(L, state.calibration)`, `applyTargeting(L)`, `redraw()`. Values display via `toDisplay(ft, state.units).toFixed(1)`.

- [ ] **Step 1: Add markup and CSS**

In `playground.html` after the `#view-mode` div add the unit toggle and the Calibrate button. In `playground.css` add `.calib-badge { font-size: 12px; padding: 4px 8px; }` and reuse `.view-mode` for `#unit-toggle`.

- [ ] **Step 2: Wire the unit toggle in `main.js`**

```js
const unitToggle = document.getElementById('unit-toggle');
try { state.units = localStorage.getItem('photo-relight:units') === 'm' ? 'm' : 'ft'; } catch {}
function applyUnits(u) {
  state.units = u;
  try { localStorage.setItem('photo-relight:units', u); } catch {}
  for (const b of unitToggle.querySelectorAll('[data-unit]')) b.setAttribute('aria-pressed', b.dataset.unit === u ? 'true' : 'false');
  document.dispatchEvent(new CustomEvent('relight:units', { detail: u }));
  renderPropsPane();   // whatever main.js already calls to re-render #props-content
}
unitToggle.addEventListener('click', (e) => { const b = e.target.closest('[data-unit]'); if (b) applyUnits(b.dataset.unit); });
applyUnits(state.units);
```
Badge: on `relight:calibration`, set `#calibrate-btn` text to `${w} × ${h} × ${d} ${unit}` using `toDisplay` (one decimal, trailing `.0` trimmed) or `Calibrate` when null.

- [ ] **Step 3: Props fields in `controls.js`**

Inside `renderLightProps`, after the existing Position Z slider markup, add:
```js
  const metric = state.calibration && L.position_ft;
  const posBlock = metric ? `
    <fieldset class="metric-pos"><legend>Position (${state.units})</legend>
      <label>Stage L/R <input class="pos-x" type="number" step="0.1" /></label>
      <label>Height <input class="pos-y" type="number" step="0.1" /></label>
      <label>Upstage <input class="pos-z" type="number" step="0.1" /></label>
    </fieldset>
    ${L.target_ft ? `<fieldset class="metric-tgt"><legend>Target (${state.units})</legend>
      <label>Stage L/R <input class="tgt-x" type="number" step="0.1" /></label>
      <label>Height <input class="tgt-y" type="number" step="0.1" /></label>
      <label>Upstage <input class="tgt-z" type="number" step="0.1" /></label>
    </fieldset>` : ''}` : '';
```
(`renderLightProps` receives `L` and `redraw` today; pass `state` in from `renderProps`, which already has it.) Fill values with `toDisplay(L.position_ft[i], state.units).toFixed(1)`, and bind `change` on each input:
```js
  const bindFt = (sel, arrKey, i) => $(sel)?.addEventListener('change', (e) => {
    const ft = parseLength(e.target.value, state.units);
    if (ft == null) return;
    L[arrKey][i] = ft;
    syncLightFromFeet(L, state.calibration);
    applyTargeting(L);
    redraw();
  });
  ['x','y','z'].forEach((ax, i) => { bindFt(`.pos-${ax}`, 'position_ft', i); bindFt(`.tgt-${ax}`, 'target_ft', i); });
```
Hide the engine-space Position Z slider when `metric` is true.

- [ ] **Step 4: Verify**

Run `npm run test:unit` (no change expected) and the smoke spec. Manual: start the :8765 server, open a scene, confirm the unit toggle flips labels and persists across reload, and that typing a Height value moves the light in both panes (calibration itself arrives in Task 10; for this task, set `window.__state.calibration` from the console using the synthetic record via `window.__applyCalibration()` after assigning it).

- [ ] **Step 5: Commit**

```bash
git add web/playground.html web/playground.css web/src/main.js web/src/controls.js
git commit -m "feat(web): feet/meters toggle, calibrate badge, and metric position fields in the props pane"
```

---

### Task 10: Calibration panel and five-click marking

**Files:**
- Create: `web/src/metric/marking.js`, `web/src/metric/calibration-panel.js`
- Test: `web/tests/unit/metric/marking.test.js`
- Modify: `web/playground.html` (panel markup inside `#stage2d-wrap`, after `#canvas-wrap`: `<div id="calib-panel" hidden></div><div id="calib-overlay" hidden></div>`), `web/playground.css`, `web/src/main.js` (open panel, apply)

**Interfaces:**
- `marking.js`: `MARK_ORDER = ['lipL','lipR','top','backL','backR']`, `MARK_LABELS = { lipL: 'Click the LEFT end of the stage lip', ... }`, `createMarking(initial = {})` → `{ next(u, v), undo(), cancel(), get marks(), get current(), get done() }`. `next` assigns the next unassigned key in order; when all five are set `done` is true and `current` is null; `undo` clears the most recently set key; `cancel` restores `initial`.
- `calibration-panel.js`: `mountCalibrationPanel({ panelEl, overlayEl, canvasWrapEl, getState, sampleDepth, onApply, onClear })`. `open()` shows the form prefilled from `state.calibration`; "Mark on photo" enters marking (overlay captures clicks; each click converts to `(u, v)` via the overlay rect, like `placement-pane-2d.js`); Esc/undo per spec; markers are absolutely positioned divs draggable with pointer events that update the mark. "Apply" runs `validateMarks`, `solveCamera`, `fitDepth(record, cam, sampleDepth)`; on success calls `onApply(record)`; on failure lists errors. "Clear calibration" calls `onClear()`. Shows `height_check_pct > 10` and `depth_fit === null` warnings inline.
- `main.js`: `mountCalibrationPanel({... sampleDepth: (u, v) => depthSampler?.sample(u, v) ?? NaN, onApply: applyCalibration, onClear: () => applyCalibration(null) })`; `#calibrate-btn` click → `open()`.

- [ ] **Step 1: Write the marking test**

`web/tests/unit/metric/marking.test.js`:
```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMarking, MARK_ORDER, MARK_LABELS } from '../../../src/metric/marking.js';

test('marks are assigned in order and done after five', () => {
  const m = createMarking();
  assert.equal(m.current, 'lipL');
  m.next(0.1, 0.6); m.next(0.9, 0.6); m.next(0.5, 0.1); m.next(0.2, 0.5);
  assert.equal(m.current, 'backR'); assert.equal(m.done, false);
  m.next(0.8, 0.5);
  assert.equal(m.done, true); assert.equal(m.current, null);
  assert.deepEqual(Object.keys(m.marks), MARK_ORDER);
});

test('undo removes the last mark and reopens it', () => {
  const m = createMarking();
  m.next(0.1, 0.6); m.next(0.9, 0.6);
  m.undo();
  assert.equal(m.current, 'lipR'); assert.equal('lipR' in m.marks, false);
  m.undo(); m.undo();               // extra undo is a no-op
  assert.equal(m.current, 'lipL');
});

test('cancel restores the initial marks', () => {
  const init = { lipL: [0.1, 0.6] };
  const m = createMarking(init);
  m.next(0.9, 0.6);
  m.cancel();
  assert.deepEqual(m.marks, init);
  assert.equal(m.current, 'lipR');
});

test('every key has a label', () => {
  for (const k of MARK_ORDER) assert.equal(typeof MARK_LABELS[k], 'string');
});
```

- [ ] **Step 2: Run to verify failure** — `npm run test:unit` → module not found.

- [ ] **Step 3: Implement `marking.js`**

```js
export const MARK_ORDER = ['lipL', 'lipR', 'top', 'backL', 'backR'];
export const MARK_LABELS = {
  lipL: 'Click the LEFT end of the stage lip (at the deck)',
  lipR: 'Click the RIGHT end of the stage lip (at the deck)',
  top: 'Click the TOP of the proscenium opening',
  backL: 'Click the LEFT end of the upstage edge (at the deck)',
  backR: 'Click the RIGHT end of the upstage edge (at the deck)',
};

export function createMarking(initial = {}) {
  const start = JSON.parse(JSON.stringify(initial));
  let marks = JSON.parse(JSON.stringify(initial));
  const history = [];
  const current = () => MARK_ORDER.find((k) => !(k in marks)) ?? null;
  return {
    next(u, v) { const k = current(); if (!k) return null; marks[k] = [u, v]; history.push(k); return k; },
    undo() { const k = history.pop(); if (k) delete marks[k]; },
    cancel() { marks = JSON.parse(JSON.stringify(start)); history.length = 0; },
    get marks() { return marks; },
    get current() { return current(); },
    get done() { return current() === null; },
  };
}
```

- [ ] **Step 4: Implement the panel**

`calibration-panel.js` renders this form into `panelEl`:
```html
<h3>Stage calibration</h3>
<label>Width <input class="cal-w" type="number" step="0.1" min="0" /></label>
<label>Height <input class="cal-h" type="number" step="0.1" min="0" /></label>
<label>Depth <input class="cal-d" type="number" step="0.1" min="0" /></label>
<div class="view-mode cal-units"><button data-unit="ft" aria-pressed="true">ft</button><button data-unit="m">m</button></div>
<button class="cal-mark">Mark on photo</button>
<div class="cal-prompt" hidden></div>
<ul class="cal-errors"></ul>
<div class="cal-warn" hidden></div>
<div class="cal-actions"><button class="cal-apply">Apply</button><button class="cal-clear">Clear calibration</button><button class="cal-close">Close</button></div>
```
Marking mode: `overlayEl.hidden = false`, overlay sized to `canvasWrapEl` (`position:absolute; inset:0`), pointerdown on the overlay converts `(clientX − rect.left)/rect.width` to `u` and likewise `v`, calls `marking.next(u, v)`, adds a `<div class="cal-marker" data-key>` at that position with the key's short name; keydown `Escape` → `marking.cancel()` and exit; `Backspace` → `marking.undo()` and remove the marker. Markers get pointer-capture drag that updates `marking.marks[key]`. Prompt text = `MARK_LABELS[marking.current]` until done, then "All five marks set. Adjust by dragging, then Apply."
Apply:
```js
const rec = { version: 1, units, width_ft: fromDisplay(w, units), height_ft: fromDisplay(h, units), depth_ft: fromDisplay(d, units), marks: { ...marking.marks }, depth_fit: null, depth_check: null };
const v = validateMarks(rec); if (!v.ok) return showErrors(v.errors);
const { width, height } = getState();
const cam = solveCamera(rec, height / width);
rec.depth_fit = fitDepth(rec, cam, sampleDepth);
const warns = [];
if (cam.height_check_pct > 10) warns.push(`Photo implies an opening height ${cam.height_check_pct.toFixed(0)}% different from what you entered; check the top mark.`);
if (cam.perspective_ratio > 0.9) warns.push('Stage depth is small relative to the camera distance, so upstage distances are sensitive to the back-line marks. Place them carefully.');
if (!rec.depth_fit) warns.push('Depth map has no usable relief between lip and back line; upstage distances fall back to a linear estimate.');
showWarnings(warns);
onApply(rec);
```
CSS: `#calib-panel { position:absolute; top:12px; left:12px; z-index:6; background: rgba(0,0,0,.8); color:#ddd; padding:10px; border-radius:6px; width: 260px; font-size:12px; }`, `#calib-overlay { position:absolute; inset:0; z-index:5; cursor:crosshair; }`, `.cal-marker { position:absolute; width:14px; height:14px; margin:-7px; border-radius:50%; background: var(--accent,#4a7); border:2px solid #fff; cursor:grab; }`, `.cal-marker::after { content: attr(data-key); position:absolute; top:14px; left:8px; white-space:nowrap; }`.

- [ ] **Step 5: Wire and verify**

Mount in `main.js` as in Interfaces. Run `npm run test:unit` (marking tests pass) and the smoke spec. Manual real-input check on :8765 with the Leica scene: enter 40/20/30, mark five points with real clicks, Backspace undo, drag a marker, Apply; badge appears; props pane shows feet fields; reload restores the badge; Clear calibration restores today's controls. Record the per-step outcome in the task summary.

- [ ] **Step 6: Commit**

```bash
git add web/src/metric/marking.js web/src/metric/calibration-panel.js web/tests/unit/metric/marking.test.js web/playground.html web/playground.css web/src/main.js
git commit -m "feat(web): calibration panel with five-click stage marking"
```

---

### Task 11: 3D viewport — stage in feet, grid, fixture markers, framing

**Files:**
- Create: `web/src/3d/stage.js`
- Modify: `web/src/3d/point-cloud.js:65-100` (`buildPointCloud` gains `calibration`), `web/src/3d/index.js:189-215` (`loadScene3D`) and `:164` (`syncLightsToScene`), `web/src/3d/light-primitives.js:20-30,85,106,159` (position source), `web/src/3d/scene.js:21-35` (far plane, `resetCamera` framing), `web/src/3d/gizmos.js` (handle size vs distance), `web/src/3d/coords.js` (add `worldFtToThree`/`threeToWorldFt`)

**Interfaces:**
- Three.js frame for calibrated scenes = world feet with **Z negated** so the existing camera at negative Three-z still looks from the house toward the stage: `worldFtToThree([X,Y,Z]) → [X, Y, −Z]`, inverse identical. Uncalibrated scenes keep `pixelToWorld`/`lightToWorld`.
- `buildPointCloud({ ..., calibration })`: when present, per pixel `zCam = depthToZcam(d, fit)` (or linear fallback) and `[X,Y,Z] = pixelToWorld(u, v, zCam, camera)` → Three position `[X, Y, −Z]`. `u_size` uniform default scales by `calibration.width_ft / 2` so points keep a similar screen size.
- `stage.js`: `buildStage(calibration, units) → THREE.Group` with a `GridHelper`-style grid on the deck (1 ft minor / 5 ft major; 1 m / 5 m for meters), spanning X in `[−0.75·W, 0.75·W]` and Three-z from `+2·D` (house, since Three-z = −Z) to `−D` (back line); plaster line and centerline as brighter `Line`s; `buildFixtureMarker(light) → THREE.Group` (capped cylinder 1.2 ft long, 0.5 ft radius, oriented along `direction_ft`). `updateStageUnits(group, units)` swaps grid spacing.
- `light-primitives.js`: position from `worldFtToThree(light.position_ft)` when the light has `position_ft` and a calibration is active, else `lightToWorld(light.position)`. Same for target viz. Gizmo drags in calibrated mode emit `{ position_ft, target_ft }` patches (`threeToWorldFt`), which `onUpdateLight` (Task 8) accepts.
- `scene.js`: far plane 5000; `resetCamera(bounds)` frames `bounds` (a `THREE.Box3` of stage + lights) when given, else today's behavior.
- `gizmos.js`: handle scale = `max(1, cameraDistance / 8)` for calibrated scenes.

Run first: `impact` on `buildPointCloud`, `loadScene3D`, `syncLightsToScene`, `buildLightPrimitive`, `createScene3D`; report.

- [ ] **Step 1: coords helpers + point cloud**

Add to `coords.js`:
```js
export function worldFtToThree([X, Y, Z]) { return [X, Y, -Z]; }
export function threeToWorldFt([x, y, z]) { return [x, y, -z]; }
```
In `buildPointCloud`, accept `calibration` and branch the per-pixel position:
```js
      let x, y, z;
      if (calibration) {
        const fit = calibration.depth_fit;
        const zc = fit ? depthToZcam(d, fit) : calibration.camera.dist_ft + d * calibration.depth_ft;
        const [X, Y, Z] = pixelToWorldFt(c / (W - 1), r / (H - 1), zc, calibration.camera);
        [x, y, z] = worldFtToThree([X, Y, Z]);
      } else {
        [x, y, z] = pixelToWorld(c, r, d, W, H, zScale);
      }
```
(import `depthToZcam` and `pixelToWorld as pixelToWorldFt` from `../metric/calibration.js`).

- [ ] **Step 2: `stage.js`**

```js
import * as THREE from 'three';

function gridLines(halfX, zFrom, zTo, step, color, opacity) {
  const pts = [];
  for (let x = -halfX; x <= halfX + 1e-6; x += step) pts.push(x, 0, zFrom, x, 0, zTo);
  for (let z = zTo; z <= zFrom + 1e-6; z += step) pts.push(-halfX, 0, z, halfX, 0, z);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
  return new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color, transparent: true, opacity }));
}

export function buildStage(cal, units = 'ft') {
  const group = new THREE.Group(); group.name = 'stage';
  const W = cal.width_ft, D = cal.depth_ft;
  const minor = units === 'm' ? 3.280839895 : 1, major = minor * 5;
  const halfX = Math.ceil(0.75 * W / major) * major;
  const zFrom = Math.ceil(2 * D / major) * major;   // into the house (+Three z)
  const zTo = -Math.ceil(D / major) * major;        // back line (−Three z)
  group.add(gridLines(halfX, zFrom, zTo, minor, 0x335533, 0.25));
  group.add(gridLines(halfX, zFrom, zTo, major, 0x55aa55, 0.5));
  const line = (a, b, color) => {
    const g = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(...a), new THREE.Vector3(...b)]);
    return new THREE.Line(g, new THREE.LineBasicMaterial({ color }));
  };
  group.add(line([-W / 2, 0, 0], [W / 2, 0, 0], 0xffcc00));       // plaster line (lip)
  group.add(line([0, 0, zFrom], [0, 0, zTo], 0x00ccff));          // centerline
  group.add(line([-W / 2, 0, -D], [W / 2, 0, -D], 0xffcc00));     // back line
  group.userData.units = units;
  return group;
}

export function updateStageUnits(scene, cal, units) {
  const old = scene.getObjectByName('stage');
  if (old) scene.remove(old);
  scene.add(buildStage(cal, units));
}

export function buildFixtureMarker() {
  const g = new THREE.Group();
  const body = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.5, 1.2, 12),
    new THREE.MeshBasicMaterial({ color: 0xdddddd }));
  body.rotation.x = Math.PI / 2;      // cylinder axis along +z; orient with lookAt at use site
  g.add(body);
  return g;
}
```

- [ ] **Step 3: Wire `index.js`, `light-primitives.js`, `scene.js`, `gizmos.js`**

- `loadScene3D({ assetUrls, calibration, units })`: pass `calibration` to `buildPointCloud`; if calibrated `api.scene.add(buildStage(calibration, units))`; compute `bounds = new THREE.Box3().setFromObject(currentPointCloud.points)` and expand by each light's `worldFtToThree(position_ft)`; call `api.resetCamera(bounds)`. Listen for `relight:calibration` (rebuild via `loadScene3D`) and `relight:units` (`updateStageUnits`) in `main.js`, calling into `index.js` exports `setCalibration3D(cal, units)` / `setUnits3D(units)`.
- `light-primitives.js`: replace each `lightToWorld(light.position)` with a helper `lightPos(light)` = `light.position_ft && buildLightPrimitive.metric ? worldFtToThree(light.position_ft) : lightToWorld(light.position)`; set `buildLightPrimitive.metric = !!calibration` from `setCalibration3D`. When metric and the light is outside the point cloud bounds, add `buildFixtureMarker()` to the group and hide the sphere. Scale the existing sphere/hit geometry by `calibration.width_ft / 2` in metric mode so it stays visible.
- `scene.js`: `PerspectiveCamera(..., near 0.01, far 5000)`; `resetCamera(bounds)`: if bounds, `center = bounds.getCenter()`, `radius = bounds.getSize().length() / 2`, place the camera at `center + (0, radius * 0.6, radius * 1.8)` (house side, +z) looking at center, `controls.target.copy(center)`.
- `gizmos.js`: where handle meshes are created or updated per frame, multiply their scale by `Math.max(1, camera.position.distanceTo(target) / 8)` when metric; in the drag callback, when metric, convert the dragged Three position with `threeToWorldFt` and call `onUpdateLight(id, { position_ft })` (and `target_ft` for target drags via `target-viz.js`).

- [ ] **Step 4: Verify**

Smoke spec passes. Manual real-input on :8765: calibrate the Leica scene (use plausible marks), confirm the deck grid appears with the yellow lip line under the photo's stage edge, the home view frames the grid, typing a light Upstage −60 / Height 20 puts a fixture marker out in the house with a beam cone to its target, gizmo drag of that fixture updates the props fields, and `Clear calibration` restores the old view. Toggle units and see grid spacing change.

- [ ] **Step 5: Commit**

```bash
git add web/src/3d/stage.js web/src/3d/coords.js web/src/3d/point-cloud.js web/src/3d/index.js web/src/3d/light-primitives.js web/src/3d/scene.js web/src/3d/gizmos.js web/src/main.js
git commit -m "feat(3d): calibrated stage in feet — deck grid, fixture markers, framing, metric gizmo drags"
```

---

### Task 12: 2D edge arrows for off-frame lights

**Files:**
- Modify: `web/src/handles.js:60-125` (layout of handles), `web/playground.css`

**Interfaces:**
- In `mountHandles` layout: for each light with `state.calibration` and `position_eng === null` or `position` outside `[0,1]²`, render `<div class="edge-arrow" data-id>` clamped to the nearest canvas edge, rotated toward the light's projected direction. Direction for a light behind the camera: use `worldToPixel` on the point `position_ft + 0.5·direction_ft·dist_ft` (a point in front of the camera along the beam); if still null, place the arrow at the bottom-center (front-of-house). Arrow is clickable (selects the light) and never draggable.
- The position handle for such a light is hidden.

Run first: `impact({target: "mountHandles", direction: "upstream"})`.

- [ ] **Step 1: Implement**

In the handle layout loop, replace the unconditional `els[i].style.left = ...` with:
```js
      const off = state.calibration && (!L.position_eng || L.position[0] < 0 || L.position[0] > 1 || L.position[1] < 0 || L.position[1] > 1);
      els[i].hidden = !!off;
      let arrow = arrows.get(L.id);
      if (off) {
        if (!arrow) { arrow = document.createElement('div'); arrow.className = 'edge-arrow'; arrow.dataset.id = L.id; arrow.textContent = '➤'; arrow.title = L.name || 'Light'; arrow.addEventListener('click', () => onSelect(L.id)); root.appendChild(arrow); arrows.set(L.id, arrow); }
        const { x, y, angle } = edgePlacement(L, state.calibration, r);
        arrow.style.left = `${x}px`; arrow.style.top = `${y}px`; arrow.style.transform = `translate(-50%,-50%) rotate(${angle}rad)`;
        arrow.classList.toggle('is-selected', L.id === state.selectedId);
      } else if (arrow) { arrow.remove(); arrows.delete(L.id); }
```
with
```js
function edgePlacement(L, cal, r) {
  let p = worldToPixel(L.position_ft, cal.camera);
  if (!p) {
    const ahead = [0, 1, 2].map((i) => L.position_ft[i] + (L.direction_ft?.[i] ?? 0) * 0.5 * cal.camera.dist_ft);
    p = worldToPixel(ahead, cal.camera) || [0.5, 1.5, 1];
  }
  const cx = 0.5, cy = 0.5, dx = p[0] - cx, dy = p[1] - cy;
  const s = 0.48 / Math.max(Math.abs(dx), Math.abs(dy), 1e-6);
  return { x: (cx + dx * s) * r.width, y: (cy + dy * s) * r.height, angle: Math.atan2(dy, dx) };
}
```
CSS: `.edge-arrow { position:absolute; pointer-events:auto; color: var(--accent,#4a7); font-size: 18px; cursor: pointer; text-shadow: 0 0 3px #000; } .edge-arrow.is-selected { color: #fff; }`. Remove arrows in the existing teardown path.

- [ ] **Step 2: Verify**

Smoke spec; manual: set a light to Upstage −60 and see the arrow at the bottom edge of the photo, click it to select the light, move the light in-frame and see the handle return.

- [ ] **Step 3: Commit**

```bash
git add web/src/handles.js web/playground.css
git commit -m "feat(web): edge arrows for calibrated lights outside the photo frame"
```

---

### Task 13: Metric depth cross-check endpoint and warning

**Files:**
- Create: `packages/relighting_engine/relighting_engine/depth/metric_check.py`
- Modify: `packages/relighting_api/relighting_api/routes/scenes.py` (new route), `web/src/metric/calibration-panel.js` (async warning), `web/src/api.js` (client call)
- Test: `packages/relighting_api/tests/api/test_calibration_check.py`

**Interfaces:**
- `metric_check.available() → bool` (checkpoint `depth_anything_v2_metric_hypersim_vitb` present under the engine's model dir; reuse the loader pattern in `depth/depth_anything.py`); `metric_check.compare(prepared, calibration) → { median_error_pct: float, samples: list[{u, v, z_fit, z_model}] }` sampling a 3×3 grid over the deck region bounded by the marks; when unavailable returns `None`.
- Route `POST /scenes/{scene_id}/calibration/check` body `{ calibration: CalibrationModel }` → `{ available: bool, median_error_pct: float|null }`. Uses the scene's session `prepared` image. Never raises for a missing checkpoint.
- Client: `checkCalibration(sceneId, record) → Promise<{available, median_error_pct}>` in `api.js`. The panel, after `onApply`, fires it and, when `available && median_error_pct > 20`, shows the warning "Metric depth model disagrees with your marks by N%; recheck the lip and back-line marks." and sets `record.depth_check = { median_error_pct, warned: true }` (then saves). 30 s timeout via `AbortSignal.timeout(30000)`; any failure is silent.

- [ ] **Step 1: Write the failing API test**

```python
from __future__ import annotations

from fastapi.testclient import TestClient

from relighting_api.main import create_app

MARKS = {"lipL": [0.1, 0.61], "lipR": [0.9, 0.61], "top": [0.5, 0.08], "backL": [0.23, 0.54], "backR": [0.77, 0.54]}


def test_check_reports_unavailable_when_model_missing(monkeypatch):
    from relighting_engine.depth import metric_check
    monkeypatch.setattr(metric_check, "available", lambda: False)
    client = TestClient(create_app(skip_engine=True))
    r = client.post("/scenes/does-not-matter/calibration/check",
                    json={"calibration": {"width_ft": 40, "height_ft": 20, "depth_ft": 30, "marks": MARKS}})
    assert r.status_code == 200
    assert r.json() == {"available": False, "median_error_pct": None}
```

- [ ] **Step 2: Run to verify failure** — 404 (route missing) or ImportError.

- [ ] **Step 3: Implement**

`metric_check.py`:
```python
"""Optional cross-check of a calibration against a metric depth model."""
from __future__ import annotations

from pathlib import Path

import numpy as np

from relighting_engine.metric.calibration import Calibration, depth_to_zcam

_CKPT = "depth_anything_v2_metric_hypersim_vitb.pth"


def _ckpt_path() -> Path:
    from relighting_engine.depth.depth_anything import MODEL_DIR   # same dir the relative model uses
    return Path(MODEL_DIR) / _CKPT


def available() -> bool:
    return _ckpt_path().exists()


def compare(prepared, cal: Calibration, marks: dict) -> dict | None:
    if not available() or cal.fit is None:
        return None
    from relighting_engine.depth.depth_anything import run_metric   # loads the metric checkpoint; returns (H, W) meters
    z_model_m = run_metric(prepared.original, _ckpt_path())
    h, w = prepared.depth.shape
    u_l, u_r = marks["lipL"][0], marks["lipR"][0]
    v_top, v_bot = (marks["backL"][1] + marks["backR"][1]) / 2, (marks["lipL"][1] + marks["lipR"][1]) / 2
    samples, errs = [], []
    for i in range(3):
        for j in range(3):
            u = u_l + (u_r - u_l) * (i + 0.5) / 3
            v = v_top + (v_bot - v_top) * (j + 0.5) / 3
            c, r = int(u * (w - 1)), int(v * (h - 1))
            z_fit = float(depth_to_zcam(prepared.depth[r, c], cal.fit))
            z_mod = float(z_model_m[r, c]) * 3.280839895
            samples.append({"u": u, "v": v, "z_fit": z_fit, "z_model": z_mod})
            errs.append(abs(z_mod - z_fit) / max(z_fit, 1e-6) * 100)
    return {"median_error_pct": float(np.median(errs)), "samples": samples}
```
If `depth_anything.py` has no `run_metric`, add one that mirrors its existing inference function but loads the metric checkpoint and returns meters without normalization (read the file first; keep the relative path untouched). Route in `scenes.py`:
```python
class CalibrationCheckRequest(BaseModel):
    calibration: CalibrationModel


@router.post("/scenes/{scene_id}/calibration/check")
async def check_calibration(scene_id: str, req: CalibrationCheckRequest, request: Request) -> dict[str, Any]:
    from relighting_engine.depth import metric_check
    if not metric_check.available():
        return {"available": False, "median_error_pct": None}
    scene = request.app.state.scenes.get(scene_id, workspace_id=_workspace(request))
    if not scene:
        raise HTTPException(404, "scene not found")
    prepared = request.app.state.sessions.get(scene["session_id"])
    cal = req.calibration.to_engine(prepared.height / prepared.width)
    result = metric_check.compare(prepared, cal, req.calibration.marks)
    return {"available": result is not None, "median_error_pct": result["median_error_pct"] if result else None}
```
`api.js`: `export async function checkCalibration(sceneId, calibration) { const r = await fetch(\`${BASE}/scenes/${sceneId}/calibration/check\`, { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ calibration }), signal: AbortSignal.timeout(30000) }); return r.json(); }` (match the existing fetch helper style in `api.js`). Panel: after `onApply(rec)`, `checkCalibration(getState().sceneId, rec).then(...)` per Interfaces, swallowing errors.

- [ ] **Step 4: Run tests and commit**

`.venv/Scripts/python -m pytest packages/relighting_api/tests -q` → all pass.
```bash
git add packages/relighting_engine/relighting_engine/depth/metric_check.py packages/relighting_engine/relighting_engine/depth/depth_anything.py packages/relighting_api/relighting_api/routes/scenes.py packages/relighting_api/tests/api/test_calibration_check.py web/src/api.js web/src/metric/calibration-panel.js
git commit -m "feat: optional metric-depth cross-check of stage calibration with a panel warning"
```

---

### Task 14: Calibrated smoke test and wrap-up

**Files:**
- Create: `web/tests/smoke-calibrated.spec.js`
- Modify: `docs/superpowers/specs/2026-09-01-stage-calibration-metric-lights-design.md` (Status → Implemented, note any deviations)

- [ ] **Step 1: Write the smoke test**

```js
import { test, expect } from '@playwright/test';
import path from 'node:path';

const FIXTURE = path.resolve('packages/relighting_engine/tests/fixtures/images/portrait_a.jpg');

test('calibrated scene shows badge, feet fields, and 3D stage grid without console errors', async ({ page }) => {
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto('http://localhost:8765/web/playground.html');
  await page.setInputFiles('#ns-file', FIXTURE);
  await page.waitForFunction(() => window.__state?.width > 0, { timeout: 60000 });
  await page.evaluate(() => {
    window.__state.calibration = { version: 1, units: 'ft', width_ft: 40, height_ft: 20, depth_ft: 30,
      marks: { lipL: [0.1, 0.61333], lipR: [0.9, 0.61333], top: [0.5, 0.08], backL: [0.23333, 0.54222], backR: [0.76667, 0.54222] },
      depth_fit: { a: -0.037037, b: 0.024074 }, depth_check: null };
    window.__applyCalibration();
  });
  await expect(page.locator('#calibrate-btn')).toHaveText(/40 × 20 × 30 ft/);
  await expect(page.locator('.metric-pos .pos-z')).toBeVisible();
  const hasStage = await page.evaluate(() => !!window.__scene3d?.getObjectByName('stage'));
  expect(hasStage).toBe(true);
  expect(errors, errors.join('\n')).toEqual([]);
});
```
(Task 11 exposes `window.__scene3d = api.scene` in `mount3D` for tests.)

- [ ] **Step 2: Run everything**

`npm run test:unit`; `npx playwright test --config=web/tests/playwright.config.js --reporter=list`; both pytest suites. Paste outputs in the task summary. Run `detect_changes({scope: "compare", base_ref: "main"})` and report affected processes.

- [ ] **Step 3: Update spec status and commit**

```bash
git add web/tests/smoke-calibrated.spec.js docs/superpowers/specs/2026-09-01-stage-calibration-metric-lights-design.md
git commit -m "test: calibrated playground smoke; mark calibration spec implemented"
```

---

## Self-review notes (done while writing)

- Spec coverage: calibration record/workflow (T2, T10), camera model and depth fit (T2, T3), world frame and unit toggle (T1, T9), shader/Python metric mode with engine-space shadow proxy and parity (T4, T5, T7, T8), API schema and persistence (T6, T8), props fields (T9), 3D grid/markers/framing/gizmo scale (T11), 2D edge arrows (T12), metric depth cross-check (T13), error handling (T2 validation, T10 warnings, T13 silent failure), tests (every task), implementation order (matches spec §Implementation order; the parity fix is folded into T7 as the spec requires).
- Deviations from spec to flag in the report: reflectors are left in engine space in metric mode (spec did not address them; documented in the panel as uncalibrated). Task 5's `Light.direction_ft` is derived server-side from `target_ft` when present, mirroring the web sync helper.
- Type consistency: `record.camera` (solved by `solveRecord`) is what the renderer, 3D, and handles read; `calibration.depth_fit` is `{a, b}` everywhere; Python `Calibration.fit` is the `DepthFit` dataclass; feet fields are `position_ft`, `target_ft`, `direction_ft`; engine proxies are `position_eng`, `direction_eng`; metric falloff is `falloff_ft`.
