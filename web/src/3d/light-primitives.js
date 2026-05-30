/** Build a 3D primitive (sphere + optional arrow + optional cone) for a light.
 *
 * Returned object exposes:
 *   group:   THREE.Group containing all parts; the gizmo attaches here.
 *   sphere:  THREE.Mesh — the main visible body. Carries the raycast hit-target.
 *   arrow:   THREE.ArrowHelper | null — direction indicator for non-point lights.
 *   cone:    THREE.Mesh | null — translucent spotlight cone (spotlight only).
 *   outline: THREE.Mesh — selection-ring shown when the light is selected.
 *   update(light): apply a new light state (position, direction, color, ...).
 */
import * as THREE from 'three';
import { directionToWorld, lightToWorld } from './coords.js';
import { rgbToHex } from './utils.js';

const SPHERE_RADIUS = 0.05;
const HIT_RADIUS = SPHERE_RADIUS * 3;
const ARROW_LENGTH = 0.25;
const CONE_LENGTH = 0.6;

export function buildLightPrimitive(light) {
  if (light.type === 'reflector') {
    return buildReflectorPrimitive(light);
  }

  const group = new THREE.Group();
  group.userData.lightId = light.id;
  group.position.set(...lightToWorld(light.position));

  const sphereGeo = new THREE.SphereGeometry(SPHERE_RADIUS, 16, 12);
  const sphereMat = new THREE.MeshBasicMaterial({ color: rgbToHex(light.color) });
  const sphere = new THREE.Mesh(sphereGeo, sphereMat);
  sphere.userData.lightId = light.id;
  group.add(sphere);

  // Invisible larger hit target so small primitives are easy to click.
  const hitGeo = new THREE.SphereGeometry(HIT_RADIUS, 8, 6);
  const hitMat = new THREE.MeshBasicMaterial({ visible: false });
  const hit = new THREE.Mesh(hitGeo, hitMat);
  hit.userData.lightId = light.id;
  hit.userData.isHitTarget = true;
  group.add(hit);

  let arrow = null;
  if (light.type !== 'point') {
    arrow = new THREE.ArrowHelper(
      new THREE.Vector3(...directionToWorld(light.direction)),
      new THREE.Vector3(0, 0, 0),
      ARROW_LENGTH,
      rgbToHex(light.color),
      0.06, 0.04,
    );
    group.add(arrow);
  }

  let cone = null;
  if (light.type === 'spotlight') {
    const radius = Math.tan(light.cone_angle ?? 0.5) * CONE_LENGTH;
    const coneGeo = new THREE.ConeGeometry(radius, CONE_LENGTH, 24, 1, true);
    coneGeo.translate(0, -CONE_LENGTH / 2, 0);
    const coneMat = new THREE.MeshBasicMaterial({
      color: rgbToHex(light.color),
      transparent: true,
      opacity: 0.15,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    cone = new THREE.Mesh(coneGeo, coneMat);
    orientToDirection(cone, directionToWorld(light.direction));
    group.add(cone);
  }

  // Outline ring shown when selected. Hidden by default.
  const ringGeo = new THREE.TorusGeometry(SPHERE_RADIUS * 1.6, 0.006, 8, 32);
  const ringMat = new THREE.MeshBasicMaterial({ color: 0xffff00 });
  const outline = new THREE.Mesh(ringGeo, ringMat);
  outline.visible = false;
  group.add(outline);

  const prim = { group, sphere, hit, arrow, cone, outline };
  prim.update = (next) => update(prim, next);
  return prim;
}

function update(prim, light) {
  prim.group.position.set(...lightToWorld(light.position));
  prim.sphere.material.color.set(rgbToHex(light.color));
  if (prim.arrow) {
    prim.arrow.setDirection(new THREE.Vector3(...directionToWorld(light.direction)));
    prim.arrow.setColor(new THREE.Color(rgbToHex(light.color)));
  }
  if (prim.cone) {
    const newRadius = Math.tan(light.cone_angle ?? 0.5) * CONE_LENGTH;
    // Rebuild cone geometry on cone-angle change.
    prim.cone.geometry.dispose();
    const g = new THREE.ConeGeometry(newRadius, CONE_LENGTH, 24, 1, true);
    g.translate(0, -CONE_LENGTH / 2, 0);
    prim.cone.geometry = g;
    prim.cone.material.color.set(rgbToHex(light.color));
    orientToDirection(prim.cone, directionToWorld(light.direction));
  }
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
    group, sphere: plane, hit, arrow: null, cone: null, outline,
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
  if (prim._planeBack) {
    prim._planeBack.geometry.dispose();
    prim._planeBack.material.dispose();
  }
  if (prim.group.parent) prim.group.parent.remove(prim.group);
}
