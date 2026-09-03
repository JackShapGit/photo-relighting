// 3D ruler rendering (Spec 3): one THREE.Line per committed span plus a
// canvas-texture label at its midpoint. Mirrors 3d/rig-overlay.js, including
// its depthTest: false labels — consistent with the area labels already
// shipped, which show through the subject.
import * as THREE from 'three';
import { distanceFt } from '../metric/measure.js';
import { formatLength } from '../metric/units.js';
import { worldFtToThree } from './coords.js';

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
    // Geometry arrives in world feet; every other 3D overlay in this module
    // (rig-overlay.js, cube-lines.js, light-primitives.js, ...) converts
    // through worldFtToThree (Z is negated) before it reaches a THREE
    // object, so this does too -- omitting it would draw the ruler mirrored
    // in Z relative to the stage, the point cloud and every light.
    const ta = worldFtToThree(m.a), tb = worldFtToThree(m.b);
    const geom = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(...ta), new THREE.Vector3(...tb),
    ]);
    group.add(new THREE.Line(geom, mat));
    const label = labelSprite(formatLength(distanceFt(m.a, m.b), units));
    label.position.set((ta[0] + tb[0]) / 2, (ta[1] + tb[1]) / 2, (ta[2] + tb[2]) / 2);
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
