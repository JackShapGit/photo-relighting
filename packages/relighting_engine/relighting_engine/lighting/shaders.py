"""PyTorch implementation of the canonical lighting shader.

Per-pixel formula (vectorized; one PyTorch tensor expression, not a Python loop):

    total = ambient * original
    for each enabled light L:
        L_vec, atten = light_vector_and_attenuation(L, P)
        cone   = spotlight_cone_factor(L, L_vec)         # 1 for non-spotlights
        gobo   = sample_gobo(L, P)                       # 1 for no gobo
        diff   = max(dot(N, L_vec), 0)
        mask_w = mask_weight(L.affects, mask)
        total += original * L.color * L.intensity * diff * atten * cone * gobo * mask_w

The GLSL fragment shader in web/src/webgl/shaders/relight.frag mirrors this exactly.
"""
from __future__ import annotations

import math
from typing import Sequence

import numpy as np
import torch
import torch.nn.functional as F

from relighting_engine.core.prepared import PreparedImage
from relighting_engine.lighting.gels import resolve_color
from relighting_engine.lighting.gobo import project_uv
from relighting_engine.lighting.models import Light


def _make_world_pos(h: int, w: int, depth: torch.Tensor) -> torch.Tensor:
    """Build (H, W, 3) world position from normalized image coords + depth."""
    ys = torch.linspace(0.0, 1.0, h, device=depth.device, dtype=depth.dtype)
    xs = torch.linspace(0.0, 1.0, w, device=depth.device, dtype=depth.dtype)
    Y, X = torch.meshgrid(ys, xs, indexing="ij")
    return torch.stack([X, Y, depth], dim=-1)


def _planar_shadow(
    P: torch.Tensor, depth: torch.Tensor, mask: torch.Tensor,
    L: Light, subject_depth: float,
    *, blur_frac: float = 0.015, strength: float = 0.85,
) -> torch.Tensor:
    """Approach 2: project the subject mask along the light direction onto a
    virtual plane at ``subject_depth``, blur, and use as a darkening factor.

    Returns a (H, W) shadow factor in [0, 1] where 1 = full light.
    Mirrors `web/src/webgl/shaders/relight.frag::planar_shadow`.

    For each pixel the algorithm asks: "if I trace from here toward the light,
    where do I cross the subject's plane?". Sampling the mask at that uv tells
    us whether the subject occludes our pixel.
    """
    h, w = depth.shape
    device = depth.device
    if mask is None:
        return torch.ones((h, w), device=device, dtype=torch.float32)

    # Per-pixel ray direction (surface → light).
    if L.type == "directional":
        d_vec = torch.tensor(L.direction, device=device, dtype=torch.float32)
        d_vec = d_vec / (d_vec.norm() + 1e-8)
        Rx = torch.full((h, w), float(-d_vec[0]), device=device)
        Ry = torch.full((h, w), float(-d_vec[1]), device=device)
        Rz = torch.full((h, w), float(-d_vec[2]), device=device)
    else:  # point / spotlight
        pos = torch.tensor(L.position, device=device, dtype=torch.float32)
        diff = pos - P
        dist = diff.norm(dim=-1, keepdim=True) + 1e-6
        unit = diff / dist
        Rx, Ry, Rz = unit[..., 0], unit[..., 1], unit[..., 2]

    # If the light is too sideways (Rz ≈ 0) the planar projection diverges.
    # Clamp |Rz| to a floor; the subject's shadow is nearly stretched-to-infinity
    # in that case anyway, so this just prevents NaN.
    rz_floor = 0.05
    sign = torch.where(Rz >= 0.0, torch.ones_like(Rz), -torch.ones_like(Rz))
    Rz_safe = torch.where(Rz.abs() < rz_floor, sign * rz_floor, Rz)

    # Time to reach the subject's plane.
    t = (subject_depth - depth) / Rz_safe

    # Build a (H, W, 2) sampling grid in [0, 1] image space.
    ys = torch.linspace(0.0, 1.0, h, device=device, dtype=torch.float32)
    xs = torch.linspace(0.0, 1.0, w, device=device, dtype=torch.float32)
    Y, X = torch.meshgrid(ys, xs, indexing="ij")
    sample_u = X + t * Rx
    sample_v = Y + t * Ry

    grid = torch.stack([sample_u, sample_v], dim=-1) * 2.0 - 1.0
    grid = grid.unsqueeze(0)
    sampled = F.grid_sample(
        mask.unsqueeze(0).unsqueeze(0), grid,
        mode="bilinear", padding_mode="zeros", align_corners=True,
    )[0, 0]

    # The subject doesn't shadow itself, and pixels in front of the subject
    # plane (t <= 0 with the light approaching) have no occluder along the way.
    valid = (t > 0.0) & (mask < 0.5)
    sampled = torch.where(valid, sampled, torch.zeros_like(sampled))

    # Soft penumbra: a quick separable-ish box blur. Kernel size scales with
    # image dimension so it looks the same at any resolution.
    k = max(1, int(blur_frac * min(h, w))) | 1
    if k > 1:
        kern = torch.ones(1, 1, k, k, device=device, dtype=torch.float32) / (k * k)
        sampled = F.conv2d(
            sampled.unsqueeze(0).unsqueeze(0), kern, padding=k // 2,
        )[0, 0]

    return (1.0 - sampled * strength).clamp(0.0, 1.0)


def _shadow_factor(
    P: torch.Tensor, depth: torch.Tensor, L_vec: torch.Tensor,
    *, steps: int = 16, max_dist: float = 0.6, bias: float = 0.003,
) -> torch.Tensor:
    """Heightfield ray-march from each pixel toward the light.

    Returns a (H, W) float tensor: 1.0 where the light reaches, 0.0 where the
    depth heightfield occludes it. ``L_vec`` is the unit vector from surface
    toward the light, shape (H, W, 3) (per-pixel for point/spotlight, or a
    broadcast constant for directional).

    Algorithm: at each step k, sample position is P + L_vec * (k/steps) * max_dist.
    Sample the depth heightfield at the step's (u, v). If the visible surface
    there is closer to camera than the ray's current z (with a small bias to
    avoid self-shadowing on slanted surfaces), the ray is blocked.

    Mirror this exactly in `web/src/webgl/shaders/relight.frag::shadow_factor`.
    """
    h, w = depth.shape
    device = depth.device
    shadow = torch.ones((h, w), device=device, dtype=torch.float32)
    depth_tex = depth.unsqueeze(0).unsqueeze(0)   # (1, 1, H, W) for grid_sample
    for k in range(1, steps + 1):
        t = (k / steps) * max_dist
        sample_pos = P + L_vec * t                # (H, W, 3)
        sample_uv = sample_pos[..., :2]
        in_bounds = ((sample_uv >= 0.0) & (sample_uv <= 1.0)).all(dim=-1)
        grid = (sample_uv * 2.0 - 1.0).unsqueeze(0)
        surface_z = F.grid_sample(
            depth_tex, grid, mode="bilinear", padding_mode="border", align_corners=True,
        )[0, 0]
        sample_z = sample_pos[..., 2]
        occluded = (surface_z + bias < sample_z) & in_bounds
        # Hard shadow: zero out occluded pixels. Once shadow is 0 it stays 0.
        shadow = torch.where(occluded, torch.zeros_like(shadow), shadow)
    return shadow


def _sample_gobo_texture(uv: torch.Tensor, tex: torch.Tensor, blur: float = 0.0) -> torch.Tensor:
    """uv: (H, W, 2) in [0, 1]. tex: (Th, Tw) float32 grayscale. Returns (H, W)."""
    h, w, _ = uv.shape
    grid = uv * 2.0 - 1.0  # grid_sample expects [-1, 1]
    grid = grid.unsqueeze(0)  # (1, H, W, 2)
    t = tex.unsqueeze(0).unsqueeze(0)  # (1, 1, Th, Tw)
    g = F.grid_sample(t, grid, mode="bilinear", padding_mode="border", align_corners=True)
    g = g[0, 0]
    if blur > 0:
        # Quick separable blur via conv. Kernel size proportional to blur.
        k = max(1, int(blur * min(h, w))) | 1  # odd
        if k > 1:
            kernel = torch.ones(1, 1, k, k, device=g.device, dtype=g.dtype) / (k * k)
            g = F.conv2d(g.unsqueeze(0).unsqueeze(0), kernel, padding=k // 2).squeeze()
    return g


def render(
    prepared: PreparedImage,
    lights: Sequence[Light],
    ambient: float = 0.2,
    *,
    device: str = "cuda",
    gobo_textures: dict[str, torch.Tensor] | None = None,
    shadow_style: str = "off",          # 'off' | 'heightfield' | 'planar'
) -> np.ndarray:
    """Render the prepared image under the given lights. Returns (H, W, 3) float32 in [0, 1]."""
    h, w = prepared.height, prepared.width
    original = torch.from_numpy(prepared.original).to(device)
    depth = torch.from_numpy(prepared.depth).to(device)
    normals = torch.from_numpy(prepared.normals).to(device)
    if prepared.mask is not None:
        mask = torch.from_numpy(prepared.mask).to(device)
    else:
        mask = torch.ones((h, w), device=device, dtype=torch.float32)

    P = _make_world_pos(h, w, depth)
    total = ambient * original

    # Confidence-aware lighting: low-confidence pixels (edges, hair, depth
    # discontinuities where DA3 is unsure) fall back to ambient. The mask is
    # broadcast over the per-light contribution sum below, not over `ambient *
    # original`, so unreliable regions still get ambient illumination.
    if prepared.confidence is not None:
        conf = torch.from_numpy(prepared.confidence).to(device).unsqueeze(-1)
    else:
        conf = None

    gobo_textures = gobo_textures or {}

    for L in lights:
        if not L.enabled:
            continue
        L.validate()

        if L.type == "directional":
            d = torch.tensor(L.direction, device=device, dtype=torch.float32)
            d = d / (d.norm() + 1e-8)
            L_vec = -d.expand_as(P)
            atten = torch.ones((h, w), device=device, dtype=torch.float32)
        else:
            pos = torch.tensor(L.position, device=device, dtype=torch.float32)
            diff_vec = pos - P
            dist = diff_vec.norm(dim=-1, keepdim=True) + 1e-6
            L_vec = diff_vec / dist
            atten = 1.0 / (1.0 + L.falloff * (dist.squeeze(-1) ** 2))

        if L.type == "spotlight":
            d = torch.tensor(L.direction, device=device, dtype=torch.float32)
            d = d / (d.norm() + 1e-8)
            cone_dot = (d * (-L_vec)).sum(dim=-1)
            inner = math.cos(max(L.cone_angle - L.softness * 0.5, 1e-4))
            outer = math.cos(L.cone_angle + L.softness * 0.5)
            cone = torch.clamp((cone_dot - outer) / (inner - outer + 1e-6), 0.0, 1.0)
        else:
            cone = torch.ones((h, w), device=device, dtype=torch.float32)

        if L.gobo is not None and L.gobo.texture_id in gobo_textures:
            uv = project_uv(P, L)
            # rotation, scale, offset around (0.5, 0.5)
            cx, cy = 0.5, 0.5
            uv_centered = uv - torch.tensor([cx, cy], device=device)
            cs = math.cos(L.gobo.rotation)
            sn = math.sin(L.gobo.rotation)
            rot = torch.tensor([[cs, -sn], [sn, cs]], device=device, dtype=uv.dtype)
            uv_rot = uv_centered @ rot.T
            uv_xform = uv_rot * L.gobo.scale + torch.tensor(
                [cx + L.gobo.offset[0], cy + L.gobo.offset[1]], device=device, dtype=uv.dtype
            )
            g = _sample_gobo_texture(uv_xform, gobo_textures[L.gobo.texture_id], blur=L.gobo.blur)
            if L.gobo.invert:
                g = 1.0 - g
        else:
            g = torch.ones((h, w), device=device, dtype=torch.float32)

        diff = torch.clamp((normals * L_vec).sum(dim=-1), min=0.0)

        if L.affects == "all":
            mask_w = torch.ones((h, w), device=device, dtype=torch.float32)
        elif L.affects == "subject":
            mask_w = mask
        else:  # "background"
            mask_w = 1.0 - mask

        if shadow_style == "heightfield":
            shadow = _shadow_factor(P, depth, L_vec)
        elif shadow_style == "planar":
            subject_depth = float(prepared.metadata.get("subject_median_depth", 0.3))
            shadow = _planar_shadow(P, depth, mask if prepared.mask is not None else None, L, subject_depth)
        else:
            shadow = torch.ones((h, w), device=device, dtype=torch.float32)

        color = torch.tensor(resolve_color(L), device=device, dtype=torch.float32)
        contrib = (
            original
            * color.view(1, 1, 3)
            * L.intensity
            * (diff * atten * cone * g * mask_w * shadow).unsqueeze(-1)
        )
        if conf is not None:
            contrib = contrib * conf
        total = total + contrib

    out = torch.clamp(total, 0.0, 1.0)
    return out.cpu().numpy().astype(np.float32)
