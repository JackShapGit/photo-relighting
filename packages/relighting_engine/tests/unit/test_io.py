"""Unit tests for the IO module. CPU-only, no models, no GPU."""
from __future__ import annotations

from pathlib import Path

import numpy as np
import pytest
from PIL import Image

from relighting_engine.core.io import (
    ImageMetadata,
    read_image,
    write_image,
)

FIXTURES = Path(__file__).parent.parent / "fixtures" / "images"


def _make_test_jpeg(tmp_path: Path) -> Path:
    arr = (np.random.default_rng(0).random((64, 96, 3)) * 255).astype(np.uint8)
    p = tmp_path / "in.jpg"
    Image.fromarray(arr).save(p, quality=95)
    return p


def test_read_jpeg_returns_linear_float32(tmp_path: Path) -> None:
    p = _make_test_jpeg(tmp_path)
    img, meta = read_image(p)
    assert img.dtype == np.float32
    assert img.ndim == 3 and img.shape[2] == 3
    assert 0.0 <= img.min() and img.max() <= 1.0
    assert meta.original_format == "JPEG"
    assert meta.original_bit_depth == 8
    assert meta.icc_profile_present in (True, False)
    assert meta.alpha_discarded is False


def test_read_jpeg_is_gamma_decoded(tmp_path: Path) -> None:
    """sRGB 50% gray (128/255 = 0.5020) should decode to ~0.2159 linear via the proper
    sRGB transfer function — NOT (x/255)**2.2 (~0.218) or (x/255)**2.4 (~0.196)."""
    arr = np.full((4, 4, 3), 128, dtype=np.uint8)
    p = tmp_path / "gray.jpg"
    Image.fromarray(arr).save(p, quality=100)
    img, _ = read_image(p)
    # Tolerance 0.005 distinguishes the proper IEC 61966-2-1 transfer (~0.2159)
    # from common gamma 2.2/2.4 approximations.
    assert abs(img.mean() - 0.2159) < 0.005, f"expected ~0.2159, got {img.mean()}"


def test_read_png_8bit(tmp_path: Path) -> None:
    arr = np.full((8, 8, 3), 64, dtype=np.uint8)
    p = tmp_path / "x.png"
    Image.fromarray(arr).save(p)
    img, meta = read_image(p)
    assert img.dtype == np.float32
    assert meta.original_bit_depth == 8
    assert meta.original_format == "PNG"


def test_read_png_16bit(tmp_path: Path) -> None:
    arr = np.full((8, 8, 3), 32768, dtype=np.uint16)
    p = tmp_path / "x.png"
    # Pillow cannot write 16-bit RGB PNG; use cv2 (which writes BGR, but all
    # channels identical here so the result is the same either way).
    import cv2
    cv2.imwrite(str(p), arr)
    img, meta = read_image(p)
    assert meta.original_bit_depth == 16
    # 32768/65535 = 0.50001 sRGB → 0.21405 linear. PNG is bit-exact (no quantization),
    # so the tolerance can be much tighter than the JPEG case.
    assert abs(img.mean() - 0.2140) < 1e-3


def test_read_tiff_32float(tmp_path: Path) -> None:
    arr = np.full((4, 4, 3), 0.3, dtype=np.float32)
    p = tmp_path / "x.tiff"
    import imageio.v3 as iio
    iio.imwrite(p, arr)
    img, meta = read_image(p)
    assert meta.original_bit_depth == 32
    assert meta.original_format == "TIFF"
    # 32-bit float TIFF is treated as linear, not gamma-encoded.
    assert abs(img.mean() - 0.3) < 1e-3


def test_alpha_is_discarded_with_metadata_flag(tmp_path: Path) -> None:
    arr = np.full((4, 4, 4), 200, dtype=np.uint8)
    p = tmp_path / "rgba.png"
    Image.fromarray(arr, mode="RGBA").save(p)
    img, meta = read_image(p)
    assert img.shape == (4, 4, 3)
    assert meta.alpha_discarded is True


def test_write_png_8bit_roundtrip(tmp_path: Path) -> None:
    src = np.full((8, 8, 3), 0.5, dtype=np.float32)  # mid-gray linear
    p = tmp_path / "out.png"
    write_image(p, src, format="png", bit_depth=8)
    back, meta = read_image(p)
    assert meta.original_bit_depth == 8
    # 8-bit PNG is gamma-encoded sRGB, so linear 0.5 → sRGB 0.7354 → 8-bit 188 → linear ~0.5.
    assert abs(back.mean() - 0.5) < 0.01


def test_write_tiff_32float_roundtrip(tmp_path: Path) -> None:
    src = np.array([[[0.1, 0.2, 0.3], [0.4, 0.5, 0.6]]], dtype=np.float32)
    p = tmp_path / "out.tiff"
    write_image(p, src, format="tiff", bit_depth=32)
    back, _ = read_image(p)
    np.testing.assert_allclose(back, src, atol=1e-6)


def test_invalid_format_bitdepth_combos_raise(tmp_path: Path) -> None:
    src = np.zeros((4, 4, 3), dtype=np.float32)
    with pytest.raises(ValueError):
        write_image(tmp_path / "x.jpg", src, format="jpeg", bit_depth=16)
    with pytest.raises(ValueError):
        write_image(tmp_path / "x.png", src, format="png", bit_depth=32)


def test_read_heic_if_sample_present() -> None:
    """HEIC support depends on libheif being bundled in the wheel.
    pillow-heif ships pre-built wheels for Windows x86_64 with libheif inside.
    Drop a sample.heic into tests/fixtures/images/ to exercise this path."""
    sample = FIXTURES / "sample.heic"
    if not sample.exists():
        pytest.skip("No HEIC sample present (drop sample.heic in fixtures to enable)")
    img, meta = read_image(sample)
    assert img.dtype == np.float32
    assert img.ndim == 3 and img.shape[2] == 3
    assert meta.original_format in ("HEIF", "HEIC")
