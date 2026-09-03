import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_RATIO,
  DIVIDER_PX,
  MIN_PANE_PX,
  computeSplitRatio,
  clampRatio,
  modeVisibility,
  normalizeMode,
  migrateMode,
  resolveInitialRatio,
} from '../../src/split-view.js';

const close = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps;

// ── defaults ────────────────────────────────────────────────────────────
test('DEFAULT_RATIO is exactly 0.5', () => {
  assert.equal(DEFAULT_RATIO, 0.5);
});

test('resolveInitialRatio returns 0.5 when nothing is saved', () => {
  assert.equal(resolveInitialRatio(null), 0.5);
  assert.equal(resolveInitialRatio(undefined), 0.5);
  assert.equal(resolveInitialRatio(''), 0.5);
});

test('resolveInitialRatio returns 0.5 for non-numeric values', () => {
  assert.equal(resolveInitialRatio('abc'), 0.5);
  assert.equal(resolveInitialRatio('NaN'), 0.5);
  assert.equal(resolveInitialRatio('Infinity'), 0.5);
});

test('resolveInitialRatio clamps out-of-range values instead of resetting', () => {
  assert.equal(resolveInitialRatio('0'), 0.05);
  assert.equal(resolveInitialRatio('0.03'), 0.05);
  assert.equal(resolveInitialRatio('1'), 0.95);
  assert.equal(resolveInitialRatio('-0.3'), 0.05);
  assert.equal(resolveInitialRatio('1.7'), 0.95);
  assert.equal(resolveInitialRatio('0.08'), 0.08);
});

test('clampRatio clamps to 0.05-0.95 and only resets non-finite input', () => {
  assert.equal(clampRatio(0.5), 0.5);
  assert.equal(clampRatio(0.08), 0.08);
  assert.equal(clampRatio(0.92), 0.92);
  assert.equal(clampRatio(0.01), 0.05);
  assert.equal(clampRatio(0.99), 0.95);
  assert.equal(clampRatio(-4), 0.05);
  assert.equal(clampRatio(42), 0.95);
  assert.equal(clampRatio(NaN), 0.5);
  assert.equal(clampRatio(Infinity), 0.5);
  assert.equal(clampRatio(undefined), 0.5);
});

test('resolveInitialRatio passes through a valid saved ratio', () => {
  assert.equal(resolveInitialRatio('0.35'), 0.35);
  assert.equal(resolveInitialRatio(0.7), 0.7);
});

// ── computeSplitRatio ───────────────────────────────────────────────────
// Stage of 1006px: usable width is 1000px once the 6px divider is removed.
const wide = { stageLeft: 100, stageWidth: 1000 + DIVIDER_PX };

test('computeSplitRatio maps the pointer to the usable width (minus divider)', () => {
  assert.ok(close(computeSplitRatio({ ...wide, clientX: 600 }), 0.5));
  assert.ok(close(computeSplitRatio({ ...wide, clientX: 400 }), 0.3));
  assert.ok(close(computeSplitRatio({ ...wide, clientX: 850 }), 0.75));
});

test('computeSplitRatio clamps so the 2D pane keeps at least MIN_PANE_PX', () => {
  const r = computeSplitRatio({ ...wide, clientX: 100 + 50 });
  assert.ok(close(r, MIN_PANE_PX / 1000));
  const r2 = computeSplitRatio({ ...wide, clientX: -5000 });
  assert.ok(close(r2, MIN_PANE_PX / 1000));
});

test('computeSplitRatio clamps so the 3D pane keeps at least MIN_PANE_PX', () => {
  const r = computeSplitRatio({ ...wide, clientX: 100 + 950 });
  assert.ok(close(r, 1 - MIN_PANE_PX / 1000));
  const r2 = computeSplitRatio({ ...wide, clientX: 99999 });
  assert.ok(close(r2, 1 - MIN_PANE_PX / 1000));
});

test('computeSplitRatio honours a custom minPx', () => {
  const r = computeSplitRatio({ ...wide, clientX: 100, minPx: 100 });
  assert.ok(close(r, 0.1));
});

test('computeSplitRatio uses a proportional minimum on a narrow stage', () => {
  // 400px usable: 200px min per pane would leave no room, so fall back to 20%.
  const narrow = { stageLeft: 0, stageWidth: 400 + DIVIDER_PX };
  assert.ok(close(computeSplitRatio({ ...narrow, clientX: 0 }), 0.2));
  assert.ok(close(computeSplitRatio({ ...narrow, clientX: 400 }), 0.8));
  assert.ok(close(computeSplitRatio({ ...narrow, clientX: 200 }), 0.5));
});

test('computeSplitRatio on a wide stage reaches below 0.1 and survives clampRatio', () => {
  // usable 2500px: 200px min pane is 0.08, which used to snap back to 0.5.
  const ultrawide = { stageLeft: 0, stageWidth: 2500 + DIVIDER_PX };
  const left = computeSplitRatio({ ...ultrawide, clientX: -100 });
  assert.ok(close(left, 0.08));
  assert.ok(close(clampRatio(left), 0.08));
  const right = computeSplitRatio({ ...ultrawide, clientX: 9999 });
  assert.ok(close(right, 0.92));
  assert.ok(close(clampRatio(right), 0.92));
});

test('computeSplitRatio returns the default for degenerate input', () => {
  assert.equal(computeSplitRatio({ clientX: 10, stageLeft: 0, stageWidth: 0 }), 0.5);
  assert.equal(computeSplitRatio({ clientX: 10, stageLeft: 0, stageWidth: DIVIDER_PX }), 0.5);
  assert.equal(computeSplitRatio({ clientX: NaN, ...wide }), 0.5);
  assert.equal(computeSplitRatio({ clientX: 10, stageLeft: NaN, stageWidth: 800 }), 0.5);
});

// ── modeVisibility ──────────────────────────────────────────────────────
test('modeVisibility for each mode', () => {
  assert.deepEqual(modeVisibility('2d'), { show2d: true, show3d: false, showDivider: false });
  assert.deepEqual(modeVisibility('split'), { show2d: true, show3d: true, showDivider: true });
  assert.deepEqual(modeVisibility('3d'), { show2d: false, show3d: true, showDivider: false });
});

test('modeVisibility falls back to split for unknown modes', () => {
  assert.deepEqual(modeVisibility('bogus'), modeVisibility('split'));
  assert.deepEqual(modeVisibility(undefined), modeVisibility('split'));
});

// ── mode normalisation / migration ──────────────────────────────────────
test('normalizeMode accepts the three modes and defaults to split', () => {
  assert.equal(normalizeMode('2d'), '2d');
  assert.equal(normalizeMode('split'), 'split');
  assert.equal(normalizeMode('3d'), '3d');
  assert.equal(normalizeMode('nope'), 'split');
  assert.equal(normalizeMode(null), 'split');
});

test('migrateMode maps the legacy show-3d key when no new key exists', () => {
  assert.equal(migrateMode({ stored: null, legacyShow3d: '0' }), '2d');
  assert.equal(migrateMode({ stored: null, legacyShow3d: '1' }), 'split');
  assert.equal(migrateMode({ stored: null, legacyShow3d: null }), 'split');
});

test('migrateMode prefers the new key over the legacy one', () => {
  assert.equal(migrateMode({ stored: '3d', legacyShow3d: '0' }), '3d');
  assert.equal(migrateMode({ stored: 'split', legacyShow3d: '0' }), 'split');
  assert.equal(migrateMode({ stored: 'garbage', legacyShow3d: '0' }), 'split');
});
