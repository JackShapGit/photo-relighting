"""Endpoint tests for POST /render."""
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


def _new_session(client: TestClient) -> str:
    r = client.post("/prepare", files={"image": ("x.png", _png_bytes(), "image/png")})
    return r.json()["session_id"]


def test_render_returns_png_bytes(client: TestClient) -> None:
    sid = _new_session(client)
    r = client.post("/render", json={
        "session_id": sid,
        "lights": [{"type": "directional", "direction": [0, 0, -1]}],
        "ambient": 0.3,
        "output_format": "png",
        "output_bit_depth": 8,
    })
    assert r.status_code == 200
    assert r.headers["content-type"].startswith("image/png")
    assert r.content[:8] == b"\x89PNG\r\n\x1a\n"


def test_render_unknown_session_404(client: TestClient) -> None:
    r = client.post("/render", json={
        "session_id": "nope",
        "lights": [],
        "ambient": 0.2,
        "output_format": "png",
        "output_bit_depth": 8,
    })
    assert r.status_code == 404


def test_render_invalid_format_bitdepth_422(client: TestClient) -> None:
    sid = _new_session(client)
    r = client.post("/render", json={
        "session_id": sid,
        "lights": [],
        "ambient": 0.2,
        "output_format": "jpeg",
        "output_bit_depth": 16,
    })
    assert r.status_code == 422


def test_render_invalid_light_422(client: TestClient) -> None:
    sid = _new_session(client)
    r = client.post("/render", json={
        "session_id": sid,
        "lights": [{"type": "laser"}],
        "ambient": 0.2,
        "output_format": "png",
        "output_bit_depth": 8,
    })
    assert r.status_code == 422
