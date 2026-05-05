"""Color helpers: Kelvin→RGB and named gel presets.

Kelvin formula is Tanner Helland's approximation (well-known, good enough for stage gels).
Presets are gel multipliers in linear-sRGB space, lifted from common Lee/Rosco filter
descriptions; not photometrically exact but visually correct in the ballpark.
"""
from __future__ import annotations

from math import log
from typing import Tuple

from relighting_engine.lighting.models import Light

RGB = Tuple[float, float, float]

GEL_PRESETS: dict[str, RGB] = {
    "CTO":              (1.00, 0.78, 0.55),  # warm — convert daylight to tungsten
    "1/2 CTO":          (1.00, 0.88, 0.74),
    "1/4 CTO":          (1.00, 0.94, 0.86),
    "CTB":              (0.65, 0.85, 1.00),  # cool — tungsten to daylight
    "1/2 CTB":          (0.78, 0.92, 1.00),
    "1/4 CTB":          (0.88, 0.96, 1.00),
    "Plus Green 1/2":   (0.85, 1.00, 0.80),
    "Plus Green":       (0.70, 1.00, 0.65),
    "Minus Green":      (1.00, 0.75, 1.00),
    "Bastard Amber":    (1.00, 0.92, 0.80),
    "Steel Blue":       (0.60, 0.80, 1.00),
    "Surprise Pink":    (1.00, 0.65, 0.85),
    "Cool White":       (0.90, 0.95, 1.00),
}


def _kelvin_raw(t: float) -> RGB:
    """Tanner Helland core formula; t = K/100, already clamped."""
    if t <= 66:
        r = 1.0
    else:
        x = t - 60
        r = min(1.0, max(0.0, (329.698727446 * (x ** -0.1332047592)) / 255.0))

    if t <= 66:
        g = (99.4708025861 * log(t) - 161.1195681661) / 255.0
    else:
        x = t - 60
        g = (288.1221695283 * (x ** -0.0755148492)) / 255.0
    g = min(1.0, max(0.0, g))

    if t >= 66:
        b = 1.0
    elif t <= 19:
        b = 0.0
    else:
        x = t - 10
        b = (138.5177312231 * log(x) - 305.0447927307) / 255.0
        b = min(1.0, max(0.0, b))

    return (r, g, b)


# White-balance reference: normalise so that 5500 K (photographic daylight) = (1, 1, 1).
_REF_5500: RGB = _kelvin_raw(5500.0 / 100.0)


def kelvin_to_rgb(k: float) -> RGB:
    """Tanner Helland approximation, white-balanced to 5500 K.

    Returns linear-sRGB-ish values in [0, 1].  5500 K (photographic daylight)
    maps to (1, 1, 1); warmer temperatures are reddish, cooler are bluish.
    """
    k = max(1000.0, min(40000.0, float(k)))
    raw = _kelvin_raw(k / 100.0)
    return tuple(  # type: ignore[return-value]
        round(min(1.0, max(0.0, c / ref)), 6)
        for c, ref in zip(raw, _REF_5500)
    )


def apply_gel(base: RGB, preset_name: str) -> RGB:
    if preset_name not in GEL_PRESETS:
        raise KeyError(f"unknown gel preset: {preset_name}")
    g = GEL_PRESETS[preset_name]
    return (base[0] * g[0], base[1] * g[1], base[2] * g[2])


def resolve_color(light: Light) -> RGB:
    """Apply priority: explicit non-white color > Kelvin > preset > white.

    A Light always carries a `color`. If that color is non-default (not white),
    it wins. Otherwise Kelvin wins. Otherwise the gel preset wins. Otherwise
    the literal `color` (which may be white).
    """
    is_default_white = (light.color == (1.0, 1.0, 1.0))
    if not is_default_white:
        return light.color
    if light.color_temperature is not None:
        return kelvin_to_rgb(light.color_temperature)
    if light.gel_preset is not None:
        return apply_gel((1.0, 1.0, 1.0), light.gel_preset)
    return light.color
