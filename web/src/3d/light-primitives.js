/** Build a 3D primitive (sphere + optional arrow + optional cone) for a light.
 *
 * Returned object exposes:
 *   group:   THREE.Group containing all parts; the gizmo attaches here.
 *   sphere:  THREE.Mesh — the main visible body. Carries the raycast hit-target.
 *   arrow:   THREE.ArrowHelper | null — direction indicator for non-point lights.
 *   cone:    THREE.Mesh | null — translucent spotlight cone (spotlight only).
 *   outline: THREE.Mesh — selection-ring shown when the light is selected.
 *   marker:  THREE.Group | null — fixture marker shown instead of the sphere when
 *            a calibrated light sits outside the point cloud (FOH positions).
 *   update(light): apply a new light state (position, direction, color, ...).
 *
 * Calibrated scenes (setLightMetric(cal, bounds)) place lights from
 * position_ft / direction_ft in the feet Three frame and scale every part by
 * half the stage width so they stay visible at stage distances.
 */
import * as THREE from 'three';
import { directionToWorld, lightToWorld, worldFtToThree } from './coords.js';
import { rgbToHex } from './utils.js';
import { buildFixtureMarker } from './stage.js';

const SPHERE_RADIUS = 0.05;
const HIT_RADIUS = SPHERE_RADIUS * 3;
const ARROW_LENGTH = 0.25;
const CONE_LENGTH = 0.6;

// Metric mode state (set by index.js when a calibration is loaded).
let metricCal = null;
let cloudBounds = null;   // THREE.Box3 of the point cloud in the feet frame

export function setLightMetric(cal, bounds = null) {
  metricCal = cal || null;
  cloudBounds = cal ? bounds : null;
}
export function isLightMetric() { return !!metricCal; }

/** Geometry scale: 1 in engine space, width_ft / 2 in feet space. */
function metricS() { return metricCal ? Math.max(1, metricCal.width_ft / 2) : 1; }

/** Three-frame position of a light: feet when calibrated and the light has
 * position_ft, else the engine → world mapping. */
export function lightPos(light) {
  if (metricCal && Array.isArray(light.position_ft)) return worldFtToThree(light.position_ft);
  return lightToWorld(light.position);
}

/** Three-frame direction of a light. */
export function lightDir(light) {
  if (metricCal && Array.isArray(light.direction_ft)) return worldFtToThree(light.direction_ft);
  return directionToWorld(light.direction);
}

function outsideCloud(light) {
  if (!metricCal || !cloudBounds || !Array.isArray(light.position_ft)) return false;
  const p = new THREE.Vector3(...worldFtToThree(light.position_ft));
  return !cloudBounds.containsPoint(p);
}

function coneGeometry(coneAngle, S) {
  const len = CONE_LENGTH * S;
  const radius = Math.tan(coneAngle ?? 0.5) * len;
  const g = new THREE.ConeGeometry(radius, len, 24, 1, true);
  g.translate(0, -len / 2, 0);
  return g;
}

export function buildLightPrimitive(light) {
  if (light.type === 'reflector') {
    return buildReflectorPrimitive(light);
  }
  const S = metricS();

  const group = new THREE.Group();
  group.userData.lightId = light.id;
  group.position.set(...lightPos(light));

  const sphereGeo = new THREE.SphereGeometry(SPHERE_RADIUS * S, 16, 12);
  const sphereMat = new THREE.MeshBasicMaterial({ color: rgbToHex(light.color) });
  const sphere = new THREE.Mesh(sphereGeo, sphereMat);
  sphere.userData.lightId = light.id;
  group.add(sphere);

  // Invisible larger hit target so small primitives are easy to click.
  const hitGeo = new THREE.SphereGeometry(HIT_RADIUS * S, 8, 6);
  const hitMat = new THREE.MeshBasicMaterial({ visible: false });
  const hit = new THREE.Mesh(hitGeo, hitMat);
  hit.userData.lightId = light.id;
  hit.userData.isHitTarget = true;
  group.add(hit);

  let arrow = null;
  if (light.type !== 'point') {
    arrow = new THREE.ArrowHelper(
      new THREE.Vector3(...lightDir(light)),
      new THREE.Vector3(0, 0, 0),
      ARROW_LENGTH * S,
      rgbToHex(light.color),
      0.06 * S, 0.04 * S,
    );
    group.add(arrow);
  }

  let cone = null;
  if (light.type === 'spotlight') {
    const coneMat = new THREE.MeshBasicMaterial({
      color: rgbToHex(light.color),
      transparent: true,
      opacity: 0.15,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    cone = new THREE.Mesh(coneGeometry(light.cone_angle, S), coneMat);
    orientToDirection(cone, lightDir(light));
    group.add(cone);
  }

  // Outline ring shown when selected. Hidden by default.
  const ringGeo = new THREE.TorusGeometry(SPHERE_RADIUS * 1.6 * S, 0.006 * S, 8, 32);
  const ringMat = new THREE.MeshBasicMaterial({ color: 0xffff00 });
  const outline = new THREE.Mesh(ringGeo, ringMat);
  outline.visible = false;
  group.add(outline);

  // Fixture marker for calibrated lights outside the point cloud (FOH).
  let marker = null;
  if (metricCal) {
    marker = buildFixtureMarker(Math.max(1, S / 20));
    marker.userData.lightId = light.id;
    group.add(marker);
  }

  const prim = { group, sphere, hit, arrow, cone, outline, marker, _S: S };
  prim.update = (next) => update(prim, next);
  applyMarkerMode(prim, light);
  return prim;
}

function applyMarkerMode(prim, light) {
  if (!prim.marker) return;
  const fixture = outsideCloud(light);
  prim.marker.visible = fixture;
  prim.sphere.visible = !fixture;
  if (fixture) {
    const dir = new THREE.Vector3(...lightDir(light)).normalize();
    prim.marker.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), dir);
  }
}

function update(prim, light) {
  prim.group.position.set(...lightPos(light));
  prim.sphere.material.color.set(rgbToHex(light.color));
  if (prim.arrow) {
    prim.arrow.setDirection(new THREE.Vector3(...lightDir(light)));
    prim.arrow.setColor(new THREE.Color(rgbToHex(light.color)));
  }
  if (prim.cone) {
    // Rebuild cone geometry on cone-angle change.
    prim.cone.geometry.dispose();
    prim.cone.geometry = coneGeometry(light.cone_angle, prim._S);
    prim.cone.material.color.set(rgbToHex(light.color));
    orientToDirection(prim.cone, lightDir(light));
  }
  applyMarkerMode(prim, light);
}

function buildReflectorPrimitive(light) {
  const group = new THREE.Group();
  group.userData.lightId = light.id;
  group.position.set(...lightToWorld(light.position));

  const sx = light.size?.[0] ?? 0.6;
  const sy = light.size?.[1] ?? 0.4;

  const planeGeo = new THREE.PlaneGeometry(sx, sy);
  const tintHex  = rgbToHex(light.color);

  const front = new THREE.MeshBasicMaterial({
    color: tintHex, transparent: true, opacity: 0.5, side: THREE.FrontSide,
  });
  const back  = new THREE.MeshBasicMaterial({
    color: 0x222222, side: THREE.BackSide,
  });

  const plane = new THREE.Mesh(planeGeo, front);
  plane.userData.lightId = light.id;
  group.add(plane);
  const planeBack = new THREE.Mesh(planeGeo, back);
  planeBack.userData.lightId = light.id;
  group.add(planeBack);

  // Orient so plane's local +Z (its normal) matches the engine normal in world.
  const worldNormal = new THREE.Vector3(...directionToWorld(light.normal));
  plane.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), worldNormal);
  planeBack.quaternion.copy(plane.quaternion);

  // Hit target: a slightly larger invisible double-sided plane for raycast.
  const hitGeo = new THREE.PlaneGeometry(sx * 1.1, sy * 1.1);
  const hitMat = new THREE.MeshBasicMaterial({ visible: false, side: THREE.DoubleSide });
  const hit = new THREE.Mesh(hitGeo, hitMat);
  hit.userData.lightId = light.id;
  hit.userData.isHitTarget = true;
  hit.quaternion.copy(plane.quaternion);
  group.add(hit);

  // Selection outline (rectangle wire edges, yellow).
  const outlineGeo = new THREE.EdgesGeometry(planeGeo);
  const outlineMat = new THREE.LineBasicMaterial({ color: 0xffff00 });
  const outline = new THREE.LineSegments(outlineGeo, outlineMat);
  outline.visible = false;
  outline.quaternion.copy(plane.quaternion);
  group.add(outline);

  const prim = {
    group, sphere: plane, hit, arrow: null, cone: null, outline, marker: null,
    _planeBack: planeBack,
  };
  prim.update = (next) => updateReflector(prim, next);
  return prim;
}

function updateReflector(prim, light) {
  prim.group.position.set(...lightToWorld(light.position));
  const sx = light.size?.[0] ?? 0.6;
  const sy = light.size?.[1] ?? 0.4;

  // Rebuild geometries on every update (cheap, simple). Dispose old.
  prim.sphere.geometry.dispose();
  prim.sphere.geometry = new THREE.PlaneGeometry(sx, sy);
  prim._planeBack.geometry.dispose();
  prim._planeBack.geometry = new THREE.PlaneGeometry(sx, sy);
  prim.hit.geometry.dispose();
  prim.hit.geometry = new THREE.PlaneGeometry(sx * 1.1, sy * 1.1);
  prim.outline.geometry.dispose();
  prim.outline.geometry = new THREE.EdgesGeometry(prim.sphere.geometry);

  prim.sphere.material.color.set(rgbToHex(light.color));
  const worldNormal = new THREE.Vector3(...directionToWorld(light.normal));
  prim.sphere.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), worldNormal);
  prim._planeBack.quaternion.copy(prim.sphere.quaternion);
  prim.hit.quaternion.copy(prim.sphere.quaternion);
  prim.outline.quaternion.copy(prim.sphere.quaternion);
}

function orientToDirection(mesh, direction) {
  // Cone geometry is built along -Y; rotate to point along the light's direction.
  const dir = new THREE.Vector3(...direction).normalize();
  const target = new THREE.Vector3().copy(dir);
  const up = new THREE.Vector3(0, -1, 0);
  mesh.quaternion.setFromUnitVectors(up, target);
}

export function disposeLightPrimitive(prim) {
  if (!prim) return;
  prim.sphere.geometry.dispose();
  prim.sphere.material.dispose();
  prim.hit.geometry.dispose();
  prim.hit.material.dispose();
  if (prim.arrow) {
    prim.arrow.line.geometry.dispose();
    prim.arrow.cone.geometry.dispose();
  }
  if (prim.cone) {
    prim.cone.geometry.dispose();
    prim.cone.material.dispose();
  }
  prim.outline.geometry.dispose();
  prim.outline.material.dispose();
  if (prim.marker) {
    prim.marker.traverse((o) => { o.geometry?.dispose?.(); o.material?.dispose?.(); });
  }
  if (prim._planeBack) {
    prim._planeBack.geometry.dispose();
    prim._planeBack.material.dispose();
  }
  if (prim.group.parent) prim.group.parent.remove(prim.group);
}
