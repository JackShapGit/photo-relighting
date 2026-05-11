/** Coordinate transforms between image-pixel space and the 3D world.
 *
 * Reuses the engine's existing convention exactly: image (x, y) maps to
 * world (x, -y), depth [0,1] maps to z centered around 0 with Z_SCALE.
 * No additional conversion layer needed elsewhere.
 */

export const Z_SCALE = 1.5;

/** (col, row, depth) → [worldX, worldY, worldZ]. */
export function pixelToWorld(col, row, depth, W, H, zScale = Z_SCALE) {
  const x = (col / (W - 1)) * 2 - 1;
  const y = -((row / (H - 1)) * 2 - 1);
  const z = (depth - 0.5) * zScale;
  return [x, y, z];
}

/** [worldX, worldY] → [col, row] in image pixel coords. */
export function worldToPixel(worldX, worldY, W, H) {
  const col = ((worldX + 1) / 2) * (W - 1);
  const row = ((-worldY + 1) / 2) * (H - 1);
  return [col, row];
}

// ─── Inline self-test (dev-mode only) ────────────────────────────────────

function _assert(cond, msg) {
  if (!cond) throw new Error(`[coords-assert] ${msg}`);
}

if (typeof window !== 'undefined' && window.location.hostname === 'localhost') {
  // Top-left pixel of a 100x100 image at depth 0.5 → world (-1, +1, 0).
  const tl = pixelToWorld(0, 0, 0.5, 100, 100);
  _assert(Math.abs(tl[0] - (-1)) < 1e-6, `top-left x: got ${tl[0]}`);
  _assert(Math.abs(tl[1] - 1) < 1e-6, `top-left y: got ${tl[1]}`);
  _assert(Math.abs(tl[2]) < 1e-6, `top-left z at depth=0.5: got ${tl[2]}`);

  // Bottom-right pixel at depth 1 → world (+1, -1, +Z_SCALE/2).
  const br = pixelToWorld(99, 99, 1.0, 100, 100);
  _assert(Math.abs(br[0] - 1) < 1e-6, `bottom-right x: got ${br[0]}`);
  _assert(Math.abs(br[1] - (-1)) < 1e-6, `bottom-right y: got ${br[1]}`);
  _assert(Math.abs(br[2] - Z_SCALE / 2) < 1e-6, `bottom-right z: got ${br[2]}`);

  // Round-trip on a center pixel.
  const cw = pixelToWorld(50, 50, 0.5, 101, 101);
  const cp = worldToPixel(cw[0], cw[1], 101, 101);
  _assert(Math.abs(cp[0] - 50) < 1e-6, `roundtrip col: got ${cp[0]}`);
  _assert(Math.abs(cp[1] - 50) < 1e-6, `roundtrip row: got ${cp[1]}`);
}
