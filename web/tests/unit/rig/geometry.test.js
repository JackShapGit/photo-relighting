import { test } from 'node:test';
import assert from 'node:assert/strict';
import { positionToWorld, nearestOffset, areaLabels, areaCenter, linearEndpoints, starterPositions, defaultFixtureName, mergeVenueIntoCalibration, SYNTHETIC_VENUE } from '../../../src/rig/geometry.js';
const near = (a, b, t = 1e-9) => assert.ok(Math.abs(a - b) <= t, `${a} !~ ${b}`);
const V = SYNTHETIC_VENUE;
const pos = (name) => V.positions.find((p) => p.name === name);

test('pipe, boom, floor map to world feet', () => {
  assert.deepEqual(positionToWorld(pos('1E'), 4), [4, 20, 6]);
  assert.deepEqual(positionToWorld(pos('FOH'), -10), [-10, 22, -52]);
  assert.deepEqual(positionToWorld(pos('BSR'), 12), [-22, 12, 8]);
  assert.deepEqual(positionToWorld({ kind: 'floor', upstage_ft: 28 }, 3), [3, 0.5, 28]);
});

test('nearestOffset projects onto the pipe or boom axis', () => {
  near(nearestOffset(pos('1E'), [7.5, 18, 9]), 7.5);
  near(nearestOffset(pos('BSL'), [20, 9.25, 7]), 9.25);
});

test('area labels and centers, house-view numbering', () => {
  assert.deepEqual(areaLabels({ rows: 3, cols: 3 }), ['1','2','3','4','5','6','7','8','9']);
  // 40 wide: columns centred at -13.33, 0, 13.33; 30 deep: rows at 5, 15, 25
  const c1 = areaCenter(V, '1'); near(c1[0], -40/3, 1e-6); near(c1[1], 5); near(c1[2], 5);
  const c5 = areaCenter(V, '5'); near(c5[0], 0); near(c5[2], 15);
  const c9 = areaCenter(V, '9'); near(c9[0], 40/3, 1e-6); near(c9[2], 25);
  assert.equal(areaCenter(V, '10'), null);
});

test('number_from_stage_left mirrors columns', () => {
  const W = { ...V, grid: { rows: 3, cols: 3, number_from_stage_left: true } };
  near(areaCenter(W, '1')[0], 40/3, 1e-6);
  near(areaCenter(W, '3')[0], -40/3, 1e-6);
});

test('4x5 grid labels count and last cell', () => {
  const W = { ...V, grid: { rows: 4, cols: 5, number_from_stage_left: false } };
  assert.equal(areaLabels(W.grid).length, 20);
  const c = areaCenter(W, '20'); near(c[0], 16); near(c[2], 26.25);
});

test('linearEndpoints along X on a pipe and along Y on a boom', () => {
  assert.deepEqual(linearEndpoints(pos('3E'), 0, 4), [[-2, 20, 22], [2, 20, 22]]);
  assert.deepEqual(linearEndpoints(pos('BSL'), 10, 4), [[22, 8, 8], [22, 12, 8]]);
});

test('starterPositions scale with the venue', () => {
  const p = starterPositions({ width_ft: 40, height_ft: 20, depth_ft: 30 });
  assert.equal(p.length, 6);
  const foh = p.find((x) => x.name === 'FOH truss');
  near(foh.upstage_ft, -39); near(foh.trim_ft, 22);
  near(p.find((x) => x.name === '1st electric').upstage_ft, 6);
  near(p.find((x) => x.name === 'Boom SR').offset_ft, -22);
});

test('mergeVenueIntoCalibration mirrors the venue dimensions onto a copy of the calibration', () => {
  const cal = { version: 1, units: 'ft', width_ft: 40, height_ft: 20, depth_ft: 30, marks: { lipL: [0.1, 0.6] }, depth_fit: { a: -1, b: 2 }, depth_check: null };
  const venue = { id: 'v1', width_ft: 52, height_ft: 24, depth_ft: 36, positions: [] };
  const merged = mergeVenueIntoCalibration(cal, venue);
  assert.notEqual(merged, cal, 'returns a copy');
  assert.deepEqual([merged.width_ft, merged.height_ft, merged.depth_ft], [52, 24, 36]);
  assert.deepEqual([cal.width_ft, cal.height_ft, cal.depth_ft], [40, 20, 30], 'input untouched');
  assert.deepEqual(merged.marks, cal.marks); assert.deepEqual(merged.depth_fit, cal.depth_fit);
  // No venue (or no calibration): pass-through.
  assert.equal(mergeVenueIntoCalibration(cal, null), cal);
  assert.equal(mergeVenueIntoCalibration(null, venue), null);
});

test('defaultFixtureName uses a short position name', () => {
  assert.equal(defaultFixtureName({ name: '1st electric' }, 3), '1E-3');
  assert.equal(defaultFixtureName({ name: 'FOH truss' }, 1), 'FT-1');
  assert.equal(defaultFixtureName({ name: 'Boom SR' }, 2), 'BSR-2');
});
