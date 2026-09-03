# Readouts and Measuring Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give every rig fixture a throw distance and field-diameter readout, and add a two-click ruler that measures between any two points in either pane.

**Architecture:** One pure geometry module (`web/src/metric/measure.js`) is the single definition of both the readout math and the ruler's distance. Around it sit four thin consumers: two table/pane renderers that call it at render time and store nothing, and a DOM-free ruler state machine with one adapter per pane. Nothing is written onto the light object and nothing is persisted, so undo/redo and reload are correct for free.

**Tech Stack:** Vanilla ES modules, no framework. `node --test` for unit tests, Playwright for E2E, Three.js for the 3D pane, raw SVG for the 2D overlay.

**Spec:** `docs/superpowers/specs/2026-09-03-readouts-and-measuring-design.md`

## Global Constraints

- **Stored lengths are ALWAYS feet.** `web/src/metric/units.js` is the only place ft↔m conversion happens. New code returns raw feet and formats through `toDisplay` / `formatLength` / `parseLength`.
- **World frame:** origin at the centre of the stage lip on the deck; +X audience right; +Y up; +Z upstage (so the house occupies negative Z).
- **`cone_angle` is the field HALF-angle in radians.** `rig/presets.js` builds it as `(fieldDeg / 2) * Math.PI / 180`. Field diameter is `2 · throw · tan(cone_angle)`.
- **No server changes.** No API schema, no route, no Python. If a task appears to need one, stop and report.
- **No new dependencies.**
- **Test baseline to beat:** 200 JS unit, 154 engine pytest (+69 pre-existing skips), 131 API, 9 Playwright. Every task ends green against its own tests; Task 10 runs the whole gate.
- **Playwright runs only with no dev server on :8765**, workers: 1.
- **Real mouse input** for UI assertions, never synthetic events. Screenshot coordinates are ~10% off on this machine — run a `pointermove` probe to calibrate before any click-by-coordinate. `requestAnimationFrame` does not fire in the automation tab.
- **Commit per task**, message ending with:
  ```
  Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01SsetKcWaCBgLdSJa3zKWSc
  ```
- **Never push. Never open or update a PR.**
- **Leave the four untracked root paths alone** (`.superpowers/`, `AGENTS.md`, `CLAUDE.md`, `Working-with-Scripts-1024x683.png`). Keep every commit scoped to the task's files.

## File Structure

| File | Responsibility | Status |
| --- | --- | --- |
| `web/src/metric/measure.js` | Pure: plane hit, distance, throw/diameter, reason codes and tooltips. | Create (Task 1) |
| `web/src/measure-tool.js` | DOM-free ruler state machine + session measurement list. | Create (Task 5) |
| `web/src/measure-overlay-2d.js` | Photo-pane picking (depth sampler) + SVG rendering. | Create (Task 6) |
| `web/src/3d/measure-overlay.js` | Viewport raycast + `THREE.Line` and label sprite. | Create (Task 7) |
| `web/src/rig/rig-tab.js` | Two readout columns; `updateReadouts()`. | Modify (Tasks 2, 4) |
| `web/src/controls.js` | Props-pane readout block; `updateReadoutBlock()`. | Modify (Tasks 3, 4) |
| `web/src/main.js` | Mount tool, header wiring, Escape, clear-on-change, readout calls in `redraw()`. | Modify (Tasks 4, 6, 7, 8) |
| `web/playground.html` | Overlay layers, Measure toggle, Clear button. | Modify (Task 6) |
| `web/playground.css` | Overlay, toggle and readout-cell styling. | Modify (Tasks 2, 6) |

---

### Task 1: Pure readout geometry

**Files:**
- Create: `web/src/metric/measure.js`
- Test: `web/tests/unit/metric/measure.test.js`

**Interfaces:**
- Consumes: `defaultHouse(venue)` from `web/src/rig/geometry.js`.
- Produces:
  - `distanceFt(a, b) → number`
  - `planeHitY(origin, dir, y) → [x,y,z] | null`
  - `insideHouse(pt, venue) → boolean`
  - `throwAndDiameter(light, venue) → { throwFt: number|null, fieldDiaFt: number|null, reason: string }`
  - `reasonTooltip(reason) → string` (empty string for `'ok'`)

- [ ] **Step 1: Write the failing test**

Create `web/tests/unit/metric/measure.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { distanceFt, planeHitY, insideHouse, throwAndDiameter, reasonTooltip } from '../../../src/metric/measure.js';
import { SYNTHETIC_VENUE } from '../../../src/rig/geometry.js';
import { applyFixturePreset } from '../../../src/rig/presets.js';

const V = SYNTHETIC_VENUE;                 // 40 × 20 × 30, focus_height_ft 5
const near = (a, b, t = 1e-6) => assert.ok(Math.abs(a - b) <= t, `${a} !~ ${b}`);

// ── planeHitY ────────────────────────────────────────────────────────────
test('planeHitY: a downward ray crosses the focus plane', () => {
  const p = planeHitY([0, 20, -10], [0, -1, 0], 5);
  assert.deepEqual(p, [0, 5, -10]);
});

test('planeHitY: a ray parallel to the plane never crosses it', () => {
  assert.equal(planeHitY([0, 5, -10], [0, 0, 1], 5), null);
});

test('planeHitY: a ray pointing away from the plane does not count', () => {
  assert.equal(planeHitY([0, 20, -10], [0, 1, 0], 5), null);
});

test('planeHitY: a ray starting on the plane does not count (t = 0)', () => {
  assert.equal(planeHitY([0, 5, -10], [0, -1, 0], 5), null);
});

// ── insideHouse ──────────────────────────────────────────────────────────
test('insideHouse: stage centre is in, a point past the side wall is out', () => {
  assert.equal(insideHouse([0, 5, 10], V), true);
  assert.equal(insideHouse([999, 5, 10], V), false);
});

test('insideHouse: a point beyond the back of the house is out', () => {
  assert.equal(insideHouse([0, 5, -1000], V), false);
});

// ── throwAndDiameter: aimed ──────────────────────────────────────────────
test('throwAndDiameter: an aimed fixture reports the distance to its target', () => {
  const L = { type: 'spotlight', position_ft: [0, 25, -30], target_ft: [0, 5, -30], cone_angle: 0.2 };
  const r = throwAndDiameter(L, V);
  assert.equal(r.reason, 'ok');
  near(r.throwFt, 20);
  near(r.fieldDiaFt, 2 * 20 * Math.tan(0.2));
});

// ── Photometric goldens: the only external check on the geometry ─────────
test('golden: a Source Four 26 deg at a 30 ft throw gives ETC published 13.9 ft field', () => {
  const L = applyFixturePreset({ type: 'spotlight', direction: [0, -1, 0], position: [0, 0, 0] }, 'ers', 26);
  L.position_ft = [0, 30, 0];
  L.target_ft = [0, 0, 0];
  const r = throwAndDiameter(L, V);
  assert.equal(r.reason, 'ok');
  near(r.throwFt, 30, 1e-9);
  assert.ok(Math.abs(r.fieldDiaFt - 13.9) <= 0.05, `field ${r.fieldDiaFt} not within 0.05 of 13.9`);
});

test('golden: a PAR MFL (35 deg) at a 20 ft throw gives 12.6 ft field', () => {
  const L = applyFixturePreset({ type: 'spotlight', direction: [0, -1, 0], position: [0, 0, 0] }, 'par', 'MFL');
  L.position_ft = [0, 20, 0];
  L.target_ft = [0, 0, 0];
  const r = throwAndDiameter(L, V);
  assert.ok(Math.abs(r.fieldDiaFt - 12.6) <= 0.05, `field ${r.fieldDiaFt} not within 0.05 of 12.6`);
});

// ── throwAndDiameter: unaimed falls to the focus plane ───────────────────
test('throwAndDiameter: an unaimed fixture measures to the focus-height plane', () => {
  const L = { type: 'spotlight', position_ft: [0, 25, 0], direction_ft: [0, -1, 0], cone_angle: 0.2 };
  const r = throwAndDiameter(L, V);
  assert.equal(r.reason, 'ok');
  near(r.throwFt, 20);                        // 25 ft trim down to 5 ft focus height
});

// ── reason codes ─────────────────────────────────────────────────────────
test('reason not-calibrated: no position_ft', () => {
  assert.equal(throwAndDiameter({ type: 'spotlight', cone_angle: 0.2 }, V).reason, 'not-calibrated');
});

test('reason no-beam: a linear (cyc) fixture and a reflector', () => {
  assert.equal(throwAndDiameter({ type: 'linear', position_ft: [0, 5, 0], cone_angle: 0.2 }, V).reason, 'no-beam');
  assert.equal(throwAndDiameter({ type: 'reflector', position_ft: [0, 5, 0], cone_angle: 0.2 }, V).reason, 'no-beam');
});

test('reason no-beam: a hand-edited cone_angle of 0 or 90 degrees', () => {
  const base = { type: 'spotlight', position_ft: [0, 25, 0], direction_ft: [0, -1, 0] };
  assert.equal(throwAndDiameter({ ...base, cone_angle: 0 }, V).reason, 'no-beam');
  assert.equal(throwAndDiameter({ ...base, cone_angle: Math.PI / 2 }, V).reason, 'no-beam');
});

test('reason no-crossing: a flat shin never reaches the focus plane', () => {
  const L = { type: 'spotlight', position_ft: [-20, 5, 10], direction_ft: [1, 0, 0], cone_angle: 0.2 };
  assert.equal(throwAndDiameter(L, V).reason, 'no-crossing');
});

test('reason no-crossing: a near-parallel beam hits the plane outside the house', () => {
  // A shallow ray from a 25 ft trim: crosses y = 5 about 2000 ft downstage.
  const L = { type: 'spotlight', position_ft: [0, 25, 0], direction_ft: [0, -0.01, 1], cone_angle: 0.2 };
  assert.equal(throwAndDiameter(L, V).reason, 'no-crossing');
});

test('reason degenerate: the target sits on the fixture', () => {
  const L = { type: 'spotlight', position_ft: [0, 12, 5], target_ft: [0, 12, 5], cone_angle: 0.2 };
  assert.equal(throwAndDiameter(L, V).reason, 'degenerate');
});

test('reason no-venue: an unaimed fixture with no venue', () => {
  const L = { type: 'spotlight', position_ft: [0, 25, 0], direction_ft: [0, -1, 0], cone_angle: 0.2 };
  assert.equal(throwAndDiameter(L, null).reason, 'no-venue');
});

test('an aimed fixture still reports numbers with no venue', () => {
  const L = { type: 'spotlight', position_ft: [0, 25, 0], target_ft: [0, 5, 0], cone_angle: 0.2 };
  assert.equal(throwAndDiameter(L, null).reason, 'ok');
});

// ── contract ─────────────────────────────────────────────────────────────
test('values are raw feet, never formatted, and ok has no tooltip', () => {
  const L = { type: 'spotlight', position_ft: [0, 25, 0], target_ft: [0, 5, 0], cone_angle: 0.2 };
  assert.equal(typeof throwAndDiameter(L, V).throwFt, 'number');
  assert.equal(reasonTooltip('ok'), '');
  assert.ok(reasonTooltip('no-crossing').length > 0);
});

test('distanceFt is a plain 3D euclidean distance', () => {
  near(distanceFt([0, 0, 0], [3, 4, 0]), 5);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test web/tests/unit/metric/measure.test.js`
Expected: FAIL — `Cannot find module '.../src/metric/measure.js'`

- [ ] **Step 3: Write minimal implementation**

Create `web/src/metric/measure.js`:

```js
// Per-fixture readout geometry (Spec 3). Pure: no DOM, no Three, so the rig
// tab, the props pane, the ruler and node --test all share one definition.
// World frame of Spec 1 (feet; +X audience right, +Y up, +Z upstage; origin
// at the centre of the lip on the deck, so the house is at negative Z).
import { defaultHouse } from '../rig/geometry.js';

const EPS = 1e-9;
const MIN_CONE = 1e-4;                        // radians: below this there is no pool
const MAX_CONE = 89 * Math.PI / 180;          // half-angle: tan explodes past this
const NO_BEAM_TYPES = new Set(['linear', 'reflector']);

/** Plain 3D euclidean distance in feet. */
export function distanceFt(a, b) {
  return Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
}

/**
 * Where origin + t·dir crosses the horizontal plane Y = y, or null when the
 * ray is parallel to it, points away from it, or already starts on it.
 */
export function planeHitY(origin, dir, y) {
  if (!Array.isArray(origin) || !Array.isArray(dir)) return null;
  if (Math.abs(dir[1]) < EPS) return null;
  const t = (y - origin[1]) / dir[1];
  if (!(t > EPS)) return null;
  return [origin[0] + dir[0] * t, y, origin[2] + dir[2] * t];
}

/**
 * True when a point lies inside the venue's house-box footprint. Used to
 * reject a mathematically valid focus-plane hit hundreds of feet outside the
 * building (a beam aimed almost parallel to the plane).
 */
export function insideHouse(pt, venue) {
  if (!Array.isArray(pt) || !venue) return false;
  const h = venue.house || defaultHouse(venue);
  return pt[0] >= h.left_wall_ft && pt[0] <= h.right_wall_ft
    && pt[2] >= -h.depth_ft && pt[2] <= venue.depth_ft;
}

/**
 * Throw distance and field diameter for one fixture, both in feet.
 * `reason` is 'ok' when both are numbers, else why they are null:
 *   no-beam        cyc/linear/reflector, or cone_angle outside (0°, 89°)
 *   no-crossing    axis parallel to the focus plane, aimed away from it, or
 *                  crossing it outside the house box
 *   degenerate     the target sits on the fixture
 *   no-venue       unaimed, and there is no venue to supply a focus height
 *   not-calibrated no position_ft
 */
export function throwAndDiameter(light, venue) {
  const none = (reason) => ({ throwFt: null, fieldDiaFt: null, reason });
  if (!light || !Array.isArray(light.position_ft)) return none('not-calibrated');
  if (NO_BEAM_TYPES.has(light.type)) return none('no-beam');
  const cone = light.cone_angle;
  if (!Number.isFinite(cone) || cone < MIN_CONE || cone > MAX_CONE) return none('no-beam');

  let aim = Array.isArray(light.target_ft) ? light.target_ft : null;
  if (!aim) {
    if (!venue) return none('no-venue');
    aim = planeHitY(light.position_ft, light.direction_ft, venue.focus_height_ft ?? 5);
    if (!aim || !insideHouse(aim, venue)) return none('no-crossing');
  }
  const throwFt = distanceFt(light.position_ft, aim);
  if (!(throwFt > EPS)) return none('degenerate');
  return { throwFt, fieldDiaFt: 2 * throwFt * Math.tan(cone), reason: 'ok' };
}

const TOOLTIPS = {
  'no-beam': 'No usable beam angle for this fixture',
  'no-crossing': 'This beam never crosses the focus height',
  degenerate: 'Target is at the fixture',
  'no-venue': 'No venue: aim this fixture to get a throw',
  'not-calibrated': 'Calibrate the scene to measure',
};

/** Tooltip for a reason code; '' for 'ok'. */
export function reasonTooltip(reason) {
  return TOOLTIPS[reason] || '';
}
```

Note on copy: the spec's example tooltip for `no-beam` was *"A cyc has no beam angle"*, written for the cyc case. Because that code also covers reflectors and out-of-range hand-edited cone angles, the message is generalised to *"No usable beam angle for this fixture"*. Record this in the spec's Deviations section in Task 10.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test web/tests/unit/metric/measure.test.js`
Expected: PASS, all tests

- [ ] **Step 5: Run the whole unit suite for regressions**

Run: `npm run test:unit`
Expected: PASS — 200 previous + the new file's tests

- [ ] **Step 6: Commit**

```bash
git add web/src/metric/measure.js web/tests/unit/metric/measure.test.js
git commit -F - <<'MSG'
feat(measure): pure throw and field-diameter geometry

Spec 3 decisions 1, 2, 10 and 15: diameter perpendicular to the beam axis at
the target, throw resolved against the focus-height plane, field angle rather
than beam, and one reason enum behind every em dash. Photometric goldens
assert the formula against ETC published data for an S4 26 and a PAR MFL.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01SsetKcWaCBgLdSJa3zKWSc
MSG
```

---

### Task 2: Readout columns in the fixtures table

**Files:**
- Modify: `web/src/metric/measure.js` (add `readoutCellText`)
- Modify: `web/src/rig/rig-tab.js` (`renderFixturesTable`, around lines 499–605)
- Modify: `web/src/pane-divider.js:15` (default rig pane width — see ruling P4)
- Modify: `web/playground.css`
- Test: `web/tests/unit/metric/measure.test.js`
- Test: `web/tests/unit/pane-divider.test.js` (the 580 assertions)

**Interfaces:**
- Consumes: `throwAndDiameter`, `reasonTooltip` (Task 1); `toDisplay` from `./units.js`; existing `el`, `cell` helpers in `rig-tab.js`.
- Produces:
  - `readoutCellText(light, venue, units, kind) → { text, title }` exported from **`web/src/metric/measure.js`** — `kind` is `'throw'` or `'dia'`.
  - two `<td>` per fixture row carrying `data-readout="throw"` and `data-readout="dia"`. Task 4 updates these in place; Tasks 4 and 9 select on them.

**Placement note (controller ruling P1):** `readoutCellText` lives in `metric/measure.js`, NOT in `rig-tab.js`. Task 3 needs it from `controls.js`, and reaching into the rig tab module for one pure text helper would drag the whole rig tab into the props pane's dependency graph. `measure.js` is pure, is the readout module, and is already imported by both consumers.

- [ ] **Step 1: Write the failing test**

Append to `web/tests/unit/metric/measure.test.js` (add `readoutCellText` to that file's existing import from `../../../src/metric/measure.js`):

```js
test('readoutCellText: an aimed fixture formats throw and diameter in the display unit', () => {
  const L = { type: 'spotlight', position_ft: [0, 25, 0], target_ft: [0, 5, 0], cone_angle: 0.2 };
  const V = { width_ft: 40, height_ft: 20, depth_ft: 30, focus_height_ft: 5 };
  assert.equal(readoutCellText(L, V, 'ft', 'throw').text, '20.0');
  assert.equal(readoutCellText(L, V, 'ft', 'throw').title, '');
  assert.equal(readoutCellText(L, V, 'm', 'throw').text, '6.1');
});

test('readoutCellText: a cyc shows an em dash and the reason tooltip', () => {
  const L = { type: 'linear', position_ft: [0, 5, 0], cone_angle: 0.2 };
  const V = { width_ft: 40, height_ft: 20, depth_ft: 30, focus_height_ft: 5 };
  const r = readoutCellText(L, V, 'ft', 'dia');
  assert.equal(r.text, '—');
  assert.ok(r.title.length > 0);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test web/tests/unit/metric/measure.test.js`
Expected: FAIL — `readoutCellText` is not exported

- [ ] **Step 3: Write minimal implementation**

In `web/src/metric/measure.js`, add the units import at the top:

```js
import { toDisplay } from './units.js';
```

and the pure cell helper at the end of the module:

```js
/**
 * Text and tooltip for one readout cell. `kind` is 'throw' or 'dia'.
 * Pure so the fixtures table, the props pane and node --test can never word
 * the same fixture state differently.
 */
export function readoutCellText(light, venue, units, kind) {
  const r = throwAndDiameter(light, venue);
  if (r.reason !== 'ok') return { text: '—', title: reasonTooltip(r.reason) };
  const v = kind === 'throw' ? r.throwFt : r.fieldDiaFt;
  return { text: toDisplay(v, units).toFixed(1), title: '' };
}
```

In `web/src/rig/rig-tab.js`, add the import beside the existing `../metric/units.js` import:

```js
import { readoutCellText } from '../metric/measure.js';
```

In `renderFixturesTable`, extend the header row (currently line ~503) from 8 to 10 columns:

```js
for (const h of ['Name', 'Type', 'Option', 'Position', `Offset (${units})`, 'Area',
                 `Throw (${units})`, `Ø (${units})`, 'On', '']) hr.appendChild(el('th', null, h));
```

Update the group header's span in the same function (currently `th.colSpan = 8`):

```js
th.colSpan = 10;
```

In the fixture row loop, immediately after the Area cell is appended (`tr.appendChild(cell(areaSel));`) and before the `On` checkbox, add:

```js
for (const kind of ['throw', 'dia']) {
  const { text, title } = readoutCellText(L, venue, units, kind);
  const td = cell(text, 'rig-muted rig-readout');
  td.dataset.readout = kind;
  if (title) td.title = title;
  tr.appendChild(td);
}
```

Add to `web/playground.css` (beside the other `.rig-table` rules):

```css
.rig-readout { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
```

**Ruling P4 — the default rig pane width must grow with the table.** Two new columns add ~83px of content, and `web/tests/smoke-rig.spec.js:92` asserts the fixtures table fits the default pane width without a horizontal scroll. `web/src/pane-divider.js:15` carries that contract in its own comment. Update it:

```js
export const DEFAULT_PANE_WIDTHS = { lights: 260, rig: 670 };   // Rig: both tables fit without a horizontal scroll (10-column fixtures table)
```

Then update the five hard-coded `580`s in `web/tests/unit/pane-divider.test.js` (the test name on line 11, the `deepEqual` on line 14, and the `resolveTabWidth` assertions on lines 44–48) to `670`.

Do **not** relax the smoke assertion to allow scrolling — it is the only thing that caught this, and weakening it to accommodate new work is how regressions hide. `DEFAULT_PANE_WIDTHS` is a default and a double-click reset target only: `MIN_PANE_WIDTH` (220) and `MAX_PANE_FRACTION` (0.6) are separate, and a user with a stored rig width keeps it.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test web/tests/unit/metric/measure.test.js`
Expected: PASS

- [ ] **Step 5: Verify the table still renders end to end**

Run: `npx playwright test --config=web/tests/playwright.config.js web/tests/smoke-rig.spec.js`
Expected: PASS (this spec asserts rig-table structure, so a colSpan mistake shows up here)

- [ ] **Step 6: Commit**

```bash
git add web/src/metric/measure.js web/src/rig/rig-tab.js web/playground.css web/tests/unit/metric/measure.test.js
git commit -F - <<'MSG'
feat(rig): throw and field-diameter columns in the fixtures table

Spec 3 decision 3, table half. readoutCellText is pure so the table and the
props pane cannot word the same state differently; the cells carry
data-readout so Task 4 can update them without rebuilding the table.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01SsetKcWaCBgLdSJa3zKWSc
MSG
```

---

### Task 3: Props-pane readout block

**Files:**
- Modify: `web/src/controls.js` (`renderLightProps`, after the rig fieldset that ends around line 311)
- Modify: `web/playground.css`
- Test: `web/tests/unit/metric/measure.test.js` (extend)

**Interfaces:**
- Consumes: `readoutCellText` from `./metric/measure.js` (added in Task 2, per controller ruling P1).
- Produces: `updateReadoutBlock(container, light, venue, units) → void`, exported from `controls.js`; markup `div.readout-block` containing `[data-readout="throw"]` and `[data-readout="dia"]`.

- [ ] **Step 1: Write the failing test**

Create `web/tests/unit/readout-block.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readoutCellText } from '../../src/metric/measure.js';

// The block's DOM write is exercised in Playwright (Task 10); here we lock
// the contract that the props pane and the table share one text source.
test('props block and table cell derive identical text for the same fixture', () => {
  const L = { type: 'spotlight', position_ft: [0, 25, 0], target_ft: [0, 5, 0], cone_angle: 0.2 };
  const V = { width_ft: 40, height_ft: 20, depth_ft: 30, focus_height_ft: 5 };
  for (const kind of ['throw', 'dia']) {
    for (const u of ['ft', 'm']) {
      const a = readoutCellText(L, V, u, kind);
      const b = readoutCellText(L, V, u, kind);
      assert.deepEqual(a, b);
      assert.ok(a.text.length > 0);
    }
  }
});
```

Note: `web/tests/unit/*.test.js` is already in the `test:unit` glob, so no script change.

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test web/tests/unit/readout-block.test.js`
Expected: FAIL if Task 2 is incomplete (`readoutCellText` not exported); PASS once Task 2 landed. If it passes immediately, that is the intended state — this file's purpose is to pin the shared-source contract for later refactors.

- [ ] **Step 3: Write minimal implementation**

In `web/src/controls.js`, add near the existing imports:

```js
import { readoutCellText } from './metric/measure.js';
```

Inside `renderLightProps`, immediately after the rig fieldset is appended to the container, add the block markup (feet-space fixtures only — the block is hidden when there is no calibration, per the spec's `not-calibrated` row):

```js
  // Spec 3: throw and field diameter for the selected fixture. Values are
  // written by updateReadoutBlock so a drag can refresh them without
  // re-rendering the whole props pane.
  const readout = document.createElement('div');
  readout.className = 'readout-block';
  readout.innerHTML = `
    <div class="readout-row"><span class="readout-key">Throw</span><span class="readout-val" data-readout="throw">—</span></div>
    <div class="readout-row"><span class="readout-key">Field Ø</span><span class="readout-val" data-readout="dia">—</span></div>
  `;
  container.appendChild(readout);
  updateReadoutBlock(container, L, state.venue, state.units || 'ft');
```

Add the exported updater at module scope:

```js
/**
 * Refresh the props-pane readout values in place. Safe to call on every
 * redraw: it writes only when the text actually changed, and no-ops when the
 * pane is not showing a light.
 */
export function updateReadoutBlock(container, light, venue, units = 'ft') {
  if (!container || !light) return;
  const block = container.querySelector('.readout-block');
  if (!block) return;
  for (const kind of ['throw', 'dia']) {
    const el = block.querySelector(`[data-readout="${kind}"]`);
    if (!el) continue;
    const { text, title } = readoutCellText(light, venue, units, kind);
    if (el.textContent !== text) el.textContent = text;
    if (el.title !== title) el.title = title;
  }
}
```

Add to `web/playground.css`:

```css
.readout-block { margin: 8px 0; padding: 6px 8px; border-radius: 4px; background: var(--panel-2, rgba(127,127,127,.08)); }
.readout-row { display: flex; justify-content: space-between; gap: 12px; line-height: 1.6; }
.readout-key { opacity: .75; }
.readout-val { font-variant-numeric: tabular-nums; }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run test:unit`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add web/src/controls.js web/playground.css web/tests/unit/readout-block.test.js
git commit -F - <<'MSG'
feat(props): throw and field-diameter block for the selected fixture

Spec 3 decision 3, props-pane half. The block reads the same pure
readoutCellText as the table so the two surfaces cannot disagree, and
updateReadoutBlock writes in place so Task 4 can refresh it per frame.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01SsetKcWaCBgLdSJa3zKWSc
MSG
```

---

### Task 4: Live readout updates during a drag

**Files:**
- Modify: `web/src/rig/rig-tab.js` (add `updateReadouts` to `mountRigTab`'s returned API)
- Modify: `web/src/main.js` (`redraw`, around line 275)
- Test: `web/tests/smoke-measure.spec.js` (create; first test only)

**Interfaces:**
- Consumes: `readoutCellText` (Task 2), `updateReadoutBlock` (Task 3).
- Produces: `rigTab.updateReadouts() → void`.

**Why no fast-path/slow-path split:** `updateReadouts()` recomputes every visible row through the same `readoutCellText` the full render uses, and only the DOM write differs. There is no separate dragged-fixture formula that could drift.

- [ ] **Step 1: Write the failing test**

Create `web/tests/smoke-measure.spec.js` with ONE shared setup helper. **Controller ruling P3:** the plan originally said to copy the setup into each test; that would be five verbatim copies of a logic block, which the review rubric treats as a defect. Every later test in this file calls the helper — none re-copies the setup.

**Controller ruling P2:** the selectors below are verified against `smoke-rig.spec.js:69–77` and `handles.js:88`. The 2D light handle class is `handle`, not `light-handle`; there is no `.rig-position` or `.rig-add` in the source.

```js
import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import { createSceneFromFixture, PORTRAIT_A } from './helpers.js';

test.setTimeout(180_000);

const CALIBRATION = {
  version: 1, units: 'ft', width_ft: 40, height_ft: 20, depth_ft: 30,
  marks: { lipL: [0.1, 0.61333], lipR: [0.9, 0.61333], top: [0.5, 0.08], backL: [0.23333, 0.54222], backR: [0.76667, 0.54222] },
  depth_fit: { a: -0.037037, b: 0.024074 }, depth_check: null,
};

/** A calibrated scene in split view with a venue, Rig tab open. Returns the console-error sink. */
async function calibratedRigScene(page, name) {
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.setViewportSize({ width: 1600, height: 900 });
  await createSceneFromFixture(page, { name, viewMode: 'split' });
  await page.evaluate((cal) => { window.__state.calibration = cal; window.__applyCalibration(); }, CALIBRATION);
  await expect(page.locator('#calibrate-btn')).toHaveText(/40 × 20 × 30 ft/);
  await page.locator('#tree-pane .pane-tabs button[data-tab="rig"]').click();
  await expect(page.locator('#rig-root .rig-positions tbody tr')).toHaveCount(6);
  return { errors };
}

/** Add a fixture on the first hang position (FOH). Same click path as smoke-rig.spec.js:75. */
async function addHungFixture(page) {
  // Uses the venue's SECOND hang position ("1E", onstage), not FOH: FOH
  // projects outside this test's photographed frame (position_eng Y ~= -0.67),
  // so handles.js treats its 2D handle as off-frame and renders an edge arrow
  // instead, leaving boundingBox() null. Returns the new fixture's id so the
  // drag and the asserted cell refer to the SAME light — handles build in
  // state.lights order while the table renders position groups before Custom,
  // so a .first() on each side would select different lights.
  const rowsBefore = await page.locator('#rig-root .rig-fixtures tr.rig-fixture').count();
  await page.locator('#rig-root .rig-positions tbody tr').nth(1)
    .locator('.rig-actions .rig-btn').first().click();
  await expect(page.locator('#rig-root .rig-fixtures tr.rig-fixture')).toHaveCount(rowsBefore + 1);
  const id = await page.evaluate(() => window.__state.selectedId);
  // Deliberately NOT aimed: this assertion is the end-to-end proof of ruling
  // T4-B (a hung fixture gets a default aim at stage centre). Aiming it here
  // would hide a regression in that default.
  await expect(page.locator(`#rig-root tr[data-id="${id}"] [data-readout="throw"]`)).not.toHaveText('—');
  return id;
}

test('readouts: columns populate, and a real-mouse drag moves the throw live', async ({ page }) => {
  test.skip(!fs.existsSync(PORTRAIT_A), 'fixture missing');
  const { errors } = await calibratedRigScene(page, 'smoke-measure-readouts');
  await addHungFixture(page);

  const throwCell = page.locator('#rig-root tr.rig-fixture [data-readout="throw"]').first();
  await expect(throwCell).not.toHaveText('—');
  const before = await throwCell.textContent();

  // Calibrate the pointer: screenshot coords are ~10% off on this machine.
  const handle = page.locator('#handles .handle').first();
  const box = await handle.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  // Assert DURING the drag, before release — this is the live guarantee.
  await page.mouse.move(box.x + box.width / 2 + 120, box.y + box.height / 2 - 60, { steps: 12 });
  await expect(throwCell).not.toHaveText(before);
  await page.mouse.up();

  expect(errors).toEqual([]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx playwright test --config=web/tests/playwright.config.js web/tests/smoke-measure.spec.js`
Expected: FAIL — the cell text does not change mid-drag (the table is not refreshed on pointermove)

- [ ] **Step 3: Write minimal implementation**

In `web/src/rig/rig-tab.js`, inside `mountRigTab`, add:

```js
  /**
   * Refresh only the readout cells, without rebuilding the table. Called on
   * every redraw (including each pointermove of a drag), so it must stay
   * allocation-light and write only what changed.
   */
  function updateReadouts() {
    if (!rootEl) return;
    const st = getState();
    const units = st.units || 'ft';
    for (const tr of rootEl.querySelectorAll('tr.rig-fixture[data-id]')) {
      const L = st.lights?.find((x) => x.id === tr.dataset.id);
      if (!L) continue;
      // One geometry solve per fixture, both cells formatted from it — see
      // ruling M3. Calling readoutCellText per kind would re-run
      // throwAndDiameter twice per fixture on every pointermove.
      const r = throwAndDiameter(L, st.venue);
      const title = r.reason === 'ok' ? '' : reasonTooltip(r.reason);
      for (const [kind, v] of [['throw', r.throwFt], ['dia', r.fieldDiaFt]]) {
        const td = tr.querySelector(`[data-readout="${kind}"]`);
        if (!td) continue;
        const text = r.reason === 'ok' ? toDisplay(v, units).toFixed(1) : '—';
        if (td.textContent !== text) td.textContent = text;
        if (td.title !== title) td.title = title;
      }
    }
  }
```

and add it to the returned object alongside `render`:

```js
  return { render, updateReadouts };
```

(Keep every other key the existing return already has.)

In `web/src/main.js`, import the updater beside the existing `./controls.js` import:

```js
import { renderProps, renderAddLightPicker, setGoboPresets, updateReadoutBlock } from './controls.js';
```

Then extend `redraw` (line ~275) so the readouts refresh at the END of it — after `syncDraggedLights()` has already re-derived the feet fields:

```js
const redraw = () => {
  // ... existing body unchanged ...
  rigTab?.updateReadouts();
  const sel = state.lights?.find((L) => L.id === state.selectedId);
  if (sel) updateReadoutBlock(document.getElementById('props-content'), sel, state.venue, state.units || 'ft');
};
```

**Ordering constraint:** these two calls must be the last thing `redraw` does. Placing them in the handle callback instead would read the previous frame's `position_ft`.

- [ ] **Step 3b: Directed cleanups from the Task 3 review**

Four Minor findings from Task 3's review, folded here because this task rewrites the per-frame path and touches both readout consumers. All four are defects in the plan's own earlier text, not in the Task 3 implementation.

**M1 — delete `web/tests/unit/readout-block.test.js`.** It calls one pure function twice with identical arguments and asserts `deepEqual`, so it can only fail if the function becomes non-deterministic. It does not prove the two call sites render identically, which is what its name claims. The real cross-surface guarantee is structural (both surfaces call the same function) and is asserted end-to-end by Task 9's units test. Unit count goes 223 → 222; that is correct, not a regression.

**M2 — `.readout-block` uses an undefined CSS variable.** `--panel-2` is defined nowhere in the codebase, so the `var()` always resolves to its hardcoded fallback and the block never participates in the light/dark theme swap. Replace the rule in `web/playground.css` with real tokens:

```css
.readout-block { margin: 8px 0; padding: 6px 8px; border-radius: 4px;
                 background: var(--bg-hover); border: 1px solid var(--border); }
```

**M3 — one geometry solve per fixture per frame.** Already applied to `updateReadouts` in Step 3 above. Apply the same shape to `updateReadoutBlock` in `web/src/controls.js`: call `throwAndDiameter(light, venue)` once, derive both values and the shared tooltip from that single result, instead of calling `readoutCellText` once per kind. Keep `readoutCellText` exported and unchanged — Task 2's static table render still uses it per cell, where the double solve does not occur.

**M4 — move the readout block next to the rig fieldset.** Task 3 appended it after the entire `container.innerHTML` template, which puts it below Type, Position, Direction, Intensity, Color, Kelvin, Cone, Softness, Falloff, Gobo, Affects and Enabled — the bottom of a long pane, likely below the fold. These numbers describe the fixture's rig geometry, so they belong with the rig fields. Move the `.readout-block` markup into the template immediately after the rig fieldset (`controls.js` around lines 269–276) rather than appending it afterwards, and keep `updateReadoutBlock(container, L, state.venue, state.units || 'ft')` as the call that fills it once the template is in the DOM.

- [ ] **Step 3c: Ruling T4-B — give a hung fixture a default aim**

A product bug this task surfaced, not a test problem. `buildFixtureLight` (`web/src/rig/rig-tab.js`) never sets a direction, so a new rig fixture inherits `newLightNode`'s `fill` preset (`web/src/lights.js:56`, `direction: [0.4, 0.0, -1]` — Y exactly zero). That preset was written for a portrait-relighting fill light, not a theatre instrument on a pipe 52 ft out in the house. Perfectly horizontal means `planeHitY` rejects it, so **every freshly added, unaimed rig fixture reports `no-crossing`, always.**

The spec accepts an em dash for beams that genuinely never cross the focus plane (a flat shin, an uplight). It does not sanction every new fixture being flat by accident, and Task 1's own unaimed golden uses `[0, -1, 0]` — the intent was always that unaimed means "measures to the focus plane."

In `buildFixtureLight`, when `position` is non-null:

```js
// A fixture hung on a position points at the stage, not along the generic
// fill default it would otherwise inherit from newLightNode (lights.js:56,
// direction [0.4, 0, -1] — perfectly horizontal, so it never crosses the
// focus-height plane and every readout reads no-crossing).
const from = positionToWorld(position, offsetFt);
const to = [0, venue?.focus_height_ft ?? 5, (venue?.depth_ft ?? 30) / 2];
const d = [0, 1, 2].map((i) => to[i] - from[i]);
const n = Math.hypot(...d) || 1;
L.direction_ft = d.map((c) => c / n);
```

Custom fixtures (no `position`) keep the existing default — they hang on nothing, so there is no stage-relative aim to infer. `syncLightFromFeet` preserves a pre-set `direction_ft` (`light-metric.js:42` fills it only when absent), so this survives the rig sync.

A default *aim* is an inference; a default *area* would be a claim, which is why this does not auto-assign an Area and flip that column from "—" to a cell the designer never picked.

Add a unit test: a fixture on the FOH position gets a `direction_ft` with Y < 0 pointing upstage (positive Z). The E2E then asserts the freshly-added **unaimed** fixture shows a number, which is the end-to-end proof of this ruling — do not aim the test fixture first, as that would mask exactly this bug.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx playwright test --config=web/tests/playwright.config.js web/tests/smoke-measure.spec.js`
Expected: PASS

- [ ] **Step 5: Run the full Playwright config**

Run: `npx playwright test --config=web/tests/playwright.config.js`
Expected: PASS — 9 previous + 1 new. This task changes a per-frame path, so parity goldens must be confirmed, not assumed.

- [ ] **Step 6: Commit**

```bash
git add web/src/rig/rig-tab.js web/src/main.js web/tests/smoke-measure.spec.js
git commit -F - <<'MSG'
feat(rig): readouts track a drag live and settle on release

Spec 3 decision 9. updateReadouts rewrites only changed cell text, and both
it and the props block are called at the end of redraw so they read the feet
fields syncDraggedLights has already re-derived. Same pure text source as the
full render, so the live and settled paths cannot diverge.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01SsetKcWaCBgLdSJa3zKWSc
MSG
```

---

### Task 5: Ruler state machine

**Files:**
- Create: `web/src/measure-tool.js`
- Test: `web/tests/unit/measure-tool.test.js`

**Interfaces:**
- Consumes: `distanceFt` from `./metric/measure.js`.
- Produces:
  ```js
  createMeasureTool({ onChange }) → {
    arm(), disarm(), cancel(), clear(),
    addPoint(worldFt) → measurement | null,
    isArmed() → boolean,
    phase() → 'idle' | 'awaitingA' | 'awaitingB',
    pendingA() → [x,y,z] | null,
    measurements() → [{ id, a, b }]
  }
  ```

- [ ] **Step 1: Write the failing test**

Create `web/tests/unit/measure-tool.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMeasureTool } from '../../src/measure-tool.js';

const mk = () => { let n = 0; const t = createMeasureTool({ onChange: () => { n += 1; } }); return { t, calls: () => n }; };

test('idle by default: addPoint is ignored until armed', () => {
  const { t } = mk();
  assert.equal(t.phase(), 'idle');
  assert.equal(t.addPoint([0, 0, 0]), null);
  assert.equal(t.measurements().length, 0);
});

test('two points commit one measurement and rearm for the next', () => {
  const { t } = mk();
  t.arm();
  assert.equal(t.phase(), 'awaitingA');
  assert.equal(t.addPoint([0, 0, 0]), null);
  assert.equal(t.phase(), 'awaitingB');
  const m = t.addPoint([3, 4, 0]);
  assert.ok(m && m.id);
  assert.deepEqual(m.a, [0, 0, 0]);
  assert.deepEqual(m.b, [3, 4, 0]);
  assert.equal(t.phase(), 'awaitingA');       // stays armed (decision 8)
  assert.equal(t.measurements().length, 1);
});

test('measurements accumulate so several spans can be compared', () => {
  const { t } = mk();
  t.arm();
  t.addPoint([0, 0, 0]); t.addPoint([10, 0, 0]);
  t.addPoint([0, 0, 0]); t.addPoint([0, 0, 20]);
  assert.equal(t.measurements().length, 2);
});

test('cancel from awaitingB discards the partial but stays armed', () => {
  const { t } = mk();
  t.arm();
  t.addPoint([0, 0, 0]);
  t.cancel();
  assert.equal(t.phase(), 'awaitingA');
  assert.equal(t.pendingA(), null);
  assert.equal(t.measurements().length, 0);
});

test('near-identical endpoints are discarded rather than stored as a zero ruler', () => {
  const { t } = mk();
  t.arm();
  t.addPoint([1, 2, 3]);
  assert.equal(t.addPoint([1, 2, 3.001]), null);
  assert.equal(t.measurements().length, 0);
  assert.equal(t.phase(), 'awaitingA');
});

test('disarm drops any partial and leaves the list intact', () => {
  const { t } = mk();
  t.arm();
  t.addPoint([0, 0, 0]); t.addPoint([10, 0, 0]);
  t.addPoint([0, 0, 0]);
  t.disarm();
  assert.equal(t.phase(), 'idle');
  assert.equal(t.isArmed(), false);
  assert.equal(t.pendingA(), null);
  assert.equal(t.measurements().length, 1);
});

test('clear empties the list', () => {
  const { t } = mk();
  t.arm();
  t.addPoint([0, 0, 0]); t.addPoint([10, 0, 0]);
  t.clear();
  assert.equal(t.measurements().length, 0);
});

test('measurements() returns copies, not the internal records', () => {
  const { t } = mk();
  t.arm();
  t.addPoint([0, 0, 0]); t.addPoint([10, 0, 0]);
  t.measurements()[0].a[0] = 999;
  assert.equal(t.measurements()[0].a[0], 0);
});

test('onChange fires on arm, each point, commit, cancel, clear and disarm', () => {
  const { t, calls } = mk();
  t.arm();                       // 1
  t.addPoint([0, 0, 0]);         // 2
  t.addPoint([10, 0, 0]);        // 3 commit
  t.addPoint([0, 0, 0]);         // 4
  t.cancel();                    // 5
  t.clear();                     // 6
  t.disarm();                    // 7
  assert.equal(calls(), 7);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test web/tests/unit/measure-tool.test.js`
Expected: FAIL — `Cannot find module '.../src/measure-tool.js'`

- [ ] **Step 3: Write minimal implementation**

Create `web/src/measure-tool.js`:

```js
// Ruler state machine (Spec 3). DOM-free, like placement.js: both pane
// adapters feed it world-space points in feet and it decides which is A and
// which is B. Measurements are session-only (decision 6) — nothing here
// touches storage or the scene document.
import { distanceFt } from './metric/measure.js';

const MIN_SPAN_FT = 0.01;      // closer than this is a mis-click, not a span

let _mid = 0;
const nextId = () => `m_${Date.now().toString(36)}_${(_mid++).toString(36)}`;

export function createMeasureTool({ onChange } = {}) {
  let phase = 'idle';          // idle | awaitingA | awaitingB
  let pendingA = null;
  const list = [];

  const fire = () => { if (onChange) onChange(); };

  function arm() {
    phase = 'awaitingA';
    pendingA = null;
    fire();
  }

  function disarm() {
    phase = 'idle';
    pendingA = null;
    fire();
  }

  /** Drop an in-progress span without leaving the tool. */
  function cancel() {
    phase = phase === 'idle' ? 'idle' : 'awaitingA';
    pendingA = null;
    fire();
  }

  function addPoint(pt) {
    if (phase === 'idle' || !Array.isArray(pt) || pt.length !== 3) return null;
    if (phase === 'awaitingA') {
      pendingA = pt.slice();
      phase = 'awaitingB';
      fire();
      return null;
    }
    const a = pendingA;
    const b = pt.slice();
    pendingA = null;
    phase = 'awaitingA';
    if (!a || distanceFt(a, b) < MIN_SPAN_FT) { fire(); return null; }
    const m = { id: nextId(), a, b };
    list.push(m);
    fire();
    return m;
  }

  function clear() {
    list.length = 0;
    pendingA = null;
    if (phase !== 'idle') phase = 'awaitingA';
    fire();
  }

  return {
    arm,
    disarm,
    cancel,
    clear,
    addPoint,
    isArmed: () => phase !== 'idle',
    phase: () => phase,
    pendingA: () => (pendingA ? pendingA.slice() : null),
    measurements: () => list.map((m) => ({ id: m.id, a: m.a.slice(), b: m.b.slice() })),
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test web/tests/unit/measure-tool.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add web/src/measure-tool.js web/tests/unit/measure-tool.test.js
git commit -F - <<'MSG'
feat(measure): DOM-free ruler state machine

Spec 3 decisions 6, 8 and 12: session-only measurements that accumulate for
comparison, a modal tool that stays armed between spans, and straight-line
distance only. Shaped after placement.js so both pane adapters can feed it.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01SsetKcWaCBgLdSJa3zKWSc
MSG
```

---

### Task 6: 2D photo-pane ruler

**Files:**
- Create: `web/src/measure-overlay-2d.js`
- Modify: `web/playground.html`
- Modify: `web/src/main.js`
- Modify: `web/playground.css`
- Test: `web/tests/smoke-measure.spec.js` (extend)

**Interfaces:**
- Consumes: `createMeasureTool` (Task 5); `distanceFt` from `./metric/measure.js`; `worldToPixel`, `engineToWorld`, `effectiveFit` from `./metric/calibration.js`; `formatLength` from `./metric/units.js`; the scene's depth sampler via `getSampler()`; `uvDepthToLight` from `./3d/coords.js`.
- Produces: `mountMeasure2D({ svgEl, captureEl, tool, getState, getSampler }) → { render(), setArmed(on) }`.

- [ ] **Step 1: Write the failing test**

Extend `web/tests/smoke-measure.spec.js` with (setup copied as in Task 4):

```js
test('ruler 2D: two clicks draw a labelled measurement and a second one persists', async ({ page }) => {
  test.skip(!fs.existsSync(PORTRAIT_A), 'fixture missing');
  const { errors } = await calibratedRigScene(page, 'smoke-measure-ruler2d');

  await page.locator('#measure-btn').click();
  await expect(page.locator('#measure-btn')).toHaveAttribute('aria-pressed', 'true');

  const wrap = await page.locator('#canvas-wrap').boundingBox();
  const at = (fx, fy) => [wrap.x + wrap.width * fx, wrap.y + wrap.height * fy];

  // Pointer calibration probe: coords are ~10% off on this machine.
  await page.mouse.move(...at(0.5, 0.5));

  await page.mouse.click(...at(0.30, 0.62));
  await page.mouse.click(...at(0.70, 0.62));
  await expect(page.locator('#measure-overlay .measure-label')).toHaveCount(1);

  await page.mouse.click(...at(0.35, 0.55));
  await page.mouse.click(...at(0.65, 0.55));
  await expect(page.locator('#measure-overlay .measure-label')).toHaveCount(2);

  // Escape exits the tool but keeps what was measured.
  await page.keyboard.press('Escape');
  await expect(page.locator('#measure-btn')).toHaveAttribute('aria-pressed', 'false');
  await expect(page.locator('#measure-overlay .measure-label')).toHaveCount(2);

  await page.locator('#measure-clear-btn').click();
  await expect(page.locator('#measure-overlay .measure-label')).toHaveCount(0);

  expect(errors).toEqual([]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx playwright test --config=web/tests/playwright.config.js web/tests/smoke-measure.spec.js -g "ruler 2D"`
Expected: FAIL — `#measure-btn` does not exist

- [ ] **Step 3a: Add the markup**

In `web/playground.html`, inside `#canvas-wrap`, add the persistent overlay directly ABOVE `#handles` and the capture layer above `#placement-overlay`:

```html
          <canvas id="canvas"></canvas>
          <svg id="areas-overlay" hidden></svg>
          <svg id="cube-overlay" hidden></svg>
          <svg id="measure-overlay" hidden></svg>
          <div id="handles"></div>
          <div id="refine-overlay" hidden></div>
          <div id="placement-overlay" hidden></div>
          <div id="measure-capture" hidden></div>
```

In the header, beside the Areas checkbox group:

```html
    <button id="measure-btn" type="button" class="measure-toggle" aria-pressed="false"
            title="Measure between two points in either pane">Measure</button>
    <button id="measure-clear-btn" type="button" hidden>Clear</button>
```

- [ ] **Step 3b: Write the overlay module**

Create `web/src/measure-overlay-2d.js`:

```js
// 2D photo-pane ruler (Spec 3). Two layers inside #canvas-wrap:
//   #measure-overlay  an SVG that takes NO pointer events and draws the
//                     committed spans plus the in-progress rubber band. It
//                     sits above #handles so labels stay readable over a
//                     light handle without blocking it.
//   #measure-capture  a full-bleed div that captures clicks ONLY while the
//                     tool is armed, so the ruler never fights the light
//                     handles, the cube handles or orbit.
// Picking: sample the scene's depth PNG at the click, turn (u, v, depth) into
// an engine point, then into world feet. Per spec decision 4 an endpoint may
// land on the depth surface, and per decision 5 the reading is not marked.
import { worldToPixel, engineToWorld, effectiveFit } from './metric/calibration.js';
import { distanceFt } from './metric/measure.js';
import { formatLength } from './metric/units.js';
import { uvDepthToLight } from './3d/coords.js';

const SVG_NS = 'http://www.w3.org/2000/svg';

export function mountMeasure2D({ svgEl, captureEl, tool, getState, getSampler } = {}) {
  if (!svgEl || !captureEl || !tool) return null;
  let hover = null;                       // cursor in world feet, for the rubber band

  function worldAt(e) {
    const r = captureEl.getBoundingClientRect();
    if (!r.width || !r.height) return null;
    const u = (e.clientX - r.left) / r.width;
    const v = (e.clientY - r.top) / r.height;
    const sampler = getSampler?.();
    const st = getState();
    if (!sampler || !st?.calibration?.camera) return null;
    const d = sampler.sample(u, v);
    if (!Number.isFinite(d)) return null;
    const eng = uvDepthToLight(u, v, d);
    return engineToWorld(eng, st.calibration.camera, effectiveFit(st.calibration));
  }

  captureEl.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    const p = worldAt(e);
    if (!p) return;                       // sample failed: ignore, hold the phase
    tool.addPoint(p);
  });

  captureEl.addEventListener('pointermove', (e) => {
    if (tool.phase() !== 'awaitingB') { if (hover) { hover = null; render(); } return; }
    hover = worldAt(e);
    render();
  });

  function setArmed(on) {
    captureEl.toggleAttribute('hidden', !on);
    if (!on) hover = null;
    render();
  }

  function render() {
    const st = getState();
    const ms = tool.measurements();
    const pending = tool.pendingA();
    const on = !!(st?.calibration?.camera) && (ms.length > 0 || !!pending);
    svgEl.toggleAttribute('hidden', !on);   // SVG has no `hidden` IDL property
    while (svgEl.firstChild) svgEl.removeChild(svgEl.firstChild);
    if (!on) return;
    const W = svgEl.clientWidth || svgEl.parentElement?.clientWidth || 0;
    const H = svgEl.clientHeight || svgEl.parentElement?.clientHeight || 0;
    if (!W || !H) return;
    svgEl.setAttribute('viewBox', `0 0 ${W} ${H}`);
    const cam = st.calibration.camera;
    const units = st.units || 'ft';
    const px = (p) => { const r = worldToPixel(p, cam); return r ? [r[0] * W, r[1] * H] : null; };

    const draw = (a, b, cls) => {
      const pa = px(a), pb = px(b);
      if (!pa || !pb) return;                       // behind the camera: skip
      const line = document.createElementNS(SVG_NS, 'line');
      line.setAttribute('x1', pa[0].toFixed(1)); line.setAttribute('y1', pa[1].toFixed(1));
      line.setAttribute('x2', pb[0].toFixed(1)); line.setAttribute('y2', pb[1].toFixed(1));
      line.setAttribute('class', cls);
      svgEl.appendChild(line);
      const text = document.createElementNS(SVG_NS, 'text');
      text.setAttribute('x', ((pa[0] + pb[0]) / 2).toFixed(1));
      text.setAttribute('y', ((pa[1] + pb[1]) / 2).toFixed(1));
      text.setAttribute('class', 'measure-label');
      text.textContent = formatLength(distanceFt(a, b), units);
      svgEl.appendChild(text);
    };

    for (const m of ms) draw(m.a, m.b, 'measure-line');
    if (pending && hover) draw(pending, hover, 'measure-line is-pending');
  }

  return { render, setArmed };
}
```

- [ ] **Step 3c: Wire it in `main.js`**

```js
import { createMeasureTool } from './measure-tool.js';
import { mountMeasure2D } from './measure-overlay-2d.js';

const measureBtn = document.getElementById('measure-btn');
const measureClearBtn = document.getElementById('measure-clear-btn');

const measureTool = createMeasureTool({ onChange: () => {
  measure2D?.render();
  if (measureBtn) measureBtn.setAttribute('aria-pressed', measureTool.isArmed() ? 'true' : 'false');
  measureClearBtn?.toggleAttribute('hidden', measureTool.measurements().length === 0);
} });

const measure2D = mountMeasure2D({
  svgEl: document.getElementById('measure-overlay'),
  captureEl: document.getElementById('measure-capture'),
  tool: measureTool,
  getState: () => state,
  getSampler: () => depthSampler,
});

function setMeasureArmed(on) {
  if (on) {
    // One modal capture at a time, against BOTH other capture layers.
    // #refine-overlay is pointer-events:auto at z-index 5 — the same value
    // #measure-capture uses — and sits earlier in DOM order, so on that tie
    // the measure layer paints on top and silently swallows mask-refinement
    // clicks, with behaviour that varies by arming order.
    if (placement?.isActive()) placement.cancel();
    if (state.refineMode) setRefineMode(false);
    measureTool.arm();
  } else {
    measureTool.disarm();
  }
  measure2D?.setArmed(measureTool.isArmed());
}

measureBtn?.addEventListener('click', () => setMeasureArmed(!measureTool.isArmed()));
measureClearBtn?.addEventListener('click', () => measureTool.clear());
```

Gate the button on calibration wherever `updateBadge()` already runs (a ruler needs a feet space):

```js
  if (measureBtn) {
    measureBtn.disabled = !state.calibration;
    measureBtn.title = state.calibration
      ? 'Measure between two points in either pane'
      : 'Calibrate the scene to measure';
    if (!state.calibration && measureTool.isArmed()) setMeasureArmed(false);
  }
```

Extend the existing Escape handler (main.js ~line 912) so Escape discards a partial span first and exits the tool second:

```js
  if (e.key === 'Escape' && measureTool.isArmed()) {
    e.preventDefault();
    if (measureTool.phase() === 'awaitingB') measureTool.cancel();
    else setMeasureArmed(false);
    return;
  }
```

Also disarm Measure at the top of the add-light flow that calls `placement.begin(...)` (main.js ~line 443):

```js
    if (measureTool.isArmed()) setMeasureArmed(false);
```

- [ ] **Step 3d: Style it**

```css
/* z-index 1 matches #areas-overlay and #cube-overlay, so measurement labels
   paint above #handles. z-index 5 matches #placement-overlay, the existing
   modal capture layer: without it the capture div sits below #cube-overlay
   (z-index 1) whose .cube-handle elements are pointer-events:all, so a
   stage-box handle stays draggable while the ruler is armed. */
#measure-overlay { position: absolute; inset: 0; pointer-events: none; z-index: 1; }
#measure-capture { position: absolute; inset: 0; cursor: crosshair; z-index: 5; }
.measure-line { stroke: #ffd166; stroke-width: 1.5; }
.measure-line.is-pending { stroke-dasharray: 4 3; opacity: .8; }
.measure-label { fill: #ffd166; font: 11px system-ui, sans-serif; text-anchor: middle;
                 paint-order: stroke; stroke: rgba(0,0,0,.65); stroke-width: 3px; }
.measure-toggle[aria-pressed="true"] { outline: 2px solid #ffd166; }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx playwright test --config=web/tests/playwright.config.js web/tests/smoke-measure.spec.js`
Expected: PASS, both tests

- [ ] **Step 5: Run the unit suite**

Run: `npm run test:unit`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add web/src/measure-overlay-2d.js web/src/main.js web/playground.html web/playground.css web/tests/smoke-measure.spec.js
git commit -F - <<'MSG'
feat(measure): photo-pane ruler with a modal capture layer

Spec 3 decisions 4, 7 and 8: freehand endpoints picked off the depth surface,
a modal toggle that stays armed between spans, and a capture layer so the
ruler never fights the light or cube handles. The toggle is disabled while the
scene is uncalibrated, since without a solve there is no feet space.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01SsetKcWaCBgLdSJa3zKWSc
MSG
```

---

### Task 7: 3D viewport ruler

**Files:**
- Create: `web/src/3d/measure-overlay.js`
- Modify: `web/src/3d/index.js`
- Modify: `web/src/main.js`
- Test: `web/tests/smoke-measure.spec.js` (extend)

**Interfaces:**
- Consumes: `distanceFt` from `../metric/measure.js`; `formatLength` from `../metric/units.js`; the module-level `raycaster` and camera in `3d/index.js`; the `labelSprite` pattern from `3d/rig-overlay.js`.
- Produces: `buildMeasureOverlay(measurements, units) → THREE.Group` and `updateMeasureOverlay(scene, measurements, units) → void`, plus `setMeasureArmed3D(on)` and `setMeasureTool3D(tool)` exported from `3d/index.js`.

- [ ] **Step 1: Write the failing test**

Extend `web/tests/smoke-measure.spec.js`:

```js
test('ruler 3D: two clicks in the viewport draw a measurement', async ({ page }) => {
  test.skip(!fs.existsSync(PORTRAIT_A), 'fixture missing');
  const { errors } = await calibratedRigScene(page, 'smoke-measure-ruler3d');

  await page.locator('#measure-btn').click();
  const box = await page.locator('#canvas3d').boundingBox();
  const at = (fx, fy) => [box.x + box.width * fx, box.y + box.height * fy];
  await page.mouse.move(...at(0.5, 0.5));          // calibration probe
  await page.mouse.click(...at(0.35, 0.60));
  await page.mouse.click(...at(0.65, 0.60));

  await expect.poll(() => page.evaluate(() => window.__measureCount())).toBe(1);
  expect(errors).toEqual([]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx playwright test --config=web/tests/playwright.config.js web/tests/smoke-measure.spec.js -g "ruler 3D"`
Expected: FAIL — `window.__measureCount` is not a function

- [ ] **Step 3a: Write the overlay module**

Create `web/src/3d/measure-overlay.js`:

```js
// 3D ruler rendering (Spec 3): one THREE.Line per committed span plus a
// canvas-texture label at its midpoint. Mirrors 3d/rig-overlay.js, including
// its depthTest: false labels — consistent with the area labels already
// shipped, which show through the subject.
import * as THREE from 'three';
import { distanceFt } from '../metric/measure.js';
import { formatLength } from '../metric/units.js';

const GROUP_NAME = 'measureOverlay';
const LABEL_HEIGHT_FT = 1.2;
const COLOR = 0xffd166;

function labelSprite(text) {
  const canvas = document.createElement('canvas');
  canvas.width = 256; canvas.height = 64;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.font = 'bold 34px system-ui, sans-serif';
  ctx.fillStyle = '#ffd166';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.strokeStyle = 'rgba(0,0,0,0.7)';
  ctx.lineWidth = 6;
  ctx.strokeText(text, canvas.width / 2, canvas.height / 2);
  ctx.fillText(text, canvas.width / 2, canvas.height / 2);
  const material = new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(canvas), transparent: true, depthTest: false });
  const sprite = new THREE.Sprite(material);
  sprite.scale.set(LABEL_HEIGHT_FT * 4, LABEL_HEIGHT_FT, 1);   // canvas is 4:1
  return sprite;
}

export function buildMeasureOverlay(measurements, units = 'ft') {
  const group = new THREE.Group();
  group.name = GROUP_NAME;
  const mat = new THREE.LineBasicMaterial({ color: COLOR });
  for (const m of measurements) {
    const geom = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(...m.a), new THREE.Vector3(...m.b),
    ]);
    group.add(new THREE.Line(geom, mat));
    const label = labelSprite(formatLength(distanceFt(m.a, m.b), units));
    label.position.set((m.a[0] + m.b[0]) / 2, (m.a[1] + m.b[1]) / 2, (m.a[2] + m.b[2]) / 2);
    group.add(label);
  }
  return group;
}

function dispose(group) {
  group.traverse((o) => {
    if (o.geometry) o.geometry.dispose();
    if (o.material) { if (o.material.map) o.material.map.dispose(); o.material.dispose(); }
  });
}

export function updateMeasureOverlay(scene, measurements, units = 'ft') {
  if (!scene) return;
  const old = scene.getObjectByName(GROUP_NAME);
  if (old) { scene.remove(old); dispose(old); }
  if (!measurements?.length) return;
  scene.add(buildMeasureOverlay(measurements, units));
}
```

- [ ] **Step 3b: Wire picking in `3d/index.js`**

Add module state and the armed pointer handler, reusing the existing `raycaster` and the same surface order the placement path uses (point cloud, then deck, then placement plane):

```js
import { updateMeasureOverlay } from './measure-overlay.js';

let measureTool = null;
let measureArmed = false;

export function setMeasureTool3D(tool) { measureTool = tool; }

export function setMeasureArmed3D(on) {
  measureArmed = !!on;
  if (renderer?.domElement) renderer.domElement.style.cursor = measureArmed ? 'crosshair' : '';
}

export function renderMeasure3D(measurements, units) {
  updateMeasureOverlay(scene, measurements, units);
}
```

In the existing canvas `pointerdown` listener, take the click before orbit/gizmo handling when armed:

```js
  if (measureArmed && measureTool) {
    e.preventDefault();
    e.stopPropagation();
    const world = surfacePointAt(e);          // existing helper: cloud → deck → plane
    if (world) measureTool.addPoint(world);
    return;
  }
```

If the existing surface helper returns an ENGINE point rather than world feet, convert with `engineToWorld(pt, metricCal.camera, effectiveFit(metricCal))` before calling `addPoint`, so the tool only ever receives feet.

- [ ] **Step 3c: Wire it in `main.js`**

Extend the tool's `onChange` and the arm helper:

```js
  renderMeasure3D(measureTool.measurements(), state.units || 'ft');
```
```js
  setMeasureArmed3D(measureTool.isArmed());
```

Add the test hook beside the other `window.__*` hooks:

```js
window.__measureCount = () => measureTool.measurements().length;
```

Re-render both overlays on a unit change, next to the existing `relight:units` listener:

```js
document.addEventListener('relight:units', () => {
  measure2D?.render();
  renderMeasure3D(measureTool.measurements(), state.units || 'ft');
});
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx playwright test --config=web/tests/playwright.config.js web/tests/smoke-measure.spec.js`
Expected: PASS, all three tests

- [ ] **Step 5: Commit**

```bash
git add web/src/3d/measure-overlay.js web/src/3d/index.js web/src/main.js web/tests/smoke-measure.spec.js
git commit -F - <<'MSG'
feat(measure): 3D viewport ruler mirroring the photo-pane one

Spec 3 decision 7: one pure geometry source, two renderers, the same split as
rig/areas.js feeding areas-overlay-2d.js and 3d/rig-overlay.js. Labels inherit
rig-overlay's depthTest: false, consistent with the shipped area labels.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01SsetKcWaCBgLdSJa3zKWSc
MSG
```

---

### Task 8: Clear measurements on calibration change and scene switch

**Files:**
- Modify: `web/src/main.js`
- Test: `web/tests/smoke-measure.spec.js` (extend)

**Interfaces:**
- Consumes: `measureTool.clear()` (Task 5).
- Produces: no new API. Behavioural guarantee only.

**Why:** a measurement's endpoints were resolved through the calibration and against a specific photo. Keeping feet coordinates would show a number that no longer describes the drawn line; keeping image anchoring would silently change a number already read. Clearing is the only option that cannot mislead (spec decision 13).

- [ ] **Step 1: Write the failing test**

Extend `web/tests/smoke-measure.spec.js`:

```js
test('measurements clear when the calibration changes or the scene switches', async ({ page }) => {
  test.skip(!fs.existsSync(PORTRAIT_A), 'fixture missing');
  const { errors } = await calibratedRigScene(page, 'smoke-measure-clear');

  await page.locator('#measure-btn').click();
  const wrap = await page.locator('#canvas-wrap').boundingBox();
  const at = (fx, fy) => [wrap.x + wrap.width * fx, wrap.y + wrap.height * fy];
  await page.mouse.move(...at(0.5, 0.5));
  await page.mouse.click(...at(0.30, 0.62));
  await page.mouse.click(...at(0.70, 0.62));
  await expect.poll(() => page.evaluate(() => window.__measureCount())).toBe(1);

  // A re-apply of the calibration drops them.
  await page.evaluate(() => window.__applyCalibration());
  await expect.poll(() => page.evaluate(() => window.__measureCount())).toBe(0);
  await expect(page.locator('#measure-overlay .measure-label')).toHaveCount(0);

  expect(errors).toEqual([]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx playwright test --config=web/tests/playwright.config.js web/tests/smoke-measure.spec.js -g "clear when"`
Expected: FAIL — count stays 1

- [ ] **Step 3: Write minimal implementation**

In `web/src/main.js`, call `measureTool.clear()` at the START of every path that re-solves the calibration or swaps the photo. Add the line to each of:

- `applyCalibration` (the function `window.__applyCalibration` exposes)
- the calibration Revert handler
- the calibration Undo and Redo handlers
- `adoptVenue` / `applyVenueEdit` (a venue edit moves the focus height and the house box)
- the scene-load path (`loadScene` / `prepareScene`, wherever `depthSampler` is rebuilt)

```js
  measureTool.clear();   // Spec 3 decision 13: no measurement outlives its solve
```

Since `clear()` fires `onChange`, both overlays re-render and the Clear button re-hides with no extra wiring.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx playwright test --config=web/tests/playwright.config.js web/tests/smoke-measure.spec.js`
Expected: PASS, all four tests

- [ ] **Step 5: Commit**

```bash
git add web/src/main.js web/tests/smoke-measure.spec.js
git commit -F - <<'MSG'
fix(measure): clear measurements when the solve or the photo changes

Spec 3 decision 13. Endpoints are resolved through the calibration and against
one photo, so a surviving measurement would either mislabel its own line or
silently restate a number the user already read.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01SsetKcWaCBgLdSJa3zKWSc
MSG
```

---

### Task 9: Bounded unit audit

**Files:**
- Modify: whichever files the audit finds (expected: few or none)
- Test: `web/tests/smoke-measure.spec.js` (extend)

**Interfaces:**
- Consumes: `toDisplay` / `formatLength` / `parseLength` from `web/src/metric/units.js`.
- Produces: no new API.

**Scope — this is a closed list, not an open sweep.** Audit exactly these length-displaying surfaces:

1. Rig tab: positions table, fixtures table (incl. the new columns), status line
2. Props pane: light position/target fields, rig fieldset, the new readout block — **known gap (M5):** the block's labels read plain "Throw" / "Field Ø" with no unit, while the fixtures table shows `Throw (ft)` / `Ø (ft)`. Both render the same converted number but only the table says which unit it is in. Give the props labels the same `(${units})` suffix.
3. Calibration panel: dimension inputs, house fieldset, the camera line
4. Cube overlay 2D: the three stage labels and the house labels
5. Venue editor: dims, house, positions
6. Calibrate badge in the header
7. 3D: deck grid labels, rig overlay position labels, the new measurement labels
8. Tree rows and group labels, if any show a length

- [ ] **Step 1: Write the failing test**

Extend `web/tests/smoke-measure.spec.js`:

```js
test('units: switching to metres converts the readout columns and the ruler label', async ({ page }) => {
  test.skip(!fs.existsSync(PORTRAIT_A), 'fixture missing');
  const { errors } = await calibratedRigScene(page, 'smoke-measure-units');
  await addHungFixture(page);

  await page.locator('#measure-btn').click();
  const wrap = await page.locator('#canvas-wrap').boundingBox();
  const at = (fx, fy) => [wrap.x + wrap.width * fx, wrap.y + wrap.height * fy];
  await page.mouse.move(...at(0.5, 0.5));
  await page.mouse.click(...at(0.30, 0.62));
  await page.mouse.click(...at(0.70, 0.62));

  const throwCell = page.locator('#rig-root tr.rig-fixture [data-readout="throw"]').first();
  const ftThrow = parseFloat(await throwCell.textContent());
  const ftLabel = await page.locator('#measure-overlay .measure-label').first().textContent();
  expect(ftLabel).toContain('ft');

  await page.locator('#unit-toggle [data-unit="m"]').click();

  await expect(page.locator('th', { hasText: 'Throw (m)' })).toBeVisible();
  const mThrow = parseFloat(await throwCell.textContent());
  expect(mThrow).toBeLessThan(ftThrow);                     // 1 ft = 0.3048 m
  expect(Math.abs(mThrow - ftThrow * 0.3048)).toBeLessThan(0.15);
  await expect(page.locator('#measure-overlay .measure-label').first()).toContainText('m');

  expect(errors).toEqual([]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx playwright test --config=web/tests/playwright.config.js web/tests/smoke-measure.spec.js -g "units:"`
Expected: FAIL if any of the new surfaces ignore the toggle; PASS once they honour it

- [ ] **Step 3: Audit and fix**

Walk the eight surfaces above with the app open in both units. For each, confirm the number changes and the suffix or column header changes with it. Any surface formatting a length without `toDisplay` / `formatLength` gets converted. Grep to shortlist candidates:

```bash
grep -rn "toFixed(1)" web/src --include=*.js | grep -v "toDisplay\|formatLength"
```

For every gap found, add a focused assertion to the `units:` test above rather than a new spec file.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx playwright test --config=web/tests/playwright.config.js web/tests/smoke-measure.spec.js`
Expected: PASS, all five tests

- [ ] **Step 5: Commit**

```bash
git add -u
git commit -F - <<'MSG'
test(units): audit every length surface against the ft/m toggle

Spec 3 decision 11, over the eight surfaces the spec enumerates. One stray
feet-only number in metres mode would cost the readouts their credibility,
so the coverage is asserted rather than assumed.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01SsetKcWaCBgLdSJa3zKWSc
MSG
```

---

### Task 10: Full-suite gate and spec Deviations

**Files:**
- Modify: `docs/superpowers/specs/2026-09-03-readouts-and-measuring-design.md` (Deviations section)

**Interfaces:** none.

- [ ] **Step 1: Confirm no dev server is holding the port**

Run: `netstat -ano | findstr :8765`
Expected: no LISTENING line. If there is one, stop that server before continuing — Playwright starts its own.

- [ ] **Step 2: Run the JS unit suite**

Run: `npm run test:unit`
Expected: PASS. Paste the count. Floor: 200 pre-existing + this plan's new tests.

- [ ] **Step 3: Run the engine suite**

Run: `python -m pytest packages/relighting_engine -q`
Expected: PASS — 154 passed, 69 skipped. No code in this plan touches Python; a change here means something went wrong.

- [ ] **Step 4: Run the API suite**

Run: `python -m pytest packages/relighting_api -q`
Expected: PASS — 131 passed.

- [ ] **Step 5: Run the full Playwright config**

Run: `npx playwright test --config=web/tests/playwright.config.js`
Expected: PASS — 9 pre-existing (4 parity goldens + 5 smokes) + 5 new in `smoke-measure.spec.js`. A green `smoke-measure` alone is not the gate; the parity goldens are the part that has silently gone red before.

- [ ] **Step 6: Run GitNexus change detection**

Run: `node .gitnexus/run.cjs detect-changes --scope all --repo .`
Expected: a report. `partial: true` or `truncated: true` is not a clean check — re-run. Log the result; per project convention HIGH/CRITICAL risk flags are noise and do not block, but a genuine contract break must be reported.

- [ ] **Step 7: Fill in the spec's Deviations section**

Replace *"To be filled in during implementation."* with the real list. At minimum it must record:

- The `no-beam` tooltip was generalised from the spec's *"A cyc has no beam angle"* to *"No usable beam angle for this fixture"*, because the code also covers reflectors and out-of-range hand-edited cone angles (Task 1).
- Any surface the Task 9 audit had to fix, or "none found".
- Anything deferred, with the reason.

- [ ] **Step 8: Commit**

```bash
git add docs/superpowers/specs/2026-09-03-readouts-and-measuring-design.md
git commit -F - <<'MSG'
docs(spec): record readouts-and-measuring deviations as implemented

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01SsetKcWaCBgLdSJa3zKWSc
MSG
```

- [ ] **Step 9: Report, do not push**

Write the task report, then hand back with: the five suite counts pasted verbatim, the `detect-changes` result, the deviations recorded, and anything a reviewer should rule on. **Do not push. Do not open or update a PR.**

---

## Self-Review

**Spec coverage** — every spec section maps to a task:

| Spec requirement | Task |
| --- | --- |
| Decision 1 (perpendicular diameter at target) | 1 |
| Decision 2 (focus-height plane, "—" when no crossing) | 1 |
| Decision 3 (both surfaces) | 2, 3 |
| Decision 4 (freehand incl. depth surface) | 6 |
| Decision 5 (readings unmarked) | 6 — no marking code exists, by construction |
| Decision 6 (session-persistent, Clear button) | 5, 6 |
| Decision 7 (both panes, one geometry module) | 6, 7 |
| Decision 8 (modal toggle, stays armed, Escape) | 5, 6 |
| Decision 9 (live drag, settle on release) | 4 |
| Decision 10 (field diameter, one number) | 1 |
| Decision 11 (bounded unit audit) | 9 |
| Decision 12 (straight line only) | 5, 6, 7 |
| Decision 13 (clear on calibration change) | 8 |
| Decision 14 (unit + golden + real-mouse E2E) | 1, 5, 4, 6, 7, 9, 10 |
| Decision 15 ("—" + reason tooltip) | 1, 2, 3 |
| Error handling: house-box bound | 1 (`insideHouse`) |
| Error handling: `cone_angle` guard | 1 (`MIN_CONE` / `MAX_CONE`) |
| Error handling: pick failure holds the phase | 5, 6 |
| Error handling: degenerate span discarded | 5 |
| Error handling: Measure disabled uncalibrated | 6 |
| Non-goals (snapping, export, persistence, rise/run, marking, Python) | not implemented anywhere — verified by absence |

**Placeholder scan:** no TBDs. Every code step carries the actual code. Task 8's file list is a set of named call sites rather than line numbers because those handlers move between commits; the line to add is given verbatim. Task 9's fixes are unknown until the audit runs, which is the nature of an audit — its closed eight-surface scope and its test are both specified.

**Type consistency:** `throwAndDiameter` returns `{ throwFt, fieldDiaFt, reason }` in Tasks 1–4; `readoutCellText(light, venue, units, kind) → { text, title }` in Tasks 2, 3, 4; `reasonTooltip(reason) → string` in Tasks 1, 2; the tool's surface is identical in Tasks 5, 6, 7, 8; measurements are `{ id, a, b }` throughout; `data-readout` values are `'throw'` and `'dia'` in Tasks 2, 3, 4, 9. `distanceFt` is imported by `measure-tool.js`, `measure-overlay-2d.js` and `3d/measure-overlay.js`, all from `metric/measure.js`.

One risk flagged for the executor: Task 7 Step 3b assumes `3d/index.js` has a reusable surface-pick helper (the one the placement path uses at `index.js:130–150`). If it is inlined rather than extracted, extract it first within Task 7 — do not duplicate the cloud → deck → plane fallback.
