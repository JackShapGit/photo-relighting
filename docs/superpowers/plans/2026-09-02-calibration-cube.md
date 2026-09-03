# Calibration Cube Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the five-click calibration with a draggable stage box (five handles = the stored marks, live re-solve, dimensions edited on the edges) and a draggable house box (walls, floor, ceiling, depth) that hang positions can reference, with Apply / Revert / Undo / Redo.

**Architecture:** Pure modules do the geometry (box corners → handle points, handle drags → marks, guessed default camera, house pixel↔feet, gizmo camera↔marks, height-reference conversions, clamps) and the draft/applied/history reducer. A 2D SVG overlay (modeled on `areas-overlay-2d.js`) draws both boxes with handles and inline-editable labels and writes to a **draft**; the panel shows the draft's numbers/warnings and commits with Apply through the existing `applyCalibration`; the 3D view draws both boxes as wireframes and maps the existing translate gizmo on the stage box back to marks. The stored calibration record, the solver, the depth fit, and all downstream fixture code are unchanged. Venues gain a `house` block and positions gain a height reference.

**Tech Stack:** Vanilla ES modules, SVG overlay, Three.js 0.165 (LineSegments, TransformControls), node:test, Playwright (`web/tests/playwright.config.js`, workers 1), FastAPI + Pydantic, pytest.

**Spec:** `docs/superpowers/specs/2026-09-02-calibration-cube-design.md`

## Global Constraints

- Calibration record format unchanged (`marks`, `depth_fit`, `depth_check`, `units`, mirrored dims). The five handles ARE `marks.lipL/lipR/top/backL/backR`; `top` is written as `[u_c, v]`.
- Stage-dimension typing never moves the photo wireframe; it changes the solve. House typing moves the house wireframe (camera fixed).
- Draft vs applied: drags/typing change only the draft (preview camera for overlays + panel numbers); Apply commits via `applyCalibration` and venue save; Revert discards the draft; Undo restores the previous applied calibration + venue + fixture feet fields and re-applies; history cap 10, single redo slot cleared by a new Apply; latest history entry persisted as `state.calibration_undo`; Clear is undoable.
- Clamps guarantee `validateMarks` can never fail from a drag: lip width ≥ 5% image width, top above lip, back narrower than lip and above lip; house: floor ≤ deck, ceiling > opening height, left < right with ≥ stage width between.
- Guessed default camera: `dist = 1.5·width`, `height = 6`, `f` so the lip spans 70% of image width, `u_c = 0.5`, `k_y = 1`, `va_h` from the projection of the deck plane.
- House defaults (venue without `house`): `left_wall = −0.75·width`, `right_wall = +0.75·width`, `floor_drop = 3`, `ceiling = height + 10`, `depth = 2·depth`, `estimated: true`.
- Height reference: stored `trim_ft`/boom `offset_ft` stay deck-relative; `toDeck(v, ref, house)`: deck → v; house_floor → v − floor_drop; ceiling → ceiling − v. Venue save recomputes deck values for non-deck refs.
- Two toggles: `photo-relight:show-stage-box`, `photo-relight:show-house-box`; each hides/shows its box in both views.
- Tests: `npm run test:unit`; pytest suites; full Playwright config (any task touching layout/state runs the FULL config); no dev server on :8765.
- CLAUDE.md: impact/detect_changes logged in reports only. Commit trailers as in `1c67066`. Use `newLightNode` in manual checks; keep the Capri scene's venue and venue_id afterwards.
- Synthetic fixtures for tests: Spec 1's `SYNTHETIC_STAGE` (web/src/metric/calibration.js) and Spec 2's `SYNTHETIC_VENUE` (web/src/rig/geometry.js).

---

## File map

Create: `web/src/metric/cube-geometry.js`, `web/src/metric/calibration-draft.js`, `web/src/rig/height-ref.js`, `web/src/metric/cube-overlay-2d.js`, `web/src/3d/cube-3d.js`; tests `web/tests/unit/metric/cube-geometry.test.js`, `calibration-draft.test.js`, `web/tests/unit/rig/height-ref.test.js`; `web/tests/smoke-cube.spec.js`.
Modify: `web/src/metric/calibration-panel.js` (rewrite), `web/src/main.js`, `web/src/lights.js` (state fields), `web/src/3d/index.js`, `web/src/3d/gizmos.js`, `web/src/rig/rig-tab.js`, `web/src/rig/venue-editor.js`, `web/src/rig/geometry.js` (house defaults), `web/playground.html`, `web/playground.css`; `packages/relighting_api/relighting_api/schemas.py`, `venue_store.py` (defaults on read), `tests/api/test_venues.py`.
Delete: `web/src/metric/marking.js`, `web/tests/unit/metric/marking.test.js`.

---

### Task 1: Pure geometry, height references, and the draft reducer

**Files:**
- Create: `web/src/metric/cube-geometry.js`, `web/src/rig/height-ref.js`, `web/src/metric/calibration-draft.js`
- Test: `web/tests/unit/metric/cube-geometry.test.js`, `web/tests/unit/rig/height-ref.test.js`, `web/tests/unit/metric/calibration-draft.test.js`
- Modify: `web/src/rig/geometry.js` (add `defaultHouse(venue)`)

**Interfaces (produces):**
- `cube-geometry.js`:
  - `stageCorners(dims) → {fbl, fbr, ftl, ftr, bbl, bbr, btl, btr}` world-feet corners for `{width_ft,height_ft,depth_ft}`.
  - `guessCamera(dims, aspect) → CameraModel` (Global Constraints numbers; `va_h` computed so the lip projects at v = 0.72).
  - `handlePoints(cam, dims) → {lipL:[u,v], lipR, top, backL, backR}` via `worldToPixel`; `top` = `[u_c, v(front-top-left/right midpoint)]`.
  - `marksFromCamera(cam, dims)` = `handlePoints` (used by the default pose and the gizmo mapping).
  - `clampStageDrag(marks, key, [u,v]) → [u,v]` (Global Constraints clamps; symmetric: dragging `backL` cannot cross to make back ≥ lip, etc.).
  - `applyHandleDrag(marks, key, [u,v]) → marks'` (copy; `top` keeps `u = u_c`).
  - `houseEdgesPx(cam, house) → {left:u, right:u, floor:v, ceiling:v, guides:[[[u,v],[u,v]]…]}` (proscenium-plane rectangle projected at Z_cam = dist; guides from each corner toward a point 0.5·house.depth toward the camera).
  - `housePxToFt(cam, edge, value) → number` inverse (X from u; Y from v).
  - `clampHouse(house, dims, patch) → house'`.
  - `cameraFromGizmoDelta(cam, dims, [dx, dy, dz]) → cam'` (dz along world −Z → `dist_ft += dz`; dy → `height_ft += dy`; dx → `u_c += dx·f/dist`), then `marksFromCamera(cam', dims)`.
- `height-ref.js`: `HEIGHT_REFS = ['deck','house_floor','ceiling']`, `toDeck(value, ref, house)`, `fromDeck(deckValue, ref, house)`, `recomputePositionsForHouse(positions, house) → positions'` (non-deck refs get `trim_ft`/boom fixture heights re-derived from `height_input_ft`), `describeHeight(deckValue, house, units) → "12.0 ft above house floor · 4.0 ft below ceiling"`.
- `geometry.js`: `defaultHouse({width_ft,height_ft,depth_ft}) → house` (Global Constraints defaults, `estimated: true`).
- `calibration-draft.js` (pure reducer): `createDraftState(applied) → S`; `reduce(S, action) → S'` with actions `{type:'edit', patch}` (marks/dims/house), `{type:'apply'}`, `{type:'revert'}`, `{type:'undo'}`, `{type:'redo'}`, `{type:'clear'}`; `S = { applied, draft, history: [...], redo: null|entry, dirty: bool }`; entries are `{ calibration, venue: {dims, house}, fixtures: [{id, position_ft, target_ft, endpoint_a_ft, endpoint_b_ft}] }` supplied by the caller via `action.snapshot` on apply/clear; cap 10; `serializeUndo(S) → entry|null` (latest history entry for `state.calibration_undo`), `hydrateUndo(S, entry)`.

- [ ] **Step 1: Tests** (write all three files; key cases)

`cube-geometry.test.js`: guessed camera for aspect 0.75 and 0.5625 yields marks that pass `validateMarks` with lip width ≈ 0.7; `handlePoints` on `SYNTHETIC_STAGE`'s solved camera reproduces its marks within 1e-6 (round trip: marks → solveCamera → handlePoints → marks); `applyHandleDrag` on `top` keeps `u = u_c`; `clampStageDrag` stops `backR` at lip width − ε, `top` above the lip line, `lipR` at ≥ 5% width; `houseEdgesPx`/`housePxToFt` round trip for left wall −30 and ceiling 30; `clampHouse` rejects floor above deck and ceiling ≤ opening; `cameraFromGizmoDelta` with `[0,0,10]` gives `dist_ft + 10` and re-solving from the produced marks reproduces `dist` within 0.5%.

`height-ref.test.js`: `toDeck(12,'house_floor',{floor_drop_ft:3})` = 9; `toDeck(4,'ceiling',{ceiling_ft:30})` = 26; `fromDeck` inverses; `recomputePositionsForHouse` moves a ceiling-referenced pipe when the ceiling changes and leaves deck-referenced pipes alone; `describeHeight` formats both units.

`calibration-draft.test.js`: edit sets dirty; revert restores draft = applied and clears dirty; apply pushes the previous applied entry and clears dirty/redo; undo pops into applied+draft and fills redo; redo re-applies and clears the slot; a new apply after undo clears redo; cap 10 (11 applies keep the last 10 entries); clear pushes history; `serializeUndo`/`hydrateUndo` round trip.

- [ ] **Step 2: Run** `npm run test:unit` → FAIL (modules missing).
- [ ] **Step 3: Implement** the modules per Interfaces (pure; import only `calibration.js` helpers). `guessCamera`: `f = 0.7·dist/width`, `va_h = 0.72·aspect − f·height/dist`, then `solveCamera` is NOT used (the guess is a CameraModel directly: `{f, dist_ft, height_ft: 6, u_c: 0.5, va_h, k_y: 1, aspect}`).
- [ ] **Step 4: Run** → all pass. **Step 5: Commit** `feat(metric): cube geometry, height references, calibration draft reducer`.

---

### Task 2: Venue schema (house, height refs), defaults on load, recompute on save

**Files:**
- Modify: `packages/relighting_api/relighting_api/schemas.py` (`HouseModel`, `VenueModel.house`, `VenueModel.default_height_ref`, `PositionModel.height_ref`, `PositionModel.height_input_ft`), `venue_store.py` (fill `house` defaults on read when missing; `estimated: true`), `tests/api/test_venues.py` (+4 tests), `web/src/rig/venue-api.js` (no change expected), `web/src/main.js` (on venue load: `venue.house ??= defaultHouse(venue)`; on venue save: `recomputePositionsForHouse` before PUT), `web/src/rig/rig-tab.js` (positions table: reference dropdown + tooltip via `describeHeight`), `web/src/rig/venue-editor.js` (house fields + default reference)
- Test: API tests; JS unit for `venueFromForm` house parsing

**Interfaces:** `HouseModel(left_wall_ft<0? no: Finite, right_wall_ft Finite, floor_drop_ft ≥ 0, ceiling_ft > 0, depth_ft > 0, estimated: bool = False)` with validator `left < right` and `ceiling > height_ft` checked at the venue level; `PositionModel.height_ref: Literal['deck','house_floor','ceiling'] = 'deck'`, `height_input_ft: Finite | None`.

- [ ] Tests: POST venue without house → GET returns defaults with `estimated: true`; PUT with house floor_drop −1 → 422; PUT with ceiling ≤ height → 422; position with `height_ref: 'ceiling'` and `height_input_ft: 4` round-trips.
- [ ] Implement; positions table gains a `ref` select (deck / house floor / ceiling) beside `trim_ft`/boom offset and shows `describeHeight` as the cell title; venue editor gains a "House" fieldset (left wall, right wall, floor drop, ceiling, depth, "estimated" note) and "Default height reference" select.
- [ ] Run API suite, JS unit, smoke-rig spec. Commit `feat(api,web): house dimensions and height references on venues and positions`.

---

### Task 3: Stage-box overlay, panel rewrite, draft/apply/revert/undo, delete marking

**Files:**
- Create: `web/src/metric/cube-overlay-2d.js`
- Modify: `web/src/metric/calibration-panel.js` (rewrite), `web/src/main.js`, `web/src/lights.js` (`calibration_undo: null` in state; `serializeSceneState` includes it), `web/playground.html` (toggles `#show-stage-box`, `#show-house-box` next to Areas; `<svg id="cube-overlay">` inside `#canvas-wrap` above the areas overlay, below handles), `web/playground.css`
- Delete: `web/src/metric/marking.js`, `web/tests/unit/metric/marking.test.js`
- Test: `web/tests/smoke-cube.spec.js` (drag + apply + undo)

**Interfaces:**
- `mountCubeOverlay({ overlayEl, canvasWrapEl, getDraft, getCamera, getDims, getHouse, getUnits, isShown: {stage, house}, onDrag(kind, key, [u,v]), onLabelEdit(kind, field, text) })` → `{ render(), destroy() }`. Renders the stage box (8 corners projected; polylines; 5 handles; 3 edge labels) and, when a camera exists, the house box (Task 4 fills in; this task renders the stage box only and leaves house hooks in place). Pointer capture on handles; rAF-throttled; dashed stroke when `dirty`.
- Panel (`mountCalibrationPanel`) new options: `getDraftState`, `dispatch(action)`, `onApplyCommit(record, venuePatch)`, `onUndoRestore(entry)`, `getUnits`. Panel content: stage dims (three inputs), house fields (Task 4), `default_height_ref` select, warnings (live from the draft's preview camera), buttons Apply (`.is-dirty` pulse when dirty), Revert (enabled when dirty), Undo (enabled when history), Redo (enabled when redo slot), Clear. "unapplied changes" line. No marking button.
- `main.js`: owns the draft state (`state.cal_draft = createDraftState(...)`), the preview camera (`solveCamera(draft.marks + draft.dims)` memoized per change), `applyCalibration` unchanged in effect but now called from the panel's Apply with the draft's record + venue patch (dims/house) → venue PUT + `applyCalibration` + `structuralEdit`; snapshot for history = current applied calibration + venue dims/house + fixtures' feet fields; undo restores fixtures' feet fields then `applyCalibration(entry.calibration)`. Badge dot when dirty. Default pose when no calibration: `guessCamera` → `marksFromCamera` into the draft.

- [ ] Smoke test (real input): open the Capri-like fixture scene via helpers; with no calibration the stage box is visible in default pose; drag `lipR` right by 60 px → the draft mark moved and the preview `dist_ft` changed, Apply button has `.is-dirty`; click Apply → `state.calibration.camera.dist_ft` equals the preview, badge updates; click Undo → calibration back to null (this scene had none) and the box returns to the default pose; Redo → calibrated again; both toggles hide/show `#cube-overlay` groups; zero console errors.
- [ ] Implement; delete marking.js and its test; update any imports.
- [ ] Run JS unit, FULL Playwright config. Commit `feat(web): draggable stage box replaces five-click calibration; apply/revert/undo`.

---

### Task 4: House-box overlay, typed fields, clamps

**Files:**
- Modify: `web/src/metric/cube-overlay-2d.js` (house box: rectangle in the proscenium plane, 4 edge handles, guide lines, labels), `web/src/metric/calibration-panel.js` (house fields wired to the draft), `web/src/main.js` (house edits → draft; Apply writes `venue.house` and runs `recomputePositionsForHouse`)
- Test: extend `smoke-cube.spec.js`: drag the ceiling edge up 40 px → `draft.house.ceiling_ft` increased; Apply → `venue.house.ceiling_ft` persisted and `estimated: false`; a pipe with `height_ref: 'ceiling'` keeps its drop.

- [ ] Implement per spec §House box on the photo; clamps via `clampHouse`; labels editable inline (parseLength).
- [ ] Run JS unit, FULL Playwright. Commit `feat(web): draggable house box with walls, floor, ceiling`.

---

### Task 5: 3D wireframes, stage-box gizmo mapping, toggles in 3D

**Files:**
- Create: `web/src/3d/cube-3d.js` (`buildStageBox(dims)`, `buildHouseBox(house, dims)` as `LineSegments` named `stage-box` / `house-box`; `updateCubes(scene, dims, house, shown)`; dashed material when dirty via `LineDashedMaterial` + `computeLineDistances`)
- Modify: `web/src/3d/index.js` (`setCubes3D({dims, house, shown, dirty})`; attach the translate gizmo to the stage box when the panel is open and the stage box is shown; on `objectChange` compute the delta since drag start and call `onStageBoxDrag([dx,dy,dz])`), `web/src/3d/gizmos.js` (`attachObject(obj, onDelta)` generic attach for a non-light object; reuse the existing `dragging-changed` guard), `web/src/main.js` (`onStageBoxDrag` → `cameraFromGizmoDelta(previewCam, dims, delta)` → `marksFromCamera` → draft edit; toggles/dirty → `setCubes3D`)
- Test: unit test already covers the mapping; extend `smoke-cube.spec.js` to assert `window.__scene3d.getObjectByName('stage-box')` exists when the toggle is on and is absent when off; the house box likewise.

- [ ] Implement; make sure the gizmo detaches from the box when a light is selected and re-attaches when the panel regains focus (panel open + no light selected).
- [ ] Run JS unit, FULL Playwright, and a real-input check on :8765 (Capri): gizmo-drag the stage box away 10 ft in 3D → photo wireframe shrinks and the panel's distance reads +10; Apply; Undo.
- [ ] Commit `feat(3d): stage and house box wireframes; gizmo drives the calibration`.

---

### Task 6: Height reference UX polish and venue editor integration

**Files:**
- Modify: `web/src/rig/rig-tab.js` (reference select + tooltip already from Task 2: add the "two derived readings" tooltip and re-render on house change), `web/src/rig/venue-editor.js` (house fieldset validation messages; "estimated" note clears on edit), `web/src/main.js` (venue save path calls `recomputePositionsForHouse` and re-syncs fixtures)
- Test: JS unit for `venueFromForm` house fields + clamps; smoke-rig assertion that changing a ceiling-referenced pipe's reference from deck to ceiling keeps `trim_ft` and sets `height_input_ft = ceiling − trim`.

- [ ] Implement; run JS unit + FULL Playwright. Commit `feat(rig): height references in the positions table and venue editor`.

---

### Task 7: Smoke/E2E, docs, spec status

- [ ] `smoke-cube.spec.js` final pass covering: default pose, drag, apply, undo/redo, house drag, toggles, reload persistence of `calibration_undo` (one undo after reload).
- [ ] Docs: spec Status → "Implemented 2026-09-02 (feat/calibration-cube)" + Deviations; Spec 1's spec gets a one-line note that its five-click UI was replaced by the cube (record format unchanged).
- [ ] Full verification: JS unit, both pytest suites, goldens, FULL Playwright twice. `detect_changes({scope:'compare', base_ref:'main'})` summary in the report.
- [ ] Commit `test: cube smoke; mark calibration-cube spec implemented`.

---

## Self-review notes

- Spec coverage: decisions 1–8 (T1 geometry + T3/T4 overlays + T5 3D + toggles T3/T5), data model (T2), geometry incl. guessed camera and gizmo mapping (T1, T5), UI incl. inline labels, dirty indicator, Revert/Undo/Redo (T3), house box (T4), height refs (T2, T6), error handling via clamps (T1, T3, T4), testing (each task; Playwright real drags T3–T5), deletion of marking (T3), implementation order matches the spec.
- Type consistency: `house` keys `left_wall_ft,right_wall_ft,floor_drop_ft,ceiling_ft,depth_ft,estimated`; position keys `height_ref,height_input_ft`; draft state `{applied, draft, history, redo, dirty}`; scene field `calibration_undo`; 3D object names `stage-box`, `house-box`; toggles `#show-stage-box`, `#show-house-box`; overlay `#cube-overlay`.
