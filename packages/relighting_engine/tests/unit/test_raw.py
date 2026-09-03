"""Unit tests for camera-raw decoding and, critically, its dispatch safety.

The load-bearing property is that LibRaw must REJECT ordinary image formats.
`prepare_image_bytes` tries raw first (because Pillow silently misreads a DNG
as a TIFF -- often as its tiny embedded thumbnail), so if LibRaw ever accepted
a JPEG or PNG, every normal upload would be routed through the raw decoder.
"""
from __future__ import annotations

import io
import os
from pathlib import Path

import numpy as np
import pytest
from PIL import Image

from relighting_engine.core.raw import (
    NotRawError,
    decode_raw_linear,
    decode_to_srgb_pil,
)

FIXTURE_DIR = Path(__file__).resolve().parent.parent / "fixtures" / "images"


def _real_raw() -> Path | None:
    """A real raw file, from env override or the fixtures dir. None if absent."""
    env = os.environ.get("RELIGHT_TEST_RAW")
    if env and Path(env).is_file():
        return Path(env)
    for ext in ("dng", "cr2", "cr3", "nef", "arw", "raf", "orf", "rw2"):
        hits = sorted(FIXTURE_DIR.glob(f"sample.{ext}"))
        if hits:
            return hits[0]
    return None


def _encode(fmt: str, h: int = 48, w: int = 64) -> bytes:
    arr = (np.random.default_rng(0).random((h, w, 3)) * 255).astype(np.uint8)
    buf = io.BytesIO()
    Image.fromarray(arr).save(buf, format=fmt)
    return buf.getvalue()


@pytest.mark.parametrize("fmt", ["TIFF", "JPEG", "PNG", "WEBP"])
def test_ordinary_formats_are_rejected_as_raw(fmt: str) -> None:
    """LibRaw must not claim ordinary images -- raw is tried FIRST."""
    with pytest.raises(NotRawError):
        decode_raw_linear(_encode(fmt))


def test_garbage_bytes_are_rejected_as_raw() -> None:
    with pytest.raises(NotRawError):
        decode_raw_linear(b"definitely not an image at all")


def test_empty_bytes_are_rejected_as_raw() -> None:
    with pytest.raises(NotRawError):
        decode_raw_linear(b"")


@pytest.mark.parametrize("fmt", ["TIFF", "JPEG", "PNG"])
def test_decode_to_srgb_pil_returns_none_for_ordinary(fmt: str) -> None:
    assert decode_to_srgb_pil(_encode(fmt)) is None


@pytest.mark.skipif(_real_raw() is None, reason="no real raw fixture available")
def test_decode_raw_returns_linear_float32_rgb() -> None:
    arr = decode_raw_linear(_real_raw().read_bytes())
    assert arr.dtype == np.float32
    assert arr.ndim == 3 and arr.shape[2] == 3
    assert 0.0 <= float(arr.min()) and float(arr.max()) <= 1.0


@pytest.mark.skipif(_real_raw() is None, reason="no real raw fixture available")
def test_decoded_raw_is_linear_not_srgb() -> None:
    """Linear data must be darker than the same data sRGB-encoded.

    Guards the double-gamma bug: if decode ever returned sRGB, the caller
    would apply _srgb_to_linear on top and crush the midtones.
    """
    from relighting_engine.core.io import _linear_to_srgb

    arr = decode_raw_linear(_real_raw().read_bytes())
    assert float(arr.mean()) < float(_linear_to_srgb(arr).mean())


@pytest.mark.skipif(_real_raw() is None, reason="no real raw fixture available")
def test_decode_to_srgb_pil_returns_image_for_real_raw() -> None:
    pil = decode_to_srgb_pil(_real_raw().read_bytes())
    assert pil is not None
    assert pil.mode == "RGB"
    assert pil.size[0] > 0 and pil.size[1] > 0
