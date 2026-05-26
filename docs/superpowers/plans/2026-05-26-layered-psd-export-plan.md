# Layered PSD Export Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Export each light in the scene as a separate named layer in a 16-bit PSD file, with an ambient base layer, so users can toggle individual light contributions on/off in Photoshop, GIMP, or Affinity Photo.

**Architecture:** New `render_layers()` engine method calls the existing `shader_render()` in a loop (once for ambient base, once per enabled light with ambient=0) to collect per-light contributions as separate float32 arrays. A new `psd.py` module converts these to 16-bit sRGB and assembles them into a PSD via `pytoshop` with Linear Dodge (Add) blend mode on light layers. A new `POST /render/layers` API endpoint and frontend button expose the feature.

**Tech Stack:** Python 3.11, PyTorch, `pytoshop` (BSD, pure Python), FastAPI, vanilla JS

---

## File Map

| Action | File | Responsibility |
|--------|------|----------------|
| Create | `packages/relighting_engine/relighting_engine/lighting/psd.py` | PSD assembly from named layers |
| Create | `packages/relighting_engine/tests/unit/test_psd.py` | Unit tests for PSD assembly |
| Create | `packages/relighting_engine/tests/unit/test_render_layers.py` | Unit tests for `render_layers()` and name dedup |
| Create | `packages/relighting_api/relighting_api/routes/layers.py` | `POST /render/layers` endpoint |
| Create | `packages/relighting_api/tests/api/test_layers_route.py` | Integration tests for layers endpoint |
| Modify | `packages/relighting_engine/relighting_engine/core/engine.py:142` | Add `render_layers()` method |
| Modify | `packages/relighting_engine/pyproject.toml:27` | Add `[layers]` optional dep |
| Modify | `packages/relighting_api/relighting_api/schemas.py:141` | Add `RenderLayersRequest`, extend `Capabilities` |
| Modify | `packages/relighting_api/relighting_api/main.py:43` | Register layers route, detect capability |
| Modify | `packages/relighting_api/relighting_api/routes/health.py:16` | Expose `layers_export` capability |
| Modify | `packages/relighting_api/tests/api/conftest.py:9` | Add `render_layers()` to `FakeEngine` |
| Modify | `web/src/api.js:31` | Add `renderLayers()` API function |
| Modify | `web/playground.html:31` | Add "Export Layers (PSD)" button |
| Modify | `web/src/main.js:622` | Wire up PSD export button |

---

### Task 1: Install pytoshop and add optional dependency

**Files:**
- Modify: `packages/relighting_engine/pyproject.toml:27-37`

- [ ] **Step 1: Install pytoshop**

Run: `pip install pytoshop`

- [ ] **Step 2: Add `[layers]` optional dependency**

In `packages/relighting_engine/pyproject.toml`, add a new extra after the existing `[diffusion]` block (after line 37):

```toml
layers = [
    "pytoshop>=0.6",
]
```

The full `[project.optional-dependencies]` section should read:

```toml
[project.optional-dependencies]
test = [
    "pytest>=8",
    "pytest-asyncio>=0.23",
    "scikit-image>=0.22",
]
diffusion = [
    "diffusers>=0.27,<1.0",
    "accelerate>=0.30",
    "safetensors>=0.4",
]
layers = [
    "pytoshop>=0.6",
]
```

- [ ] **Step 3: Verify import works**

Run: `python -c "import pytoshop; print(pytoshop.__version__)"`

Expected: prints a version number (e.g. `0.6.0`) with no errors.

- [ ] **Step 4: Commit**

```bash
git add packages/relighting_engine/pyproject.toml
git commit -m "feat(engine): add pytoshop optional dependency for layered PSD export"
```

---

### Task 2: PSD assembly module with tests

**Files:**
- Create: `packages/relighting_engine/relighting_engine/lighting/psd.py`
- Create: `packages/relighting_engine/tests/unit/test_psd.py`

- [ ] **Step 1: Write the failing test**

Create `packages/relighting_engine/tests/unit/test_psd.py`:

```python
"""Unit tests for PSD assembly."""
from __future__ import annotations

import io

import numpy as np
import pytest

pytoshop = pytest.importorskip("pytoshop")

from relighting_engine.lighting.psd import assemble_psd


def _white_layer(h=4, w=4):
    return np.ones((h, w, 3), dtype=np.float32)


def _gray_layer(h=4, w=4, val=0.5):
    return np.full((h, w, 3), val, dtype=np.float32)


def test_assemble_psd_returns_bytes():
    layers = {"Ambient": _gray_layer(), "Key Light": _white_layer()}
    data = assemble_psd(layers)
    assert isinstance(data, bytes)
    assert len(data) > 0


def test_assemble_psd_roundtrip_layer_count():
    layers = {"Ambient": _gray_layer(), "Key": _white_layer(), "Fill": _gray_layer(val=0.3)}
    data = assemble_psd(layers)
    psd = pytoshop.read(io.BytesIO(data))
    # pytoshop exposes layer_and_mask_info.layer_info.layer_records
    records = psd.layer_and_mask_info.layer_info.layer_records
    assert len(records) == 3


def test_assemble_psd_roundtrip_layer_names():
    layers = {"Ambient": _gray_layer(), "Key": _white_layer(), "Fill": _gray_layer(val=0.3)}
    data = assemble_psd(layers)
    psd = pytoshop.read(io.BytesIO(data))
    records = psd.layer_and_mask_info.layer_info.layer_records
    names = [r.name for r in records]
    assert "Ambient" in names
    assert "Key" in names
    assert "Fill" in names


def test_assemble_psd_16_bit():
    layers = {"Ambient": _gray_layer()}
    data = assemble_psd(layers)
    psd = pytoshop.read(io.BytesIO(data))
    assert psd.header.depth == 16


def test_assemble_psd_ambient_only():
    layers = {"Ambient": _gray_layer()}
    data = assemble_psd(layers)
    psd = pytoshop.read(io.BytesIO(data))
    records = psd.layer_and_mask_info.layer_info.layer_records
    assert len(records) == 1
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pytest packages/relighting_engine/tests/unit/test_psd.py -v`

Expected: FAIL with `ModuleNotFoundError` or `ImportError` for `relighting_engine.lighting.psd`.

- [ ] **Step 3: Implement PSD assembly module**

Create `packages/relighting_engine/relighting_engine/lighting/psd.py`:

```python
"""Assemble per-light render layers into a 16-bit PSD file.

Uses pytoshop (BSD, pure Python) to build a Photoshop-compatible PSD.
Light layers use Linear Dodge (Add) blend mode so toggling them matches
the additive composition in the app's renderer.
"""
from __future__ import annotations

import io
from collections.abc import Sequence

import numpy as np

from relighting_engine.core.io import _linear_to_srgb

# Linear Dodge (Add) blend mode key in PSD spec.
_BLEND_LINEAR_DODGE = b"lddg"
_BLEND_NORMAL = b"norm"


def assemble_psd(
    layers: dict[str, np.ndarray],
    icc_profile: bytes | None = None,
) -> bytes:
    """Build a 16-bit PSD from named float32 layers.

    Parameters
    ----------
    layers : dict mapping layer name to (H, W, 3) float32 in [0, 1] linear sRGB.
        The "Ambient" layer (if present) is placed at the bottom with Normal
        blend mode. All other layers use Linear Dodge (Add).
    icc_profile : optional sRGB ICC profile bytes to embed.

    Returns
    -------
    bytes : the complete PSD file.
    """
    import pytoshop
    from pytoshop import layers as pslayers
    from pytoshop.enums import BlendMode, ColorMode

    if not layers:
        raise ValueError("at least one layer required")

    # All layers must have the same dimensions.
    first = next(iter(layers.values()))
    h, w = first.shape[:2]

    psd = pytoshop.PsdFile(num_channels=3, height=h, width=w,
                           depth=16, color_mode=ColorMode.rgb)

    if icc_profile:
        psd.image_resources.append(
            pytoshop.image_resources.ImageResource(
                resource_id=0x040F,  # ICC profile
                name="",
                data=icc_profile,
            )
        )

    layer_records = []

    # Build layers in bottom-to-top order.
    # "Ambient" always goes first (bottom) with Normal blend.
    ordered_names: list[str] = []
    if "Ambient" in layers:
        ordered_names.append("Ambient")
    for name in layers:
        if name != "Ambient":
            ordered_names.append(name)

    for name in ordered_names:
        arr = layers[name]
        srgb = _linear_to_srgb(arr)
        u16 = np.clip(srgb * 65535 + 0.5, 0, 65535).astype(np.uint16)

        channel_data = []
        for ch in range(3):
            channel_data.append(
                pslayers.ChannelDataList(
                    data=u16[:, :, ch]
                )
            )

        blend = BlendMode.normal if name == "Ambient" else BlendMode.linear_dodge

        record = pslayers.LayerRecord(
            channels={i: channel_data[i] for i in range(3)},
            blend_mode=blend,
            name=name,
            opacity=255,
            visible=True,
            top=0, left=0, bottom=h, right=w,
        )
        layer_records.append(record)

    psd.layer_and_mask_info.layer_info = pslayers.LayerInfo(
        layer_records=layer_records
    )

    # Write the composite (flattened) image into the PSD image data section.
    # Sum all layers to produce the composite.
    composite = np.zeros((h, w, 3), dtype=np.float32)
    for arr in layers.values():
        composite += arr
    composite = np.clip(composite, 0.0, 1.0)
    comp_srgb = _linear_to_srgb(composite)
    comp_u16 = np.clip(comp_srgb * 65535 + 0.5, 0, 65535).astype(np.uint16)
    psd.image_data = [comp_u16[:, :, ch] for ch in range(3)]

    buf = io.BytesIO()
    psd.write(buf)
    return buf.getvalue()
```

**Note:** The exact `pytoshop` API may need adjustment. The implementation above follows `pytoshop`'s documented class structure. If the API differs (e.g. `ChannelDataList` vs `ChannelData`), consult `python -c "import pytoshop; help(pytoshop.layers)"` and adapt the calls. The key contract is: 16-bit RGB PSD, named layers, Linear Dodge blend mode on non-Ambient layers.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pytest packages/relighting_engine/tests/unit/test_psd.py -v`

Expected: all 5 tests PASS. If `pytoshop`'s API differs from the implementation above, adjust `psd.py` to match (the tests define the contract).

- [ ] **Step 5: Commit**

```bash
git add packages/relighting_engine/relighting_engine/lighting/psd.py packages/relighting_engine/tests/unit/test_psd.py
git commit -m "feat(engine): PSD assembly module for layered light export"
```

---

### Task 3: Name deduplication utility

**Files:**
- Modify: `packages/relighting_engine/relighting_engine/lighting/psd.py`
- Modify: `packages/relighting_engine/tests/unit/test_psd.py`

- [ ] **Step 1: Write the failing test**

Append to `packages/relighting_engine/tests/unit/test_psd.py`:

```python
from relighting_engine.lighting.psd import deduplicate_names


def test_deduplicate_names_no_dupes():
    assert deduplicate_names(["Key", "Fill", "Rim"]) == ["Key", "Fill", "Rim"]


def test_deduplicate_names_with_dupes():
    result = deduplicate_names(["Spot Light", "Spot Light", "Spot Light", "Fill"])
    assert result == ["Spot Light", "Spot Light (2)", "Spot Light (3)", "Fill"]


def test_deduplicate_names_empty():
    assert deduplicate_names([]) == []
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pytest packages/relighting_engine/tests/unit/test_psd.py::test_deduplicate_names_no_dupes -v`

Expected: FAIL with `ImportError` for `deduplicate_names`.

- [ ] **Step 3: Implement deduplicate_names**

Add to the top of `packages/relighting_engine/relighting_engine/lighting/psd.py`, after the imports:

```python
def deduplicate_names(names: list[str]) -> list[str]:
    """Append numeric suffix to duplicate names. First occurrence keeps bare name."""
    seen: dict[str, int] = {}
    result: list[str] = []
    for name in names:
        count = seen.get(name, 0) + 1
        seen[name] = count
        if count == 1:
            result.append(name)
        else:
            result.append(f"{name} ({count})")
    return result
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pytest packages/relighting_engine/tests/unit/test_psd.py -v`

Expected: all 8 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/relighting_engine/relighting_engine/lighting/psd.py packages/relighting_engine/tests/unit/test_psd.py
git commit -m "feat(engine): name deduplication for layered PSD light names"
```

---

### Task 4: `render_layers()` engine method with tests

**Files:**
- Modify: `packages/relighting_engine/relighting_engine/core/engine.py:142-163`
- Create: `packages/relighting_engine/tests/unit/test_render_layers.py`

- [ ] **Step 1: Write the failing test**

Create `packages/relighting_engine/tests/unit/test_render_layers.py`:

```python
"""Unit tests for RelightingEngine.render_layers().

Uses CPU device to run without a GPU.
"""
from __future__ import annotations

import numpy as np
import pytest

from relighting_engine.core.engine import RelightingEngine
from relighting_engine.core.prepared import PreparedImage
from relighting_engine.lighting.models import Light


def _fake_prepared(h=8, w=8) -> PreparedImage:
    return PreparedImage(
        original=np.full((h, w, 3), 0.5, dtype=np.float32),
        depth=np.full((h, w), 0.5, dtype=np.float32),
        normals=np.tile(np.array([0.0, 0.0, 1.0], dtype=np.float32), (h, w, 1)),
        mask=np.ones((h, w), dtype=np.float32),
        width=w, height=h,
        metadata={"subject_median_depth": 0.3},
    )


@pytest.fixture
def engine():
    return RelightingEngine(device="cpu")


def test_render_layers_ambient_only(engine):
    prepared = _fake_prepared()
    result = engine.render_layers(prepared, lights=[], ambient=0.2)
    assert "Ambient" in result
    assert len(result) == 1
    assert result["Ambient"].shape == (8, 8, 3)
    assert result["Ambient"].dtype == np.float32
    assert result["Ambient"].max() > 0.0


def test_render_layers_one_light(engine):
    prepared = _fake_prepared()
    lights = [Light(type="directional", direction=(0, 0, 1), intensity=1.0, name="Key")]
    result = engine.render_layers(prepared, lights=lights, ambient=0.1)
    assert "Ambient" in result
    assert "Key" in result
    assert len(result) == 2


def test_render_layers_disabled_light_skipped(engine):
    prepared = _fake_prepared()
    lights = [
        Light(type="directional", direction=(0, 0, 1), intensity=1.0, enabled=True),
        Light(type="directional", direction=(0, -1, 0), intensity=1.0, enabled=False),
    ]
    result = engine.render_layers(prepared, lights=lights, ambient=0.1)
    # Ambient + 1 enabled light = 2 layers (disabled light skipped)
    assert len(result) == 2


def test_render_layers_sum_matches_composite(engine):
    prepared = _fake_prepared()
    lights = [
        Light(type="directional", direction=(0, 0, 1), intensity=0.5),
        Light(type="point", position=(0.5, 0.5, -0.5), intensity=0.8),
    ]
    layers = engine.render_layers(prepared, lights=lights, ambient=0.2)
    composite = engine.render(prepared, lights=lights, ambient=0.2)

    layer_sum = np.zeros_like(composite)
    for arr in layers.values():
        layer_sum += arr
    layer_sum = np.clip(layer_sum, 0.0, 1.0)

    assert np.allclose(layer_sum, composite, atol=1e-4)
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pytest packages/relighting_engine/tests/unit/test_render_layers.py -v`

Expected: FAIL with `AttributeError: 'RelightingEngine' object has no attribute 'render_layers'`.

**Note:** The `Light` dataclass does not currently have a `name` field. Before implementing `render_layers`, we need to add it. Proceed to Step 3.

- [ ] **Step 3: Add `name` field to Light dataclass**

In `packages/relighting_engine/relighting_engine/lighting/models.py`, add a `name` field to the `Light` dataclass. After line 56 (`enabled: bool = True`), add:

```python
    name: str = ""
```

Also add `name` to the `to_dict` method (it's already handled by `asdict`) and to `from_dict`. In the `from_dict` classmethod, add to the constructor call:

```python
            name=d.get('name', ''),
```

- [ ] **Step 4: Add `name` field to LightModel Pydantic schema**

In `packages/relighting_api/relighting_api/schemas.py`, add to `LightModel` (after `enabled: bool = True` on line 47):

```python
    name: str = ""
```

And in the `to_engine()` method, add `name=self.name` to the `Light()` constructor call.

- [ ] **Step 5: Implement render_layers()**

In `packages/relighting_engine/relighting_engine/core/engine.py`, add this import at line 17 (after the existing `shader_render` import):

```python
from relighting_engine.lighting.psd import deduplicate_names
```

Then add the `render_layers()` method after the existing `render()` method (after line 163). Insert before the `polish()` method:

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
        """Render each enabled light as a separate layer.

        Returns a dict mapping layer name to (H, W, 3) float32 in [0, 1].
        "Ambient" key holds the ambient-only base. Each light key holds that
        light's isolated additive contribution (rendered with ambient=0).
        """
        gobos = self._gobos()

        # 1. Ambient base: render with no lights.
        ambient_layer = shader_render(
            prepared, [], ambient=ambient,
            ambient_subject=ambient_subject,
            ambient_background=ambient_background,
            device=self.device, gobo_textures=gobos,
            shadow_style=shadow_style,
        )

        enabled = [L for L in lights if L.enabled]
        emitters = [L for L in enabled if L.type != "reflector"]
        reflectors = [L for L in enabled if L.type == "reflector"]

        raw_names = [L.name or f"{L.type.title()} Light" for L in enabled]
        deduped = deduplicate_names(raw_names)

        layers: dict[str, np.ndarray] = {"Ambient": ambient_layer}

        # 2. Per-emitter layers.
        for L, name in zip(emitters, deduped[:len(emitters)]):
            layer = shader_render(
                prepared, [L], ambient=0.0,
                ambient_subject=0.0, ambient_background=0.0,
                device=self.device, gobo_textures=gobos,
                shadow_style=shadow_style,
            )
            layers[name] = layer

        # 3. Per-reflector layers: isolate net reflector contribution.
        # Render all emitters (no ambient) as the emitter-only baseline.
        if reflectors:
            emitter_only = shader_render(
                prepared, emitters, ambient=0.0,
                ambient_subject=0.0, ambient_background=0.0,
                device=self.device, gobo_textures=gobos,
                shadow_style=shadow_style,
            )
            for R, name in zip(reflectors, deduped[len(emitters):]):
                with_refl = shader_render(
                    prepared, emitters + [R], ambient=0.0,
                    ambient_subject=0.0, ambient_background=0.0,
                    device=self.device, gobo_textures=gobos,
                    shadow_style=shadow_style,
                )
                layer = np.clip(with_refl - emitter_only, 0.0, 1.0)
                layers[name] = layer

        # 4. Resize all layers if requested.
        if output_resolution is not None:
            import cv2
            tw, th = output_resolution
            layers = {
                k: cv2.resize(v, (tw, th), interpolation=cv2.INTER_LINEAR)
                for k, v in layers.items()
            }

        return layers
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `pytest packages/relighting_engine/tests/unit/test_render_layers.py -v`

Expected: all 4 tests PASS.

- [ ] **Step 7: Run existing tests to verify no regressions**

Run: `pytest packages/relighting_engine/tests/unit/ -v`

Expected: all existing tests PASS (the new `name` field has a default so existing code is unaffected).

- [ ] **Step 8: Commit**

```bash
git add packages/relighting_engine/relighting_engine/lighting/models.py packages/relighting_engine/relighting_engine/core/engine.py packages/relighting_api/relighting_api/schemas.py packages/relighting_engine/tests/unit/test_render_layers.py
git commit -m "feat(engine): render_layers() method for per-light layer decomposition"
```

---

### Task 5: API schema, route, and capability

**Files:**
- Modify: `packages/relighting_api/relighting_api/schemas.py:141-152`
- Create: `packages/relighting_api/relighting_api/routes/layers.py`
- Modify: `packages/relighting_api/relighting_api/main.py:43-57`
- Modify: `packages/relighting_api/relighting_api/routes/health.py:16`

- [ ] **Step 1: Add RenderLayersRequest schema and extend Capabilities**

In `packages/relighting_api/relighting_api/schemas.py`:

After `PolishRequest` (after line 109), add:

```python
class RenderLayersRequest(BaseModel):
    """POST /render/layers body. Always outputs 16-bit PSD."""
    session_id: str
    lights: list[LightModel] = Field(default_factory=list)
    ambient: Annotated[float, Field(ge=0.0)] = 0.2
    ambient_subject: Annotated[float | None, Field(ge=0.0)] = None
    ambient_background: Annotated[float | None, Field(ge=0.0)] = None
    shadow_style: Literal["off", "heightfield", "planar"] = "off"
    output_resolution: list[int] | None = None
    scene_name: str = ""
```

In the `Capabilities` class (line 141-143), add the `layers_export` field:

```python
class Capabilities(BaseModel):
    polish: bool = False
    layers_export: bool = False
    segmenters: list[str] = Field(default_factory=list)
```

- [ ] **Step 2: Create the layers route**

Create `packages/relighting_api/relighting_api/routes/layers.py`:

```python
"""POST /render/layers -- render per-light layers and return a PSD file."""
from __future__ import annotations

import io
import re

import torch
from fastapi import APIRouter, HTTPException, Request, Response

from relighting_api.schemas import RenderLayersRequest

router = APIRouter()

_SANITIZE = re.compile(r'[/\\:*?"<>|]+')


@router.post("/render/layers")
async def render_layers(req: RenderLayersRequest, request: Request) -> Response:
    # Guard: pytoshop must be installed.
    if not request.app.state.capabilities.get("layers_export", False):
        raise HTTPException(status_code=501, detail="layers export not available (pytoshop not installed)")

    sessions = request.app.state.sessions
    prepared = sessions.get(req.session_id)
    if prepared is None:
        raise HTTPException(status_code=404, detail="unknown session_id")

    try:
        lights = [l.to_engine() for l in req.lights]
    except Exception as e:  # noqa: BLE001
        raise HTTPException(status_code=422, detail=str(e)) from e

    engine = getattr(request.app.state, "engine", None)
    if engine is None:
        from relighting_api.deps import get_engine
        engine = get_engine()

    out_res = tuple(req.output_resolution) if req.output_resolution else None
    async with sessions.lock(req.session_id):
        try:
            layers = engine.render_layers(
                prepared, lights=lights, ambient=req.ambient,
                ambient_subject=req.ambient_subject,
                ambient_background=req.ambient_background,
                output_resolution=out_res,
                shadow_style=req.shadow_style,
            )
        except torch.cuda.OutOfMemoryError as e:
            raise HTTPException(status_code=503, detail="GPU OOM",
                                headers={"Retry-After": "10"}) from e

    from relighting_engine.lighting.psd import assemble_psd
    from relighting_api.routes._encoding import srgb_icc

    data = assemble_psd(layers, icc_profile=srgb_icc())

    name = _SANITIZE.sub("_", req.scene_name).strip("_") if req.scene_name else "relighting_export"
    filename = f"{name}.psd"

    return Response(
        content=data,
        media_type="application/x-photoshop",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )
```

- [ ] **Step 3: Register the route and detect capability in main.py**

In `packages/relighting_api/relighting_api/main.py`:

Add import (after line 17, with the other route imports):

```python
from relighting_api.routes import layers as layers_route
```

In the `create_app` function, after the `polish_available` detection block (after line 46), add:

```python
    layers_available = False
    try:
        import pytoshop  # noqa: F401
        layers_available = True
    except ImportError:
        layers_available = False
    app.state.capabilities = {
        "polish": polish_available,
        "layers_export": layers_available,
        "segmenters": ["rmbg", "sam2"],
    }
```

Replace the existing `app.state.capabilities = { ... }` block (lines 43-46) with the above.

Add the router include (after the existing `render_route` include, around line 55):

```python
    app.include_router(layers_route.router)
```

- [ ] **Step 4: Expose `layers_export` in healthz**

In `packages/relighting_api/relighting_api/routes/health.py`, update the `Capabilities` construction (line 16-19) to include `layers_export`:

```python
    caps = Capabilities(
        polish=bool(caps_dict.get("polish", False)),
        layers_export=bool(caps_dict.get("layers_export", False)),
        segmenters=list(caps_dict.get("segmenters", [])),
    )
```

- [ ] **Step 5: Commit**

```bash
git add packages/relighting_api/relighting_api/schemas.py packages/relighting_api/relighting_api/routes/layers.py packages/relighting_api/relighting_api/main.py packages/relighting_api/relighting_api/routes/health.py
git commit -m "feat(api): POST /render/layers endpoint for layered PSD export"
```

---

### Task 6: API integration tests

**Files:**
- Modify: `packages/relighting_api/tests/api/conftest.py`
- Create: `packages/relighting_api/tests/api/test_layers_route.py`

- [ ] **Step 1: Add render_layers() to FakeEngine**

In `packages/relighting_api/tests/api/conftest.py`, add this method to the `FakeEngine` class (after the `polish` method, after line 57):

```python
    def render_layers(
        self, prepared, lights, ambient=0.2,
        ambient_subject=None, ambient_background=None,
        shadow_style="off", output_resolution=None,
    ) -> dict[str, np.ndarray]:
        self.last_lights = list(lights)
        self.last_ambient = ambient
        h = output_resolution[1] if output_resolution else prepared.height
        w = output_resolution[0] if output_resolution else prepared.width
        result = {"Ambient": np.full((h, w, 3), 0.3, dtype=np.float32)}
        for i, L in enumerate(lights):
            if L.enabled:
                name = getattr(L, "name", "") or f"Light {i+1}"
                result[name] = np.full((h, w, 3), 0.2, dtype=np.float32)
        return result
```

- [ ] **Step 2: Write the integration tests**

Create `packages/relighting_api/tests/api/test_layers_route.py`:

```python
"""Endpoint tests for POST /render/layers."""
from __future__ import annotations

import io
from pathlib import Path

import numpy as np
import pytest
from fastapi.testclient import TestClient
from PIL import Image

pytoshop = pytest.importorskip("pytoshop")

from relighting_api.main import create_app

from .conftest import FakeEngine


@pytest.fixture
def client(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> TestClient:
    monkeypatch.setenv("RELIGHT_CACHE_DIR", str(tmp_path / "sessions"))
    app = create_app(skip_engine=True)
    app.state.engine = FakeEngine()
    return TestClient(app)


def _png_bytes() -> bytes:
    arr = np.full((32, 32, 3), 128, dtype=np.uint8)
    buf = io.BytesIO()
    Image.fromarray(arr).save(buf, format="PNG")
    return buf.getvalue()


def _new_session(client: TestClient) -> str:
    r = client.post("/prepare", files={"image": ("x.png", _png_bytes(), "image/png")})
    return r.json()["session_id"]


def test_render_layers_returns_psd(client: TestClient) -> None:
    sid = _new_session(client)
    r = client.post("/render/layers", json={
        "session_id": sid,
        "lights": [{"type": "directional", "direction": [0, 0, -1], "name": "Key"}],
        "ambient": 0.3,
    })
    assert r.status_code == 200
    assert "application/x-photoshop" in r.headers["content-type"]
    assert "Content-Disposition" in r.headers
    assert ".psd" in r.headers["Content-Disposition"]


def test_render_layers_valid_psd(client: TestClient) -> None:
    sid = _new_session(client)
    r = client.post("/render/layers", json={
        "session_id": sid,
        "lights": [{"type": "directional", "direction": [0, 0, -1], "name": "Key"}],
        "ambient": 0.3,
    })
    psd = pytoshop.read(io.BytesIO(r.content))
    records = psd.layer_and_mask_info.layer_info.layer_records
    assert len(records) >= 2  # Ambient + at least 1 light


def test_render_layers_unknown_session_404(client: TestClient) -> None:
    r = client.post("/render/layers", json={
        "session_id": "nope",
        "lights": [],
        "ambient": 0.2,
    })
    assert r.status_code == 404


def test_render_layers_custom_filename(client: TestClient) -> None:
    sid = _new_session(client)
    r = client.post("/render/layers", json={
        "session_id": sid,
        "lights": [],
        "ambient": 0.2,
        "scene_name": "My Cool Scene",
    })
    assert r.status_code == 200
    assert "My Cool Scene.psd" in r.headers["Content-Disposition"]
```

- [ ] **Step 3: Run tests to verify they pass**

Run: `pytest packages/relighting_api/tests/api/test_layers_route.py -v`

Expected: all 4 tests PASS.

- [ ] **Step 4: Run all API tests for regression**

Run: `pytest packages/relighting_api/tests/ -v`

Expected: all existing tests PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/relighting_api/tests/api/conftest.py packages/relighting_api/tests/api/test_layers_route.py
git commit -m "test(api): integration tests for POST /render/layers"
```

---

### Task 7: Frontend -- Export Layers PSD button

**Files:**
- Modify: `web/src/api.js:31`
- Modify: `web/playground.html:31`
- Modify: `web/src/main.js:622`

- [ ] **Step 1: Add renderLayers() API function**

In `web/src/api.js`, after the existing `render()` function (after line 39), add:

```javascript
export async function renderLayers(body) {
  const r = await fetch('/render/layers', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`/render/layers: ${r.status}`);
  const cd = r.headers.get('content-disposition') || '';
  const m = cd.match(/filename="?([^"]+)"?/i);
  const filename = m ? m[1] : 'relighting_export.psd';
  return { blob: await r.blob(), filename };
}
```

- [ ] **Step 2: Add the Export Layers button to HTML**

In `web/playground.html`, after the existing export button on line 31:

```html
    <button id="export-btn" type="button">Export PNG</button>
    <button id="export-layers-btn" type="button" hidden>Export Layers (PSD)</button>
```

The button starts `hidden` and is revealed by JS if the capability is present.

- [ ] **Step 3: Wire up the button and capability check in main.js**

In `web/src/main.js`, add `renderLayers` to the import from `api.js`. Find the existing import line for api.js and add `renderLayers`:

```javascript
import { ..., renderLayers } from './api.js';
```

Then, in the capability check section (find where `getCapabilities()` is called and polish UI is toggled), add after the polish capability check:

```javascript
if (caps.layers_export) {
  document.getElementById('export-layers-btn').hidden = false;
}
```

Finally, after the existing `export-btn` click handler (after line 641), add:

```javascript
document.getElementById('export-layers-btn').addEventListener('click', async () => {
  if (!state.sessionId) return;
  const btn = document.getElementById('export-layers-btn');
  const origText = btn.textContent;
  btn.textContent = 'Exporting...';
  btn.disabled = true;
  try {
    const body = {
      session_id: state.sessionId,
      lights: state.lights,
      ambient: state.ambient,
      ambient_subject: state.ambientLinked === false ? state.ambientSubject : null,
      ambient_background: state.ambientLinked === false ? state.ambientBackground : null,
      shadow_style: state.shadowStyle || 'off',
      scene_name: state.sceneName || '',
    };
    const { blob, filename } = await renderLayers(body);
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a); a.click(); a.remove();
    URL.revokeObjectURL(url);
  } catch (err) {
    alert(`PSD export failed:\n${err.message}`);
  } finally {
    btn.textContent = origText;
    btn.disabled = false;
  }
});
```

- [ ] **Step 4: Manual test**

1. Start the dev server: run the start script or `uvicorn relighting_api.main:app --port 8001`
2. Open `http://localhost:8001/web/playground.html`
3. Upload an image, add a few lights
4. Verify the "Export Layers (PSD)" button is visible (requires `pytoshop` installed)
5. Click it -- a `.psd` file should download
6. Open the PSD in Photoshop or GIMP -- verify each light is a separate toggleable layer with the correct name
7. Toggle lights off/on in Photoshop -- verify the visual result matches the app

- [ ] **Step 5: Commit**

```bash
git add web/src/api.js web/playground.html web/src/main.js
git commit -m "feat(web): Export Layers (PSD) button with capability gating"
```

---

### Task 8: Healthz capability test

**Files:**
- Modify: `packages/relighting_api/tests/api/test_healthz_capabilities.py`

- [ ] **Step 1: Read existing healthz test to understand pattern**

Read: `packages/relighting_api/tests/api/test_healthz_capabilities.py`

- [ ] **Step 2: Add layers_export capability test**

Append a test to verify `layers_export` appears in the capabilities response:

```python
def test_healthz_reports_layers_export(client: TestClient) -> None:
    r = client.get("/healthz")
    assert r.status_code == 200
    body = r.json()
    assert "layers_export" in body["capabilities"]
    assert isinstance(body["capabilities"]["layers_export"], bool)
```

- [ ] **Step 3: Run tests**

Run: `pytest packages/relighting_api/tests/api/test_healthz_capabilities.py -v`

Expected: all tests PASS.

- [ ] **Step 4: Commit**

```bash
git add packages/relighting_api/tests/api/test_healthz_capabilities.py
git commit -m "test(api): verify layers_export capability in healthz response"
```

---

### Task 9: Full regression and cleanup

**Files:** none new

- [ ] **Step 1: Run all engine unit tests**

Run: `pytest packages/relighting_engine/tests/unit/ -v`

Expected: all PASS.

- [ ] **Step 2: Run all API tests**

Run: `pytest packages/relighting_api/tests/ -v`

Expected: all PASS.

- [ ] **Step 3: Verify no untracked files or dirty state**

Run: `git status`

Expected: working tree clean (or only the `generate_report.py` / `photo_relighting_report.pdf` from earlier).
