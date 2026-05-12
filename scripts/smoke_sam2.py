"""One-shot smoke test for the SAM2Backend.

Loads the fixture portrait, runs auto-segmentation, prints stats, and writes
the mask as a grayscale PNG next to this script.
"""
from __future__ import annotations

from pathlib import Path

import numpy as np
from PIL import Image

import relighting_engine as _re
_PKG = str(Path(__file__).resolve().parent.parent / "packages" / "relighting_engine")
if _PKG not in _re.__path__:
    _re.__path__.append(_PKG)

from relighting_engine.core.io import read_image
from relighting_engine.segmentation.sam2 import SAM2Backend


ROOT = Path(__file__).resolve().parent.parent


def main() -> int:
    fixture = ROOT / "packages" / "relighting_engine" / "tests" / "fixtures" / "images" / "portrait_a.jpg"
    img, _ = read_image(fixture)
    print(f"image: {img.shape} {img.dtype}")

    s = SAM2Backend(device="cuda")
    print("loading SAM2 (~200 MB on first run)…")

    # Diagnostic — what does the processor actually return?
    s._load()
    from PIL import Image as PILImage
    img_u8 = (img * 255.0).clip(0, 255).astype(np.uint8)
    pil = PILImage.fromarray(img_u8)
    mask = s.infer(img)
    print(
        f"mask: shape={mask.shape} dtype={mask.dtype} "
        f"min={mask.min():.3f} max={mask.max():.3f} mean={mask.mean():.3f}"
    )

    out = ROOT / "scripts" / "sam2_smoke_mask.png"
    Image.fromarray((mask * 255).clip(0, 255).astype(np.uint8)).save(out)
    print(f"wrote {out.relative_to(ROOT)}")
    return 0
    print(
        f"mask: shape={mask.shape} dtype={mask.dtype} "
        f"min={mask.min():.3f} max={mask.max():.3f} mean={mask.mean():.3f}"
    )

    out = ROOT / "scripts" / "sam2_smoke_mask.png"
    Image.fromarray((mask * 255).clip(0, 255).astype(np.uint8)).save(out)
    print(f"wrote {out.relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
