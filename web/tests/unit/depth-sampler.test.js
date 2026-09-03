import { test } from 'node:test';
import assert from 'node:assert/strict';
import { uvDepthToLight } from '../../src/3d/coords.js';
import { sampleDepthFromImageData } from '../../src/depth-sampler.js';

const close = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps;
const vclose = (a, b) => a.length === b.length && a.every((v, i) => close(v, b[i]));

test('uvDepthToLight: engine x=u, y=v, z=1-depth', () => {
  assert.ok(vclose(uvDepthToLight(0.25, 0.75, 0.0), [0.25, 0.75, 1.0]));
  assert.ok(vclose(uvDepthToLight(0.5, 0.5, 0.5), [0.5, 0.5, 0.5]));
  assert.ok(vclose(uvDepthToLight(0.1, 0.2, 1.0), [0.1, 0.2, 0.0]));
});

// Build a 2x2 RGBA ImageData-like object. Depth lives in the RED channel.
// Pixels (col,row): (0,0)=0, (1,0)=255, (0,1)=128, (1,1)=64  (red values)
function img2x2() {
  const data = new Uint8ClampedArray(2 * 2 * 4);
  const setR = (col, row, r) => { data[(row * 2 + col) * 4] = r; };
  setR(0, 0, 0); setR(1, 0, 255); setR(0, 1, 128); setR(1, 1, 64);
  return { width: 2, height: 2, data };
}

test('sampleDepthFromImageData: maps (u,v) to the right pixel red/255', () => {
  const im = img2x2();
  assert.ok(close(sampleDepthFromImageData(im, 0.1, 0.1), 0 / 255));
  assert.ok(close(sampleDepthFromImageData(im, 0.9, 0.1), 255 / 255));
  assert.ok(close(sampleDepthFromImageData(im, 0.1, 0.9), 128 / 255));
  assert.ok(close(sampleDepthFromImageData(im, 0.9, 0.9), 64 / 255));
});

test('sampleDepthFromImageData: clamps out-of-range (u,v) into the image', () => {
  const im = img2x2();
  assert.ok(close(sampleDepthFromImageData(im, -5, -5), 0 / 255));
  assert.ok(close(sampleDepthFromImageData(im, 5, 5), 64 / 255));
});
