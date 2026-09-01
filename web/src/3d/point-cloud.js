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

import { Z_SCALE, pixelToWorld, worldFtToThree } from './coords.js';
import { depthToZcam, pixelToWorld as pixelToWorldFt } from '../metric/calibration.js';

const MAX_POINTS = 1_000_000;
const _tmp = new THREE.Vector3();
// Cap the mirror canvas's long edge so per-frame texture uploads stay cheap.
// The point cloud is stride-downsampled to ~1M points anyway — a higher-
// resolution texture wastes GPU bandwidth without adding visible detail.
const MAX_MIRROR_DIM = 1024;

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
    // u_size is in world-space units (matches PointsMaterial.size). The
    // 1000 multiplier roughly accounts for a typical viewport height in
    // pixels so a u_size of ~0.005 gives 1–2 px points at unit distance.
    gl_PointSize = u_size * 1000.0 / max(0.1, -mv.z);
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

/** World-unit scale of a calibrated scene relative to the engine frame (which
 * spans ~2 units): half the stage width in feet. Used so point size, hit
 * thresholds and light primitives keep a similar screen size. */
export function metricScale(calibration) {
  return calibration ? Math.max(1, calibration.width_ft / 2) : 1;
}

export async function buildPointCloud({ originalUrl, depthUrl, sourceCanvas2D, zScale = Z_SCALE, calibration = null }) {
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

  // Bounds of the *stage-range* points (Three frame). Calibrated depth fits
  // send background pixels toward Z_CAM_MAX (10 000 ft), which would make the
  // raw bounding box useless for framing and fixture classification, so only
  // points within [−0.5·D, 2·D] of the lip in world Z and a sane X/Y band
  // count. Uncalibrated clouds use their full extent.
  const bounds = new THREE.Box3();
  const D = calibration?.depth_ft ?? 0;
  const Wft = calibration?.width_ft ?? 0;
  const Hft = calibration?.height_ft ?? 0;

  let i = 0;
  for (let r = 0; r < H; r += stride) {
    for (let c = 0; c < W; c += stride) {
      const idx = (r * W + c) * 4;
      const d = depthPx[idx] / 255;
      let x, y, z;
      if (calibration) {
        // Calibrated: per-pixel position in feet via the same camera model the
        // shader uses (metric_pixel_to_world), then into the Three frame.
        const fit = calibration.depth_fit;
        const zc = fit ? depthToZcam(d, fit) : calibration.camera.dist_ft + d * calibration.depth_ft;
        const [X, Y, Z] = pixelToWorldFt(c / (W - 1), r / (H - 1), zc, calibration.camera);
        [x, y, z] = worldFtToThree([X, Y, Z]);
        if (Z >= -0.5 * D && Z <= 2 * D && Math.abs(X) <= 1.5 * Wft && Y >= -0.5 * Hft && Y <= 3 * Hft) {
          bounds.expandByPoint(_tmp.set(x, y, z));
        }
      } else {
        [x, y, z] = pixelToWorld(c, r, d, W, H, zScale);
        bounds.expandByPoint(_tmp.set(x, y, z));
      }
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
  // drawing buffer may be cleared after compositing. Capped to MAX_MIRROR_DIM
  // on the long edge to keep per-frame texture uploads cheap.
  const mirrorScale = Math.min(1, MAX_MIRROR_DIM / Math.max(W, H));
  const mirrorW = Math.max(1, Math.round(W * mirrorScale));
  const mirrorH = Math.max(1, Math.round(H * mirrorScale));
  const mirror = document.createElement('canvas');
  mirror.width = mirrorW;
  mirror.height = mirrorH;
  const mirrorCtx = mirror.getContext('2d');
  // Seed with the original image so the first 3D frame has something to
  // show before any classical render fires.
  const seedImg = document.createElement('canvas');
  seedImg.width = W; seedImg.height = H;
  seedImg.getContext('2d').putImageData(origData, 0, 0);
  mirrorCtx.drawImage(seedImg, 0, 0, mirrorW, mirrorH);

  const texture = new THREE.CanvasTexture(mirror);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;

  const mat = new THREE.ShaderMaterial({
    uniforms: {
      u_map:     { value: texture },
      // world-space size; matches old PointsMaterial.size. Scaled with the
      // stage width in calibrated scenes so points keep a similar screen size.
      u_size:    { value: 0.005 * metricScale(calibration) },
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
      mirrorCtx.drawImage(canvas, 0, 0, mirrorW, mirrorH);
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
    bounds,   // THREE.Box3 of the stage-range points (see above)
  };
}

export function disposePointCloud(pc) {
  if (!pc) return;
  pc.geometry.dispose();
  pc.material.dispose();
  if (pc.texture) pc.texture.dispose();
  if (pc.points.parent) pc.points.parent.remove(pc.points);
}
