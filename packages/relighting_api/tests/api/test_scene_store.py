"""SceneStore CRUD tests — direct against the class, no HTTP layer."""
from __future__ import annotations

import time
from pathlib import Path

import pytest

from relighting_api.scene_store import SceneStore


@pytest.fixture
def store(tmp_path: Path) -> SceneStore:
    return SceneStore(tmp_path / "scenes.db")


def test_create_returns_full_record(store: SceneStore) -> None:
    s = store.create(name="Test", session_id="sess1", state={"foo": 1})
    assert s["id"]
    assert s["name"] == "Test"
    assert s["session_id"] == "sess1"
    assert s["state"] == {"foo": 1}
    assert s["created_at"] == s["updated_at"]


def test_get_returns_none_for_missing(store: SceneStore) -> None:
    assert store.get("nope") is None


def test_get_round_trips_state(store: SceneStore) -> None:
    state = {"tree": [{"kind": "light", "id": "x", "name": "Key"}], "ambient": 0.3}
    s = store.create(name="A", session_id="sess1", state=state)
    fetched = store.get(s["id"])
    assert fetched is not None
    assert fetched["state"] == state


def test_list_recent_orders_by_updated_desc(store: SceneStore) -> None:
    a = store.create(name="A", session_id="s1", state={})
    time.sleep(0.01)
    b = store.create(name="B", session_id="s2", state={})
    listed = store.list_recent()
    assert [x["id"] for x in listed] == [b["id"], a["id"]]


def test_list_recent_omits_state(store: SceneStore) -> None:
    store.create(name="A", session_id="s1", state={"big": "blob"})
    listed = store.list_recent()
    assert "state" not in listed[0]


def test_update_state_bumps_updated_at(store: SceneStore) -> None:
    s = store.create(name="A", session_id="s1", state={"v": 1})
    time.sleep(0.01)
    assert store.update_state(s["id"], {"v": 2})
    fetched = store.get(s["id"])
    assert fetched is not None
    assert fetched["state"] == {"v": 2}
    assert fetched["updated_at"] > s["updated_at"]


def test_update_state_returns_false_for_missing(store: SceneStore) -> None:
    assert store.update_state("nope", {}) is False


def test_rename_persists(store: SceneStore) -> None:
    s = store.create(name="Old", session_id="s1", state={})
    assert store.rename(s["id"], "New")
    assert store.get(s["id"])["name"] == "New"


def test_delete_removes(store: SceneStore) -> None:
    s = store.create(name="A", session_id="s1", state={})
    assert store.delete(s["id"])
    assert store.get(s["id"]) is None
    assert store.delete(s["id"]) is False


def test_referenced_session_ids_dedupes(store: SceneStore) -> None:
    store.create(name="A", session_id="s1", state={})
    store.create(name="B", session_id="s1", state={})  # same session as A
    store.create(name="C", session_id="s2", state={})
    assert store.referenced_session_ids() == {"s1", "s2"}


def test_create_persists_across_instances(tmp_path: Path) -> None:
    db = tmp_path / "scenes.db"
    s1 = SceneStore(db)
    scene = s1.create(name="Persisted", session_id="x", state={"a": 1})
    s2 = SceneStore(db)   # fresh instance, same file
    fetched = s2.get(scene["id"])
    assert fetched is not None
    assert fetched["name"] == "Persisted"
    assert fetched["state"] == {"a": 1}
