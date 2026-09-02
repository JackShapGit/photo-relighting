"""Pydantic schemas — wire format mirrors of engine dataclasses.

These models 422 on bad input; conversion to engine dataclasses happens via
.to_engine(). Wire field names match engine field names exactly.
"""
from __future__ import annotations

import math
from typing import Annotated, Any, Literal

from pydantic import BaseModel, Field, model_validator

from relighting_engine.lighting.models import Gobo, Light
from relighting_engine.metric.calibration import Calibration

_MARK_KEYS = ("lipL", "lipR", "top", "backL", "backR")
_MARK_RANGE = (-0.5, 1.5)        # marks may sit a little outside the photo, never far
_MIN_LIP_FRACTION = 0.05         # same as web/src/metric/calibration.js MIN_LIP_FRACTION

Finite = Annotated[float, Field(allow_inf_nan=False)]


class DepthFitModel(BaseModel):
    a: Finite
    b: Finite


class CalibrationModel(BaseModel):
    version: int = 1
    units: Literal["ft", "m"] = "ft"
    width_ft: Annotated[float, Field(gt=0.0, allow_inf_nan=False)]
    height_ft: Annotated[float, Field(gt=0.0, allow_inf_nan=False)]
    depth_ft: Annotated[float, Field(gt=0.0, allow_inf_nan=False)]
    marks: dict[str, list[float]]
    depth_fit: DepthFitModel | None = None
    depth_check: dict[str, Any] | None = None

    @model_validator(mode="after")
    def _validate_marks(self) -> "CalibrationModel":
        """Mirror of web/src/metric/calibration.js validateMarks, so a
        degenerate record is a 422 here rather than a ZeroDivisionError in
        solve_camera (500) or NaNs in a render."""
        m = self.marks
        for k in _MARK_KEYS:
            v = m.get(k)
            if not (isinstance(v, list) and len(v) == 2):
                raise ValueError(f"marks.{k} must be [u, v]")
            for c in v:
                if not (isinstance(c, (int, float)) and math.isfinite(c)):
                    raise ValueError(f"marks.{k} must be finite numbers")
                if not (_MARK_RANGE[0] <= c <= _MARK_RANGE[1]):
                    raise ValueError(f"marks.{k} is outside the photo")
        w_lip = abs(m["lipR"][0] - m["lipL"][0])
        w_back = abs(m["backR"][0] - m["backL"][0])
        v_lip = (m["lipL"][1] + m["lipR"][1]) / 2.0
        v_back = (m["backL"][1] + m["backR"][1]) / 2.0
        if w_lip < _MIN_LIP_FRACTION:
            raise ValueError("lip marks are too close together")
        if m["top"][1] >= v_lip:
            raise ValueError("top of opening must be above the lip")
        if w_back >= w_lip:
            raise ValueError("back line must be narrower than the lip")
        if v_back >= v_lip:
            raise ValueError("back line must appear above the lip line")
        return self

    def to_engine(self, aspect: float) -> Calibration:
        return Calibration.from_dict(self.model_dump(), aspect)


# ─── Venues (Spec 2) ─────────────────────────────────────────────────────────

class GridModel(BaseModel):
    rows: Annotated[int, Field(ge=1, le=6)] = 3
    cols: Annotated[int, Field(ge=1, le=6)] = 3
    number_from_stage_left: bool = False


class PositionModel(BaseModel):
    """A hanging position in the Spec 1 world frame (feet). Pipes need a trim
    height, booms an X offset, floor positions only an upstage distance."""
    id: str = Field(min_length=1)
    name: str = Field(min_length=1)
    kind: Literal["pipe", "boom", "floor"]
    upstage_ft: Finite
    trim_ft: Finite | None = None
    offset_ft: Finite | None = None

    @model_validator(mode="after")
    def _validate_kind(self) -> "PositionModel":
        if self.kind == "pipe" and self.trim_ft is None:
            raise ValueError("pipe position needs trim_ft")
        if self.kind == "boom" and self.offset_ft is None:
            raise ValueError("boom position needs offset_ft")
        return self


class VenueModel(BaseModel):
    name: str = Field(min_length=1)
    width_ft: Annotated[float, Field(gt=0.0, allow_inf_nan=False)]
    height_ft: Annotated[float, Field(gt=0.0, allow_inf_nan=False)]
    depth_ft: Annotated[float, Field(gt=0.0, allow_inf_nan=False)]
    grid: GridModel = Field(default_factory=GridModel)
    focus_height_ft: Annotated[float, Field(ge=0.0, allow_inf_nan=False)] = 5.0
    positions: list[PositionModel] = Field(default_factory=list)


class GoboModel(BaseModel):
    texture_id: str
    scale: float = 1.0
    rotation: float = 0.0
    offset: list[float] = Field(default_factory=lambda: [0.0, 0.0])
    blur: float = 0.0
    invert: bool = False

    def to_engine(self) -> Gobo:
        return Gobo(
            texture_id=self.texture_id,
            scale=self.scale,
            rotation=self.rotation,
            offset=(self.offset[0], self.offset[1]),
            blur=self.blur,
            invert=self.invert,
        )


class LightModel(BaseModel):
    type: Literal["directional", "point", "spotlight", "reflector", "linear"]
    position: list[float] = Field(default_factory=lambda: [0.0, 0.0, -1.0])
    direction: list[float] = Field(default_factory=lambda: [0.0, 0.0, 1.0])
    target: list[float] | None = None
    color: list[float] = Field(default_factory=lambda: [1.0, 1.0, 1.0])
    color_temperature: float | None = None
    gel_preset: str | None = None
    intensity: Annotated[float, Field(ge=0.0)] = 1.0
    falloff: Annotated[float, Field(ge=0.0)] = 1.0
    cone_angle: Annotated[float, Field(gt=0.0)] = 0.5
    softness: Annotated[float, Field(ge=0.0)] = 0.1
    gobo: GoboModel | None = None
    affects: Literal["all", "subject", "background"] = "all"
    enabled: bool = True
    name: str = ""
    position_ft: list[float] | None = None
    target_ft: list[float] | None = None
    direction_ft: list[float] | None = None
    # Linear (cyc/strip) lights: bar endpoints, feet and engine.
    endpoint_a_ft: list[float] | None = None
    endpoint_b_ft: list[float] | None = None
    endpoint_a: list[float] | None = None
    endpoint_b: list[float] | None = None
    normal: list[float] = Field(default_factory=lambda: [0.0, 0.0, -1.0])
    size: list[float] = Field(default_factory=lambda: [0.6, 0.4])
    reflectance: Annotated[float, Field(ge=0.0, le=1.0)] = 0.7
    roughness: Annotated[float, Field(ge=0.0, le=1.0)] = 0.5

    @model_validator(mode="after")
    def _validate_ft(self) -> "LightModel":
        for k in ("position_ft", "target_ft", "direction_ft",
                  "endpoint_a_ft", "endpoint_b_ft", "endpoint_a", "endpoint_b"):
            v = getattr(self, k)
            if v is not None and len(v) != 3:
                raise ValueError(f"{k} must have 3 components")
        return self

    def to_engine(self) -> Light:
        l = Light(
            type=self.type,
            position=(self.position[0], self.position[1], self.position[2]),
            direction=(self.direction[0], self.direction[1], self.direction[2]),
            target=tuple(self.target) if self.target else None,
            color=(self.color[0], self.color[1], self.color[2]),
            color_temperature=self.color_temperature,
            gel_preset=self.gel_preset,
            intensity=self.intensity,
            falloff=self.falloff,
            cone_angle=self.cone_angle,
            softness=self.softness,
            gobo=self.gobo.to_engine() if self.gobo else None,
            affects=self.affects,
            enabled=self.enabled,
            name=self.name,
            position_ft=tuple(self.position_ft) if self.position_ft else None,
            target_ft=tuple(self.target_ft) if self.target_ft else None,
            direction_ft=tuple(self.direction_ft) if self.direction_ft else None,
            endpoint_a_ft=tuple(self.endpoint_a_ft) if self.endpoint_a_ft else None,
            endpoint_b_ft=tuple(self.endpoint_b_ft) if self.endpoint_b_ft else None,
            endpoint_a=tuple(self.endpoint_a) if self.endpoint_a else None,
            endpoint_b=tuple(self.endpoint_b) if self.endpoint_b else None,
            normal=(self.normal[0], self.normal[1], self.normal[2]),
            size=(self.size[0], self.size[1]),
            reflectance=self.reflectance,
            roughness=self.roughness,
        )
        l.validate()
        return l


class RenderCommon(BaseModel):
    """Shared base for /render and /polish — lights, ambient, shadow, output format."""
    session_id: str
    lights: list[LightModel] = Field(default_factory=list)
    ambient: Annotated[float, Field(ge=0.0)] = 0.2
    ambient_subject: Annotated[float | None, Field(ge=0.0)] = None
    ambient_background: Annotated[float | None, Field(ge=0.0)] = None
    shadow_style: Literal["off", "heightfield", "planar"] = "off"
    output_format: Literal["png", "jpeg", "tiff"] = "png"
    output_bit_depth: Literal[8, 16, 32] = 8
    output_resolution: list[int] | None = None
    calibration: CalibrationModel | None = None

    @model_validator(mode="after")
    def _validate_format_bitdepth(self) -> "RenderCommon":
        if self.output_format == "jpeg" and self.output_bit_depth != 8:
            raise ValueError("JPEG supports 8-bit only")
        if self.output_format == "png" and self.output_bit_depth not in (8, 16):
            raise ValueError("PNG supports 8 or 16-bit only")
        if self.output_format == "tiff" and self.output_bit_depth not in (8, 16, 32):
            raise ValueError("TIFF supports 8, 16, or 32-bit float")
        if self.output_resolution is not None and len(self.output_resolution) != 2:
            raise ValueError("output_resolution must be [w, h]")
        return self


class RenderRequest(RenderCommon):
    """POST /render body. No additional fields beyond RenderCommon today."""


class PolishRequest(RenderCommon):
    """POST /polish body — adds optional prompt + seed."""
    prompt: str = ""
    seed: int | None = None


class RenderLayersRequest(BaseModel):
    """POST /render/layers body. Always outputs 16-bit PSD."""
    session_id: str
    lights: list[LightModel] = Field(default_factory=list)
    ambient: Annotated[float, Field(ge=0.0)] = 0.2
    ambient_subject: Annotated[float | None, Field(ge=0.0)] = None
    ambient_background: Annotated[float | None, Field(ge=0.0)] = None
    shadow_style: Literal["off", "heightfield", "planar"] = "off"
    output_resolution: list[int] | None = None
    scene_name: str = ""
    calibration: CalibrationModel | None = None


class GoboPreset(BaseModel):
    gobo_id: str
    name: str
    thumbnail_url: str
    projection: Literal["spotlight", "equirect"]


class GoboList(BaseModel):
    presets: list[GoboPreset]


class PreparedAssets(BaseModel):
    original_png_url: str
    depth_png_url: str
    normals_png_url: str
    mask_png_url: str | None
    confidence_png_url: str | None = None
    thumbnail_url: str | None = None
    source_url: str | None = None


class PrepareResponse(BaseModel):
    session_id: str
    width: int
    height: int
    assets: PreparedAssets
    metadata: dict


class Capabilities(BaseModel):
    polish: bool = False
    layers_export: bool = False
    segmenters: list[str] = Field(default_factory=list)


class HealthResponse(BaseModel):
    ok: bool
    gpu: bool
    depth_model_loaded: bool
    seg_model_loaded: bool
    capabilities: Capabilities = Field(default_factory=Capabilities)
