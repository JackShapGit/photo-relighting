# Calibration Cube — Design Spec

Date: 2026-09-02
Status: Approved in discussion, awaiting user review of this document
Roadmap position: replaces the five-click marking UI of Spec 1; lands before Spec 3 (Readouts and Measuring)

## Goal

Replace the sequential five-click calibration with two draggable wireframe
boxes drawn over the photo and in the 3D view:

- The **stage box** is the stage volume (width × height × depth). The user
  drags it until its edges sit on the lip, the proscenium opening, and the
  back wall, then types the real dimensions. Where the box sits on the photo
  is the measurement; the typed numbers say what it represents. This drives
  the existing pinhole solve unchanged.
- The **house box** is the room: walls, house floor, ceiling, and depth into
  the house. It is measured against the camera the stage box established, so
  typing a number moves its wireframe and dragging its wireframe changes the
  number. It exists so hang positions can be given relative to the ceiling or
  the house floor, and so the rig is drawn inside a room.

Each box has its own show/hide toggle.

## Decisions (brainstorm 2026-09-02)

1. The cube is the stage volume, not an arbitrary reference object.
2. Drag in both views; the photo (corner handles) is the precise fit, the 3D
   gizmo is the coarse "move it around the scene" control.
3. The cube replaces the five-click flow; the stored record format is
   unchanged, so old scenes load with their cube already fitted.
4. Dimension labels sit on the cube's edges and are edited in place.
5. Typing a stage dimension does not move the wireframe on the photo (the
   photo pose is the measurement); it changes the solve. Only the 3D view,
   which is in feet, visibly rescales.
6. Five handles on the stage box (front-bottom-left, front-bottom-right,
   front-top edge, back-bottom-left, back-bottom-right); the other edges
   follow from the solve.
7. The house box is draggable on the photo with its own measurements.
8. Two toggles, one per box, remembered separately.

## Non-goals (v1)

- Least-squares camera fits from more than five points; non-rectangular
  stages; angled photos (Spec 1's head-on assumption stands).
- Non-vertical walls, sloped ceilings, balconies.
- A draggable house box in 3D (3D house box is display-only).
- Using the house box for rendering (no bounce, no occlusion). It is a
  reference frame and a drawing.
- Readouts (throw, beam diameter, ruler) — Spec 3.

## Vocabulary

- **Stage box**: the calibration box; its five handles are Spec 1's marks
  (`lipL`, `lipR`, `top`, `backL`, `backR`).
- **House box**: the room envelope attached to the proscenium plane.
- **Proscenium plane**: Z = 0, the stage box's front face.
- **Deck**: Y = 0. **House floor**: Y = −floor_drop_ft. **Ceiling**:
  Y = ceiling_ft (above the deck).
- **Height reference**: how a position's height number is stated: `deck`
  (above the deck, today's meaning), `house_floor` (above the house floor),
  or `ceiling` (drop below the ceiling).

## Data model

### Calibration record (unchanged)

`state.calibration` keeps `marks`, `depth_fit`, `depth_check`, `units`, with
dimensions mirrored from the venue. The cube's five handles read and write
`marks` directly. Nothing else changes.

### Venue additions

```
house: {
  left_wall_ft:  number,   // X of the house-left wall (negative; audience-left)
  right_wall_ft: number,   // X of the house-right wall (positive)
  floor_drop_ft: number,   // deck height above the house floor (>= 0)
  ceiling_ft:    number,   // ceiling height above the deck (> opening height)
  depth_ft:      number,   // house depth from the proscenium plane toward the camera (> 0)
  estimated: bool          // true until a user edits any house value
},
default_height_ref: 'deck' | 'house_floor' | 'ceiling'   // for new positions; default 'deck'
```
Defaults when a venue has no `house` (derived on load, `estimated: true`):
`left_wall = −0.75·width`, `right_wall = +0.75·width`, `floor_drop = 3`,
`ceiling = height + 10`, `depth = 2·depth`.

### Position additions

```
height_ref: 'deck' | 'house_floor' | 'ceiling'   // default 'deck'
height_input_ft: number                           // the number as the user stated it
```
`trim_ft` (pipe) and, for a fixture on a boom, `fixture.offset_ft` remain the
stored deck-relative values used by every existing derivation. Conversions
(pure, `web/src/rig/height-ref.js`):
- `toDeck(value, ref, house)`: deck → value; house_floor → value − floor_drop;
  ceiling → ceiling − value.
- `fromDeck(deckValue, ref, house)`: inverse.
Editing either the number or the reference recomputes `trim_ft`; editing the
house box (floor drop or ceiling) recomputes `trim_ft` for positions whose
`height_ref` is not `deck`, so a truss "4 ft from the ceiling" stays 4 ft
from the ceiling when the ceiling moves.

## Geometry

### Stage box on the photo

Projection uses Spec 1's `worldToPixel(cam)` on the eight corners of the box
`[±width/2, {0, height}, {0, depth}]`. The five handles are placed at the
projected `lipL`, `lipR`, the midpoint of the front-top edge (vertical drag
only), `backL`, `backR`. A handle drag writes the corresponding mark(s)
(the top handle writes `top` as `[u_c, v]`), then `solveCamera` runs and the
whole box re-projects. Before the first solve (no marks) the default pose is
produced by projecting the box through a **guessed camera**: `dist =
1.5·width`, `height = 6 ft`, `f` such that the lip spans 70% of the image
width, `u_c = 0.5`, `k_y = 1`; its five projected handle points become the
initial marks.

### House box on the photo

The house cross-section in the proscenium plane is the rectangle
`X ∈ [left_wall, right_wall]`, `Y ∈ [−floor_drop, ceiling]`, `Z = 0`. Its
four edges project to two vertical and two horizontal lines (head-on camera).
Handles: left wall (drag X), right wall (drag X), floor line (drag Y), ceiling
line (drag Y). Pixel → feet uses the inverse projection at `Z_cam = dist`:
`X = (u − u_c)·dist/f`, `Y = k_y·(height_cam − (v·aspect − va_h)·dist/f)`.
The wall/floor/ceiling lines are extended toward the image edges (the room's
side walls, floor and ceiling as seen from inside) as faint guide lines from
each corner toward its vanishing direction, computed by projecting a second
point 0.5·house depth toward the camera. The near face is behind the camera
and is not drawn. Depth is typed only.

### 3D

Both boxes are `THREE.LineSegments` wireframes in the feet frame
(`worldFtToThree`), stage box in the accent color, house box in a second
color. The stage box carries the existing translate gizmo; a drag along Three
z (world −Z) changes `dist_ft` by the same amount, along Y changes camera
`height_ft`, along X shifts `u_c` by `ΔX·f/dist` — all by rewriting the marks
that would produce that camera (invert: project the box through the adjusted
camera and take the five handle points as the new marks) so the record stays
the single source of truth. The house box is display-only in 3D. Hang-
position bars (Spec 2 overlay) are unchanged; they simply draw inside the
house box.

## UI

- Header: two toggles `Stage box` / `House box` next to `Areas`, persisted
  under `photo-relight:show-stage-box` and `photo-relight:show-house-box`
  (defaults: on while the scene is uncalibrated or the panel is open; the
  stored value otherwise).
- Photo overlay (`web/src/metric/cube-overlay-2d.js`, SVG like the areas
  overlay but with pointer events on handles only): wireframe polylines,
  handles (14 px), edge labels (`40.0 ft` etc.) positioned at edge midpoints,
  `contenteditable`-style inline edit on label click (Enter commits, Esc
  cancels; parse via `parseLength`), and a legend swatch.
- Calibration panel becomes: the two toggles mirrored, three stage dimension
  fields, five house fields, a height-reference default dropdown, Apply,
  Clear, and the warnings. "Mark on photo" and the marker sequence are
  removed; `marking.js` and its tests are deleted.
- Live vs. committed: dragging updates a **draft** (marks, stage dims,
  house values), re-solves into a preview camera used by both overlays and
  the 3D wireframes, and updates the panel's numbers/warnings. Fixtures, the
  point cloud, the stage grid, the venue, and the saved record change only on
  Apply. Clear removes the calibration and shows the default-pose cube again.
- Unapplied state is unmissable: while the draft differs from the applied
  record, the Apply button pulses (`.is-dirty`), the panel shows an
  "unapplied changes" line, the badge shows a dot, and the wireframes draw
  dashed. Leaving the scene or reloading with unapplied changes discards
  them (the draft is not persisted).
- **Revert** (button beside Apply, enabled only when dirty) discards the
  draft and snaps both boxes back to the last applied pose.
- **Undo calibration** (button in the panel, enabled when history exists)
  undoes the last Apply: it restores the previous calibration record, the
  previous venue values (dimensions and house), and every fixture's feet
  position/target as they were before that Apply, then re-applies that state
  (re-solve, re-hang, rebuild). History is a per-scene stack of up to 10
  entries kept in memory for the session; the most recent entry is also
  persisted in scene state as `calibration_undo` so one undo survives a
  reload. **Redo** re-applies the undone entry (single level, in-session).
- Positions table (Rig tab) and venue editor: a reference dropdown
  (`deck | house floor | ceiling`) beside the trim/height number; the row
  also shows the two derived readings in a tooltip ("12.0 ft above house
  floor · 4.0 ft below ceiling").

## Apply / Revert / Undo semantics

| Action | Effect on draft | Effect on applied state | History |
|---|---|---|---|
| Drag / type | changes draft; preview only | none | none |
| Apply | draft becomes applied | re-solve, venue save, fixtures re-hang, cloud rebuild, scene save | pushes the previous applied state |
| Revert | draft := applied | none | none |
| Undo | draft := restored | previous applied state re-applied | pops; pushes onto the single redo slot |
| Redo | draft := restored | undone state re-applied | clears the redo slot, pushes to history |
| Clear | draft := default pose | calibration removed (as today) | pushes the previous applied state, so Clear is undoable |

## Error handling

- Stage handle drags are clamped so `validateMarks` can never fail: lip width
  ≥ 5% of image width, top above the lip line, back narrower than the lip and
  above the lip line. A clamped handle flashes (`.is-clamped` class, 300 ms).
- House handle drags are clamped: floor at or below the deck, ceiling above
  the opening height, left wall < right wall with at least the stage width
  between them.
- Typed values go through the same clamps and show an inline message on
  rejection; the previous value is restored.
- Existing warnings (opening-height mismatch > 10%, perspective ratio > 0.9)
  are shown live under the panel and as ⚠ on the badge after Apply.
- Venue without `house`: defaults applied, `estimated: true`, panel note
  "House dimensions are estimates until you set them".
- Old scenes: marks present → cube appears fitted; no marks → default pose.
- Position with `height_ref` other than `deck` on a venue whose house values
  change: `trim_ft` recomputed on venue save so the stated reference holds.

## Testing

- Unit: draft/applied/history reducer (pure: apply, revert, undo, redo,
  clear; cap 10; redo slot cleared by a new Apply); handle ↔ marks mapping (drag top handle writes `top` at `u_c`);
  default pose from the guessed camera produces valid marks for 4:3 and 16:9
  images; house pixel ↔ feet round trip; height-ref conversions (all three
  modes, both directions) and recompute-on-house-change; default house
  derivation; clamps for both boxes; gizmo drag → adjusted camera → marks
  round trip (project then re-solve reproduces the camera within 0.5%).
- Playwright (real input): drag `lipR` right and assert the solved
  `dist_ft` changes and the mark moved; drag the house ceiling edge and
  assert `venue.house.ceiling_ft` changed; each toggle hides/shows its box
  in both views (`window.__scene3d` names `stage-box`, `house-box`); Apply
  persists and reload restores; parity and rig smoke unchanged.
- Manual real-input pass on Capri: from the default pose fit the stage box in
  under a minute, type 40/20/30, Apply, then set the house box, then give the
  FOH truss "4 ft from the ceiling" and see its bar move.

## Implementation order (for the plan)

1. Pure modules: `height-ref.js`, cube geometry helpers (`cube-geometry.js`:
   corners, handle points, default pose, clamps, house pixel↔feet, gizmo
   camera↔marks), venue house defaults. Tests.
2. Venue/position schema additions (API + client), house defaults on load,
   recompute-on-save. Tests.
3. Photo overlay for the stage box with live preview solve; panel rewrite
   with draft/applied state, dirty indicator, Revert, Undo/Redo history
   (pure reducer + persistence of `calibration_undo`); delete marking flow.
   Playwright drag + apply + undo test.
4. House box overlay + typed fields + clamps. Playwright drag test.
5. 3D wireframes + stage-box gizmo mapping; toggles in both views.
6. Height reference in positions table and venue editor; tooltips.
7. Smoke/E2E, docs, spec status.

## Roadmap note

Spec 3 (Readouts and Measuring) is parked at its first grill question and
resumes after this ships.
