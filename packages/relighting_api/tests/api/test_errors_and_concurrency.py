"""Error path + concurrent-render safety tests."""
from __future__ import annotations

import asyncio
import io
from pathlib import Path

import numpy as np
import pytest
from fastapi.testclient import TestClient
from PIL import Image

from relighting_api.main import create_app

from .conftest import FakeEngine


def _png_bytes() -> bytes:
    arr = np.full((16, 16, 3), 128, dtype=np.uint8)
    buf = io.BytesIO()
    Image.fromarray(arr).save(buf, format="PNG")
    return buf.getvalue()


@pytest.fixture
def client(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> TestClient:
    monkeypatch.setenv("RELIGHT_CACHE_DIR", str(tmp_path / "sessions"))
    app = create_app(skip_engine=True)
    app.state.engine = FakeEngine()
    return TestClient(app)


def test_render_oom_returns_503(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    sid = client.post("/prepare", files={"image": ("x.png", _png_bytes(), "image/png")}).json()["session_id"]
    import torch

    def _boom(*a, **kw):  # noqa: ANN001
        raise torch.cuda.OutOfMemoryError("synthetic")

    monkeypatch.setattr(client.app.state.engine, "render", _boom)
    r = client.post("/render", json={
        "session_id": sid, "lights": [], "ambient": 0.2,
        "output_format": "png", "output_bit_depth": 8,
    })
    assert r.status_code == 503
    assert "Retry-After" in r.headers


def test_concurrent_renders_on_same_session_are_serialized(client: TestClient) -> None:
    sid = client.post("/prepare", files={"image": ("x.png", _png_bytes(), "image/png")}).json()["session_id"]
    # Two sequential renders should both succeed; this also exercises the lock.
    body = {"session_id": sid, "lights": [], "ambient": 0.2,
            "output_format": "png", "output_bit_depth": 8}
    r1 = client.post("/render", json=body)
    r2 = client.post("/render", json=body)
    assert r1.status_code == 200
    assert r2.status_code == 200
