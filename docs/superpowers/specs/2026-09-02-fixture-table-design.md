# Fixture Table — Design Spec

Date: 2026-09-02
Status: Implemented 2026-09-02 (feat/fixture-table)
Roadmap position: Spec 2 of 6 (previous: Stage Calibration and Metric Lights; next: Readouts and Measuring)

## Goal

Make table-driven rig entry the primary workflow for a calibrated scene. A
designer picks or creates a **venue** (stage dimensions and hang positions),
loads and calibrates a photo, then fills a **rig**: fixtures of real types
(ERS, Fresnel, PAR, followspot, moving head, cyc/strip, other) hung on named
positions at offsets and focused on numbered acting areas. Canvas drag stays
as a secondary way to adjust. Real rigs have dozens of fixtures, so the
renderer's 8-light limit is raised to 64 by multi-pass accumulation, and
cyc/strip units become a linear light type.

Builds on `docs/superpowers/specs/2026-09-01-stage-calibration-metric-lights-design.md`
(world frame, feet fields, calibration, 3D stage).

## Non-goals (v1)

- Throw distance and beam diameter readouts, ruler tool (Spec 3).
- Rig export as CSV/PDF (Spec 4); channel, dimmer, universe/DMX columns
  (cheap to add in Spec 4).
- Fixture inventory by manufacturer/model; photometric data.
- Physically correct inverse-square falloff (falloff stays a slider).
- Follow/co-drive mode.
- Reflectors in the rig table (they remain photographic tools in the Lights tab).

## Decisions from the grill (2026-09-01)

1. **Light limit:** multi-pass accumulation, 8 lights per pass, hard cap 64
   enabled emitters per scene. Python engine already has no limit.
2. **Cyc/strip:** a new **linear** light type (segment between two endpoints)
   in shader and Python; one slot per unit.
3. **Tree mirrors the rig:** in a calibrated scene the Lights tree's groups
   are generated from hang positions (plus "Custom"); manual group editing is
   disabled in that mode.
4. **Room for the editor:** the left pane gets a draggable divider (reusing
   `split-view.js`); the Rig tab defaults to ~520 px; width persists per tab.
5. **Venue migration:** automatic on load for scenes with embedded stage
   dimensions; the new-scene popup gains a venue picker defaulting to "New venue".
6. **Type presets:** split color defaults, conventional 3200 K / modern 5600 K
   (table below).
7. **Acting-area numbering:** house view, reading like a book (area 1 =
   downstage, audience-left = stage right); per-venue switch "number from
   stage left".

## Vocabulary

- **Venue**: a named house: stage width/height/depth, acting-area grid, hang
  positions, focus height, numbering switch. Server record, workspace-scoped.
- **Hang position** (position): a pipe, boom, or floor row with a name and
  the numbers that place it. Fixtures hang on positions at an **offset**.
- **Fixture**: a light (existing light object) with rig metadata: fixture
  type, position id, offset, acting area.
- **Acting area** (area): a cell of the venue's grid over the deck; a fixture
  focused on an area aims at the cell center at the venue's focus height.
- **Custom** fixture: a fixture that was moved directly (drag, gizmo, typed
  feet) and no longer follows a position.

## Data model

### Venue (server, SQLite table `venues`, workspace-scoped like `scenes`)

```
{
  id, name, workspace_id, created_at, updated_at,
  width_ft, height_ft, depth_ft,
  grid: { rows: 3, cols: 3, number_from_stage_left: false },
  focus_height_ft: 5,
  positions: [
    { id, name: 'FOH truss',  kind: 'pipe',  upstage_ft: -40, trim_ft: 22 },
    { id, name: '1st electric', kind: 'pipe',  upstage_ft: 6,  trim_ft: 20 },
    { id, name: '2nd electric', kind: 'pipe',  upstage_ft: 14, trim_ft: 20 },
    { id, name: '3rd electric', kind: 'pipe',  upstage_ft: 22, trim_ft: 20 },
    { id, name: 'Boom SR',     kind: 'boom',  offset_ft: -22, upstage_ft: 8 },
    { id, name: 'Boom SL',     kind: 'boom',  offset_ft:  22, upstage_ft: 8 },
  ]
}
```
Starter positions (above) scale with the venue: electrics at 20%, 47%, 73%
of depth; booms 2 ft outside the lip half-width; FOH pipe at −depth×1.3,
trim = opening height + 2 ft; electrics trim = opening height.

Position kinds and their defining numbers (all feet, world frame of Spec 1:
+X audience right = stage left, +Y up, +Z upstage):
- `pipe`: `upstage_ft` (negative into the house), `trim_ft`. Fixture at
  `offset_ft` along X → `[offset, trim, upstage]`.
- `boom`: `offset_ft` (X), `upstage_ft`. Fixture at `height_ft` on the boom →
  `[offset, height, upstage]`.
- `floor`: `upstage_ft`. Fixture at `offset_ft` → `[offset, 0.5, upstage]`
  (half-foot lift so the source is not inside the deck).

Endpoints: `GET/POST /venues`, `GET/PUT/DELETE /venues/{id}`,
`POST /venues/{id}/duplicate`. Delete refuses (409) while any scene in the
workspace references the venue unless `?force=1`, in which case those scenes
keep their embedded fallback copy (below).

### Scene

- `state.venue_id` (string | null) and `state.venue_snapshot` (embedded copy
  of the venue as last loaded, so a deleted or unreachable venue never breaks
  a scene; UI shows "venue missing" with "Recreate from snapshot").
- `state.calibration` keeps only photo-specific parts: `marks`, `depth_fit`,
  `depth_check`, `units`. Its `width_ft/height_ft/depth_ft` are populated
  from the venue on load (read-only mirror for Spec 1 code paths).
- **Migration:** on load, a scene with `calibration.width_ft` and no
  `venue_id` creates a venue named after the scene (dimensions from the
  calibration, starter positions), stores `venue_id` and `venue_snapshot`,
  and saves. Silent; the badge tooltip says "Venue created from this scene".

### Fixture (fields added to the light object)

```
fixture: {
  type: 'ers' | 'fresnel' | 'par' | 'followspot' | 'moving_head' | 'cyc' | 'other',
  position_id: string | null,     // null = custom
  offset_ft: number,              // along a pipe/floor (X) or height on a boom (Y)
  area: string | null,            // e.g. '5'; null = keep existing aim
  barrel_deg | beam_deg | lamp,   // type-specific option (see presets)
  length_ft?: number,             // cyc/strip only, default 4
}
```
`light.type` becomes `'spotlight'` for all fixture types except cyc/strip,
which is the new engine type `'linear'`. Existing fields (`position_ft`,
`target_ft`, cone, softness, color, gobo, enabled, name) are the engine truth;
the fixture block is how they were derived.

Derivations (pure, `web/src/rig/geometry.js`, mirrored in Python only where
the server needs them, i.e. nowhere in v1):
- `positionToWorld(position, fixture) → [X, Y, Z]` per the kind table.
- `areaCenter(venue, areaLabel) → [X, focus_height, Z]`; labels are
  1..rows×cols; house-view numbering: row 1 is downstage, column 1 is
  audience-left (negative X); `number_from_stage_left` mirrors columns.
- `applyFixturePreset(light, type, option)` sets engine parameters (table
  below) and keeps position/aim.
- `linearEndpoints(fixture, position) → [A, B]` for cyc/strip: centered on
  the offset, along X for pipe/floor, along Y for boom, length `length_ft`.

### Fixture type presets

| Type | Engine | Cone (field angle → engine half-angle) | Softness | Color | Aim | Gobo | Option |
|---|---|---|---|---|---|---|---|
| ERS | spotlight | barrel 19/26/36/50°, default 26 | 0.05 | 3200 K | area or free | yes | `barrel_deg` |
| Fresnel | spotlight | beam 10–60°, default 30 | 0.4 | 3200 K | area or free | no | `beam_deg` |
| PAR | spotlight | VNSP 12 / NSP 20 / MFL 35 / WFL 55°, default MFL | 0.25 | 3200 K | area or free | no | `lamp` |
| Followspot | spotlight | 8° | 0.05 | 5600 K | always aimed | no | — |
| Moving head | spotlight | 20° (10–50 editable) | 0.2 | 5600 K | always aimed | yes | `beam_deg` |
| Cyc/strip | linear | n/a (wash) | 0.6 | 3200 K | none (points at deck/cyc per orientation) | no | `length_ft` |
| Other | spotlight | 30° | 0.2 | 5600 K | area or free | yes | `beam_deg` |

Intensity 1.0 for all. Engine `cone_angle` = field angle / 2 in radians.
Changing type re-applies the preset but preserves position, offset, area,
name, enabled, and intensity.

### Linear light (engine)

- `Light.type = 'linear'`, new fields `endpoint_a_ft`, `endpoint_b_ft`
  (feet, world frame) and engine-space proxies `endpoint_a`, `endpoint_b`
  (via `worldToEngine`) for the uncalibrated path and shadow marching.
- Shading: for pixel P, `Q = closest point on segment AB to P`;
  `L_vec = normalize(Q − P)`, `atten = 1/(1 + falloff·|Q − P|²)`, cone term =
  1 (wash), softness applies as a diffuse-wrap term `max(dot(N, L)+s, 0)/(1+s)`
  so a cyc unit reads as a soft floodlight. Gobo: none. Shadow marching uses
  `Q`'s engine proxy.
- Shader: `u_l_type == 3` branch, `u_l_endpoint_b[MAX_LIGHTS]` uniform
  (`u_l_position` carries endpoint A). Python mirror in `shaders.py`.
- Uncalibrated scenes may also use linear lights (endpoints in engine space);
  presets only create them from the rig.
- 3D: drawn as a bar between the endpoints with a soft wedge toward its aim.

### Multi-pass accumulation (renderer)

- `MAX_LIGHTS` stays 8 per pass. `draw()` splits enabled emitters into
  chunks of 8. Pass 1 renders ambient + chunk 1 into a half-float
  framebuffer; passes 2..n render chunk k with ambient 0 and additive
  blending into the same framebuffer; a final blit applies the existing
  sRGB encode to the canvas. Single chunk (≤ 8 lights) short-circuits to
  today's single pass so uncalibrated/small scenes are bit-identical.
- Reflectors: computed once in pass 1 (they depend on all emitters via
  `computeReflectorEmission`, which already receives the full list).
- Hard cap 64 enabled emitters: the Rig tab shows "N of 64 enabled"; enabling
  a 65th is refused with a message. Disabled fixtures cost nothing.
- Parity: a golden with 12 lights (two passes) added to the golden configs and
  the Playwright parity spec.

## UI

### Left pane: tabs and divider

- Tabs "Lights" and "Rig" in the pane header. Rig is enabled only for
  calibrated scenes (tooltip: "Calibrate the scene to build a rig"). Rig opens
  by default when a calibrated scene loads.
- A draggable divider between the left pane and the stage, built on
  `createSplitView`'s drag/ratio helpers (extract the pointer-drag logic into
  a reusable `createDragDivider` if needed; do not duplicate it). Width
  persists per tab under `photo-relight:left-pane-width:{lights|rig}`;
  defaults 260 px (Lights) and 520 px (Rig); minimum 220 px; the stage keeps
  its own split behaviour.

### Rig tab

Two stacked tables, positions above fixtures, plus a status line
"N of 64 enabled · venue: <name>".

**Positions table** — columns: name, kind (pipe/boom/floor), number 1,
number 2 (labels change with kind, in current unit), fixtures (count),
actions (add fixture here, delete). Inline editing on every cell. "Add
position" appends a pipe at the last position's upstage + 8 ft. "Load from
venue…" copies another venue's positions (append, not replace). Deleting a
position with fixtures confirms once, then moves those fixtures to Custom.

**Fixtures table** — rows grouped under position headers (and a "Custom"
header), columns: name, type, option (barrel/beam/lamp/length per type),
position, offset (or height on a boom), area, enabled, actions (clone,
remove). Inline editing; type/position/area are dropdowns; offset is a
number in the current unit. Selecting a row selects the light everywhere
(props pane, 2D, 3D). "Add fixture" appends a row copying the last row's
position and type at offset + 2 ft. Clone = same, offset + 2 ft. Names
default to `<position short name>-<n>` (e.g. `1E-3`) and are editable.

**Custom rows** show position "Custom" and their feet coordinates in place of
offset; choosing a position snaps them back onto it.

### Venue editor

Opened from the header badge (which now reads `<venue name> · 40 × 20 × 30 ft`)
or from "New venue" in the new-scene popup. Fields: name, width, height,
depth, grid rows/cols (1–6 each), focus height, "number from stage left",
positions (same table as the Rig tab's positions table). Save updates the
venue; every scene that references it re-derives fixture positions on next
load. Changing dimensions re-solves calibration on the current scene (marks
are unchanged).

### Lights tab in calibrated scenes

Groups are generated: one per position in venue order, then "Custom", then
reflectors as today. Fixtures appear under their position. Group enable
cascades as today. "+ Group", drag-to-regroup, and rename-group are disabled
with a tooltip; "+ Light" adds a Custom fixture via the existing preset
picker (which now also lists the seven fixture types).

### Grid overlay

- 3D: acting-area cells drawn on the deck grid with their labels, and hang
  positions drawn as thin bars (pipes/floor rows along X, booms vertical).
- 2D: an "Areas" checkbox in the header shows cell outlines and labels
  projected through the calibration (deck-level polygons).

### Detaching and re-attaching

Any direct move (2D drag, gizmo, typed feet, click-placement) sets
`fixture.position_id = null` (Custom) and keeps coordinates. Editing a
position's numbers never touches Custom fixtures. Choosing a position for a
Custom fixture snaps it to that position at the nearest offset (projection of
its X onto the pipe, or Y onto the boom).

## Error handling

- Rig tab on an uncalibrated scene: disabled with hint.
- Venue missing/unreachable: scene loads from `venue_snapshot`, badge shows
  "venue missing", offers "Recreate venue from snapshot".
- 65th enabled emitter: refused with "64 lights maximum; disable one first";
  the light stays disabled.
- Deleting a venue referenced by scenes: 409 with the count; `?force=1`
  path documented.
- Preset application on a light with a gobo when the new type has no gobo
  support: gobo is removed and the table notes it.
- Invalid numbers (NaN, negative trim, offset beyond ±3× stage width) are
  rejected inline; the previous value is restored.
- Multi-pass on a device without half-float render targets: fall back to
  8-bit RGBA accumulation with a console warning (banding acceptable).

## Testing

- Unit (node --test): `positionToWorld` for each kind incl. negative
  upstage; `areaCenter` for 3×3 and 4×5, both numbering modes; label ↔
  index round trip; `applyFixturePreset` for every type (cone half-angle,
  softness, color, gobo removal); `linearEndpoints` along X and Y;
  snap-to-nearest-offset; migration builds a venue from an embedded
  calibration; `createDragDivider` clamp math.
- Python: linear light shading on a synthetic 4×4 (closest-point math,
  wrap term); `Light` accepts endpoints; API tests for venues CRUD, 409 on
  referenced delete, force path, workspace scoping.
- Parity: goldens `linear_cyc` and `twelve_lights` (two passes) with
  Playwright `toMatchSnapshot` assertions as in Spec 1.
- Playwright: Rig tab adds a position and a fixture with real clicks, the
  light appears in `window.__scene3d` at the derived coordinates; 65th
  enable refused.
- Manual real-input pass: new venue → photo → calibrate → six-ERS truss →
  areas → move the truss trim → all six follow → clone/remove → detach by
  drag → reattach → reload → delete venue (409) → force → snapshot fallback.

## Implementation order (for the plan)

1. Rig geometry module + presets (pure) with tests.
2. Linear light in shader + Python + golden + parity (engine change, own commit).
3. Multi-pass accumulation + 12-light golden + parity (renderer change, own commit).
4. Venue API + store + tests; scene migration; new-scene venue picker.
5. Fixture data on lights; tree mirroring; detaching rules.
6. Left-pane tabs + draggable divider.
7. Rig tab tables (positions, fixtures), status line, cap enforcement.
8. Venue editor + badge.
9. Grid overlays (3D cells and position bars; 2D areas toggle).
10. Smoke/E2E, docs, spec status.

## Deviations (as implemented, 2026-09-02)

- **Linear light planar shadows (Python):** the planar-shadow proxy for a bar
  is a point light at the bar's midpoint; the heightfield path matches the
  shader per pixel. Cyc units rarely cast planar shadows; the parity golden
  runs with shadows off.
- **`twelve_lights` golden:** the 12-light grid is mirrored into the house
  (6/14/22 ft in front of the lip, trim 20, aimed 20 ft upstage) because the
  portrait fixture's normals face the camera and straight-down units graze.
- **Single-pass upload:** the renderer's single-pass path uploads only the
  enabled emitters (pixel-identical; a scene with 8 enabled + 1 disabled light
  no longer drops a live light).
- **"Add fixture" copies the selected row** when a fixture row is selected
  (each add selects the new light, so repeated clicks build a run on one
  position), else the last row of the table.
- **`cellCorners` lives in `web/src/rig/areas.js`** (re-exported from
  `3d/rig-overlay.js`): `three` is loaded from the import map, so a module
  that imports it cannot run under `node --test`.
- **Venue Save reloads the point cloud:** re-solving the calibration goes
  through `relight:calibration`, which rebuilds the 3D scene; a stage-only
  refresh is a later optimisation.
- **Rig tab default width is 580 px** (not 520) so both tables fit without a
  horizontal scroll; the Lights tab keeps 260.
- **`handles.js` resize listener:** each remount now replaces the previous
  window `resize` listener (stale closures threw once the light count grew).
- **"Calibration…" button in the venue editor:** in rig mode the badge and
  the Rig tab's "Venue…" both open the editor, so the editor carries the way
  back to the marking panel.
- **Duplicate remaps fixture position ids by index:** the API gives a
  duplicated venue fresh position ids; fixtures hung on the old venue follow
  to the copy by position order.
- **Parity harness:** the calibrated parity specs pin the Rig pane to the
  Lights width (the Rig tab opens by itself once calibrated) and put their
  test lights in the tree (calibration migrates a venue, which regenerates
  the tree and re-flattens `state.lights`).
- **Playwright runs one worker:** every spec pays a real `/prepare` on the one
  local GPU; with the default worker count the cold runs overlap and the
  scene-creation waits time out.

## Roadmap (unchanged)

1. Stage calibration and metric lights — done (PR #1).
2. This spec.
3. Readouts and measuring.
4. Rig export (CSV/PDF; channel/dimmer columns land here).
5. 360 orbit video.
6. TIFF export.
Later: permissioned follow / co-drive mode.
