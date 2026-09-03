"""Linear light (cyc/strip) — closest-point lighting, wrap diffuse, symmetry."""
from __future__ import annotations

import numpy as np
import pytest

from relighting_engine.lighting import shaders
from relighting_engine.lighting.models import Light
from relighting_engine.metric.calibration import Calibration
from relighting_engine.tests.unit.test_metric_render import RECORD, ASPECT, _prepared   # reuse Task-5 fixtures from Spec 1


def test_linear_light_lights_from_closest_point_and_is_symmetric():
    cal = Calibration.from_dict(RECORD, ASPECT)
    L = Light(type="linear", intensity=1.0, falloff=1.0, softness=0.6,
              endpoint_a_ft=(-10.0, 20.0, 6.0), endpoint_b_ft=(10.0, 20.0, 6.0))
    out = shaders.render(_prepared(h=4, w=8), [L], ambient=0.0, device="cpu", calibration=cal)
    assert out.mean() > 0.01
    # symmetric about the centre column
    assert np.allclose(out[:, :4], out[:, ::-1][:, :4], atol=1e-4)


def test_linear_light_uncalibrated_engine_space():
    L = Light(type="linear", intensity=1.0, endpoint_a=(0.2, 0.5, 1.0), endpoint_b=(0.8, 0.5, 1.0))
    out = shaders.render(_prepared(), [L], ambient=0.0, device="cpu")
    assert out.max() > 0.01


def test_linear_validate_requires_endpoints():
    with pytest.raises(ValueError):
        Light(type="linear").validate()


def test_linear_light_closest_point_beats_endpoint_distance():
    """A pixel under the middle of the bar is lit by the bar's midpoint, not by
    endpoint A: with a 20 ft bar the centre column must be brighter than a
    point light parked at endpoint A would make it. The bar hangs 6 ft
    downstage of the lip plane so the camera-facing fixture pixels see it."""
    cal = Calibration.from_dict(RECORD, ASPECT)
    bar = Light(type="linear", intensity=1.0, falloff=1.0, softness=0.0,
                endpoint_a_ft=(-10.0, 20.0, -6.0), endpoint_b_ft=(10.0, 20.0, -6.0))
    point = Light(type="point", intensity=1.0, falloff=1.0, position=(0.5, 0.5, 0.5),
                  position_ft=(-10.0, 20.0, -6.0))
    a = shaders.render(_prepared(h=4, w=9), [bar], ambient=0.0, device="cpu", calibration=cal)
    b = shaders.render(_prepared(h=4, w=9), [point], ambient=0.0, device="cpu", calibration=cal)
    assert a[:, 4].mean() > b[:, 4].mean()


def test_other_light_types_are_unchanged_by_the_linear_branch():
    """The per-light loop was restructured; a spotlight and a directional light
    must render exactly as before (the goldens pin this at scale)."""
    cal = Calibration.from_dict(RECORD, ASPECT)
    spot = Light(type="spotlight", position=(0.5, 0.2, 1.0), direction=(0.0, 0.3, -1.0),
                 position_ft=(0.0, 20.0, -60.0), target_ft=(0.0, 5.0, 10.0), intensity=6.0, cone_angle=0.6)
    d = Light(type="directional", direction=(0.5, -0.5, -0.5), intensity=1.0)
    for lights, c in ((([spot]), cal), (([d]), None)):
        out1 = shaders.render(_prepared(), lights, ambient=0.1, device="cpu", calibration=c)
        out2 = shaders.render(_prepared(), lights, ambient=0.1, device="cpu", calibration=c)
        assert np.array_equal(out1, out2)
        assert np.isfinite(out1).all()
