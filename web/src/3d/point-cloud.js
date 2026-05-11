/** Builds a THREE.Points cloud from depth + photo URLs.
 *
 * Loads both PNGs, reads their pixel data via a hidden canvas, then writes
 * BufferGeometry position + color attributes. Returns a THREE.Points object
 * the caller can add to a scene. Includes a stride downsample so very large
 * images stay under ~1M points (about 24 MB of vertex data).
 */
import * as THREE from 'three';

import { Z_SCALE, pixelToWorld } from './coords.js';

const MAX_POINTS = 1_000_000;

function srgbToLinearByte(b) {
  const x = b / 255;
  return x <= 0.04045 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4);
}

async function loadImageData(url) {
  const img = new Image();
  img.crossOrigin = 'anonymous';
  await new Promise((resolve, reject) => {
    img.onload = resolve;
    img.onerror = reject;
    img.src = url;
  });
  const cv = document.createElement('canvas');
  cv.width = img.naturalWidth;
  cv.height = img.naturalHeight;
  const ctx = cv.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(img, 0, 0);
  return ctx.getImageData(0, 0, cv.width, cv.height);
}

export async function buildPointCloud({ originalUrl, depthUrl, zScale = Z_SCALE }) {
  const [origData, depthData] = await Promise.all([
    loadImageData(originalUrl),
    loadImageData(depthUrl),
  ]);
  const W = origData.width;
  const H = origData.height;
  if (depthData.width !== W || depthData.height !== H) {
    throw new Error(`size mismatch: original ${W}x${H} vs depth ${depthData.width}x${depthData.height}`);
  }

  // Stride downsamples uniformly until total points <= MAX_POINTS.
  let stride = 1;
  while ((Math.ceil(W / stride) * Math.ceil(H / stride)) > MAX_POINTS) stride += 1;

  const cols = Math.ceil(W / stride);
  const rows = Math.ceil(H / stride);
  const n = cols * rows;

  const positions = new Float32Array(n * 3);
  const colors = new Float32Array(n * 3);
  const origPx = origData.data;     // RGBA uint8
  const depthPx = depthData.data;   // RGBA uint8 (depth in R)

  let i = 0;
  for (let r = 0; r < H; r += stride) {
    for (let c = 0; c < W; c += stride) {
      const idx = (r * W + c) * 4;
      const d = depthPx[idx] / 255;
      const [x, y, z] = pixelToWorld(c, r, d, W, H, zScale);
      positions[i * 3 + 0] = x;
      positions[i * 3 + 1] = y;
      positions[i * 3 + 2] = z;
      colors[i * 3 + 0] = srgbToLinearByte(origPx[idx + 0]);
      colors[i * 3 + 1] = srgbToLinearByte(origPx[idx + 1]);
      colors[i * 3 + 2] = srgbToLinearByte(origPx[idx + 2]);
      i += 1;
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));

  const mat = new THREE.PointsMaterial({
    size: 0.005,
    sizeAttenuation: true,
    vertexColors: true,
    transparent: true,
    opacity: 0.8,
  });

  const points = new THREE.Points(geo, mat);
  points.name = 'point-cloud';
  return { points, geometry: geo, material: mat, width: W, height: H, stride };
}

export function disposePointCloud(pc) {
  if (!pc) return;
  pc.geometry.dispose();
  pc.material.dispose();
  if (pc.points.parent) pc.points.parent.remove(pc.points);
}
