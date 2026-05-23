"""SceneStore — SQLite-backed CRUD for saved scenes.

A "scene" is a named lighting setup paired with a session_id pointer to the
prepared image cache. Auto-save updates state_json on every edit; the actual
image bytes live in cache/sessions/{session_id}/ and are never duplicated.

Schema:
    scenes(
      id            TEXT PK,             -- UUID hex
      name          TEXT NOT NULL,
      created_at    TEXT NOT NULL,       -- ISO 8601 UTC
      updated_at    TEXT NOT NULL,
      session_id    TEXT NOT NULL,       -- references cache/sessions/{sid}
      state_json    TEXT NOT NULL,       -- the full state blob (tree, lights, ambient, ...)
      workspace_id  TEXT NOT NULL        -- per-user namespace ('default' for legacy rows)
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


DEFAULT_WORKSPACE = "default"

_SCHEMA = """
CREATE TABLE IF NOT EXISTS scenes (
    id            TEXT PRIMARY KEY,
    name          TEXT NOT NULL,
    created_at    TEXT NOT NULL,
    updated_at    TEXT NOT NULL,
    session_id    TEXT NOT NULL,
    state_json    TEXT NOT NULL,
    workspace_id  TEXT NOT NULL DEFAULT 'default'
);
CREATE INDEX IF NOT EXISTS idx_scenes_updated_at ON scenes(updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_scenes_name       ON scenes(name);
CREATE INDEX IF NOT EXISTS idx_scenes_session_id ON scenes(session_id);
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
            # Migration: ALTER existing tables that pre-date workspace_id. Pre-
            # existing rows get 'default' so they remain visible to anyone
            # opening the playground without a ?ws= query string.
            cols = {r[1] for r in c.execute("PRAGMA table_info(scenes)").fetchall()}
            if "workspace_id" not in cols:
                c.execute(
                    "ALTER TABLE scenes ADD COLUMN workspace_id "
                    "TEXT NOT NULL DEFAULT 'default'"
                )
            c.execute(
                "CREATE INDEX IF NOT EXISTS idx_scenes_workspace "
                "ON scenes(workspace_id)"
            )

    @contextmanager
    def _conn(self):
        conn = sqlite3.connect(self.db_path)
        conn.row_factory = sqlite3.Row
        try:
            yield conn
            conn.commit()
        finally:
            conn.close()

    def create(
        self, *, name: str, session_id: str, state: dict[str, Any],
        workspace_id: str = DEFAULT_WORKSPACE,
    ) -> dict[str, Any]:
        sid = uuid.uuid4().hex
        now = _now_iso()
        with self._conn() as c:
            c.execute(
                "INSERT INTO scenes (id, name, created_at, updated_at, "
                "session_id, state_json, workspace_id) "
                "VALUES (?, ?, ?, ?, ?, ?, ?)",
                (sid, name, now, now, session_id, json.dumps(state), workspace_id),
            )
        # Re-fetch through the workspace-scoped get() so the returned record is
        # consistent with what later reads will see.
        return self.get(sid, workspace_id=workspace_id)  # type: ignore[return-value]

    def get(
        self, scene_id: str, *, workspace_id: str | None = None,
    ) -> dict[str, Any] | None:
        # workspace_id=None means "any workspace" — used internally for GC. The
        # HTTP layer always passes one so users can't read across workspaces.
        with self._conn() as c:
            if workspace_id is None:
                row = c.execute("SELECT * FROM scenes WHERE id = ?", (scene_id,)).fetchone()
            else:
                row = c.execute(
                    "SELECT * FROM scenes WHERE id = ? AND workspace_id = ?",
                    (scene_id, workspace_id),
                ).fetchone()
        return _row_to_scene(row) if row else None

    def list_recent(
        self, *, workspace_id: str = DEFAULT_WORKSPACE,
    ) -> list[dict[str, Any]]:
        """Returns scenes (without state_json) in this workspace, sorted by updated_at desc."""
        with self._conn() as c:
            rows = c.execute(
                "SELECT * FROM scenes WHERE workspace_id = ? "
                "ORDER BY updated_at DESC",
                (workspace_id,),
            ).fetchall()
        return [_row_to_scene(r, include_state=False) for r in rows]

    def update_state(
        self, scene_id: str, state: dict[str, Any],
        *, workspace_id: str | None = None,
    ) -> bool:
        with self._conn() as c:
            if workspace_id is None:
                r = c.execute(
                    "UPDATE scenes SET state_json = ?, updated_at = ? WHERE id = ?",
                    (json.dumps(state), _now_iso(), scene_id),
                )
            else:
                r = c.execute(
                    "UPDATE scenes SET state_json = ?, updated_at = ? "
                    "WHERE id = ? AND workspace_id = ?",
                    (json.dumps(state), _now_iso(), scene_id, workspace_id),
                )
            return r.rowcount > 0

    def rename(
        self, scene_id: str, name: str, *, workspace_id: str | None = None,
    ) -> bool:
        with self._conn() as c:
            if workspace_id is None:
                r = c.execute(
                    "UPDATE scenes SET name = ?, updated_at = ? WHERE id = ?",
                    (name, _now_iso(), scene_id),
                )
            else:
                r = c.execute(
                    "UPDATE scenes SET name = ?, updated_at = ? "
                    "WHERE id = ? AND workspace_id = ?",
                    (name, _now_iso(), scene_id, workspace_id),
                )
            return r.rowcount > 0

    def delete(self, scene_id: str, *, workspace_id: str | None = None) -> bool:
        with self._conn() as c:
            if workspace_id is None:
                r = c.execute("DELETE FROM scenes WHERE id = ?", (scene_id,))
            else:
                r = c.execute(
                    "DELETE FROM scenes WHERE id = ? AND workspace_id = ?",
                    (scene_id, workspace_id),
                )
            return r.rowcount > 0

    def referenced_session_ids(self) -> set[str]:
        """All session ids referenced by any scene. Useful for pinning the
        underlying SessionStore against TTL eviction."""
        with self._conn() as c:
            rows = c.execute("SELECT DISTINCT session_id FROM scenes").fetchall()
        return {r["session_id"] for r in rows}
