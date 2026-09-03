# Readouts and Measuring — Design Spec

Date: 2026-09-03
Status: Implemented 2026-09-03 (feat/readouts-measuring). See Deviations.
Roadmap position: Spec 3. Follows Spec 1 (stage calibration + metric lights),
Spec 2 (fixture table) and the calibration cube. Precedes Spec 4 (rig export).

## Goal

Turn the metric layer into numbers a designer can act on and hand to a crew:

- **Per-fixture readouts** — how far each fixture throws, and how wide its pool
  is at the target.
- **A ruler** — measure between any two points in either pane.
- **Unit coverage** — every length-displaying surface honours the ft/m toggle.

The purpose is previs for planning a real rig, so a number that looks
authoritative and is wrong costs more than no number at all. Where a value
cannot be computed honestly, the UI shows an em dash and says why.

## Decisions (grill-storm 2026-09-03)

Fifteen decisions, numbered as they were settled.

### Readouts

1. **Diameter is measured perpendicular to the beam axis at the target** —
   one number per fixture, not the elliptical footprint on the deck. It is the
   figure printed on manufacturer photometric charts, so it can be checked
   against a spec sheet.
2. **Throw for an unaimed fixture comes from the focus-height plane.**
   Ray-cast the beam axis to `Y = venue.focus_height_ft` (default 5 ft) — the
   same plane `areaCenter` already aims at. A beam that never crosses it (a
   flat shin, an uplight) reads "—". This gap is accepted, not papered over.
3. **Both surfaces.** `Throw` and `Ø` columns in the rig tab's fixtures table
   *and* a readout block in the props pane for the selected fixture. The
   column answers "are my FOH pools even?"; the block answers "what is this
   instrument doing?".
9. **Live during a drag, authoritative on release.** Readouts update on every
   pointermove via a targeted text update, and the normal render path
   recomputes everything when the drag lands.
10. **Labelled field diameter, not beam diameter.** The stored angles (ERS
    barrels 19/26/36/50, PAR lamp codes 12–55) are field-angle designations,
    so the computed pool is the field pool. Calling it "beam" would promise
    the 50% core and deliver the 10% edge. One number only: `softness` is a
    shader edge-falloff parameter, not a measured beam/field ratio, so no beam
    figure is derived from it.
15. **No-number cases show "—" with a reason tooltip**, because the reasons
    need different actions: a cyc will never have a beam angle, an unaimed
    fixture is fixed by aiming it, an uncalibrated scene is fixed by
    calibrating.

### Ruler

4. **Freehand against whatever the cursor hits**, including the photo's depth
   surface. Not restricted to declared geometry.
5. **Readings are not marked** as depth-derived versus declared. One number,
   one styling, whatever the endpoint landed on. (See Accepted risks.)
6. **Session-persistent.** Measurements accumulate so several can be compared,
   are dropped by a Clear button, and are not saved with the scene.
7. **Both panes**, mirrored from one pure geometry module — the same split as
   `rig/areas.js` feeding `areas-overlay-2d.js` and `3d/rig-overlay.js`.
8. **Modal tool with a toolbar toggle**, staying armed between measurements so
   several can be taken in a row. Escape or a second click on the toggle
   exits. A modal capture layer avoids fighting the existing drags in both
   panes, exactly as click-to-place does.
12. **Straight-line distance only** — one number on the line. No rise/run
    components; trim and upstage distance are already columns elsewhere.
13. **A calibration change clears live measurements.** Any Apply / Revert /
    Undo / Redo of the calibration drops them. Both survival options mislead:
    keeping feet coordinates shows a number that no longer describes the drawn
    line; keeping image anchoring silently changes a number already read.

### Scope and bar

11. **Bounded unit audit.** Walk every surface that displays a length — both
    panes, both tabs, the props pane, the 3D labels — fix any that ignore the
    toggle, and cover the gaps found with tests. Coverage is already good;
    this is cheap insurance against the one stray number that would cost the
    feature its credibility.
14. **Acceptance bar: unit tests + a photometric golden + real-mouse E2E in
    both panes.** The golden is load-bearing: a unit test written from the
    implementation's own formula confirms the arithmetic, not the geometry.

## Non-goals (v1)

- No snapping to fixtures, hang positions or stage corners.
- No export of readouts — that is Spec 4 (rig export, CSV/PDF).
- No persistence of measurements across a reload or into the scene document.
- No rise/run components on a measurement.
- No confidence marking, tolerance band or approximate styling on any reading.
- No Python mirror of the formula. Spec 4 decides where export computes it.

## Vocabulary

| Term | Meaning |
| --- | --- |
| **Throw** | Distance in feet from the fixture to its aim point. |
| **Aim point** | `target_ft` when the fixture is aimed; otherwise where the beam axis crosses the focus-height plane. |
| **Field diameter (Ø)** | Pool width perpendicular to the beam axis at the aim point: `2 · throw · tan(cone_angle)`. |
| **Focus height** | `venue.focus_height_ft`, default 5 ft — the plane `areaCenter` already aims at. |
| **Measurement** | One ruler: two world-space endpoints in feet plus the distance between them. |

## Architecture

Four new modules, each copying a sibling already in the tree.

| Module | Role | Sibling |
| --- | --- | --- |
| `web/src/metric/measure.js` | Pure geometry. No DOM, no THREE. | `rig/areas.js` |
| `web/src/measure-tool.js` | DOM-free state machine and measurement list. | `placement.js` |
| `web/src/measure-overlay-2d.js` | Photo-pane picking and SVG rendering. | `placement-pane-2d.js`, `areas-overlay-2d.js` |
| `web/src/3d/measure-overlay.js` | Viewport raycast, `THREE.Line` + `labelSprite`. | `3d/rig-overlay.js` |

Five existing files change:

- `web/src/rig/rig-tab.js` — `Throw` and `Ø` columns; `updateReadouts()`.
- `web/src/controls.js` — readout block in `renderLightProps`;
  `updateReadoutBlock()`.
- `web/src/main.js` — mount the tool, wire the header toggle, clear on
  calibration change and scene switch, call the readout updates from
  `redraw()`.
- `web/playground.html` — `svg#measure-overlay` directly above `#handles`
  (no pointer events, so labels stay readable over handles without blocking
  them); `div#measure-capture` above `#placement-overlay` (full capture, only
  while armed); a `Measure` toggle and a `Clear` button in the header beside
  the Areas checkbox.
- CSS for the overlay, the toggle and the readout cells.

**The boundary that matters:** `measure.js` takes plain data and returns
numbers, and is the only thing the readouts and the ruler share. Neither
overlay knows the other exists; each owns its picking and its rendering, and
both feed world-space points to the same tool.

## Components

### `metric/measure.js`

```js
planeHitY(origin, dir, y)        // → [x,y,z] | null
distanceFt(a, b)                 // → number
throwAndDiameter(light, venue)   // → { throwFt, fieldDiaFt, reason }
```

`throwAndDiameter` resolves the aim point as `light.target_ft` when the
fixture is aimed, otherwise `planeHitY(position_ft, direction_ft,
venue.focus_height_ft ?? 5)`. Then:

```
throwFt    = distanceFt(position_ft, aim)
fieldDiaFt = 2 * throwFt * Math.tan(light.cone_angle)
```

`cone_angle` is already the field **half**-angle in radians — `rig/presets.js`
builds it as `(fieldDeg / 2) * Math.PI / 180`. All returns are raw feet;
formatting is `units.js`'s job.

Formula check, which is also the golden test: a Source Four 26° at a 30 ft
throw gives `2 · 30 · tan(13°) = 13.85 ft`, against ETC's published 13.9.

### `measure-tool.js`

```js
createMeasureTool({ onChange }) → {
  arm(), disarm(), isArmed(), phase(),   // idle | awaitingA | awaitingB
  addPoint(worldFt), cancel(), clear(),
  measurements()                          // [{ id, a, b }]
}
```

### Overlay adapters

```js
mountMeasure2D({ svgEl, captureEl, tool, getSampler, getCalibration, getUnits })
mountMeasure3D({ scene, tool, getHit, getUnits })
```

Both return `{ render(), setArmed(bool) }`. The 2D adapter picks by sampling
depth at the click and converting to world feet, and draws with `worldToPixel`.
The 3D adapter picks with the existing raycaster (point cloud, then deck plane,
then stage planes) and draws a `THREE.Line` plus a `labelSprite`.

### Readout updates

```js
rigTab.updateReadouts()                                  // rig-tab.js
updateReadoutBlock(container, light, venue, units)       // controls.js
```

`updateReadouts()` recomputes every visible row and writes `textContent` only
where it differs — 64 rows of trivial arithmetic, no DOM rebuild. Deliberately
*not* a dragged-fixture fast path: the same function computes the number in
both the live and the settled path, so the two cannot diverge.

### Header controls

A `Measure` toggle beside the Areas checkbox, and a `Clear` button visible only
when measurements exist. Arming Measure disarms placement and vice versa — one
modal capture at a time. The toggle is **disabled while the scene is
uncalibrated**: with no solve there is no feet space, so a ruler could only
report pixels.

## Data flow

`position_ft` is already current on every pointermove, so the readouts need no
new sync plumbing:

```
handles.js pointermove
  → onHandlesChange                    (main.js:360, passed in as `redraw`)
      → syncDraggedLights()
          → syncRig(lights, venue, calibration)
              → syncLightsFromEngineEdits   (fixture-sync.js:111)
                    ⇒ position_ft / direction_ft / target_ft re-derived
      → redrawAndSave() → redraw()
                    ⇒ NEW: rigTab?.updateReadouts(); updateReadoutBlock(...)
```

**Ordering constraint:** the readout updates must run *after*
`syncDraggedLights()`, never before, or they read the previous frame's feet.
Hooking them at the end of `redraw()` satisfies this, and covers handle drags,
the Z slider, the wheel and 3D gizmo drags in one place.

**Steady state:** `tree.render()` → `rigTab.render()` → `renderFixturesTable`
→ per row `throwAndDiameter(L, venue)` → `formatLength(v, units)`, or "—" plus
the `reason` tooltip.

**Taking a measurement (2D):** capture-layer pointerdown → `uv` → depth sample
→ engine point → `engineToWorld` → world feet → `tool.addPoint`. The second
point commits and fires `onChange`; both overlays re-render. Between points,
pointermove rubber-bands a line to the cursor, as placement's tether already
does.

**Taking a measurement (3D):** pointerdown → existing raycaster → point cloud,
else deck plane, else stage planes → world feet → the same `tool.addPoint`.
Identical from the tool's perspective.

**Calibration change / scene switch:** `tool.clear()` before re-solving, so no
measurement outlives the solve or the photo that produced it.

**Unit change:** `relight:units` already re-renders the rig tab; both overlays
subscribe to the same event and re-render labels. Stored values stay in feet
throughout — `units.js` remains the only place conversion happens.

## Error handling

One `reason` enum drives every "—" and its tooltip.

| reason | when | tooltip |
| --- | --- | --- |
| `ok` | numbers valid | — |
| `no-beam` | cyc, linear, reflector, or `cone_angle` outside (0°, 89°) | "A cyc has no beam angle" |
| `no-crossing` | axis parallel to the focus plane, pointing away from it, or hitting it outside the house box | "This beam never crosses the focus height" |
| `degenerate` | target within ε of the fixture | "Target is at the fixture" |
| `no-venue` | unaimed fixture while `venueMissing` | "No venue: aim this fixture to get a throw" |
| `not-calibrated` | no `position_ft` (props pane only) | "Calibrate the scene to measure" |

Two rules deserve their reasoning recorded:

- **The house-box bound on `no-crossing`.** A fixture aimed nearly parallel to
  the focus plane produces a mathematically valid hit hundreds of feet outside
  the building. Requiring the hit to land inside the declared house box turns
  an absurd number into an honest dash, using geometry the user typed in rather
  than an arbitrary cap.
- **The `cone_angle` guard.** The presets cap the field angle at 90°, but the
  legacy `.cone` control (`controls.js:452`) writes `parseFloat` straight onto
  the light, so a hand-edited value can be anything. Outside (0°, 89°) the
  diameter is meaningless or negative, so it reads as `no-beam`.

**Ruler edges**

- Depth sample fails, or the 3D ray hits nothing: the click is ignored and the
  phase holds. No half-built measurement.
- Endpoints within ε of each other: discarded, not stored as a 0.0 ruler.
- Scene switch or photo re-prepare: `tool.clear()`, as for a calibration change
  — a different photo invalidates every depth-derived endpoint.

**No depth fit:** throws and rulers inherit the linear-estimate warning the
calibrate badge already shows (`⚠`). Per decision 5 the readings themselves
stay unmarked; the badge is the only signal.

**Property worth banking:** because nothing is stored, undo/redo of any light
edit yields correct readouts for free — they recompute from whatever state
exists. This is the main advantage over writing derived fields onto the light.

## Testing

The `test:unit` glob already covers `unit/`, `unit/metric/` and `unit/rig/`, so
new files in those directories need no script change.

### `web/tests/unit/metric/measure.test.js`

- `planeHitY`: normal hit; ray parallel to the plane → null; ray pointing away
  → null; `t = 0`.
- `throwAndDiameter` on an aimed fixture with a known target and cone angle →
  exact throw and diameter.
- **Photometric goldens.** `applyFixturePreset(L, 'ers', 26)` with endpoints
  30 ft apart → `fieldDiaFt` ≈ 13.85, asserted to ±0.05 against ETC's published
  13.9. PAR `MFL` (35°) at 20 ft → 12.6 ft. These are the only tests that catch
  a half-angle/full-angle mixup: the full angle gives 29.2 ft and
  degrees-as-radians gives garbage, and both pass a test written from the
  implementation's own formula.
- Every `reason` code, one case each, including a hit landing outside the house
  box and hand-edited `cone_angle` values of 0° and 90°.
- Returns raw feet, never formatted.

### `web/tests/unit/measure-tool.test.js`

Phase transitions through a committed measurement; cancel from `awaitingB`
discards the partial; near-identical endpoints discarded; measurements
accumulate; `clear()` empties; `onChange` fires on commit, cancel and clear.

### `web/tests/smoke-measure.spec.js` — real mouse input, both panes

1. Calibrated scene with a venue: `Throw` and `Ø` show numbers on an ERS row,
   "—" with the right tooltip on a cyc row.
2. Real-mouse drag of a 2D handle asserting the `Throw` cell changes **during**
   the drag, not only after release. Run a pointermove calibration probe first
   — screenshot coordinates are ~10% off on this machine.
3. Arm Measure, click two points on the photo, assert a labelled measurement;
   take a second, assert both persist.
4. The same in the 3D pane.
5. Flip to meters; assert both the columns and the measurement labels convert.
6. Apply a calibration change; assert measurements clear.

### Full-suite gate

The complete Playwright config (workers: 1, no dev server on :8765), plus the
JS unit suite and both Python suites. A green `smoke-measure` alone has
historically hidden parity regressions. Baseline to beat: **200 JS unit, 154
engine, 131 API, 9 Playwright.**

## Accepted risks

**Decisions 4 and 5 compound.** The ruler may report a one-decimal number
derived from monocular depth with nothing on screen distinguishing it from one
derived from the stage box the user typed in. The recommendation during the
grill was to constrain endpoints to declared geometry, or failing that to mark
depth-derived readings as approximate; both were declined in favour of an
unqualified freehand ruler. Recorded here as a known limitation. The mitigation
if it bites: each overlay already knows at pick time which surface it hit, so
adding a provenance field to the measurement record and styling on it is an
additive change, not a rewrite.

**The focus-plane gap (decision 2).** A flat shin or an uplight reads "—"
rather than a throw. Accepted deliberately over a fallback plane whose
behaviour a user could not predict.

## Implementation order (for the plan)

1. `metric/measure.js` with its unit tests and the photometric goldens.
2. `Throw` / `Ø` columns in the fixtures table, static render only.
3. Props-pane readout block.
4. `updateReadouts()` / `updateReadoutBlock()` wired into `redraw()`; live-drag
   E2E.
5. `measure-tool.js` with its unit tests.
6. `measure-overlay-2d.js` plus the header toggle, Clear button and capture
   layer.
7. `3d/measure-overlay.js`.
8. Clear-on-calibration-change and clear-on-scene-switch wiring.
9. The bounded unit audit and any fixes it turns up.
10. Full-suite gate.

## Deviations (as implemented)

### Production behaviour changed beyond what the spec described

- **Hung fixtures now get a default aim at stage centre** (`buildFixtureLight`, Task 4). Before this, every unaimed rig fixture inherited a horizontal `fill` direction, so its throw/diameter readouts could never resolve to a number until the designer manually assigned an Area — the readout columns and the props-pane block would sit at "—" for every fixture on the rig by default, defeating their purpose. A hung fixture's default `direction_ft` now points at stage centre at focus height; Custom (unhung) fixtures keep the prior generic default, since there's no position to aim from.
- **Default rig pane width raised from 580 to 670px**, to keep the fixtures table free of horizontal scroll once the Throw and Field Ø columns were added (Task 2/3).
- **Header layout fix:** `.view-mode` (both `#view-mode`, the 2D | Split | 3D control, and `#unit-toggle`) no longer shrinks (`flex-shrink: 0`), and `.calib-badge` truncates with an ellipsis instead (`min-width: 0; overflow: hidden; text-overflow: ellipsis`). Discovered during Task 9: `overflow: hidden` on `.view-mode` with no `flex-shrink: 0` dropped its flexbox automatic minimum width to zero, so both segmented controls collapsed to ~2px and became unclickable whenever the header's content exceeded the 1600px viewport in rig mode with a long calibrate badge (e.g. `"<scene> · 40 × 20 × 30 ft"`) — latent since Task 6 added the Measure/Clear buttons pushed header content past that threshold, never exercised by any test until Task 9's own `units:` test tried to click the header toggle. Fixed in-task per explicit ruling, since it made a real control unclickable in ordinary use, not only a blocked test.
- **`#measure-overlay`/`#measure-capture` z-index** (`z-index: 1` / `z-index: 5`, matching the `#placement-overlay` precedent) and **Measure/Refine Mask mutual exclusivity** — the two full-bleed pointer-capturing modes are guarded so entering one disarms the other, avoiding mutual recursion by construction (Task 6, fix round in Task 6).
- **Calibration panel dimension and house field labels gained a `(${units})` suffix** (Task 9). The Width/Height/Depth and house fields already converted their numeric values correctly on unit toggle, but the labels never stated which unit — the same defect class as the props-pane readout gap (M5) below, found independently on this second surface during the Task 9 audit. Because the panel's markup is built once at mount and never rebuilt (unlike `venue-editor.js`, which rebuilds on every open), the fix is a live DOM update inside `setUnits`, not static interpolation.

### Known edge case: a boom fixture level with `focus_height_ft` reads "—" permanently

Final whole-branch review, escalated rather than fixed in the fix wave (the reviewer's suggested fix does not work, verified before ruling it out — see below).

For a boom, `positionToWorld` returns `[p.offset_ft, offsetFt, p.upstage_ft]` — the *second* component, `offsetFt`, is the fixture's height. When a boom fixture's height equals `venue.focus_height_ft` (the default aim's target height, `buildFixtureLight`), the default aim's `d[1]` (the vertical component of the direction toward stage centre) is exactly `0`: a perfectly level beam. `planeHitY` then computes `t = (y - origin[1]) / dir[1]`, and with `origin[1] === y` that is `t = 0` for *any* direction — the beam can never cross the focus plane at `t > 0`, so the readout reads `reason: 'no-crossing'` ("—") from the moment the fixture is created, with no drag or edit needed to reach it. Reachable with any even `focus_height_ft` given the 2 ft boom step; already latent in `smoke-rig.spec.js:115`, which builds a boom at offset 5 against `SYNTHETIC_VENUE`'s `focus_height_ft: 5`. Pinned by a unit test in `rig-tab-model.test.js` ("a boom fixture hung level with focus_height_ft has a flat default aim and reads no-crossing").

**Why "aim at the deck instead" does not fix it:** a fixture sitting *on* the focus plane can never cross it at `t > 0` regardless of which direction it's aimed — the degeneracy is in `origin[1] === y`, not in the direction chosen. No default-aim formula resolves this.

This is spec decision 2's accepted flat-shin case (a beam that never crosses the focus plane reads "—" with a reason tooltip), arising here from the *default* aim rather than a user choice to point a fixture along the deck. Resolving it properly needs a design call between two options, both deferred to the user:
1. Give default-aimed fixtures a real `target_ft`, which makes them "targeted" — with visible UI consequences (targeted fixtures render and edit differently from aimed-but-untargeted ones elsewhere in the rig tab).
2. Change how the readout resolves an on-plane fixture, e.g. treating an exactly-level beam at the focus height as a zero-throw special case rather than "no-crossing".

### Copy and wording

- The `no-beam` tooltip was generalised from the spec's cyc-specific example ("A cyc has no beam angle") to **"No usable beam angle for this fixture"**, because the code path also covers reflectors and out-of-range hand-edited cone angles, not only cycs (Task 1).
- Props-pane readout block labels gained a `(${units})` suffix (`Throw (${units})` / `Field Ø (${units})`) to match the fixtures table's column headers, which already stated the unit — this was the known gap M5, closed in Task 9.

### API shapes that differ from the spec's interfaces section

The spec's interfaces section describes `mountMeasure3D({ scene, tool, getHit, getUnits })` returning `{ render(), setArmed(bool) }`, matching the 2D adapter's shape. What shipped for the 3D side instead is three module-level functions in `3d/index.js` — `setMeasureTool3D(tool)`, `setMeasureArmed3D(on)`, `renderMeasure3D(measurements, units)` — plus the separate pure `buildMeasureOverlay`/`updateMeasureOverlay` pair in `3d/measure-overlay.js`. This matches the module-singleton pattern the rest of `3d/index.js` already uses for its other overlays, rather than introducing a second, differently-shaped mounting convention alongside it.

Separately, `mountMeasure2D`'s actual signature is `{ svgEl, captureEl, tool, getState, getSampler }` — the spec's `getCalibration`/`getUnits` pair collapsed into a single `getState` accessor. This matches the shape `areas-overlay-2d.js` already uses for the same purpose.

Both shapes were a deliberate fit to this codebase's existing conventions rather than an oversight, and the final review judged both an improvement over the spec's literal interfaces — recorded here because the Deviations section is meant to capture everything that changed from the spec, not only the changes judged worth reconsidering.

### Deferred, with reasons

- The Sprite shared-geometry dispose that `measure-overlay.js` inherited from `rig-overlay.js`'s pattern — pre-existing scope, not introduced by this plan, left as-is for consistency with the rest of the 3D overlay code.
- `measure-overlay-2d.js`'s `render()` rebuilds the whole SVG on every pointermove rather than patching in place — acceptable at the scale of a single in-progress ruler segment, deferred as a perf concern only if profiling ever shows it matters.
- `measureTool`'s `cancel()`/`disarm()` fire `onChange` even on a true no-op (e.g. disarming when already disarmed) — harmless (all consumers are idempotent re-renders) but not worth the extra guard clause for a currently-invisible case.
- The latent z-index tie between `#measure-capture` and `#refine-overlay` (both effectively claiming the same modal-capture layer precedence) — resolved for the two modes that exist today via the mutual-exclusivity guard rather than a hard z-index ordering; a future third full-bleed capture layer would need to actually resolve the ordering, not just add another pairwise exclusivity guard.

### Run-wide finding: GitNexus index is stale

GitNexus's index for this repo is pinned at commit `905d768`, well behind the branch's current tip. Confirmed directly: symbols GitNexus reported as "touched" during Task 9 (`updatePrompt`, `startDrag`/its nested `move`, `onOverlayPointerDown` in `calibration-panel.js`) exist in the file as of `905d768` but not in the file as it stands today — the tool was reporting against a deleted/superseded revision, not the actual diff. Every "line-shift artifact" dismissal made against `detect_changes`/`impact` output this run (`openLoadPicker`, `renderReflectorProps`, `escapeHtml`, `uploadFixture`, `record`, `done`, and the calibration-panel closures above) should be read with this in mind — some may equally have been symbols that no longer exist rather than symbols that merely moved. A future reader relying on this tool's symbol-level output for this branch should re-index first (`node .gitnexus/run.cjs analyze --index-only`) rather than trust it as-is.

### Final test counts (branch tip `a691cf1`, plus this spec commit)

- `npm run test:unit`: **235 passed**, 0 failed.
- `python -m pytest packages/relighting_engine -q`: **154 passed, 69 skipped**.
- `python -m pytest packages/relighting_api -q`: **131 passed**.
- `npx playwright test --config=web/tests/playwright.config.js` (workers=1): **17 passed** — 4 parity goldens, 5 pre-existing smokes, 8 in `smoke-measure.spec.js` (readouts, ruler 2D ×4, ruler 3D, measurements-clear, units).
