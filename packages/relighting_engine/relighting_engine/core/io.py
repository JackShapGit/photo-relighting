"""Image IO for the relighting engine.

Internal working space: float32, linear sRGB, shape (H, W, 3), range [0, 1].
On read: gamma-decode sRGB -> linear. On write: gamma-encode linear -> sRGB.
Alpha is discarded with a metadata flag. ICC profile presence is recorded.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Literal

import cv2
import numpy as np
from PIL import Image

import pillow_heif  # noqa: F401  -- registers HEIC plugin into Pillow
pillow_heif.register_heif_opener()

import imageio.v3 as iio  # noqa: E402

OutputFormat = Literal["png", "jpeg", "tiff"]

# Extensions that cv2 handles better than Pillow for depth-aware reading
_CV2_EXTS = {".png"}
# Extensions where Pillow cannot open float32 data — use imageio directly
_TIFF_EXTS = {".tiff", ".tif"}


@dataclass
class ImageMetadata:
    original_format: str
    original_bit_depth: int
    width: int
    height: int
    icc_profile_present: bool
    alpha_discarded: bool
    extras: dict = field(default_factory=dict)


def _srgb_to_linear(x: np.ndarray) -> np.ndarray:
    """sRGB -> linear, vectorized. Input/output are float32 in [0, 1]."""
    a = 0.055
    lo = x / 12.92
    hi = ((x + a) / (1 + a)) ** 2.4
    return np.where(x <= 0.04045, lo, hi).astype(np.float32)


def _linear_to_srgb(x: np.ndarray) -> np.ndarray:
    """Linear -> sRGB, vectorized. Input/output are float32 in [0, 1]."""
    a = 0.055
    x = np.clip(x, 0.0, 1.0)
    lo = x * 12.92
    hi = (1 + a) * np.power(x, 1 / 2.4) - a
    return np.where(x <= 0.0031308, lo, hi).astype(np.float32)


def _read_tiff(path: Path) -> tuple[np.ndarray, int, bool, bool]:
    """Read a TIFF file via imageio. Returns (array, bit_depth, icc_present, alpha_present)."""
    # Try PIL first for metadata; float32 TIFFs may not be openable by PIL
    icc_present = False
    alpha_present = False
    try:
        img_pil = Image.open(path)
        icc_present = bool(img_pil.info.get("icc_profile"))
        alpha_present = img_pil.mode in ("RGBA", "LA", "PA") or "A" in img_pil.mode
    except Exception:
        pass  # float32 TIFFs are not openable by Pillow — that's fine

    arr = iio.imread(path)
    if arr.ndim == 2:
        arr = np.stack([arr] * 3, axis=-1)
    if arr.ndim == 3 and arr.shape[-1] == 4:
        alpha_present = True
        arr = arr[..., :3]

    if arr.dtype == np.uint8:
        bit_depth = 8
        f = arr.astype(np.float32) / 255.0
    elif arr.dtype == np.uint16:
        bit_depth = 16
        f = arr.astype(np.float32) / 65535.0
    elif arr.dtype in (np.float32, np.float16, np.float64):
        bit_depth = 32
        f = np.clip(arr.astype(np.float32), 0.0, 1.0)
    else:
        raise ValueError(f"Unsupported TIFF dtype {arr.dtype}")

    linear = _srgb_to_linear(f) if bit_depth in (8, 16) else f
    return linear, bit_depth, icc_present, alpha_present


def _read_png(path: Path) -> tuple[np.ndarray, int, bool, bool]:
    """Read a PNG file, preserving 16-bit depth via cv2. Returns (linear_array, bit_depth, icc_present, alpha_present)."""
    # Use PIL for metadata (ICC, alpha mode detection)
    img_pil = Image.open(path)
    icc_present = bool(img_pil.info.get("icc_profile"))
    mode = img_pil.mode
    alpha_present = mode in ("RGBA", "LA", "PA") or "A" in mode

    # Use cv2 IMREAD_UNCHANGED to correctly detect 8 vs 16-bit depth
    # cv2 reads as BGR(A) — convert to RGB(A)
    arr_cv2 = cv2.imread(str(path), cv2.IMREAD_UNCHANGED)
    if arr_cv2 is None:
        raise ValueError(f"cv2 could not read PNG: {path}")

    # Handle grayscale (2D) and alpha channel
    if arr_cv2.ndim == 2:
        arr_cv2 = np.stack([arr_cv2] * 3, axis=-1)
    elif arr_cv2.shape[-1] == 4:
        alpha_present = True
        arr_cv2 = cv2.cvtColor(arr_cv2, cv2.COLOR_BGRA2RGB)
    elif arr_cv2.shape[-1] == 3:
        arr_cv2 = cv2.cvtColor(arr_cv2, cv2.COLOR_BGR2RGB)

    if arr_cv2.dtype == np.uint8:
        bit_depth = 8
        f = arr_cv2.astype(np.float32) / 255.0
    elif arr_cv2.dtype == np.uint16:
        bit_depth = 16
        f = arr_cv2.astype(np.float32) / 65535.0
    else:
        raise ValueError(f"Unsupported PNG dtype {arr_cv2.dtype}")

    linear = _srgb_to_linear(f)
    return linear, bit_depth, icc_present, alpha_present


def read_image(path: str | Path) -> tuple[np.ndarray, ImageMetadata]:
    """Load an image. Returns (HxWx3 float32 linear-sRGB, metadata).

    Supported: JPEG/PNG/TIFF/HEIC. Bit depths: 8/16 (PNG, TIFF), 32-float (TIFF).
    Alpha is discarded; the metadata flag records whether it was present.
    """
    path = Path(path)
    suffix = path.suffix.lower()

    if suffix in _TIFF_EXTS:
        fmt = "TIFF"
        linear, bit_depth, icc_present, alpha_present = _read_tiff(path)
    elif suffix in _CV2_EXTS:
        fmt = "PNG"
        linear, bit_depth, icc_present, alpha_present = _read_png(path)
    else:
        # JPEG, HEIC, and other Pillow-supported formats
        img = Image.open(path)
        fmt = (img.format or suffix.lstrip(".")).upper()
        icc_present = bool(img.info.get("icc_profile"))
        mode = img.mode
        alpha_present = mode in ("RGBA", "LA", "PA") or "A" in mode

        if mode != "RGB":
            img = img.convert("RGB")
        arr = np.asarray(img)
        if arr.dtype == np.uint16:
            bit_depth = 16
            f = arr.astype(np.float32) / 65535.0
        else:
            bit_depth = 8
            f = arr.astype(np.float32) / 255.0
        linear = _srgb_to_linear(f)

    h, w = linear.shape[:2]
    meta = ImageMetadata(
        original_format=fmt,
        original_bit_depth=bit_depth,
        width=w,
        height=h,
        icc_profile_present=icc_present,
        alpha_discarded=alpha_present,
    )
    return linear, meta


def write_image(
    path: str | Path,
    image: np.ndarray,
    *,
    format: OutputFormat,
    bit_depth: Literal[8, 16, 32],
) -> None:
    """Write a linear-sRGB float32 image to disk in the requested format/depth."""
    if image.dtype != np.float32:
        raise ValueError("write_image expects float32 linear input")
    if image.ndim != 3 or image.shape[2] != 3:
        raise ValueError("write_image expects HxWx3")
    if format == "jpeg" and bit_depth != 8:
        raise ValueError("JPEG supports 8-bit only")
    if format == "png" and bit_depth not in (8, 16):
        raise ValueError("PNG supports 8 or 16 bit")
    if format == "tiff" and bit_depth not in (8, 16, 32):
        raise ValueError("TIFF supports 8, 16, or 32-bit float")

    path = Path(path)

    if bit_depth == 32:
        # Float TIFF -- keep linear; do NOT gamma-encode.
        iio.imwrite(path, np.clip(image, 0.0, 1.0).astype(np.float32))
        return

    srgb = _linear_to_srgb(image)
    if bit_depth == 8:
        u = np.clip(srgb * 255.0 + 0.5, 0, 255).astype(np.uint8)
    else:  # 16
        u = np.clip(srgb * 65535.0 + 0.5, 0, 65535).astype(np.uint16)

    if format == "jpeg":
        Image.fromarray(u).save(path, format="JPEG", quality=95)
    elif format == "png":
        if bit_depth == 16:
            # Pillow cannot write 16-bit RGB PNG; use cv2 (BGR->RGB conversion needed)
            u_bgr = cv2.cvtColor(u, cv2.COLOR_RGB2BGR)
            cv2.imwrite(str(path), u_bgr)
        else:
            Image.fromarray(u).save(path, format="PNG")
    elif format == "tiff":
        iio.imwrite(path, u)
