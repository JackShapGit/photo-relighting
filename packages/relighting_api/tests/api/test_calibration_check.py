"""POST /scenes/{id}/calibration/check — optional metric-depth cross-check.

The metric checkpoint is not shipped, so the contract to prove is the silent
path (available() false → {available: false, median_error_pct: null}) plus
the plumbing when the model is stubbed as available.
"""
from __future__ import annotations

import io
from pathlib import Path

import numpy as np
import pytest
from fastapi.testclient import TestClient
from PIL import Image

from relighting_api.main import create_app

from .conftest import FakeEngine

MARKS = {"lipL": [0.1, 0.61], "lipR": [0.9, 0.61], "top": [0.5, 0.08],
         "backL": [0.23, 0.54], "backR": [0.77, 0.54]}
CAL = {"width_ft": 40, "height_ft": 20, "depth_ft": 30, "marks": MARKS,
       "depth_fit": {"a": -0.037037, "b": 0.024074}}


@pytest.fixture
def client(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> TestClient:
    monkeypatch.setenv("RELIGHT_CACHE_DIR", str(tmp_path / "sessions"))
    monkeypatch.setenv("RELIGHT_SCENES_DB", str(tmp_path / "scenes.db"))
    app = create_app(skip_engine=True)
    app.state.engine = FakeEngine()
    return TestClient(app)


def _scene(client: TestClient) -> str:
    arr = (np.random.default_rng(0).random((16, 16, 3)) * 255).astype(np.uint8)
    buf = io.BytesIO()
    Image.fromarray(arr).save(buf, format="PNG")
    r = client.post("/prepare", files={"image": ("x.png", buf.getvalue(), "image/png")})
    assert r.status_code == 200, r.text
    r = client.post("/scenes", json={"name": "s", "session_id": r.json()["session_id"], "state": {}})
    assert r.status_code == 200, r.text
    return r.json()["id"]


def test_check_reports_unavailable_when_model_missing(monkeypatch, client):
    from relighting_engine.depth import metric_check
    monkeypatch.setattr(metric_check, "available", lambda: False)
    r = client.post("/scenes/does-not-matter/calibration/check",
                    json={"calibration": {"width_ft": 40, "height_ft": 20, "depth_ft": 30, "marks": MARKS}})
    assert r.status_code == 200
    assert r.json() == {"available": False, "median_error_pct": None}


def test_check_is_unavailable_by_default_on_this_machine(client, monkeypatch):
    """No checkpoint is installed here; the un-patched route must stay silent."""
    monkeypatch.delenv("RELIGHT_METRIC_CKPT", raising=False)
    r = client.post("/scenes/does-not-matter/calibration/check", json={"calibration": CAL})
    assert r.status_code == 200
    assert r.json() == {"available": False, "median_error_pct": None}


def test_check_runs_compare_against_the_scene_session(monkeypatch, client):
    from relighting_engine.depth import metric_check
    seen = {}

    def fake_compare(prepared, cal, marks):
        seen["shape"] = prepared.depth.shape
        seen["dist"] = cal.camera.dist_ft
        seen["marks"] = marks
        return {"median_error_pct": 12.5, "samples": []}

    monkeypatch.setattr(metric_check, "available", lambda: True)
    monkeypatch.setattr(metric_check, "compare", fake_compare)
    sid = _scene(client)
    r = client.post(f"/scenes/{sid}/calibration/check", json={"calibration": CAL})
    assert r.status_code == 200, r.text
    assert r.json() == {"available": True, "median_error_pct": 12.5}
    assert seen["shape"] == (16, 16)
    assert seen["dist"] == pytest.approx(30 * (0.54 / 0.8) / (1 - 0.54 / 0.8))
    assert seen["marks"] == MARKS


def test_check_404s_for_unknown_scene_when_model_available(monkeypatch, client):
    from relighting_engine.depth import metric_check
    monkeypatch.setattr(metric_check, "available", lambda: True)
    r = client.post("/scenes/nope/calibration/check", json={"calibration": CAL})
    assert r.status_code == 404
