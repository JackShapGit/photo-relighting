import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FIXTURE_TYPES, PRESETS, applyFixturePreset, fieldAngleFor } from '../../../src/rig/presets.js';
const near = (a, b, t = 1e-9) => assert.ok(Math.abs(a - b) <= t, `${a} !~ ${b}`);
const base = () => ({ type: 'spotlight', name: 'X', enabled: true, intensity: 0.7, position_ft: [1,2,3], target_ft: [0,5,10], gobo: { texture_id: 'preset:window-blinds' }, fixture: { type: 'other', position_id: 'p', offset_ft: 4, area: '5' } });

test('seven types in order', () => {
  assert.deepEqual(FIXTURE_TYPES.map((t) => t.id), ['ers','fresnel','par','followspot','moving_head','cyc','other']);
});

test('ERS preset: 26° barrel → half angle, hard edge, 3200 K, gobo kept', () => {
  const L = applyFixturePreset(base(), 'ers', 26);
  near(L.cone_angle, (26 / 2) * Math.PI / 180, 1e-12);
  assert.equal(L.softness, 0.05); assert.equal(L.kelvin, 3200); assert.equal(L.type, 'spotlight');
  assert.ok(L.gobo); assert.equal(L.fixture.barrel_deg, 26);
});

test('Fresnel removes an unsupported gobo and keeps rig fields', () => {
  const L = applyFixturePreset(base(), 'fresnel', 30);
  assert.equal(L.gobo, null); assert.equal(L.softness, 0.4);
  assert.deepEqual(L.position_ft, [1,2,3]); assert.equal(L.fixture.area, '5'); assert.equal(L.intensity, 0.7); assert.equal(L.name, 'X');
});

test('PAR lamps, followspot and moving head defaults', () => {
  assert.equal(fieldAngleFor('par', 'WFL'), 55);
  near(applyFixturePreset(base(), 'followspot').cone_angle, 4 * Math.PI / 180, 1e-12);
  assert.equal(PRESETS.followspot.aimed, 'always'); assert.equal(PRESETS.moving_head.kelvin, 5600);
});

test('cyc preset makes a linear light with length', () => {
  const L = applyFixturePreset(base(), 'cyc');
  assert.equal(L.type, 'linear'); assert.equal(L.fixture.length_ft, 4); assert.equal(L.softness, 0.6); assert.equal(L.gobo, null);
});
