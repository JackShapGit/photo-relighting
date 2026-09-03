/** Rig overlay for the 3D viewport (Spec 2 §Grid overlay): acting-area
 * cells drawn on the deck with their labels, and the venue's hanging
 * positions as thin bars (pipes and floor rows along X at their height,
 * booms vertical at their X/Z).
 *
 * Frame: Three x = world X, y = world Y, z = −world Z (coords.js
 * worldFtToThree). Geometry is in feet; `units` only affects nothing here
 * yet (labels are area numbers), but is kept so a later unit-aware label
 * needs no signature change.
 */
import * as THREE from 'three';
import { worldFtToThree } from './coords.js';
import { areaLabels, areaCenter } from '../rig/geometry.js';
import { cellCorners } from '../rig/areas.js';

export { cellCorners } from '../rig/areas.js';

export const RIG_OVERLAY_NAME = 'rig-overlay';
const DECK_LIFT = 0.02;          // ft above the deck grid to avoid z-fighting
const LABEL_HEIGHT_FT = 1.5;
const BAR_THICKNESS_FT = 0.15;
const FLOOR_BAR_HEIGHT_FT = 0.25;
const MIN_BOOM_HEIGHT_FT = 20;
const CELL_COLOR = 0x5cd0ff;
const PIPE_COLOR = 0xffb347;
const BOOM_COLOR = 0xff8c69;
const FLOOR_COLOR = 0xc0a060;

function labelSprite(text) {
  const canvas = document.createElement('canvas');
  canvas.width = 128; canvas.height = 64;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.font = 'bold 44px system-ui, sans-serif';
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.lineWidth = 6; ctx.strokeStyle = 'rgba(0,0,0,0.85)';
  ctx.strokeText(text, 64, 34);
  ctx.fillStyle = '#cfefff';
  ctx.fillText(text, 64, 34);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  const material = new THREE.SpriteMaterial({ map: texture, transparent: true, depthTest: false });
  const sprite = new THREE.Sprite(material);
  sprite.scale.set(LABEL_HEIGHT_FT * 2, LABEL_HEIGHT_FT, 1);   // canvas is 2:1
  sprite.renderOrder = 10;
  return sprite;
}

function bar(size, position, color, userData) {
  const mesh = new THREE.Mesh(
    new THREE.BoxGeometry(...size),
    new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.85 }),
  );
  mesh.position.set(...position);
  mesh.name = 'rig-position-bar';
  Object.assign(mesh.userData, userData);
  return mesh;
}

/** Build the overlay group for a venue. */
export function buildRigOverlay(venue, units = 'ft') {
  const group = new THREE.Group();
  group.name = RIG_OVERLAY_NAME;
  group.userData.units = units;
  if (!venue) return group;

  // Acting-area cells: one LineSegments for every outline.
  const pts = [];
  const labels = areaLabels(venue.grid || { rows: 3, cols: 3 });
  for (const label of labels) {
    const corners = cellCorners(venue, label);
    if (!corners) continue;
    for (let i = 0; i < 4; i++) {
      const a = worldFtToThree(corners[i]), b = worldFtToThree(corners[(i + 1) % 4]);
      pts.push(a[0], DECK_LIFT, a[2], b[0], DECK_LIFT, b[2]);
    }
  }
  const cellGeo = new THREE.BufferGeometry();
  cellGeo.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
  const cells = new THREE.LineSegments(cellGeo, new THREE.LineBasicMaterial({ color: CELL_COLOR, transparent: true, opacity: 0.8 }));
  cells.name = 'rig-area-cells';
  cells.userData.cellCount = labels.length;
  group.add(cells);

  // One label per cell at its centre, just above the deck.
  for (const label of labels) {
    const c = areaCenter(venue, label);
    if (!c) continue;
    const [x, , z] = worldFtToThree(c);
    const sprite = labelSprite(label);
    sprite.position.set(x, DECK_LIFT + LABEL_HEIGHT_FT / 2, z);
    sprite.name = 'rig-area-label';
    sprite.userData.label = label;
    group.add(sprite);
  }

  // Hanging positions.
  const positions = venue.positions || [];
  const W = venue.width_ft;
  const pipeTrims = positions.filter((p) => p.kind === 'pipe').map((p) => p.trim_ft ?? 0);
  const boomHeight = Math.max(MIN_BOOM_HEIGHT_FT, ...pipeTrims);
  for (const p of positions) {
    const z = -(p.upstage_ft ?? 0);
    if (p.kind === 'boom') {
      group.add(bar([BAR_THICKNESS_FT, boomHeight, BAR_THICKNESS_FT], [p.offset_ft ?? 0, boomHeight / 2, z], BOOM_COLOR,
        { positionId: p.id, kind: p.kind, name: p.name }));
    } else {
      const y = p.kind === 'floor' ? FLOOR_BAR_HEIGHT_FT : (p.trim_ft ?? 0);
      group.add(bar([W, BAR_THICKNESS_FT, BAR_THICKNESS_FT], [0, y, z], p.kind === 'floor' ? FLOOR_COLOR : PIPE_COLOR,
        { positionId: p.id, kind: p.kind, name: p.name }));
    }
  }
  return group;
}

function disposeGroup(group) {
  group.traverse((o) => {
    o.geometry?.dispose?.();
    if (o.material) {
      for (const m of Array.isArray(o.material) ? o.material : [o.material]) {
        m.map?.dispose?.();
        m.dispose?.();
      }
    }
  });
}

export function removeRigOverlay(scene) {
  if (!scene) return;
  // Remove every copy: a venue edit can rebuild while a scene load is in flight.
  for (const old of scene.children.filter((o) => o.name === RIG_OVERLAY_NAME)) {
    scene.remove(old);
    disposeGroup(old);
  }
}

/** Replace the overlay (or just remove it when there is no venue). */
export function updateRigOverlay(scene, venue, units = 'ft') {
  removeRigOverlay(scene);
  if (!scene || !venue) return null;
  const group = buildRigOverlay(venue, units);
  scene.add(group);
  return group;
}
