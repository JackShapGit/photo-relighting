# Click-to-Place Lights — Design Spec

Date: 2026-06-02
Status: Approved, ready for implementation planning

## Goal

Let a user create a light by clicking in the scene instead of accepting a preset's default position. For a directional/spotlight, **two clicks**: the first places the light, the second places its aim **target** (auto-enabling the targeting feature). Clicks work in **either** the 2D photo pane or the 3D viewport, and the clicked point's depth is sampled from the scene's depth map so the light/target land on real surfaces.

Builds directly on the existing **light targeting** feature (`docs/superpowers/specs/2026-05-30-light-targeting-design.md`): the second click sets `light.target`, and `applyTargeting` derives `direction`.

## Non-goals (v1)

- **Target snapping to the detected subject** — deferred (tracked as light-targeting v1.1).
- Placing groups, or placing multiple lights in one gesture.
- Depth-proportional standoff (v1 uses a fixed camera-ward standoff).
- Changing the `+ Light` → preset-picker entry point (it stays).
- Reflector placement changes (reflectors keep today's instant-add behavior).
- Backend changes (none are needed; depth is read client-side).

## Architecture

A dedicated **placement controller** owns the click-to-place lifecycle; both panes feed it. The key insight: both panes reduce to the same primitive — produce an **engine-space surface point** `[x, y, z]` (same space as `light.position`). The controller is pane-agnostic and never touches the DOM.

```
2D click ─→ (u,v) ─→ depthSampler.sample ─→ pixelToWorld ─→ worldToLight ─┐
                                                                          ├─→ placement.acceptSurfacePoint(engPt)
3D click ─→ NDC ─→ raycast point-cloud / plane ─→ worldToLight ───────────┘
                                                                                │
                                              click 1 → light.position (+standoff)
                                              click 2 → light.target → applyTargeting
```

### New units

**`web/src/depth-sampler.js`** — pane-independent per-pixel depth access.
- `createDepthSampler(depthUrl) → Promise<{ sample(u, v), ready }>`.
- Loads the depth PNG once into an offscreen 2D canvas (`drawImage` + `getImageData`), reusing the `loadImageData` pattern from `web/src/3d/point-cloud.js`.
- `sample(u, v)` clamps `(u,v)` to `[0,1]`, maps to the depth image's pixel `(col,row)`, and returns the **red channel `/ 255`** as depth in `[0,1]` (matches the point-cloud convention).
- Built when a scene loads (from `state.assetUrls.depth_png_url`); works whether or not the 3D pane is mounted/visible.

**`web/src/placement.js`** — the placement state machine. No DOM access; communicates through injected callbacks.
- States: `idle → awaitingLight → awaitingTarget` (the last only for directional/spotlight).
- API:
  - `begin(light, insertAt)` — start placing the given (not-yet-inserted) light node; remember where it will be inserted (`{ parentArr, index }`).
  - `acceptSurfacePoint(engPt)` — advance the state machine (see Flow).
  - `previewCursor(engPt)` — update the live preview to the cursor's current surface point.
  - `cancel()` — abort; if a light was already inserted, remove it.
  - `isActive()` / `phase()` — for adapters to know whether to capture clicks and what to preview.
- Injected callbacks (provided by `main.js`): `commitLight(light, insertAt)`, `updateLight(light)`, `removeLight(light)`, `onPhaseChange(phase)` (drives preview + cursor affordance), `redraw()`.
- Constants live here: `LIGHT_STANDOFF` (camera-ward offset), and the engine-z clamp range.

### Pane adapters (thin)

- **2D adapter** (in `web/src/handles.js` or a small sibling, over the `#handles`/`#canvas` overlay): on `pointerdown` while `placement.isActive()`, compute normalized `(u,v)` via `getBoundingClientRect()` (the refine-overlay pattern, `main.js:567`), sample depth, build the engine point, and call `acceptSurfacePoint`. On `pointermove`, call `previewCursor`.
- **3D adapter** (in `web/src/3d/index.js`): on click while active, NDC → `raycaster.setFromCamera` → intersect the point-cloud `THREE.Points` (with a tuned `raycaster.params.Points.threshold`); if no hit, intersect a plane at `state.subjectMedianDepth`; convert the world hit to engine space via `worldToLight`. `pointermove` drives the preview.

## Surface point → engine point

Both panes produce an engine-space `[x,y,z]`:
- **2D:** `depth = sampler.sample(u, v)`; `world = pixelToWorld(u*W, v*H, depth, W, H)`; `engPt = worldToLight(world)`.
- **3D:** `engPt = worldToLight(hitWorldPoint)`.

`coords.js` already provides `pixelToWorld`, `worldToLight`, and `Z_SCALE = 1.5` — no new math. Depth `0.5` → engine z `0.5` (scene center); depth `0` (nearest) → engine z `1.0` (camera-side).

## Flow

1. **`+ Light` → preset picker** (unchanged). `onPickPreset(preset)` branches on `preset.fields.type`:
   - **reflector** → unchanged path (instant add at default position; `splice` into tree as today).
   - **directional / spotlight / point** → build `L = lightFromPreset(preset)`, then `placement.begin(L, insertAt)` instead of inserting immediately. Enter `awaitingLight`. (`insertAt` = the existing `pendingAddLight` target, defaulting to root end.)
2. **Click 1 — light.** `acceptSurfacePoint(engPt)`:
   - `L.position = [engPt.x, engPt.y, clamp(engPt.z + LIGHT_STANDOFF)]` (camera-ward standoff; XY stay at the clicked surface point).
   - `commitLight(L, insertAt)` — insert into the tree now so the light is live and visible; select it.
   - If `L.type` is **point** → finish: `idle`. (Single click, no target.)
   - Else (**directional/spotlight**) → enter `awaitingTarget`.
3. **Between clicks — preview.** `previewCursor(engPt)` updates a live beam from `L.position` to the cursor's current surface point: the 3D target-viz beam line + the 2D tether (reused from the targeting feature). The cursor pane shows a placement affordance (e.g. crosshair class).
4. **Click 2 — target.** `acceptSurfacePoint(engPt)`:
   - `L.target = [engPt.x, engPt.y, engPt.z]` (exactly on the surface).
   - `applyTargeting(L)` derives `direction` from `target − position`.
   - `updateLight(L)`; finish → `idle`. Normal editing resumes with `L` selected and targeted (the targeting UI from the prior feature takes over: target marker, gizmo, toggle checked).
5. **Cancel — Esc / right-click.** `cancel()`: if `L` was already committed (after click 1), `removeLight(L)`; reset to `idle`. Fully backs out the operation. A cancel during `awaitingLight` (before any click) just exits placement and returns to the prior selection.

## Edge cases

- **Click outside the image bounds (2D):** ignore (no state change) — matches the refine-overlay bounds check.
- **3D click with no surface hit:** fall back to the median-depth plane so a point is always produced.
- **Degenerate target == light XY/Z** at click 2: `applyTargeting`/`deriveDirection` already keep the prior direction on a zero-length vector (no normalization of zero) — no special handling here.
- **Scene change / new scene mid-placement:** `cancel()` is invoked by the scene-load path so no half-placed light leaks across scenes.
- **Depth sampler not ready** (image still loading) at click time: the controller treats `sample` as returning the median depth fallback until `ready` resolves, so a click never throws.

## Backward compatibility

Purely additive. Existing add-light (reflector and the default-position path) is unchanged for users who don't engage placement. No data-model change beyond what the targeting feature already added (`target`). No persistence/format change.

## Testing

- **`depth-sampler` unit (`node:test`):** feed a tiny known ImageData (mock the canvas/getImageData boundary) and assert `sample(u,v)` returns the expected red-channel/255 at mapped pixels, and clamps out-of-range `(u,v)`.
- **`placement` state-machine unit (`node:test`):** with spy callbacks and a fake surface-point source —
  - directional/spotlight: click1 sets position with `+LIGHT_STANDOFF` and commits+selects; click2 sets target and derives direction (assert `direction == normalize(target − position)`); reaches `idle`.
  - point light: click1 commits and finishes immediately; no target set.
  - `cancel()` after click1 removes the committed light; before click1 leaves the tree untouched.
  - `previewCursor` updates preview without mutating committed state.
- **Pane adapters:** manual smoke in both panes — place a spotlight via 2D (light then target, beam preview tracks the cursor, cone lands on target), place via 3D, place a point light (single click), and Esc-cancel mid-flow (light disappears).
- **Coords sanity:** confirm a 2D click near the subject yields an engine position whose `worldToLight`/`lightToWorld` round-trips match the 3D marker location (no drift between panes).

## Rollout

Ships behind no flag — it's an additive entry path. The existing default-position add still works (reflector path, and as an implicit fallback if a user dismisses placement via Esc before click 1).
