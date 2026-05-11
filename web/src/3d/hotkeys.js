/** Keyboard shortcuts for the 3D viewport.
 *
 * Hotkeys fire only when the keypress originates outside of inputs/textareas
 * (so typing in the polish prompt or scene name doesn't grab them).
 */
import * as THREE from 'three';

const VIEW_PRESETS = {
  // [position, target]
  '1': [[0, 0, -3], [0, 0, 0]],   // front (photographer's POV)
  '3': [[3, 0, 0], [0, 0, 0]],    // right side
  '7': [[0, 3, 0], [0, 0, 0]],    // top
  '0': [[0, 0, -3], [0, 0, 0]],   // camera view (= front for us)
};

export function bindHotkeys({ api, gizmoApi }) {
  document.addEventListener('keydown', (e) => {
    if (isTextInput(e.target)) return;

    const k = e.key.toLowerCase();

    // Gizmo mode toggles.
    if (k === 'g') { gizmoApi?.setMode('translate'); e.preventDefault(); return; }
    if (k === 'r') { gizmoApi?.setMode('rotate');    e.preventDefault(); return; }
    if (k === 'escape') {
      // No native "cancel drag" on TransformControls; the best we can do is
      // detach the gizmo, which the user can re-attach by clicking again.
      // Real Blender-style cancel-with-revert is out of scope for v1.
      // (Leaving Esc as a no-op for now to avoid surprising behavior.)
      return;
    }

    // Camera presets.
    if (VIEW_PRESETS[k]) {
      const [pos, tgt] = VIEW_PRESETS[k];
      api.getActiveCamera().position.set(...pos);
      api.controls.target.set(...tgt);
      api.controls.update();
      e.preventDefault();
      return;
    }

    // Projection toggle.
    if (k === '5') {
      const cam = api.getActiveCamera();
      const isPersp = cam.isPerspectiveCamera;
      api.setProjection(isPersp ? 'orthographic' : 'perspective');
      if (gizmoApi) gizmoApi.setCamera(api.getActiveCamera());
      e.preventDefault();
      return;
    }
  });
}

function isTextInput(el) {
  if (!el) return false;
  const t = el.tagName;
  if (t === 'INPUT' || t === 'TEXTAREA' || t === 'SELECT') return true;
  if (el.isContentEditable) return true;
  return false;
}
