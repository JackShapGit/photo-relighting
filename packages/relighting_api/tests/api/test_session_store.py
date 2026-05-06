"""Unit tests for SessionStore: TTL eviction, disk persistence, lazy reload."""
from __future__ import annotations

import time
from pathlib import Path

import numpy as np
import pytest

from relighting_engine.core.prepared import PreparedImage
from relighting_api.session_store import SessionStore


def _prepared(h: int = 16, w: int = 16) -> PreparedImage:
    return PreparedImage(
        original=np.full((h, w, 3), 0.4, dtype=np.float32),
        depth=np.full((h, w), 0.5, dtype=np.float32),
        normals=np.tile(np.array([0.0, 0.0, 1.0], dtype=np.float32), (h, w, 1)),
        mask=None,
        width=w,
        height=h,
        metadata={"depth_model": "x", "seg_model": "y", "prep_ms": 1},
    )


def test_put_and_get_round_trips(tmp_path: Path) -> None:
    s = SessionStore(cache_dir=tmp_path, ttl_seconds=600)
    sid = s.put(_prepared())
    p = s.get(sid)
    assert p is not None
    assert p.width == 16


def test_get_unknown_returns_none(tmp_path: Path) -> None:
    s = SessionStore(cache_dir=tmp_path, ttl_seconds=600)
    assert s.get("does-not-exist") is None


def test_disk_persistence_survives_new_instance(tmp_path: Path) -> None:
    s1 = SessionStore(cache_dir=tmp_path, ttl_seconds=600)
    sid = s1.put(_prepared())
    s2 = SessionStore(cache_dir=tmp_path, ttl_seconds=600)
    p = s2.get(sid)
    assert p is not None
    assert p.width == 16


def test_ttl_eviction_kicks_in(tmp_path: Path) -> None:
    s = SessionStore(cache_dir=tmp_path, ttl_seconds=0.05)
    sid = s.put(_prepared())
    time.sleep(0.1)
    s.evict_expired()
    assert s.get(sid) is None


def test_delete_removes_disk_and_memory(tmp_path: Path) -> None:
    s = SessionStore(cache_dir=tmp_path, ttl_seconds=600)
    sid = s.put(_prepared())
    s.delete(sid)
    assert s.get(sid) is None
    # Disk dir should also be gone
    assert not (tmp_path / sid).exists()
