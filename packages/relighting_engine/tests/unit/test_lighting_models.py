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
