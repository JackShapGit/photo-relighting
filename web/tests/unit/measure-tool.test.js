import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMeasureTool } from '../../src/measure-tool.js';

const mk = () => { let n = 0; const t = createMeasureTool({ onChange: () => { n += 1; } }); return { t, calls: () => n }; };

test('idle by default: addPoint is ignored until armed', () => {
  const { t } = mk();
  assert.equal(t.phase(), 'idle');
  assert.equal(t.addPoint([0, 0, 0]), null);
  assert.equal(t.measurements().length, 0);
});

test('two points commit one measurement and rearm for the next', () => {
  const { t } = mk();
  t.arm();
  assert.equal(t.phase(), 'awaitingA');
  assert.equal(t.addPoint([0, 0, 0]), null);
  assert.equal(t.phase(), 'awaitingB');
  const m = t.addPoint([3, 4, 0]);
  assert.ok(m && m.id);
  assert.deepEqual(m.a, [0, 0, 0]);
  assert.deepEqual(m.b, [3, 4, 0]);
  assert.equal(t.phase(), 'awaitingA');       // stays armed (decision 8)
  assert.equal(t.measurements().length, 1);
});

test('measurements accumulate so several spans can be compared', () => {
  const { t } = mk();
  t.arm();
  t.addPoint([0, 0, 0]); t.addPoint([10, 0, 0]);
  t.addPoint([0, 0, 0]); t.addPoint([0, 0, 20]);
  assert.equal(t.measurements().length, 2);
});

test('cancel from awaitingB discards the partial but stays armed', () => {
  const { t } = mk();
  t.arm();
  t.addPoint([0, 0, 0]);
  t.cancel();
  assert.equal(t.phase(), 'awaitingA');
  assert.equal(t.pendingA(), null);
  assert.equal(t.measurements().length, 0);
});

test('near-identical endpoints are discarded rather than stored as a zero ruler', () => {
  const { t } = mk();
  t.arm();
  t.addPoint([1, 2, 3]);
  assert.equal(t.addPoint([1, 2, 3.001]), null);
  assert.equal(t.measurements().length, 0);
  assert.equal(t.phase(), 'awaitingA');
});

test('disarm drops any partial and leaves the list intact', () => {
  const { t } = mk();
  t.arm();
  t.addPoint([0, 0, 0]); t.addPoint([10, 0, 0]);
  t.addPoint([0, 0, 0]);
  t.disarm();
  assert.equal(t.phase(), 'idle');
  assert.equal(t.isArmed(), false);
  assert.equal(t.pendingA(), null);
  assert.equal(t.measurements().length, 1);
});

test('clear empties the list', () => {
  const { t } = mk();
  t.arm();
  t.addPoint([0, 0, 0]); t.addPoint([10, 0, 0]);
  t.clear();
  assert.equal(t.measurements().length, 0);
});

test('measurements() returns copies, not the internal records', () => {
  const { t } = mk();
  t.arm();
  t.addPoint([0, 0, 0]); t.addPoint([10, 0, 0]);
  t.measurements()[0].a[0] = 999;
  assert.equal(t.measurements()[0].a[0], 0);
  t.measurements()[0].b[0] = 999;
  assert.equal(t.measurements()[0].b[0], 10);
});

test('onChange fires on arm, each point, commit, cancel, clear and disarm', () => {
  const { t, calls } = mk();
  t.arm();                       // 1
  t.addPoint([0, 0, 0]);         // 2
  t.addPoint([10, 0, 0]);        // 3 commit
  t.addPoint([0, 0, 0]);         // 4
  t.cancel();                    // 5
  t.clear();                     // 6
  t.disarm();                    // 7
  assert.equal(calls(), 7);
});
