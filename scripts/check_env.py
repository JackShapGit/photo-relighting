"""Smoke-test the dev environment. Run after Task 1 and any time deps change."""
from __future__ import annotations

import sys


def main() -> int:
    print(f"Python: {sys.version.split()[0]}")
    assert sys.version_info[:2] == (3, 11), "Expected Python 3.11.x"

    import torch
    print(f"torch: {torch.__version__}")
    print(f"CUDA available: {torch.cuda.is_available()}")
    assert torch.cuda.is_available(), "CUDA must be available"
    print(f"CUDA device: {torch.cuda.get_device_name(0)}")
    print(f"CUDA capability: {torch.cuda.get_device_capability(0)}")

    x = torch.randn(8, 8, device="cuda")
    y = (x @ x.T).cpu()
    assert y.shape == (8, 8)

    import PIL, pillow_heif, imageio, transformers, fastapi, pydantic
    print(f"Pillow: {PIL.__version__}")
    print(f"pillow-heif: {pillow_heif.__version__}")
    print(f"imageio: {imageio.__version__}")
    print(f"transformers: {transformers.__version__}")
    print(f"fastapi: {fastapi.__version__}")
    print(f"pydantic: {pydantic.VERSION}")

    import depth_anything_3  # noqa: F401
    print("depth-anything-3 importable: OK")

    print("\nAll environment checks passed.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
