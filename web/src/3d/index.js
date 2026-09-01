/** 3D viewport entry point. Mount once, hook lifecycle into main.js. */
import * as THREE from 'three';
import { worldToLight, lightToWorld, worldFtToThree, threeToWorldFt } from './coords.js';
import './sync.js';
import { buildPointCloud, disposePointCloud, metricScale } from './point-cloud.js';
import { disposeLightPrimitive, setLightMetric } from './light-primitives.js';
import { mountOverlayPanel } from './overlay-panel.js';
import { createScene3D } from './scene.js';
import { applyOps, diffLights, setSelected } from './sync.js';
import { createGizmo } from './gizmos.js';
import { bindHotkeys } from './hotkeys.js';
import { isTargeted } from '../targeting.js';
import { createTargetViz } from './target-viz.js';
import { buildStage, removeStage, updateStageUnits } from './stage.js';
import { worldToEngine } from '../metric/calibration.js';

let api = null;
let currentPointCloud = null;
const primitives = new Map();
let prevLights = [];
let onLightSelected = null;
let gizmoApi = null;
let targetViz = null;
let onLightChange = null;
let placement = null;
let getMedianDepth = () => 0.3;
const raycaster = new THREE.Raycaster();
const POINT_HIT_THRESHOLD = 0.03;           // point-cloud hit tolerance for placement (engine units)
raycaster.params.Points.threshold = POINT_HIT_THRESHOLD;
const mouse = new THREE.Vector2();

// Calibrated-stage state: the solved calibration record (with camera), the
// display units for the deck grid, the assets of the loaded scene (so a
// calibration change can rebuild the cloud), and a load sequence so an
// overlapping rebuild cannot leave a stale cloud in the scene.
let metricCal = null;
let metricUnits = 'ft';
let lastAssetUrls = null;
let loadSeq = 0;
const isMetric = () => !!metricCal;

export function mount3D({ onSelectLight, onUpdateLight, placement: placementCtl, getMedianDepth: getMedian } = {}) {
  if (api) return api;
  const canvas = document.getElementById('canvas3d');
  if (!canvas) return null;
  api = createScene3D(canvas);
  api.resize();
  api.start();
  window.addEventListener('resize', api.resize);
  window.__scene3d = api.scene;   // inspection hook (smoke tests, console)
  onLightSelected = onSelectLight || null;
  onLightChange = onUpdateLight || null;
  placement = placementCtl || null;
  if (getMedian) getMedianDepth = getMedian;

  const overlayEl = document.getElementById('stage3d-overlay');
  if (overlayEl) {
    mountOverlayPanel({
      rootEl: overlayEl,
      hooks: {
        onShowPointsChange: (v) => {
          if (currentPointCloud) currentPointCloud.points.visible = v;
        },
        onPointSizeChange: (s) => {
          // Slider gives world-space size [0.002, 0.012] which feeds the
          // shader's u_size uniform directly (matches the original
          // PointsMaterial.size scaling); scaled up with the stage width in
          // calibrated scenes.
          if (currentPointCloud) {
            currentPointCloud.material.uniforms.u_size.value = s * metricScale(metricCal);
          }
        },
        onPointOpacityChange: (o) => {
          if (currentPointCloud) {
            currentPointCloud.material.uniforms.u_opacity.value = o;
          }
        },
        onProjectionChange: (mode) => {
          api.setProjection(mode);
          if (gizmoApi) gizmoApi.setCamera(api.getActiveCamera());
        },
        onResetCamera: () => api.resetCamera(),
      },
    });
  }

  gizmoApi = createGizmo({
    camera: api.getActiveCamera(),
    canvas,
    orbitControls: api.controls,
    scene: api.scene,
    // The gizmo hands back a partial light in the right frame for the mode:
    // { position } / { direction | normal } / { target } uncalibrated,
    // { position_ft } / { direction_ft } / { target_ft } when calibrated.
    onTranslate: (id, patch) => { if (onLightChange) onLightChange(id, patch); },
    onRotate: (id, patch) => { if (onLightChange) onLightChange(id, patch); },
    onTargetMove: (id, patch) => { if (onLightChange) onLightChange(id, patch); },
    getMetric: () => metricCal,
  });
  targetViz = createTargetViz(api.scene);

  bindHotkeys({ api, gizmoApi });

  canvas.addEventListener('pointerdown', onCanvasClick);
  canvas.addEventListener('pointermove', onPlacementMove);
  canvas.addEventListener('contextmenu', onPlacementContext);
  return api;
}

const placementPlane = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0);

function placementEngPoint(e) {
  if (!api) return null;
  const canvas = e.currentTarget;
  const rect = canvas.getBoundingClientRect();
  mouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
  mouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
  raycaster.setFromCamera(mouse, api.getActiveCamera());
  // Prefer a real point-cloud hit (true depth); fall back to a plane at the
  // subject's median depth so a point is always produced.
  let hit = null;
  if (currentPointCloud) {
    const pts = raycaster.intersectObject(currentPointCloud.points, false);
    if (pts.length) hit = pts[0].point;
  }
  if (!hit) {
    if (metricCal) {
      // Calibrated: fall back to the deck plane (y = 0 in the feet frame).
      const deck = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
      const p = new THREE.Vector3();
      if (!raycaster.ray.intersectPlane(deck, p)) return null;
      hit = p;
    } else {
      const medianEngZ = 1 - getMedianDepth();
      placementPlane.constant = -lightToWorld([0, 0, medianEngZ])[2];
      const p = new THREE.Vector3();
      if (!raycaster.ray.intersectPlane(placementPlane, p)) return null;
      hit = p;
    }
  }
  if (metricCal) {
    // The placement controller works in engine space; project the feet-space
    // hit through the calibration (null when the point has no projection).
    return worldToEngine(threeToWorldFt([hit.x, hit.y, hit.z]), metricCal.camera, metricCal.depth_fit);
  }
  return worldToLight([hit.x, hit.y, hit.z]);
}

function onPlacementMove(e) {
  if (!placement || placement.phase() !== 'awaitingTarget' || !targetViz) {
    targetViz?.clearPreview();
    return;
  }
  const L = placement.pendingLight();
  const engPt = placementEngPoint(e);
  if (!L || !engPt) { targetViz.clearPreview(); return; }
  targetViz.showPreview(L.position, engPt);
}

function onPlacementContext(e) {
  if (!placement || !placement.isActive()) return;
  e.preventDefault();
  placement.cancel();
}

function onCanvasClick(e) {
  if (e.button !== 0) return;                 // left click only
  if (placement && placement.isActive()) {
    const engPt = placementEngPoint(e);
    if (engPt) placement.acceptSurfacePoint(engPt);
    return;
  }
  if (!api || primitives.size === 0) return;
  const canvas = e.currentTarget;
  const rect = canvas.getBoundingClientRect();
  mouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
  mouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
  raycaster.setFromCamera(mouse, api.getActiveCamera());
  // Collect all hit targets across primitives.
  const hits = [];
  for (const p of primitives.values()) {
    hits.push(p.sphere, p.hit);
  }
  const intersects = raycaster.intersectObjects(hits, false);
  if (intersects.length === 0) return;
  const lightId = intersects[0].object.userData.lightId;
  if (lightId && onLightSelected) onLightSelected(lightId);
}

export function syncLightsToScene(lights, selectedId) {
  if (!api) return;
  const ops = diffLights(prevLights, lights);
  applyOps(api.scene, primitives, ops);
  setSelected(primitives, selectedId);
  prevLights = lights.map((l) => structuredClone(l));

  // Attach gizmo to the selected light — or to its target marker when targeted.
  if (gizmoApi) {
    const selectedPrim = selectedId ? primitives.get(selectedId) : null;
    const selectedLight = lights.find((l) => l.id === selectedId);
    if (selectedLight && isTargeted(selectedLight) && targetViz) {
      targetViz.show(selectedLight);
      gizmoApi.attachTarget(targetViz.marker, selectedLight.id);
    } else {
      if (targetViz) targetViz.hide();
      if (selectedPrim && selectedLight) {
        gizmoApi.attach(selectedPrim, selectedLight.type);
      } else {
        gizmoApi.detach();
      }
    }
  }
}

/** Build (or rebuild) the scene for a prepared image. `calibration` switches
 * the viewport into the feet frame: the cloud is projected through the solved
 * camera, a deck grid is added, lights read their `_ft` fields, and the home
 * view frames stage + lights. Overlapping calls are serialized by `loadSeq`:
 * a superseded load disposes its result instead of adding it. */
export async function loadScene3D({ assetUrls, calibration = null, units = 'ft' }) {
  if (!api) return;
  const seq = ++loadSeq;
  // Detach any in-flight gizmo before primitives go away.
  gizmoApi?.detach();
  if (targetViz) targetViz.hide();
  // Dispose old cloud + primitives (new scene = different subject).
  if (currentPointCloud) {
    disposePointCloud(currentPointCloud);
    currentPointCloud = null;
  }
  for (const p of primitives.values()) disposeLightPrimitive(p);
  primitives.clear();
  prevLights = [];
  removeStage(api.scene);

  lastAssetUrls = assetUrls || null;
  metricCal = calibration || null;
  metricUnits = units || 'ft';
  raycaster.params.Points.threshold = POINT_HIT_THRESHOLD * metricScale(metricCal);
  setLightMetric(metricCal, null);
  targetViz?.setMetric(metricCal);

  if (!assetUrls) { api.resetCamera(null); return; }
  const cloud = await buildPointCloud({
    originalUrl: assetUrls.original_png_url,
    depthUrl: assetUrls.depth_png_url,
    sourceCanvas2D: document.getElementById('canvas'),
    calibration: metricCal,
  });
  if (seq !== loadSeq) { disposePointCloud(cloud); return; }   // superseded
  currentPointCloud = cloud;
  api.scene.add(currentPointCloud.points);

  if (metricCal) {
    api.scene.add(buildStage(metricCal, metricUnits));
    // Stage-range bounds (the raw cloud reaches the 10 000 ft depth clamp).
    const bounds = currentPointCloud.bounds.isEmpty()
      ? new THREE.Box3().setFromObject(currentPointCloud.points)
      : currentPointCloud.bounds.clone();
    setLightMetric(metricCal, bounds.clone());
    // Primitives re-added while the cloud was loading did not know the
    // bounds yet; refresh them so FOH lights switch to fixture markers.
    for (const L of prevLights) primitives.get(L.id)?.update(L);
    api.resetCamera(frameBounds(bounds));
  } else {
    api.resetCamera(null);
  }
}

/** Box3 to frame in the home view: the point cloud plus every calibrated
 * light's feet position (FOH fixtures sit well outside the cloud). */
function frameBounds(cloudBounds) {
  const b = cloudBounds.clone();
  for (const L of prevLights) {
    if (L.type !== 'reflector' && Array.isArray(L.position_ft)) {
      b.expandByPoint(new THREE.Vector3(...worldFtToThree(L.position_ft)));
    }
  }
  return b;
}

/** Calibration changed (or was cleared): rebuild the scene in the new frame.
 * Skips when `cal` is the record already loaded (applyScene passes it through
 * loadScene3D itself). Callers re-sync lights afterwards. */
export async function setCalibration3D(cal, units = metricUnits) {
  if (!api) return;
  if ((cal || null) === metricCal && (units || 'ft') === metricUnits) return;
  if (!lastAssetUrls) { metricCal = cal || null; metricUnits = units || 'ft'; setLightMetric(metricCal, null); return; }
  await loadScene3D({ assetUrls: lastAssetUrls, calibration: cal, units });
}

/** Display units for the deck grid (ft | m). */
export function setUnits3D(units) {
  metricUnits = units === 'm' ? 'm' : 'ft';
  if (api && metricCal) updateStageUnits(api.scene, metricCal, metricUnits);
}

/** Re-frame the home view once lights are known (FOH fixtures extend it). */
export function frameStage3D() {
  if (!api || !metricCal || !currentPointCloud) return;
  const b = currentPointCloud.bounds.isEmpty()
    ? new THREE.Box3().setFromObject(currentPointCloud.points)
    : currentPointCloud.bounds;
  api.resetCamera(frameBounds(b));
}

/** Mirror the live 2D-render canvas into the point cloud's texture.
 * Call this immediately after every classical render so the 3D pane
 * reflects whatever the 2D pane is currently showing. */
export function refreshPointCloudColor() {
  if (!currentPointCloud) return;
  const canvas2D = document.getElementById('canvas');
  currentPointCloud.refreshFrom(canvas2D);
}

export function dispose3D() {
  if (!api) return;
  if (gizmoApi) { gizmoApi.dispose(); gizmoApi = null; }
  if (targetViz) { targetViz.dispose(); targetViz = null; }
  if (currentPointCloud) disposePointCloud(currentPointCloud);
  for (const p of primitives.values()) disposeLightPrimitive(p);
  primitives.clear();
  removeStage(api.scene);
  api.dispose();
  api = null;
  currentPointCloud = null;
  metricCal = null;
  lastAssetUrls = null;
  setLightMetric(null, null);
  if (window.__scene3d) delete window.__scene3d;
}

export function isMetric3D() { return isMetric(); }

export function getApi3D() { return api; }
export function getPointCloud() { return currentPointCloud; }

export function setGizmoMode(mode) {
  if (gizmoApi) gizmoApi.setMode(mode);
}

export function getGizmoMode() {
  return gizmoApi ? gizmoApi.getMode() : null;
}

export function notifyPlacementPhase(phase) {
  if (!targetViz) return;
  if (phase !== 'awaitingTarget') targetViz.clearPreview();
}
