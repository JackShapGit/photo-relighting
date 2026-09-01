"""Golden image tests. SSIM > 0.99 vs reference for each fixture × config.

Set RELIGHT_WRITE_GOLDENS=1 to write a missing golden instead of skipping
(existing goldens are never overwritten here; use scripts/make_goldens.py).
"""
from __future__ import annotations

import os
from pathlib import Path

import numpy as np
import pytest
import torch

if not torch.cuda.is_available():
    pytest.skip("CUDA required for golden tests", allow_module_level=True)

from skimage.metrics import structural_similarity as ssim

from relighting_engine import RelightingEngine
from relighting_engine.core.io import read_image, write_image
from relighting_engine.metric.calibration import Calibration
from relighting_engine.tests.golden.configs import FIXTURES, configs

ROOT = Path(__file__).resolve().parents[1]
FIX = ROOT / "fixtures" / "images"
EXP = ROOT / "fixtures" / "expected"
WRITE_GOLDENS = os.environ.get("RELIGHT_WRITE_GOLDENS") == "1"

_engine: RelightingEngine | None = None


def _eng() -> RelightingEngine:
    global _engine
    if _engine is None:
        _engine = RelightingEngine(device="cuda")
    return _engine


@pytest.mark.gpu
@pytest.mark.models
@pytest.mark.parametrize("fixture", FIXTURES)
@pytest.mark.parametrize("config", configs(), ids=lambda c: c[0])
def test_golden(fixture: str, config: tuple[str, list, float, dict | None]) -> None:
    name, lights, ambient, cal_dict = config
    src = FIX / fixture
    if not src.exists():
        pytest.skip(f"fixture not present: {fixture}")
    expected = EXP / f"{Path(fixture).stem}__{name}.png"
    if not expected.exists() and not WRITE_GOLDENS:
        pytest.skip(f"golden not generated yet: {expected.name} (run scripts/make_goldens.py)")

    img, _ = read_image(src)
    p = _eng().prepare(img, mode="interactive")
    calibration = Calibration.from_dict(cal_dict, p.height / p.width) if cal_dict else None
    out = _eng().render(p, lights=lights, ambient=ambient, calibration=calibration)
    if not expected.exists():
        write_image(expected, out, format="png", bit_depth=8)
    ref, _ = read_image(expected)

    # Resize ref to match if it differs (interactive caps long-side at 1024)
    if ref.shape != out.shape:
        import cv2
        ref = cv2.resize(ref, (out.shape[1], out.shape[0]), interpolation=cv2.INTER_LINEAR)

    score = ssim(ref, out, channel_axis=-1, data_range=1.0)
    assert score > 0.99, f"{fixture} × {name}: SSIM {score:.4f} < 0.99"
