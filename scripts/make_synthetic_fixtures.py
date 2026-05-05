"""Generate 3 deterministic synthetic test fixtures.

These are not real photographs — they're synthetic scenes designed to exercise
the engine deterministically: a centered figure (segmentation lock-on), a
horizon gradient (depth variation), and overlapping rectangles (mask + depth
steps). Real photos can be added later under the same FIXTURES names; this
script is committed for reproducibility.
"""
from __future__ import annotations

from pathlib import Path

import numpy as np
from PIL import Image

OUT = (
    Path(__file__).resolve().parent.parent
    / "packages" / "relighting_engine" / "tests" / "fixtures" / "images"
)
H, W = 384, 512  # modest size — keeps make_goldens fast


def _save_jpeg(name: str, arr: np.ndarray) -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    u = (np.clip(arr, 0.0, 1.0) * 255 + 0.5).astype(np.uint8)
    Image.fromarray(u).save(OUT / name, format="JPEG", quality=95)


def portrait_a() -> np.ndarray:
    """Central bright disc on dark background — segmentation should lock onto it."""
    bg = np.full((H, W, 3), 0.05, dtype=np.float32)
    Y, X = np.mgrid[:H, :W].astype(np.float32)
    cy, cx = H / 2, W / 2
    r = np.sqrt((Y - cy) ** 2 + (X - cx) ** 2)
    disc = r < min(H, W) * 0.3
    inner = r < min(H, W) * 0.18
    bg[disc] = (0.65, 0.55, 0.5)
    bg[inner] = (0.85, 0.7, 0.6)
    # Subtle border glow so depth has something to grab onto.
    glow_zone = (r > min(H, W) * 0.3) & (r < min(H, W) * 0.42)
    bg[glow_zone] = bg[glow_zone] * 0.4 + np.array([0.2, 0.18, 0.15], dtype=np.float32) * 0.6
    return bg


def landscape_a() -> np.ndarray:
    """Horizontal gradient with a horizon band — depth gradient signal."""
    img = np.zeros((H, W, 3), dtype=np.float32)
    # Y_col: (H,) normalised row index
    Y_col = np.arange(H, dtype=np.float32) / H
    sky = np.array([0.55, 0.65, 0.85], dtype=np.float32)
    ground = np.array([0.3, 0.25, 0.18], dtype=np.float32)
    horizon = 0.55
    img[:] = ground
    for row in range(H):
        y = Y_col[row]
        if y < horizon:
            img[row, :] = sky * (1.0 - y / horizon * 0.4)
    # Texture noise to give depth model something more than a flat gradient.
    rng = np.random.default_rng(0)
    img += rng.standard_normal((H, W, 3)).astype(np.float32) * 0.02
    return img


def still_life_a() -> np.ndarray:
    """Overlapping rectangles at varying brightness — mask + depth-step interactions."""
    img = np.full((H, W, 3), 0.1, dtype=np.float32)
    rects = [
        # (y0, y1, x0, x1, color)
        (60, 280, 80, 260, (0.7, 0.5, 0.4)),
        (140, 340, 200, 380, (0.55, 0.6, 0.3)),
        (200, 360, 300, 460, (0.4, 0.45, 0.6)),
    ]
    for y0, y1, x0, x1, col in rects:
        img[y0:y1, x0:x1] = col
    # Slight noise so JPEG roundtrip doesn't lose perfectly flat blocks.
    rng = np.random.default_rng(1)
    img += rng.standard_normal((H, W, 3)).astype(np.float32) * 0.015
    return img


def main() -> None:
    _save_jpeg("portrait_a.jpg", portrait_a())
    _save_jpeg("landscape_a.jpg", landscape_a())
    _save_jpeg("still_life_a.jpg", still_life_a())
    print(f"Wrote 3 synthetic fixtures to {OUT}")


if __name__ == "__main__":
    main()
