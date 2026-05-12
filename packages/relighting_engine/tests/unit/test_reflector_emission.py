"""Unit tests for compute_reflector_emission (Stage 1 of reflector math)."""
from __future__ import annotations

import numpy as np

from relighting_engine.lighting.models import Light
from relighting_engine.lighting.reflectors import compute_reflector_emission


def _refl(**kw):
    base = dict(
        type='reflector',
        position=(0.5, 0.5, -0.5),
        direction=(0, 0, -1),
        color=(1.0, 1.0, 1.0),
        normal=(0.0, 0.0, 1.0),
        size=(0.6, 0.4),
        reflectance=1.0,
        roughness=0.5,
    )
    base.update(kw)
    return Light(**base)


def _dir_light(direction=(0, 0, -1), color=(1, 1, 1), intensity=1.0):
    return Light(
        type='directional',
        position=(0, 0, 0),
        direction=direction,
        color=color,
        intensity=intensity,
    )


def test_emission_empty_inputs_returns_empty_list() -> None:
    assert compute_reflector_emission([], []) == []


def test_no_lights_yields_zero_emission() -> None:
    [(emission, _)] = compute_reflector_emission([_refl()], [])
    assert np.allclose(emission, [0, 0, 0])


def test_single_directional_light_perpendicular_to_reflector() -> None:
    # Reflector normal +z, light shining along -z (toward reflector).
    light = _dir_light(direction=(0, 0, -1), color=(1, 1, 1), intensity=1.0)
    [(emission, dom)] = compute_reflector_emission([_refl()], [light])
    # facing = dot(+z, +z) = 1, irradiance = 1 * 1 * 1 = 1.
    # emission = (1,1,1) * 1.0 (reflectance) * (1,1,1) (tint) = (1,1,1).
    assert np.allclose(emission, [1, 1, 1], atol=1e-6)
    # Dominant: reflect(-L_dir, normal). L_dir = +z (toward source from R).
    # inc = -L_dir = -z. refl = -z - 2*(-1)*+z = -z + 2z = +z.
    assert np.allclose(dom, [0, 0, 1], atol=1e-6)


def test_light_behind_reflector_contributes_zero() -> None:
    # Reflector normal +z; directional light with direction +z means rays
    # travel +z, so the "source" is at -z (behind reflector). facing < 0.
    light = _dir_light(direction=(0, 0, 1))
    [(emission, _)] = compute_reflector_emission([_refl()], [light])
    assert np.allclose(emission, [0, 0, 0])


def test_reflectance_scales_emission() -> None:
    light = _dir_light(direction=(0, 0, -1), intensity=1.0)
    [(emission, _)] = compute_reflector_emission(
        [_refl(reflectance=0.5)], [light]
    )
    assert np.allclose(emission, [0.5, 0.5, 0.5], atol=1e-6)


def test_tint_modulates_emission() -> None:
    light = _dir_light(direction=(0, 0, -1), color=(1, 1, 1), intensity=1.0)
    [(emission, _)] = compute_reflector_emission(
        [_refl(color=(1.0, 0.8, 0.6))], [light]
    )
    assert np.allclose(emission, [1.0, 0.8, 0.6], atol=1e-6)


def test_disabled_reflector_returns_zero() -> None:
    light = _dir_light(direction=(0, 0, -1), intensity=1.0)
    [(emission, _)] = compute_reflector_emission(
        [_refl(enabled=False)], [light]
    )
    assert np.allclose(emission, [0, 0, 0])


def test_disabled_light_does_not_contribute() -> None:
    light = _dir_light(direction=(0, 0, -1), intensity=1.0)
    light.enabled = False
    [(emission, _)] = compute_reflector_emission([_refl()], [light])
    assert np.allclose(emission, [0, 0, 0])


def test_two_perpendicular_lights_average_dominant_dir() -> None:
    # Reflector normal +z.
    # Light A: directional, dir = -z → L_dir = +z → reflected ray = +z.
    # Light B: directional, dir = (-1, 0, -1)/sqrt(2) → L_dir = (1, 0, 1)/sqrt(2)
    #         → reflected ray = (-1, 0, +1)/sqrt(2).
    # Equal intensities → dominant_dir averages between them in a (+x or -x, +z) region.
    # We just confirm it's normalized and points "forward" (positive z component).
    a = _dir_light(direction=(0, 0, -1), intensity=1.0)
    b = _dir_light(direction=(-1, 0, -1), intensity=1.0)
    [(_, dom)] = compute_reflector_emission([_refl()], [a, b])
    assert dom[2] > 0
    assert abs(np.linalg.norm(dom) - 1.0) < 1e-6


def test_reflector_inputs_ignored_as_emitters() -> None:
    # A reflector passed in the emitter list should NOT contribute.
    r = _refl()
    other = _refl(position=(0, 0, 0.5))
    [(emission, _)] = compute_reflector_emission([r], [other])
    assert np.allclose(emission, [0, 0, 0])
