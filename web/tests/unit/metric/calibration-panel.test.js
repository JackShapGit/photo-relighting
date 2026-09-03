import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as panelMod from '../../../src/metric/calibration-panel.js';
const { panelDims, readDim } = panelMod;
import { SYNTHETIC_VENUE } from '../../../src/rig/geometry.js';

const V = SYNTHETIC_VENUE;   // 40 × 20 × 30
const near = (a, b, t = 1e-9) => assert.ok(Math.abs(a - b) <= t, `${a} !~ ${b}`);

test('panelDims prefers the calibration record, then the venue, then blanks', () => {
  assert.deepEqual(panelDims({ width_ft: 50, height_ft: 22, depth_ft: 35 }, V), { width_ft: 50, height_ft: 22, depth_ft: 35, source: 'record' });
  assert.deepEqual(panelDims(null, V), { width_ft: 40, height_ft: 20, depth_ft: 30, source: 'venue' });
  assert.deepEqual(panelDims({ marks: {} }, V), { width_ft: 40, height_ft: 20, depth_ft: 30, source: 'venue' });
  assert.deepEqual(panelDims(null, null), { width_ft: null, height_ft: null, depth_ft: null, source: null });
});

test('readDim keeps the exact prefilled value while the field is untouched, parses an edit otherwise', () => {
  // A venue width of 40.25 ft shows as "40.3"; leaving it alone must not write 40.3 back.
  near(readDim('40.3', '40.3', 40.25, 'ft'), 40.25);
  near(readDim('41', '40.3', 40.25, 'ft'), 41);
  near(readDim('12.3', '12.3', 40.25, 'm'), 40.25);          // untouched, shown in meters
  near(readDim('12', '12.3', 40.25, 'm'), 12 / 0.3048);      // edited in meters → feet
  assert.ok(Number.isNaN(readDim('abc', '40.3', 40.25, 'ft')));
  assert.ok(Number.isNaN(readDim('', '', null, 'ft')), 'no prefill and nothing typed');
});

test('draftWarnings: opening-height mismatch > 10%, perspective ratio > 0.9, and a null depth fit each warn; a good camera is silent', () => {
  const { draftWarnings } = panelMod;
  const good = { height_check_pct: 4, perspective_ratio: 0.5 };
  assert.deepEqual(draftWarnings(good, undefined), []);
  assert.deepEqual(draftWarnings(null, null), [], 'no camera: nothing to warn about');
  const w1 = draftWarnings({ height_check_pct: 23.4, perspective_ratio: 0.5 }, undefined);
  assert.equal(w1.length, 1); assert.match(w1[0], /23%/); assert.match(w1[0], /top handle/);
  const w2 = draftWarnings({ height_check_pct: 0, perspective_ratio: 0.95 }, undefined);
  assert.equal(w2.length, 1); assert.match(w2[0], /back-line handles/);
  const w3 = draftWarnings(good, null);
  assert.equal(w3.length, 1); assert.match(w3[0], /no usable relief/);
  assert.equal(draftWarnings({ height_check_pct: 30, perspective_ratio: 0.99 }, null).length, 3);
});
