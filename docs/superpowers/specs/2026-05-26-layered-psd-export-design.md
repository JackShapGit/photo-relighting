# Layered PSD Export

**Date:** 2026-05-26
**Status:** Draft
**Branch:** feat/3d-viewport

## Summary

Export each light in the scene as a separate layer in a Photoshop PSD file.
Users can open the PSD in Photoshop, GIMP, Affinity Photo, or Krita and
toggle individual light contributions on and off, exactly as they would in
the app's light tree.

## Requirements

| # | Requirement |
|---|-------------|
| R1 | Every enabled light produces its own named layer |
| R2 | A bottom "Ambient" layer contains the ambient-only illumination |
| R3 | Light layers use Linear Dodge (Add) blend mode so toggling matches the app |
| R4 | Output is 16-bit-per-channel sRGB PSD with embedded ICC profile |
| R5 | Disabled lights are excluded (no empty layers) |
| R6 | Layer names match light names; duplicates get a numeric suffix |
| R7 | Reflector layers isolate the reflector's net contribution |
| R8 | The feature is optional — guarded behind `pytoshop` availability |

## Architecture

### Approach

Approach A — Per-Light Engine Method. A new `render_layers()` method on
`RelightingEngine` calls the existing shader render in a loop, once per
light, collecting per-light contributions as separate numpy arrays. A new
PSD assembly module packages the arrays into a layered PSD file. A new API
endpoint exposes the feature over HTTP.

### Why not single-pass extraction?

Modifying `shaders.py:render()` to return intermediate per-light tensors
would be faster (one pass instead of N+1) but invasively changes the core
render function's signature and makes it harder to test. The N+1 approach
reuses the existing, tested render path and keeps the shader code clean.

### Why not API-level orchestration only?

Calling `engine.render()` N+1 times from the route handler works but
redundantly re-initializes tensor state each call. A dedicated
`render_layers()` method can share `PreparedImage` setup across passes.

## Engine Layer

### New method: `RelightingEngine.render_layers()`

```python
def render_layers(
    self,
    prepared: PreparedImage,
    lights: Sequence[Light],
    ambient: float = 0.2,
    ambient_subject: float | None = None,
    ambient_background: float | None = None,
    shadow_style: str = "off",
    output_resolution: tuple[int, int] | None = None,
) -> dict[str, np.ndarray]:
    """Return per-light layers as {name: HxWx3 float32} dict.

    Keys:
      "Ambient"       - image lit by ambient only
      "<light.name>"  - additive contribution of that light (ambient=0)

    Duplicate light names receive a numeric suffix: "Spot Light (2)".
    Disabled lights are skipped.
    """
```

**Steps:**

1. Render ambient base — call `shader_render()` with an empty lights list
   to isolate the ambient contribution.
2. For each enabled light — call `shader_render()` with only that light
   and `ambient=0`. This produces the light's isolated additive
   contribution.
3. Resize all layers if `output_resolution` is set.
4. Return dict keyed by deduplicated light names.

### New helper: `shaders.py:render_single_light()`

A thin wrapper around the existing render loop that renders one light's
contribution without ambient. Avoids the need to subtract ambient from
each pass.

```python
def render_single_light(
    prepared: PreparedImage,
    light: Light,
    device: str = "cuda",
    gobo_textures: dict[str, torch.Tensor] | None = None,
    shadow_style: str = "off",
) -> np.ndarray:
    """Render one light's additive contribution (no ambient)."""
```

### Reflector handling

Reflectors depend on emitter illumination. To isolate a reflector's
contribution:

1. Render all emitters + that reflector with ambient=0.
2. Render all emitters only with ambient=0.
3. Subtract (2) from (1) to get the reflector's net contribution.

This costs two extra passes per reflector but correctly isolates the
reflector's effect.

### Name deduplication

If multiple lights share the same name, append a counter:

```
"Spot Light", "Spot Light (2)", "Spot Light (3)"
```

The first occurrence keeps the bare name.

## PSD Assembly

### New module: `relighting_engine/lighting/psd.py`

```python
def assemble_psd(
    layers: dict[str, np.ndarray],
    icc_profile: bytes | None = None,
) -> bytes:
    """Build a 16-bit PSD from named layers.

    The "Ambient" layer (if present) is placed at the bottom with Normal
    blend mode. All other layers use Linear Dodge (Add).

    Returns the PSD as bytes.
    """
```

**Layer order (bottom to top):**

```
[Ambient]        - Normal blend mode
[Light 1 name]   - Linear Dodge (Add)
[Light 2 name]   - Linear Dodge (Add)
...
[Light N name]   - Linear Dodge (Add)
```

**Color space:** Linear float32 arrays are converted to sRGB via
`_linear_to_srgb()` (same transform as existing export) then quantized
to 16-bit unsigned (0-65535).

**ICC profile:** The sRGB ICC profile is embedded in the PSD header,
matching the existing PNG/TIFF export behavior.

**Dependency:** `pytoshop` (BSD license, pure Python). Added as an
optional dependency under `[layers]` extra:

```toml
[project.optional-dependencies]
layers = ["pytoshop>=0.6"]
```

## API Endpoint

### `POST /render/layers`

**Request schema — `RenderLayersRequest`:**

Same fields as `RenderRequest` minus `output_format` and
`output_bit_depth` (always PSD, always 16-bit):

```python
class RenderLayersRequest(BaseModel):
    session_id: str
    lights: list[LightModel]
    ambient: float = 0.2
    ambient_subject: float | None = None
    ambient_background: float | None = None
    shadow_style: Literal["off", "heightfield", "planar"] = "off"
    output_resolution: list[int] | None = None
```

**Response:**

```
Content-Type: application/x-photoshop
Content-Disposition: attachment; filename="<scene_name>.psd"
```

Body is the raw PSD bytes.

**Error cases:**

| Condition | Response |
|-----------|----------|
| `pytoshop` not installed | 501 Not Implemented |
| Invalid session_id | 404 Not Found |
| No lights provided | 200 — single-layer PSD with ambient only |
| Concurrent render on same session | 409 Conflict (existing session lock) |

### Capability advertisement

`GET /healthz` response gains a new field:

```json
{
  "capabilities": {
    "layers_export": true
  }
}
```

Set to `false` if `pytoshop` is not importable.

## Frontend

### Export button

Add an "Export Layers (PSD)" button to the export UI, next to the
existing format options. The button is hidden if `/healthz` reports
`layers_export: false`.

**On click:**

1. Collect the current light tree and scene settings.
2. POST to `/render/layers` with the scene state.
3. Download the response as `<scene_name>.psd`.
4. Show a spinner during the request (export may take a few seconds).

**Filename:** Scene name if saved, otherwise `relighting_export.psd`.
Sanitize the name for filesystem safety (strip `/\:*?"<>|`).

## Performance

| Lights | Passes | Estimated time (4K, RTX 3070) |
|--------|--------|-------------------------------|
| 1 | 2 | ~50-100 ms |
| 4 | 5 | ~125-250 ms |
| 8 | 9 | ~225-450 ms |
| 8 + 2 reflectors | 13 | ~325-650 ms |

Each pass reuses the same `PreparedImage` tensors already resident on
GPU. The bottleneck is shader math, not data transfer. PSD assembly
(CPU) adds ~50-100 ms for a 4K image at 16-bit.

Total export time for a typical 8-light scene: under 1 second.

## Out of Scope

- **Group layers in PSD** — all layers are flat (per-light, not per-group)
- **Layer opacity mapping** — light intensity is baked into the rendered
  contribution, not mapped to PSD layer opacity
- **Round-trip editing** — PSD edits cannot be imported back into the app
- **32-bit float PSD** — limited editor support; 16-bit covers the
  quality need
- **EXR / multi-page TIFF** — PSD was chosen as the primary format;
  these could be added later if needed

## Testing

- **Unit test:** `render_layers()` returns correct number of layers,
  ambient layer is non-zero, per-light layers sum to approximately the
  full composite (within float tolerance).
- **Unit test:** Name deduplication produces expected suffixes.
- **Unit test:** PSD assembly produces a valid file that can be read back
  by `pytoshop` with correct layer count and names.
- **Integration test:** `POST /render/layers` returns a valid PSD with
  expected Content-Type and Content-Disposition headers.
- **Manual test:** Open exported PSD in Photoshop/GIMP, verify layers
  toggle independently and composite matches the app preview.
