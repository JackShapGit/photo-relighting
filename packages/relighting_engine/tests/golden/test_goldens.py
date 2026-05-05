"""Golden image tests. SSIM > 0.99 vs reference for each fixture × config."""
from __future__ import annotations

from pathlib import Path

import numpy as np
import pytest
import torch

if not torch.cuda.is_available():
    pytest.skip("CUDA required for golden tests", allow_module_level=True)

from skimage.metrics import structural_similarity as ssim

from relighting_engine import RelightingEngine
from relighting_engine.core.io import read_image
from relighting_engine.tests.golden.configs import FIXTURES, configs

ROOT = Path(__file__).resolve().parents[1]
FIX = ROOT / "fixtures" / "images"
EXP = ROOT / "fixtures" / "expected"

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
def test_golden(fixture: str, config: tuple[str, list, float]) -> None:
    name, lights, ambient = config
    src = FIX / fixture
    if not src.exists():
        pytest.skip(f"fixture not present: {fixture}")
    expected = EXP / f"{Path(fixture).stem}__{name}.png"
    if not expected.exists():
        pytest.skip(f"golden not generated yet: {expected.name} (run scripts/make_goldens.py)")

    img, _ = read_image(src)
    p = _eng().prepare(img, mode="interactive")
    out = _eng().render(p, lights=lights, ambient=ambient)
    ref, _ = read_image(expected)

    # Resize ref to match if it differs (interactive caps long-side at 1024)
    if ref.shape != out.shape:
        import cv2
        ref = cv2.resize(ref, (out.shape[1], out.shape[0]), interpolation=cv2.INTER_LINEAR)

    score = ssim(ref, out, channel_axis=-1, data_range=1.0)
    assert score > 0.99, f"{fixture} × {name}: SSIM {score:.4f} < 0.99"
