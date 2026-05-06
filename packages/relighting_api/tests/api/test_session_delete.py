"""Endpoint test for DELETE /session/{id}."""
from __future__ import annotations

import io
from pathlib import Path

import numpy as np
import pytest
from fastapi.testclient import TestClient
from PIL import Image

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


def test_delete_session_204_then_render_404(client: TestClient) -> None:
    sid = client.post("/prepare", files={"image": ("x.png", _png_bytes(), "image/png")}).json()["session_id"]
    r = client.delete(f"/session/{sid}")
    assert r.status_code == 204
    r2 = client.post("/render", json={
        "session_id": sid, "lights": [], "ambient": 0.2,
        "output_format": "png", "output_bit_depth": 8,
    })
    assert r2.status_code == 404


def test_delete_unknown_session_204_idempotent(client: TestClient) -> None:
    r = client.delete("/session/no-such-id")
    assert r.status_code == 204
