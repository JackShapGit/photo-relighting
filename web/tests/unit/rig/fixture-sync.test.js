import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  syncFixtureFromRig, syncAllFixtures, detachFixture, detachAim, attachFixture,
  enabledEmitterCount, canEnable, detachFromEngineEdits, syncRig, setLightType, tryEnable, CAP_MESSAGE,
} from '../../../src/rig/fixture-sync.js';
import { SYNTHETIC_VENUE } from '../../../src/rig/geometry.js';
import { solveRecord, syncLightFromFeet } from '../../../src/metric/light-metric.js';
const syncLightFromFeetForTest = (L) => syncLightFromFeet(L, record);
import { SYNTHETIC_STAGE } from '../../../src/metric/calibration.js';

const V = SYNTHETIC_VENUE;
const record = solveRecord({ ...SYNTHETIC_STAGE.record, depth_fit: { a: -0.037037, b: 0.024074 } }, SYNTHETIC_STAGE.aspect);
const pos = (name) => V.positions.find((p) => p.name === name);
const near = (a, b, t = 1e-9) => assert.ok(Math.abs(a - b) <= t, `${a} !~ ${b}`);
const vnear = (a, b, t = 1e-9) => { assert.equal(a.length, b.length); a.forEach((v, i) => near(v, b[i], t)); };
const spot = (fixture, extra = {}) => ({
  id: 'L', name: 'L', type: 'spotlight', enabled: true, position: [0.5, 0.5, 0.5], direction: [0, 0, 1], target: null,
  falloff: 1, cone_angle: 0.3, softness: 0.1, intensity: 1, fixture, ...extra,
});

test('a fixture on 1E at offset 4 hangs at [4, 20, 6] and aims at area 5 → [0, 5, 15]', () => {
  const L = spot({ type: 'ers', position_id: 'p_1e', offset_ft: 4, area: '5', barrel_deg: 26 });
  syncFixtureFromRig(L, V, record);
  assert.deepEqual(L.position_ft, [4, 20, 6]);
  assert.deepEqual(L.target_ft, [0, 5, 15]);
  near(Math.hypot(...L.direction_ft), 1);
  assert.ok(L.direction_ft[1] < 0 && L.direction_ft[2] > 0, 'aims down and upstage');
  assert.ok(Array.isArray(L.position_eng) && Array.isArray(L.position), 'engine proxies derived');
  assert.deepEqual(L.direction, L.direction_eng);
});

test('a cyc on 3E gets endpoints along X and a midpoint position; its area is ignored', () => {
  const L = spot({ type: 'cyc', position_id: 'p_3e', offset_ft: 0, length_ft: 4, area: '5' }, { type: 'linear' });
  syncFixtureFromRig(L, V, record);
  assert.deepEqual(L.endpoint_a_ft, [-2, 20, 22]);
  assert.deepEqual(L.endpoint_b_ft, [2, 20, 22]);
  assert.deepEqual(L.position_ft, [0, 20, 22]);
  assert.equal('target_ft' in L, false, 'cyc is never aimed');
  const B = spot({ type: 'cyc', position_id: 'p_bsl', offset_ft: 10, length_ft: 4 }, { type: 'linear' });
  syncFixtureFromRig(B, V, record);
  assert.deepEqual(B.endpoint_a_ft, [22, 8, 8]); assert.deepEqual(B.endpoint_b_ft, [22, 12, 8]);
});

test('a null area leaves an existing target alone; a followspot with an area is always aimed', () => {
  const L = spot({ type: 'fresnel', position_id: 'p_2e', offset_ft: -3, area: null }, { target_ft: [1, 2, 3] });
  syncFixtureFromRig(L, V, record);
  assert.deepEqual(L.position_ft, [-3, 20, 14]);
  assert.deepEqual(L.target_ft, [1, 2, 3]);
  const F = spot({ type: 'followspot', position_id: 'p_foh', offset_ft: 0, area: '9' });
  syncFixtureFromRig(F, V, record);
  assert.deepEqual(F.position_ft, [0, 22, -52]);
  vnear(F.target_ft, [40 / 3, 5, 25], 1e-6);
});

test('detachFixture keeps the coordinates and the sync then leaves the light alone', () => {
  const L = spot({ type: 'par', position_id: 'p_1e', offset_ft: 4, area: '5', lamp: 'MFL' });
  syncFixtureFromRig(L, V, record);
  detachFixture(L);
  assert.equal(L.fixture.position_id, null);
  assert.deepEqual(L.position_ft, [4, 20, 6]);
  assert.deepEqual(L.target_ft, [0, 5, 15]);
  L.position_ft = [9, 9, 9];                          // a direct move afterwards
  syncAllFixtures([L], V, record);
  assert.deepEqual(L.position_ft, [9, 9, 9], 'custom fixtures are never re-hung');
  detachAim(L);
  assert.equal(L.fixture.area, null);
  assert.deepEqual(L.target_ft, [0, 5, 15], 'aim kept');
});

test('attachFixture snaps to the nearest offset: X on a pipe, Y on a boom', () => {
  const L = spot({ type: 'ers', position_id: null, offset_ft: 0, area: null }, { position_ft: [7.5, 18, 9] });
  attachFixture(L, pos('1E'), V, record);
  assert.equal(L.fixture.position_id, 'p_1e');
  near(L.fixture.offset_ft, 7.5);
  assert.deepEqual(L.position_ft, [7.5, 20, 6]);
  const B = spot({ type: 'ers', position_id: null, offset_ft: 0, area: null }, { position_ft: [20, 9.25, 7] });
  attachFixture(B, pos('BSL'), V, record);
  near(B.fixture.offset_ft, 9.25);
  assert.deepEqual(B.position_ft, [22, 9.25, 8]);
});

test('syncAllFixtures skips reflectors, custom lights, lights without a fixture, and unknown positions', () => {
  const R = { id: 'R', type: 'reflector', enabled: true, position: [0.5, 0.5, 0.5], direction: [0, 0, -1], normal: [0, 0, 1], fixture: { type: 'other', position_id: 'p_1e', offset_ft: 0 } };
  const P = spot({ type: 'ers', position_id: 'p_nope', offset_ft: 1, area: null }, { position_ft: [3, 3, 3] });
  const N = spot(undefined, { position_ft: [4, 4, 4] });
  const A = spot({ type: 'ers', position_id: 'p_1e', offset_ft: 1, area: null });
  syncAllFixtures([R, P, N, A], V, record);
  assert.equal('position_ft' in R, false);
  assert.deepEqual(P.position_ft, [3, 3, 3]);
  assert.deepEqual(N.position_ft, [4, 4, 4]);
  assert.deepEqual(A.position_ft, [1, 20, 6]);
});

test('enabledEmitterCount / canEnable enforce the 64-emitter cap', () => {
  const lights = Array.from({ length: 64 }, (_, i) => spot(undefined, { id: `L${i}` }));
  const off = spot(undefined, { id: 'off', enabled: false });
  const refl = { id: 'R', type: 'reflector', enabled: true };
  assert.equal(enabledEmitterCount([...lights, off, refl]), 64);
  assert.equal(canEnable([...lights, off, refl], off), false);
  assert.equal(canEnable([...lights, off, refl], lights[0]), true, 'already enabled');
  assert.equal(canEnable([...lights.slice(1), off], off), true, '63 enabled leaves room');
});

// ─── Direct moves in engine space (2D handle drags, sliders, aim toggle) ────
// main.js runs syncRig on every change: engine edits detach first, the rig
// re-hangs what is still attached, then Spec 1 re-derives feet from engine.

const hung = (extra = {}) => {
  const L = spot({ type: 'ers', position_id: 'p_1e', offset_ft: 4, area: '5', barrel_deg: 26 }, extra);
  syncFixtureFromRig(L, V, record);
  return L;
};

test('an untouched attached light survives syncRig still hung and aimed', () => {
  const L = hung();
  syncRig([L], V, record);
  assert.equal(L.fixture.position_id, 'p_1e');
  assert.equal(L.fixture.area, '5');
  assert.deepEqual(L.position_ft, [4, 20, 6]);
  assert.deepEqual(L.target_ft, [0, 5, 15]);
});

test('a 2D drag (engine position moved) makes the light Custom and keeps the dragged spot', () => {
  const L = hung();
  L.position = [L.position[0] + 0.1, L.position[1], L.position[2]];   // the handle moved it
  const dragged = L.position.slice();
  const n = detachFromEngineEdits([L], record);
  assert.equal(n, 1);
  assert.equal(L.fixture.position_id, null, 'now Custom');
  assert.equal(L.fixture.area, '5', 'aim untouched by a move');
  const M = hung();
  M.position = dragged.slice();
  assert.equal(syncRig([M], V, record), 1, 'reports the detach so the tree can regroup');
  assert.equal(syncRig([M], V, record), 0, 'nothing more to detach');
  assert.equal(M.fixture.position_id, null);
  assert.notDeepEqual(M.position_ft, [4, 20, 6], 'not re-hung on the pipe');
  vnear(M.position, dragged, 1e-9);
  assert.deepEqual(M.position_eng, M.position);
});

test('a target-handle drag drops the area but keeps the light on its pipe', () => {
  const L = hung();
  L.target = [L.target[0] + 0.05, L.target[1], L.target[2]];
  syncRig([L], V, record);
  assert.equal(L.fixture.position_id, 'p_1e');
  assert.equal(L.fixture.area, null);
  assert.deepEqual(L.position_ft, [4, 20, 6]);
  assert.notDeepEqual(L.target_ft, [0, 5, 15], 'target follows the drag');
});

test('switching aim-at-target off on a hung light sticks: no target, no area, still hung', () => {
  const L = hung();
  const dir = L.direction_ft.slice();
  L.target = null;
  syncRig([L], V, record);
  assert.equal(L.target, null);
  assert.equal('target_ft' in L, false);
  assert.equal(L.fixture.area, null);
  assert.equal(L.fixture.position_id, 'p_1e');
  assert.deepEqual(L.position_ft, [4, 20, 6]);
  vnear(L.direction_ft, dir, 1e-9);
});

test('syncRig re-hangs attached lights before Spec 1 sync, so a moved pipe moves its fixtures', () => {
  const L = hung();
  const V2 = { ...V, positions: V.positions.map((p) => (p.id === 'p_1e' ? { ...p, trim_ft: 24 } : p)) };
  syncRig([L], V2, record);
  assert.deepEqual(L.position_ft, [4, 24, 6]);
  assert.deepEqual(L.position, L.position_eng, 'engine proxy follows');
  const C = hung(); detachFixture(C); C.position_ft = [1, 1, 1]; syncLightFromFeetForTest(C);
  syncRig([C], V2, record);
  assert.deepEqual(C.position_ft, [1, 1, 1], 'Custom is never re-hung');
});

// ─── Props-pane Type select (I2) and Enabled checkbox (I3) ────────────────

test('setLightType to linear seeds engine endpoints on an uncalibrated light', () => {
  const L = { id: 'u', type: 'spotlight', enabled: true, position: [0.4, 0.5, 1.2], direction: [0, 0, 1], target: [0.5, 0.5, 0.5] };
  setLightType(L, 'linear', null);
  assert.equal(L.type, 'linear');
  vnear(L.endpoint_a, [0.3, 0.5, 1.2]); vnear(L.endpoint_b, [0.5, 0.5, 1.2]);
  assert.equal(L.target, null, 'a bar is not aimed');
  setLightType(L, 'spotlight', null);
  assert.equal('endpoint_a' in L, false); assert.equal('endpoint_b' in L, false);
});

test('setLightType to linear on a calibrated Custom light makes a 4 ft bar centred on its feet position, with proxies', () => {
  const L = spot(undefined, { position_ft: [3, 12, 4], target_ft: [0, 5, 15] });
  syncLightFromFeetForTest(L);
  setLightType(L, 'linear', record);
  assert.deepEqual(L.endpoint_a_ft, [1, 12, 4]); assert.deepEqual(L.endpoint_b_ft, [5, 12, 4]);
  assert.deepEqual(L.position_ft, [3, 12, 4]);
  assert.ok(Array.isArray(L.endpoint_a) && Array.isArray(L.endpoint_b), 'engine proxies derived');
  assert.equal('target_ft' in L, false);
  setLightType(L, 'spotlight', record);
  assert.equal('endpoint_a_ft' in L, false); assert.equal('endpoint_a' in L, false);
  assert.deepEqual(L.position_ft, [3, 12, 4]);
});

test('setLightType to linear on a hung fixture becomes a cyc on its position (preset + linearEndpoints)', () => {
  const L = spot({ type: 'ers', position_id: 'p_3e', offset_ft: 0, area: '5', barrel_deg: 26 });
  syncFixtureFromRig(L, V, record);
  setLightType(L, 'linear', record, V);
  assert.equal(L.fixture.type, 'cyc'); assert.equal(L.fixture.length_ft, 4);
  assert.deepEqual(L.endpoint_a_ft, [-2, 20, 22]); assert.deepEqual(L.endpoint_b_ft, [2, 20, 22]);
  assert.equal(L.softness, 0.6);
});

test('tryEnable gates the 64-emitter cap and returns the spec message', () => {
  const lights = Array.from({ length: 64 }, (_, i) => spot(undefined, { id: `L${i}` }));
  const off = spot(undefined, { id: 'off', enabled: false });
  const all = [...lights, off];
  const refused = tryEnable(all, off, true);
  assert.equal(refused.ok, false); assert.equal(refused.message, CAP_MESSAGE); assert.equal(off.enabled, false);
  assert.equal(CAP_MESSAGE, '64 lights maximum; disable one first');
  const disabled = tryEnable(all, lights[0], false);
  assert.equal(disabled.ok, true); assert.equal(lights[0].enabled, false);
  const ok = tryEnable(all, off, true);
  assert.equal(ok.ok, true); assert.equal(off.enabled, true);
});
