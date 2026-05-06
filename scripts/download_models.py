"""Pre-warm the model caches. Run once after install (~600 MB total)."""
from __future__ import annotations


def main() -> None:
    print("Pre-warming Depth Anything V3 (DA3-BASE) ...")
    from relighting_engine.depth.depth_anything import DepthAnythingBackend
    DepthAnythingBackend(device="cuda")._load()
    print("DA3-BASE: cached.")

    print("Pre-warming RMBG-2.0 ...")
    from relighting_engine.segmentation.rmbg import RMBGBackend
    RMBGBackend(device="cuda")._load()
    print("RMBG-2.0: cached.")
    print("\nDone. Models will be reused from HF cache on subsequent runs.")


if __name__ == "__main__":
    main()
