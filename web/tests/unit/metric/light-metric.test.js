import { test } from 'node:test';
import assert from 'node:assert/strict';
import { solveRecord, syncLightFromFeet, syncLightFromEngine, migrateLightsToFeet, clearMetric } from '../../../src/metric/light-metric.js';
import { SYNTHETIC_STAGE } from '../../../src/metric/calibration.js';

const near = (a, b, tol = 1e-6) => assert.ok(Math.abs(a - b) <= tol, `${a} !~ ${b}`);
const record = solveRecord({ ...SYNTHETIC_STAGE.record, depth_fit: { a: -0.037037, b: 0.024074 } }, SYNTHETIC_STAGE.aspect);

test('solveRecord attaches a camera', () => {
  assert.ok(record.camera && Math.abs(record.camera.dist_ft - 60) < 0.5);
});

test('syncLightFromFeet derives direction from target and engine proxies', () => {
  const L = { type: 'spotlight', position: [0.5, 0.5, 1], direction: [0, 0, -1], target: null,
    falloff: 1, position_ft: [0, 20, -60], target_ft: [0, 5, 10] };
  syncLightFromFeet(L, record);
  near(Math.hypot(...L.direction_ft), 1, 1e-9);
  assert.ok(L.direction_ft[2] > 0, 'points upstage');
  assert.equal(L.position_eng, null, 'FOH light at the camera plane has no projection');
  assert.deepEqual(L.direction_eng, [L.direction_ft[0], -L.direction_ft[1], -L.direction_ft[2]]);
  near(L.falloff_ft, 1 / 1600, 1e-12);
});

test('syncLightFromFeet updates engine position when the light projects', () => {
  const L = { type: 'point', position: [0.1, 0.1, 0.1], direction: [0, 0, -1], target: null, falloff: 1,
    position_ft: [0, 5, 10] };
  syncLightFromFeet(L, record);
  assert.ok(L.position_eng && L.position[0] > 0.4 && L.position[0] < 0.6);
  assert.deepEqual(L.position, L.position_eng);
});

test('syncLightFromEngine derives feet from an in-frame engine position', () => {
  const L = { type: 'spotlight', position: [0.5, 0.6, 0.8], direction: [0, 0, -1], target: [0.5, 0.5, 0.65], falloff: 1 };
  syncLightFromEngine(L, record);
  assert.ok(Array.isArray(L.position_ft) && Array.isArray(L.target_ft));
  assert.ok(Math.abs(L.position_ft[0]) < 1, 'centered light is near X = 0');
});

test('migrateLightsToFeet only touches lights without position_ft', () => {
  const a = { type: 'point', position: [0.5, 0.5, 0.5], direction: [0, 0, -1], target: null, falloff: 1 };
  const b = { ...a, position_ft: [1, 2, 3] };
  migrateLightsToFeet([a, b], record);
  assert.ok(a.position_ft);
  assert.deepEqual(b.position_ft, [1, 2, 3]);
});

test('a record with no depth fit still migrates lights (linear depth fallback)', () => {
  const noFit = solveRecord({ ...SYNTHETIC_STAGE.record, depth_fit: null }, SYNTHETIC_STAGE.aspect);
  const L = { type: 'spotlight', position: [0.5, 0.6, 0.8], direction: [0, 0, -1], target: [0.5, 0.5, 0.65], falloff: 1 };
  migrateLightsToFeet([L], noFit);
  assert.ok(Array.isArray(L.position_ft) && Array.isArray(L.target_ft), 'feet fields exist');
  assert.ok(Array.isArray(L.position_eng), 'engine proxy exists without a fit');
  // Engine z = 0.8 → d = 0.2 → Z = 0.2 · 30 ft = 6 ft upstage of the lip.
  near(L.position_ft[2], 6, 1e-6);
  near(L.position_eng[2], 0.8, 1e-9);
  assert.deepEqual(L.position, L.position_eng);
  // And the feet → engine direction agrees with the shader's linear rule.
  const M = { type: 'point', position: [0, 0, 0], direction: [0, 0, -1], target: null, falloff: 1, position_ft: [0, 5, 15] };
  syncLightFromFeet(M, noFit);
  near(M.position_eng[2], 1 - 15 / 30, 1e-9);
});

test('clearMetric removes metric fields', () => {
  const L = { position_ft: [1, 2, 3], target_ft: [0, 0, 0], direction_ft: [0, 0, 1], position_eng: [0.5, 0.5, 0.5], direction_eng: [0, 0, -1], falloff_ft: 0.1 };
  clearMetric(L);
  for (const k of ['position_ft', 'target_ft', 'direction_ft', 'position_eng', 'direction_eng', 'falloff_ft']) assert.equal(k in L, false);
});
