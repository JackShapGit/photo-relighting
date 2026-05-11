"""Capability detection for IC-Light polish.

is_available() runs three independent checks and is monkeypatch-friendly:
the helper functions are module-level so tests can override them.
"""
from __future__ import annotations

# Minimum free VRAM to consider polish usable. IC-Light + SD1.5 peaks around
# 6 GB; we leave headroom so an in-flight depth/SAM2 inference can coexist.
MIN_FREE_VRAM_BYTES = 8 * 1024**3


def _diffusers_importable() -> bool:
    try:
        import diffusers  # noqa: F401
    except ImportError:
        return False
    return True


def _cuda_available() -> bool:
    try:
        import torch
    except ImportError:
        return False
    return bool(torch.cuda.is_available())


def _free_vram_bytes() -> int:
    try:
        import torch
        free, _total = torch.cuda.mem_get_info()
        return int(free)
    except Exception:  # noqa: BLE001 — defensive, any failure means "unknown"
        return 0


def is_available() -> bool:
    if not _diffusers_importable():
        return False
    if not _cuda_available():
        return False
    if _free_vram_bytes() < MIN_FREE_VRAM_BYTES:
        return False
    return True
