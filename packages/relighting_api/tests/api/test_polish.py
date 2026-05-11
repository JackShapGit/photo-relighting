"""Tests for POST /polish — happy path, errors, capability gating."""
from __future__ import annotations

import numpy as np
import pytest
import torch
from fastapi.testclient import TestClient

from relighting_api.main import create_app
from relighting_engine.core.prepared import PreparedImage

from tests.api.conftest import FakeEngine


@pytest.fixture
def client_with_session(tmp_path, monkeypatch):
    """App + fake engine + a pre-populated session named 'sess-1'."""
    monkeypatch.setenv("RELIGHT_CACHE_DIR", str(tmp_path / "sessions"))
    monkeypatch.setenv("RELIGHT_SCENES_DB", str(tmp_path / "scenes.db"))
    app = create_app(skip_engine=True)
    fake = FakeEngine()
    app.state.engine = fake
    app.state.capabilities = {"polish": True, "segmenters": ["rmbg"]}

    # Inject a prepared image into the session store. SessionStore._mem is a
    # dict of (PreparedImage, timestamp) tuples — see session_store.py.
    import time
    prepared = PreparedImage(
        original=np.full((32, 32, 3), 0.5, dtype=np.float32),
        depth=np.full((32, 32), 0.5, dtype=np.float32),
        normals=np.tile(np.array([0.0, 0.0, 1.0], dtype=np.float32), (32, 32, 1)),
        mask=None,
        width=32,
        height=32,
        metadata={"depth_model": "fake", "seg_model": "fake", "prep_ms": 0,
                  "subject_median_depth": 0.5},
    )
    app.state.sessions._mem["sess-1"] = (prepared, time.monotonic())
    return TestClient(app), fake


def test_polish_happy_path_returns_png(client_with_session):
    client, _ = client_with_session
    r = client.post("/polish", json={"session_id": "sess-1", "lights": []})
    assert r.status_code == 200
    assert r.headers["content-type"] == "image/png"
    assert len(r.content) > 100


def test_polish_forwards_prompt_and_seed(client_with_session):
    client, fake = client_with_session
    r = client.post("/polish", json={
        "session_id": "sess-1", "lights": [],
        "prompt": "golden hour", "seed": 7,
    })
    assert r.status_code == 200
    assert fake.last_prompt == "golden hour"
    assert fake.last_seed == 7


def test_polish_unknown_session_404(client_with_session):
    client, _ = client_with_session
    r = client.post("/polish", json={"session_id": "nope", "lights": []})
    assert r.status_code == 404


def test_polish_invalid_lights_422(client_with_session):
    client, _ = client_with_session
    r = client.post("/polish", json={
        "session_id": "sess-1",
        "lights": [{"type": "not-a-real-type"}],
    })
    assert r.status_code == 422


def test_polish_oom_503_with_retry_after(client_with_session):
    client, fake = client_with_session
    fake.polish_raises = torch.cuda.OutOfMemoryError("OOM")
    r = client.post("/polish", json={"session_id": "sess-1", "lights": []})
    assert r.status_code == 503
    assert r.headers.get("Retry-After") == "30"


def test_polish_capability_disabled_501(client_with_session):
    client, _ = client_with_session
    client.app.state.capabilities["polish"] = False
    r = client.post("/polish", json={"session_id": "sess-1", "lights": []})
    assert r.status_code == 501
    assert "polish unavailable" in r.json()["detail"].lower()


def test_polish_lock_contention_409(client_with_session):
    """Second concurrent polish on the same session returns 409.

    We can't easily hold an asyncio.Lock across the sync TestClient boundary,
    so we substitute the session's lock with one whose .locked() reports True.
    The route only consults .locked() before deciding to 409, so this
    accurately exercises the contention branch.
    """
    client, _ = client_with_session
    sessions = client.app.state.sessions

    class _PreLocked:
        def locked(self): return True
        async def __aenter__(self): raise AssertionError("should not enter")
        async def __aexit__(self, *exc): return False

    sessions._locks["sess-1"] = _PreLocked()
    r = client.post("/polish", json={"session_id": "sess-1", "lights": []})
    assert r.status_code == 409
