# Light Targeting Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a directional or spotlight light aim at a movable 3D **target** point; when a `target` is set, the light's `direction` is derived from `target − position` and re-derived whenever either moves.

**Architecture:** A light is *targeted* iff `light.target` is a non-null `[x, y, z]` point in engine space (same space as `position`). Direction stays the single field the renderer consumes; in targeted mode it becomes a *derived* value kept in sync by one pure helper (`web/src/targeting.js`). The three existing free-aim direction paths (rotate gizmo, 2D direction-handle, direction-Z slider) are suppressed while targeted. The Python engine and API gain an optional `target` field and a render-time derivation fallback so direct API callers work too.

**Tech Stack:** Vanilla ES modules + three.js (web), PyTorch/Python dataclasses (engine), Pydantic (API). Web pure-logic tests via Node's built-in `node:test`; Python tests via pytest; existing Playwright parity test for visual smoke.

**Spec:** `docs/superpowers/specs/2026-05-30-light-targeting-design.md`

---

## Design reconciliations (read before starting)

Two points where the codebase differs from the spec's wording — the plan follows the codebase:

1. **No `aimAtTarget` boolean flag.** Targeted mode is derived purely from `light.target != null`. The "Aim at target" checkbox's checked state reflects `light.target != null`; toggling on spawns a target, toggling off sets it to `null`.
2. **No undo/redo stack exists.** Persistence is debounced auto-save (`serializeSceneState` → `updateScene`, see `web/src/main.js:56,73`). The spec's "undo path" maps to this auto-save path: target edits flow through `onUpdateLight → onChange → scheduleSave` exactly like every other edit, so "target moves use the existing edit path with no special handling" is satisfied with nothing extra to build. Task 8 verifies round-trip persistence; there is no undo system to integrate with.

## File structure

| File | Change | Responsibility |
|---|---|---|
| `web/src/targeting.js` | **Create** | Pure helpers: `isTargeted`, `deriveDirection`, `targetSpawnPoint`, `applyTargeting`. No DOM/three deps. |
| `web/tests/unit/targeting.test.js` | **Create** | Node `node:test` unit tests for the helpers. |
| `package.json` | Modify | Add `test:unit` script. |
| `packages/relighting_engine/relighting_engine/lighting/models.py` | Modify | Add optional `target` field + dict round-trip. |
| `packages/relighting_engine/relighting_engine/lighting/shaders.py` | Modify | `effective_direction(light)` helper + use it for directional/spotlight. |
| `packages/relighting_engine/tests/unit/test_lighting_models.py` | Modify | Round-trip + derivation tests. |
| `packages/relighting_api/relighting_api/schemas.py` | Modify | Add `target` to `LightModel` + `to_engine`. |
| `packages/relighting_api/tests/api/test_targeting.py` | **Create** | Schema → engine target passthrough test. |
| `web/src/main.js` | Modify | `onUpdateLight` target handling + re-derive on load. |
| `web/src/controls.js` | Modify | "Aim at target" toggle, gated to directional/spotlight. |
| `web/src/handles.js` | Modify | 2D target handle; suppress direction-handle when targeted. |
| `web/src/3d/gizmos.js` | Modify | `attachTarget` mode + `onTargetMove` callback. |
| `web/src/3d/target-viz.js` | **Create** | Beam line + target marker primitive for the selected targeted light. |
| `web/src/3d/index.js` | Modify | Drive target-viz + choose gizmo attach (light vs target) + suppress rotate. |

---

## Task 1: Pure targeting helpers (web)

**Files:**
- Create: `web/src/targeting.js`
- Create: `web/tests/unit/targeting.test.js`
- Modify: `package.json` (add `test:unit` script)

- [ ] **Step 1: Add the `test:unit` script**

In `package.json`, change the `scripts` block to:

```json
  "scripts": {
    "test:parity": "playwright test --config=web/tests/playwright.config.js",
    "test:unit": "node --test web/tests/unit/"
  },
```

- [ ] **Step 2: Write the failing unit test**

Create `web/tests/unit/targeting.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isTargeted, deriveDirection, targetSpawnPoint, applyTargeting, TARGET_SPAWN_DIST,
} from '../../src/targeting.js';

const close = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps;
const vclose = (a, b) => a.length === b.length && a.every((v, i) => close(v, b[i]));

test('isTargeted: only directional/spotlight with an array target', () => {
  assert.equal(isTargeted({ type: 'spotlight', target: [0, 0, 0] }), true);
  assert.equal(isTargeted({ type: 'directional', target: [1, 2, 3] }), true);
  assert.equal(isTargeted({ type: 'spotlight', target: null }), false);
  assert.equal(isTargeted({ type: 'spotlight' }), false);
  assert.equal(isTargeted({ type: 'point', target: [0, 0, 0] }), false);
  assert.equal(isTargeted({ type: 'reflector', target: [0, 0, 0] }), false);
});

test('deriveDirection: normalized target - position', () => {
  const L = { type: 'spotlight', position: [0, 0, 0], target: [0, 0, -2], direction: [1, 0, 0] };
  assert.ok(vclose(deriveDirection(L), [0, 0, -1]));
});

test('deriveDirection: degenerate target==position keeps existing direction', () => {
  const L = { type: 'spotlight', position: [0.5, 0.5, 1], target: [0.5, 0.5, 1], direction: [0.3, -0.2, -1] };
  assert.ok(vclose(deriveDirection(L), [0.3, -0.2, -1]));
});

test('deriveDirection: not targeted returns a copy of direction unchanged', () => {
  const dir = [0.1, 0.2, -0.97];
  const L = { type: 'spotlight', position: [0, 0, 0], target: null, direction: dir };
  const out = deriveDirection(L);
  assert.ok(vclose(out, dir));
  assert.notEqual(out, dir, 'returns a fresh array, not the same reference');
});

test('targetSpawnPoint then deriveDirection round-trips to the same direction', () => {
  const dir = [0.3, 0.3, -1];
  const n = Math.hypot(...dir);
  const unit = dir.map((c) => c / n);
  const L = { type: 'spotlight', position: [0.7, 0.3, 1.5], target: null, direction: dir };
  const tgt = targetSpawnPoint(L);
  const Lt = { ...L, target: tgt };
  assert.ok(vclose(deriveDirection(Lt), unit), 'beam does not jump on spawn');
  assert.ok(close(Math.hypot(tgt[0] - L.position[0], tgt[1] - L.position[1], tgt[2] - L.position[2]), TARGET_SPAWN_DIST));
});

test('applyTargeting: writes derived direction in place when targeted, no-op otherwise', () => {
  const L = { type: 'spotlight', position: [0, 0, 0], target: [0, 0, -5], direction: [1, 0, 0] };
  applyTargeting(L);
  assert.ok(vclose(L.direction, [0, 0, -1]));

  const F = { type: 'spotlight', position: [0, 0, 0], target: null, direction: [1, 0, 0] };
  applyTargeting(F);
  assert.ok(vclose(F.direction, [1, 0, 0]));
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npm run test:unit`
Expected: FAIL — `Cannot find module '../../src/targeting.js'` (file not created yet).

- [ ] **Step 4: Write the helper module**

Create `web/src/targeting.js`:

```js
// Pure helpers for optional light targeting.
//
// A light is "targeted" iff its `target` field is a non-null [x, y, z] point in
// ENGINE space (the same space as `position`). When targeted, the light's
// `direction` is DERIVED from `target - position` and must never be hand-edited;
// the free-aim direction controls are suppressed by the UI in that mode.
//
// Only directional/spotlight lights may be targeted (point lights are
// omnidirectional; reflectors aim via `normal`).

export const TARGET_SPAWN_DIST = 1.0;   // engine-space units in front of the light
const EPS = 1e-6;

export function isTargeted(light) {
  return (light.type === 'directional' || light.type === 'spotlight')
    && Array.isArray(light.target);
}

// Normalized direction a targeted light should point. Returns a copy of the
// light's existing direction when not targeted, or when target coincides with
// position (degenerate — avoids normalizing a zero vector).
export function deriveDirection(light) {
  if (!isTargeted(light)) return light.direction.slice();
  const [px, py, pz] = light.position;
  const [tx, ty, tz] = light.target;
  const vx = tx - px, vy = ty - py, vz = tz - pz;
  const len = Math.hypot(vx, vy, vz);
  if (len < EPS) return light.direction.slice();
  return [vx / len, vy / len, vz / len];
}

// Spawn point for a freshly-toggled target: a fixed distance along the light's
// current (normalized) direction, so direction — and the rendered beam — does
// not visibly jump when targeting turns on.
export function targetSpawnPoint(light, dist = TARGET_SPAWN_DIST) {
  const [px, py, pz] = light.position;
  let [dx, dy, dz] = light.direction;
  const len = Math.hypot(dx, dy, dz);
  if (len < EPS) { dx = 0; dy = 0; dz = -1; } else { dx /= len; dy /= len; dz /= len; }
  return [px + dx * dist, py + dy * dist, pz + dz * dist];
}

// Recompute + store the derived direction in place when targeted; no-op
// otherwise. Call after any change to a light's target or position.
export function applyTargeting(light) {
  if (isTargeted(light)) light.direction = deriveDirection(light);
  return light;
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npm run test:unit`
Expected: PASS — all 6 tests green.

- [ ] **Step 6: Commit**

```bash
git add web/src/targeting.js web/tests/unit/targeting.test.js package.json
git commit -m "feat(web): pure light-targeting helpers (derive direction from target)"
```

---

## Task 2: Engine — optional `target` field + render-time derivation

**Files:**
- Modify: `packages/relighting_engine/relighting_engine/lighting/models.py:46,90,103`
- Modify: `packages/relighting_engine/relighting_engine/lighting/shaders.py:221-244`
- Test: `packages/relighting_engine/tests/unit/test_lighting_models.py`

- [ ] **Step 1: Write the failing tests**

Append to `packages/relighting_engine/tests/unit/test_lighting_models.py`:

```python
import math

from relighting_engine.lighting.models import Light
from relighting_engine.lighting.shaders import effective_direction


def test_light_target_dict_roundtrip() -> None:
    l = Light(type="spotlight", position=(0.5, 0.4, -0.3), target=(0.1, 0.2, -2.0))
    l2 = Light.from_dict(l.to_dict())
    assert l2.target == (0.1, 0.2, -2.0)
    assert l2 == l


def test_light_target_defaults_none() -> None:
    l = Light.from_dict({"type": "spotlight"})
    assert l.target is None


def test_effective_direction_derives_from_target() -> None:
    l = Light(type="spotlight", position=(0.0, 0.0, 0.0), target=(0.0, 0.0, -2.0),
              direction=(1.0, 0.0, 0.0))
    dx, dy, dz = effective_direction(l)
    assert math.isclose(dx, 0.0, abs_tol=1e-9)
    assert math.isclose(dy, 0.0, abs_tol=1e-9)
    assert math.isclose(dz, -1.0, abs_tol=1e-9)


def test_effective_direction_degenerate_keeps_direction() -> None:
    l = Light(type="spotlight", position=(0.5, 0.5, 1.0), target=(0.5, 0.5, 1.0),
              direction=(0.3, -0.2, -1.0))
    assert effective_direction(l) == (0.3, -0.2, -1.0)


def test_effective_direction_no_target_returns_direction() -> None:
    l = Light(type="directional", direction=(0.1, 0.2, -0.9))
    assert effective_direction(l) == (0.1, 0.2, -0.9)
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pytest packages/relighting_engine/tests/unit/test_lighting_models.py -v`
Expected: FAIL — `ImportError: cannot import name 'effective_direction'` and `TypeError: ... unexpected keyword argument 'target'`.

- [ ] **Step 3: Add the `target` field to the `Light` dataclass**

In `models.py`, insert after line 46 (`direction: ...`):

```python
    target: tuple[float, float, float] | None = None
```

- [ ] **Step 4: Serialize `target` in `to_dict`**

In `models.py` `to_dict` (after the `d["color"] = list(...)` line, around line 93), add:

```python
        d["target"] = list(self.target) if self.target is not None else None
```

- [ ] **Step 5: Deserialize `target` in `from_dict`**

In `models.py` `from_dict`, after the `direction=...` line (around line 103), add:

```python
            target=tuple(d["target"]) if d.get("target") else None,
```

- [ ] **Step 6: Add the `effective_direction` helper to the shader module**

In `shaders.py`, add this module-level function (place it above the `render` function or near the top after imports; `math` is already imported):

```python
def effective_direction(light) -> tuple[float, float, float]:
    """Direction a directional/spotlight actually points.

    If `light.target` is set, derive `normalize(target - position)`. Falls back
    to the stored `light.direction` when no target is set or when target
    coincides with position (degenerate). The web client sends an already-derived
    direction; this lets direct API callers send a bare target instead.
    """
    target = getattr(light, "target", None)
    if target is not None:
        tx, ty, tz = target
        px, py, pz = light.position
        vx, vy, vz = tx - px, ty - py, tz - pz
        n = math.sqrt(vx * vx + vy * vy + vz * vz)
        if n > 1e-9:
            return (vx / n, vy / n, vz / n)
    return light.direction
```

- [ ] **Step 7: Use `effective_direction` in the render loop**

In `shaders.py`, inside the `for L in emitters:` loop, right after `L.validate()` (line 224), add:

```python
        dir_vec = effective_direction(L)
```

Then change the directional branch (line 227) from:

```python
            d = torch.tensor(L.direction, device=device, dtype=torch.float32)
```
to:
```python
            d = torch.tensor(dir_vec, device=device, dtype=torch.float32)
```

And change the spotlight branch (line 239) from:

```python
            d = torch.tensor(L.direction, device=device, dtype=torch.float32)
```
to:
```python
            d = torch.tensor(dir_vec, device=device, dtype=torch.float32)
```

- [ ] **Step 8: Run the tests to verify they pass**

Run: `pytest packages/relighting_engine/tests/unit/test_lighting_models.py -v`
Expected: PASS — all new tests green, existing tests still pass.

- [ ] **Step 9: Run the broader engine suite for regressions**

Run: `pytest packages/relighting_engine/tests/ -q`
Expected: PASS (no regressions in render/shader tests).

- [ ] **Step 10: Commit**

```bash
git add packages/relighting_engine/relighting_engine/lighting/models.py packages/relighting_engine/relighting_engine/lighting/shaders.py packages/relighting_engine/tests/unit/test_lighting_models.py
git commit -m "feat(engine): optional light target with render-time direction derivation"
```

---

## Task 3: API schema — pass `target` through to the engine

**Files:**
- Modify: `packages/relighting_api/relighting_api/schemas.py:37,58`
- Test: `packages/relighting_api/tests/api/test_targeting.py` (create)

- [ ] **Step 1: Write the failing test**

Create `packages/relighting_api/tests/api/test_targeting.py`:

```python
from relighting_api.schemas import LightModel


def test_lightmodel_target_passthrough_to_engine() -> None:
    m = LightModel(type="spotlight", position=[0.5, 0.4, -0.3], target=[0.1, 0.2, -2.0])
    eng = m.to_engine()
    assert eng.target == (0.1, 0.2, -2.0)


def test_lightmodel_target_defaults_none() -> None:
    m = LightModel(type="spotlight")
    assert m.target is None
    assert m.to_engine().target is None
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pytest packages/relighting_api/tests/api/test_targeting.py -v`
Expected: FAIL — `LightModel` rejects `target` / `to_engine()` produces no `target`.

- [ ] **Step 3: Add `target` to `LightModel`**

In `schemas.py`, insert after line 37 (`direction: ...`):

```python
    target: list[float] | None = None
```

- [ ] **Step 4: Pass `target` in `to_engine`**

In `schemas.py` `to_engine`, after the `direction=(...)` line (line 58), add:

```python
            target=tuple(self.target) if self.target else None,
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `pytest packages/relighting_api/tests/api/test_targeting.py -v`
Expected: PASS — both tests green.

- [ ] **Step 6: Commit**

```bash
git add packages/relighting_api/relighting_api/schemas.py packages/relighting_api/tests/api/test_targeting.py
git commit -m "feat(api): optional light target field on LightModel"
```

---

## Task 4: main.js — central target wiring (update handler + re-derive on load)

This is the hub: it accepts `target` patches from the 3D gizmo and re-derives direction, and recomputes derived direction for targeted lights after a scene loads. UI tasks (5–7) depend on this.

**Files:**
- Modify: `web/src/main.js:428-435` (`onUpdateLight`), `web/src/main.js:232` (post-load recompute), and the import block near the top.

- [ ] **Step 1: Import the targeting helper**

Near the other `web/src/...` imports at the top of `web/src/main.js`, add:

```js
import { applyTargeting } from './targeting.js';
```

- [ ] **Step 2: Handle `target` patches and re-derive in `onUpdateLight`**

In `web/src/main.js`, replace the `onUpdateLight` body (lines 428–435) with:

```js
    onUpdateLight: (id, patch) => {
      const L = state.lights.find((l) => l.id === id);
      if (!L) return;
      if (patch.position)  L.position  = patch.position;
      if (patch.direction) L.direction = patch.direction;
      if (patch.normal)    L.normal    = patch.normal;
      if ('target' in patch) L.target = patch.target;
      // Targeted lights derive direction from target - position; recompute after
      // any target OR position change so the beam tracks live.
      applyTargeting(L);
      onChange();
    },
```

(Note: `'target' in patch` — not `patch.target` — so a `null` target from "untarget" is honored.)

- [ ] **Step 3: Re-derive targeted lights after a scene loads**

In `web/src/main.js` `applyScene`, immediately after `syncLights(state);` at line 232, add:

```js
  // Recompute derived direction for any targeted lights (guards against a stale
  // stored direction in the loaded scene).
  for (const L of state.lights) applyTargeting(L);
```

- [ ] **Step 4: Verify nothing is broken (no unit harness for main.js — manual smoke)**

Run the app per the project's run flow (see `web/playground.html`; backend on port 8001 with auth per memory). Load an existing scene.
Expected: scene loads unchanged; no console errors. (Targeting isn't user-reachable yet — this step confirms the wiring is inert for non-targeted lights.)

- [ ] **Step 5: Commit**

```bash
git add web/src/main.js
git commit -m "feat(web): wire target patches + on-load re-derive into light update path"
```

---

## Task 5: controls.js — "Aim at target" toggle

The toggle is a structural mode switch (not a per-frame edit): it must remount the 2D handles (to swap the direction handle for the target handle) and sync the 3D scene (to show the marker). The per-edit `redraw` callback the props panel already gets (`redrawAndSave`, `web/src/main.js:122`) syncs 3D + saves but does **not** remount the 2D handles — only `onChange` (`web/src/main.js:167`) does. So we thread `onChange` into the props renderer as a dedicated structural callback used only by this toggle.

**Files:**
- Modify: `web/src/main.js:133` (pass `onChange` to `renderProps`)
- Modify: `web/src/controls.js:43,58,211` (`renderProps` + `renderLightProps` signatures) + import block.

- [ ] **Step 1: Pass `onChange` into the props renderer (main.js)**

In `web/src/main.js`, in `refreshProps` (line 133), change:

```js
    renderProps(state, c, redrawAndSave);
```
to:
```js
    renderProps(state, c, redrawAndSave, onChange);
```

- [ ] **Step 2: Thread the structural callback through controls.js**

In `web/src/controls.js`, change `renderProps` (line 43) from:

```js
export function renderProps(state, container, redraw) {
```
to:
```js
export function renderProps(state, container, redraw, onStructural) {
```

And change the `renderLightProps(...)` call (line 58) from:

```js
  renderLightProps(node, idx, container, redraw);
```
to:
```js
  renderLightProps(node, idx, container, redraw, onStructural);
```

And change the `renderLightProps` definition (line 211) from:

```js
function renderLightProps(L, slotIdx, container, redraw) {
```
to:
```js
function renderLightProps(L, slotIdx, container, redraw, onStructural) {
```

- [ ] **Step 3: Import the helpers**

At the top of `web/src/controls.js`, add to the imports:

```js
import { isTargeted, targetSpawnPoint, applyTargeting } from './targeting.js';
```

- [ ] **Step 4: Add the toggle markup**

In `renderLightProps`, in the template literal (after the `Direction Z` label at line 234), add a new line:

```js
    <label class="checkbox-row"><input type="checkbox" class="aim-at-target" /> Aim at target</label>
```

- [ ] **Step 5: Reflect current state + disable Direction Z while targeted**

After the existing `$('.direction-z').value = L.direction[2];` line (line 256), add:

```js
  const targeted = isTargeted(L);
  $('.aim-at-target').checked = targeted;
  $('.direction-z').disabled = targeted;   // direction is derived while targeted
```

- [ ] **Step 6: Wire the toggle (uses `onStructural`, not `bind`)**

After the `bind('.direction-z', ...)` line (line 272), add a direct listener (the toggle needs `onStructural`, which `bind` doesn't provide):

```js
  $('.aim-at-target').addEventListener('change', (e) => {
    if (e.target.checked) {
      L.target = targetSpawnPoint(L);   // spawn in front; beam won't jump
      applyTargeting(L);                // derive (unchanged at spawn)
    } else {
      L.target = null;                  // back to free-aim; keep last direction
    }
    // direction is derived while targeted — disable its slider directly (onChange
    // does not re-render the props panel, so we update this DOM in place).
    $('.direction-z').disabled = e.target.checked;
    if (onStructural) onStructural();   // remount 2D handles, sync 3D, save
  });
```

- [ ] **Step 7: Manual smoke**

Run the app. Select a spotlight. Toggle "Aim at target" on.
Expected: checkbox stays checked; Direction Z slider becomes disabled; the rendered image does not jump (direction unchanged at spawn); the 3D pane shows a target marker + beam; the 2D direction handle is replaced by a target handle. Toggle off: Direction Z re-enables; markers disappear; image unchanged.

- [ ] **Step 8: Commit**

```bash
git add web/src/main.js web/src/controls.js
git commit -m "feat(web): Aim at target toggle in light props (spawns/clears target)"
```

---

## Task 6: handles.js — 2D target handle + suppress direction handle

**Files:**
- Modify: `web/src/handles.js` (add target handle element, placement, drag; gate direction handle).

- [ ] **Step 1: Import helpers**

At the top of `web/src/handles.js`, add:

```js
import { isTargeted, applyTargeting } from './targeting.js';
```

- [ ] **Step 2: Create the target handle element**

After the direction widgets are created (after line 45, `root.appendChild(dirHandle);`), add:

```js
  // Target handle — shown only for the selected, targeted light. Dragging it
  // moves light.target in X/Y (Z unchanged); direction is re-derived live.
  const tgtLine = document.createElement('div');
  tgtLine.className = 'direction-line';        // reuse the tether styling
  const tgtHandle = document.createElement('div');
  tgtHandle.className = 'direction-handle target-handle';
  tgtHandle.style.display = 'none';
  tgtLine.style.display = 'none';
  root.appendChild(tgtLine);
  root.appendChild(tgtHandle);
```

- [ ] **Step 3: Suppress the direction handle when targeted; place the target handle**

In `place()`, change the `showDir` line (line 65) from:

```js
    const showDir = sel && sel.enabled;
```
to:
```js
    const targeted = sel && isTargeted(sel);
    const showDir = sel && sel.enabled && !targeted;
```

Then, just before the closing `};` of `place()` (after line 86, after the `dirLine.style.display = '';` block), add:

```js
    // Target handle + tether from the light position to the target.
    if (targeted) {
      const r2 = root.getBoundingClientRect();
      const lpx = sel.position[0] * r2.width;
      const lpy = sel.position[1] * r2.height;
      const tpx = sel.target[0] * r2.width;
      const tpy = sel.target[1] * r2.height;
      tgtHandle.style.left = `${tpx}px`;
      tgtHandle.style.top  = `${tpy}px`;
      tgtHandle.style.display = '';
      const tdx = tpx - lpx, tdy = tpy - lpy;
      tgtLine.style.left = `${lpx}px`;
      tgtLine.style.top  = `${lpy}px`;
      tgtLine.style.width = `${Math.hypot(tdx, tdy)}px`;
      tgtLine.style.transform = `rotate(${Math.atan2(tdy, tdx) * 180 / Math.PI}deg)`;
      tgtLine.style.display = '';
    } else {
      tgtHandle.style.display = 'none';
      tgtLine.style.display = 'none';
    }
```

- [ ] **Step 4: Wire the target-handle drag**

After the direction-handle drag block (after line 166, the closing `}` of that block), add:

```js
  // ─── Target-handle drag ────────────────────────────────────────────────
  {
    let startX = 0, startY = 0, startTarget = null;
    tgtHandle.addEventListener('pointerdown', (e) => {
      const sel = selectedLight();
      if (!sel || !isTargeted(sel)) return;
      e.stopPropagation();
      tgtHandle.setPointerCapture(e.pointerId);
      tgtHandle.classList.add('dragging');
      startX = e.clientX; startY = e.clientY;
      startTarget = sel.target.slice();
    });
    tgtHandle.addEventListener('pointermove', (e) => {
      if (!tgtHandle.hasPointerCapture(e.pointerId)) return;
      const sel = selectedLight();
      if (!sel || !isTargeted(sel)) return;
      const r = root.getBoundingClientRect();
      const dx = (e.clientX - startX) / r.width;
      const dy = (e.clientY - startY) / r.height;
      sel.target = [startTarget[0] + dx, startTarget[1] + dy, startTarget[2]];
      applyTargeting(sel);   // re-derive direction live
      place();
      redraw();
    });
    tgtHandle.addEventListener('pointerup', (e) => {
      tgtHandle.releasePointerCapture(e.pointerId);
      tgtHandle.classList.remove('dragging');
    });
  }
```

- [ ] **Step 5: Manual smoke**

Run the app. Select a spotlight, enable "Aim at target". On the 2D canvas: the direction handle is gone; a target handle with a tether appears. Drag the target.
Expected: target handle moves; the rendered beam re-aims toward the new target position as you drag; releasing leaves it stable.

- [ ] **Step 6: Commit**

```bash
git add web/src/handles.js
git commit -m "feat(web): 2D target handle; suppress direction handle when targeted"
```

---

## Task 7: 3D viewport — gizmo target drag, beam line + marker, rotate suppression

**Files:**
- Modify: `web/src/3d/gizmos.js` (add `onTargetMove` + `attachTarget`)
- Create: `web/src/3d/target-viz.js` (beam line + marker)
- Modify: `web/src/3d/index.js` (drive target-viz + choose gizmo attach + suppress rotate)

- [ ] **Step 1: Extend the gizmo to drive a target object**

In `web/src/3d/gizmos.js`, add `onTargetMove` to the `createGizmo` params (line 14):

```js
export function createGizmo({ camera, canvas, orbitControls, scene, onTranslate, onRotate, onTargetMove }) {
```

Add a state flag near the other attach state (after line 27, `let attachedLightType = 'point';`):

```js
  let attachedKind = 'light';   // 'light' | 'target'
  let attachedTargetLightId = null;
```

At the very top of the `objectChange` handler (immediately inside `gizmo.addEventListener('objectChange', () => {`, before the existing `if (!attachedLightId ...)` guard at line 31), add:

```js
    if (attachedKind === 'target') {
      if (!attachedTargetLightId || !attachedPrimitive) return;
      const g = attachedPrimitive;   // for target, the attached object IS the marker
      const engPos = worldToLight([g.position.x, g.position.y, g.position.z]);
      if (onTargetMove) onTargetMove(attachedTargetLightId, engPos);
      return;
    }
```

Add an `attachTarget` method (after the `attach` function, around line 69):

```js
  // Attach the gizmo (translate mode) to a target marker Object3D so dragging
  // it moves the light's target rather than its position.
  function attachTarget(markerObject, lightId) {
    if (attachedKind === 'target' && attachedPrimitive === markerObject) return;
    detach();
    attachedKind = 'target';
    attachedTargetLightId = lightId;
    attachedPrimitive = markerObject;
    gizmo.setMode('translate');
    gizmo.attach(markerObject);
  }
```

Update `detach` (line 71) to also clear the new state:

```js
  function detach() {
    attachedLightId = null;
    attachedPrimitive = null;
    attachedKind = 'light';
    attachedTargetLightId = null;
    gizmo.detach();
  }
```

Export `attachTarget` in the returned object (line 94):

```js
  return { gizmo, attach, attachTarget, detach, setMode, getMode, setCamera, dispose };
```

- [ ] **Step 2: Create the target-viz module**

Create `web/src/3d/target-viz.js`:

```js
/** Beam line + target marker for the currently-selected targeted light.
 *
 * One instance lives in the scene; show(light) positions a small sphere at the
 * light's target and draws a line from the light position to the target. hide()
 * removes them from view. The marker is returned so the gizmo can attach to it.
 */
import * as THREE from 'three';
import { lightToWorld } from './coords.js';

const MARKER_RADIUS = 0.04;

export function createTargetViz(scene) {
  const markerGeo = new THREE.SphereGeometry(MARKER_RADIUS, 16, 12);
  const markerMat = new THREE.MeshBasicMaterial({ color: 0xffff00 });
  const marker = new THREE.Mesh(markerGeo, markerMat);
  marker.visible = false;
  scene.add(marker);

  const lineMat = new THREE.LineBasicMaterial({ color: 0xffff00 });
  const lineGeo = new THREE.BufferGeometry().setFromPoints([
    new THREE.Vector3(), new THREE.Vector3(),
  ]);
  const line = new THREE.Line(lineGeo, lineMat);
  line.visible = false;
  scene.add(line);

  function show(light) {
    const lp = lightToWorld(light.position);
    const tp = lightToWorld(light.target);
    marker.position.set(tp[0], tp[1], tp[2]);
    marker.material.color.set(rgbToHex(light.color));
    marker.visible = true;
    const pos = line.geometry.attributes.position;
    pos.setXYZ(0, lp[0], lp[1], lp[2]);
    pos.setXYZ(1, tp[0], tp[1], tp[2]);
    pos.needsUpdate = true;
    line.material.color.set(rgbToHex(light.color));
    line.visible = true;
  }

  function hide() {
    marker.visible = false;
    line.visible = false;
  }

  function dispose() {
    scene.remove(marker); marker.geometry.dispose(); marker.material.dispose();
    scene.remove(line); line.geometry.dispose(); line.material.dispose();
  }

  return { marker, show, hide, dispose };
}

function rgbToHex(rgb) {
  const r = Math.round(Math.min(1, Math.max(0, rgb[0])) * 255);
  const g = Math.round(Math.min(1, Math.max(0, rgb[1])) * 255);
  const b = Math.round(Math.min(1, Math.max(0, rgb[2])) * 255);
  return (r << 16) | (g << 8) | b;
}
```

- [ ] **Step 3: Import targeting + target-viz in index.js**

At the top of `web/src/3d/index.js`, add:

```js
import { isTargeted } from '../targeting.js';
import { createTargetViz } from './target-viz.js';
```

Add a module-scoped handle near the other `let` declarations (after line 18, `let gizmoApi = null;`):

```js
let targetViz = null;
```

- [ ] **Step 4: Pass `onTargetMove` when creating the gizmo + create target-viz**

In `mount3D`, extend the `createGizmo({...})` call (lines 64–75) to add the `onTargetMove` callback:

```js
    onTargetMove: (id, pos) => {
      if (onLightChange) onLightChange(id, { target: pos });
    },
```

Immediately after the `createGizmo({...})` call (after line 75), add:

```js
  targetViz = createTargetViz(api.scene);
```

- [ ] **Step 5: In `syncLightsToScene`, choose attach + drive the viz**

Replace the gizmo-attach block in `syncLightsToScene` (lines 110–118) with:

```js
  // Attach gizmo to the selected light — or to its target marker when targeted.
  if (gizmoApi) {
    const selectedPrim = selectedId ? primitives.get(selectedId) : null;
    const selectedLight = lights.find((l) => l.id === selectedId);
    if (selectedLight && isTargeted(selectedLight) && targetViz) {
      targetViz.show(selectedLight);
      gizmoApi.attachTarget(targetViz.marker, selectedLight.id);
    } else {
      if (targetViz) targetViz.hide();
      if (selectedPrim && selectedLight) {
        gizmoApi.attach(selectedPrim, selectedLight.type);
      } else {
        gizmoApi.detach();
      }
    }
  }
```

- [ ] **Step 6: Dispose target-viz in `dispose3D`**

In `dispose3D` (line 153), after `if (gizmoApi) { ... }`, add:

```js
  if (targetViz) { targetViz.dispose(); targetViz = null; }
```

- [ ] **Step 7: Manual smoke**

Run the app. Select a spotlight, enable "Aim at target". In the 3D pane:
Expected: a yellow target marker appears with a beam line from the light to it; the translate gizmo is attached to the marker (not the light). Drag the marker — the beam line and the spotlight cone re-orient to keep landing on the target as you drag. Toggle off: marker + line disappear; the rotate gizmo returns to the light.

- [ ] **Step 8: Commit**

```bash
git add web/src/3d/gizmos.js web/src/3d/target-viz.js web/src/3d/index.js
git commit -m "feat(web): 3D target gizmo, beam line + marker, rotate suppression when targeted"
```

---

## Task 8: Integration — persistence round-trip + full verification

**Files:** none new — verification only. (Persistence already works: `serializeSceneState` returns `state.tree` whole, so the optional `target` field round-trips through `updateScene`/load with no code change.)

- [ ] **Step 1: Run all automated tests**

Run:
```bash
npm run test:unit
pytest packages/relighting_engine/tests/ -q
pytest packages/relighting_api/tests/ -q
```
Expected: all green.

- [ ] **Step 2: Persistence round-trip (manual)**

Run the app. Enable targeting on a spotlight, drag the target somewhere distinctive, wait for the "Saved" status. Reload the page (re-loads the scene from the backend).
Expected: the light comes back targeted, target marker + beam in the same place, image identical. Confirms `target` survives `serializeSceneState` → `updateScene` → `applyScene`, and that `applyScene`'s on-load `applyTargeting` reproduces the direction.

- [ ] **Step 3: Backward-compat (manual)**

Load a scene created before this feature (no `target` on any light).
Expected: loads unchanged, every light in free-aim mode, no target markers, no console errors.

- [ ] **Step 4: Run the parity smoke test**

Run: `npm run test:parity`
Expected: PASS (no visual regression for non-targeted scenes).

- [ ] **Step 5: Final commit (if any verification fixups were needed)**

```bash
git add -A
git commit -m "test(web,engine,api): verify light targeting round-trip and parity"
```

---

## Self-review notes (already reconciled in this plan)

- **Spec coverage:** data model (Tasks 2,3 + web `target` via Task 1 semantics), derivation rules (Task 1 + Task 2 engine fallback), interaction toggle (Task 5), 3D/2D dragging (Tasks 6,7), gizmo/handle/slider suppression (Tasks 5,6,7), visualization beam+marker+cone (Task 7 + existing cone follows `direction`), persistence (Task 8), testing across engine/web-unit/interaction/visual (Tasks 1,2,3,8). v1.1 snapping intentionally out of scope.
- **Type consistency:** helper names (`isTargeted`, `deriveDirection`, `targetSpawnPoint`, `applyTargeting`) used identically across Tasks 1,4,5,6,7. Engine `effective_direction` used in Task 2 only. Gizmo `attachTarget` / `onTargetMove` consistent across Task 7.
- **Coordinate space:** `target` is engine space everywhere (same as `position`); `lightToWorld`/`worldToLight` convert at the 3D boundary; 2D handle uses `target[0..1] * width/height` like `position`.
