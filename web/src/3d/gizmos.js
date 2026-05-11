/** TransformControls gizmo that attaches to the currently-selected light.
 *
 * Translate mode by default. Rotate mode is enabled by the consumer when
 * the selected light's type supports direction (directional / spotlight).
 *
 * Writebacks happen via the `onTranslate` and `onRotate` callbacks:
 *   onTranslate(lightId, [x, y, z]) — new world-space position
 *   onRotate(lightId, [dx, dy, dz]) — new normalized direction unit vector
 */
import * as THREE from 'three';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import { worldToDirection, worldToLight } from './coords.js';

export function createGizmo({ camera, canvas, orbitControls, scene, onTranslate, onRotate }) {
  const gizmo = new TransformControls(camera, canvas);
  gizmo.setMode('translate');
  gizmo.setSize(0.8);
  scene.add(gizmo);

  // Disable orbit controls while dragging the gizmo (standard pattern).
  gizmo.addEventListener('dragging-changed', (e) => {
    orbitControls.enabled = !e.value;
  });

  let attachedLightId = null;
  let attachedPrimitive = null;
  let attachedLightType = 'point';

  // Live writeback during drag.
  gizmo.addEventListener('objectChange', () => {
    if (!attachedLightId || !attachedPrimitive) return;
    const g = attachedPrimitive.group;
    if (gizmo.getMode() === 'translate') {
      const engPos = worldToLight([g.position.x, g.position.y, g.position.z]);
      onTranslate(attachedLightId, engPos);
    } else if (gizmo.getMode() === 'rotate' && attachedLightType !== 'point') {
      // The cone primitive is built along -Y in light-primitives.js; that's
      // its "forward" axis. Rotate it by the group's quaternion to get the
      // current world-space pointing vector, then convert back to engine
      // direction space.
      const worldDir = new THREE.Vector3(0, -1, 0).applyQuaternion(g.quaternion).normalize();
      const engDir = worldToDirection([worldDir.x, worldDir.y, worldDir.z]);
      onRotate(attachedLightId, engDir);
    }
  });

  function attach(primitive, lightType) {
    detach();
    if (!primitive) return;
    attachedLightId = primitive.group.userData.lightId;
    attachedPrimitive = primitive;
    attachedLightType = lightType;
    gizmo.attach(primitive.group);
  }

  function detach() {
    attachedLightId = null;
    attachedPrimitive = null;
    gizmo.detach();
  }

  function setMode(mode) {
    if (mode === 'rotate' && attachedLightType === 'point') return;
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

  return { gizmo, attach, detach, setMode, getMode, setCamera, dispose };
}
