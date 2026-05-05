"""FastAPI dependencies. Engine is a process-level singleton."""
from __future__ import annotations

from functools import lru_cache

from relighting_engine import RelightingEngine


@lru_cache(maxsize=1)
def get_engine() -> RelightingEngine:
    return RelightingEngine(device="cuda")
