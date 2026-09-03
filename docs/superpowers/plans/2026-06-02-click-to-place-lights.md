# Click-to-Place Lights Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Create a light by clicking in the scene — for directional/spotlight, click 1 places the light and click 2 places its aim target (auto-targeting); works in both the 2D photo pane and 3D viewport, with depth sampled from the scene's depth map.

**Architecture:** A DOM-free placement state machine (`placement.js`) owns the lifecycle; both panes feed it a single primitive — an engine-space surface point `[x,y,z]`. The 2D pane samples the depth PNG (`depth-sampler.js`) and maps a click directly to engine coords `[u, v, 1−depth]`; the 3D pane raycasts the point cloud (plane fallback) and converts the world hit via `worldToLight`. Builds on the existing light-targeting feature (`applyTargeting`).

**Tech Stack:** Vanilla ES modules + three.js (web). Pure logic (`depth-sampler`, `placement`, coords helper) tested with Node's built-in `node:test`; pane adapters verified by manual smoke + a module-load smoke.

**Spec:** `docs/superpowers/specs/2026-06-02-click-to-place-lights-design.md`

---

## Key facts (verified against the codebase)

- **Engine point from a 2D click is `[u, v, 1 − depth]`.** Engine `position[0]/[1]` are the normalized image coords (same space the 2D handles use: `handles.js` does `position[0] * rect.width`). And `worldToLight(uvDepthToWorld(...))` reduces to engine `z = 1 − depth` independent of `Z_SCALE`. So no world round-trip is needed for 2D.
- **Camera-ward standoff = larger engine z.** Depth 0 (nearest) → engine z 1.0 (camera side); engine z>0 → world z<0 (toward the camera at world z=−3, per `coords.js`). So the light's standoff is `position.z = surface.z + LIGHT_STANDOFF`.
- **Depth is client-readable.** `point-cloud.js:loadImageData` already loads a PNG into ImageData; depth is the **red channel / 255** in `[0,1]`.
- **Add-light hook** is `onPickPreset` in `main.js:146-166` (build `L = lightFromPreset(preset)`, then `splice` at `pendingAddLight`).
- **3D selection raycast** lives in `3d/index.js:onCanvasClick` (90-107); the active camera is `api.getActiveCamera()`; the point cloud is `getPointCloud().points` (a `THREE.Points`).
- **`applyTargeting(light)`** (from `targeting.js`) sets `light.direction = normalize(target − position)` in place when `light.target` is set.

## File structure

| File | Change | Responsibility |
|---|---|---|
| `web/src/3d/coords.js` | Modify | Add `uvDepthToLight(u,v,depth)` → engine `[u, v, 1−depth]`. |
| `web/src/depth-sampler.js` | **Create** | `sampleDepthFromImageData(img,u,v)` (pure) + `createDepthSampler(depthUrl)` (async loader). |
| `web/src/placement.js` | **Create** | DOM-free placement state machine + `LIGHT_STANDOFF`. |
| `web/src/placement-pane-2d.js` | **Create** | 2D overlay adapter: click → engine point; move → tether preview. |
| `web/playground.html` | Modify | Add `#placement-overlay` element. |
| `web/playground.css` | Modify | Styles for the placement overlay + tether (reuse existing classes where possible). |
| `web/src/main.js` | Modify | Create controller + sampler; inject callbacks; branch `onPickPreset`; Esc cancel; phase → panes/status. |
| `web/src/3d/index.js` | Modify | 3D placement adapter (click raycast + move preview); wire `placement` into `mount3D`; `notifyPlacementPhase`. |
| `web/src/3d/target-viz.js` | Modify | Add `showPreview(fromEng,toEng,color)` / `clearPreview()` for the transient placement beam. |
| `web/tests/unit/depth-sampler.test.js` | **Create** | Unit tests for the pure sampler + coords helper. |
| `web/tests/unit/placement.test.js` | **Create** | Unit tests for the state machine. |

---

## Task 1: Pure surface-point math (coords helper + depth sampler)

**Files:**
- Modify: `web/src/3d/coords.js`
- Create: `web/src/depth-sampler.js`
- Create: `web/tests/unit/depth-sampler.test.js`

- [ ] **Step 1: Write the failing tests**

Create `web/tests/unit/depth-sampler.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { uvDepthToLight } from '../../src/3d/coords.js';
import { sampleDepthFromImageData } from '../../src/depth-sampler.js';

const close = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps;
const vclose = (a, b) => a.length === b.length && a.every((v, i) => close(v, b[i]));

test('uvDepthToLight: engine x=u, y=v, z=1-depth', () => {
  assert.ok(vclose(uvDepthToLight(0.25, 0.75, 0.0), [0.25, 0.75, 1.0]));
  assert.ok(vclose(uvDepthToLight(0.5, 0.5, 0.5), [0.5, 0.5, 0.5]));
  assert.ok(vclose(uvDepthToLight(0.1, 0.2, 1.0), [0.1, 0.2, 0.0]));
});

// Build a 2x2 RGBA ImageData-like object. Depth lives in the RED channel.
// Pixels (col,row): (0,0)=0, (1,0)=255, (0,1)=128, (1,1)=64  (red values)
function img2x2() {
  const data = new Uint8ClampedArray(2 * 2 * 4);
  const setR = (col, row, r) => { data[(row * 2 + col) * 4] = r; };
  setR(0, 0, 0); setR(1, 0, 255); setR(0, 1, 128); setR(1, 1, 64);
  return { width: 2, height: 2, data };
}

test('sampleDepthFromImageData: maps (u,v) to the right pixel red/255', () => {
  const im = img2x2();
  // u,v in the left/top cell → pixel (0,0) = 0
  assert.ok(close(sampleDepthFromImageData(im, 0.1, 0.1), 0 / 255));
  // right/top cell → pixel (1,0) = 255
  assert.ok(close(sampleDepthFromImageData(im, 0.9, 0.1), 255 / 255));
  // left/bottom → (0,1) = 128
  assert.ok(close(sampleDepthFromImageData(im, 0.1, 0.9), 128 / 255));
  // right/bottom → (1,1) = 64
  assert.ok(close(sampleDepthFromImageData(im, 0.9, 0.9), 64 / 255));
});

test('sampleDepthFromImageData: clamps out-of-range (u,v) into the image', () => {
  const im = img2x2();
  assert.ok(close(sampleDepthFromImageData(im, -5, -5), 0 / 255));   // clamps to (0,0)
  assert.ok(close(sampleDepthFromImageData(im, 5, 5), 64 / 255));    // clamps to (1,1)
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm run test:unit`
Expected: FAIL — `uvDepthToLight` / `sampleDepthFromImageData` not exported / module missing.

- [ ] **Step 3: Add `uvDepthToLight` to coords.js**

In `web/src/3d/coords.js`, add this export (near the other transforms):

```js
/**
 * A normalized 2D-photo click (u, v in [0,1]) plus a sampled depth (0..1) →
 * engine light-position coords [x, y, z].
 *
 * Engine x/y equal the normalized image coords (the same space the 2D handles
 * use). The engine z works out to exactly 1 - depth: worldToLight inverts the
 * (depth-0.5)*Z_SCALE mapping and the Z_SCALE cancels. depth 0 (nearest) → z 1.0
 * (camera side); depth 1 (farthest) → z 0.0.
 */
export function uvDepthToLight(u, v, depth) {
  return [u, v, 1 - depth];
}
```

- [ ] **Step 4: Create depth-sampler.js**

Create `web/src/depth-sampler.js`:

```js
// Reads per-pixel depth from the scene's depth PNG, entirely client-side.
//
// Depth is stored in the RED channel of the depth image (0..255 → 0..1), the
// same convention web/src/3d/point-cloud.js uses to build the point cloud.
// `createDepthSampler` loads the image once into an offscreen 2D canvas;
// `sample(u, v)` reads the depth at a normalized photo coordinate. Pane-
// independent — works whether or not the 3D viewport is mounted.

// Pure: sample an ImageData-like object ({ width, height, data: RGBA }) at a
// normalized (u, v). Clamps (u, v) into [0, 1] so a click is never out of range.
export function sampleDepthFromImageData(img, u, v) {
  const cu = Math.min(1, Math.max(0, u));
  const cv = Math.min(1, Math.max(0, v));
  const col = Math.min(img.width - 1, Math.floor(cu * img.width));
  const row = Math.min(img.height - 1, Math.floor(cv * img.height));
  const idx = (row * img.width + col) * 4;
  return img.data[idx] / 255;
}

async function loadImageData(url) {
  const image = new Image();
  image.crossOrigin = 'anonymous';
  await new Promise((resolve, reject) => {
    image.onload = resolve;
    image.onerror = reject;
    image.src = url;
  });
  const cv = document.createElement('canvas');
  cv.width = image.naturalWidth;
  cv.height = image.naturalHeight;
  const ctx = cv.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(image, 0, 0);
  return ctx.getImageData(0, 0, cv.width, cv.height);
}

// Create a sampler for a depth PNG URL. `sample(u, v)` returns the median
// fallback (0.5) until the image finishes loading, so callers never throw.
export function createDepthSampler(depthUrl, { fallback = 0.5 } = {}) {
  let imageData = null;
  const ready = loadImageData(depthUrl)
    .then((d) => { imageData = d; })
    .catch(() => { imageData = null; });

  return {
    ready,
    sample(u, v) {
      if (!imageData) return fallback;
      return sampleDepthFromImageData(imageData, u, v);
    },
  };
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm run test:unit`
Expected: PASS — all targeting + depth-sampler tests green. Paste the depth-sampler results.

- [ ] **Step 6: Commit**

```bash
git add web/src/3d/coords.js web/src/depth-sampler.js web/tests/unit/depth-sampler.test.js
git commit -m "feat(web): depth sampler + uvDepthToLight coords helper for click-to-place"
```

---

## Task 2: Placement state machine

**Files:**
- Create: `web/src/placement.js`
- Create: `web/tests/unit/placement.test.js`

- [ ] **Step 1: Write the failing tests**

Create `web/tests/unit/placement.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPlacement, LIGHT_STANDOFF } from '../../src/placement.js';

const close = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps;
const vclose = (a, b) => a.length === b.length && a.every((v, i) => close(v, b[i]));

// Build a controller with spy callbacks recording calls.
function makeCtl() {
  const calls = { commit: [], update: [], remove: [], phase: [] };
  const ctl = createPlacement({
    commitLight: (L, at) => calls.commit.push({ L, at }),
    updateLight: (L) => calls.update.push(L),
    removeLight: (L) => calls.remove.push(L),
    onPhaseChange: (p) => calls.phase.push(p),
  });
  return { ctl, calls };
}

function spotlight() {
  return { id: 's1', type: 'spotlight', position: [0, 0, 0], direction: [0, 0, -1], target: null };
}

test('spotlight: click 1 places light with camera-ward standoff and commits', () => {
  const { ctl, calls } = makeCtl();
  const L = spotlight();
  ctl.begin(L, { parentArr: [], index: 0 });
  assert.equal(ctl.phase(), 'awaitingLight');
  ctl.acceptSurfacePoint([0.3, 0.4, 0.6]);   // surface at engine z 0.6
  assert.ok(vclose(L.position, [0.3, 0.4, 0.6 + LIGHT_STANDOFF]));
  assert.equal(calls.commit.length, 1);
  assert.equal(ctl.phase(), 'awaitingTarget');
});

test('spotlight: click 2 sets target and derives direction, then idle', () => {
  const { ctl, calls } = makeCtl();
  const L = spotlight();
  ctl.begin(L, { parentArr: [], index: 0 });
  ctl.acceptSurfacePoint([0.5, 0.5, 0.5]);   // light at z 0.5+standoff
  ctl.acceptSurfacePoint([0.5, 0.5, 0.0]);   // target straight ahead (toward scene)
  assert.ok(vclose(L.target, [0.5, 0.5, 0.0]));
  // direction = normalize(target - position) = normalize([0,0,-(0.5+standoff)]) = [0,0,-1]
  assert.ok(vclose(L.direction, [0, 0, -1]));
  assert.equal(calls.update.length, 1);
  assert.equal(ctl.phase(), 'idle');
  assert.equal(ctl.isActive(), false);
});

test('point light: single click commits and finishes (no target)', () => {
  const { ctl, calls } = makeCtl();
  const L = { id: 'p1', type: 'point', position: [0, 0, 0], direction: [0, 0, -1] };
  ctl.begin(L, { parentArr: [], index: 0 });
  ctl.acceptSurfacePoint([0.2, 0.2, 0.4]);
  assert.equal(calls.commit.length, 1);
  assert.equal(L.target, undefined);
  assert.equal(ctl.phase(), 'idle');
});

test('cancel after click 1 removes the committed light', () => {
  const { ctl, calls } = makeCtl();
  const L = spotlight();
  ctl.begin(L, { parentArr: [], index: 0 });
  ctl.acceptSurfacePoint([0.5, 0.5, 0.5]);
  ctl.cancel();
  assert.equal(calls.remove.length, 1);
  assert.equal(ctl.phase(), 'idle');
});

test('cancel before click 1 removes nothing', () => {
  const { ctl, calls } = makeCtl();
  ctl.begin(spotlight(), { parentArr: [], index: 0 });
  ctl.cancel();
  assert.equal(calls.remove.length, 0);
  assert.equal(ctl.phase(), 'idle');
});

test('pendingLight exposes the in-progress light while awaiting target', () => {
  const { ctl } = makeCtl();
  const L = spotlight();
  ctl.begin(L, { parentArr: [], index: 0 });
  ctl.acceptSurfacePoint([0.5, 0.5, 0.5]);
  assert.equal(ctl.pendingLight(), L);
});

test('position z is clamped to the slider range [-2, 3]', () => {
  const { ctl } = makeCtl();
  const L = spotlight();
  ctl.begin(L, { parentArr: [], index: 0 });
  ctl.acceptSurfacePoint([0, 0, 5]);   // 5 + standoff would exceed 3
  assert.ok(close(L.position[2], 3));
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm run test:unit`
Expected: FAIL — `../../src/placement.js` missing.

- [ ] **Step 3: Create placement.js**

Create `web/src/placement.js`:

```js
// Click-to-place state machine. DOM-free: it mutates a light node and signals
// the host through injected callbacks. Both panes feed it engine-space surface
// points; it decides whether a point becomes the light's position (click 1) or
// its aim target (click 2).
//
// Phases: 'idle' → 'awaitingLight' → 'awaitingTarget' (the last only for
// directional/spotlight; point lights finish on click 1).

import { applyTargeting } from './targeting.js';

export const LIGHT_STANDOFF = 0.8;        // engine-z units, pulled toward camera
const Z_MIN = -2, Z_MAX = 3;              // matches the Position Z slider range

const clampZ = (z) => Math.max(Z_MIN, Math.min(Z_MAX, z));
const isTargetable = (L) => L.type === 'directional' || L.type === 'spotlight';

export function createPlacement({ commitLight, updateLight, removeLight, onPhaseChange }) {
  let phase = 'idle';
  let light = null;
  let insertAt = null;
  let committed = false;

  function setPhase(p) {
    phase = p;
    if (onPhaseChange) onPhaseChange(p);
  }

  function reset() {
    light = null;
    insertAt = null;
    committed = false;
    setPhase('idle');
  }

  // Start placing a (not-yet-inserted) light. `where` = { parentArr, index }.
  function begin(newLight, where) {
    light = newLight;
    insertAt = where;
    committed = false;
    setPhase('awaitingLight');
  }

  function acceptSurfacePoint(engPt) {
    if (phase === 'awaitingLight') {
      light.position = [engPt[0], engPt[1], clampZ(engPt[2] + LIGHT_STANDOFF)];
      commitLight(light, insertAt);
      committed = true;
      if (isTargetable(light)) {
        setPhase('awaitingTarget');
      } else {
        reset();                          // point light: done on click 1
      }
    } else if (phase === 'awaitingTarget') {
      light.target = [engPt[0], engPt[1], engPt[2]];
      applyTargeting(light);              // derive direction from target - position
      updateLight(light);
      reset();
    }
  }

  function cancel() {
    if (committed && light && removeLight) removeLight(light);
    reset();
  }

  return {
    begin,
    acceptSurfacePoint,
    cancel,
    isActive: () => phase !== 'idle',
    phase: () => phase,
    pendingLight: () => light,
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm run test:unit`
Expected: PASS — all placement tests green. Paste the placement results.

- [ ] **Step 5: Commit**

```bash
git add web/src/placement.js web/tests/unit/placement.test.js
git commit -m "feat(web): placement state machine (click 1 = light, click 2 = target)"
```

---

## Task 3: main.js wiring (controller, callbacks, preset branch, Esc, phase routing)

**Files:**
- Modify: `web/src/main.js` (imports; `onPickPreset` ~146-166; scene-load sampler in `applyScene` ~242-252; new controller + callbacks; Esc listener).

This task wires the controller but the pane adapters (Tasks 4-5) aren't built yet, so placement is only reachable once those land. After this task, normal app behavior must be unchanged.

- [ ] **Step 1: Add imports**

In `web/src/main.js`, with the other relative imports add:
```js
import { createPlacement } from './placement.js';
import { createDepthSampler } from './depth-sampler.js';
import { deleteNode } from './lights.js';
```
(`lights.js` already exports `deleteNode`; if `SCENE_ID` is needed and not already imported, add it to the existing `./lights.js` import — check the existing import line first and extend it rather than duplicating.)

- [ ] **Step 2: Add a module-scoped sampler holder**

Near the other top-level `let` declarations in `main.js` (e.g. next to `let handlesAPI = null;`), add:
```js
let depthSampler = null;     // rebuilt on each scene load; used by 2D placement
let placement = null;        // created once below
```

- [ ] **Step 3: Add the commit / update / remove callbacks**

Add these helper functions in `main.js` (place them near `onPickPreset`):
```js
function commitPlacedLight(L, insertAt) {
  const where = insertAt || { parentArr: state.tree, index: state.tree.length };
  where.parentArr.splice(where.index, 0, L);
  state.selectedId = L.id;
  tree?.render();
  refreshProps();
  onChange();
}

function updatePlacedLight(L) {
  // Direction already derived by the controller; refresh props so the targeting
  // toggle reflects the new target, then sync + save.
  refreshProps();
  onChange();
}

function removePlacedLight(L) {
  deleteNode(state.tree, L.id);
  syncLights(state);
  if (state.selectedId === L.id) state.selectedId = state.tree[0]?.id || SCENE_ID;
  tree?.render();
  refreshProps();
  onChange();
}

function onPlacementPhase(phase) {
  if (phase === 'awaitingLight') setStatus('Click in the photo or 3D view to place the light');
  else if (phase === 'awaitingTarget') setStatus('Click where the light should aim (Esc to cancel)');
  else setStatus('');
  placement2D?.setPhase(phase);
  notifyPlacementPhase3D(phase);
}
```
NOTE: `placement2D` and `notifyPlacementPhase3D` are introduced in Tasks 4 and 5. To keep this task self-contained and the app runnable now, declare a safe placeholder at module scope near the other `let`s:
```js
let placement2D = null;                         // set in Task 4
const notifyPlacementPhase3D = (phase) => {     // replaced by the real import in Task 5
  if (window.__notifyPlacementPhase3D) window.__notifyPlacementPhase3D(phase);
};
```
(Task 5 will replace this shim with a real import. The shim keeps the app working between tasks.)

- [ ] **Step 4: Create the controller**

After the callbacks, create the controller once (module scope, e.g. just below them):
```js
placement = createPlacement({
  commitLight: commitPlacedLight,
  updateLight: updatePlacedLight,
  removeLight: removePlacedLight,
  onPhaseChange: onPlacementPhase,
});
```

- [ ] **Step 5: Branch `onPickPreset` into placement for non-reflector types**

Replace the body of `onPickPreset` (lines 146-166) with:
```js
function onPickPreset(preset) {
  if (!preset) {
    // Cancel — restore previous selection.
    pendingAddLight = null;
    state.selectedId = lastSelectedBeforePicker || state.tree[0]?.id || SCENE_ID;
    lastSelectedBeforePicker = null;
    tree?.render();
    refreshProps();
    return;
  }
  const insertAt = pendingAddLight || { parentArr: state.tree, index: state.tree.length };
  const L = lightFromPreset(preset);
  L.name = uniqueName(preset.name);
  pendingAddLight = null;
  lastSelectedBeforePicker = null;

  const placeable = L.type === 'directional' || L.type === 'spotlight' || L.type === 'point';
  if (placeable && placement && state.assetUrls) {
    // Enter click-to-place. The light is committed on the first click.
    state.selectedId = SCENE_ID;     // dismiss the picker; show scene props meanwhile
    tree?.render();
    refreshProps();
    placement.begin(L, insertAt);
    return;
  }

  // Reflector (or no assets yet): instant add at default position (legacy path).
  insertAt.parentArr.splice(insertAt.index, 0, L);
  state.selectedId = L.id;
  tree?.render();
  refreshProps();
  onChange();
}
```

- [ ] **Step 6: Build the depth sampler on scene load**

In `applyScene`, after `state.assetUrls = scene.assets;` (line 242) and within the `if (state.assetUrls) { ... }` block (around 247-252, where `loadScene3D` is called), add:
```js
    depthSampler = createDepthSampler(state.assetUrls.depth_png_url);
```
Place it alongside the existing `await setAssets(...)` / `await loadScene3D(...)` calls (it does not need awaiting — `sample()` falls back to median depth until ready). If a scene has no assets, also reset it: in the `session_missing` early-return branch (line 209-216) add `depthSampler = null;`.

- [ ] **Step 7: Cancel placement on Esc (and on scene change)**

Add a document keydown listener for Esc (place it near the app bootstrap, after the controller is created):
```js
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && placement?.isActive()) {
    e.preventDefault();
    placement.cancel();
  }
});
```
And at the very top of `applyScene` (right after `await flushSave();`, line 197) cancel any in-flight placement so a half-placed light can't leak across scenes:
```js
  if (placement?.isActive()) placement.cancel();
```

- [ ] **Step 8: Verify the app still behaves (no adapters yet)**

Run: `npm run test:unit`
Expected: PASS (targeting + depth-sampler + placement units intact).

Then a module-load smoke (confirms `main.js` still parses/imports with the new imports and shim). Start the app per your usual flow and confirm: page loads with no console errors; adding a light via **+ Light** still works (it now enters placement mode for directional/spotlight/point, but with no pane adapters a click won't complete yet — that's expected and lands in Tasks 4-5). Adding a **reflector** still instantly adds at default position. Press **Esc** to cancel an accidental placement (status clears).

- [ ] **Step 9: Commit**

```bash
git add web/src/main.js
git commit -m "feat(web): wire placement controller, preset branch, depth sampler, Esc cancel"
```

---

## Task 4: 2D placement pane (overlay + adapter)

**Files:**
- Modify: `web/playground.html` (add `#placement-overlay`)
- Modify: `web/playground.css` (overlay + tether styles)
- Create: `web/src/placement-pane-2d.js`
- Modify: `web/src/main.js` (mount the 2D pane; set `placement2D`)

- [ ] **Step 1: Add the overlay element**

In `web/playground.html`, inside `#canvas-wrap` (next to `#handles` and `#refine-overlay`, around line 65-70), add:
```html
    <div id="placement-overlay" hidden></div>
```

- [ ] **Step 2: Add overlay + tether styles**

In `web/playground.css`, add:
```css
#placement-overlay {
  position: absolute;
  inset: 0;
  z-index: 5;                 /* above handles while placing */
  cursor: crosshair;
}
#placement-overlay[hidden] { display: none; }
#placement-overlay .placement-tether {
  position: absolute;
  height: 0;
  border-top: 1px dashed #ffd23f;
  transform-origin: 0 0;
  pointer-events: none;
}
```
(If `.direction-line` styling already gives a suitable tether look, the adapter may reuse it instead; this dedicated class keeps placement visuals independent.)

- [ ] **Step 3: Create the 2D pane adapter**

Create `web/src/placement-pane-2d.js`:
```js
// 2D-photo-pane adapter for click-to-place. While placement is active, a full
// overlay captures clicks over the photo, samples depth at the click, and feeds
// the controller an engine-space surface point [u, v, 1 - depth]. Between the
// light click and the target click it draws a dashed tether from the light to
// the cursor.
import { uvDepthToLight } from './3d/coords.js';

export function mountPlacement2D({ overlayEl, controller, getSampler }) {
  const tether = document.createElement('div');
  tether.className = 'placement-tether';
  tether.style.display = 'none';
  overlayEl.appendChild(tether);

  function uv(e) {
    const r = overlayEl.getBoundingClientRect();
    return [(e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height];
  }

  function engPointAt(e) {
    const [u, v] = uv(e);
    if (u < 0 || u > 1 || v < 0 || v > 1) return null;
    const depth = getSampler()?.sample(u, v) ?? 0.5;
    return uvDepthToLight(u, v, depth);
  }

  overlayEl.addEventListener('pointerdown', (e) => {
    if (!controller.isActive() || e.button !== 0) return;
    const engPt = engPointAt(e);
    if (!engPt) return;
    e.preventDefault();
    controller.acceptSurfacePoint(engPt);
  });

  overlayEl.addEventListener('pointermove', (e) => {
    if (controller.phase() !== 'awaitingTarget') { tether.style.display = 'none'; return; }
    const L = controller.pendingLight();
    if (!L) { tether.style.display = 'none'; return; }
    const r = overlayEl.getBoundingClientRect();
    const lx = L.position[0] * r.width;
    const ly = L.position[1] * r.height;
    const cx = e.clientX - r.left;
    const cy = e.clientY - r.top;
    const dx = cx - lx, dy = cy - ly;
    tether.style.left = `${lx}px`;
    tether.style.top = `${ly}px`;
    tether.style.width = `${Math.hypot(dx, dy)}px`;
    tether.style.transform = `rotate(${Math.atan2(dy, dx) * 180 / Math.PI}deg)`;
    tether.style.display = '';
  });

  // Right-click cancels placement.
  overlayEl.addEventListener('contextmenu', (e) => {
    if (!controller.isActive()) return;
    e.preventDefault();
    controller.cancel();
  });

  function setPhase(phase) {
    const active = phase !== 'idle';
    overlayEl.hidden = !active;
    if (!active || phase !== 'awaitingTarget') tether.style.display = 'none';
  }

  return { setPhase };
}
```

- [ ] **Step 4: Mount it in main.js**

In `web/src/main.js`, after the placement controller is created (Task 3 Step 4), and after the DOM is available (the app bootstraps against existing elements; mount alongside the other DOM wiring), add:
```js
placement2D = mountPlacement2D({
  overlayEl: document.getElementById('placement-overlay'),
  controller: placement,
  getSampler: () => depthSampler,
});
```
And add the import at the top:
```js
import { mountPlacement2D } from './placement-pane-2d.js';
```
Remove the `let placement2D = null;` initializer's reliance on being unset — it's assigned here. (Keep the `let placement2D = null;` declaration from Task 3; this just assigns it.)

- [ ] **Step 5: Verify (unit + manual smoke)**

Run: `npm run test:unit`
Expected: PASS.

Manual: start the app, load a scene. **+ Light → Spotlight** → click on the subject in the 2D photo (light appears there) → move the mouse (dashed tether follows) → click elsewhere to set the target. The spotlight should now be targeted and aiming at the second point. Try **+ Light → Point** → one click places it. Try starting a placement and pressing **Esc** / right-click → the just-placed light is removed and status clears.

- [ ] **Step 6: Commit**

```bash
git add web/playground.html web/playground.css web/src/placement-pane-2d.js web/src/main.js
git commit -m "feat(web): 2D click-to-place overlay with depth sampling and tether preview"
```

---

## Task 5: 3D placement adapter

**Files:**
- Modify: `web/src/3d/target-viz.js` (add `showPreview`/`clearPreview`)
- Modify: `web/src/3d/index.js` (placement raycast on click, preview on move, `mount3D` option, `notifyPlacementPhase`)
- Modify: `web/src/main.js` (pass `placement` into `mount3D`; replace the Task 3 phase shim with the real import)

- [ ] **Step 1: Add a preview beam to target-viz.js**

In `web/src/3d/target-viz.js`, the module already creates a `marker` + `line` and returns `{ marker, show, hide, dispose }`. Add a second, dedicated preview line so the placement preview never fights the real targeting beam. Inside `createTargetViz`, after the existing `line` is created, add:
```js
  const previewMat = new THREE.LineBasicMaterial({ color: 0xffd23f });
  const previewGeo = new THREE.BufferGeometry().setFromPoints([
    new THREE.Vector3(), new THREE.Vector3(),
  ]);
  const previewLine = new THREE.Line(previewGeo, previewMat);
  previewLine.visible = false;
  scene.add(previewLine);
```
Add two functions (before the `return`):
```js
  function showPreview(fromEng, toEng) {
    const a = lightToWorld(fromEng);
    const b = lightToWorld(toEng);
    const pos = previewLine.geometry.attributes.position;
    pos.setXYZ(0, a[0], a[1], a[2]);
    pos.setXYZ(1, b[0], b[1], b[2]);
    pos.needsUpdate = true;
    previewLine.visible = true;
  }
  function clearPreview() { previewLine.visible = false; }
```
Update `dispose` to also tear down the preview line:
```js
    scene.remove(previewLine); previewLine.geometry.dispose(); previewLine.material.dispose();
```
And add `showPreview, clearPreview` to the returned object:
```js
  return { marker, show, hide, showPreview, clearPreview, dispose };
```
(`lightToWorld` is already imported in target-viz.js — confirm.)

- [ ] **Step 2: Add the placement adapter to index.js**

In `web/src/3d/index.js`:

(a) Add a module-scoped `let placement = null;` near the other `let`s (after `let targetViz = null;`).

(b) In `mount3D`, extend the options destructure to accept `placement`:
```js
export function mount3D({ onSelectLight, onUpdateLight, placement: placementCtl } = {}) {
```
and store it: after `onLightChange = onUpdateLight || null;`, add `placement = placementCtl || null;`.

(c) Add a helper that converts a 3D pointer event into an engine surface point by raycasting the point cloud (plane fallback). Add near `onCanvasClick`:
```js
const placementPlane = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0);

function placementEngPoint(e) {
  if (!api) return null;
  const canvas = e.currentTarget;
  const rect = canvas.getBoundingClientRect();
  mouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
  mouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
  raycaster.setFromCamera(mouse, api.getActiveCamera());
  // Prefer a real point-cloud hit (true depth); fall back to a plane at the
  // subject's median depth so a point is always produced.
  raycaster.params.Points.threshold = 0.03;
  let hit = null;
  if (currentPointCloud) {
    const pts = raycaster.intersectObject(currentPointCloud.points, false);
    if (pts.length) hit = pts[0].point;
  }
  if (!hit) {
    // Plane at world z corresponding to engine median depth.
    const medianEngZ = 1 - (window.__subjectMedianDepth ?? 0.3);
    placementPlane.constant = -lightToWorld([0, 0, medianEngZ])[2];
    const p = new THREE.Vector3();
    if (!raycaster.ray.intersectPlane(placementPlane, p)) return null;
    hit = p;
  }
  return worldToLight([hit.x, hit.y, hit.z]);
}
```
Add imports at the top of index.js: extend the coords import to include `worldToLight` and `lightToWorld`:
```js
import { worldToLight, lightToWorld } from './coords.js';
```
NOTE on the median depth: rather than a `window` global, pass it cleanly. Simpler and explicit — read it from the controller's pending light is wrong (no depth there). Instead, accept the median via `mount3D`. Change `mount3D` to also accept `getSubjectMedianDepth` is overkill; instead, in `main.js` set `window.__subjectMedianDepth = state.subjectMedianDepth` whenever it changes (in `applyScene` after computing it). That is acceptable and avoids new wiring. Add in `applyScene` (Task 3 already touches it) the line `window.__subjectMedianDepth = state.subjectMedianDepth;` right after `state.subjectMedianDepth` is set (line ~232). (Add this line as part of THIS task.)

(d) In `onCanvasClick`, handle placement BEFORE the normal selection raycast. At the very top of `onCanvasClick` (after the `if (e.button !== 0) return;` guard), add:
```js
  if (placement && placement.isActive()) {
    const engPt = placementEngPoint(e);
    if (engPt) { placement.acceptSurfacePoint(engPt); }
    return;
  }
```

(e) Add a pointermove preview. In `mount3D`, where `canvas.addEventListener('pointerdown', onCanvasClick);` is registered (line ~86), add:
```js
  canvas.addEventListener('pointermove', onPlacementMove);
  canvas.addEventListener('contextmenu', onPlacementContext);
```
and define:
```js
function onPlacementMove(e) {
  if (!placement || placement.phase() !== 'awaitingTarget' || !targetViz) {
    targetViz?.clearPreview();
    return;
  }
  const L = placement.pendingLight();
  const engPt = placementEngPoint(e);
  if (!L || !engPt) { targetViz.clearPreview(); return; }
  targetViz.showPreview(L.position, engPt);
}
function onPlacementContext(e) {
  if (!placement || !placement.isActive()) return;
  e.preventDefault();
  placement.cancel();
}
```

(f) Export the phase notifier (clears the preview when leaving target-aim):
```js
export function notifyPlacementPhase(phase) {
  if (!targetViz) return;
  if (phase !== 'awaitingTarget') targetViz.clearPreview();
}
```

- [ ] **Step 3: Wire main.js to the real 3D notifier and pass the controller**

In `web/src/main.js`:

(a) Replace the Task 3 shim
```js
const notifyPlacementPhase3D = (phase) => {
  if (window.__notifyPlacementPhase3D) window.__notifyPlacementPhase3D(phase);
};
```
with a real import. Extend the existing `./3d/index.js` import to include `notifyPlacementPhase`, and replace the shim function with:
```js
const notifyPlacementPhase3D = (phase) => notifyPlacementPhase(phase);
```
(Or call `notifyPlacementPhase(phase)` directly inside `onPlacementPhase` and delete the shim entirely.)

(b) Pass the controller into `mount3D`. Find the `mount3D({ onSelectLight, onUpdateLight: ... })` call and add `placement`:
```js
  mount3D({
    onSelectLight: (id) => { ... existing ... },
    onUpdateLight: (id, patch) => { ... existing ... },
    placement,
  });
```

- [ ] **Step 4: Verify (unit + manual smoke in 3D)**

Run: `npm run test:unit`
Expected: PASS.

Manual: load a scene with the 3D pane visible. **+ Light → Spotlight** → click on the subject in the **3D** viewport (light appears) → move (preview beam follows) → click to set the target; the cone re-aims onto the target. Confirm placing also still works in the **2D** pane (Task 4). Confirm **Esc** and right-click cancel and remove the light. Confirm normal light **selection** by clicking a light still works when NOT placing.

- [ ] **Step 5: Commit**

```bash
git add web/src/3d/target-viz.js web/src/3d/index.js web/src/main.js
git commit -m "feat(web): 3D click-to-place (point-cloud raycast, plane fallback, beam preview)"
```

---

## Task 6: Integration verification

**Files:** none (verification only).

- [ ] **Step 1: Run all unit tests**

Run: `npm run test:unit`
Expected: targeting + depth-sampler + placement suites all green.

- [ ] **Step 2: Module-load smoke**

Confirm every edited/created module imports without page errors (catches syntax/bad-import issues the unit tests don't cover, since they only import the pure modules). Temporarily add a Playwright spec that `goto`s `/web/playground.html` and asserts no `pageerror`/`console.error` during load (pattern: load page, wait ~2.5s, fail on JS errors), run it via `npx playwright test <spec> --config=web/tests/playwright.config.js`, then delete the temp spec. (This mirrors the smoke used for the targeting feature.)

- [ ] **Step 3: Manual end-to-end checklist**

With the app running and a scene loaded, verify:
- 2D: place a **spotlight** (light click → target click); tether preview tracks the cursor; cone lands on the target afterward.
- 3D: place a **spotlight** (light click → target click); beam preview tracks; cone re-aims.
- **Point light**: single click places it (no target step), in both panes.
- **Reflector**: still instant-adds at default position (no placement mode).
- **Cancel**: Esc and right-click during `awaitingTarget` remove the just-placed light; status clears.
- **Cross-pane consistency**: a light placed in 2D appears at the matching spot in 3D (no drift).
- **Persistence**: after placing + finishing, reload → the light (and its target) come back in place.
- **Scene switch mid-placement**: start a placement, switch scenes → no half-placed light leaks in.

- [ ] **Step 4: Commit any verification fixups**

```bash
git add -A
git commit -m "test(web): verify click-to-place across panes, cancel, and persistence"
```
(Only if fixups were needed; otherwise nothing to commit.)

---

## Self-review notes (reconciled)

- **Spec coverage:** depth sampling (Task 1), placement state machine incl. standoff/point-single-click/cancel-removes (Task 2), preset-branch + Esc + scene-load sampler + scene-switch cancel (Task 3), 2D pane with tether (Task 4), 3D pane with point-cloud raycast + plane fallback + beam preview (Task 5), testing across pure-units + manual + load-smoke (Tasks 1,2,6). v1.1 subject-snapping intentionally excluded.
- **Type/name consistency:** controller API (`begin`, `acceptSurfacePoint`, `cancel`, `isActive`, `phase`, `pendingLight`) used identically in Tasks 2/3/4/5; callbacks (`commitLight`/`updateLight`/`removeLight`/`onPhaseChange`) consistent; `uvDepthToLight` (Task 1) used by Task 4; `showPreview`/`clearPreview` (Task 5) consistent; `notifyPlacementPhase` consistent between index.js and main.js.
- **Engine-coord correctness:** 2D click → `[u, v, 1−depth]`; light standoff adds `LIGHT_STANDOFF` to engine z (camera-ward) with `[-2,3]` clamp; target sits on the surface; both verified by the placement unit tests.
- **Inter-task runnability:** Task 3 ships a phase shim so the app runs before the pane adapters exist; Task 5 replaces it with the real `notifyPlacementPhase` import.
