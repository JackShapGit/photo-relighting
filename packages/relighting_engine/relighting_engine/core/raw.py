"""Camera raw decoding (DNG, CR2, CR3, NEF, ARW, RAF, ORF, RW2, ...) via LibRaw.

Dispatch contract
-----------------
Callers must try raw decoding BEFORE handing bytes to Pillow. Pillow opens a
DNG as a plain ``TIFF`` -- frequently resolving to the small embedded preview
rather than the real frame -- so a Pillow-first order silently relights a
thumbnail and reports success. LibRaw, by contrast, rejects every ordinary
image format with ``LibRawFileUnsupportedError`` (verified for TIFF/JPEG/PNG/
WEBP in ``tests/unit/test_raw.py``), so a raw-first order cannot hijack a
normal upload.

Colour contract
---------------
``decode_raw_linear`` returns **linear-light** float32. Raw sensor data is
natively linear, so it is decoded with ``gamma=(1, 1)`` and no sRGB transfer
curve is applied. Callers must NOT run it through ``_srgb_to_linear``; doing so
would apply an inverse curve that was never applied in the first place.

LibRaw's automatic brightness IS enabled (``no_auto_bright=False``, its
default). Disabling it is more faithful to sensor exposure but lands typical
frames far below mid-grey -- measured sRGB means of 0.15-0.35 across sample
DNG/CR3/ARW files. The depth and background-removal models are trained on
normally-exposed photographs, so those dark inputs degrade the mask and depth
before any relighting happens. Auto-brightness centres the same files near
0.53-0.59 for ~0.5% highlight clipping, which is the standard raw-converter
tradeoff and the better input for this pipeline.
"""
from __future__ import annotations

import io

import numpy as np

from relighting_engine.core.io import _linear_to_srgb


class NotRawError(Exception):
    """The supplied bytes are not a camera raw file LibRaw can decode."""


def decode_raw_linear(data: bytes) -> np.ndarray:
    """Decode camera raw bytes to linear-light float32 RGB in ``[0, 1]``.

    Returns an ``(H, W, 3)`` float32 array in LINEAR light -- not sRGB.
    Raises ``NotRawError`` if the bytes are not a raw file LibRaw understands,
    which is the signal for the caller to fall back to Pillow.
    """
    import rawpy  # imported lazily: LibRaw is only needed on the raw path

    try:
        with rawpy.imread(io.BytesIO(data)) as handle:
            rgb16 = handle.postprocess(
                output_bps=16,
                gamma=(1, 1),
                use_camera_wb=True,
                output_color=rawpy.ColorSpace.sRGB,
            )
    except Exception as exc:  # noqa: BLE001 -- LibRaw raises several distinct types
        raise NotRawError(str(exc)) from exc

    return (rgb16.astype(np.float32) / 65535.0).clip(0.0, 1.0)


def decode_to_srgb_pil(data: bytes):
    """Decode raw bytes to an 8-bit sRGB ``PIL.Image``, or ``None`` if not raw.

    Convenience for consumers that only need a displayable image (thumbnails,
    the SAM2 refine path) and do not care about linear precision.
    """
    from PIL import Image

    try:
        linear = decode_raw_linear(data)
    except NotRawError:
        return None
    srgb8 = (_linear_to_srgb(linear) * 255.0 + 0.5).astype(np.uint8)
    return Image.fromarray(srgb8, mode="RGB")
