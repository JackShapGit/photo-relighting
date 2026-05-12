"""SceneStore — SQLite-backed CRUD for saved scenes.

A "scene" is a named lighting setup paired with a session_id pointer to the
prepared image cache. Auto-save updates state_json on every edit; the actual
image bytes live in cache/sessions/{session_id}/ and are never duplicated.

Schema:
    scenes(
      id          TEXT PK,             -- UUID hex
      name        TEXT NOT NULL,
      created_at  TEXT NOT NULL,       -- ISO 8601 UTC
      updated_at  TEXT NOT NULL,
      session_id  TEXT NOT NULL,       -- references cache/sessions/{sid}
      state_json  TEXT NOT NULL        -- the full state blob (tree, lights, ambient, ...)
    )
"""
from __future__ import annotations

import json
import sqlite3
import uuid
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


_SCHEMA = """
CREATE TABLE IF NOT EXISTS scenes (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL,
    session_id  TEXT NOT NULL,
    state_json  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_scenes_updated_at ON scenes(updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_scenes_name        ON scenes(name);
CREATE INDEX IF NOT EXISTS idx_scenes_session_id  ON scenes(session_id);
"""


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _row_to_scene(row: sqlite3.Row, *, include_state: bool = True) -> dict[str, Any]:
    out = {
        "id": row["id"],
        "name": row["name"],
        "created_at": row["created_at"],
        "updated_at": row["updated_at"],
        "session_id": row["session_id"],
    }
    if include_state:
        out["state"] = json.loads(row["state_json"])
    return out


class SceneStore:
    def __init__(self, db_path: str | Path):
        self.db_path = Path(db_path)
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        with self._conn() as c:
            c.executescript(_SCHEMA)

    @contextmanager
    def _conn(self):
        conn = sqlite3.connect(self.db_path)
        conn.row_factory = sqlite3.Row
        try:
            yield conn
            conn.commit()
        finally:
            conn.close()

    def create(self, *, name: str, session_id: str, state: dict[str, Any]) -> dict[str, Any]:
        sid = uuid.uuid4().hex
        now = _now_iso()
        with self._conn() as c:
            c.execute(
                "INSERT INTO scenes (id, name, created_at, updated_at, session_id, state_json) "
                "VALUES (?, ?, ?, ?, ?, ?)",
                (sid, name, now, now, session_id, json.dumps(state)),
            )
        return self.get(sid)  # type: ignore[return-value]

    def get(self, scene_id: str) -> dict[str, Any] | None:
        with self._conn() as c:
            row = c.execute("SELECT * FROM scenes WHERE id = ?", (scene_id,)).fetchone()
        return _row_to_scene(row) if row else None

    def list_recent(self) -> list[dict[str, Any]]:
        """Returns scenes (without state_json) sorted by updated_at desc."""
        with self._conn() as c:
            rows = c.execute("SELECT * FROM scenes ORDER BY updated_at DESC").fetchall()
        return [_row_to_scene(r, include_state=False) for r in rows]

    def update_state(self, scene_id: str, state: dict[str, Any]) -> bool:
        with self._conn() as c:
            r = c.execute(
                "UPDATE scenes SET state_json = ?, updated_at = ? WHERE id = ?",
                (json.dumps(state), _now_iso(), scene_id),
            )
            return r.rowcount > 0

    def rename(self, scene_id: str, name: str) -> bool:
        with self._conn() as c:
            r = c.execute(
                "UPDATE scenes SET name = ?, updated_at = ? WHERE id = ?",
                (name, _now_iso(), scene_id),
            )
            return r.rowcount > 0

    def delete(self, scene_id: str) -> bool:
        with self._conn() as c:
            r = c.execute("DELETE FROM scenes WHERE id = ?", (scene_id,))
            return r.rowcount > 0

    def referenced_session_ids(self) -> set[str]:
        """All session ids referenced by any scene. Useful for pinning the
        underlying SessionStore against TTL eviction."""
        with self._conn() as c:
            rows = c.execute("SELECT DISTINCT session_id FROM scenes").fetchall()
        return {r["session_id"] for r in rows}
