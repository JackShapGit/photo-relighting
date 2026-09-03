# Stage Calibration and Metric Lights — Design Spec

Date: 2026-09-01
Status: Implemented 2026-09-01 (feat/stage-calibration)
Roadmap position: Spec 1 of 6 (next: Fixture Table)
Note (2026-09-02): the five-click marking UI described here was replaced by the calibration cube (see `2026-09-02-calibration-cube-design.md`); the stored calibration record format is unchanged.

## Goal

Turn a head-on photo of a stage into a metric scene so a lighting designer can
place fixtures at real front-of-house, overhead, side, and behind-stage
positions and trust the resulting positions and distances enough to hand to a
crew. The user enters the stage's width, height, and depth, marks five points
on the photo, and from then on every light has a position in feet (meters
toggle) and the renderer lights the scene from that real position.

This spec is the foundation. It deliberately stops before readouts, the
fixture table, and exports (see Roadmap).

## Non-goals (v1)

- Fixture table / table-driven light entry (Spec 2).
- Throw distance and beam diameter readouts, ruler tool (Spec 3).
- Rig export as CSV/PDF (Spec 4), 360 orbit video (Spec 5), TIFF export (Spec 6).
- Physically correct inverse-square falloff in feet. `falloff` stays a slider.
- Non-rectangular stages, thrust stages, angled or off-axis photos.
- Solid stage geometry when viewed from behind: the photo is 2.5D and the 3D
  view shows a relief from the back. This is accepted and documented in the UI.
- True occlusion or shadowing from backlights/sidelights: the engine has no
  geometry the camera did not see. Positions and directions are exact; the
  rendered look from those angles is indicative.
- Permissioned follow / co-drive mode (recorded on the roadmap for later).

## Vocabulary

- **Lip**: the downstage edge of the deck (plaster line assumed coincident).
- **Opening**: the proscenium rectangle: lip width by opening height.
- **Back line**: the upstage edge of the deck at the back wall.
- **Deck**: the stage floor, Y = 0.
- **Engine space**: the existing normalized coordinate space
  (x, y in [0, 1] image coords, z = 1 − depth) used by `light.position`.
- **World space (ft)**: the new metric frame defined below.

## World frame

- Origin: center of the lip, on the deck.
- +X: toward audience right, which is **stage left**. UI labels use "Stage L / R".
- +Y: up from the deck.
- +Z: upstage. Negative Z is into the house (front-of-house positions).
- Internal unit is **feet**. Meters is a display conversion only (1 ft =
  0.3048 m), applied in one formatting helper used by every UI surface.

## Architecture

```
 Calibration panel ──► CalibrationRecord (saved with scene)
                             │
                             ▼
                    solveCamera(record, W, H)  ──► CameraModel
                             │
     depth map ──► fitDepth(record, camera, depthSampler) ──► DepthFit {a, b}
                             │
        ┌────────────────────┼─────────────────────────┐
        ▼                    ▼                         ▼
 worldToEngine /      shader/engine metric mode    3D viewport in feet
 engineToWorld        (per-pixel P in feet,        (deck grid, house,
 (lights, targets)     lights in feet)              fixture markers)
```

### New units

**`web/src/metric/calibration.js`** — pure, no DOM.
- `CalibrationRecord` shape:
  ```
  {
    version: 1,
    units: 'ft' | 'm',              // unit the user typed in; stored values are ft
    width_ft, height_ft, depth_ft,  // stage dimensions
    marks: {                        // normalized image coords u,v in [0,1]
      lipL: [u, v], lipR: [u, v], top: [u, v], backL: [u, v], backR: [u, v]
    },
    depth_fit: { a, b } | null,     // 1/Z_cam = a * d + b  (d = depth map value)
    depth_check: { median_error_pct, warned: bool } | null
  }
  ```
- `validateMarks(record)` → `{ ok, errors: string[] }`. Rejects: lip points
  closer than 5% of image width; top mark not above the lip's deck line; back
  line wider than or equal to the lip (camera would be at or behind the
  stage); back line below the lip line (upstage edge must appear higher in a
  head-on photo from the house).
- `solveCamera(record, imageAspect)` → `CameraModel`:
  ```
  {
    f,        // focal length in normalized-image-width units
    dist_ft,  // camera to lip along Z
    height_ft,// camera height above deck
    u_c,      // principal point u (center of lip)
    v_horizon // image v of the horizon (deck plane vanishing line)
  }
  ```
  Derivation (all in normalized image coords, aspect-corrected so v is in the
  same units as u):
  - `w_lip = |lipR.u − lipL.u|`, `w_back = |backR.u − backL.u|`.
  - Perspective ratio `r = w_back / w_lip`; `dist_ft = depth_ft * r / (1 − r)`.
  - `f = w_lip * dist_ft / width_ft`.
  - Deck lines: `v_lip = mean(lipL.v, lipR.v)`, `v_back = mean(backL.v, backR.v)`.
    With `v − v_horizon = f * height_ft / Z_cam` at Z_cam = dist_ft and
    dist_ft + depth_ft, solve the two equations for `height_ft` and `v_horizon`.
  - `u_c = mean(lipL.u, lipR.u)`.
  - The solve uses width and depth only. The entered opening height is then
    honored exactly through a vertical correction factor
    `k_y = height_ft / ((v_lip − top.v) * dist_ft / f)`, which is 1.0 when the
    photo is perfectly head-on with square pixels. `CameraModel` stores `k_y`.
    `height_check_pct = |k_y − 1| * 100` drives the UI warning above 10%.
- `pixelToWorld(u, v, Z_cam, camera)` → `[X, Y, Z]` ft.
  `X = (u − u_c) * Z_cam / f`, `Y = height_ft − k_y * (v − v_horizon) * Z_cam / f`,
  `Z = Z_cam − dist_ft`.
- `worldToPixel([X, Y, Z], camera)` → `[u, v, Z_cam]` (inverse; Z_cam ≤ 0
  returns `null` — point is at or behind the camera and has no projection).
- `fitDepth(record, camera, sampleDepth)` → `{ a, b }`:
  sample the depth map along the lip segment and the back segment (median of
  ~64 samples each), giving `d_lip`, `d_back`. Solve
  `1/dist_ft = a*d_lip + b` and `1/(dist_ft + depth_ft) = a*d_back + b`.
  Returns `null` if `|d_lip − d_back| < 0.02` (flat depth, no usable fit).
- `depthToZcam(d, fit)` = `1 / (a*d + b)`, clamped to `[0.5 ft, 10000 ft]`.
- `worldToEngine([X,Y,Z], camera, fit)` → engine `[x, y, z]` for **lights**:
  This is used only for the uncalibrated-renderer fallback and for 2D handle
  placement. `[u, v] = worldToPixel`, `z = 1 − (1/Z_cam − b)/a`. For points
  with no projection (behind the camera) returns `null`.
- `engineToWorld([x,y,z], camera, fit)` → `[X,Y,Z]` ft (inverse; used when the
  user drags a 2D handle or places by click).

**`web/src/metric/units.js`** — `formatLength(ft, unit, {precision})`,
`parseLength(text, unit)`, `FT_PER_M`. Single source of unit conversion.

**`web/src/metric/calibration-panel.js`** — DOM: the panel and the five-click
marking flow. Pure state machine `createMarking()` (like `placement.js`) with
`next(u,v)`, `undo()`, `done`, tested without DOM.

**`web/src/3d/stage.js`** — deck grid, plaster line, centerline, house
extension, unit labels; fixture markers for lights beyond the point cloud.

### Changed units

**Shader (`web/src/webgl/shaders/relight.frag`) and renderer (`renderer.js`)**
- New uniforms: `u_metric` (bool), `u_cam` (f, dist_ft, height_ft, u_c,
  v_horizon), `u_depthfit` (a, b), `u_aspect`.
- When `u_metric` is true, the per-pixel position `P` is computed in feet with
  `pixelToWorld(u, v, depthToZcam(depth))` instead of the normalized box, and
  `u_l_position` / `u_l_direction` / targets are supplied in feet. All existing
  math (diffuse, cone, gobo projection, reflectors) is unchanged because it is
  already expressed in terms of `P` and light position. `atten` uses the same
  formula; `falloff` is rescaled on the JS side by `(1/scene_scale_ft)^2`
  where `scene_scale_ft = width_ft` so a falloff slider value produces roughly
  the same look before and after calibration.
- When `u_metric` is false, behavior is bit-identical to today.

**Python engine (`packages/relighting_engine/relighting_engine/lighting/shaders.py`)**
- Same metric mode, same formulas, guarded by a `calibration` argument. The
  `Light` model carries `position_ft` / `target_ft` optionally; when the
  calibration is present the engine uses them and ignores `position`.
- **Parity requirement**: the existing web/Python parity comparison gains a
  calibrated case. The metric-mode shader and Python paths must match within
  the parity test's current tolerance.

**API (`packages/relighting_api/relighting_api/schemas.py`)**
- `LightModel` gains `position_ft: list[float] | None`, `target_ft: list[float] | None`.
- Render request bodies (`RenderCommon` and the layers/PSD request) gain
  `calibration: CalibrationModel | None` mirroring `CalibrationRecord`.
- Scene persistence: `calibration` is stored in the scene JSON alongside
  `tree`; missing → uncalibrated.

**Metric depth cross-check (hybrid)**
- New engine module `depth/metric_check.py` runs the Depth Anything V2 metric
  (indoor) checkpoint once per scene when calibration is saved, on request
  from a new endpoint `POST /scenes/{id}/calibration/check`. It returns the
  median percentage disagreement between the model's metric depth and the
  fitted mapping at 9 sample points (3×3 grid over the deck region between the
  lip and back lines). The panel shows a warning when the median exceeds 20%.
  The fit is never overridden by the model. If the checkpoint is not
  available, the endpoint returns `{ available: false }` and the UI shows no
  warning and no error.

**Light data (`web/src/main.js`, `lights.js`, `tree.js`)**
- Each light gains `position_ft` and, when targeted, `target_ft`. These are
  the source of truth when the scene is calibrated. `position` / `target`
  (engine space) are kept and regenerated from feet via `worldToEngine` on any
  change to the light or to the calibration; when `worldToEngine` returns
  `null` (light behind the camera) `position` keeps its last value and the 2D
  handle is replaced by an edge arrow.
- On first calibration of a scene with existing lights, each light's
  `position_ft` is derived once via `engineToWorld`, so lights stay visually
  where they were.
- On recalibration, lights keep `position_ft` and their engine positions are
  regenerated, so fixtures stay where they physically are.

**Props pane (`controls.js`)**
- Calibrated scenes show X / Y / Z fields labeled "Stage L/R", "Height",
  "Upstage" in the current unit for the light and, when aiming is on, for its
  target. Typing moves the light immediately in 2D and 3D. Uncalibrated scenes
  show today's controls.

**Header**
- A "Calibrate" button opens the panel. After calibration it becomes a badge
  reading e.g. `40 × 20 × 30 ft` that reopens the panel.
- A unit toggle `ft | m` next to it, persisted in localStorage under
  `photo-relight:units`, default `ft`.

**3D viewport (`3d/index.js`, `point-cloud.js`, `scene.js`, `gizmos.js`)**
- Calibrated: point cloud built in feet via `pixelToWorld` per pixel; deck
  grid (1 ft minor, 5 ft major; 1 m / 5 m when meters) from 1.5× stage width
  either side and from 2× stage depth into the house to the back line; plaster
  line and centerline emphasized; orbit target = stage center at deck; home
  view frames the bounding box of stage plus all lights; far plane ≥ 2000 ft.
  Lights outside the point cloud's bounding box render as a fixture marker
  (small capped cylinder) with the existing beam cone. Gizmo handle size
  scales with camera distance so it stays grabbable at 60 ft.
- Uncalibrated: unchanged.
- Existing coordinate helpers in `3d/coords.js` gain metric counterparts;
  the normalized ones are untouched.

**2D pane (`handles.js`)**
- A light whose projection is outside `[0,1]²` or behind the camera draws a
  small arrow on the nearest canvas edge pointing toward the light, with the
  light's name. Arrows are selectable (select the light) but not draggable.

**Placement (`placement.js`, `depth-sampler.js`)**
- Clicks still produce an engine surface point; in calibrated scenes the
  controller converts it to feet via `engineToWorld` and sets `position_ft` /
  `target_ft`. No change to the state machine.

## Calibration workflow (user-facing)

1. Header → **Calibrate**. Panel: Width, Height, Depth fields; unit selector;
   "Mark on photo" button.
2. Marking: the 2D pane shows a prompt for each click in order: lip left, lip
   right, top of opening, back left, back right. Each click drops a labeled
   marker. **Undo** removes the last; **Esc** cancels marking and keeps prior
   marks. Markers are draggable after placement for fine adjustment.
3. **Apply**: validates marks, solves camera, fits depth, converts existing
   lights, saves calibration with the scene, triggers the metric depth
   cross-check asynchronously, rebuilds the 3D scene, and redraws.
4. Badge shows dimensions. Warnings (height mismatch > 10%, depth check > 20%,
   depth fit unavailable) appear in the panel and as a small ⚠ on the badge.

## Error handling

- Degenerate marks: Apply is disabled with a specific message per rule in
  `validateMarks`. The panel stays open.
- No depth map: calibration saves; `depth_fit` is null; X/Y are metric at the
  proscenium plane; Z of pixels falls back to the normalized box scaled to the
  stage depth; badge shows "no depth fit".
- Depth fit returns null (flat depth): same fallback as no depth map, with the
  message "Depth map has no usable relief between lip and back line".
- Metric check endpoint unavailable or slow: no warning, no error; a subtle
  "checking…" state times out silently after 30 s.
- Old scenes with no `calibration`: identical behavior to today. Old lights
  with no `position_ft`: derived lazily on first calibration.
- Server render with calibration but a light missing `position_ft`: the
  engine derives it from `position` via the same `engineToWorld`, so exports
  never fail on partially migrated data.

## Testing

- Unit (node --test, `web/tests/unit/metric/*.test.js`):
  - `validateMarks` for every rejection rule and a valid set.
  - `solveCamera` on a synthetic stage: 40 × 20 × 30 ft, camera at 60 ft,
    8 ft high, generated marks from a pinhole projection; assert distance,
    height, and focal within 0.5%.
  - `pixelToWorld` / `worldToPixel` round trip; `worldToPixel` returns null
    behind the camera.
  - `fitDepth` from synthetic depth values; `depthToZcam` clamps.
  - `worldToEngine` / `engineToWorld` round trip inside the frame; null
    outside/behind.
  - `units` formatting and parsing, both units, rounding.
  - `createMarking` state machine: order, undo, cancel, completion.
- Python (`pytest`): metric-mode shading on a 4×4 synthetic prepared scene
  against hand-computed expected directions; API schema accepts/rejects
  calibration payloads.
- Parity: a calibrated case added to the existing web/Python parity test
  (note: the parity spec currently fails on a stale `#file` selector; fixing
  that selector is in scope for this spec because the metric parity case
  depends on it).
- Playwright smoke: calibrated scene fixture loads, badge shows, 3D grid
  present, no console errors.
- Manual, real-input (per the split-view lesson): the five-click flow with
  real clicks, marker drag, Esc/undo, typing a front-of-house position and
  seeing the fixture marker and edge arrow, recalibrating and confirming
  lights stay put.

## Implementation order (for the plan)

1. Pure metric math module + unit tests.
2. Shader and Python metric mode + parity case (highest risk; own commit,
   landed first).
3. API schema and scene persistence.
4. Light data model migration and props-pane fields.
5. Calibration panel and marking flow.
6. 3D viewport stage grid, fixture markers, camera framing.
7. 2D edge arrows.
8. Metric depth cross-check endpoint and warning.

## Deviations (as implemented, 2026-09-01)

- Reflectors stay in the engine frame in metric mode: they get no feet
  fields, no edge arrow, and are not migrated on calibration (the spec did
  not address them; the panel treats them as uncalibrated).
- No depth fit: `effectiveFit(record)` supplies the linear fallback
  (zCam = dist_ft + d·depth_ft) to every JS geometry path (light sync, drag
  sync, placement projection, point cloud), matching the shader's
  `u_fit.z = 0` rule; the badge shows a warning glyph and the panel its
  inline warning. Python keeps its own no-fit path (shadow proxy null).
- Metric depth checkpoint location: `RELIGHT_METRIC_CKPT`, else
  `~/.cache/relighting/depth_anything_v2_metric_hypersim_vitb.pth`; never
  downloaded. `run_metric` lives in `depth/metric_check.py` with a lazy
  `depth_anything_v2` import (the shipped depth adapter is DA3 via the
  HuggingFace hub and has no model directory to share).
- Ortho gobo projection uses the engine-space light direction in metric mode
  (both shader and Python), keeping the gobo UV in the same space as the
  engine-space shadow proxy.
- WebGL/Python parity is asserted in-test: the Playwright parity spec uses
  `toMatchSnapshot` against the Python goldens under
  `tests/fixtures/expected` (maxDiffPixelRatio 0.02, threshold 0.1) via
  `snapshotPathTemplate`, instead of the standalone parity_check script.

## Roadmap (agreed 2026-09-01)

1. This spec.
2. Fixture table: table-driven light entry (type, position, aim), clone,
   remove; canvas drag secondary.
3. Readouts and measuring: throw distance, beam diameter at target, ruler
   tool, unit toggle everywhere.
4. Rig export: fixture list as CSV and PDF.
5. 360 orbit video: 30 s, 4K, from the 3D viewport.
6. TIFF export.
Later: permissioned follow / co-drive mode.
