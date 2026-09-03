import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chunkEmitters, MAX_EMITTERS, MAX_LIGHTS_PER_PASS } from '../../../src/webgl/renderer.js';

const light = (i, enabled = true) => ({ id: `L${i}`, type: 'spotlight', enabled });
const many = (n, enabled = true) => Array.from({ length: n }, (_, i) => light(i, enabled));

test('constants: 8 per pass, 64 emitters total', () => {
  assert.equal(MAX_LIGHTS_PER_PASS, 8);
  assert.equal(MAX_EMITTERS, 64);
});

test('no enabled emitters → no chunks', () => {
  assert.deepEqual(chunkEmitters([]), []);
  assert.deepEqual(chunkEmitters(many(3, false)), []);
});

test('8 enabled → one chunk of 8; 9 → [8, 1]', () => {
  assert.deepEqual(chunkEmitters(many(8)).map((c) => c.length), [8]);
  assert.deepEqual(chunkEmitters(many(9)).map((c) => c.length), [8, 1]);
});

test('disabled lights are excluded and do not occupy slots', () => {
  const lights = [light(0), light(1, false), light(2), light(3, false), ...many(7).map((l, i) => ({ ...l, id: `M${i}` }))];
  const chunks = chunkEmitters(lights);
  assert.deepEqual(chunks.map((c) => c.length), [8, 1]);
  assert.ok(chunks.flat().every((l) => l.enabled));
  assert.deepEqual(chunks[0].slice(0, 2).map((l) => l.id), ['L0', 'L2']);
});

test('70 enabled → 8 chunks totalling 64 (defensive cap)', () => {
  const chunks = chunkEmitters(many(70));
  assert.equal(chunks.length, 8);
  assert.equal(chunks.reduce((n, c) => n + c.length, 0), 64);
  assert.ok(chunks.every((c) => c.length === 8));
});

test('reflectors are never chunked as emitters', () => {
  const chunks = chunkEmitters([light(0), { id: 'R', type: 'reflector', enabled: true }, light(1)]);
  assert.deepEqual(chunks.map((c) => c.map((l) => l.id)), [['L0', 'L1']]);
});
