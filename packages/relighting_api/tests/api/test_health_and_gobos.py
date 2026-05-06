"""Endpoint tests for /healthz and /gobos. Use TestClient — no real network."""
from __future__ import annotations

from fastapi.testclient import TestClient

from relighting_api.main import create_app


def _client() -> TestClient:
    app = create_app(skip_engine=True)  # tests must not load CUDA models
    return TestClient(app)


def test_healthz_ok_shape() -> None:
    r = _client().get("/healthz")
    assert r.status_code == 200
    body = r.json()
    assert body["ok"] is True
    assert "gpu" in body and isinstance(body["gpu"], bool)


def test_gobos_lists_six_presets() -> None:
    r = _client().get("/gobos")
    assert r.status_code == 200
    body = r.json()
    presets = body["presets"]
    assert len(presets) == 6
    names = {p["gobo_id"] for p in presets}
    assert names == {
        "preset:window-blinds", "preset:leaves", "preset:grid",
        "preset:clouds", "preset:rays", "preset:dapple",
    }
    for p in presets:
        assert p["projection"] in ("spotlight", "equirect")
