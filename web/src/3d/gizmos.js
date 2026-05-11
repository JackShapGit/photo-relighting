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
      onTranslate(attachedLightId, [g.position.x, g.position.y, g.position.z]);
    } else if (gizmo.getMode() === 'rotate' && attachedLightType !== 'point') {
      // Direction comes from the rotated group's local -Y axis (matches the
      // cone orientation in light-primitives.js). Translate that into the
      // engine's `direction` convention.
      const dir = new THREE.Vector3(0, -1, 0).applyQuaternion(g.quaternion).normalize();
      onRotate(attachedLightId, [dir.x, dir.y, dir.z]);
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

  function dispose() {
    gizmo.detach();
    scene.remove(gizmo);
    gizmo.dispose();
  }

  return { gizmo, attach, detach, setMode, getMode, dispose };
}
