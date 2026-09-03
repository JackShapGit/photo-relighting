/** Calibrated stage furniture for the 3D viewport: deck grid, plaster line,
 * centerline, back line, and fixture markers for lights that sit outside the
 * photo's point cloud (front-of-house positions).
 *
 * Frame: Three.js x = world X (feet, audience right), y = world Y (up),
 * z = −world Z (so +z is toward the house, −z is upstage). See coords.js
 * worldFtToThree.
 */
import * as THREE from 'three';

export const FT_PER_M = 3.280839895;

function gridLines(halfX, zFrom, zTo, step, color, opacity) {
  const pts = [];
  for (let x = -halfX; x <= halfX + 1e-6; x += step) pts.push(x, 0, zFrom, x, 0, zTo);
  for (let z = zTo; z <= zFrom + 1e-6; z += step) pts.push(-halfX, 0, z, halfX, 0, z);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
  return new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color, transparent: true, opacity }));
}

function line(a, b, color) {
  const g = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(...a), new THREE.Vector3(...b)]);
  return new THREE.Line(g, new THREE.LineBasicMaterial({ color }));
}

/** Deck grid: 1 ft minor / 5 ft major (1 m / 5 m in meters). X spans
 * ±0.75·W, Three-z from +2·D (house) to −D (back line). */
export function buildStage(cal, units = 'ft') {
  const group = new THREE.Group();
  group.name = 'stage';
  const W = cal.width_ft, D = cal.depth_ft;
  const minor = units === 'm' ? FT_PER_M : 1;
  const major = minor * 5;
  const halfX = Math.ceil(0.75 * W / major) * major;
  const zFrom = Math.ceil(2 * D / major) * major;   // into the house (+Three z)
  const zTo = -Math.ceil(D / major) * major;        // back line (−Three z)
  const minorGrid = gridLines(halfX, zFrom, zTo, minor, 0x335533, 0.25);
  minorGrid.name = 'stage-grid-minor';
  const majorGrid = gridLines(halfX, zFrom, zTo, major, 0x55aa55, 0.5);
  majorGrid.name = 'stage-grid-major';
  group.add(minorGrid, majorGrid);
  const plaster = line([-W / 2, 0, 0], [W / 2, 0, 0], 0xffcc00);       // plaster line (lip)
  plaster.name = 'stage-plaster-line';
  const center = line([0, 0, zFrom], [0, 0, zTo], 0x00ccff);          // centerline
  center.name = 'stage-centerline';
  const back = line([-W / 2, 0, -D], [W / 2, 0, -D], 0xffcc00);       // back line
  back.name = 'stage-back-line';
  group.add(plaster, center, back);
  group.userData.units = units;
  group.userData.minorStep = minor;
  group.userData.majorStep = major;
  return group;
}

function disposeGroup(group) {
  group.traverse((o) => {
    o.geometry?.dispose?.();
    if (o.material) (Array.isArray(o.material) ? o.material : [o.material]).forEach((m) => m.dispose?.());
  });
}

export function removeStage(scene) {
  const old = scene.getObjectByName('stage');
  if (old) { scene.remove(old); disposeGroup(old); }
}

export function updateStageUnits(scene, cal, units) {
  removeStage(scene);
  const stage = buildStage(cal, units);
  scene.add(stage);
  return stage;
}

/** Capped cylinder 1.2 ft long, 0.5 ft radius, aimed along the group's +z;
 * orient with a quaternion from (0, 0, 1) to the light's direction. `scale`
 * lets callers enlarge it for very wide stages. */
export function buildFixtureMarker(scale = 1) {
  const g = new THREE.Group();
  g.name = 'fixture-marker';
  const body = new THREE.Mesh(
    new THREE.CylinderGeometry(0.5 * scale, 0.5 * scale, 1.2 * scale, 12),
    new THREE.MeshBasicMaterial({ color: 0xdddddd }),
  );
  body.rotation.x = Math.PI / 2;      // cylinder axis (Y) → group +z
  g.add(body);
  const lens = new THREE.Mesh(
    new THREE.CircleGeometry(0.5 * scale, 16),
    new THREE.MeshBasicMaterial({ color: 0xffffaa, side: THREE.DoubleSide }),
  );
  lens.position.z = 0.6 * scale + 0.001;
  g.add(lens);
  return g;
}
