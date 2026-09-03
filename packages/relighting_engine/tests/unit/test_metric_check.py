"""metric_check.compare() math, with the metric model stubbed out."""
from __future__ import annotations

import numpy as np
import pytest

from relighting_engine.core.prepared import PreparedImage
from relighting_engine.depth import metric_check
from relighting_engine.metric.calibration import Calibration

FT_PER_M = 3.280839895
RECORD = {
    "width_ft": 40, "height_ft": 20, "depth_ft": 30,
    "marks": {"lipL": [0.1, 0.61333], "lipR": [0.9, 0.61333], "top": [0.5, 0.08],
              "backL": [0.23333, 0.54222], "backR": [0.76667, 0.54222]},
    "depth_fit": {"a": -0.037037, "b": 0.024074},
}
D = 0.2                                              # 1/Z = a·d + b → Z ≈ 60 ft
Z_FIT = 1.0 / (RECORD["depth_fit"]["a"] * D + RECORD["depth_fit"]["b"])


def _prepared(h: int = 24, w: int = 32) -> PreparedImage:
    return PreparedImage(
        original=np.zeros((h, w, 3), np.float32),
        depth=np.full((h, w), D, np.float32),
        normals=np.tile(np.array([0, 0, 1], np.float32), (h, w, 1)),
        mask=None, width=w, height=h,
    )


def test_compare_is_none_when_unavailable(monkeypatch):
    monkeypatch.setattr(metric_check, "available", lambda: False)
    cal = Calibration.from_dict(RECORD, 0.75)
    assert metric_check.compare(_prepared(), cal, RECORD["marks"]) is None


def test_compare_is_none_without_a_depth_fit(monkeypatch):
    monkeypatch.setattr(metric_check, "available", lambda: True)
    monkeypatch.setattr(metric_check, "run_metric", lambda *a, **k: pytest.fail("must not run"))
    cal = Calibration.from_dict({**RECORD, "depth_fit": None}, 0.75)
    assert metric_check.compare(_prepared(), cal, RECORD["marks"]) is None


def test_compare_zero_error_when_model_agrees_with_fit(monkeypatch):
    monkeypatch.setattr(metric_check, "available", lambda: True)
    monkeypatch.setattr(metric_check, "run_metric",
                        lambda image, ckpt: np.full(image.shape[:2], Z_FIT / FT_PER_M, np.float32))
    cal = Calibration.from_dict(RECORD, 0.75)
    res = metric_check.compare(_prepared(), cal, RECORD["marks"])
    assert res["median_error_pct"] == pytest.approx(0.0, abs=1e-3)
    assert len(res["samples"]) == 9
    for s in res["samples"]:
        assert 0.1 < s["u"] < 0.9 and 0.54 < s["v"] < 0.62
        assert s["z_fit"] == pytest.approx(Z_FIT, rel=1e-6)
        assert s["z_model"] == pytest.approx(Z_FIT, rel=1e-5)


def test_compare_reports_percent_disagreement(monkeypatch):
    monkeypatch.setattr(metric_check, "available", lambda: True)
    monkeypatch.setattr(metric_check, "run_metric",
                        lambda image, ckpt: np.full(image.shape[:2], 1.5 * Z_FIT / FT_PER_M, np.float32))
    cal = Calibration.from_dict(RECORD, 0.75)
    res = metric_check.compare(_prepared(), cal, RECORD["marks"])
    assert res["median_error_pct"] == pytest.approx(50.0, abs=1e-3)


def test_available_is_false_here_and_honours_env_override(monkeypatch, tmp_path):
    monkeypatch.delenv("RELIGHT_METRIC_CKPT", raising=False)
    assert metric_check.available() is False          # no checkpoint on this machine
    ckpt = tmp_path / "depth_anything_v2_metric_hypersim_vitb.pth"
    ckpt.write_bytes(b"x")
    monkeypatch.setenv("RELIGHT_METRIC_CKPT", str(ckpt))
    assert metric_check.available() is True
