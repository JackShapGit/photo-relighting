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
    def prepare(self, img: np.ndarray, mode: str = "interactive",
                *, segmenter: str = "rmbg") -> PreparedImage:
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


def test_prepare_rejects_oversize_image(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    # Lower MAX_DIM so we can test the gate without allocating a huge image.
    from relighting_api.routes import prepare as prepare_route
    monkeypatch.setattr(prepare_route, "MAX_DIM", 64)
    big = _png_bytes(h=65, w=65)
    r = client.post("/prepare", files={"image": ("big.png", big, "image/png")})
    assert r.status_code == 413


def test_prepare_rejects_unsupported_format(client: TestClient) -> None:
    r = client.post("/prepare", files={"image": ("x.bmp", b"\x00\x01\x02\x03", "image/bmp")})
    assert r.status_code in (415, 400)


# --- camera raw (DNG/CR2/CR3/NEF/ARW/...) -------------------------------


def _real_raw() -> Path | None:
    """A real raw file from env override or the engine fixtures dir."""
    import os

    env = os.environ.get("RELIGHT_TEST_RAW")
    if env and Path(env).is_file():
        return Path(env)
    fixtures = (
        Path(__file__).resolve().parents[3]
        / "relighting_engine" / "tests" / "fixtures" / "images"
    )
    for ext in ("dng", "cr2", "cr3", "nef", "arw", "raf", "orf", "rw2"):
        hits = sorted(fixtures.glob(f"sample.{ext}"))
        if hits:
            return hits[0]
    return None


def test_prepare_still_rejects_non_images(client: TestClient) -> None:
    """Raw-first dispatch must not turn junk uploads into 500s."""
    r = client.post(
        "/prepare", files={"image": ("x.bin", b"not an image", "application/octet-stream")}
    )
    assert r.status_code == 415


@pytest.mark.skipif(_real_raw() is None, reason="no real raw fixture available")
def test_prepare_accepts_camera_raw(client: TestClient) -> None:
    path = _real_raw()
    r = client.post(
        "/prepare",
        files={"image": (path.name, path.read_bytes(), "image/x-adobe-dng")},
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["width"] > 0 and body["height"] > 0


@pytest.mark.skipif(_real_raw() is None, reason="no real raw fixture available")
def test_prepare_raw_persists_original_bytes(client: TestClient, tmp_path: Path) -> None:
    """The original raw must survive for scene export/import round trips."""
    path = _real_raw()
    original = path.read_bytes()
    r = client.post(
        "/prepare", files={"image": (path.name, original, "image/x-adobe-dng")}
    )
    assert r.status_code == 200, r.text
    sess_dir = tmp_path / "sessions" / r.json()["session_id"]
    saved = sorted(sess_dir.glob("source.*"))
    assert saved, "no source file persisted"
    assert saved[0].read_bytes() == original


@pytest.mark.skipif(_real_raw() is None, reason="no real raw fixture available")
def test_prepare_raw_uses_full_frame_not_embedded_thumbnail(client: TestClient) -> None:
    """Regression: Pillow reads some DNGs as their ~216x320 embedded preview.

    The raw-first dispatch must yield the real sensor dimensions instead.
    """
    path = _real_raw()
    r = client.post(
        "/prepare", files={"image": (path.name, path.read_bytes(), "image/x-adobe-dng")}
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert max(body["width"], body["height"]) > 1000, (
        f"got {body['width']}x{body['height']} -- looks like an embedded preview"
    )
