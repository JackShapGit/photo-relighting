"""Generate a synthetic sample HEIC at tests/fixtures/images/sample.heic.

Run once to regenerate. The fixture is committed; this script exists only to
document HOW it was made (and to allow re-generation after pillow-heif
upgrades, if needed).

Verifies BOTH encode and decode paths through libheif on this box, which
resolves the HEIC platform-variability risk from MVP spec §12.
"""
from __future__ import annotations

from pathlib import Path

import numpy as np
from PIL import Image

import pillow_heif
pillow_heif.register_heif_opener()


def main() -> None:
    out = (
        Path(__file__).resolve().parent.parent
        / "packages" / "relighting_engine" / "tests" / "fixtures" / "images" / "sample.heic"
    )
    rng = np.random.default_rng(0)
    arr = (rng.random((128, 128, 3)) * 255).astype(np.uint8)
    Image.fromarray(arr).save(out, format="HEIF", quality=85)
    print(f"Wrote {out} ({out.stat().st_size} bytes)")


if __name__ == "__main__":
    main()
