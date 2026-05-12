"""Pre-render fixture-library preset thumbnails for the + Add Light picker.

Run once after editing web/src/presets.js. Output: web/preset-thumbs/{id}.jpg

Each thumbnail renders the fixture portrait under a single light using that
preset's defaults, so the user gets an at-a-glance "this is what this fixture
looks like" preview in the picker grid.

Note: the preset definitions below are duplicated from web/src/presets.js.
Keep them in sync. (Future: hoist to a shared JSON.)
"""
from __future__ import annotations

import sys
from pathlib import Path

import numpy as np
from PIL import Image

import relighting_engine as _re
_PKG_ROOT = str(Path(__file__).resolve().parent.parent / "packages" / "relighting_engine")
if _PKG_ROOT not in _re.__path__:
    _re.__path__.append(_PKG_ROOT)

from relighting_engine import RelightingEngine
from relighting_engine.core.io import read_image, _linear_to_srgb
from relighting_engine.lighting.models import Light

ROOT = Path(__file__).resolve().parent.parent
FIXTURE = ROOT / "packages" / "relighting_engine" / "tests" / "fixtures" / "images" / "portrait_a.jpg"
OUTDIR = ROOT / "web" / "preset-thumbs"
THUMB_SIDE = 240


PRESETS: list[dict] = [
    {"id": "sun",      "type": "directional", "position": (0.5, 0.5, 1.0),  "direction": (-0.4, 0.5, -0.8), "kelvin": 5500, "intensity": 1.5, "falloff": 0.0, "cone_angle": 0.5, "softness": 0.10},
    {"id": "skylight", "type": "directional", "position": (0.5, 0.5, 1.0),  "direction": (0.0, -1.0, -0.3), "kelvin": 7500, "intensity": 0.4, "falloff": 0.0, "cone_angle": 0.5, "softness": 0.10},
    {"id": "softbox",  "type": "directional", "position": (0.5, 0.5, 1.0),  "direction": (0.5,  0.2, -1.0), "kelvin": 5300, "intensity": 0.8, "falloff": 0.0, "cone_angle": 0.5, "softness": 0.10},
    {"id": "tungsten", "type": "spotlight",   "position": (0.85, 0.35, 1.0),"direction": (-0.3, 0.2, -1.0), "kelvin": 3200, "intensity": 0.9, "falloff": 1.0, "cone_angle": 0.45, "softness": 0.10},
    {"id": "fresnel",  "type": "spotlight",   "position": (0.20, 0.30, 1.2),"direction": (0.3,  0.2, -1.0), "kelvin": 5500, "intensity": 1.1, "falloff": 1.0, "cone_angle": 0.50, "softness": 0.08},
    {"id": "cone",     "type": "spotlight",   "position": (0.50, 0.20, 1.0),"direction": (0.0,  0.3, -1.0), "kelvin": 5500, "intensity": 1.0, "falloff": 1.0, "cone_angle": 0.50, "softness": 0.15},
    {"id": "strobe",   "type": "spotlight",   "position": (0.85, 0.50, 0.8),"direction": (-0.3, 0.0, -1.0), "kelvin": 5500, "intensity": 1.6, "falloff": 1.0, "cone_angle": 0.30, "softness": 0.05},
    {"id": "rim",      "type": "spotlight",   "position": (0.50, 0.50, 0.4),"direction": (0.0, -0.2, -1.0), "kelvin": 6500, "intensity": 1.2, "falloff": 0.8, "cone_angle": 0.40, "softness": 0.10},
]


def _to_light(p: dict) -> Light:
    return Light(
        type=p["type"],
        position=p["position"],
        direction=p["direction"],
        color=(1.0, 1.0, 1.0),
        color_temperature=p["kelvin"],
        gel_preset=None,
        intensity=p["intensity"],
        falloff=p["falloff"],
        cone_angle=p["cone_angle"],
        softness=p["softness"],
        gobo=None,
        affects="all",
        enabled=True,
    )


def main() -> int:
    if not FIXTURE.exists():
        print(f"missing fixture: {FIXTURE}", file=sys.stderr)
        return 1
    OUTDIR.mkdir(parents=True, exist_ok=True)

    eng = RelightingEngine(device="cuda")
    img, _ = read_image(FIXTURE)
    prepared = eng.prepare(img, mode="interactive")

    for p in PRESETS:
        light = _to_light(p)
        # Render at native resolution; we'll thumbnail with PIL for nicer
        # downscaling than cv2.INTER_LINEAR.
        out = eng.render(prepared, lights=[light], ambient=0.15)
        srgb = _linear_to_srgb(out)
        u8 = np.clip(srgb * 255 + 0.5, 0, 255).astype(np.uint8)
        pil = Image.fromarray(u8)
        # Center-crop to square, then thumbnail.
        side = min(pil.size)
        x0 = (pil.size[0] - side) // 2
        y0 = (pil.size[1] - side) // 2
        pil = pil.crop((x0, y0, x0 + side, y0 + side))
        pil.thumbnail((THUMB_SIDE, THUMB_SIDE), Image.LANCZOS)
        outp = OUTDIR / f"{p['id']}.jpg"
        pil.save(outp, format="JPEG", quality=85)
        print(f"wrote {outp.relative_to(ROOT)}")

    return 0


if __name__ == "__main__":
    sys.exit(main())
