"""Mirror of web/src/metric/calibration.js. Keep the formulas identical.

Image coords u in [0,1] left→right, v in [0,1] top→bottom; va = v * aspect.
World frame (feet): origin center of lip on the deck, +X audience right,
+Y up, +Z upstage.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any

import numpy as np

Z_CAM_MIN = 0.5
Z_CAM_MAX = 10000.0


@dataclass(frozen=True)
class CameraModel:
    f: float
    dist_ft: float
    height_ft: float
    u_c: float
    va_h: float
    k_y: float
    aspect: float


@dataclass(frozen=True)
class DepthFit:
    a: float
    b: float


@dataclass(frozen=True)
class LinearFit:
    """No-fit fallback (spec §Error handling): zCam = dist_ft + d·depth_ft.
    Mirrors ``effectiveFit`` in web/src/metric/calibration.js and the
    shader's ``u_fit.z = 0`` rule."""
    dist_ft: float
    depth_ft: float


@dataclass(frozen=True)
class Calibration:
    width_ft: float
    height_ft: float
    depth_ft: float
    camera: CameraModel
    fit: DepthFit | None

    @classmethod
    def from_dict(cls, d: dict[str, Any], aspect: float) -> "Calibration":
        fit = d.get("depth_fit")
        return cls(
            width_ft=float(d["width_ft"]), height_ft=float(d["height_ft"]),
            depth_ft=float(d["depth_ft"]),
            camera=solve_camera(d, aspect),
            fit=DepthFit(a=float(fit["a"]), b=float(fit["b"])) if fit else None,
        )


def solve_camera(record: dict[str, Any], aspect: float) -> CameraModel:
    m = record["marks"]
    w_lip = abs(m["lipR"][0] - m["lipL"][0])
    w_back = abs(m["backR"][0] - m["backL"][0])
    r = w_back / w_lip
    dist = record["depth_ft"] * r / (1.0 - r)
    f = w_lip * dist / record["width_ft"]
    va_lip = (m["lipL"][1] + m["lipR"][1]) / 2.0 * aspect
    va_back = (m["backL"][1] + m["backR"][1]) / 2.0 * aspect
    va_top = m["top"][1] * aspect
    h = (va_lip - va_back) / (f * (1.0 / dist - 1.0 / (dist + record["depth_ft"])))
    va_h = va_lip - f * h / dist
    k_y = (f * record["height_ft"] / dist) / (va_lip - va_top)
    return CameraModel(f=f, dist_ft=dist, height_ft=h, u_c=(m["lipL"][0] + m["lipR"][0]) / 2.0,
                       va_h=va_h, k_y=k_y, aspect=aspect)


def effective_fit(cal: "Calibration") -> DepthFit | LinearFit:
    """The depth mapping a calibration actually uses: its fitted inverse-depth
    line, or the linear fallback when fitDepth found none."""
    if cal.fit is not None:
        return cal.fit
    return LinearFit(dist_ft=cal.camera.dist_ft, depth_ft=cal.depth_ft)


def depth_to_zcam(d, fit: DepthFit | LinearFit):
    d = np.asarray(d, dtype=np.float64)
    if isinstance(fit, LinearFit):
        z = fit.dist_ft + d * fit.depth_ft
    else:
        z = 1.0 / np.maximum(fit.a * d + fit.b, 1.0 / Z_CAM_MAX)
    return np.clip(z, Z_CAM_MIN, Z_CAM_MAX)


def zcam_to_depth(zcam, fit: DepthFit | LinearFit):
    zcam = np.asarray(zcam, dtype=np.float64)
    if isinstance(fit, LinearFit):
        return (zcam - fit.dist_ft) / fit.depth_ft
    return (1.0 / zcam - fit.b) / fit.a


def pixel_to_world(u, v, zcam, cam: CameraModel):
    u = np.asarray(u, dtype=np.float64); v = np.asarray(v, dtype=np.float64)
    zcam = np.asarray(zcam, dtype=np.float64)
    X = (u - cam.u_c) * zcam / cam.f
    Y = cam.k_y * (cam.height_ft - (v * cam.aspect - cam.va_h) * zcam / cam.f)
    Z = zcam - cam.dist_ft
    return X, Y, Z


def world_to_pixel(xyz, cam: CameraModel):
    X, Y, Z = (float(c) for c in xyz)
    zcam = Z + cam.dist_ft
    if not zcam >= Z_CAM_MIN:
        return None
    u = cam.u_c + X * cam.f / zcam
    va = cam.va_h + (cam.height_ft - Y / cam.k_y) * cam.f / zcam
    return (u, va / cam.aspect, zcam)


def world_to_engine(xyz, cam: CameraModel, fit: DepthFit | LinearFit):
    p = world_to_pixel(xyz, cam)
    if p is None:
        return None
    u, v, zcam = p
    return (u, v, 1.0 - float(zcam_to_depth(zcam, fit)))


def engine_to_world(xyz, cam: CameraModel, fit: DepthFit | LinearFit):
    x, y, z = (float(c) for c in xyz)
    zcam = float(depth_to_zcam(1.0 - z, fit))
    X, Y, Z = pixel_to_world(x, y, zcam, cam)
    return (float(X), float(Y), float(Z))


def engine_dir_to_world(v):
    x, y, z = (float(c) for c in v)
    return (x, -y, -z)


def falloff_to_metric(falloff: float, width_ft: float) -> float:
    return falloff / (width_ft * width_ft)
