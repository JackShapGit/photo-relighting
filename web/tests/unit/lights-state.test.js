import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newState } from '../../src/lights.js';

// Calibration cube: the latest history entry is persisted as
// state.calibration_undo so one Undo survives a reload; a fresh state has none.
test('newState carries calibration_undo: null (persisted undo entry slot)', () => {
  const s = newState();
  assert.ok('calibration_undo' in s, 'field exists');
  assert.equal(s.calibration_undo, null);
});
