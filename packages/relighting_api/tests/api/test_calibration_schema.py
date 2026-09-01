from __future__ import annotations

import pytest
from pydantic import ValidationError

from relighting_api.schemas import CalibrationModel, LightModel, RenderRequest

MARKS = {"lipL": [0.1, 0.61], "lipR": [0.9, 0.61], "top": [0.5, 0.08], "backL": [0.23, 0.54], "backR": [0.77, 0.54]}


def test_calibration_model_round_trips_to_engine():
    cal = CalibrationModel(width_ft=40, height_ft=20, depth_ft=30, marks=MARKS,
                           depth_fit={"a": -0.037, "b": 0.024})
    eng = cal.to_engine(aspect=0.75)
    assert eng.width_ft == 40 and eng.fit is not None and eng.camera.dist_ft > 0


def test_calibration_model_rejects_missing_mark_and_bad_dims():
    with pytest.raises(ValidationError):
        CalibrationModel(width_ft=40, height_ft=20, depth_ft=30, marks={k: v for k, v in MARKS.items() if k != "top"})
    with pytest.raises(ValidationError):
        CalibrationModel(width_ft=0, height_ft=20, depth_ft=30, marks=MARKS)


def test_light_model_carries_feet_fields():
    L = LightModel(type="spotlight", position_ft=[0, 20, -60], target_ft=[0, 5, 10]).to_engine()
    assert L.position_ft == (0, 20, -60) and L.target_ft == (0, 5, 10)
    with pytest.raises(ValidationError):
        LightModel(type="spotlight", position_ft=[0, 20])


def test_render_request_accepts_optional_calibration():
    req = RenderRequest(session_id="s", lights=[], calibration=None)
    assert req.calibration is None
    req = RenderRequest(session_id="s", lights=[],
                        calibration={"width_ft": 40, "height_ft": 20, "depth_ft": 30, "marks": MARKS})
    assert req.calibration.width_ft == 40
