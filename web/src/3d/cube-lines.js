/** Pure vertex lists for the calibration cube's 3D wireframes (no Three
 * import, so node can test them): the stage box and the house box as twelve
 * edges = 24 vertices in the Three frame (x = world X, y = world Y,
 * z = −world Z; see coords.js worldFtToThree). cube-3d.js wraps them in
 * THREE.LineSegments.
 */
import { worldFtToThree } from './coords.js';

export const BOX_EDGE_COUNT = 12;
// Corner order: bottom ring z0 (0..3), then the same ring at z1 (4..7).
const EDGES = [[0, 1], [1, 2], [2, 3], [3, 0], [4, 5], [5, 6], [6, 7], [7, 4], [0, 4], [1, 5], [2, 6], [3, 7]];

function boxSegments([x0, x1], [y0, y1], [z0, z1]) {
  const world = [
    [x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0],
    [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1],
  ];
  const corners = world.map(worldFtToThree);
  const positions = [];
  for (const [a, b] of EDGES) positions.push(...corners[a], ...corners[b]);
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (const c of corners) {
    for (let i = 0; i < 3; i++) { min[i] = Math.min(min[i], c[i]); max[i] = Math.max(max[i], c[i]); }
  }
  return { positions, bounds: { min, max } };
}

/** The stage volume [±W/2, 0..H, 0..D] (world), i.e. Three z from 0 back to −D. */
export function stageBoxSegments({ width_ft: W, height_ft: H, depth_ft: D }) {
  return boxSegments([-W / 2, W / 2], [0, H], [0, D]);
}

/** The house: walls X ∈ [left, right], floor to ceiling, and the house depth
 * from the proscenium plane toward the camera (world Z ∈ [−depth, 0], Three z ∈ [0, depth]). */
export function houseBoxSegments({ left_wall_ft: L, right_wall_ft: R, floor_drop_ft: drop, ceiling_ft: ceil, depth_ft: depth }) {
  return boxSegments([L, R], [-drop, ceil], [-depth, 0]);
}
