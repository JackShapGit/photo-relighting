"""Pydantic schemas — wire format mirrors of engine dataclasses.

These models 422 on bad input; conversion to engine dataclasses happens via
.to_engine(). Wire field names match engine field names exactly.
"""
from __future__ import annotations

from typing import Annotated, Any, Literal

from pydantic import BaseModel, Field, model_validator

from relighting_engine.lighting.models import Gobo, Light
from relighting_engine.metric.calibration import Calibration

_MARK_KEYS = ("lipL", "lipR", "top", "backL", "backR")


class DepthFitModel(BaseModel):
    a: float
    b: float


class CalibrationModel(BaseModel):
    version: int = 1
    units: Literal["ft", "m"] = "ft"
    width_ft: Annotated[float, Field(gt=0.0)]
    height_ft: Annotated[float, Field(gt=0.0)]
    depth_ft: Annotated[float, Field(gt=0.0)]
    marks: dict[str, list[float]]
    depth_fit: DepthFitModel | None = None
    depth_check: dict[str, Any] | None = None

    @model_validator(mode="after")
    def _validate_marks(self) -> "CalibrationModel":
        for k in _MARK_KEYS:
            v = self.marks.get(k)
            if not (isinstance(v, list) and len(v) == 2):
                raise ValueError(f"marks.{k} must be [u, v]")
        return self

    def to_engine(self, aspect: float) -> Calibration:
        return Calibration.from_dict(self.model_dump(), aspect)


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
    type: Literal["directional", "point", "spotlight", "reflector"]
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
    normal: list[float] = Field(default_factory=lambda: [0.0, 0.0, -1.0])
    size: list[float] = Field(default_factory=lambda: [0.6, 0.4])
    reflectance: Annotated[float, Field(ge=0.0, le=1.0)] = 0.7
    roughness: Annotated[float, Field(ge=0.0, le=1.0)] = 0.5

    @model_validator(mode="after")
    def _validate_ft(self) -> "LightModel":
        for k in ("position_ft", "target_ft", "direction_ft"):
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
