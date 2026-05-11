"""Shared image encoder for /render and /polish.

Encodes a HxWx3 float32 linear-sRGB array into PNG/JPEG/TIFF bytes with an
embedded sRGB ICC profile (8-bit PNG/JPEG only — 16-bit PNG goes through cv2
which doesn't write ICC).
"""
from __future__ import annotations

import io

import numpy as np

from relighting_engine.core.io import _linear_to_srgb

CONTENT_TYPES = {"png": "image/png", "jpeg": "image/jpeg", "tiff": "image/tiff"}


def encode(arr: np.ndarray, buf: io.BytesIO, *, fmt: str, bit_depth: int) -> None:
    from PIL import Image, PngImagePlugin
    import imageio.v3 as iio

    if bit_depth == 32:
        iio.imwrite(buf, np.clip(arr, 0, 1).astype(np.float32), extension=".tiff")
        return
    srgb = _linear_to_srgb(arr)
    if bit_depth == 16:
        u = np.clip(srgb * 65535 + 0.5, 0, 65535).astype(np.uint16)
    else:
        u = np.clip(srgb * 255 + 0.5, 0, 255).astype(np.uint8)
    if fmt == "jpeg":
        Image.fromarray(u).save(buf, format="JPEG", quality=95, icc_profile=srgb_icc())
    elif fmt == "png":
        if bit_depth == 16:
            import cv2
            bgr = cv2.cvtColor(u, cv2.COLOR_RGB2BGR)
            ok, png_bytes = cv2.imencode(".png", bgr)
            if not ok:
                raise RuntimeError("cv2 failed to encode 16-bit PNG")
            buf.write(png_bytes.tobytes())
        else:
            pnginfo = PngImagePlugin.PngInfo()
            pnginfo.add(b"sRGB", b"\x00")
            Image.fromarray(u).save(
                buf, format="PNG", pnginfo=pnginfo, icc_profile=srgb_icc()
            )
    elif fmt == "tiff":
        iio.imwrite(buf, u, extension=".tiff")


def srgb_icc() -> bytes:
    cached = getattr(srgb_icc, "_bytes", None)
    if cached is not None:
        return cached
    from PIL import ImageCms
    profile = ImageCms.createProfile("sRGB")
    data = ImageCms.ImageCmsProfile(profile).tobytes()
    srgb_icc._bytes = data
    return data
