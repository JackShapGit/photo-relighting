from __future__ import annotations

import math

import numpy as np
import pytest

from relighting_engine.metric.calibration import (
    Calibration, DepthFit, depth_to_zcam, engine_dir_to_world, falloff_to_metric,
    pixel_to_world, solve_camera, world_to_engine, world_to_pixel,
)

ASPECT = 0.75
RECORD = {
    "version": 1, "units": "ft", "width_ft": 40, "height_ft": 20, "depth_ft": 30,
    "marks": {
        "lipL": [0.1, 0.61333], "lipR": [0.9, 0.61333], "top": [0.5, 0.08],
        "backL": [0.23333, 0.54222], "backR": [0.76667, 0.54222],
    },
    "depth_fit": {"a": -0.037037, "b": 0.024074},
    "depth_check": None,
}


def test_solve_camera_recovers_synthetic_stage():
    cam = solve_camera(RECORD, ASPECT)
    assert cam.dist_ft == pytest.approx(60, rel=0.005)
    assert cam.height_ft == pytest.approx(8, rel=0.005)
    assert cam.f == pytest.approx(1.2, rel=0.005)
    assert cam.k_y == pytest.approx(1.0, abs=0.01)
    assert cam.u_c == 0.5
    assert cam.va_h == pytest.approx(0.3, abs=0.002)


def test_pixel_to_world_lip_corners_and_top():
    cam = solve_camera(RECORD, ASPECT)
    # Lip plane sits at the solved camera distance (60.00225 ft from the
    # 5-decimal marks), same anchoring as the JS test; a literal 60.0 leaves
    # Z at -0.00225.
    z_lip = np.array([cam.dist_ft, cam.dist_ft])
    X, Y, Z = pixel_to_world(np.array([0.1, 0.9]), np.array([0.61333, 0.61333]), z_lip, cam)
    assert X[0] == pytest.approx(-20, rel=0.005) and X[1] == pytest.approx(20, rel=0.005)
    assert abs(Y[0]) < 0.05 and abs(Z[0]) < 1e-6
    _, Yt, _ = pixel_to_world(0.5, 0.08, cam.dist_ft, cam)
    assert Yt == pytest.approx(20, rel=0.005)


def test_world_to_pixel_round_trip_and_none_behind_camera():
    cam = solve_camera(RECORD, ASPECT)
    u, v, zc = world_to_pixel((7.0, 3.0, 12.0), cam)
    X, Y, Z = pixel_to_world(u, v, zc, cam)
    assert (X, Y, Z) == pytest.approx((7.0, 3.0, 12.0), abs=1e-6)
    assert world_to_pixel((0.0, 10.0, -60.0), cam) is None
    assert world_to_pixel((0.0, 10.0, -80.0), cam) is None


def test_depth_to_zcam_matches_js_numbers_and_clamps():
    fit = DepthFit(a=-0.037037, b=0.024074)
    assert depth_to_zcam(0.20, fit) == pytest.approx(60, abs=1e-2)
    assert depth_to_zcam(0.35, fit) == pytest.approx(90, abs=1e-2)
    z = depth_to_zcam(np.array([-5.0, 0.65]), fit)
    assert z[0] >= 0.5 and z[1] <= 10000


def test_depth_to_zcam_anchored_on_solved_camera():
    # Same anchoring as the JS fitDepth test: the 5-decimal synthetic marks
    # solve to dist_ft = 60.00225 (not 60), and a fit built on that camera
    # must map the lip/back depths back onto it exactly.
    cam = solve_camera(RECORD, ASPECT)
    assert cam.dist_ft == pytest.approx(60, rel=1e-4)
    z_lip = cam.dist_ft
    z_back = cam.dist_ft + RECORD["depth_ft"]
    d_lip, d_back = 0.20, 0.35
    a = (1.0 / z_lip - 1.0 / z_back) / (d_lip - d_back)   # mirrors fitDepth in calibration.js
    b = 1.0 / z_lip - a * d_lip
    fit = DepthFit(a=a, b=b)
    assert fit.a == pytest.approx(-0.037037, abs=1e-5)
    assert fit.b == pytest.approx(0.024074, abs=1e-5)
    assert depth_to_zcam(d_lip, fit) == pytest.approx(z_lip, abs=1e-3)
    assert depth_to_zcam(d_back, fit) == pytest.approx(z_back, abs=1e-3)


def test_world_to_engine_and_dir_transform():
    cam = solve_camera(RECORD, ASPECT)
    fit = DepthFit(a=-0.037037, b=0.024074)
    e = world_to_engine((5.0, 4.0, 10.0), cam, fit)
    assert 0 < e[0] < 1 and 0 < e[1] < 1
    assert world_to_engine((0.0, 20.0, -70.0), cam, fit) is None
    assert engine_dir_to_world((0.1, 0.2, -0.9)) == (0.1, -0.2, 0.9)


def test_calibration_from_dict_and_falloff():
    cal = Calibration.from_dict(RECORD, ASPECT)
    assert cal.fit is not None and cal.camera.dist_ft == pytest.approx(60, rel=0.005)
    assert falloff_to_metric(1.0, cal.width_ft) == pytest.approx(1 / 1600)
    no_fit = Calibration.from_dict({**RECORD, "depth_fit": None}, ASPECT)
    assert no_fit.fit is None
