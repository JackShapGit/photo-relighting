import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stageBoxSegments, houseBoxSegments, BOX_EDGE_COUNT } from '../../src/3d/cube-lines.js';

// Pure vertex lists for the 3D wireframes (cube-3d.js wraps them in THREE
// objects, which node cannot import): 12 edges = 24 vertices = 72 numbers in
// the Three frame (x = X, y = Y, z = −Z).
const DIMS = { width_ft: 40, height_ft: 20, depth_ft: 30 };
const HOUSE = { left_wall_ft: -30, right_wall_ft: 30, floor_drop_ft: 3, ceiling_ft: 30, depth_ft: 60, estimated: true };
const near = (a, b, t = 1e-9) => assert.ok(Math.abs(a - b) <= t, `${a} !~ ${b}`);
const vnear = (a, b) => { assert.equal(a.length, b.length); a.forEach((v, i) => near(v, b[i])); };

test('stageBoxSegments: 24 vertices bounding [±W/2, 0..H, −D..0] in Three space', () => {
  const s = stageBoxSegments(DIMS);
  assert.equal(BOX_EDGE_COUNT, 12);
  assert.equal(s.positions.length, 24 * 3);
  vnear(s.bounds.min, [-20, 0, -30]);
  vnear(s.bounds.max, [20, 20, 0]);
  // Every vertex sits on a corner of the box.
  for (let i = 0; i < s.positions.length; i += 3) {
    assert.ok([-20, 20].includes(s.positions[i]) && [0, 20].includes(s.positions[i + 1]) && [0, -30].includes(s.positions[i + 2]));
  }
});

test('houseBoxSegments: walls, floor, ceiling and the house depth toward the camera (Three +z)', () => {
  const h = houseBoxSegments(HOUSE);
  assert.equal(h.positions.length, 72);
  vnear(h.bounds.min, [-30, -3, 0]);
  vnear(h.bounds.max, [30, 30, 60]);
});
