import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMarking, MARK_ORDER, MARK_LABELS } from '../../../src/metric/marking.js';

test('marks are assigned in order and done after five', () => {
  const m = createMarking();
  assert.equal(m.current, 'lipL');
  m.next(0.1, 0.6); m.next(0.9, 0.6); m.next(0.5, 0.1); m.next(0.2, 0.5);
  assert.equal(m.current, 'backR'); assert.equal(m.done, false);
  m.next(0.8, 0.5);
  assert.equal(m.done, true); assert.equal(m.current, null);
  assert.deepEqual(Object.keys(m.marks), MARK_ORDER);
});

test('undo removes the last mark and reopens it', () => {
  const m = createMarking();
  m.next(0.1, 0.6); m.next(0.9, 0.6);
  m.undo();
  assert.equal(m.current, 'lipR'); assert.equal('lipR' in m.marks, false);
  m.undo(); m.undo();               // extra undo is a no-op
  assert.equal(m.current, 'lipL');
});

test('cancel restores the initial marks', () => {
  const init = { lipL: [0.1, 0.6] };
  const m = createMarking(init);
  m.next(0.9, 0.6);
  m.cancel();
  assert.deepEqual(m.marks, init);
  assert.equal(m.current, 'lipR');
});

test('every key has a label', () => {
  for (const k of MARK_ORDER) assert.equal(typeof MARK_LABELS[k], 'string');
});
