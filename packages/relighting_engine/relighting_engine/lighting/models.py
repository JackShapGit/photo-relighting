"""Light and Gobo dataclasses. The single source of truth for the engine API.

The HTTP layer's Pydantic schemas mirror these — keep the field names aligned.
"""
from __future__ import annotations

from dataclasses import asdict, dataclass, field
from math import isfinite
from typing import Any, Literal

LightType = Literal["directional", "point", "spotlight", "reflector"]
Affects = Literal["all", "subject", "background"]


@dataclass
class Gobo:
    texture_id: str
    scale: float = 1.0
    rotation: float = 0.0      # radians
    offset: tuple[float, float] = (0.0, 0.0)
    blur: float = 0.0
    invert: bool = False

    def to_dict(self) -> dict[str, Any]:
        d = asdict(self)
        d["offset"] = list(self.offset)
        return d

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> "Gobo":
        offset = tuple(d.get("offset", (0.0, 0.0)))
        return cls(
            texture_id=d["texture_id"],
            scale=float(d.get("scale", 1.0)),
            rotation=float(d.get("rotation", 0.0)),
            offset=(float(offset[0]), float(offset[1])),
            blur=float(d.get("blur", 0.0)),
            invert=bool(d.get("invert", False)),
        )


@dataclass
class Light:
    type: Literal['directional', 'point', 'spotlight', 'reflector']
    position: tuple[float, float, float] = (0.0, 0.0, -1.0)
    direction: tuple[float, float, float] = (0.0, 0.0, 1.0)
    color: tuple[float, float, float] = (1.0, 1.0, 1.0)
    color_temperature: float | None = None
    gel_preset: str | None = None
    intensity: float = 1.0
    falloff: float = 1.0
    cone_angle: float = 0.5     # radians (half-angle)
    softness: float = 0.1
    gobo: Gobo | None = None
    affects: Affects = "all"
    enabled: bool = True
    name: str = ""

    # Reflector-only fields (ignored for non-reflector types).
    normal: tuple[float, float, float] = (0.0, 0.0, -1.0)
    size: tuple[float, float] = (0.6, 0.4)
    reflectance: float = 0.7
    roughness: float = 0.5

    def validate(self) -> None:
        if self.type not in ("directional", "point", "spotlight", "reflector"):
            raise ValueError(f"unknown light type {self.type}")
        if not isfinite(self.intensity) or self.intensity < 0:
            raise ValueError("intensity must be non-negative finite")
        if self.type in ("directional", "spotlight"):
            dx, dy, dz = self.direction
            if dx == 0.0 and dy == 0.0 and dz == 0.0:
                raise ValueError("direction must be non-zero for directional/spotlight")
        if self.type == "spotlight" and self.cone_angle <= 0:
            raise ValueError("cone_angle must be positive for spotlight")
        if any(not isfinite(c) or c < 0 for c in self.color):
            raise ValueError("color components must be non-negative finite")
        if self.type == 'reflector':
            nx, ny, nz = self.normal
            if nx * nx + ny * ny + nz * nz < 1e-9:
                raise ValueError('reflector normal must be non-zero')
            if self.size[0] <= 0 or self.size[1] <= 0:
                raise ValueError('reflector size components must be positive')
            if not (0.0 <= self.reflectance <= 1.0):
                raise ValueError('reflector reflectance must be in [0, 1]')
            if not (0.0 <= self.roughness <= 1.0):
                raise ValueError('reflector roughness must be in [0, 1]')

    def to_dict(self) -> dict[str, Any]:
        d: dict[str, Any] = asdict(self)
        d["position"] = list(self.position)
        d["direction"] = list(self.direction)
        d["color"] = list(self.color)
        d["gobo"] = self.gobo.to_dict() if self.gobo else None
        return d

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> "Light":
        gobo = Gobo.from_dict(d["gobo"]) if d.get("gobo") else None
        return cls(
            type=d["type"],
            position=tuple(d.get("position", (0.0, 0.0, -1.0))),
            direction=tuple(d.get("direction", (0.0, 0.0, 1.0))),
            color=tuple(d.get("color", (1.0, 1.0, 1.0))),
            color_temperature=d.get("color_temperature"),
            gel_preset=d.get("gel_preset"),
            intensity=float(d.get("intensity", 1.0)),
            falloff=float(d.get("falloff", 1.0)),
            cone_angle=float(d.get("cone_angle", 0.5)),
            softness=float(d.get("softness", 0.1)),
            gobo=gobo,
            affects=d.get("affects", "all"),
            enabled=bool(d.get("enabled", True)),
            name=d.get('name', ''),
            normal=tuple(d.get('normal', (0.0, 0.0, -1.0))),
            size=tuple(d.get('size', (0.6, 0.4))),
            reflectance=float(d.get('reflectance', 0.7)),
            roughness=float(d.get('roughness', 0.5)),
        )
