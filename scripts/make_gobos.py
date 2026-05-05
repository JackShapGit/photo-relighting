"""Generate 6 grayscale gobo PNGs for the engine. Run once; outputs are committed."""
from __future__ import annotations

from pathlib import Path

import numpy as np
from PIL import Image

OUT = (
    Path(__file__).resolve().parent.parent
    / "packages" / "relighting_engine" / "relighting_engine" / "assets" / "gobos"
)
SIZE = 512


def _save(name: str, arr: np.ndarray) -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    a = np.clip(arr, 0.0, 1.0)
    img = (a * 255 + 0.5).astype(np.uint8)
    Image.fromarray(img, mode="L").save(OUT / f"{name}.png")


def window_blinds() -> np.ndarray:
    y = np.linspace(0, 1, SIZE)
    return np.tile((0.5 + 0.5 * np.cos(y * 18 * np.pi)).astype(np.float32) ** 2, (SIZE, 1)).T


def grid() -> np.ndarray:
    coords = np.linspace(0, 1, SIZE)
    Y, X = np.meshgrid(coords, coords, indexing="ij")
    bars = (np.sin(X * 12 * np.pi) > 0.7) | (np.sin(Y * 12 * np.pi) > 0.7)
    return bars.astype(np.float32) * 0.95 + 0.05


def rays() -> np.ndarray:
    coords = np.linspace(-1, 1, SIZE)
    Y, X = np.meshgrid(coords, coords, indexing="ij")
    theta = np.arctan2(Y, X)
    return ((0.5 + 0.5 * np.cos(theta * 16)) ** 3).astype(np.float32)


def leaves() -> np.ndarray:
    rng = np.random.default_rng(42)
    a = np.zeros((SIZE, SIZE), dtype=np.float32)
    for _ in range(80):
        cx, cy = rng.uniform(0, SIZE, 2)
        rx, ry = rng.uniform(20, 70, 2)
        ang = rng.uniform(0, np.pi)
        ys, xs = np.mgrid[:SIZE, :SIZE]
        u = (xs - cx) * np.cos(ang) + (ys - cy) * np.sin(ang)
        v = -(xs - cx) * np.sin(ang) + (ys - cy) * np.cos(ang)
        m = (u / rx) ** 2 + (v / ry) ** 2 < 1.0
        a[m] = 1.0
    return 1.0 - a  # leaves block light, so they're dark


def clouds() -> np.ndarray:
    rng = np.random.default_rng(7)
    a = np.zeros((SIZE, SIZE), dtype=np.float32)
    for f, amp in [(2, 0.5), (5, 0.25), (12, 0.15), (32, 0.1)]:
        n = rng.standard_normal((f, f)).astype(np.float32)
        from scipy.ndimage import zoom
        a += zoom(n, SIZE / f, order=1) * amp
    a = (a - a.min()) / (a.max() - a.min())
    return a ** 1.5


def dapple() -> np.ndarray:
    rng = np.random.default_rng(11)
    a = np.zeros((SIZE, SIZE), dtype=np.float32)
    for _ in range(800):
        cx, cy = rng.uniform(0, SIZE, 2)
        r = rng.uniform(3, 18)
        ys, xs = np.mgrid[:SIZE, :SIZE]
        d = (xs - cx) ** 2 + (ys - cy) ** 2
        a += np.exp(-d / (2 * r * r)) * rng.uniform(0.4, 1.0)
    return np.clip(a, 0.0, 1.0)


def main() -> None:
    _save("window-blinds", window_blinds())
    _save("grid", grid())
    _save("rays", rays())
    _save("leaves", leaves())
    _save("clouds", clouds())
    _save("dapple", dapple())
    print(f"Wrote 6 gobos to {OUT}")


if __name__ == "__main__":
    main()
