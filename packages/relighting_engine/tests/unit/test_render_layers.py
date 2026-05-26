"""Unit tests for RelightingEngine.render_layers(). Uses CPU device."""
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
    assert len(result) == 2  # Ambient + 1 enabled light

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
