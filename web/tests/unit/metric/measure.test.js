import { test } from 'node:test';
import assert from 'node:assert/strict';
import { distanceFt, planeHitY, insideHouse, throwAndDiameter, reasonTooltip, readoutCellText } from '../../../src/metric/measure.js';
import { SYNTHETIC_VENUE } from '../../../src/rig/geometry.js';
import { applyFixturePreset } from '../../../src/rig/presets.js';

const V = SYNTHETIC_VENUE;                 // 40 × 20 × 30, focus_height_ft 5
const near = (a, b, t = 1e-6) => assert.ok(Math.abs(a - b) <= t, `${a} !~ ${b}`);

// ── planeHitY ────────────────────────────────────────────────────────────
test('planeHitY: a downward ray crosses the focus plane', () => {
  const p = planeHitY([0, 20, -10], [0, -1, 0], 5);
  assert.deepEqual(p, [0, 5, -10]);
});

test('planeHitY: a ray parallel to the plane never crosses it', () => {
  assert.equal(planeHitY([0, 5, -10], [0, 0, 1], 5), null);
});

test('planeHitY: a ray pointing away from the plane does not count', () => {
  assert.equal(planeHitY([0, 20, -10], [0, 1, 0], 5), null);
});

test('planeHitY: a ray starting on the plane does not count (t = 0)', () => {
  assert.equal(planeHitY([0, 5, -10], [0, -1, 0], 5), null);
});

// ── insideHouse ──────────────────────────────────────────────────────────
test('insideHouse: stage centre is in, a point past the side wall is out', () => {
  assert.equal(insideHouse([0, 5, 10], V), true);
  assert.equal(insideHouse([999, 5, 10], V), false);
});

test('insideHouse: a point beyond the back of the house is out', () => {
  assert.equal(insideHouse([0, 5, -1000], V), false);
});

// ── throwAndDiameter: aimed ──────────────────────────────────────────────
test('throwAndDiameter: an aimed fixture reports the distance to its target', () => {
  const L = { type: 'spotlight', position_ft: [0, 25, -30], target_ft: [0, 5, -30], cone_angle: 0.2 };
  const r = throwAndDiameter(L, V);
  assert.equal(r.reason, 'ok');
  near(r.throwFt, 20);
  near(r.fieldDiaFt, 2 * 20 * Math.tan(0.2));
});

// ── Photometric goldens: the only external check on the geometry ─────────
test('golden: a Source Four 26 deg at a 30 ft throw gives ETC published 13.9 ft field', () => {
  const L = applyFixturePreset({ type: 'spotlight', direction: [0, -1, 0], position: [0, 0, 0] }, 'ers', 26);
  L.position_ft = [0, 30, 0];
  L.target_ft = [0, 0, 0];
  const r = throwAndDiameter(L, V);
  assert.equal(r.reason, 'ok');
  near(r.throwFt, 30, 1e-9);
  assert.ok(Math.abs(r.fieldDiaFt - 13.9) <= 0.05, `field ${r.fieldDiaFt} not within 0.05 of 13.9`);
});

test('golden: a PAR MFL (35 deg) at a 20 ft throw gives 12.6 ft field', () => {
  const L = applyFixturePreset({ type: 'spotlight', direction: [0, -1, 0], position: [0, 0, 0] }, 'par', 'MFL');
  L.position_ft = [0, 20, 0];
  L.target_ft = [0, 0, 0];
  const r = throwAndDiameter(L, V);
  assert.ok(Math.abs(r.fieldDiaFt - 12.6) <= 0.05, `field ${r.fieldDiaFt} not within 0.05 of 12.6`);
});

// ── throwAndDiameter: unaimed falls to the focus plane ───────────────────
test('throwAndDiameter: an unaimed fixture measures to the focus-height plane', () => {
  const L = { type: 'spotlight', position_ft: [0, 25, 0], direction_ft: [0, -1, 0], cone_angle: 0.2 };
  const r = throwAndDiameter(L, V);
  assert.equal(r.reason, 'ok');
  near(r.throwFt, 20);                        // 25 ft trim down to 5 ft focus height
});

// ── reason codes ─────────────────────────────────────────────────────────
test('reason not-calibrated: no position_ft', () => {
  assert.equal(throwAndDiameter({ type: 'spotlight', cone_angle: 0.2 }, V).reason, 'not-calibrated');
});

test('reason no-beam: a linear (cyc) fixture and a reflector', () => {
  assert.equal(throwAndDiameter({ type: 'linear', position_ft: [0, 5, 0], cone_angle: 0.2 }, V).reason, 'no-beam');
  assert.equal(throwAndDiameter({ type: 'reflector', position_ft: [0, 5, 0], cone_angle: 0.2 }, V).reason, 'no-beam');
});

test('reason no-beam: a hand-edited cone_angle of 0 or 90 degrees', () => {
  const base = { type: 'spotlight', position_ft: [0, 25, 0], direction_ft: [0, -1, 0] };
  assert.equal(throwAndDiameter({ ...base, cone_angle: 0 }, V).reason, 'no-beam');
  assert.equal(throwAndDiameter({ ...base, cone_angle: Math.PI / 2 }, V).reason, 'no-beam');
});

test('reason no-crossing: a flat shin never reaches the focus plane', () => {
  const L = { type: 'spotlight', position_ft: [-20, 5, 10], direction_ft: [1, 0, 0], cone_angle: 0.2 };
  assert.equal(throwAndDiameter(L, V).reason, 'no-crossing');
});

test('reason no-crossing: a near-parallel beam hits the plane outside the house', () => {
  // A shallow ray from a 25 ft trim: crosses y = 5 about 2000 ft downstage.
  const L = { type: 'spotlight', position_ft: [0, 25, 0], direction_ft: [0, -0.01, 1], cone_angle: 0.2 };
  assert.equal(throwAndDiameter(L, V).reason, 'no-crossing');
});

test('reason degenerate: the target sits on the fixture', () => {
  const L = { type: 'spotlight', position_ft: [0, 12, 5], target_ft: [0, 12, 5], cone_angle: 0.2 };
  assert.equal(throwAndDiameter(L, V).reason, 'degenerate');
});

test('reason no-venue: an unaimed fixture with no venue', () => {
  const L = { type: 'spotlight', position_ft: [0, 25, 0], direction_ft: [0, -1, 0], cone_angle: 0.2 };
  assert.equal(throwAndDiameter(L, null).reason, 'no-venue');
});

test('an aimed fixture still reports numbers with no venue', () => {
  const L = { type: 'spotlight', position_ft: [0, 25, 0], target_ft: [0, 5, 0], cone_angle: 0.2 };
  assert.equal(throwAndDiameter(L, null).reason, 'ok');
});

// ── contract ─────────────────────────────────────────────────────────────
test('values are raw feet, never formatted, and ok has no tooltip', () => {
  const L = { type: 'spotlight', position_ft: [0, 25, 0], target_ft: [0, 5, 0], cone_angle: 0.2 };
  assert.equal(typeof throwAndDiameter(L, V).throwFt, 'number');
  assert.equal(reasonTooltip('ok'), '');
  assert.ok(reasonTooltip('no-crossing').length > 0);
});

test('distanceFt is a plain 3D euclidean distance', () => {
  near(distanceFt([0, 0, 0], [3, 4, 0]), 5);
});

// ── readoutCellText ──────────────────────────────────────────────────────
test('readoutCellText: an aimed fixture formats throw and diameter in the display unit', () => {
  const L = { type: 'spotlight', position_ft: [0, 25, 0], target_ft: [0, 5, 0], cone_angle: 0.2 };
  const V = { width_ft: 40, height_ft: 20, depth_ft: 30, focus_height_ft: 5 };
  assert.equal(readoutCellText(L, V, 'ft', 'throw').text, '20.0');
  assert.equal(readoutCellText(L, V, 'ft', 'throw').title, '');
  assert.equal(readoutCellText(L, V, 'm', 'throw').text, '6.1');
});

test('readoutCellText: a cyc shows an em dash and the reason tooltip', () => {
  const L = { type: 'linear', position_ft: [0, 5, 0], cone_angle: 0.2 };
  const V = { width_ft: 40, height_ft: 20, depth_ft: 30, focus_height_ft: 5 };
  const r = readoutCellText(L, V, 'ft', 'dia');
  assert.equal(r.text, '—');
  assert.ok(r.title.length > 0);
});
