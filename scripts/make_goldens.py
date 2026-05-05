"""Generate the golden expected/ images. Run once after engine changes settle.

Drop fixture images into packages/relighting_engine/tests/fixtures/images/.
Anything in FIXTURES that is missing on disk is skipped (logged)."""
from __future__ import annotations

from pathlib import Path

# Ensure the tests tree is importable as relighting_engine.tests (it lives
# alongside the installed source package, not inside it in editable layout).
import relighting_engine as _re
_PKG_ROOT = str(Path(__file__).resolve().parent.parent / "packages" / "relighting_engine")
if _PKG_ROOT not in _re.__path__:
    _re.__path__.append(_PKG_ROOT)

from relighting_engine import RelightingEngine
from relighting_engine.core.io import read_image, write_image
from relighting_engine.tests.golden.configs import FIXTURES, configs

ROOT = Path(__file__).resolve().parent.parent / "packages" / "relighting_engine" / "tests" / "fixtures"
SRC = ROOT / "images"
DST = ROOT / "expected"


def main() -> None:
    DST.mkdir(parents=True, exist_ok=True)
    eng = RelightingEngine(device="cuda")
    for fixture in FIXTURES:
        src = SRC / fixture
        if not src.exists():
            print(f"skip (missing): {fixture}")
            continue
        img, _ = read_image(src)
        prepared = eng.prepare(img, mode="interactive")
        for name, lights, ambient in configs():
            out = eng.render(prepared, lights=lights, ambient=ambient)
            outp = DST / f"{Path(fixture).stem}__{name}.png"
            write_image(outp, out, format="png", bit_depth=8)
            print(f"wrote {outp.name}")


if __name__ == "__main__":
    main()
