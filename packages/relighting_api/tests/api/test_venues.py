"""/venues routes: CRUD, workspace isolation, starters, delete guard, duplicate, validation."""
from __future__ import annotations

import io
import json
from pathlib import Path

import numpy as np
import pytest
from fastapi.testclient import TestClient
from PIL import Image

from relighting_api.main import create_app

from .conftest import FakeEngine

GRID = {"rows": 3, "cols": 3, "number_from_stage_left": False}
POS = [
    {"id": "p1", "name": "1E", "kind": "pipe", "upstage_ft": 6, "trim_ft": 20},
    {"id": "p2", "name": "Boom SL", "kind": "boom", "upstage_ft": 8, "offset_ft": 22},
    {"id": "p3", "name": "Floor", "kind": "floor", "upstage_ft": 28},
]


def _venue(**over):
    v = {"name": "Test House", "width_ft": 40, "height_ft": 20, "depth_ft": 30,
         "grid": GRID, "focus_height_ft": 5, "positions": POS}
    v.update(over)
    return v


@pytest.fixture
def client(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> TestClient:
    monkeypatch.setenv("RELIGHT_CACHE_DIR", str(tmp_path / "sessions"))
    monkeypatch.setenv("RELIGHT_SCENES_DB", str(tmp_path / "scenes.db"))
    app = create_app(skip_engine=True)
    app.state.engine = FakeEngine()
    return TestClient(app)


def _scene_with_venue(client: TestClient, venue_id: str, workspace: str = "default") -> str:
    arr = (np.random.default_rng(0).random((16, 16, 3)) * 255).astype(np.uint8)
    buf = io.BytesIO(); Image.fromarray(arr).save(buf, format="PNG")
    r = client.post("/prepare", files={"image": ("x.png", buf.getvalue(), "image/png")})
    assert r.status_code == 200, r.text
    r = client.post(f"/scenes?workspace={workspace}", json={
        "name": "s", "session_id": r.json()["session_id"], "state": {"venue_id": venue_id, "tree": []}})
    assert r.status_code == 200, r.text
    return r.json()["id"]


def test_crud_round_trip(client: TestClient) -> None:
    r = client.post("/venues", json=_venue())
    assert r.status_code == 200, r.text
    v = r.json()
    assert v["id"] and v["name"] == "Test House" and v["width_ft"] == 40
    assert [p["kind"] for p in v["positions"]] == ["pipe", "boom", "floor"]
    assert v["created_at"] == v["updated_at"]

    assert client.get("/venues").json()[0]["id"] == v["id"]
    assert client.get(f"/venues/{v['id']}").json()["positions"][0]["trim_ft"] == 20

    r = client.put(f"/venues/{v['id']}", json=_venue(name="Renamed", depth_ft=36))
    assert r.status_code == 200, r.text
    got = client.get(f"/venues/{v['id']}").json()
    assert got["name"] == "Renamed" and got["depth_ft"] == 36 and got["id"] == v["id"]

    assert client.delete(f"/venues/{v['id']}").status_code == 200
    assert client.get(f"/venues/{v['id']}").status_code == 404
    assert client.get("/venues").json() == []


def test_workspace_isolation(client: TestClient) -> None:
    a = client.post("/venues?workspace=alice", json=_venue(name="A")).json()
    assert client.get("/venues?workspace=alice").json()[0]["id"] == a["id"]
    assert client.get("/venues?workspace=bob").json() == []
    assert client.get(f"/venues/{a['id']}?workspace=bob").status_code == 404
    assert client.put(f"/venues/{a['id']}?workspace=bob", json=_venue(name="X")).status_code == 404
    assert client.delete(f"/venues/{a['id']}?workspace=bob").status_code == 404
    assert client.get(f"/venues/{a['id']}?workspace=alice").json()["name"] == "A"


def test_empty_positions_get_starters_scaled_to_the_venue(client: TestClient) -> None:
    v = client.post("/venues", json=_venue(positions=[])).json()
    p = {x["name"]: x for x in v["positions"]}
    assert len(p) == 6
    assert p["FOH truss"]["kind"] == "pipe" and p["FOH truss"]["upstage_ft"] == pytest.approx(-39)
    assert p["FOH truss"]["trim_ft"] == pytest.approx(22)
    assert p["1st electric"]["upstage_ft"] == pytest.approx(6) and p["1st electric"]["trim_ft"] == pytest.approx(20)
    assert p["2nd electric"]["upstage_ft"] == pytest.approx(14.1)
    assert p["3rd electric"]["upstage_ft"] == pytest.approx(21.9)
    assert p["Boom SR"]["kind"] == "boom" and p["Boom SR"]["offset_ft"] == pytest.approx(-22)
    assert p["Boom SL"]["offset_ft"] == pytest.approx(22) and p["Boom SL"]["upstage_ft"] == pytest.approx(8.1)
    assert len({x["id"] for x in v["positions"]}) == 6


def test_delete_refuses_while_referenced_unless_forced(client: TestClient) -> None:
    v = client.post("/venues", json=_venue()).json()
    _scene_with_venue(client, v["id"])
    _scene_with_venue(client, v["id"])
    r = client.delete(f"/venues/{v['id']}")
    assert r.status_code == 409
    assert r.json()["scene_count"] == 2 and "detail" in r.json()
    assert client.get(f"/venues/{v['id']}").status_code == 200
    r = client.delete(f"/venues/{v['id']}?force=1")
    assert r.status_code == 200 and r.json() == {"ok": True}
    assert client.get(f"/venues/{v['id']}").status_code == 404


def test_delete_guard_counts_only_this_workspace(client: TestClient) -> None:
    v = client.post("/venues?workspace=alice", json=_venue()).json()
    _scene_with_venue(client, v["id"], workspace="bob")      # another workspace's scene does not pin it
    assert client.delete(f"/venues/{v['id']}?workspace=alice").status_code == 200


def test_duplicate_copies_positions_with_new_ids(client: TestClient) -> None:
    v = client.post("/venues", json=_venue()).json()
    r = client.post(f"/venues/{v['id']}/duplicate", json={"name": "Copy"})
    assert r.status_code == 200, r.text
    d = r.json()
    assert d["id"] != v["id"] and d["name"] == "Copy"
    assert [p["name"] for p in d["positions"]] == [p["name"] for p in v["positions"]]
    assert {p["id"] for p in d["positions"]}.isdisjoint({p["id"] for p in v["positions"]})
    assert d["positions"][1]["offset_ft"] == 22
    assert len(client.get("/venues").json()) == 2
    assert client.post("/venues/nope/duplicate", json={"name": "X"}).status_code == 404


@pytest.mark.parametrize("bad", [
    _venue(grid={"rows": 7, "cols": 3, "number_from_stage_left": False}),
    _venue(grid={"rows": 3, "cols": 0, "number_from_stage_left": False}),
    _venue(positions=[{"id": "p", "name": "1E", "kind": "pipe", "upstage_ft": 6}]),          # pipe without trim
    _venue(positions=[{"id": "p", "name": "B", "kind": "boom", "upstage_ft": 6}]),           # boom without offset
    _venue(positions=[{"id": "p", "name": "X", "kind": "truss", "upstage_ft": 6}]),          # unknown kind
    _venue(width_ft=0),
    _venue(depth_ft=float("nan")),
    _venue(focus_height_ft=-1),
])
def test_validation_errors_are_422(client: TestClient, bad) -> None:
    # Raw body: httpx's json= refuses NaN, but a client can still send the
    # literal and the server must answer 422, not 500.
    r = client.post("/venues", content=json.dumps(bad), headers={"content-type": "application/json"})
    assert r.status_code == 422


def test_invalid_workspace_name_is_400(client: TestClient) -> None:
    assert client.get("/venues?workspace=bad%20name").status_code == 400
