import { test } from 'node:test';
import assert from 'node:assert/strict';
import { edgePlacement, isOffFrame } from '../../src/handles.js';
import { solveCamera, SYNTHETIC_STAGE } from '../../src/metric/calibration.js';

const { record: REC, aspect: ASPECT } = SYNTHETIC_STAGE;
const cal = { ...REC, camera: solveCamera(REC, ASPECT) };
const r = { width: 800, height: 600 };
const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) <= eps, `${a} !~ ${b}`);

test('a light in front of the camera but off to the side sits on the right edge, pointing right', () => {
  const L = { position_ft: [100, 5, 0] };   // far stage left at the lip → u = 2.5
  const { x, y, angle } = edgePlacement(L, cal, r);
  near(x, 0.98 * r.width, 1e-6);
  assert.ok(Math.abs(y - 0.5 * r.height) < 0.02 * r.height, `y ${y} should stay near mid-height`);
  assert.ok(Math.abs(angle) < 0.05, `angle ${angle} should point right`);
});

test('a light behind the camera uses the point ahead along its beam', () => {
  // FOH spot at (0, 20, -60): Z_cam = 0 → no projection. Aimed at (0, 5, 10),
  // the point half a camera-distance down the beam is above the eye line, so
  // the arrow lands on the top edge pointing up.
  const d = [0, -15, 70]; const n = Math.hypot(...d);
  const L = { position_ft: [0, 20, -60], direction_ft: d.map((c) => c / n) };
  const { x, y, angle } = edgePlacement(L, cal, r);
  near(x, 0.5 * r.width, 1e-6);
  near(y, 0.02 * r.height, 1e-6);
  near(angle, -Math.PI / 2, 1e-9);
});

test('a light behind the camera with no usable beam falls back to bottom-centre (front of house)', () => {
  const L = { position_ft: [0, 20, -60] };   // no direction_ft → "ahead" is the light itself
  const { x, y, angle } = edgePlacement(L, cal, r);
  near(x, 0.5 * r.width, 1e-6);
  near(y, 0.98 * r.height, 1e-6);
  near(angle, Math.PI / 2, 1e-9);
});

test('the arrow always lands 2% inside the nearest edge', () => {
  for (const pos of [[100, 5, 0], [-100, 5, 0], [0, 200, 0], [0, -200, 0], [30, 60, 20]]) {
    const { x, y } = edgePlacement({ position_ft: pos }, cal, r);
    const m = Math.max(Math.abs(x / r.width - 0.5), Math.abs(y / r.height - 0.5));
    near(m, 0.48, 1e-9);
    assert.ok(x >= 0 && x <= r.width && y >= 0 && y <= r.height);
  }
});

test('isOffFrame: only calibrated feet-lights with no or out-of-range projection', () => {
  assert.equal(isOffFrame({ position: [0.5, 0.5, 0.5] }, null), false);                       // no calibration
  assert.equal(isOffFrame({ type: 'reflector', position: [0.5, 0.5, 0.5] }, cal), false);      // reflectors stay engine-space
  assert.equal(isOffFrame({ position_ft: [0, 20, -60], position_eng: null, position: [0.5, 0.5, 0.5] }, cal), true);
  assert.equal(isOffFrame({ position_ft: [100, 5, 0], position_eng: [2.5, 0.48, 0.5], position: [2.5, 0.48, 0.5] }, cal), true);
  assert.equal(isOffFrame({ position_ft: [0, 5, 10], position_eng: [0.5, 0.5, 0.5], position: [0.5, 0.5, 0.5] }, cal), false);
  // No depth fit: every light has position_eng null, so the camera projection decides.
  assert.equal(isOffFrame({ position_ft: [0, 5, 10], position_eng: null, position: [0.5, 0.5, 0.5] }, cal), false);
  assert.equal(isOffFrame({ position_ft: [100, 5, 0], position_eng: null, position: [0.5, 0.5, 0.5] }, cal), true);
});
