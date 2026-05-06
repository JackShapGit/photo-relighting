"""SessionStore — in-memory dict + disk cache for PreparedImage instances.

Disk layout (under cache/sessions/{session_id}/):
    original.png      — 8-bit display version (browser texture)
    original_full.npy — float32 linear original (preserved precision)
    depth.npy
    normals.npy
    mask.npy          — only present when mask is not None
    meta.json         — width, height, metadata dict
"""
from __future__ import annotations

import asyncio
import json
import shutil
import time
import uuid
from pathlib import Path

import cv2
import numpy as np
from PIL import Image

from relighting_engine.core.prepared import PreparedImage


class SessionStore:
    def __init__(self, cache_dir: str | Path, ttl_seconds: float = 3600.0):
        self.dir = Path(cache_dir)
        self.dir.mkdir(parents=True, exist_ok=True)
        self.ttl = ttl_seconds
        self._mem: dict[str, tuple[PreparedImage, float]] = {}
        self._locks: dict[str, asyncio.Lock] = {}

    def _path(self, sid: str) -> Path:
        return self.dir / sid

    def lock(self, sid: str) -> asyncio.Lock:
        return self._locks.setdefault(sid, asyncio.Lock())

    def put(self, prepared: PreparedImage) -> str:
        sid = uuid.uuid4().hex
        d = self._path(sid)
        d.mkdir(parents=True, exist_ok=True)
        # 8-bit sRGB display version
        from relighting_engine.core.io import write_image
        write_image(d / "original.png", prepared.original, format="png", bit_depth=8)
        np.save(d / "original_full.npy", prepared.original)
        np.save(d / "depth.npy", prepared.depth)
        np.save(d / "normals.npy", prepared.normals)
        if prepared.mask is not None:
            np.save(d / "mask.npy", prepared.mask)
        (d / "meta.json").write_text(json.dumps({
            "width": prepared.width,
            "height": prepared.height,
            "metadata": prepared.metadata,
        }))
        # Also dump browser-friendly textures for /prepare assets
        self._dump_textures(d, prepared)
        self._mem[sid] = (prepared, time.monotonic())
        return sid

    def _dump_textures(self, d: Path, p: PreparedImage) -> None:
        # depth: 16-bit grayscale — use cv2 because Pillow's mode="I;16" path is
        # deprecated in Pillow 12 and removed in Pillow 13 (2026-10-15).
        depth16 = (np.clip(p.depth, 0, 1) * 65535 + 0.5).astype(np.uint16)
        cv2.imwrite(str(d / "depth.png"), depth16)
        # normals: (n*0.5+0.5) → uint8 RGB
        n = np.clip((p.normals * 0.5 + 0.5) * 255 + 0.5, 0, 255).astype(np.uint8)
        Image.fromarray(n, mode="RGB").save(d / "normals.png")
        if p.mask is not None:
            mask8 = np.clip(p.mask * 255 + 0.5, 0, 255).astype(np.uint8)
            Image.fromarray(mask8, mode="L").save(d / "mask.png")

    def get(self, sid: str) -> PreparedImage | None:
        if sid in self._mem:
            prepared, _ = self._mem[sid]
            self._mem[sid] = (prepared, time.monotonic())
            return prepared
        d = self._path(sid)
        if not d.is_dir() or not (d / "meta.json").exists():
            return None
        meta = json.loads((d / "meta.json").read_text())
        original = np.load(d / "original_full.npy")
        depth = np.load(d / "depth.npy")
        normals = np.load(d / "normals.npy")
        mask = np.load(d / "mask.npy") if (d / "mask.npy").exists() else None
        prepared = PreparedImage(
            original=original, depth=depth, normals=normals, mask=mask,
            width=meta["width"], height=meta["height"], metadata=meta["metadata"],
        )
        self._mem[sid] = (prepared, time.monotonic())
        return prepared

    def delete(self, sid: str) -> None:
        self._mem.pop(sid, None)
        self._locks.pop(sid, None)
        d = self._path(sid)
        if d.exists():
            shutil.rmtree(d, ignore_errors=True)

    def evict_expired(self) -> int:
        now = time.monotonic()
        expired = [sid for sid, (_, t) in self._mem.items() if now - t > self.ttl]
        for sid in expired:
            self.delete(sid)
        return len(expired)
