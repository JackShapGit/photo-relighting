/** TransformControls gizmo that attaches to the currently-selected light.
 *
 * Translate mode by default. Rotate mode is enabled by the consumer when
 * the selected light's type supports direction (directional / spotlight).
 *
 * Writebacks happen via the `onTranslate`, `onRotate` and `onTargetMove`
 * callbacks, each receiving (lightId, patch) where patch is a partial light:
 *   engine frame (uncalibrated):  { position } / { direction | normal } / { target }
 *   feet frame (calibrated):      { position_ft } / { direction_ft } / { target_ft }
 * `getMetric()` tells the gizmo which frame the dragged objects live in.
 */
import * as THREE from 'three';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import { worldToDirection, worldToLight, threeToWorldFt } from './coords.js';

export function createGizmo({ camera, canvas, orbitControls, scene, onTranslate, onRotate, onTargetMove, getMetric = () => null }) {
  const gizmo = new TransformControls(camera, canvas);
  gizmo.setMode('translate');
  gizmo.setSize(0.8);
  scene.add(gizmo);
  const metric = () => !!getMetric();

  // Disable orbit controls while dragging the gizmo (standard pattern).
  gizmo.addEventListener('dragging-changed', (e) => {
    orbitControls.enabled = !e.value;
  });

  let attachedLightId = null;
  let attachedPrimitive = null;
  let attachedLightType = 'point';
  let attachedKind = 'light';   // 'light' | 'target'
  let attachedTargetLightId = null;

  // Live writeback during drag.
  gizmo.addEventListener('objectChange', () => {
    if (attachedKind === 'target') {
      if (!attachedTargetLightId || !attachedPrimitive) return;
      const m = attachedPrimitive;   // for target, attachedPrimitive IS the marker Object3D
      const p = [m.position.x, m.position.y, m.position.z];
      const patch = metric() ? { target_ft: threeToWorldFt(p) } : { target: worldToLight(p) };
      if (onTargetMove) onTargetMove(attachedTargetLightId, patch);
      return;
    }
    if (!attachedLightId || !attachedPrimitive) return;
    const g = attachedPrimitive.group;
    if (gizmo.getMode() === 'translate') {
      const p = [g.position.x, g.position.y, g.position.z];
      const patch = metric() && attachedLightType !== 'reflector'
        ? { position_ft: threeToWorldFt(p) }
        : { position: worldToLight(p) };
      onTranslate(attachedLightId, patch);
    } else if (gizmo.getMode() === 'rotate' && attachedLightType !== 'point') {
      if (attachedLightType === 'reflector') {
        // Reflector plane's "front" is local +Z (from setFromUnitVectors above).
        const worldDir = new THREE.Vector3(0, 0, 1).applyQuaternion(g.quaternion).normalize();
        const engNormal = worldToDirection([worldDir.x, worldDir.y, worldDir.z]);
        onRotate(attachedLightId, { normal: engNormal });
      } else {
        // The cone primitive is built along -Y in light-primitives.js; that's
        // its "forward" axis. Rotate it by the group's quaternion to get the
        // current Three-space pointing vector, then convert back to the light's
        // direction space (engine, or world feet when calibrated).
        const worldDir = new THREE.Vector3(0, -1, 0).applyQuaternion(g.quaternion).normalize();
        const d = [worldDir.x, worldDir.y, worldDir.z];
        onRotate(attachedLightId, metric() ? { direction_ft: threeToWorldFt(d) } : { direction: worldToDirection(d) });
      }
    }
  });

  function attach(primitive, lightType) {
    if (!primitive) {
      detach();
      return;
    }
    // No-op if already attached to the same primitive. Every gizmo drag tick
    // fires onUpdateLight → onChange → syncLightsToScene, which calls attach
    // again with the same target. Without this guard the inner gizmo.detach()
    // cancels the in-flight pointer drag after only a few pixels.
    if (attachedKind === 'light' && attachedPrimitive === primitive && attachedLightType === lightType) return;
    detach();
    attachedKind = 'light';
    attachedLightId = primitive.group.userData.lightId;
    attachedPrimitive = primitive;
    attachedLightType = lightType;
    gizmo.attach(primitive.group);
  }

  // Attach the gizmo (translate mode) to a target marker Object3D so dragging
  // it moves the light's target rather than its position.
  function attachTarget(markerObject, lightId) {
    if (attachedKind === 'target' && attachedPrimitive === markerObject) return;
    detach();
    attachedKind = 'target';
    attachedTargetLightId = lightId;
    attachedPrimitive = markerObject;
    gizmo.setMode('translate');   // a target point can only be translated, never rotated
    gizmo.attach(markerObject);
  }

  function detach() {
    attachedLightId = null;
    attachedPrimitive = null;
    attachedLightType = 'point';
    attachedKind = 'light';
    attachedTargetLightId = null;
    gizmo.detach();
  }

  function setMode(mode) {
    if (mode === 'rotate' && (attachedKind === 'target' || attachedLightType === 'point')) return;
    gizmo.setMode(mode);
  }

  function getMode() { return gizmo.getMode(); }

  function setCamera(newCamera) {
    gizmo.camera = newCamera;
  }

  function dispose() {
    gizmo.detach();
    scene.remove(gizmo);
    gizmo.dispose();
  }

  return { gizmo, attach, attachTarget, detach, setMode, getMode, setCamera, dispose };
}
