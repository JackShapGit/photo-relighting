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


# ── Server-side mark validation mirrors web/src/metric/calibration.js validateMarks ──

def _cal(marks, **kw):
    return CalibrationModel(width_ft=40, height_ft=20, depth_ft=30, marks=marks, **kw)


@pytest.mark.parametrize("bad", [
    {**MARKS, "lipR": [0.1, 0.61]},                            # lip width zero → w_lip < 5 %
    {**MARKS, "lipR": [0.14, 0.61]},                           # lip width 4 %
    {**MARKS, "backL": [0.05, 0.54], "backR": [0.95, 0.54]},   # back wider than lip
    {**MARKS, "backL": [0.23, 0.7], "backR": [0.77, 0.7]},     # back line below the lip
    {**MARKS, "top": [0.5, 0.65]},                             # top below the lip
    {**MARKS, "top": [0.5, float("nan")]},                     # NaN
    {**MARKS, "lipL": [float("inf"), 0.61]},                   # inf
    {**MARKS, "lipL": [-2.0, 0.61]},                           # far outside the photo
    {**MARKS, "top": [0.5]},                                   # wrong length
])
def test_calibration_model_rejects_degenerate_marks(bad):
    with pytest.raises(ValidationError):
        _cal(bad)


def test_calibration_model_rejects_non_finite_depth_fit_and_dims():
    with pytest.raises(ValidationError):
        _cal(MARKS, depth_fit={"a": float("nan"), "b": 0.02})
    with pytest.raises(ValidationError):
        CalibrationModel(width_ft=float("inf"), height_ft=20, depth_ft=30, marks=MARKS)


def test_calibration_model_accepts_marks_slightly_outside_the_photo():
    assert _cal({**MARKS, "lipL": [-0.2, 0.61]}).to_engine(0.75).camera.dist_ft > 0
