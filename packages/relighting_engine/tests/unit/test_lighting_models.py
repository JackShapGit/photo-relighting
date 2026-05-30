"""Unit tests for Light/Gobo dataclasses and JSON round-trip."""
from __future__ import annotations

import pytest

from relighting_engine.lighting.models import Gobo, Light


def test_default_light_construction() -> None:
    l = Light(type="directional", direction=(0.0, -1.0, 0.5))
    assert l.enabled is True
    assert l.affects == "all"
    assert l.intensity == 1.0
    assert l.gobo is None


def test_light_dict_roundtrip() -> None:
    l = Light(
        type="spotlight",
        position=(0.5, 0.4, -0.3),
        direction=(0.0, -0.2, 1.0),
        color=(1.0, 0.85, 0.6),
        intensity=1.5,
        falloff=0.8,
        cone_angle=0.5,
        softness=0.1,
        gobo=Gobo(texture_id="preset:window-blinds", scale=1.2, rotation=0.3),
        affects="subject",
    )
    d = l.to_dict()
    l2 = Light.from_dict(d)
    assert l2 == l


def test_light_validation_rejects_zero_direction_for_directional() -> None:
    with pytest.raises(ValueError, match="direction"):
        Light(type="directional", direction=(0.0, 0.0, 0.0)).validate()


def test_light_validation_rejects_negative_intensity() -> None:
    l = Light(type="directional", direction=(0.0, -1.0, 0.0), intensity=-0.1)
    with pytest.raises(ValueError, match="intensity"):
        l.validate()


def test_light_validation_rejects_zero_cone_for_spotlight() -> None:
    l = Light(type="spotlight", direction=(0.0, 0.0, 1.0), cone_angle=0.0)
    with pytest.raises(ValueError, match="cone_angle"):
        l.validate()


def test_reflector_defaults_validate() -> None:
    from relighting_engine.lighting.models import Light
    L = Light(
        type='reflector',
        position=(0.5, 0.5, -0.5),
        direction=(0, 0, -1),
        color=(1.0, 1.0, 1.0),
        normal=(0.0, 0.0, 1.0),
        size=(0.6, 0.4),
        reflectance=0.7,
        roughness=0.5,
    )
    L.validate()       # should not raise


def test_reflector_rejects_negative_size() -> None:
    from relighting_engine.lighting.models import Light
    import pytest
    L = Light(
        type='reflector',
        position=(0, 0, 0), direction=(0, 0, -1), color=(1, 1, 1),
        normal=(0, 0, 1), size=(-0.5, 0.4),
        reflectance=0.7, roughness=0.5,
    )
    with pytest.raises(Exception):
        L.validate()


def test_reflector_rejects_out_of_range_reflectance() -> None:
    from relighting_engine.lighting.models import Light
    import pytest
    L = Light(
        type='reflector',
        position=(0, 0, 0), direction=(0, 0, -1), color=(1, 1, 1),
        normal=(0, 0, 1), size=(0.6, 0.4),
        reflectance=1.5, roughness=0.5,
    )
    with pytest.raises(Exception):
        L.validate()


def test_reflector_zero_normal_rejected() -> None:
    from relighting_engine.lighting.models import Light
    import pytest
    L = Light(
        type='reflector',
        position=(0, 0, 0), direction=(0, 0, -1), color=(1, 1, 1),
        normal=(0, 0, 0), size=(0.6, 0.4),
        reflectance=0.7, roughness=0.5,
    )
    with pytest.raises(Exception):
        L.validate()


def test_regular_light_unaffected_by_reflector_fields() -> None:
    # Non-reflector types should still validate without setting the new fields.
    from relighting_engine.lighting.models import Light
    L = Light(
        type='spotlight',
        position=(0.5, 0.3, 1.5), direction=(-0.3, 0.3, -1),
        color=(1, 1, 1), intensity=1.2,
    )
    L.validate()


import math

from relighting_engine.lighting.shaders import effective_direction


def test_light_target_dict_roundtrip() -> None:
    l = Light(type="spotlight", position=(0.5, 0.4, -0.3), target=(0.1, 0.2, -2.0))
    l2 = Light.from_dict(l.to_dict())
    assert l2.target == (0.1, 0.2, -2.0)
    assert l2 == l


def test_light_target_defaults_none() -> None:
    l = Light.from_dict({"type": "spotlight"})
    assert l.target is None


def test_effective_direction_derives_from_target() -> None:
    l = Light(type="spotlight", position=(0.0, 0.0, 0.0), target=(0.0, 0.0, -2.0),
              direction=(1.0, 0.0, 0.0))
    dx, dy, dz = effective_direction(l)
    assert math.isclose(dx, 0.0, abs_tol=1e-9)
    assert math.isclose(dy, 0.0, abs_tol=1e-9)
    assert math.isclose(dz, -1.0, abs_tol=1e-9)


def test_effective_direction_degenerate_keeps_direction() -> None:
    l = Light(type="spotlight", position=(0.5, 0.5, 1.0), target=(0.5, 0.5, 1.0),
              direction=(0.3, -0.2, -1.0))
    assert effective_direction(l) == (0.3, -0.2, -1.0)


def test_effective_direction_no_target_returns_direction() -> None:
    l = Light(type="directional", direction=(0.1, 0.2, -0.9))
    assert effective_direction(l) == (0.1, 0.2, -0.9)
