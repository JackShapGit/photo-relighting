"""Tests for /healthz capabilities block."""
from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from relighting_api.main import create_app


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setenv("RELIGHT_CACHE_DIR", str(tmp_path / "sessions"))
    monkeypatch.setenv("RELIGHT_SCENES_DB", str(tmp_path / "scenes.db"))
    app = create_app(skip_engine=True)
    app.state.capabilities = {"polish": True, "segmenters": ["rmbg", "sam2"]}
    return TestClient(app)


def test_healthz_includes_capabilities(client):
    r = client.get("/healthz")
    assert r.status_code == 200
    body = r.json()
    assert "capabilities" in body
    assert body["capabilities"]["polish"] is True
    assert "rmbg" in body["capabilities"]["segmenters"]


def test_healthz_capabilities_polish_false_when_disabled(client):
    client.app.state.capabilities["polish"] = False
    r = client.get("/healthz")
    body = r.json()
    assert body["capabilities"]["polish"] is False
