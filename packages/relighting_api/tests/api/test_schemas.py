"""Schema round-trip tests — Pydantic mirrors of engine dataclasses."""
from __future__ import annotations

import pytest

from relighting_api.schemas import GoboModel, LightModel, PolishRequest, RenderRequest


def test_light_model_validates_known_good() -> None:
    m = LightModel(
        type="spotlight",
        position=[0.5, 0.4, -0.3],
        direction=[0.0, -0.2, 1.0],
        color=[1.0, 0.85, 0.6],
        intensity=1.5,
        cone_angle=0.5,
        gobo=GoboModel(texture_id="preset:window-blinds", scale=1.2),
    )
    e = m.to_engine()
    assert e.type == "spotlight"
    assert e.gobo.texture_id == "preset:window-blinds"


def test_light_model_rejects_unknown_type() -> None:
    with pytest.raises(Exception):
        LightModel(type="laser", direction=[0.0, 0.0, 1.0])


def test_light_model_rejects_negative_intensity() -> None:
    with pytest.raises(Exception):
        LightModel(type="directional", direction=[0.0, -1.0, 0.0], intensity=-0.5)


def test_render_request_rejects_jpeg_with_16bit() -> None:
    with pytest.raises(Exception):
        RenderRequest(
            session_id="s",
            lights=[],
            ambient=0.2,
            output_format="jpeg",
            output_bit_depth=16,
        )


def test_render_request_rejects_png_with_32bit() -> None:
    with pytest.raises(Exception):
        RenderRequest(
            session_id="s", lights=[], ambient=0.2,
            output_format="png", output_bit_depth=32,
        )


def test_render_request_allows_tiff_32bit() -> None:
    r = RenderRequest(
        session_id="s", lights=[], ambient=0.2,
        output_format="tiff", output_bit_depth=32,
    )
    assert r.output_format == "tiff"


def test_polish_request_minimal_construction() -> None:
    req = PolishRequest(session_id="abc", lights=[])
    assert req.session_id == "abc"
    assert req.prompt == ""
    assert req.seed is None
    assert req.ambient == 0.2
    assert req.shadow_style == "off"
    assert req.output_format == "png"
    assert req.output_bit_depth == 8


def test_polish_request_accepts_prompt_and_seed() -> None:
    req = PolishRequest(
        session_id="abc", lights=[], prompt="warm sunset", seed=42,
    )
    assert req.prompt == "warm sunset"
    assert req.seed == 42


def test_polish_request_validates_format_bitdepth() -> None:
    with pytest.raises(Exception):
        PolishRequest(session_id="abc", lights=[],
                      output_format="jpeg", output_bit_depth=16)
