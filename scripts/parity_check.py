"""Compare WebGL screenshot to Python golden.

Run:
    python scripts/parity_check.py test-results/webgl.png \
        packages/relighting_engine/tests/fixtures/expected/portrait_a__single_directional.png
Exits 0 if within tolerance; 1 otherwise.

Color-space notes
-----------------
The WebGL canvas writes *linear* float values to fragColor (values already in
[0, 1] linear-light space).  canvas.toDataURL('image/png') stores those values
as-is as uint8 — it does NOT apply sRGB gamma encoding.  The resulting PNG
therefore contains linear values stored in a nominally-sRGB container.

The Python golden is produced by write_image(..., bit_depth=8) which correctly
gamma-encodes linear → sRGB before saving.

To compare in a common linear space:
  - WebGL PNG:  read raw uint8, divide by 255  (already linear, no gamma step)
  - Golden PNG: use read_image() which gamma-decodes sRGB → linear as normal
"""
from __future__ import annotations

import sys
from pathlib import Path

import numpy as np
from PIL import Image

from relighting_engine.core.io import read_image


def main() -> int:
    if len(sys.argv) != 3:
        print(__doc__)
        return 2
    web = Path(sys.argv[1])
    golden = Path(sys.argv[2])

    # WebGL PNG contains linear values stored as uint8 (no gamma encoding).
    # Dividing by 255 gives the original linear [0, 1] floats directly.
    a = np.array(Image.open(web).convert("RGB")).astype(np.float32) / 255.0

    # Golden PNG is properly gamma-encoded sRGB; read_image decodes to linear.
    b, _ = read_image(golden)

    if a.shape != b.shape:
        import cv2
        b = cv2.resize(b, (a.shape[1], a.shape[0]), interpolation=cv2.INTER_LINEAR)

    diff = np.abs(a - b)
    per_channel_8 = (diff * 255).max(axis=-1)
    bad = float((per_channel_8 > 2.0).mean())

    print(f"max channel diff: {diff.max() * 255:.2f}/255")
    print(f"pct pixels >2/255: {bad * 100:.3f}%")

    if bad > 0.01:
        print("FAIL: parity diff exceeds 1% of pixels")
        return 1
    print("PASS")
    return 0


if __name__ == "__main__":
    sys.exit(main())
