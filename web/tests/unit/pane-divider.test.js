import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MIN_PANE_WIDTH, MAX_PANE_FRACTION, DEFAULT_PANE_WIDTHS, LEFT_TAB_KEY,
  clampPaneWidth, resolveTabWidth, paneWidthKey, createPaneDivider,
} from '../../src/pane-divider.js';
import { createDragDivider } from '../../src/split-view.js';

// ── pure helpers ─────────────────────────────────────────────────────────

test('defaults: 220 px minimum, 60% of the window maximum, 260 / 580 per tab', () => {
  assert.equal(MIN_PANE_WIDTH, 220);
  assert.equal(MAX_PANE_FRACTION, 0.6);
  assert.deepEqual(DEFAULT_PANE_WIDTHS, { lights: 260, rig: 580 });
  assert.equal(LEFT_TAB_KEY, 'photo-relight:left-tab');
});

test('clampPaneWidth keeps the pane between 220 px and 60% of the window', () => {
  assert.equal(clampPaneWidth(300, 1600), 300);
  assert.equal(clampPaneWidth(100, 1600), 220);
  assert.equal(clampPaneWidth(-5, 1600), 220);
  assert.equal(clampPaneWidth(2000, 1600), 960);
  assert.equal(clampPaneWidth(960, 1600), 960);
  assert.equal(clampPaneWidth(961, 1600), 960);
});

test('clampPaneWidth on a window too narrow for the minimum still returns the minimum', () => {
  assert.equal(clampPaneWidth(300, 300), 220);      // 60% is 180 < 220
  assert.equal(clampPaneWidth(200, 0), 220);
  assert.equal(clampPaneWidth(200, NaN), 220);
});

test('clampPaneWidth rounds to whole pixels and treats garbage as the minimum', () => {
  assert.equal(clampPaneWidth(300.6, 1600), 301);
  assert.equal(clampPaneWidth(NaN, 1600), 220);
  assert.equal(clampPaneWidth(undefined, 1600), 220);
  assert.equal(clampPaneWidth('abc', 1600), 220);
});

test('resolveTabWidth uses a finite stored number, else the tab default', () => {
  assert.equal(resolveTabWidth('333', 'lights'), 333);
  assert.equal(resolveTabWidth(410, 'rig'), 410);
  assert.equal(resolveTabWidth(null, 'lights'), 260);
  assert.equal(resolveTabWidth(undefined, 'rig'), 580);
  assert.equal(resolveTabWidth('', 'rig'), 580);
  assert.equal(resolveTabWidth('abc', 'lights'), 260);
  assert.equal(resolveTabWidth('NaN', 'rig'), 580);
  assert.equal(resolveTabWidth('Infinity', 'rig'), 580);
  assert.equal(resolveTabWidth('0', 'lights'), 260, 'zero is not a usable width');
  assert.equal(resolveTabWidth('-40', 'lights'), 260);
});

test('resolveTabWidth falls back to the Lights default for an unknown tab', () => {
  assert.equal(resolveTabWidth(null, 'bogus'), 260);
  assert.equal(resolveTabWidth(null, undefined), 260);
});

test('paneWidthKey is per tab', () => {
  assert.equal(paneWidthKey('lights'), 'photo-relight:left-pane-width:lights');
  assert.equal(paneWidthKey('rig'), 'photo-relight:left-pane-width:rig');
});

// ── DOM-free stand-ins ───────────────────────────────────────────────────
// A minimal element: EventTarget + the bits the divider touches. No rAF in
// node, so createDragDivider must fall back to a synchronous flush.

class FakeEl extends EventTarget {
  constructor(rect = { left: 0, width: 6 }) {
    super();
    this.rect = rect;
    this.style = {};
    this.classList = { set: new Set(), add(c) { this.set.add(c); }, remove(c) { this.set.delete(c); }, contains(c) { return this.set.has(c); } };
    this.captured = null;
    this.ownerDocument = { body: { classList: { set: new Set(), add(c) { this.set.add(c); }, remove(c) { this.set.delete(c); }, contains(c) { return this.set.has(c); } } } };
  }
  getBoundingClientRect() { return { left: this.rect.left, width: this.rect.width, right: this.rect.left + this.rect.width }; }
  setPointerCapture(id) { this.captured = id; }
  releasePointerCapture() { this.captured = null; }
  hasPointerCapture(id) { return this.captured === id; }
}
const ptr = (type, clientX, extra = {}) => Object.assign(new Event(type), { clientX, button: 0, pointerId: 7, preventDefault() {}, ...extra });

class FakeStorage {
  constructor(init = {}) { this.map = new Map(Object.entries(init)); }
  getItem(k) { return this.map.has(k) ? this.map.get(k) : null; }
  setItem(k, v) { this.map.set(k, String(v)); }
}

test('createDragDivider: pointer down/move/up drives onDrag with the last x, then onEnd; dblclick resets', () => {
  const div = new FakeEl();
  const xs = []; let ends = 0, dbl = 0;
  const d = createDragDivider({
    dividerEl: div, onDrag: (x) => xs.push(x), onEnd: () => { ends += 1; }, onDblClick: () => { dbl += 1; },
  });
  div.dispatchEvent(ptr('pointerdown', 100));
  assert.equal(div.captured, 7, 'pointer captured');
  assert.ok(div.classList.contains('is-active'));
  assert.ok(div.ownerDocument.body.classList.contains('is-resizing-split'), 'body class while dragging');
  div.dispatchEvent(ptr('pointermove', 140));
  div.dispatchEvent(ptr('pointermove', 180));
  div.dispatchEvent(ptr('pointerup', 200));
  assert.deepEqual(xs.slice(-1), [200], 'the final x lands on release');
  assert.ok(xs.includes(140) || xs.includes(180), 'moves reached onDrag');
  assert.equal(ends, 1);
  assert.equal(div.captured, null, 'capture released');
  assert.ok(!div.classList.contains('is-active'));
  assert.ok(!div.ownerDocument.body.classList.contains('is-resizing-split'));
  div.dispatchEvent(ptr('pointermove', 999));
  assert.equal(xs.slice(-1)[0], 200, 'moves without a press are ignored');
  div.dispatchEvent(new Event('dblclick'));
  assert.equal(dbl, 1);
  d.destroy();
  div.dispatchEvent(ptr('pointerdown', 100));
  assert.equal(div.captured, null, 'destroyed: no capture');
});

test('createDragDivider: canStart gates the press and the double click; non-primary buttons ignored', () => {
  const div = new FakeEl();
  let allowed = false; let drags = 0, dbl = 0;
  createDragDivider({ dividerEl: div, canStart: () => allowed, onDrag: () => { drags += 1; }, onDblClick: () => { dbl += 1; } });
  div.dispatchEvent(ptr('pointerdown', 100));
  div.dispatchEvent(ptr('pointerup', 150));
  div.dispatchEvent(new Event('dblclick'));
  assert.equal(drags, 0); assert.equal(dbl, 0);
  allowed = true;
  div.dispatchEvent(ptr('pointerdown', 100, { button: 2 }));
  div.dispatchEvent(ptr('pointerup', 150));
  assert.equal(drags, 0, 'right button does not drag');
  div.dispatchEvent(ptr('pointerdown', 100));
  div.dispatchEvent(ptr('pointerup', 150));
  div.dispatchEvent(new Event('dblclick'));
  assert.equal(drags, 1); assert.equal(dbl, 1);
});

test('createPaneDivider: width from storage per tab, applied to the pane, persisted on drag end, resize dispatched', () => {
  const pane = new FakeEl({ left: 0, width: 260 });
  const div = new FakeEl({ left: 260, width: 6 });
  const storage = new FakeStorage({ 'photo-relight:left-pane-width:rig': '600' });
  let tab = 'lights'; const layouts = [];
  const pd = createPaneDivider({
    paneEl: pane, dividerEl: div, getTab: () => tab, storage, windowWidth: () => 1600,
    onLayout: (w) => layouts.push(w),
  });
  assert.equal(pane.style.width, '260px', 'Lights default');
  assert.equal(pd.getWidth(), 260);
  tab = 'rig'; pd.applyTab('rig');
  assert.equal(pane.style.width, '600px', 'stored Rig width');
  assert.equal(layouts.slice(-1)[0], 600);
  // Drag the divider: the pane ends where the pointer is (minus the pane's left edge).
  div.dispatchEvent(ptr('pointerdown', 603));
  div.dispatchEvent(ptr('pointermove', 700));
  div.dispatchEvent(ptr('pointerup', 700));
  assert.equal(pane.style.width, '700px');
  assert.equal(storage.getItem('photo-relight:left-pane-width:rig'), '700', 'persisted on release');
  assert.equal(storage.getItem('photo-relight:left-pane-width:lights'), null, 'Lights untouched');
  // Clamped: past 60% of a 1600 window.
  div.dispatchEvent(ptr('pointerdown', 700));
  div.dispatchEvent(ptr('pointerup', 1500));
  assert.equal(pane.style.width, '960px');
  assert.equal(storage.getItem('photo-relight:left-pane-width:rig'), '960');
  // Below the minimum.
  div.dispatchEvent(ptr('pointerdown', 960));
  div.dispatchEvent(ptr('pointerup', 10));
  assert.equal(pane.style.width, '220px');
  // Back to Lights restores its own width; double click resets the current tab to its default.
  tab = 'lights'; pd.applyTab('lights');
  assert.equal(pane.style.width, '260px');
  pd.setWidth(400);
  assert.equal(storage.getItem('photo-relight:left-pane-width:lights'), '400');
  div.dispatchEvent(new Event('dblclick'));
  assert.equal(pane.style.width, '260px');
  assert.equal(storage.getItem('photo-relight:left-pane-width:lights'), '260');
  pd.destroy();
});
