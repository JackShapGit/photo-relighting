"""Golden test inputs: 10 fixture image names × 5 light configurations.

Fixture images live under tests/fixtures/images/. If a fixture is absent on disk,
the golden run skips it (logged) — this keeps CI flexible while reviewers can
add real photos as fixtures progress."""
from __future__ import annotations

from relighting_engine.lighting.models import Gobo, Light

FIXTURES = [
    "portrait_a.jpg", "portrait_b.jpg", "still_life_a.jpg",
    "landscape_a.jpg", "object_centered.jpg", "low_contrast.jpg",
    "wide_gamut.tiff", "hi_res.png", "dark_scene.jpg", "small.jpg",
]


def configs() -> list[tuple[str, list[Light], float]]:
    return [
        ("ambient_only", [], 0.4),
        ("single_directional", [
            Light(type="directional", direction=(0.5, -0.5, -0.5), intensity=1.0)
        ], 0.15),
        ("key_plus_fill", [
            Light(type="directional", direction=(0.7, -0.3, -0.6), intensity=1.0),
            Light(type="directional", direction=(-0.7, -0.3, -0.6), intensity=0.4,
                  color_temperature=4000),
        ], 0.1),
        ("spotlight_with_gobo", [
            Light(type="spotlight",
                  position=(0.5, 0.4, -1.5), direction=(0.0, 0.0, 1.0),
                  cone_angle=0.5, softness=0.15, intensity=1.5,
                  gobo=Gobo(texture_id="preset:window-blinds", scale=1.0)),
        ], 0.1),
        ("rim_only_with_mask", [
            Light(type="directional", direction=(0.0, 0.0, 1.0), intensity=1.0,
                  affects="subject", color_temperature=7500),
        ], 0.1),
    ]
