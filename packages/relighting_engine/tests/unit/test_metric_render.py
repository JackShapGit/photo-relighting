from __future__ import annotations

import numpy as np
import pytest
import torch

from relighting_engine.core.prepared import PreparedImage
from relighting_engine.lighting import shaders
from relighting_engine.lighting.models import Light
from relighting_engine.metric.calibration import Calibration

ASPECT = 1.0
RECORD = {
    "width_ft": 40, "height_ft": 20, "depth_ft": 30,
    "marks": {"lipL": [0.1, 0.61333 * 0.75], "lipR": [0.9, 0.61333 * 0.75], "top": [0.5, 0.08 * 0.75],
              "backL": [0.23333, 0.54222 * 0.75], "backR": [0.76667, 0.54222 * 0.75]},
    "depth_fit": {"a": -0.037037, "b": 0.024074},
}


def _prepared(h=4, w=4):
    original = np.full((h, w, 3), 0.5, dtype=np.float32)
    depth = np.full((h, w), 0.2, dtype=np.float32)          # everything at the lip plane (60 ft)
    normals = np.zeros((h, w, 3), dtype=np.float32); normals[..., 2] = 1.0   # facing camera
    return PreparedImage(original=original, depth=depth, normals=normals, mask=None, confidence=None,
                         width=w, height=h)


def test_front_of_house_light_illuminates_camera_facing_surface():
    cal = Calibration.from_dict(RECORD, ASPECT)
    L = Light(type="point", position=(0.5, 0.5, 1.0), intensity=1.0, falloff=1.0,
              position_ft=(0.0, 20.0, -60.0))
    out = shaders.render(_prepared(), [L], ambient=0.0, device="cpu", calibration=cal)
    assert out.mean() > 0.05


def test_behind_stage_light_does_not_illuminate_camera_facing_surface():
    cal = Calibration.from_dict(RECORD, ASPECT)
    L = Light(type="point", position=(0.5, 0.5, 0.0), intensity=1.0, falloff=1.0,
              position_ft=(0.0, 20.0, 90.0))
    out = shaders.render(_prepared(), [L], ambient=0.0, device="cpu", calibration=cal)
    assert out.max() < 1e-4


def test_uncalibrated_path_is_unchanged():
    L = Light(type="directional", direction=(0.5, -0.5, -0.5), intensity=1.0)
    a = shaders.render(_prepared(), [L], ambient=0.15, device="cpu")
    b = shaders.render(_prepared(), [L], ambient=0.15, device="cpu", calibration=None)
    assert np.array_equal(a, b)


def test_metric_falloff_uses_feet():
    cal = Calibration.from_dict(RECORD, ASPECT)
    near = Light(type="point", position=(0.5, 0.5, 1.0), intensity=1.0, falloff=1.0, position_ft=(0.0, 5.0, -10.0))
    far = Light(type="point", position=(0.5, 0.5, 1.0), intensity=1.0, falloff=1.0, position_ft=(0.0, 5.0, -40.0))
    # Compare the best-lit pixel, not the mean: the 4x4 grid spans ~50 ft of
    # stage, so a light 10 ft away hits most pixels at grazing angles and the
    # cosine loss outweighs the attenuation gain in the mean (0.147 vs 0.175).
    # The max isolates falloff in feet (0.345 near vs 0.239 far).
    a = shaders.render(_prepared(), [near], ambient=0.0, device="cpu", calibration=cal).max()
    b = shaders.render(_prepared(), [far], ambient=0.0, device="cpu", calibration=cal).max()
    assert a > b


# ── Final-review fixes: fallbacks must match the client ──

def test_missing_position_ft_is_derived_from_engine_position():
    from relighting_engine.metric.calibration import effective_fit, engine_to_world
    for rec in (RECORD, {**RECORD, "depth_fit": None}):
        cal = Calibration.from_dict(rec, ASPECT)
        L = Light(type="point", position=(0.5, 0.6, 0.8), intensity=1.0)
        pos_ft, _dir, proxy = shaders._metric_light_vectors(L, cal)
        assert pos_ft == pytest.approx(engine_to_world(L.position, cal.camera, effective_fit(cal)))
        assert proxy is not None
        assert proxy == pytest.approx(L.position, abs=1e-6)


def test_no_fit_shadow_proxy_uses_the_linear_rule():
    from relighting_engine.metric.calibration import world_to_pixel
    cal = Calibration.from_dict({**RECORD, "depth_fit": None}, ASPECT)
    L = Light(type="spotlight", position=(0.5, 0.5, 0.5), intensity=1.0, position_ft=(5.0, 4.0, 10.0))
    _pos, _dir, proxy = shaders._metric_light_vectors(L, cal)
    assert proxy is not None
    u, v, zc = world_to_pixel((5.0, 4.0, 10.0), cal.camera)
    assert proxy == pytest.approx((u, v, 1.0 - (zc - cal.camera.dist_ft) / 30.0))


def test_metric_shadow_marching_follows_the_engine_direction_field(monkeypatch):
    """Shader and Python march shadows along the same vector: the engine-space
    `direction` the client sends (kept equal to direction_eng by the client)."""
    seen = {}
    real = shaders._shadow_factor

    def spy(P, depth, L_vec_eng, *a, **k):
        seen["vec"] = L_vec_eng[0, 0].tolist()
        return real(P, depth, L_vec_eng, *a, **k)

    monkeypatch.setattr(shaders, "_shadow_factor", spy)
    cal = Calibration.from_dict(RECORD, ASPECT)
    # Deliberately inconsistent fields: the marching vector must come from `direction`.
    L = Light(type="directional", direction=(0.6, 0.0, -0.8), direction_ft=(0.0, 0.0, 1.0), intensity=1.0)
    shaders.render(_prepared(), [L], ambient=0.0, device="cpu", calibration=cal, shadow_style="heightfield")
    assert seen["vec"] == pytest.approx([-0.6, 0.0, 0.8], abs=1e-6)
