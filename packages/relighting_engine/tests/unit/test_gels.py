"""Unit tests for gels: Kelvin→RGB and named presets."""
from __future__ import annotations

import pytest

from relighting_engine.lighting.gels import (
    GEL_PRESETS,
    apply_gel,
    kelvin_to_rgb,
    resolve_color,
)
from relighting_engine.lighting.models import Light


def test_kelvin_5500_is_near_neutral() -> None:
    r, g, b = kelvin_to_rgb(5500)
    assert 0.95 < r <= 1.0
    assert 0.95 < g <= 1.0
    assert 0.85 < b <= 1.0  # 5500 K is ever-so-slightly cool


def test_kelvin_3200_is_warm() -> None:
    r, g, b = kelvin_to_rgb(3200)
    assert r > g > b
    assert r >= 0.99


def test_kelvin_8000_is_cool() -> None:
    r, g, b = kelvin_to_rgb(8000)
    assert b >= g
    assert b > r


def test_kelvin_clamps_to_valid_range() -> None:
    a = kelvin_to_rgb(500)
    b = kelvin_to_rgb(1000)
    c = kelvin_to_rgb(40000)
    d = kelvin_to_rgb(40000)
    assert a == b
    assert c == d


def test_named_gel_presets_exist() -> None:
    for name in ("CTO", "CTB", "Plus Green 1/2", "Bastard Amber", "Steel Blue", "Surprise Pink"):
        assert name in GEL_PRESETS


def test_apply_gel_multiplies_base_color() -> None:
    base = (1.0, 1.0, 1.0)
    out = apply_gel(base, "CTO")
    # CTO warms — red channel should remain ~1, blue should drop.
    assert out[0] > out[2]


def test_resolve_color_priority() -> None:
    """Explicit RGB > Kelvin > preset."""
    l = Light(type="directional", color=(0.2, 0.3, 0.4),
              color_temperature=5500, gel_preset="CTO")
    r = resolve_color(l)
    assert r == (0.2, 0.3, 0.4)

    l2 = Light(type="directional", color=(1.0, 1.0, 1.0),
               color_temperature=3200, gel_preset="CTB")
    r2 = resolve_color(l2)
    expected = kelvin_to_rgb(3200)
    assert r2 == pytest.approx(expected, abs=1e-6)
