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
  // TODO(task 5): remove after point cloud lands.
  const cubeGeo = new THREE.BoxGeometry(0.3, 0.3, 0.3);
  const cubeMat = new THREE.MeshStandardMaterial({ color: 0x4a77ee });
  const cube = new THREE.Mesh(cubeGeo, cubeMat);
  scene.add(cube);
  const ambient = new THREE.AmbientLight(0xffffff, 0.6);
  scene.add(ambient);
  const dir = new THREE.DirectionalLight(0xffffff, 0.8);
  dir.position.set(1, 2, 1);
  scene.add(dir);

  const perspectiveCamera = new THREE.PerspectiveCamera(
    50,
    1,        // aspect fixed at resize
    0.01,
    100,
  );
  perspectiveCamera.position.set(...DEFAULT_CAMERA_POSITION);
  perspectiveCamera.lookAt(...DEFAULT_CAMERA_TARGET);

  const orthoCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.01, 100);
  orthoCamera.position.set(...DEFAULT_CAMERA_POSITION);
  orthoCamera.lookAt(...DEFAULT_CAMERA_TARGET);

  let activeCamera = perspectiveCamera;
  const controls = new OrbitControls(activeCamera, canvas);
  controls.target.set(...DEFAULT_CAMERA_TARGET);
  controls.update();

  function resize() {
    const rect = canvas.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;
    renderer.setSize(rect.width, rect.height, false);
    const aspect = rect.width / rect.height;
    perspectiveCamera.aspect = aspect;
    perspectiveCamera.updateProjectionMatrix();
    // Keep orthographic frustum a constant world-space size; widen for aspect.
    const orthoSize = 1.5;
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

  function resetCamera() {
    activeCamera.position.set(...DEFAULT_CAMERA_POSITION);
    controls.target.set(...DEFAULT_CAMERA_TARGET);
    controls.update();
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
