/** Builds a THREE.Points cloud whose colors are sampled live from a 2D canvas.
 *
 * Each point owns a normalized UV attribute (`a_uv`) corresponding to its
 * pixel in the source image. A custom ShaderMaterial samples the supplied
 * 2D canvas at that UV, so whatever is currently rendered on the canvas
 * (the classical-render output, including all active lights) becomes the
 * color of the matching point — making the 3D pane a depth-displaced view
 * of the live relit image.
 *
 * Stride downsampling keeps the geometry under ~1M points for very large
 * images (about 16 MB of vertex data: 3 floats position + 2 floats UV).
 */
import * as THREE from 'three';

import { Z_SCALE, pixelToWorld } from './coords.js';

const MAX_POINTS = 1_000_000;

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

const VERT_SRC = `
  attribute vec2 a_uv;
  varying vec2 v_uv;
  uniform float u_size;
  void main() {
    v_uv = a_uv;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_PointSize = u_size * (300.0 / max(0.1, -mv.z));
    gl_Position = projectionMatrix * mv;
  }
`;

const FRAG_SRC = `
  precision highp float;
  uniform sampler2D u_map;
  uniform float u_opacity;
  varying vec2 v_uv;
  void main() {
    vec4 c = texture2D(u_map, v_uv);
    gl_FragColor = vec4(c.rgb, c.a * u_opacity);
  }
`;

export async function buildPointCloud({ originalUrl, depthUrl, sourceCanvas2D, zScale = Z_SCALE }) {
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
  const uvs = new Float32Array(n * 2);
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
      // Default Three.js CanvasTexture has flipY=true, so v=0 reads the
      // bottom of the source canvas. Image row 0 = top of canvas, so for
      // row 0 we want v=1; for row H-1 we want v=0.
      uvs[i * 2 + 0] = c / (W - 1);
      uvs[i * 2 + 1] = 1 - r / (H - 1);
      i += 1;
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.setAttribute('a_uv', new THREE.BufferAttribute(uvs, 2));

  // Offscreen 2D canvas we mirror into right after each classical render.
  // Reading from the live WebGL canvas directly is unreliable because its
  // drawing buffer may be cleared after compositing.
  const mirror = document.createElement('canvas');
  mirror.width = W;
  mirror.height = H;
  const mirrorCtx = mirror.getContext('2d');
  // Seed with the original image so the first 3D frame has something to
  // show before any classical render fires.
  const seedImg = document.createElement('canvas');
  seedImg.width = W; seedImg.height = H;
  seedImg.getContext('2d').putImageData(origData, 0, 0);
  mirrorCtx.drawImage(seedImg, 0, 0);

  const texture = new THREE.CanvasTexture(mirror);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;

  const mat = new THREE.ShaderMaterial({
    uniforms: {
      u_map:     { value: texture },
      u_size:    { value: 2.0 },
      u_opacity: { value: 0.8 },
    },
    vertexShader: VERT_SRC,
    fragmentShader: FRAG_SRC,
    transparent: true,
  });

  function refreshFrom(canvas) {
    // Mirror the current 2D-render canvas into our offscreen surface,
    // then flag the texture for re-upload on the next 3D frame.
    if (!canvas) return;
    try {
      mirrorCtx.drawImage(canvas, 0, 0, W, H);
      texture.needsUpdate = true;
    } catch (e) {
      // drawImage can throw if the source canvas is tainted (cross-origin)
      // or zero-sized; just skip the frame.
    }
  }

  const points = new THREE.Points(geo, mat);
  points.name = 'point-cloud';
  return {
    points,
    geometry: geo,
    material: mat,
    texture,
    refreshFrom,
    width: W,
    height: H,
    stride,
  };
}

export function disposePointCloud(pc) {
  if (!pc) return;
  pc.geometry.dispose();
  pc.material.dispose();
  if (pc.texture) pc.texture.dispose();
  if (pc.points.parent) pc.points.parent.remove(pc.points);
}
