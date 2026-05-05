"""Verify the engine ships its 6 gobo presets and the engine surface lists them."""
from __future__ import annotations

from pathlib import Path

PRESETS = ("window-blinds", "leaves", "grid", "clouds", "rays", "dapple")


def test_all_gobo_presets_present_on_disk() -> None:
    base = (
        Path(__file__).resolve().parents[2]
        / "relighting_engine" / "assets" / "gobos"
    )
    assert base.is_dir()
    for name in PRESETS:
        p = base / f"{name}.png"
        assert p.exists(), f"missing gobo preset: {p}"
        assert p.stat().st_size > 1024  # not an empty/garbage file


def test_engine_loads_all_six_gobo_textures() -> None:
    import torch
    if not torch.cuda.is_available():
        import pytest
        pytest.skip("CUDA required")
    from relighting_engine import RelightingEngine
    e = RelightingEngine(device="cuda")
    g = e._gobos()  # internal API, but stable across MVP
    for name in PRESETS:
        assert f"preset:{name}" in g
