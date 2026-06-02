/** 3D viewport entry point. Mount once, hook lifecycle into main.js. */
import * as THREE from 'three';
import { worldToLight, lightToWorld } from './coords.js';
import './sync.js';
import { buildPointCloud, disposePointCloud } from './point-cloud.js';
import { disposeLightPrimitive } from './light-primitives.js';
import { mountOverlayPanel } from './overlay-panel.js';
import { createScene3D } from './scene.js';
import { applyOps, diffLights, setSelected } from './sync.js';
import { createGizmo } from './gizmos.js';
import { bindHotkeys } from './hotkeys.js';
import { isTargeted } from '../targeting.js';
import { createTargetViz } from './target-viz.js';

let api = null;
let currentPointCloud = null;
const primitives = new Map();
let prevLights = [];
let onLightSelected = null;
let gizmoApi = null;
let targetViz = null;
let onLightChange = null;
let placement = null;
const raycaster = new THREE.Raycaster();
const mouse = new THREE.Vector2();

export function mount3D({ onSelectLight, onUpdateLight, placement: placementCtl } = {}) {
  if (api) return api;
  const canvas = document.getElementById('canvas3d');
  if (!canvas) return null;
  api = createScene3D(canvas);
  api.resize();
  api.start();
  window.addEventListener('resize', api.resize);
  onLightSelected = onSelectLight || null;
  onLightChange = onUpdateLight || null;
  placement = placementCtl || null;

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
          // PointsMaterial.size scaling).
          if (currentPointCloud) {
            currentPointCloud.material.uniforms.u_size.value = s;
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
    onTranslate: (id, pos) => {
      if (onLightChange) onLightChange(id, { position: pos });
    },
    onRotate: (id, vec, field) => {
      if (onLightChange) onLightChange(id, { [field]: vec });
    },
    onTargetMove: (id, pos) => {
      if (onLightChange) onLightChange(id, { target: pos });
    },
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
  raycaster.params.Points.threshold = 0.03;
  let hit = null;
  if (currentPointCloud) {
    const pts = raycaster.intersectObject(currentPointCloud.points, false);
    if (pts.length) hit = pts[0].point;
  }
  if (!hit) {
    const medianEngZ = 1 - (window.__subjectMedianDepth ?? 0.3);
    placementPlane.constant = -lightToWorld([0, 0, medianEngZ])[2];
    const p = new THREE.Vector3();
    if (!raycaster.ray.intersectPlane(placementPlane, p)) return null;
    hit = p;
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

export async function loadScene3D({ assetUrls }) {
  if (!api) return;
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

  if (!assetUrls) return;
  currentPointCloud = await buildPointCloud({
    originalUrl: assetUrls.original_png_url,
    depthUrl: assetUrls.depth_png_url,
    sourceCanvas2D: document.getElementById('canvas'),
  });
  api.scene.add(currentPointCloud.points);
  api.resetCamera();
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
  api.dispose();
  api = null;
  currentPointCloud = null;
}

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
