import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPlacement, LIGHT_STANDOFF } from '../../src/placement.js';

const close = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps;
const vclose = (a, b) => a.length === b.length && a.every((v, i) => close(v, b[i]));

function makeCtl() {
  const calls = { commit: [], update: [], remove: [], phase: [] };
  const ctl = createPlacement({
    commitLight: (L, at) => calls.commit.push({ L, at }),
    updateLight: (L) => calls.update.push(L),
    removeLight: (L) => calls.remove.push(L),
    onPhaseChange: (p) => calls.phase.push(p),
  });
  return { ctl, calls };
}

function spotlight() {
  return { id: 's1', type: 'spotlight', position: [0, 0, 0], direction: [0, 0, -1], target: null };
}

test('spotlight: click 1 places light with camera-ward standoff and commits', () => {
  const { ctl, calls } = makeCtl();
  const L = spotlight();
  ctl.begin(L, { parentArr: [], index: 0 });
  assert.equal(ctl.phase(), 'awaitingLight');
  ctl.acceptSurfacePoint([0.3, 0.4, 0.6]);
  assert.ok(vclose(L.position, [0.3, 0.4, 0.6 + LIGHT_STANDOFF]));
  assert.equal(calls.commit.length, 1);
  assert.equal(ctl.phase(), 'awaitingTarget');
});

test('spotlight: click 2 sets target and derives direction, then idle', () => {
  const { ctl, calls } = makeCtl();
  const L = spotlight();
  ctl.begin(L, { parentArr: [], index: 0 });
  ctl.acceptSurfacePoint([0.5, 0.5, 0.5]);
  ctl.acceptSurfacePoint([0.5, 0.5, 0.0]);
  assert.ok(vclose(L.target, [0.5, 0.5, 0.0]));
  assert.ok(vclose(L.direction, [0, 0, -1]));
  assert.equal(calls.update.length, 1);
  assert.equal(ctl.phase(), 'idle');
  assert.equal(ctl.isActive(), false);
});

test('point light: single click commits and finishes (no target)', () => {
  const { ctl, calls } = makeCtl();
  const L = { id: 'p1', type: 'point', position: [0, 0, 0], direction: [0, 0, -1] };
  ctl.begin(L, { parentArr: [], index: 0 });
  ctl.acceptSurfacePoint([0.2, 0.2, 0.4]);
  assert.equal(calls.commit.length, 1);
  assert.equal(L.target, undefined);
  assert.equal(ctl.phase(), 'idle');
});

test('cancel after click 1 removes the committed light', () => {
  const { ctl, calls } = makeCtl();
  const L = spotlight();
  ctl.begin(L, { parentArr: [], index: 0 });
  ctl.acceptSurfacePoint([0.5, 0.5, 0.5]);
  ctl.cancel();
  assert.equal(calls.remove.length, 1);
  assert.equal(ctl.phase(), 'idle');
});

test('cancel before click 1 removes nothing', () => {
  const { ctl, calls } = makeCtl();
  ctl.begin(spotlight(), { parentArr: [], index: 0 });
  ctl.cancel();
  assert.equal(calls.remove.length, 0);
  assert.equal(ctl.phase(), 'idle');
});

test('pendingLight exposes the in-progress light while awaiting target', () => {
  const { ctl } = makeCtl();
  const L = spotlight();
  ctl.begin(L, { parentArr: [], index: 0 });
  ctl.acceptSurfacePoint([0.5, 0.5, 0.5]);
  assert.equal(ctl.pendingLight(), L);
});

test('position z is clamped to the slider range [-2, 3]', () => {
  const { ctl } = makeCtl();
  const L = spotlight();
  ctl.begin(L, { parentArr: [], index: 0 });
  ctl.acceptSurfacePoint([0, 0, 5]);
  assert.ok(close(L.position[2], 3));
});
