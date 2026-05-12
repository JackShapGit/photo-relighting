# Reflectors — Design Spec

Date: 2026-05-12
Status: Approved, ready for implementation planning

## Goal

Add a passive **reflector** entity to the lighting system. A reflector is a flat rectangular surface in 3D space that bounces light from active emitters back toward the subject, with diffuse (matte/white-card) and glossy (silver/gold-card) components. Reflectors illuminate but do not emit on their own.

## Non-goals

- Multi-bounce (reflector light bouncing off another reflector).
- Specular/mirror reflections (sharp reflected light source on the subject).
- True 3D occlusion of reflector light by other geometry.
- Soft-edge falloff at the reflector's projected footprint.
- Reflector textures or gobos.
- Cookies / flags / light-blockers (separate feature).
- Reflector size editing via gizmo scale handle (sliders only in v1).
- Per-reflector live preview of "what the reflector sees."

## Architecture

A reflector is stored in the existing lights tree as a node with `type: 'reflector'`. This reuses the tree pane, drag/reorder, enabled toggle, +Light picker, props panel, 2D anchor, and 3D primitive flows.

Lighting math is split into two stages per render:

1. **CPU-side (Python engine + JS WebGL renderer):** for each reflector, accumulate the irradiance hitting its surface from active emitters; produce a single emission color and a dominant reflected direction.
2. **Shader-side (GLSL):** for each pixel, for each reflector, apply a diffuse Lambertian contribution (weighted by `roughness`) plus a glossy Phong-like lobe (weighted by `1 - roughness`) using the precomputed emission and direction.

This split keeps the shader bounded (no nested emitter loops per pixel) and keeps emission computation small (O(N_lights × N_reflectors) per frame, executed once outside the per-pixel loop).

Cap: **MAX_REFLECTORS = 4** in v1. Plenty for typical photography; exceeding it silently truncates with a planned future UI warning.

### Why diffuse + glossy (not diffuse only, not specular)

Diffuse-only captures matte/white-card behavior but loses the directional "streak" that's the main visual win of silver and gold reflectors. True specular requires raycast geometry the depth-map-based engine can't model. Diffuse + glossy is the sweet spot at moderate cost.

## Data model

Reflectors are `LightNode` objects with `type: 'reflector'`. The existing tree/UI plumbing works as-is.

### LightNode fields used for reflectors

| Field | Purpose |
|---|---|
| `id`, `kind: 'light'`, `name`, `enabled`, `affects` | Same as regular lights |
| `position: [x, y, z]` | Center of the reflector plane (engine coords) |
| `color: [r, g, b]` | Surface tint applied to bounced light |
| `normal: [nx, ny, nz]` | **New.** Unit vector perpendicular to the plane, pointing toward the subject |
| `size: [w, h]` | **New.** Plane dimensions in engine world units |
| `reflectance: float` | **New.** 0–1, fraction of incoming light bounced (default 0.7) |
| `roughness: float` | **New.** 0–1, glossy (0) ↔ diffuse (1) (default 0.5) |
| `direction`, `intensity`, `cone_angle`, `softness`, `falloff`, `gobo`, `color_temperature` | Stored as harmless defaults; ignored by reflector math |

### API schema (`packages/relighting_api/relighting_api/schemas.py`)

`LightModel` gains:

```python
type: Literal["directional", "point", "spotlight", "reflector"]
normal: list[float] = Field(default_factory=lambda: [0.0, 0.0, -1.0])
size: list[float] = Field(default_factory=lambda: [0.6, 0.4])
reflectance: Annotated[float, Field(ge=0.0, le=1.0)] = 0.7
roughness: Annotated[float, Field(ge=0.0, le=1.0)] = 0.5
```

All new fields are optional with defaults; existing scenes round-trip unchanged.

### Engine dataclass (`lighting/models.py`)

Mirror the same fields on the `Light` dataclass. `LightModel.to_engine()` passes them through. `Light.validate()` adds:

- `type == 'reflector'` → `normal` non-zero (auto-normalized), `size` components positive, `reflectance`/`roughness` clamped to `[0, 1]`.
- Other types → new fields ignored.

## Engine math

### Stage 1: per-reflector emission (CPU)

Before each render, for each enabled reflector R:

```
accumulated_color = [0, 0, 0]
total_intensity   = 0
dominant_dir      = [0, 0, 0]

for each enabled emitter L (type != 'reflector'):
    if L is directional:
        L_dir = -L.direction
    else:                       # point or spotlight
        L_dir = normalize(L.position - R.position)

    facing = max(0, dot(R.normal, L_dir))
    if facing == 0:             # light behind reflector — skip
        continue

    atten = 1.0
    if L is point or spotlight:
        dist  = length(L.position - R.position)
        atten = 1 / (1 + L.falloff * dist * dist)

    L_color    = effective_light_color(L)   # accounts for Kelvin / gel
    irradiance = L.intensity * atten * facing

    accumulated_color += L_color * irradiance
    total_intensity   += irradiance

    refl_dir       = reflect(-L_dir, R.normal)    # = 2*(N·L)*N - L
    dominant_dir  += refl_dir * irradiance

R.emission = accumulated_color * R.reflectance * R.color
R.dominant_dir = normalize(dominant_dir) if total_intensity > 0 else R.normal
```

`R.emission` and `R.dominant_dir` are passed to the shader as part of the reflector uniform array. Both the Python engine (`lighting/shaders.py`) and the JS WebGL renderer compute this identically.

### Stage 2: per-pixel contribution (GLSL)

In `relight.frag`, after the existing per-light loop:

```glsl
for (int i = 0; i < u_reflectorCount; i++) {
    if (u_r_enabled[i] == 0) continue;
    float maskAffect = affectsMask(u_r_affects[i], maskV);
    if (maskAffect == 0.0) continue;

    vec3 R_pos    = u_r_position[i];
    vec3 R_norm   = u_r_normal[i];
    vec3 R_emit   = u_r_emission[i];
    vec3 R_refl   = u_r_dominant_dir[i];
    float rough   = u_r_roughness[i];
    vec2  R_size  = u_r_size[i];

    vec3 Lvec = R_pos - P;
    float dist = length(Lvec) + 1e-6;
    Lvec /= dist;

    float facing = max(0.0, dot(R_norm, -Lvec));
    if (facing == 0.0) continue;

    float area  = R_size.x * R_size.y;
    float atten = area / (dist * dist + 1.0);

    // Diffuse component.
    float diffuse_w = rough;
    float ndotl = max(0.0, dot(N, Lvec));
    vec3  diffuse_contrib = R_emit * ndotl * diffuse_w * facing * atten;

    // Glossy component.
    float glossy_w     = 1.0 - rough;
    float lobe_sharpness = mix(2.0, 50.0, 1.0 - rough);
    float align          = max(0.0, dot(Lvec, R_refl));
    float lobe           = pow(align, lobe_sharpness);
    vec3  glossy_contrib = R_emit * lobe * glossy_w * facing * atten;

    total += maskAffect * (diffuse_contrib + glossy_contrib);
}
```

### Approximations / known limitations

- **No occlusion.** A reflector in shadow still emits. Acceptable for a depth-map engine without 3D geometry.
- **No edge falloff on the reflector footprint.** The `area / (dist² + 1)` term approximates intensity falloff with distance; size affects intensity but not visibility cutoff.
- **Single dominant glossy direction per reflector.** Averaging across emitters can "smear" the glossy lobe with multiple roughly-equal sources. Mitigation deferred until observed in practice; user workaround is to raise `roughness` toward 1.0.

## UI / UX

### Preset card (`web/src/presets.js`)

```javascript
{
  id: 'reflector',
  name: 'Reflector',
  icon: '▭',
  description: 'Bounce card — silver/white, 5000 K',
  fields: {
    type: 'reflector',
    position: [0.25, 0.55, -0.4],
    normal: [0.5, 0.0, 1.0],
    size: [0.6, 0.4],
    color: [1.0, 0.95, 0.9],
    reflectance: 0.7,
    roughness: 0.5,
    direction: [0, 0, -1], intensity: 1.0, falloff: 1.0,
    cone_angle: 0.5, softness: 0.1,
  },
}
```

Thumbnail: extend `scripts/make_preset_thumbs.py` to render this preset's thumbnail PNG into `web/preset-thumbs/reflector.jpg`.

### Properties panel

When `light.type === 'reflector'`, the props panel shows:

| Field | Control |
|---|---|
| `name` | text input |
| `enabled` | checkbox |
| `affects` | select (all / subject / background) |
| `size.x`, `size.y` | two sliders (0.1 – 2.0) |
| `color` | color picker |
| `reflectance` | slider (0 – 1) |
| `roughness` | slider (0 – 1), labelled "Glossy ←→ Matte" |

Position is manipulated via the 2D anchor or 3D gizmo. Direction/intensity/cone/softness/falloff/gobo are hidden for reflectors.

Implementation: `renderProps()` branches on `light.type === 'reflector'` and renders the reflector-specific fields. Reuses existing slider/picker helpers.

### 2D anchor

Reflector gets a dot on the photo canvas at `position[0] * W, position[1] * H`. Distinguished:
- Color: light cyan (separate from yellow / blue / pink slot indicators)
- A small rectangle outline drawn around the dot

Selection and drag behavior unchanged.

### 3D primitive (`web/src/3d/light-primitives.js`)

For `light.type === 'reflector'`, build:
- `THREE.PlaneGeometry(size.x, size.y)` for the visible plane
- Front face: `MeshBasicMaterial` tinted with `light.color`, `transparent: true, opacity: 0.5`
- Back face: opaque dark gray (`side: THREE.BackSide` with separate material) to make orientation obvious
- Plane oriented so its surface normal aligns with `directionToWorld(light.normal)`
- Invisible larger hit target (slightly larger plane) for raycasting
- Selection outline ring (rectangle, not torus) when selected

Position via `lightToWorld(light.position)`. Update path mirrors the existing primitive `update(light)` method.

### Gizmo behavior

- Translate gizmo (G): moves `position`
- Rotate gizmo (R): adjusts `normal` (writeback via `worldToDirection`)
- No scale gizmo in v1; `size` edited via props panel sliders

The existing `TransformControls` flow works without modification. The rotate writeback for reflectors derives `normal` from the rotated plane's local axis the same way it derives `direction` for spotlights.

### 3D viewport — lit point cloud

Reflector contribution appears automatically in the live-lit point cloud:
- Stage 1 emission computed JS-side
- Passed as uniforms to the 2D shader
- 2D shader renders subject including reflector contribution
- 3D point cloud texture-samples the canvas

No additional 3D-only shader changes required.

### Tree pane

Reflectors appear alongside lights with the ▭ icon. All existing tree behaviors (enable toggle, drag-to-reorder, context menu rename/clone/delete, group nesting) work unchanged.

## Testing

### Engine unit tests

- `tests/unit/test_lighting_models.py` — `Light.validate()` accepts reflector defaults; rejects negative `size` components and out-of-range `reflectance` / `roughness`.
- `tests/unit/test_reflector_emission.py` (new) — pure-function test of Stage 1 emission math:
  - Reflector facing a single directional emitter: emission color = emitter_color × reflectance × tint.
  - Reflector facing two emitters at 90° apart: dominant_dir averages between the two reflected rays, weighted by intensity.
  - Light behind reflector contributes 0.

### Engine integration test

Add golden fixture `packages/relighting_engine/tests/fixtures/expected/portrait_a__reflector_fill.png`:
- Single directional Key from upper-right
- One reflector at left side facing the subject, white tint, reflectance 0.7, roughness 0.6
- Expected: shadow side of face shows soft pinkish fill (white reflector × warm key)

Pixel-diff comparison via the existing test framework; no new harness.

### API tests

- `LightModel` round-trip with reflector fields (existing schema test gets a reflector case added).
- `to_engine()` carries new fields through.

### Manual checklist

After implementation:
- Add a Reflector via +Light picker → 2D dot appears, 3D plane primitive appears.
- Drag 2D anchor → 3D plane follows.
- Drag 3D gizmo translate → 2D anchor follows.
- Rotate gizmo → plane orientation changes, glossy streak shifts on subject.
- Toggle roughness slider 0 ↔ 1 → glossy streak appears / disappears in render.
- Multiple reflectors (up to 4) all contribute.
- `affects=subject` → background not affected by reflector.
- Disable toggle → contribution drops to zero.

## Risks

- **Color-space mismatch.** Reflector emission is in linear-sRGB; the shader expects linear; tint from picker is sRGB-encoded. Must decode tint to linear before multiplying with emission. Mitigation: reuse the existing `effective_light_color()` helper.
- **Glossy lobe smearing** (see §3 limitations).
- **Shader uniform cap silent truncation** (see §1).

## Estimated scope

~2 days:

- **Day 1** — schema (Pydantic + dataclass + validation) + Stage 1 emission math (Python + JS, matching) + GLSL shader additions + golden fixture + engine unit tests.
- **Day 2** — preset card + thumbnail + props panel branch + 3D plane primitive + 2D anchor styling + tree-pane icon + manual checklist sweep.

## Out of scope (future)

- Multi-bounce reflectors
- True specular / mirror reflections
- 3D occlusion of reflector light
- Soft-edge falloff at the reflector footprint
- Reflector textures / gobo equivalent
- Light-blockers (cookies / flags) as a separate entity type
- Reflector size via gizmo scale handle
- Per-reflector live preview thumbnail
- UI warning when MAX_REFLECTORS is exceeded
