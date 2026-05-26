"""Layered PSD export for relighting results.

Each light's contribution is stored as a separate layer so users can
toggle, blend, or grade individual lights in Photoshop.

Working space: float32 linear-sRGB.  Layers are gamma-encoded to sRGB and
quantised to 16-bit unsigned before being written into the PSD.

Blend modes:
- "Ambient" layer  →  Normal  (bottom layer, full image)
- All other layers →  Linear Dodge (Add)  (additive light contribution)
"""
from __future__ import annotations

import io
from typing import Dict, List, Optional

import numpy as np

try:
    import pytoshop
    import pytoshop.enums as _E
    import pytoshop.image_data as _ID
    import pytoshop.layers as _L
except ImportError as exc:  # pragma: no cover
    raise ImportError(
        "pytoshop is required for PSD export.  "
        "Install it with: pip install 'relighting-engine[layers]'"
    ) from exc

from relighting_engine.core.io import _linear_to_srgb  # noqa: PLC2701


def _float_to_uint16(arr: np.ndarray) -> np.ndarray:
    """Convert float32 linear-sRGB (H, W, 3) to uint16 sRGB (H, W, 3)."""
    srgb = _linear_to_srgb(arr)  # still float32 in [0, 1]
    return (np.clip(srgb, 0.0, 1.0) * 65535.0 + 0.5).astype(np.uint16)


def _make_layer_record(
    name: str,
    arr16: np.ndarray,
    blend_mode: _E.BlendMode,
    h: int,
    w: int,
) -> _L.LayerRecord:
    """Build a pytoshop LayerRecord from a uint16 (H, W, 3) array."""
    alpha16 = np.full((h, w), 65535, dtype=np.uint16)

    lr = _L.LayerRecord(
        top=0,
        left=0,
        bottom=h,
        right=w,
        blend_mode=blend_mode,
        opacity=255,
        name=name,
        color_mode=_E.ColorMode.rgb,
    )
    lr.set_channel(
        _E.ColorChannel.red,
        _L.ChannelImageData(image=arr16[..., 0].copy(), compression=_E.Compression.raw),
    )
    lr.set_channel(
        _E.ColorChannel.green,
        _L.ChannelImageData(image=arr16[..., 1].copy(), compression=_E.Compression.raw),
    )
    lr.set_channel(
        _E.ColorChannel.blue,
        _L.ChannelImageData(image=arr16[..., 2].copy(), compression=_E.Compression.raw),
    )
    lr.set_channel(
        _E.ColorChannel.transparency,
        _L.ChannelImageData(image=alpha16, compression=_E.Compression.raw),
    )
    return lr


def assemble_psd(
    layers: Dict[str, np.ndarray],
    icc_profile: Optional[bytes] = None,
) -> bytes:
    """Assemble a 16-bit layered PSD from float32 linear-sRGB layer arrays.

    Parameters
    ----------
    layers:
        Ordered mapping of ``{name: float32_array}`` where each array has
        shape ``(H, W, 3)`` in linear sRGB.  The layer named ``"Ambient"``
        (case-sensitive) receives the Normal blend mode; all others receive
        Linear Dodge (Add).
    icc_profile:
        Optional raw ICC profile bytes to embed in the PSD image resources.

    Returns
    -------
    bytes
        Raw PSD file contents ready to write to disk.
    """
    if not layers:
        raise ValueError("layers must contain at least one entry")

    names = list(layers.keys())
    arrays = list(layers.values())

    h, w = arrays[0].shape[:2]

    psd = pytoshop.PsdFile(num_channels=3, height=h, width=w)
    psd.depth = 16

    # Optionally embed ICC profile (resource ID 1039 = 0x040F)
    if icc_profile is not None:
        import pytoshop.image_resources as _IR  # noqa: PLC0415  (lazy import)
        icc_res = _IR.GenericImageResourceBlock(
            name="", resource_id=1039, data=icc_profile,
        )
        psd.image_resources._blocks.append(icc_res)

    # Accumulator for composite (sum, then clamp)
    composite_f = np.zeros((h, w, 3), dtype=np.float32)

    for name, arr in zip(names, arrays):
        blend_mode = (
            _E.BlendMode.normal
            if name == "Ambient"
            else _E.BlendMode.linear_dodge
        )
        arr16 = _float_to_uint16(arr)
        lr = _make_layer_record(name, arr16, blend_mode, h, w)
        psd.layer_and_mask_info.layer_info.layer_records.append(lr)
        composite_f += arr  # accumulate in linear space

    # Build composite: encode accumulated linear → sRGB → uint16
    composite16 = _float_to_uint16(composite_f)
    comp_arr = np.transpose(composite16, (2, 0, 1))  # (3, H, W)
    psd.image_data = _ID.ImageData(channels=comp_arr, compression=_E.Compression.raw)

    buf = io.BytesIO()
    psd.write(buf)
    return buf.getvalue()


def deduplicate_names(names: List[str]) -> List[str]:
    """Append numeric suffix to duplicate names.

    The first occurrence keeps the bare name.  Subsequent duplicates
    receive a ``" (N)"`` suffix where N starts at 2.

    Parameters
    ----------
    names:
        Input list of layer names (may contain duplicates).

    Returns
    -------
    list[str]
        New list with unique names.

    Examples
    --------
    >>> deduplicate_names(["Spot Light", "Spot Light", "Fill"])
    ['Spot Light', 'Spot Light (2)', 'Fill']
    """
    seen: dict[str, int] = {}
    result: list[str] = []
    for name in names:
        count = seen.get(name, 0) + 1
        seen[name] = count
        if count == 1:
            result.append(name)
        else:
            result.append(f"{name} ({count})")
    return result
