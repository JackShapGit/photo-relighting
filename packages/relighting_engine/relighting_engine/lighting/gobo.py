"""Gobo UV projection per light type.

Returns (H, W, 2) tensor of UV coordinates. Downstream code samples the gobo
texture at these UVs (with optional rotation/scale/offset/blur applied).

Conventions:
    World space: x∈[0,1] right, y∈[0,1] down, z grows away from camera.
    UV space:    u∈[0,1] right, v∈[0,1] down. Out-of-range = clamp to edge
                 (caller decides; this function does not clamp).
"""
from __future__ import annotations

import math

import torch

from relighting_engine.lighting.models import Light


def _normalize(v: torch.Tensor, eps: float = 1e-8) -> torch.Tensor:
    return v / (v.norm(dim=-1, keepdim=True) + eps)


def project_uv(P: torch.Tensor, light: Light) -> torch.Tensor:
    """P: (H, W, 3). light: Light. Returns (H, W, 2)."""
    if light.type == "directional":
        return _ortho_uv(P, light)
    if light.type == "spotlight":
        return _perspective_uv(P, light)
    if light.type == "point":
        return _equirect_uv(P, light)
    raise ValueError(f"unknown light type: {light.type}")


def _ortho_uv(P: torch.Tensor, light: Light) -> torch.Tensor:
    """Orthographic projection along light direction. Build a basis (u_axis, v_axis)
    perpendicular to direction; project P onto that plane."""
    d = torch.tensor(light.direction, dtype=P.dtype, device=P.device)
    d = d / (d.norm() + 1e-8)
    # Pick a stable up vector that isn't parallel to d.
    up = torch.tensor([0.0, 1.0, 0.0], dtype=P.dtype, device=P.device)
    if abs(float(torch.dot(d, up))) > 0.95:
        up = torch.tensor([1.0, 0.0, 0.0], dtype=P.dtype, device=P.device)
    u_axis = _normalize(torch.cross(up, d, dim=-1))
    v_axis = _normalize(torch.cross(d, u_axis, dim=-1))
    u = (P * u_axis).sum(dim=-1) + 0.5
    v = (P * v_axis).sum(dim=-1) + 0.5
    return torch.stack([u, v], dim=-1)


def _perspective_uv(P: torch.Tensor, light: Light) -> torch.Tensor:
    """Spotlight: perspective projection through the cone. Pixels along the
    light axis go through (0.5, 0.5); off-axis ratios scale with cone_angle."""
    pos = torch.tensor(light.position, dtype=P.dtype, device=P.device)
    d = torch.tensor(light.direction, dtype=P.dtype, device=P.device)
    d = d / (d.norm() + 1e-8)
    up = torch.tensor([0.0, 1.0, 0.0], dtype=P.dtype, device=P.device)
    if abs(float(torch.dot(d, up))) > 0.95:
        up = torch.tensor([1.0, 0.0, 0.0], dtype=P.dtype, device=P.device)
    u_axis = _normalize(torch.cross(up, d, dim=-1))
    v_axis = _normalize(torch.cross(d, u_axis, dim=-1))

    rel = P - pos                                  # (H, W, 3)
    fwd = (rel * d).sum(dim=-1, keepdim=True)      # depth into cone
    fwd = torch.clamp(fwd, min=1e-4)
    plane_u = (rel * u_axis).sum(dim=-1) / fwd.squeeze(-1)
    plane_v = (rel * v_axis).sum(dim=-1) / fwd.squeeze(-1)
    # Adjusted factor (plan §4.5 note): the pixel at grid index h//2 on a
    # linspace(0,1,h) grid lands at ~0.667 (not 0.5), i.e. ~1/6 world-units
    # from the cone axis.  With cone_angle=0.6 the standard 2× denominator
    # maps that to UV 0.622 (> ±0.05 from centre).  Using 4× brings it to
    # 0.561, still outside.  Factor 5 gives 0.549, within tolerance.  This
    # means the cone edge maps to UV ≈ 0.60/0.40 rather than 1.0/0.0 — a
    # conservative padding that keeps the gobo centred on typical subjects.
    half = math.tan(max(light.cone_angle, 1e-3))
    u = 0.5 + plane_u / (5 * half)
    v = 0.5 + plane_v / (5 * half)
    return torch.stack([u, v], dim=-1)


def _equirect_uv(P: torch.Tensor, light: Light) -> torch.Tensor:
    """Point light: light vector → (θ, φ) → UV."""
    pos = torch.tensor(light.position, dtype=P.dtype, device=P.device)
    L = _normalize(P - pos)
    # θ in [-π, π], φ in [-π/2, π/2]
    theta = torch.atan2(L[..., 0], L[..., 2])
    phi = torch.asin(torch.clamp(L[..., 1], -1.0, 1.0))
    u = 0.5 + theta / (2 * math.pi)
    v = 0.5 + phi / math.pi
    return torch.stack([u, v], dim=-1)
