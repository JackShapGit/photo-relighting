import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isTargeted, deriveDirection, targetSpawnPoint, applyTargeting, TARGET_SPAWN_DIST,
} from '../../src/targeting.js';

const close = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps;
const vclose = (a, b) => a.length === b.length && a.every((v, i) => close(v, b[i]));

test('isTargeted: only directional/spotlight with an array target', () => {
  assert.equal(isTargeted({ type: 'spotlight', target: [0, 0, 0] }), true);
  assert.equal(isTargeted({ type: 'directional', target: [1, 2, 3] }), true);
  assert.equal(isTargeted({ type: 'spotlight', target: null }), false);
  assert.equal(isTargeted({ type: 'spotlight' }), false);
  assert.equal(isTargeted({ type: 'point', target: [0, 0, 0] }), false);
  assert.equal(isTargeted({ type: 'reflector', target: [0, 0, 0] }), false);
});

test('deriveDirection: normalized target - position', () => {
  const L = { type: 'spotlight', position: [0, 0, 0], target: [0, 0, -2], direction: [1, 0, 0] };
  assert.ok(vclose(deriveDirection(L), [0, 0, -1]));
});

test('deriveDirection: degenerate target==position keeps existing direction', () => {
  const L = { type: 'spotlight', position: [0.5, 0.5, 1], target: [0.5, 0.5, 1], direction: [0.3, -0.2, -1] };
  assert.ok(vclose(deriveDirection(L), [0.3, -0.2, -1]));
});

test('deriveDirection: not targeted returns a copy of direction unchanged', () => {
  const dir = [0.1, 0.2, -0.97];
  const L = { type: 'spotlight', position: [0, 0, 0], target: null, direction: dir };
  const out = deriveDirection(L);
  assert.ok(vclose(out, dir));
  assert.notEqual(out, dir, 'returns a fresh array, not the same reference');
});

test('targetSpawnPoint then deriveDirection round-trips to the same direction', () => {
  const dir = [0.3, 0.3, -1];
  const n = Math.hypot(...dir);
  const unit = dir.map((c) => c / n);
  const L = { type: 'spotlight', position: [0.7, 0.3, 1.5], target: null, direction: dir };
  const tgt = targetSpawnPoint(L);
  const Lt = { ...L, target: tgt };
  assert.ok(vclose(deriveDirection(Lt), unit), 'beam does not jump on spawn');
  assert.ok(close(Math.hypot(tgt[0] - L.position[0], tgt[1] - L.position[1], tgt[2] - L.position[2]), TARGET_SPAWN_DIST));
});

test('applyTargeting: writes derived direction in place when targeted, no-op otherwise', () => {
  const L = { type: 'spotlight', position: [0, 0, 0], target: [0, 0, -5], direction: [1, 0, 0] };
  applyTargeting(L);
  assert.ok(vclose(L.direction, [0, 0, -1]));

  const F = { type: 'spotlight', position: [0, 0, 0], target: null, direction: [1, 0, 0] };
  applyTargeting(F);
  assert.ok(vclose(F.direction, [1, 0, 0]));
});
