/** Diff two `state.lights` snapshots and return the operations needed to
 * reconcile a scene's primitives with the new list.
 *
 * Each op is one of:
 *   { kind: 'add', light }
 *   { kind: 'remove', id }
 *   { kind: 'update', light }
 *
 * Operations are emitted in a stable order: removes first, then adds, then
 * updates, so the consumer can apply them in one pass without conflicts.
 */

export function diffLights(prevList, nextList) {
  const prevById = new Map(prevList.map((l) => [l.id, l]));
  const nextById = new Map(nextList.map((l) => [l.id, l]));
  const ops = [];

  for (const id of prevById.keys()) {
    if (!nextById.has(id)) ops.push({ kind: 'remove', id });
  }
  for (const [id, light] of nextById) {
    if (!prevById.has(id)) ops.push({ kind: 'add', light });
  }
  for (const [id, light] of nextById) {
    const prev = prevById.get(id);
    if (!prev) continue;
    if (!shallowLightEqual(prev, light)) ops.push({ kind: 'update', light });
  }
  return ops;
}

function shallowLightEqual(a, b) {
  if (a === b) return true;
  if (a.type !== b.type) return false;
  if (!arrayEq(a.position, b.position)) return false;
  if (!arrayEq(a.direction, b.direction)) return false;
  if (!arrayEq(a.color, b.color)) return false;
  if ((a.cone_angle ?? null) !== (b.cone_angle ?? null)) return false;
  if ((a.intensity ?? null) !== (b.intensity ?? null)) return false;
  if ((a.enabled ?? true) !== (b.enabled ?? true)) return false;
  if (!arrayEq(a.normal, b.normal)) return false;
  if (!arrayEq(a.size, b.size)) return false;
  if ((a.reflectance ?? null) !== (b.reflectance ?? null)) return false;
  if ((a.roughness ?? null) !== (b.roughness ?? null)) return false;
  return true;
}

function arrayEq(a, b) {
  if (a === b) return true;           // both undefined / same reference
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false;
  return true;
}

// ─── Scene apply-ops ─────────────────────────────────────────────────────

import { buildLightPrimitive, disposeLightPrimitive } from './light-primitives.js';

/** Apply a list of diff ops to a scene's primitive registry.
 *
 * `primitives` is a Map<lightId, primitiveObject> that this helper mutates.
 * `scene` is the THREE.Scene to add new primitives into.
 */
export function applyOps(scene, primitives, ops) {
  for (const op of ops) {
    if (op.kind === 'remove') {
      const p = primitives.get(op.id);
      if (p) {
        disposeLightPrimitive(p);
        primitives.delete(op.id);
      }
    } else if (op.kind === 'add') {
      const p = buildLightPrimitive(op.light);
      primitives.set(op.light.id, p);
      scene.add(p.group);
    } else if (op.kind === 'update') {
      const p = primitives.get(op.light.id);
      if (p) p.update(op.light);
    }
  }
}

export function setSelected(primitives, selectedId) {
  for (const [id, p] of primitives) {
    p.outline.visible = (id === selectedId);
  }
}

// ─── Inline self-test (dev-mode only) ────────────────────────────────────

function _assert(cond, msg) {
  if (!cond) throw new Error(`[sync-assert] ${msg}`);
}

if (typeof window !== 'undefined' && window.location.hostname === 'localhost') {
  const L = (id, pos = [0, 0, 0]) => ({
    id, type: 'point', position: pos, direction: [0, 0, 1], color: [1, 1, 1],
  });

  // Empty → empty: no ops.
  _assert(diffLights([], []).length === 0, 'empty-empty should be no-op');

  // Add: one add op.
  const adds = diffLights([], [L('a')]);
  _assert(adds.length === 1 && adds[0].kind === 'add' && adds[0].light.id === 'a',
          `add: got ${JSON.stringify(adds)}`);

  // Remove: one remove op.
  const rms = diffLights([L('a')], []);
  _assert(rms.length === 1 && rms[0].kind === 'remove' && rms[0].id === 'a',
          `remove: got ${JSON.stringify(rms)}`);

  // Position change: one update op.
  const ups = diffLights([L('a', [0, 0, 0])], [L('a', [1, 0, 0])]);
  _assert(ups.length === 1 && ups[0].kind === 'update' && ups[0].light.id === 'a',
          `update: got ${JSON.stringify(ups)}`);

  // Unchanged: no ops.
  const same = diffLights([L('a')], [L('a')]);
  _assert(same.length === 0, `unchanged: got ${JSON.stringify(same)}`);
}
