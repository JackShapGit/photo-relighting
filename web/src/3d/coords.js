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

/** Engine light position [engX, engY, engZ] → world [x, y, z]. */
export function lightToWorld(pos, zScale = Z_SCALE) {
  return [
    pos[0] * 2 - 1,
    -(pos[1] * 2 - 1),
    (pos[2] - 0.5) * zScale,
  ];
}

/** World [x, y, z] → engine light position [engX, engY, engZ]. */
export function worldToLight(pos, zScale = Z_SCALE) {
  return [
    (pos[0] + 1) / 2,
    (1 - pos[1]) / 2,
    pos[2] / zScale + 0.5,
  ];
}

/** Engine direction unit vector → world unit vector.
 *
 * Applies the linear part of the position transform (scales x, y, z but no
 * translation) then renormalizes. This preserves "pointing toward subject"
 * semantics after the engine↔world remap.
 */
export function directionToWorld(dir, zScale = Z_SCALE) {
  const wx = dir[0] * 2;
  const wy = -dir[1] * 2;
  const wz = dir[2] * zScale;
  const len = Math.hypot(wx, wy, wz) || 1;
  return [wx / len, wy / len, wz / len];
}

/** World unit vector → engine direction unit vector. */
export function worldToDirection(worldDir, zScale = Z_SCALE) {
  const ex = worldDir[0] * 0.5;
  const ey = -worldDir[1] * 0.5;
  const ez = worldDir[2] / zScale;
  const len = Math.hypot(ex, ey, ez) || 1;
  return [ex / len, ey / len, ez / len];
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

  // Engine ↔ world round-trip on light positions.
  const lw = lightToWorld([0.5, 0.5, 0.5]);
  _assert(Math.abs(lw[0]) < 1e-6 && Math.abs(lw[1]) < 1e-6 && Math.abs(lw[2]) < 1e-6,
          `center light: got ${lw}`);
  const lr = worldToLight(lw);
  _assert(Math.abs(lr[0] - 0.5) < 1e-6 && Math.abs(lr[1] - 0.5) < 1e-6 && Math.abs(lr[2] - 0.5) < 1e-6,
          `light roundtrip: got ${lr}`);

  // Direction round-trip.
  const dw = directionToWorld([0, 0, -1]);
  const dr = worldToDirection(dw);
  _assert(Math.abs(dr[2] - (-1)) < 1e-6, `direction roundtrip z: got ${dr}`);
}
