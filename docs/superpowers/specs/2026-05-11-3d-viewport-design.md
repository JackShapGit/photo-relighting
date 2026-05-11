# 3D Viewport with Blender-Style Gizmos — Design Spec

Date: 2026-05-11
Status: Approved, ready for implementation planning

## Goal

Add a 3D viewport alongside the existing 2D photo canvas where the user can manipulate lights in 3D space using Blender-style gizmos. The viewport shows the scene as a point cloud derived from the photo's depth map, with light primitives that the user can drag (translate) and rotate (direction). All interactions are bidirectional with the 2D view — moving a light in either view updates the shared state and re-fires the classical render.

## Non-goals

- Adding new lights from inside the 3D viewport (use the existing + Light button in the tree pane).
- Multi-light selection or box-select.
- Snapping (grid snap, surface snap, axis snap).
- Persisting camera state across sessions.
- Floor/grid/world-axis visualizations.
- Previewing the classical lit result inside the 3D viewport (the 3D view shows the *config*; the 2D canvas still shows the *render*).
- VR / stereo / mobile-touch gizmo support.

## Architecture

The 3D viewport is a Three.js scene rendered into a second canvas mounted adjacent to the existing photo canvas inside `#stage`. The two canvases share horizontal space via a resizable vertical divider.

```
┌─Tree pane──┬─Stage─────────────────────────────────────────┬─Props pane─┐
│            │ ┌─Photo canvas───┬──┬─3D viewport─────────┐   │            │
│  Lights    │ │  WebGL2 render │  │  Three.js scene     │   │ Selected   │
│  ──────    │ │  + 2D anchors  │  │  + point cloud      │   │ light's    │
│            │ │                │  │  + Blender gizmo    │   │ controls   │
│            │ └────────────────┴──┴─────────────────────┘   │            │
│            │            ↑                                  │            │
│            │   draggable divider                           │            │
└────────────┴───────────────────────────────────────────────┴────────────┘
```

`state.lights` (derived from `state.tree`) remains the single source of truth. The 3D viewport reads it and writes back through the same `onChange()` choke point the 2D handles already use.

### Why Three.js

`OrbitControls` and `TransformControls` (the Blender-style gizmo) ship as official examples — implementing equivalents from scratch is 1–2 days of pure math reinvention. Three.js is also better suited to scene-editor work than Babylon (which is more game-engine-oriented).

### Why a horizontal split (not toggle / picture-in-picture)

The whole purpose of moving a light in 3D is to *see how the lit image changes*. Toggling between views breaks the feedback loop. Picture-in-picture makes the 3D view too small for gizmo manipulation. A side-by-side split keeps both views live so dragging a gizmo updates the 2D render in real time.

## Package layout

New files in `web/src/3d/`:

```
web/src/3d/
  index.js            # mount + lifecycle (init, on scene change, dispose)
  scene.js            # Three.js scene + renderer + camera setup
  point-cloud.js      # builds THREE.Points from depth + photo textures
  light-primitives.js # sphere/arrow/cone meshes per light type
  gizmos.js           # TransformControls wired to the selected light
  sync.js             # bidirectional state ↔ scene sync
  hotkeys.js          # G/R/Esc/1/3/5/7/0 keyboard shortcuts
```

Modified:

- `web/playground.html` — add the importmap and a `#stage3d-wrap` element next to `#canvas-wrap`.
- `web/playground.css` — flex layout for the split, divider styling, overlay panel.
- `web/src/main.js` — mount the 3D viewport, hook it into the scene-load lifecycle, hook it into `onChange()` and `state.selectedId` subscriptions.

## Three.js dependency

Loaded via an import map in `playground.html`:

```html
<script type="importmap">
{
  "imports": {
    "three": "https://unpkg.com/three@0.165.0/build/three.module.js",
    "three/addons/": "https://unpkg.com/three@0.165.0/examples/jsm/"
  }
}
</script>
```

Pinned to 0.165.x. Vendoring locally to `web/vendor/three/` is a one-line change in the importmap when we want offline-deterministic builds.

No new Python dependencies; the engine and API are unchanged.

## Coordinate system

Reuses the existing engine convention with **no conversion layer**. Light positions are already `[x, y, z]` arrays in roughly normalized image-space coordinates (x, y ≈ [-1, 1], z > 0 behind the scene, z < 0 camera-side, photo plane at z ≈ 0).

The point cloud is built in the same space:

```
x = (col / W) * 2 - 1                  // → image x in [-1, 1]
y = -((row / H) * 2 - 1)               // → image y in [-1, 1], flipped
z = (depth[row, col] - 0.5) * Z_SCALE  // depth [0,1] centered around 0
```

`Z_SCALE` defaults to `1.5`, putting the point cloud roughly inside `z ∈ [-0.75, 0.75]` — close enough to where lights naturally sit that visual relationships are intuitive.

## Scene contents

### Point cloud

One vertex per pixel of `prepared.original`. ~2M points at 1920×1080; trivial on a modern GPU using `THREE.Points` with `GL_POINTS`.

- **Position:** from depth map per the formula above.
- **Color:** sampled from `prepared.original` (linear-sRGB encoded to sRGB for display).
- **Material:** `THREE.PointsMaterial({ vertexColors: true, sizeAttenuation: true })`.
- **Source data:** fetched from `prepared.assets.original_png_url` and `depth_png_url` — same URLs the existing renderer uses.

### Color-space note

Set `texture.colorSpace = THREE.SRGBColorSpace` and `renderer.outputColorSpace = THREE.SRGBColorSpace` so vertex colors match the 2D canvas. The 8-bit `original.png` on disk has an sRGB profile; this configuration tells Three.js to decode/encode through it.

### Light primitives

Each light renders as a small 3D widget at `light.position`:

| Type | Primitive | Direction indicator |
|---|---|---|
| **Point** | Sphere (radius ~0.05), emissive color = `light.color` | none |
| **Directional** | Sphere + arrow along `light.direction` | arrow |
| **Spotlight** | Sphere + arrow + translucent cone showing `cone_angle` (~15% alpha) | arrow + cone |

Each primitive carries `userData.lightId` so the raycaster can resolve clicks back to the source light.

**Selected light highlight:** a thin outline ring around the sphere primitive — makes the active selection obvious without depending on the gizmo being visible.

**Hit target:** an invisible larger sphere (~3× visual radius) around each primitive sits in the raycaster layer so small primitives at far zoom are still easy to click.

### Camera

- **Perspective** (default): FOV 50°, near 0.01, far 100, initial position `(0, 0, -3)` looking at origin.
- **Orthographic**: same world coordinates, different projection. Switch via dropdown in the overlay panel or hotkey **5**.
- **OrbitControls** for free orbit: middle-mouse rotates, scroll zooms, right-click pans.

### Quick-view hotkeys (Blender convention)

| Key | View |
|---|---|
| **1** | front (looking down -z from camera side) |
| **3** | right side (looking from +x) |
| **7** | top-down (looking from -y) |
| **0** | photographer's POV (camera default position) |
| **5** | toggle perspective / orthographic |

### Overlay control panel

Floats in a corner of the 3D viewport. Contains:

- **View mode** dropdown — Perspective / Orthographic.
- **Show point cloud** — checkbox, default ON.
- **Point size** — slider 1–4 px, default 2.
- **Point cloud opacity** — slider 0–100%, default 80%.
- **Reset camera** — button, snaps back to photographer's POV.

## Interaction

### Gizmo (TransformControls)

| Mode | Visual | Affects |
|---|---|---|
| **Translate** (default) | three axis arrows (X red, Y green, Z blue) + center plane | `light.position` |
| **Rotate** | three orbit circles + free-rotation sphere | `light.direction` (for directional + spotlight) |
| **Scale** | (hidden — not meaningful for lights) | — |

**Mode hotkeys** (when a light is selected and the 3D viewport has focus):

- **G** — translate.
- **R** — rotate. Only enabled for directional + spotlight; on point lights it's a no-op since point lights are isotropic.
- **Esc** — cancel current drag, revert to pre-drag value.

**Axis constraints during drag:**

- Click an axis handle to lock to that axis (built into TransformControls).
- Hold **X**, **Y**, or **Z** during drag to lock to that axis (added on top of TransformControls).
- Hold **Shift+X/Y/Z** to lock to the plane *perpendicular* to that axis (Blender convention).

### Selection

**From 3D viewport:** click a light primitive → updates `state.selectedId`. Clicking empty 3D space does not deselect (matches existing 2D behavior).

**From tree pane:** still works. Changing `state.selectedId` from anywhere → 3D viewport reattaches `TransformControls` to the new selection and pulses the outline ring briefly.

### 2D anchors remain visible

The existing 2D draggable anchors on the photo canvas stay live when the 3D pane is open. Dragging an anchor on the 2D side updates `state.lights[i].position` → the 3D gizmo follows in real time. Both views are simultaneously-active editors of the same state.

### Adding / deleting / reordering lights

All routed through the existing tree pane and its + Light button — no 3D-specific UI for these in v1.

### Hide-3D toggle

Header button **Show 3D** / **Hide 3D** collapses the right pane. The split ratio is persisted in `localStorage`; hiding sets the right pane to width 0 without losing the ratio.

When the pane is hidden, the Three.js `requestAnimationFrame` loop is paused; reopening resumes it. Scene state is preserved in memory.

## State sync

### state → 3D (subscription)

The 3D module subscribes to the existing `relight:redraw` DOM event, which already fires on every state mutation that invalidates the classical render. On each emission:

1. Diff `state.lights` against the previously-rendered set:
   - **New light** → create primitive, add to scene.
   - **Removed light** → dispose primitive, remove from scene.
   - **Modified light** → update primitive's position / direction / color / cone-angle in place.
2. If `state.selectedId` changed → reattach `TransformControls` to the new selection (or detach if nothing is selected).

Reusing the existing event avoids adding a parallel pub/sub system — every code path that already calls `redraw()` automatically keeps the 3D view in sync.

### 3D → state (gizmo drag)

`TransformControls.addEventListener('objectChange', ...)` fires on every drag tick:

1. Read the primitive's new position / rotation.
2. Update the corresponding `state.lights[i].position` or `.direction` directly.
3. Call `onChange()` — fires the throttled classical render, invalidates polish, schedules save.

The existing render-loop throttling (frame-rate cap inside `redraw`) is sufficient; no additional throttling at the 3D layer.

## Scene lifecycle

**On scene load (`applyScene`):**

1. Dispose any existing point cloud + light primitives + gizmo.
2. Fetch the new session's `original.png` + `depth.png` as `THREE.Texture` objects (parallel with the classical renderer's loads).
3. Build the point cloud + light primitives.
4. Reset the camera to the photographer's POV.

**On scene unload / page close:**

- Dispose all GL resources (textures, geometries, materials).
- Cancel any in-flight texture fetches.

## Testing

The 3D module is primarily interactive — most verification is by hand. The web playground has no JS test harness today, so two pure-function surfaces are verified via inline asserts that run on module import in dev mode (a small `assert(condition, message)` helper that throws). Production builds can strip these later if needed.

- **Coordinate helpers** (`pixelToWorld(col, row, depth, W, H, zScale)` and inverse). Sanity assertions: round-trip identity, edge pixels map to expected world coords.
- **State-diff logic** in `sync.js` — given a `prev` and `next` `state.lights` list, returns the add/remove/update operations. Sanity assertions: empty→empty is no-op, adding one yields one add op, removing one yields one remove op, changing position yields one update op.

The rest is a **manual checklist** in the spec:

- Click a light primitive → tree row highlights, props panel updates.
- Drag gizmo translate → 2D anchor follows in real time; classical render updates.
- Drag gizmo rotate on a directional light → light's beam direction visibly changes in the 2D render.
- Drag a 2D anchor → 3D gizmo follows.
- Toggle point cloud off / on → still see lights / point cloud reappears at saved opacity.
- Switch perspective → orthographic via hotkey 5.
- Number-key hotkeys 1/3/7/0 work for view presets.
- G / R / Esc hotkeys behave per Blender.
- Hide 3D pane → 2D expands to full width. Show 3D → pane returns at the saved ratio.
- Load a different scene → 3D rebuilds cleanly, no leaked memory or stuck gizmo.
- Reload page → 3D viewport mounts cleanly, point cloud appears, default camera is photographer's POV.

## Risks

- **Color space.** `prepared.original` on disk is 8-bit sRGB-encoded. Setting `THREE.SRGBColorSpace` on both texture and renderer is required; missing this will produce a noticeably different color cast in the point cloud vs. the 2D canvas. Documented above but easy to miss in implementation.
- **Z-scale tuning.** `Z_SCALE = 1.5` is a starting guess. Depth maps can be noisy and the point cloud may look "puffy" or too flat depending on the photo. May need an "exaggerate depth" slider on the overlay panel if the default doesn't feel right across our test fixtures. Defer adding the slider until we see the issue.
- **Three.js bundle size.** ~600 KB ESM. First load adds noticeable latency on slow connections. Pinning a version is essential so we don't get surprise breaking changes from `@latest`.

## Out of scope (future work)

- Right-click context menu in 3D for adding lights at a clicked point.
- Snapping (grid, surface, axis).
- Multi-light selection / box-select.
- Persisting camera state per scene.
- World-axis indicator gizmo in a viewport corner.
- Animation timeline (camera fly-through, light keyframes).
- Subject mesh from depth (extruded heightfield surface) as an alternative to point cloud.

## Estimated scope

3–4 focused days. Day-shape:

- Day 1 — Three.js scaffolding, scene, OrbitControls, point cloud rendering, layout split, importmap.
- Day 2 — Light primitives, selection, TransformControls wired to translate.
- Day 3 — Rotate mode, hotkeys, state ↔ 3D sync (both directions), scene lifecycle.
- Day 4 — Polish: overlay control panel, hide/show toggle, color-space fixes, manual checklist sweep.
