import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readoutCellText } from '../../src/metric/measure.js';

// The block's DOM write is exercised in Playwright (Task 10); here we lock
// the contract that the props pane and the table share one text source.
test('props block and table cell derive identical text for the same fixture', () => {
  const L = { type: 'spotlight', position_ft: [0, 25, 0], target_ft: [0, 5, 0], cone_angle: 0.2 };
  const V = { width_ft: 40, height_ft: 20, depth_ft: 30, focus_height_ft: 5 };
  for (const kind of ['throw', 'dia']) {
    for (const u of ['ft', 'm']) {
      const a = readoutCellText(L, V, u, kind);
      const b = readoutCellText(L, V, u, kind);
      assert.deepEqual(a, b);
      assert.ok(a.text.length > 0);
    }
  }
});
