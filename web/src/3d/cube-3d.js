/** Calibration cube in the 3D viewport (calibration cube spec §3D): the
 * stage box and the house box as LineSegments wireframes in the feet frame,
 * the stage box in the UI accent, the house box in the house colour. Dashed
 * while the draft is dirty. Both sit at `offset` (Three space): the draft's
 * pose relative to the applied calibration, so a gizmo drag of the stage box
 * leaves it where it was dropped until Apply rebuilds the frame around it.
 */
import * as THREE from 'three';
import { stageBoxSegments, houseBoxSegments } from './cube-lines.js';

export const STAGE_BOX_NAME = 'stage-box';
export const HOUSE_BOX_NAME = 'house-box';
const STAGE_COLOR = 0x4a9eff;   // --accent
const HOUSE_COLOR = 0xf0a030;   // --house-color (amber)
const DASH = { dashSize: 1, gapSize: 0.6 };   // feet
const RENDER_ORDER = 6;         // above the cloud and the deck grid, below the rig labels (10)

function material(color, dirty) {
  const common = { color, transparent: true, opacity: 0.95, depthTest: false };
  return dirty ? new THREE.LineDashedMaterial({ ...common, ...DASH }) : new THREE.LineBasicMaterial(common);
}

function segments(name, seg, color, dirty) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(seg.positions, 3));
  const obj = new THREE.LineSegments(g, material(color, dirty));
  obj.name = name;
  obj.renderOrder = RENDER_ORDER;
  obj.userData.dirty = !!dirty;
  obj.userData.color = color;
  if (dirty) obj.computeLineDistances();
  return obj;
}

export function buildStageBox(dims, { dirty = false } = {}) {
  return segments(STAGE_BOX_NAME, stageBoxSegments(dims), STAGE_COLOR, dirty);
}

export function buildHouseBox(house, dims, { dirty = false } = {}) {
  void dims;   // the house is self-contained; dims kept for the interface
  return segments(HOUSE_BOX_NAME, houseBoxSegments(house), HOUSE_COLOR, dirty);
}

export function removeCubes(scene) {
  if (!scene) return;
  for (const name of [STAGE_BOX_NAME, HOUSE_BOX_NAME]) {
    // Every copy: a rebuild can race a scene load, like the rig overlay.
    for (const old of scene.children.filter((o) => o.name === name)) {
      scene.remove(old);
      old.geometry?.dispose?.();
      old.material?.dispose?.();
    }
  }
}

/** Replace both boxes (remove any existing by name first). */
export function updateCubes(scene, { dims, house, shown = { stage: true, house: true }, dirty = false, offset = [0, 0, 0] } = {}) {
  removeCubes(scene);
  if (!scene || !dims) return;
  const houseOk = !!house && Number.isFinite(house.left_wall_ft) && Number.isFinite(house.ceiling_ft);
  const objs = [];
  if (shown.stage) objs.push(buildStageBox(dims, { dirty }));
  if (shown.house && houseOk) objs.push(buildHouseBox(house, dims, { dirty }));
  for (const o of objs) {
    o.position.set(offset[0] || 0, offset[1] || 0, offset[2] || 0);
    scene.add(o);
  }
}

/** Restyle the boxes in place (while the stage box is being dragged, a rebuild would break the drag). */
export function styleCubes(scene, { dirty = false } = {}) {
  if (!scene) return;
  for (const name of [STAGE_BOX_NAME, HOUSE_BOX_NAME]) {
    const o = scene.getObjectByName(name);
    if (!o || o.userData.dirty === !!dirty) continue;
    o.material.dispose();
    o.material = material(o.userData.color, dirty);
    if (dirty) o.computeLineDistances();
    o.userData.dirty = !!dirty;
  }
}
