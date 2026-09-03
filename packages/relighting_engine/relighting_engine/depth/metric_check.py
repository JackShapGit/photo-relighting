"""Optional cross-check of a stage calibration against a metric depth model.

The app ships with a *relative* depth model (depth_anything.py, DA3 via the
HuggingFace hub). A second, metric model can sanity-check the calibration's
inverse-depth fit: sample a 3×3 grid over the deck between the lip and the
back line, compare the fitted camera distance at each sample with the metric
model's metres (converted to feet), and report the median percent error.

The metric checkpoint (Depth-Anything-V2 metric, Hypersim, ViT-B) is never
downloaded automatically. ``available()`` is True only when the file exists at
``~/.cache/relighting/depth_anything_v2_metric_hypersim_vitb.pth`` or at the
path in ``RELIGHT_METRIC_CKPT``; every caller must treat ``None`` from
``compare()`` as "no opinion".
"""
from __future__ import annotations

import os
from pathlib import Path
from typing import Any

import numpy as np

from relighting_engine.metric.calibration import Calibration, depth_to_zcam

CKPT_NAME = "depth_anything_v2_metric_hypersim_vitb.pth"
ENV_VAR = "RELIGHT_METRIC_CKPT"
FT_PER_M = 3.280839895          # 1 ft = 0.3048 m
GRID = 3                        # samples per axis over the deck region
HYPERSIM_MAX_DEPTH_M = 20.0     # the Hypersim metric head was trained with this cap


def ckpt_path() -> Path:
    override = os.environ.get(ENV_VAR)
    if override:
        return Path(override)
    return Path.home() / ".cache" / "relighting" / CKPT_NAME


def available() -> bool:
    try:
        return ckpt_path().is_file()
    except OSError:
        return False


def run_metric(image: np.ndarray, ckpt: Path) -> np.ndarray:
    """Metric depth in metres, ``(H, W) float32``, for an ``(H, W, 3)`` float32
    [0, 1] image.

    Loads the Depth-Anything-V2 metric ViT-B checkpoint on each call: the check
    runs once per Apply, so caching the model in VRAM alongside the relative
    model is not worth it. Requires the optional ``depth_anything_v2`` package;
    ``compare()`` only reaches here once ``available()`` is True.
    """
    import torch  # noqa: PLC0415
    from depth_anything_v2.dpt import DepthAnythingV2  # noqa: PLC0415

    model = DepthAnythingV2(encoder="vitb", features=128,
                            out_channels=[96, 192, 384, 768], max_depth=HYPERSIM_MAX_DEPTH_M)
    model.load_state_dict(torch.load(ckpt, map_location="cpu"))
    device = "cuda" if torch.cuda.is_available() else "cpu"
    model = model.to(device).eval()
    bgr = (np.clip(image, 0.0, 1.0) * 255.0).astype(np.uint8)[..., ::-1]
    with torch.inference_mode():
        depth_m = model.infer_image(np.ascontiguousarray(bgr))
    return np.asarray(depth_m, dtype=np.float32)


def compare(prepared: Any, cal: Calibration, marks: dict[str, Any]) -> dict[str, Any] | None:
    """Median percent disagreement between the calibration's depth fit and the
    metric model over the deck, or ``None`` when the model is unavailable or
    the calibration has no depth fit."""
    if not available() or cal.fit is None:
        return None
    z_model_m = run_metric(prepared.original, ckpt_path())
    h, w = prepared.depth.shape
    mh, mw = z_model_m.shape[:2]
    u_l, u_r = float(marks["lipL"][0]), float(marks["lipR"][0])
    v_top = (float(marks["backL"][1]) + float(marks["backR"][1])) / 2.0
    v_bot = (float(marks["lipL"][1]) + float(marks["lipR"][1])) / 2.0
    samples: list[dict[str, float]] = []
    errs: list[float] = []
    for i in range(GRID):
        for j in range(GRID):
            u = u_l + (u_r - u_l) * (i + 0.5) / GRID
            v = v_top + (v_bot - v_top) * (j + 0.5) / GRID
            c, r = int(u * (w - 1)), int(v * (h - 1))
            z_fit = float(depth_to_zcam(prepared.depth[r, c], cal.fit))
            z_mod = float(z_model_m[int(v * (mh - 1)), int(u * (mw - 1))]) * FT_PER_M
            samples.append({"u": u, "v": v, "z_fit": z_fit, "z_model": z_mod})
            errs.append(abs(z_mod - z_fit) / max(z_fit, 1e-6) * 100.0)
    return {"median_error_pct": float(np.median(errs)), "samples": samples}
