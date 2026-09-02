// Rig-mode tree (Spec 2 §Lights tab): in a calibrated scene with a venue the
// lights tree is generated — one group per hanging position in venue order,
// then "Custom" for emitters that hang nowhere, then reflectors at top level.
// Group nodes are derived every render; the light nodes are the very same
// objects, so edits through the tree land on the lights.
export const CUSTOM_GROUP_ID = 'custom';
export const RIG_GROUP_TOOLTIP = 'Groups follow hang positions in a calibrated scene';

export function rigMode(state) {
  return !!(state?.calibration?.camera && state?.venue);
}

export function positionGroupId(positionId) { return `pos:${positionId}`; }

/**
 * @param {object[]} lights   flat light list (state.lights)
 * @param {object} venue      the scene's venue (positions in display order)
 * @param {object[]} [prevTree] previous tree, to carry collapsed state by group id
 */
export function buildRigTree(lights, venue, prevTree = null) {
  const collapsed = new Map();
  for (const n of prevTree || []) if (n.kind === 'group') collapsed.set(n.id, !!n.collapsed);
  const group = (id, name, children) => ({
    kind: 'group', id, name,
    enabled: children.every((c) => c.enabled !== false),   // derived, never persisted as truth
    collapsed: collapsed.get(id) || false,
    children,
  });
  const all = lights || [];
  const emitters = all.filter((L) => L.type !== 'reflector');
  const reflectors = all.filter((L) => L.type === 'reflector');
  const positions = venue?.positions || [];
  const known = new Set(positions.map((p) => p.id));
  const tree = positions.map((p) => group(positionGroupId(p.id), p.name, emitters.filter((L) => L.fixture?.position_id === p.id)));
  tree.push(group(CUSTOM_GROUP_ID, 'Custom', emitters.filter((L) => !L.fixture?.position_id || !known.has(L.fixture.position_id))));
  tree.push(...reflectors);
  return tree;
}
