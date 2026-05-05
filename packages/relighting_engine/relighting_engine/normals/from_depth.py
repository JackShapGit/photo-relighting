"""Surface normals from a depth map via finite differences.

Convention: image coordinates are (y down, x right). World z increases AWAY
from the camera (matches PreparedImage.depth normalization). To make lighting
math feel natural we return normals with +z toward the camera; flip the
gradient sign accordingly.

The strength factor controls how exaggerated surface tilt looks; depth from
DA3 is in arbitrary units, so we scale gradients before normalizing.
"""
from __future__ import annotations

import numpy as np
from scipy.ndimage import gaussian_filter


def normals_from_depth(
    depth: np.ndarray,
    *,
    sigma: float = 1.5,
    strength: float = 8.0,
) -> np.ndarray:
    """Compute (H, W, 3) unit-length surface normals from a depth map.

    sigma     — Gaussian smoothing applied before differencing (in pixels).
    strength  — multiplier on dz/dx, dz/dy gradients before normalization.
                Higher = more pronounced surface tilt response to depth changes.
    """
    if depth.ndim != 2 or depth.dtype != np.float32:
        raise ValueError("expected (H, W) float32 depth")

    d = depth if sigma == 0 else gaussian_filter(depth, sigma=sigma).astype(np.float32)

    # np.gradient returns (dz/dy, dz/dx). +z points TOWARD camera, depth grows AWAY,
    # so the normal of a surface where depth increases in +x has -x component:
    #   n = normalize((-dz/dx, -dz/dy, 1)) * strength scaling
    dy, dx = np.gradient(d)
    nx = -dx * strength
    ny = -dy * strength
    nz = np.ones_like(d)

    n = np.stack([nx, ny, nz], axis=-1)
    norm = np.linalg.norm(n, axis=-1, keepdims=True) + 1e-8
    return (n / norm).astype(np.float32)
