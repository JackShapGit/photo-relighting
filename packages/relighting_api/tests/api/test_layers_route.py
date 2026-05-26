"""Endpoint tests for POST /render/layers."""
from __future__ import annotations

import io
from pathlib import Path

import numpy as np
import pytest
from fastapi.testclient import TestClient
from PIL import Image

pytoshop = pytest.importorskip("pytoshop")

from relighting_api.main import create_app
from .conftest import FakeEngine


@pytest.fixture
def client(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> TestClient:
    monkeypatch.setenv("RELIGHT_CACHE_DIR", str(tmp_path / "sessions"))
    app = create_app(skip_engine=True)
    app.state.engine = FakeEngine()
    return TestClient(app)


def _png_bytes() -> bytes:
    arr = np.full((32, 32, 3), 128, dtype=np.uint8)
    buf = io.BytesIO()
    Image.fromarray(arr).save(buf, format="PNG")
    return buf.getvalue()


def _new_session(client: TestClient) -> str:
    r = client.post("/prepare", files={"image": ("x.png", _png_bytes(), "image/png")})
    return r.json()["session_id"]


def test_render_layers_returns_psd(client: TestClient) -> None:
    sid = _new_session(client)
    r = client.post("/render/layers", json={
        "session_id": sid,
        "lights": [{"type": "directional", "direction": [0, 0, -1], "name": "Key"}],
        "ambient": 0.3,
    })
    assert r.status_code == 200
    assert "application/x-photoshop" in r.headers["content-type"]
    assert "Content-Disposition" in r.headers
    assert ".psd" in r.headers["Content-Disposition"]


def test_render_layers_valid_psd(client: TestClient) -> None:
    sid = _new_session(client)
    r = client.post("/render/layers", json={
        "session_id": sid,
        "lights": [{"type": "directional", "direction": [0, 0, -1], "name": "Key"}],
        "ambient": 0.3,
    })
    psd = pytoshop.read(io.BytesIO(r.content))
    records = psd.layer_and_mask_info.layer_info.layer_records
    assert len(records) >= 2  # Ambient + at least 1 light


def test_render_layers_unknown_session_404(client: TestClient) -> None:
    r = client.post("/render/layers", json={
        "session_id": "nope",
        "lights": [],
        "ambient": 0.2,
    })
    assert r.status_code == 404


def test_render_layers_custom_filename(client: TestClient) -> None:
    sid = _new_session(client)
    r = client.post("/render/layers", json={
        "session_id": sid,
        "lights": [],
        "ambient": 0.2,
        "scene_name": "My Cool Scene",
    })
    assert r.status_code == 200
    assert "My Cool Scene.psd" in r.headers["Content-Disposition"]
