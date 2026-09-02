"""VenueStore — SQLite-backed CRUD for venues (Spec 2, fixture table).

A venue is a named stage: dimensions, area grid, focus height and hanging
positions (pipes, booms, floor positions). Scenes reference a venue by id and
keep an embedded snapshot so a deleted venue never breaks a scene.

Lives in the same SQLite file as the scenes table so the delete guard can
count referencing scenes with ``json_extract`` over ``scenes.state_json``.

Schema:
    venues(
      id            TEXT PK,             -- UUID hex
      name          TEXT NOT NULL,
      workspace_id  TEXT NOT NULL,       -- per-user namespace ('default' for legacy rows)
      created_at    TEXT NOT NULL,       -- ISO 8601 UTC
      updated_at    TEXT NOT NULL,
      venue_json    TEXT NOT NULL        -- dims, grid, focus_height_ft, positions
    )
"""
from __future__ import annotations

import json
import math
import sqlite3
import uuid
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from relighting_api.scene_store import DEFAULT_WORKSPACE

_SCHEMA = """
CREATE TABLE IF NOT EXISTS venues (
    id            TEXT PRIMARY KEY,
    name          TEXT NOT NULL,
    workspace_id  TEXT NOT NULL DEFAULT 'default',
    created_at    TEXT NOT NULL,
    updated_at    TEXT NOT NULL,
    venue_json    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_venues_workspace  ON venues(workspace_id);
CREATE INDEX IF NOT EXISTS idx_venues_updated_at ON venues(updated_at DESC);
"""

_ROW_KEYS = ("id", "name", "workspace_id", "created_at", "updated_at")


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _round1(v: float) -> float:
    """Round half up to one decimal, matching JS Math.round(v * 10) / 10."""
    return math.floor(v * 10 + 0.5) / 10


def starter_positions(width_ft: float, height_ft: float, depth_ft: float) -> list[dict[str, Any]]:
    """Mirror of web/src/rig/geometry.js starterPositions (same numbers)."""
    pid = lambda: uuid.uuid4().hex  # noqa: E731
    return [
        {"id": pid(), "name": "FOH truss",    "kind": "pipe", "upstage_ft": _round1(-depth_ft * 1.3), "trim_ft": _round1(height_ft + 2)},
        {"id": pid(), "name": "1st electric", "kind": "pipe", "upstage_ft": _round1(depth_ft * 0.20), "trim_ft": _round1(height_ft)},
        {"id": pid(), "name": "2nd electric", "kind": "pipe", "upstage_ft": _round1(depth_ft * 0.47), "trim_ft": _round1(height_ft)},
        {"id": pid(), "name": "3rd electric", "kind": "pipe", "upstage_ft": _round1(depth_ft * 0.73), "trim_ft": _round1(height_ft)},
        {"id": pid(), "name": "Boom SR", "kind": "boom", "offset_ft": _round1(-(width_ft / 2 + 2)), "upstage_ft": _round1(depth_ft * 0.27)},
        {"id": pid(), "name": "Boom SL", "kind": "boom", "offset_ft": _round1(width_ft / 2 + 2),  "upstage_ft": _round1(depth_ft * 0.27)},
    ]


def _row_to_venue(row: sqlite3.Row) -> dict[str, Any]:
    out = json.loads(row["venue_json"])
    for k in _ROW_KEYS:
        out[k] = row[k]
    return out


def _venue_body(venue: dict[str, Any]) -> dict[str, Any]:
    """The JSON blob: everything except the row-owned keys."""
    return {k: v for k, v in venue.items() if k not in _ROW_KEYS}


class VenueStore:
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

    def create(
        self, *, name: str, venue: dict[str, Any], workspace_id: str = DEFAULT_WORKSPACE,
    ) -> dict[str, Any]:
        vid = uuid.uuid4().hex
        now = _now_iso()
        with self._conn() as c:
            c.execute(
                "INSERT INTO venues (id, name, workspace_id, created_at, updated_at, venue_json) "
                "VALUES (?, ?, ?, ?, ?, ?)",
                (vid, name, workspace_id, now, now, json.dumps(_venue_body(venue))),
            )
        return self.get(vid, workspace_id=workspace_id)  # type: ignore[return-value]

    def get(
        self, venue_id: str, *, workspace_id: str | None = None,
    ) -> dict[str, Any] | None:
        with self._conn() as c:
            if workspace_id is None:
                row = c.execute("SELECT * FROM venues WHERE id = ?", (venue_id,)).fetchone()
            else:
                row = c.execute(
                    "SELECT * FROM venues WHERE id = ? AND workspace_id = ?",
                    (venue_id, workspace_id),
                ).fetchone()
        return _row_to_venue(row) if row else None

    def list_recent(self, *, workspace_id: str = DEFAULT_WORKSPACE) -> list[dict[str, Any]]:
        """Venues in this workspace (full records; they are small), newest first."""
        with self._conn() as c:
            rows = c.execute(
                "SELECT * FROM venues WHERE workspace_id = ? ORDER BY updated_at DESC",
                (workspace_id,),
            ).fetchall()
        return [_row_to_venue(r) for r in rows]

    def update(
        self, venue_id: str, venue: dict[str, Any], *, workspace_id: str | None = None,
    ) -> bool:
        name = venue.get("name")
        body = json.dumps(_venue_body(venue))
        with self._conn() as c:
            if workspace_id is None:
                r = c.execute(
                    "UPDATE venues SET venue_json = ?, name = COALESCE(?, name), updated_at = ? WHERE id = ?",
                    (body, name, _now_iso(), venue_id),
                )
            else:
                r = c.execute(
                    "UPDATE venues SET venue_json = ?, name = COALESCE(?, name), updated_at = ? "
                    "WHERE id = ? AND workspace_id = ?",
                    (body, name, _now_iso(), venue_id, workspace_id),
                )
            return r.rowcount > 0

    def delete(self, venue_id: str, *, workspace_id: str | None = None) -> bool:
        with self._conn() as c:
            if workspace_id is None:
                r = c.execute("DELETE FROM venues WHERE id = ?", (venue_id,))
            else:
                r = c.execute(
                    "DELETE FROM venues WHERE id = ? AND workspace_id = ?",
                    (venue_id, workspace_id),
                )
            return r.rowcount > 0

    def duplicate(
        self, venue_id: str, name: str, *, workspace_id: str = DEFAULT_WORKSPACE,
    ) -> dict[str, Any] | None:
        src = self.get(venue_id, workspace_id=workspace_id)
        if src is None:
            return None
        body = _venue_body(src)
        body["positions"] = [{**p, "id": uuid.uuid4().hex} for p in body.get("positions", [])]
        body["name"] = name
        return self.create(name=name, venue=body, workspace_id=workspace_id)

    def count_scene_refs(self, venue_id: str, *, workspace_id: str = DEFAULT_WORKSPACE) -> int:
        """Scenes in this workspace whose state references the venue. The
        scenes table lives in the same file (SceneStore owns it); without it
        there is nothing to count."""
        with self._conn() as c:
            try:
                row = c.execute(
                    "SELECT COUNT(*) AS n FROM scenes "
                    "WHERE workspace_id = ? AND json_extract(state_json, '$.venue_id') = ?",
                    (workspace_id, venue_id),
                ).fetchone()
            except sqlite3.OperationalError:
                return 0
        return int(row["n"]) if row else 0
