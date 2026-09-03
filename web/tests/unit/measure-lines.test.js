import { test } from 'node:test';
import assert from 'node:assert/strict';
import { measureSegment } from '../../src/3d/measure-lines.js';

// Pure segment geometry for the 3D ruler (measure-overlay.js wraps this in
// THREE.Line/Sprite, which node cannot import). This is the regression guard
// for the whole task: without it, "simplifying" the overlay back to
// unconverted points would draw every measurement mirrored onto the
// audience side of the stage and nothing in the suite would fail.
const near = (a, b, t = 1e-9) => assert.ok(Math.abs(a - b) <= t, `${a} !~ ${b}`);
const vnear = (a, b) => { assert.equal(a.length, b.length); a.forEach((v, i) => near(v, b[i])); };

test('measureSegment: Z sign flips on both endpoints (world feet -> Three)', () => {
  const m = { a: [1, 2, 3], b: [4, 5, 6] };
  const s = measureSegment(m);
  vnear(s.a, [1, 2, -3]);
  vnear(s.b, [4, 5, -6]);
});

test('measureSegment: mid is the converted midpoint (the contract), which equals the midpoint of converted points only because the transform is linear', () => {
  const m = { a: [0, 0, 0], b: [10, 4, 20] };
  const s = measureSegment(m);
  vnear(s.mid, [5, 2, -10]);
});

test('measureSegment: lengthFt matches distanceFt on the raw, unconverted input', () => {
  const m = { a: [0, 0, 0], b: [3, 4, 0] };
  const s = measureSegment(m);
  near(s.lengthFt, 5);
});
