/** Beam line + target marker for the currently-selected targeted light.
 *
 * One instance lives in the scene; show(light) positions a small sphere at the
 * light's target and draws a line from the light position to the target. hide()
 * removes them from view. The marker is returned so the gizmo can attach to it.
 */
import * as THREE from 'three';
import { lightToWorld } from './coords.js';
import { rgbToHex } from './utils.js';

const MARKER_RADIUS = 0.04;

export function createTargetViz(scene) {
  const markerGeo = new THREE.SphereGeometry(MARKER_RADIUS, 16, 12);
  const markerMat = new THREE.MeshBasicMaterial({ color: 0xffff00 });
  const marker = new THREE.Mesh(markerGeo, markerMat);
  marker.visible = false;
  scene.add(marker);

  const lineMat = new THREE.LineBasicMaterial({ color: 0xffff00 });
  const lineGeo = new THREE.BufferGeometry().setFromPoints([
    new THREE.Vector3(), new THREE.Vector3(),
  ]);
  const line = new THREE.Line(lineGeo, lineMat);
  line.visible = false;
  scene.add(line);

  const previewMat = new THREE.LineBasicMaterial({ color: 0xffd23f });
  const previewGeo = new THREE.BufferGeometry().setFromPoints([
    new THREE.Vector3(), new THREE.Vector3(),
  ]);
  const previewLine = new THREE.Line(previewGeo, previewMat);
  previewLine.visible = false;
  scene.add(previewLine);

  function show(light) {
    const lp = lightToWorld(light.position);
    const tp = lightToWorld(light.target);
    marker.position.set(tp[0], tp[1], tp[2]);
    marker.material.color.set(rgbToHex(light.color));
    marker.visible = true;
    const pos = line.geometry.attributes.position;
    pos.setXYZ(0, lp[0], lp[1], lp[2]);
    pos.setXYZ(1, tp[0], tp[1], tp[2]);
    pos.needsUpdate = true;
    line.material.color.set(rgbToHex(light.color));
    line.visible = true;
  }

  function hide() {
    marker.visible = false;
    line.visible = false;
  }

  function showPreview(fromEng, toEng) {
    const a = lightToWorld(fromEng);
    const b = lightToWorld(toEng);
    const pos = previewLine.geometry.attributes.position;
    pos.setXYZ(0, a[0], a[1], a[2]);
    pos.setXYZ(1, b[0], b[1], b[2]);
    pos.needsUpdate = true;
    previewLine.visible = true;
  }
  function clearPreview() { previewLine.visible = false; }

  function dispose() {
    scene.remove(marker); marker.geometry.dispose(); marker.material.dispose();
    scene.remove(line); line.geometry.dispose(); line.material.dispose();
    scene.remove(previewLine); previewLine.geometry.dispose(); previewLine.material.dispose();
  }

  return { marker, show, hide, dispose, showPreview, clearPreview };
}
