// 3D ruler rendering (Spec 3): one THREE.Line per committed span plus a
// canvas-texture label at its midpoint. Mirrors 3d/rig-overlay.js, including
// its depthTest: false labels — consistent with the area labels already
// shipped, which show through the subject.
import * as THREE from 'three';
import { formatLength } from '../metric/units.js';
import { measureSegment } from './measure-lines.js';

const GROUP_NAME = 'measureOverlay';
const LABEL_HEIGHT_FT = 1.2;
const COLOR = 0xffd166;

function labelSprite(text) {
  const canvas = document.createElement('canvas');
  canvas.width = 256; canvas.height = 64;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.font = 'bold 34px system-ui, sans-serif';
  ctx.fillStyle = '#ffd166';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.strokeStyle = 'rgba(0,0,0,0.7)';
  ctx.lineWidth = 6;
  ctx.strokeText(text, canvas.width / 2, canvas.height / 2);
  ctx.fillText(text, canvas.width / 2, canvas.height / 2);
  const material = new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(canvas), transparent: true, depthTest: false });
  const sprite = new THREE.Sprite(material);
  sprite.scale.set(LABEL_HEIGHT_FT * 4, LABEL_HEIGHT_FT, 1);   // canvas is 4:1
  return sprite;
}

export function buildMeasureOverlay(measurements, units = 'ft') {
  const group = new THREE.Group();
  group.name = GROUP_NAME;
  const mat = new THREE.LineBasicMaterial({ color: COLOR });
  for (const m of measurements) {
    // measure-lines.js does the world-feet -> Three conversion (and is unit
    // tested for it -- see ruling T7-B); this module only wraps the result
    // in Three objects.
    const { a, b, mid, lengthFt } = measureSegment(m);
    const geom = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(...a), new THREE.Vector3(...b),
    ]);
    group.add(new THREE.Line(geom, mat));
    const label = labelSprite(formatLength(lengthFt, units));
    label.position.set(...mid);
    group.add(label);
  }
  return group;
}

function dispose(group) {
  group.traverse((o) => {
    if (o.geometry) o.geometry.dispose();
    if (o.material) { if (o.material.map) o.material.map.dispose(); o.material.dispose(); }
  });
}

export function updateMeasureOverlay(scene, measurements, units = 'ft') {
  if (!scene) return;
  const old = scene.getObjectByName(GROUP_NAME);
  if (old) { scene.remove(old); dispose(old); }
  if (!measurements?.length) return;
  scene.add(buildMeasureOverlay(measurements, units));
}
