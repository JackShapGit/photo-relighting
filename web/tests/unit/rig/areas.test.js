import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cellCorners, cellBounds } from '../../../src/rig/areas.js';
import { SYNTHETIC_VENUE, areaCenter, areaLabels } from '../../../src/rig/geometry.js';

const V = SYNTHETIC_VENUE;   // 40 × 20 × 30, 3 × 3, house numbering
const near = (a, b, t = 1e-9) => assert.ok(Math.abs(a - b) <= t, `${a} !~ ${b}`);
const vnear = (a, b) => { assert.equal(a.length, b.length); a.forEach((v, i) => near(v, b[i])); };

test('cellCorners: area 1 is the downstage audience-left cell, corners downstage-left first then clockwise from the house', () => {
  const c = cellCorners(V, '1');
  assert.equal(c.length, 4);
  vnear(c[0], [-20, 0, 0]);          // downstage-left (lip, −X)
  vnear(c[1], [-20, 0, 10]);         // upstage-left
  vnear(c[2], [-20 + 40 / 3, 0, 10]); // upstage-right
  vnear(c[3], [-20 + 40 / 3, 0, 0]);  // downstage-right
});

test('cellCorners: area 5 is the centre cell and area 9 the upstage audience-right cell', () => {
  const c5 = cellCorners(V, '5');
  vnear(c5[0], [-20 / 3, 0, 10]); vnear(c5[2], [20 / 3, 0, 20]);
  const c9 = cellCorners(V, '9');
  vnear(c9[0], [20 / 3, 0, 20]); vnear(c9[2], [20, 0, 30]);
});

test('cellCorners: every cell centre matches areaCenter on the deck (y = 0) for 3×3 and 4×5', () => {
  for (const venue of [V, { ...V, width_ft: 50, depth_ft: 36, grid: { rows: 4, cols: 5, number_from_stage_left: false } }]) {
    for (const label of areaLabels(venue.grid)) {
      const c = cellCorners(venue, label);
      const cx = (c[0][0] + c[2][0]) / 2, cz = (c[0][2] + c[2][2]) / 2;
      const [X, , Z] = areaCenter(venue, label);
      near(cx, X); near(cz, Z);
      assert.ok(c.every((p) => p[1] === 0));
      assert.ok(c[1][2] > c[0][2] && c[2][0] > c[1][0], 'clockwise from the house: up, then right');
    }
  }
});

test('cellCorners mirrors the columns when numbering from stage left', () => {
  const M = { ...V, grid: { ...V.grid, number_from_stage_left: true } };
  const c = cellCorners(M, '1');
  vnear(c[0], [20 - 40 / 3, 0, 0]);   // audience-right column now carries label 1
  vnear(c[2], [20, 0, 10]);
  vnear(cellCorners(M, '3')[0], [-20, 0, 0]);
  vnear(cellCorners(M, '5')[0], cellCorners(V, '5')[0], 'the centre column is its own mirror');
});

test('cellCorners returns null for labels outside the grid; cellBounds gives the cell rectangle', () => {
  assert.equal(cellCorners(V, '0'), null);
  assert.equal(cellCorners(V, '10'), null);
  assert.equal(cellCorners(V, 'x'), null);
  const b = cellBounds(V, '2');
  near(b.x0, -20 / 3); near(b.x1, 20 / 3); near(b.z0, 0); near(b.z1, 10);
});
