import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildRigTree, rigMode, CUSTOM_GROUP_ID } from '../../../src/rig/tree-mirror.js';
import { SYNTHETIC_VENUE } from '../../../src/rig/geometry.js';

const V = SYNTHETIC_VENUE;
const light = (id, position_id, enabled = true) => ({ kind: 'light', id, name: id, type: 'spotlight', enabled, fixture: { type: 'ers', position_id, offset_ft: 0, area: null } });

test('rigMode needs a solved calibration and a venue', () => {
  assert.equal(rigMode({ calibration: null, venue: V }), false);
  assert.equal(rigMode({ calibration: { camera: {} }, venue: null }), false);
  assert.equal(rigMode({ calibration: { camera: {} }, venue: V }), true);
});

test('groups follow venue order, Custom comes last, reflectors stay top-level, identity is preserved', () => {
  const a = light('a', 'p_1e'), b = light('b', 'p_foh'), c = light('c', null), d = { kind: 'light', id: 'd', name: 'd', type: 'point', enabled: true };
  const r = { kind: 'light', id: 'r', name: 'r', type: 'reflector', enabled: true };
  const tree = buildRigTree([a, b, c, d, r], V);
  const groups = tree.filter((n) => n.kind === 'group');
  assert.deepEqual(groups.map((g) => g.id), ['pos:p_foh', 'pos:p_1e', 'pos:p_2e', 'pos:p_3e', 'pos:p_bsr', 'pos:p_bsl', CUSTOM_GROUP_ID]);
  assert.deepEqual(groups.map((g) => g.name), ['FOH', '1E', '2E', '3E', 'BSR', 'BSL', 'Custom']);
  assert.equal(groups[0].children[0], b, 'same object, not a copy');
  assert.equal(groups[1].children[0], a);
  assert.deepEqual(groups[6].children, [c, d], 'unpositioned and fixture-less emitters are Custom');
  assert.equal(tree[tree.length - 1], r, 'reflector after the groups at top level');
  assert.ok(groups.slice(2, 6).every((g) => g.children.length === 0), 'empty positions are still shown');
});

test('group enabled is derived from the children; empty groups read as enabled', () => {
  const on = light('on', 'p_1e'), off = light('off', 'p_1e', false);
  const tree = buildRigTree([on, off], V);
  const g1e = tree.find((n) => n.id === 'pos:p_1e');
  assert.equal(g1e.enabled, false);
  assert.equal(tree.find((n) => n.id === 'pos:p_2e').enabled, true);
  off.enabled = true;
  assert.equal(buildRigTree([on, off], V).find((n) => n.id === 'pos:p_1e').enabled, true);
});

test('collapsed state carries over from the previous tree by group id', () => {
  const a = light('a', 'p_1e');
  const first = buildRigTree([a], V);
  first.find((n) => n.id === 'pos:p_1e').collapsed = true;
  const second = buildRigTree([a], V, first);
  assert.equal(second.find((n) => n.id === 'pos:p_1e').collapsed, true);
  assert.equal(second.find((n) => n.id === 'pos:p_2e').collapsed, false);
});
