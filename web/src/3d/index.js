/** 3D viewport entry point. Mount once, hook lifecycle into main.js. */
import { createScene3D } from './scene.js';

let api = null;

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

export function dispose3D() {
  if (!api) return;
  api.dispose();
  api = null;
}
