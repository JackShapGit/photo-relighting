/** Three.js scene + camera + renderer + OrbitControls.
 *
 * Exposes `createScene3D(canvas)` which builds everything and returns
 * handles the rest of the 3D module needs. The render loop runs while
 * `running` is true; pause/resume controls live in index.js.
 */
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

export const DEFAULT_CAMERA_POSITION = [0, 0, -3];
export const DEFAULT_CAMERA_TARGET = [0, 0, 0];

export function createScene3D(canvas) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.setPixelRatio(window.devicePixelRatio);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0b0b0b);

  // Far plane covers calibrated stages measured in feet (a 40 ft stage seen
  // from 60+ ft in the house, plus FOH fixtures).
  const perspectiveCamera = new THREE.PerspectiveCamera(
    50,
    1,        // aspect fixed at resize
    0.01,
    5000,
  );
  perspectiveCamera.position.set(...DEFAULT_CAMERA_POSITION);
  perspectiveCamera.lookAt(...DEFAULT_CAMERA_TARGET);

  const orthoCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.01, 5000);
  orthoCamera.position.set(...DEFAULT_CAMERA_POSITION);
  orthoCamera.lookAt(...DEFAULT_CAMERA_TARGET);

  let activeCamera = perspectiveCamera;
  const controls = new OrbitControls(activeCamera, canvas);
  controls.target.set(...DEFAULT_CAMERA_TARGET);
  controls.update();

  let orthoSize = 1.5;   // half-height of the orthographic frustum (world units)

  function resize() {
    const rect = canvas.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;
    renderer.setSize(rect.width, rect.height, false);
    const aspect = rect.width / rect.height;
    perspectiveCamera.aspect = aspect;
    perspectiveCamera.updateProjectionMatrix();
    // Keep orthographic frustum a constant world-space size; widen for aspect.
    orthoCamera.left = -orthoSize * aspect;
    orthoCamera.right = orthoSize * aspect;
    orthoCamera.top = orthoSize;
    orthoCamera.bottom = -orthoSize;
    orthoCamera.updateProjectionMatrix();
  }

  function setProjection(mode) {
    if (mode !== 'perspective' && mode !== 'orthographic') return;
    const newCam = mode === 'perspective' ? perspectiveCamera : orthoCamera;
    if (newCam === activeCamera) return;
    newCam.position.copy(activeCamera.position);
    newCam.quaternion.copy(activeCamera.quaternion);
    activeCamera = newCam;
    controls.object = newCam;
    controls.update();
  }

  // Home view. With `bounds` (a THREE.Box3 of stage + lights, calibrated
  // scenes) the camera sits on the house side (+z) looking at the center so
  // the whole stage is framed; otherwise today's fixed engine-frame view.
  let homeBounds = null;
  function resetCamera(bounds = homeBounds) {
    homeBounds = bounds || null;
    if (bounds && !bounds.isEmpty()) {
      const center = bounds.getCenter(new THREE.Vector3());
      const radius = Math.max(1e-3, bounds.getSize(new THREE.Vector3()).length() / 2);
      activeCamera.position.set(center.x, center.y + radius * 0.6, center.z + radius * 1.8);
      controls.target.copy(center);
      orthoSize = radius;
    } else {
      activeCamera.position.set(...DEFAULT_CAMERA_POSITION);
      controls.target.set(...DEFAULT_CAMERA_TARGET);
      orthoSize = 1.5;
    }
    activeCamera.lookAt(controls.target);
    controls.update();
    resize();
  }

  function getActiveCamera() { return activeCamera; }

  let running = false;
  let rafId = 0;
  function loop() {
    if (!running) return;
    controls.update();
    renderer.render(scene, activeCamera);
    rafId = requestAnimationFrame(loop);
  }
  function start() {
    if (running) return;
    running = true;
    loop();
  }
  function stop() {
    running = false;
    if (rafId) cancelAnimationFrame(rafId);
    rafId = 0;
  }

  function dispose() {
    stop();
    controls.dispose();
    renderer.dispose();
    // Caller is responsible for disposing geometries/materials added later.
  }

  return {
    renderer, scene, controls,
    setProjection, resetCamera, getActiveCamera,
    resize, start, stop, dispose,
  };
}
