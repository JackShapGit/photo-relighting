import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  solveRecord, syncLightFromFeet, syncLightFromEngine, migrateLightsToFeet, clearMetric,
  syncLightsFromEngineEdits, clampEnginePosition,
} from '../../../src/metric/light-metric.js';
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

// ── Engine-space edits (aim toggle, Direction Z slider, 2D direction handle)
// must re-derive the feet fields through one central sync (final review C1).

function calibratedSpot() {
  const L = { type: 'spotlight', position: [0.5, 0.6, 0.8], direction: [0, 0, -1], target: null, falloff: 1 };
  migrateLightsToFeet([L], record);
  return L;
}

test('syncLightsFromEngineEdits: an engine direction change updates direction_ft', () => {
  const L = calibratedSpot();
  const before = L.direction_ft.slice();
  L.direction = [0.6, 0, -0.8];                    // Direction Z slider / 2D direction handle
  syncLightsFromEngineEdits([L], record);
  assert.notDeepEqual(L.direction_ft, before);
  assert.ok(vclose(L.direction_ft, [0.6, 0, 0.8]));
  assert.deepEqual(L.direction, L.direction_eng, 'engine direction is canonical after the sync');
});

test('syncLightsFromEngineEdits: aim on spawns target_ft down the beam (no jump), aim off drops it', () => {
  const L = calibratedSpot();
  const beam = L.direction_ft.slice(), dirBefore = L.direction.slice();
  L.target = [L.position[0], L.position[1], L.position[2] - 1];   // aim toggle on (engine spawn)
  syncLightsFromEngineEdits([L], record);
  assert.ok(Array.isArray(L.target_ft), 'target_ft exists');
  const expected = [0, 1, 2].map((i) => L.position_ft[i] + beam[i] * 0.5 * record.camera.dist_ft);
  assert.ok(vclose(L.target_ft, expected, 1e-9), 'spawned half a camera distance down the beam');
  assert.ok(vclose(L.direction_ft, beam, 1e-9) && vclose(L.direction, dirBefore, 1e-9), 'beam did not jump');
  assert.ok(Array.isArray(L.target), 'engine target re-derived from the feet target');
  // Target-handle drag: the engine target moves, the feet target follows.
  L.target = [L.target[0] + 0.05, L.target[1], L.target[2]];
  const tftBefore = L.target_ft.slice();
  syncLightsFromEngineEdits([L], record);
  assert.ok(!vclose(L.target_ft, tftBefore, 1e-9), 'target_ft re-derived after a target drag');
  L.target = null;                                                 // aim toggle off
  syncLightsFromEngineEdits([L], record);
  assert.equal('target_ft' in L, false, 'target_ft dropped');
  assert.ok(Array.isArray(L.direction_ft));
});

test('syncLightsFromEngineEdits: a behind-camera light keeps its feet position and spawns a feet target', () => {
  const L = { type: 'spotlight', position: [0.5, 0.5, 0.5], direction: [0, 0, -1], target: null, falloff: 1,
    position_ft: [0, 20, -60] };
  syncLightFromFeet(L, record);
  assert.equal(L.position_eng, null);
  L.target = [0.5, 0.5, -0.5];
  syncLightsFromEngineEdits([L], record);
  assert.deepEqual(L.position_ft, [0, 20, -60], 'position_ft untouched');
  assert.ok(Array.isArray(L.target_ft) && L.target_ft[2] > -60, 'target spawned down the beam in feet');
});

test('syncLightsFromEngineEdits: a light without position_ft is migrated; reflectors are skipped', () => {
  const L = { type: 'point', position: [0.5, 0.5, 0.5], direction: [0, 0, -1], target: null, falloff: 1 };
  const R = { type: 'reflector', position: [0.5, 0.5, 0.5], direction: [0, 0, -1], normal: [0, 0, 1] };
  syncLightsFromEngineEdits([L, R], record);
  assert.ok(Array.isArray(L.position_ft) && Array.isArray(L.position_eng));
  assert.equal('position_ft' in R, false);
});

test('syncLightFromFeet: engine direction always equals direction_eng, even behind the camera', () => {
  const L = { type: 'spotlight', position: [0.5, 0.5, 0.5], direction: [0.3, 0.3, 0.3], target: null, falloff: 1,
    position_ft: [0, 20, -60], direction_ft: [0, -0.6, 0.8] };
  syncLightFromFeet(L, record);
  assert.equal(L.position_eng, null);
  assert.deepEqual(L.direction, L.direction_eng);
});

test('clampEnginePosition brings an off-frame engine position back into reach', () => {
  const L = { position: [1.7, -0.3, 5] };
  clampEnginePosition(L);
  assert.deepEqual(L.position, [0.98, 0.02, 3]);
  const M = { position: [0.4, 0.5, -9] };
  clampEnginePosition(M);
  assert.deepEqual(M.position, [0.4, 0.5, -2]);
});

const vclose = (a, b, eps = 1e-9) => a.length === b.length && a.every((v, i) => Math.abs(v - b[i]) <= eps);

// ── Linear lights (Spec 2): endpoints in feet, engine proxies per endpoint ──

test('syncLightFromFeet on a linear light: endpoint proxies, midpoint position_ft, placeholder direction', () => {
  const L = { type: 'linear', position: [0.5, 0.5, 0.5], direction: [0, 0, 1], target: null, falloff: 1,
    endpoint_a_ft: [-15, 20, 26], endpoint_b_ft: [15, 20, 26] };
  syncLightFromFeet(L, record);
  assert.deepEqual(L.position_ft, [0, 20, 26]);
  assert.ok(Array.isArray(L.endpoint_a) && Array.isArray(L.endpoint_b), 'engine proxies per endpoint');
  assert.ok(L.endpoint_a[0] < 0.5 && L.endpoint_b[0] > 0.5, 'A left of B in engine u');
  assert.ok(Math.abs(L.endpoint_a[0] + L.endpoint_b[0] - 1) < 1e-9, 'symmetric about u = 0.5');
  assert.deepEqual(L.direction_ft, [0, -1, 0]);
  assert.deepEqual(L.direction, L.direction_eng);
  assert.ok(Array.isArray(L.position_eng) && vclose(L.position, L.position_eng));
});

test('migrating an uncalibrated linear light derives feet endpoints; a 2D drag shifts both endpoints', () => {
  const L = { type: 'linear', position: [0.5, 0.5, 0.5], direction: [0, 0, 1], target: null, falloff: 1,
    endpoint_a: [0.3, 0.4, 0.5], endpoint_b: [0.7, 0.4, 0.5] };
  migrateLightsToFeet([L], record);
  assert.ok(Array.isArray(L.endpoint_a_ft) && Array.isArray(L.endpoint_b_ft));
  assert.ok(vclose(L.position_ft, [0, 1, 2].map((i) => (L.endpoint_a_ft[i] + L.endpoint_b_ft[i]) / 2), 1e-9));
  const a0 = L.endpoint_a_ft.slice(), b0 = L.endpoint_b_ft.slice();
  L.position = [L.position[0] + 0.1, L.position[1], L.position[2]];   // 2D handle drag of the midpoint
  syncLightsFromEngineEdits([L], record);
  const dA = [0, 1, 2].map((i) => L.endpoint_a_ft[i] - a0[i]);
  const dB = [0, 1, 2].map((i) => L.endpoint_b_ft[i] - b0[i]);
  assert.ok(vclose(dA, dB, 1e-9) && dA[0] > 0, 'both endpoints translated by the same delta');
});
