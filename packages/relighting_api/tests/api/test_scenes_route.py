"""End-to-end tests for the /scenes routes."""
from __future__ import annotations

import io
import json
import zipfile
from pathlib import Path

import numpy as np
import pytest
from fastapi.testclient import TestClient
from PIL import Image

from relighting_api.main import create_app

from .conftest import FakeEngine


def _png_bytes(h: int = 16, w: int = 16) -> bytes:
    arr = (np.random.default_rng(0).random((h, w, 3)) * 255).astype(np.uint8)
    buf = io.BytesIO()
    Image.fromarray(arr).save(buf, format="PNG")
    return buf.getvalue()


@pytest.fixture
def client(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> TestClient:
    monkeypatch.setenv("RELIGHT_CACHE_DIR", str(tmp_path / "sessions"))
    monkeypatch.setenv("RELIGHT_SCENES_DB", str(tmp_path / "scenes.db"))
    app = create_app(skip_engine=True)
    app.state.engine = FakeEngine()
    return TestClient(app)


def _prepare(client: TestClient) -> str:
    """Helper: upload a PNG and return its session id."""
    r = client.post("/prepare", files={"image": ("x.png", _png_bytes(), "image/png")})
    assert r.status_code == 200, r.text
    return r.json()["session_id"]


# ─── CRUD ────────────────────────────────────────────────────────────────

def test_create_scene_requires_existing_session(client: TestClient) -> None:
    r = client.post("/scenes", json={
        "name": "x", "session_id": "no-such-session", "state": {},
    })
    assert r.status_code == 404


def test_create_scene_persists_and_returns_state(client: TestClient) -> None:
    sid = _prepare(client)
    r = client.post("/scenes", json={
        "name": "First", "session_id": sid, "state": {"v": 1},
    })
    assert r.status_code == 200
    body = r.json()
    assert body["name"] == "First"
    assert body["session_id"] == sid
    assert body["state"] == {"v": 1}


def test_get_scene_includes_assets_and_dimensions(client: TestClient) -> None:
    sid = _prepare(client)
    create = client.post("/scenes", json={
        "name": "g", "session_id": sid, "state": {},
    }).json()
    r = client.get(f"/scenes/{create['id']}")
    assert r.status_code == 200
    body = r.json()
    assert "assets" in body
    assert body["assets"]["original_png_url"].startswith(f"/cache/sessions/{sid}")
    assert body["width"] == 16
    assert body["height"] == 16


def test_get_scene_marks_session_missing(client: TestClient) -> None:
    sid = _prepare(client)
    create = client.post("/scenes", json={
        "name": "orphan", "session_id": sid, "state": {},
    }).json()
    # Wipe the session dir to simulate eviction. We delete by path AND drop
    # the in-memory cache; the route checks disk existence to set the flag.
    import shutil
    sessions = client.app.state.sessions
    shutil.rmtree(sessions.dir / sid)
    sessions._mem.pop(sid, None)
    r = client.get(f"/scenes/{create['id']}")
    assert r.status_code == 200
    assert r.json().get("session_missing") is True


def test_list_scenes_orders_by_updated_desc_with_thumbnails(client: TestClient) -> None:
    sid = _prepare(client)
    a = client.post("/scenes", json={"name": "A", "session_id": sid, "state": {}}).json()
    b = client.post("/scenes", json={"name": "B", "session_id": sid, "state": {}}).json()
    listed = client.get("/scenes").json()
    assert [s["id"] for s in listed] == [b["id"], a["id"]]
    # Both should expose a thumbnail since they share the same session.
    for s in listed:
        assert s["thumbnail_url"].endswith("/thumb.jpg")


def test_update_scene_persists_state(client: TestClient) -> None:
    sid = _prepare(client)
    s = client.post("/scenes", json={"name": "x", "session_id": sid, "state": {"v": 1}}).json()
    r = client.put(f"/scenes/{s['id']}", json={"state": {"v": 42}})
    assert r.status_code == 200
    fetched = client.get(f"/scenes/{s['id']}").json()
    assert fetched["state"] == {"v": 42}


def test_rename_scene(client: TestClient) -> None:
    sid = _prepare(client)
    s = client.post("/scenes", json={"name": "Old", "session_id": sid, "state": {}}).json()
    r = client.patch(f"/scenes/{s['id']}/name", json={"name": "New"})
    assert r.status_code == 200
    assert client.get(f"/scenes/{s['id']}").json()["name"] == "New"


def test_rename_rejects_empty(client: TestClient) -> None:
    sid = _prepare(client)
    s = client.post("/scenes", json={"name": "A", "session_id": sid, "state": {}}).json()
    r = client.patch(f"/scenes/{s['id']}/name", json={"name": ""})
    assert r.status_code == 422


def test_delete_scene(client: TestClient) -> None:
    sid = _prepare(client)
    s = client.post("/scenes", json={"name": "x", "session_id": sid, "state": {}}).json()
    assert client.delete(f"/scenes/{s['id']}").status_code == 200
    assert client.get(f"/scenes/{s['id']}").status_code == 404


# ─── Export / Import ────────────────────────────────────────────────────

def test_export_returns_zip_with_manifest_and_source(client: TestClient) -> None:
    sid = _prepare(client)
    s = client.post("/scenes", json={
        "name": "Exportable", "session_id": sid, "state": {"v": 7},
    }).json()
    r = client.get(f"/scenes/{s['id']}/export")
    assert r.status_code == 200
    assert r.headers["content-type"] == "application/zip"
    assert 'filename="Exportable.relight.zip"' in r.headers["content-disposition"]

    zf = zipfile.ZipFile(io.BytesIO(r.content))
    names = set(zf.namelist())
    assert "scene.json" in names
    assert any(n.startswith("source.") for n in names)

    manifest = json.loads(zf.read("scene.json"))
    assert manifest["name"] == "Exportable"
    assert manifest["state"] == {"v": 7}


def test_export_404_for_missing_scene(client: TestClient) -> None:
    assert client.get("/scenes/nope/export").status_code == 404


def test_import_creates_scene_from_zip(client: TestClient) -> None:
    # Create + export an original scene
    sid = _prepare(client)
    src = client.post("/scenes", json={
        "name": "Source", "session_id": sid, "state": {"answer": 42},
    }).json()
    blob = client.get(f"/scenes/{src['id']}/export").content

    # Import as a new scene
    r = client.post(
        "/scenes/import",
        files={"file": ("scene.relight.zip", blob, "application/zip")},
    )
    assert r.status_code == 200
    imported = r.json()
    assert imported["name"] == "Source"
    assert imported["state"] == {"answer": 42}
    assert imported["session_id"] != sid          # fresh session created
    assert imported["id"] != src["id"]            # fresh scene id


def test_import_rejects_non_zip(client: TestClient) -> None:
    r = client.post(
        "/scenes/import",
        files={"file": ("not.zip", b"hello", "application/zip")},
    )
    assert r.status_code == 400
