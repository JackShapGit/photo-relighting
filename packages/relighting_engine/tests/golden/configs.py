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

# Fixtures that have a reflector_fill golden. Only portrait_a is listed here
# because it's the only source image guaranteed to exist in CI.
REFLECTOR_FIXTURES = ["portrait_a.jpg"]

# Synthetic 40x20x30 ft stage seen head-on from 60 ft (see Global Constraints);
# marks are in image fractions for the 3:4 fixture layout, aspect comes from
# the fixture image at render time. The depth fit is matched to the portrait_a
# fixture (d_lip = 0.5 -> 60 ft, d_back = 0.7 -> 90 ft, so d = 1.0 -> 360 ft and
# nothing clamps to Z_CAM_MAX); the Task-2 synthetic a/b live in the unit tests.
CALIBRATION = {
    "width_ft": 40, "height_ft": 20, "depth_ft": 30,
    "marks": {"lipL": [0.1, 0.61333], "lipR": [0.9, 0.61333], "top": [0.5, 0.08],
              "backL": [0.23333, 0.54222], "backR": [0.76667, 0.54222]},
    "depth_fit": {"a": -0.027778, "b": 0.030556},
}


def configs() -> list[tuple[str, list[Light], float, dict | None]]:
    """(name, lights, ambient, calibration_dict | None)."""
    return [
        ("ambient_only", [], 0.4, None),
        ("single_directional", [
            Light(type="directional", direction=(0.5, -0.5, -0.5), intensity=1.0)
        ], 0.15, None),
        ("key_plus_fill", [
            Light(type="directional", direction=(0.7, -0.3, -0.6), intensity=1.0),
            Light(type="directional", direction=(-0.7, -0.3, -0.6), intensity=0.4,
                  color_temperature=4000),
        ], 0.1, None),
        ("spotlight_with_gobo", [
            Light(type="spotlight",
                  position=(0.5, 0.4, -1.5), direction=(0.0, 0.0, 1.0),
                  cone_angle=0.5, softness=0.15, intensity=1.5,
                  gobo=Gobo(texture_id="preset:window-blinds", scale=1.0)),
        ], 0.1, None),
        ("rim_only_with_mask", [
            Light(type="directional", direction=(0.0, 0.0, 1.0), intensity=1.0,
                  affects="subject", color_temperature=7500),
        ], 0.1, None),
        ("reflector_fill", [
            Light(type="directional",
                  position=(0.7, 0.3, -0.4),
                  direction=(-0.5, 0.3, -1.0),
                  color=(1.0, 0.95, 0.85),
                  intensity=1.2,
                  color_temperature=5500),
            Light(type="reflector",
                  position=(0.25, 0.55, -0.4),
                  direction=(0.0, 0.0, -1.0),
                  color=(1.0, 0.95, 0.9),
                  normal=(0.5, 0.0, 1.0),
                  size=(0.6, 0.4),
                  reflectance=0.7,
                  roughness=0.6),
        ], 0.15, None),
        ("calibrated_foh_spot", [
            Light(type="spotlight", position=(0.5, 0.2, 1.0), direction=(0.0, 0.3, -1.0),
                  position_ft=(0.0, 20.0, -60.0), target_ft=(0.0, 5.0, 10.0),
                  # 0.6 rad cone covers the 40 ft width from 60 ft; 6.0 attenuates
                  # (falloff/width_ft²) to ~1.5 on stage and puts the golden's mean
                  # luma at ~0.10 with < 3 % clipped pixels.
                  intensity=6.0, cone_angle=0.6, softness=0.1),
        ], 0.1, CALIBRATION),
        ("linear_cyc", [
            # 30 ft strip at 20 ft trim on the back line (Z = 26 of a 30 ft
            # stage), lit from the closest point on the bar with a wrapped
            # diffuse term (softness 0.6); no cone, no gobo. Intensity 7.0 puts
            # the golden's mean luma at 0.084 (4.0 gave 0.063; the strip only
            # reaches the far pixels, so the mean saturates while clipping
            # grows: 4.7 % of pixels > 0.95 at 7.0).
            Light(type="linear", endpoint_a_ft=(-15.0, 20.0, 26.0), endpoint_b_ft=(15.0, 20.0, 26.0),
                  intensity=7.0, softness=0.6),
        ], 0.1, CALIBRATION),
    ]
