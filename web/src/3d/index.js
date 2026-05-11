/** 3D viewport entry point. Mount once, hook lifecycle into main.js. */
import './coords.js';   // dev-mode self-test
import { buildPointCloud, disposePointCloud } from './point-cloud.js';
import { createScene3D } from './scene.js';

let api = null;
let currentPointCloud = null;

export function mount3D() {
  if (api) return api;
  const canvas = document.getElementById('canvas3d');
  if (!canvas) return null;
  api = createScene3D(canvas);
  api.resize();
  api.start();
  window.addEventListener('resize', api.resize);
  return api;
}

export async function loadScene3D({ assetUrls }) {
  if (!api) return;
  if (currentPointCloud) {
    disposePointCloud(currentPointCloud);
    currentPointCloud = null;
  }
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
  if (currentPointCloud) disposePointCloud(currentPointCloud);
  api.dispose();
  api = null;
  currentPointCloud = null;
}

export function getApi3D() { return api; }
export function getPointCloud() { return currentPointCloud; }
