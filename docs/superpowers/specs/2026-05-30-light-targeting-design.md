# Light Targeting — Design Spec

Date: 2026-05-30
Status: Approved, ready for implementation planning

## Goal

Let a directional or spotlight aim at a movable **target point** in 3D space instead of only being rotated. When a light is targeted, its direction is *derived* from `target − position`, so dragging the target (or moving the light) re-aims the beam automatically. This gives photographers an intuitive "point the light at this spot" workflow, complementing the existing rotate-by-hand controls.

## Non-goals (v1)

- **Target snapping to subject** — auto-snapping the target onto the detected subject/foreground. Deferred to v1.1.
- Targeting for `point` and `reflector` lights (point lights are omnidirectional; reflectors use `normal`).
- Multiple targets per light, or shared targets across lights.
- Target-based falloff/distance attenuation (distance to target does not change intensity).
- A new gizmo widget type; we reuse the existing TransformControls in translate mode for the target.
- Animation/keyframing of the target.

## Architecture

Targeting introduces a **fourth source of direction**, layered on top of the existing system. Direction remains stored as a normalized unit vector (`lights.js`, `models.py`) and continues to flow unchanged through the render pipeline (WebGL uniforms + PyTorch engine). Nothing downstream of direction changes.

The only new concept is: when a light has a non-null `target`, `direction` becomes a **derived** value rather than a directly-edited one. A single derivation helper computes `direction = normalize(target − position)` and is invoked whenever `target`, `position`, or a loaded scene could have changed it. The three existing direction-edit paths (3D rotate gizmo, 2D canvas handle, Z-slider) are *suppressed* while targeting is on, because they would fight the derivation.

```
target moved ─┐
position moved ─┼─→ deriveDirection(light) ─→ direction (unit vec) ─→ existing render pipeline
scene loaded ─┘
```

### Why derive instead of storing both

Storing `target` and treating `direction` as derived (not a second source of truth) avoids drift. There is exactly one rule — `direction = normalize(target − position)` — and `direction` is always recomputed, never hand-edited, while targeting is active. Old scenes (no `target`) keep `direction` as the authoritative hand-edited value. A light is therefore always in exactly one of two modes: **free-aim** (`target == null`) or **targeted** (`target != null`).

## Data model

### Web (`web/src/lights.js`)

`LightNode` gains one optional field:

| Field | Purpose |
|---|---|
| `target: [x, y, z] \| null` | **New.** A point in engine world coords the light aims at. `null` (default) = free-aim mode. Only meaningful for `directional` and `spotlight`. |

`direction` is retained and remains the field consumed by the renderer. In targeted mode it is kept in sync by the derivation helper; in free-aim mode it is edited directly as today.

### API schema (`packages/relighting_api/relighting_api/schemas.py`)

`LightModel` gains `target: Optional[Tuple[float, float, float]] = None`. Because the engine consumes the pre-derived `direction`, the schema stays backward-compatible and the engine ignores `target` beyond passing it through.

### Python engine (`packages/relighting_engine/.../models.py`, `shaders.py`)

The engine accepts `target` but does **not** re-derive direction at render time by default — the web client sends an already-derived `direction`. The engine includes the same derivation rule (below) so that direct API callers who send a `target` without a `direction` still render correctly, and so engine tests can validate derivation independently of the web client.

### Backward compatibility

`target` is optional with a `null`/`None` default. Old scenes load unchanged, no migration and no scene-version bump. A light without `target` behaves exactly as before.

## Derivation rules

`deriveDirection(light)`:

1. If `light.target == null` → return `light.direction` unchanged (free-aim mode).
2. Let `v = target − position`.
3. **Degenerate case** (`|v| ≈ 0`, i.e. target coincident with position): keep the light's previous `direction` and do not normalize a zero vector. (Optionally surface a subtle UI hint; not required for v1.)
4. Otherwise `direction = normalize(v)`.

Recompute triggers (web):
- Target dragged (3D or 2D).
- Light position changed (drag, slider, or programmatic).
- Scene loaded/imported (recompute for every targeted light after load).
- Targeting toggled on (compute initial direction from the newly-spawned target).

Directional vs spotlight: the rule is identical. Directional lights have a notional position used only as the derivation origin; the parallel-ray look at render time is unchanged because only the resulting `direction` reaches the shader.

## Interaction design

### Toggle (`web/src/controls.js`)

The light props panel gains a **"Aim at target"** toggle, shown only for `directional`/`spotlight`. Turning it on:
- Spawns a target at a sensible default — a fixed spawn distance along the light's current `direction` from its `position` (so the beam doesn't visibly jump), clamped to stay in front of the subject.
- Derives `direction` (unchanged at spawn) and suppresses the rotate-gizmo / 2D direction-handle / Z-slider.

Turning it off:
- Clears `target` to `null`, returns to free-aim, and re-enables the rotate controls. The last derived `direction` is retained as the new hand-edited value (no visible jump).

### Dragging the target

- **3D:** the existing TransformControls is attached to the target in **translate** mode while targeting is on (instead of the light's rotate handle). Dragging moves `target`; each frame re-derives `direction`.
- **2D canvas (`web/src/handles.js`):** the target gets a draggable handle reusing the existing pixel→engine conversion. The free-aim direction-handle is hidden while targeting is on.

### Gizmo suppression

While `target != null`, the three free-aim direction paths are disabled to prevent fighting the derivation: rotate gizmo (`gizmos.js`), 2D direction-handle (`handles.js`), and the direction-Z slider (`controls.js`). Position editing stays fully enabled (and re-derives direction).

## Visualization

While targeting is on, the viewport shows the aim relationship:

- **Beam line:** a thin line segment from the light `position` to `target`, color-matched to the light. Updates live as either end moves.
- **Target marker:** a small handle/crosshair primitive at `target`, draggable (the 3D translate gizmo attaches here).
- **Cone / arrow orientation:** the spotlight cone (`light-primitives.js`) and any directional arrow auto-orient along the derived direction so the cone visibly *lands on* the target. This already follows `direction`, so it works once derivation runs — no separate code path.

In free-aim mode, visualization is unchanged from today.

## Persistence, undo, testing

### Persistence

`target` serializes as part of the light node via existing save/load. No new format work beyond the optional field. Load path recomputes `direction` for targeted lights (guards against stale stored direction).

### Undo / redo

Target operations flow through the **existing light-edit undo path** — no special handling. Toggling targeting, dragging the target, and removing the target are all ordinary light state changes that the current undo system already records. Because dragging emits many intermediate states, it coalesces the same way existing drag edits do.

### Testing strategy

- **Python engine:** derivation correctness, including the degenerate `target == position` case and the directional-light case; confirm `direction`-only requests still render (engine ignores `target` when `direction` provided).
- **Web units:** `deriveDirection` helper (normal, degenerate, directional); target spawn-distance math; toggle on/off direction continuity (no jump).
- **Interaction layer:** 3D and 2D drag updates re-derive direction; gizmo/handle/slider suppression while targeted; position edits re-derive.
- **Round-trip serialization:** save→load preserves `target`; old scene (no `target`) loads unchanged.
- **Visual smoke tests:** beam line tracks both endpoints; cone/arrow lands on the target; toggling off leaves no visible jump.

## Rollout / v1.1 follow-up

v1 ships manual free-drag targeting. **v1.1** adds target-snapping-to-subject: when the target is dragged near the detected subject/foreground it snaps onto it, with a snap threshold and an un-snap gesture. Deferred because it depends on subject-mask/depth availability and adds interaction edge cases not needed to validate the core targeting workflow.
