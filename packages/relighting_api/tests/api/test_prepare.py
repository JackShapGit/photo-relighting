"""Endpoint tests for POST /prepare. Uses a fake engine to avoid real models."""
from __future__ import annotations

import io
from pathlib import Path

import numpy as np
import pytest
from fastapi.testclient import TestClient
from PIL import Image

from relighting_api.main import create_app
from relighting_engine.core.prepared import PreparedImage


class FakeEngine:
    def prepare(self, img: np.ndarray, mode: str = "interactive") -> PreparedImage:
        h, w = img.shape[:2]
        return PreparedImage(
            original=img.astype(np.float32),
            depth=np.full((h, w), 0.5, dtype=np.float32),
            normals=np.tile(np.array([0.0, 0.0, 1.0], dtype=np.float32), (h, w, 1)),
            mask=np.full((h, w), 0.7, dtype=np.float32),
            width=w, height=h,
            metadata={"depth_model": "fake", "seg_model": "fake", "prep_ms": 0},
        )


@pytest.fixture
def client(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> TestClient:
    monkeypatch.setenv("RELIGHT_CACHE_DIR", str(tmp_path / "sessions"))
    app = create_app(skip_engine=True)
    app.state.engine = FakeEngine()
    return TestClient(app)


def _png_bytes(h: int = 32, w: int = 32) -> bytes:
    arr = (np.random.default_rng(0).random((h, w, 3)) * 255).astype(np.uint8)
    buf = io.BytesIO()
    Image.fromarray(arr).save(buf, format="PNG")
    return buf.getvalue()


def test_prepare_returns_session_with_asset_urls(client: TestClient) -> None:
    r = client.post("/prepare", files={"image": ("x.png", _png_bytes(), "image/png")})
    assert r.status_code == 200, r.text
    body = r.json()
    assert "session_id" in body
    assert body["assets"]["original_png_url"].startswith("/cache/")
    assert body["assets"]["depth_png_url"].startswith("/cache/")
    assert body["metadata"]["depth_model"] == "fake"


def test_prepare_rejects_oversize_image(client: TestClient) -> None:
    big = _png_bytes(h=4097, w=4097)
    r = client.post("/prepare", files={"image": ("big.png", big, "image/png")})
    assert r.status_code == 413


def test_prepare_rejects_unsupported_format(client: TestClient) -> None:
    r = client.post("/prepare", files={"image": ("x.bmp", b"\x00\x01\x02\x03", "image/bmp")})
    assert r.status_code in (415, 400)
