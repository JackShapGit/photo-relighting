// Pure data model for the tree of lights and groups.
//
// state.tree    — source of truth: an ordered list of nodes at the root level.
//                 Each node is either a LightNode (kind: 'light') or a
//                 GroupNode (kind: 'group') which can recursively contain more
//                 of either.
// state.lights  — derived flat list of LightNodes in display order. Kept in
//                 sync via syncLights() after any tree mutation. The renderer,
//                 handles, and export all consume this flat list.
// state.selectedId — id of the currently-selected node. The literal SCENE_ID
//                    selects the scene-level controls.

export const SCENE_ID = '__scene__';
export const ADD_LIGHT_ID = '__add_light__';

// Stamp a new LightNode from a preset definition (see ./presets.js).
// Generates a fresh id; the preset's name/type/position/direction/Kelvin/etc.
// are copied through.
export function lightFromPreset(preset) {
  const L = {
    kind: 'light',
    id: newId(),
    name: preset.name,
    enabled: true,
    type: preset.fields.type,
    position: preset.fields.position.slice(),
    direction: preset.fields.direction.slice(),
    color: [1, 1, 1],
    color_temperature: preset.fields.color_temperature ?? 5500,
    gel_preset: null,
    intensity: preset.fields.intensity ?? 1.0,
    falloff: preset.fields.falloff ?? 1.0,
    cone_angle: preset.fields.cone_angle ?? 0.5,
    softness: preset.fields.softness ?? 0.1,
    gobo: null,
    affects: 'all',
  };
  return L;
}

export function newId() {
  return (crypto.randomUUID && crypto.randomUUID()) ||
    Math.random().toString(36).slice(2) + Date.now().toString(36);
}

export function defaultLight(slot) {
  // z>0 = behind the scene (per spec §4.2), z<0 = camera-side.
  // For a default-facing surface (normal +z), lights must be positioned/aimed
  // so Lvec has positive z — i.e. point lights at z>1, directionals with dir.z<0.
  const presets = {
    key:  { type: 'spotlight',   position: [0.7, 0.3, 1.5], direction: [-0.3, 0.3, -1], intensity: 1.2, color: [1,1,1], kelvin: 5500, name: 'Key' },
    fill: { type: 'directional', position: [0.2, 0.5, -0.4], direction: [ 0.4, 0.0, -1], intensity: 0.5, color: [1,1,1], kelvin: 4500, name: 'Fill' },
    rim:  { type: 'spotlight',   position: [0.5, 0.5,  1.3], direction: [ 0.0,-0.2,-1], intensity: 1.0, color: [1,1,1], kelvin: 7000, name: 'Rim' },
  };
  const p = presets[slot] || presets.key;
  return {
    kind: 'light',
    id: newId(),
    name: p.name,
    enabled: true,
    type: p.type,
    position: p.position.slice(),
    direction: p.direction.slice(),
    color: p.color.slice(),
    color_temperature: p.kelvin,
    gel_preset: null,
    intensity: p.intensity,
    falloff: 1.0,
    cone_angle: 0.5,
    softness: 0.1,
    gobo: null,
    affects: 'all',
  };
}

export function newLightNode({ name = 'Light', type = 'directional' } = {}) {
  const L = defaultLight('fill');         // sensible fill-style defaults
  L.id = newId();
  L.name = name;
  L.type = type;
  return L;
}

export function newGroupNode({ name = 'Group' } = {}) {
  return {
    kind: 'group',
    id: newId(),
    name,
    enabled: true,
    collapsed: false,
    children: [],
  };
}

// ─── Tree helpers ─────────────────────────────────────────────────────────

export function flatLights(tree) {
  const out = [];
  const walk = (arr) => {
    for (const n of arr) {
      if (n.kind === 'light') out.push(n);
      else if (n.kind === 'group') walk(n.children);
    }
  };
  walk(tree);
  return out;
}

export function syncLights(state) {
  state.lights = flatLights(state.tree);
}

export function findNode(tree, id) {
  for (const n of tree) {
    if (n.id === id) return n;
    if (n.kind === 'group') {
      const r = findNode(n.children, id);
      if (r) return r;
    }
  }
  return null;
}

// Returns the children-array containing the given id (so callers can splice).
// Returns null if not found.
export function findParentArray(tree, id) {
  for (const n of tree) {
    if (n.id === id) return tree;
    if (n.kind === 'group') {
      const r = findParentArray(n.children, id);
      if (r) return r;
    }
  }
  return null;
}

// Recursively cascade a group's enabled flag onto every descendant light.
// Called when the user toggles a group's eye icon — overwrites individual
// light enabled flags (per the user's spec: "still individually overridable
// when you re-toggle").
export function cascadeEnabled(group) {
  for (const child of group.children) {
    child.enabled = group.enabled;
    if (child.kind === 'group') cascadeEnabled(child);
  }
}

// Remove a node by id. Returns true if found+removed.
export function deleteNode(tree, id) {
  for (let i = 0; i < tree.length; i++) {
    if (tree[i].id === id) { tree.splice(i, 1); return true; }
    if (tree[i].kind === 'group' && deleteNode(tree[i].children, id)) return true;
  }
  return false;
}

// Deep-clone a node, generating fresh ids throughout. Top-level node gets the
// supplied suffix appended to its name; descendants keep their names.
export function cloneNode(node, suffix = ' Copy') {
  if (node.kind === 'light') {
    const copy = JSON.parse(JSON.stringify(node));
    copy.id = newId();
    copy.name = `${node.name}${suffix}`;
    return copy;
  }
  return {
    kind: 'group',
    id: newId(),
    name: `${node.name}${suffix}`,
    enabled: node.enabled,
    collapsed: node.collapsed,
    children: node.children.map((c) => cloneNode(c, '')),
  };
}

// Check if `targetArr` is the children-array of `nodeId` or any of its
// descendants. Used to prevent dragging a group into itself.
export function isInsideNode(tree, nodeId, targetArr) {
  const node = findNode(tree, nodeId);
  if (!node || node.kind !== 'group') return false;
  if (node.children === targetArr) return true;
  for (const child of node.children) {
    if (child.kind === 'group' && isInsideNode([child], child.id, targetArr)) return true;
  }
  return false;
}

// Move node `id` to position `targetIdx` of `targetArr`. Splice-aware: if
// the move is within the same array and we're removing before the target,
// the index is decremented. Returns false on no-op or cycle.
export function moveNode(tree, id, targetArr, targetIdx) {
  const node = findNode(tree, id);
  if (!node) return false;
  if (node.kind === 'group' && isInsideNode(tree, id, targetArr)) return false;
  const parent = findParentArray(tree, id);
  if (!parent) return false;
  const fromIdx = parent.indexOf(node);
  let toIdx = targetIdx;
  if (parent === targetArr && fromIdx < toIdx) toIdx -= 1;
  parent.splice(fromIdx, 1);
  targetArr.splice(toIdx, 0, node);
  return true;
}

// ─── Initial state ────────────────────────────────────────────────────────

// Persisted-state portion of newState() — the bits saved into the DB and
// reloaded by applyScene. Used when creating a brand-new scene so we don't
// carry the current scene's tree/ambient over.
export function defaultSceneState() {
  const key = defaultLight('key');
  const rim = defaultLight('rim');
  return {
    tree: [key, rim],
    ambient: 0.2,
    debugView: 'render',
    shadowStyle: 'off',
    selectedId: key.id,
  };
}

export function newState() {
  const key = defaultLight('key');
  const rim = defaultLight('rim');
  // Default scene: Key + Rim. Rim sits dead-center pointing forward and
  // restores the "centered" feel users got from the original three-point setup;
  // Fill is omitted since it's the easiest to add back via + Light if needed.
  const tree = [key, rim];
  const state = {
    sessionId: null,
    width: 0,
    height: 0,
    assetUrls: null,
    tree,
    lights: [],                           // populated by syncLights below
    ambient: 0.2,
    debugView: 'render',
    shadowStyle: 'off',                   // 'off' | 'heightfield' | 'planar'
    subjectMedianDepth: 0.3,              // populated from prepare metadata
    selectedId: key.id,                   // Key still selected first
    theme: 'dark',
  };
  syncLights(state);
  return state;
}
