/** 3D viewport entry point. Mount once, hook lifecycle into main.js. */
import * as THREE from 'three';
import './coords.js';
import './sync.js';
import { buildPointCloud, disposePointCloud } from './point-cloud.js';
import { disposeLightPrimitive } from './light-primitives.js';
import { mountOverlayPanel } from './overlay-panel.js';
import { createScene3D } from './scene.js';
import { applyOps, diffLights, setSelected } from './sync.js';
import { createGizmo } from './gizmos.js';

let api = null;
let currentPointCloud = null;
const primitives = new Map();
let prevLights = [];
let onLightSelected = null;
let gizmoApi = null;
let onLightChange = null;
const raycaster = new THREE.Raycaster();
const mouse = new THREE.Vector2();

export function mount3D({ onSelectLight, onUpdateLight } = {}) {
  if (api) return api;
  const canvas = document.getElementById('canvas3d');
  if (!canvas) return null;
  api = createScene3D(canvas);
  api.resize();
  api.start();
  window.addEventListener('resize', api.resize);
  onLightSelected = onSelectLight || null;
  onLightChange = onUpdateLight || null;

  const overlayEl = document.getElementById('stage3d-overlay');
  if (overlayEl) {
    mountOverlayPanel({
      rootEl: overlayEl,
      hooks: {
        onShowPointsChange: (v) => {
          if (currentPointCloud) currentPointCloud.points.visible = v;
        },
        onPointSizeChange: (s) => {
          if (currentPointCloud) currentPointCloud.material.size = s;
        },
        onPointOpacityChange: (o) => {
          if (currentPointCloud) currentPointCloud.material.opacity = o;
        },
        onProjectionChange: (mode) => api.setProjection(mode),
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
    onRotate: (id, dir) => {
      if (onLightChange) onLightChange(id, { direction: dir });
    },
  });

  canvas.addEventListener('pointerdown', onCanvasClick);
  return api;
}

function onCanvasClick(e) {
  if (e.button !== 0) return;                 // left click only
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

  // Attach gizmo to the selected light's primitive (if any).
  if (gizmoApi) {
    const selectedPrim = selectedId ? primitives.get(selectedId) : null;
    const selectedLight = lights.find((l) => l.id === selectedId);
    if (selectedPrim && selectedLight) {
      gizmoApi.attach(selectedPrim, selectedLight.type);
    } else {
      gizmoApi.detach();
    }
  }
}

export async function loadScene3D({ assetUrls }) {
  if (!api) return;
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
  });
  api.scene.add(currentPointCloud.points);
  api.resetCamera();
}

export function dispose3D() {
  if (!api) return;
  if (gizmoApi) { gizmoApi.dispose(); gizmoApi = null; }
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
