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

        color = torch.tensor(resolve_color(L), device=device, dtype=torch.float32)
        contrib = (
            original
            * color.view(1, 1, 3)
            * L.intensity
            * (diff * atten * cone * g * mask_w).unsqueeze(-1)
        )
        total = total + contrib

    out = torch.clamp(total, 0.0, 1.0)
    return out.cpu().numpy().astype(np.float32)
