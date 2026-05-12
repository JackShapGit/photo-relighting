"""Stage 1 of reflector math: per-reflector emission + dominant reflected direction.

For each enabled reflector, walks the active emitters and accumulates:
  - emission_rgb: total light bounced back from the reflector surface,
    in linear-sRGB, ready for the shader to use as a virtual area-light
    intensity.
  - dominant_dir: a single unit vector representing the average reflected
    ray direction (intensity-weighted). Drives the glossy lobe in Stage 2.

Reflector→reflector interactions are explicitly skipped (single-bounce).
"""
from __future__ import annotations

from typing import Iterable

import numpy as np

from relighting_engine.lighting.gels import resolve_color
from relighting_engine.lighting.models import Light


def _effective_light_color(light: Light) -> np.ndarray:
    """RGB (linear-sRGB) accounting for color, Kelvin, and gel."""
    rgb = resolve_color(light)
    return np.array(rgb, dtype=np.float32)


def compute_reflector_emission(
    reflectors: Iterable[Light],
    lights: Iterable[Light],
) -> list[tuple[np.ndarray, np.ndarray]]:
    """Return a list of (emission_rgb, dominant_dir_unit) per reflector.

    Reflectors not enabled or with no incident light produce (zeros(3), normal).
    `lights` is expected to contain only emitters (type != 'reflector');
    any entries with type=='reflector' are silently skipped.
    """
    reflectors = list(reflectors)
    lights = [L for L in lights if L.type != 'reflector' and L.enabled]
    out: list[tuple[np.ndarray, np.ndarray]] = []

    for R in reflectors:
        R_normal = np.array(R.normal, dtype=np.float32)
        n_len = float(np.linalg.norm(R_normal))
        if n_len < 1e-9:
            R_normal = np.array([0.0, 0.0, 1.0], dtype=np.float32)
        else:
            R_normal = R_normal / n_len
        R_pos = np.array(R.position, dtype=np.float32)

        if not R.enabled:
            out.append((np.zeros(3, dtype=np.float32), R_normal))
            continue

        accumulated = np.zeros(3, dtype=np.float32)
        total_irr = 0.0
        dominant = np.zeros(3, dtype=np.float32)

        for L in lights:
            if L.type == 'directional':
                ld = np.array(L.direction, dtype=np.float32)
                ld_len = float(np.linalg.norm(ld))
                if ld_len < 1e-9:
                    continue
                L_dir = -ld / ld_len               # toward light source
                dist_atten = 1.0
            else:
                L_pos = np.array(L.position, dtype=np.float32)
                delta = L_pos - R_pos
                dist = float(np.linalg.norm(delta))
                if dist < 1e-9:
                    continue
                L_dir = delta / dist
                dist_atten = 1.0 / (1.0 + L.falloff * dist * dist)

            facing = float(np.dot(R_normal, L_dir))
            if facing <= 0.0:
                continue

            L_color = _effective_light_color(L)
            irradiance = float(L.intensity) * dist_atten * facing
            accumulated += L_color * irradiance
            total_irr += irradiance

            # Reflected ray: reflect the *incoming* direction (-L_dir) across R_normal.
            inc = -L_dir
            refl = inc - 2.0 * float(np.dot(inc, R_normal)) * R_normal
            dominant += refl * irradiance

        R_color = np.array(R.color, dtype=np.float32)
        emission = accumulated * float(R.reflectance) * R_color

        if total_irr > 0.0:
            dom_len = float(np.linalg.norm(dominant))
            dom_unit = dominant / dom_len if dom_len > 1e-9 else R_normal
        else:
            dom_unit = R_normal

        out.append((emission.astype(np.float32), dom_unit.astype(np.float32)))

    return out
