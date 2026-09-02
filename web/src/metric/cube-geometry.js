/**
 * Calibration cube geometry (pure): the stage box and house box on the
 * photo, the guessed default camera, handle ↔ marks mapping with the drag
 * clamps, house edge projection and its inverse, and the gizmo → camera
 * mapping. Imports only Spec 1's calibration helpers; no DOM, no Three.
 *
 * Image coords: u in [0,1] left→right, v in [0,1] top→bottom (see
 * calibration.js). World feet: origin at the centre of the lip on the deck,
 * +X audience right, +Y up, +Z upstage.
 */
import { worldToPixel, Z_CAM_MIN } from './calibration.js';
import { defaultHouse } from '../rig/geometry.js';

export const MIN_LIP_FRACTION = 0.05;    // must match calibration.js validateMarks
const EPS = 1e-3;                        // margin that keeps a clamped drag strictly inside the rules
const GUESS_DIST_FACTOR = 1.5;           // dist = 1.5·width
const GUESS_CAMERA_HEIGHT_FT = 6;
const GUESS_LIP_SPAN = 0.7;              // lip spans 70% of the image width
const GUESS_LIP_V = 0.72;                // lip line lands at v = 0.72
const GUESS_TOP_V_MIN = 0.1;             // ... and the top of the opening no higher than v = 0.1
const BACK_RATIO_MIN = 0.05;             // back/lip width ratio floor (dist = D·r/(1−r) stays positive and sane)
const BACK_RATIO_MAX = 0.98;             // ... and cap (the lip stays clearly wider than the back)
const DIST_FLOOR_FT = 2 * Z_CAM_MIN * 1.01;   // the camera stays this far ahead of the lip (cameraFromGizmoDelta's floor, with margin)
const HOUSE_GUIDE_FRACTION = 0.5;        // guides run toward a point 0.5·house depth toward the camera
const CEILING_MARGIN_FT = 0.5;           // ceiling must clear the opening by at least this
const MIN_HOUSE_DEPTH_FT = 1;

const clamp01 = (x) => Math.min(1, Math.max(0, x));
const clone = (marks) => Object.fromEntries(Object.entries(marks).map(([k, p]) => [k, p.slice()]));

/** Eight corners of the stage box [±W/2, {0, H}, {0, D}] in world feet. */
export function stageCorners({ width_ft: W, height_ft: H, depth_ft: D }) {
  const x = W / 2;
  return {
    fbl: [-x, 0, 0], fbr: [x, 0, 0], ftl: [-x, H, 0], ftr: [x, H, 0],
    bbl: [-x, 0, D], bbr: [x, 0, D], btl: [-x, H, D], btr: [x, H, D],
  };
}

/**
 * The default pose before any solve: a head-on camera 1.5·width away, 6 ft
 * up, focal length so the lip spans 70% of the image (less when a tall
 * opening or a wide photo would push the top of the opening above v = 0.1,
 * so every handle starts inside the photo), lip line at v = 0.72.
 * A CameraModel like solveCamera's (no solve involved).
 */
export function guessCamera({ width_ft: W, height_ft: H, depth_ft: D }, aspect) {
  const dist_ft = GUESS_DIST_FACTOR * W;
  const fSpan = GUESS_LIP_SPAN * dist_ft / W;
  const fTop = H > 0 ? (GUESS_LIP_V - GUESS_TOP_V_MIN) * aspect * dist_ft / H : fSpan;
  const f = Math.min(fSpan, fTop);
  const height_ft = GUESS_CAMERA_HEIGHT_FT;
  // The lip (Y = 0, Z = 0) projects at va = va_h + height·f/dist; choose va_h so v = 0.72.
  const va_h = GUESS_LIP_V * aspect - f * height_ft / dist_ft;
  return {
    f, dist_ft, height_ft, u_c: 0.5, va_h, k_y: 1, aspect,
    height_check_pct: 0,
    perspective_ratio: dist_ft / (dist_ft + D),
  };
}

/** The five handle points for a camera and dimensions: lip corners, back corners, front-top midpoint. */
export function handlePoints(cam, dims) {
  const c = stageCorners(dims);
  const px = (p) => { const r = worldToPixel(p, cam); return r ? [r[0], r[1]] : null; };
  const topMid = px([0, dims.height_ft, 0]);
  return {
    lipL: px(c.fbl), lipR: px(c.fbr),
    top: topMid ? [cam.u_c, topMid[1]] : null,
    backL: px(c.bbl), backR: px(c.bbr),
  };
}

/** Marks for a camera pose: the handle points (default pose, gizmo mapping). */
export function marksFromCamera(cam, dims) { return handlePoints(cam, dims); }

/**
 * Clamp a handle drag so validateMarks can never fail and the solve stays
 * sane, whatever sequence of drags came before: every corner is fenced
 * against the OTHER corners (not their means), so each lip corner sits
 * below both back corners and the top, each back corner above both lip
 * corners, the top above both lip corners at u_c; the lip is at least 5%
 * of the image wide; and the back/lip width ratio r stays within
 * [rMin, 0.98], where rMin keeps the solved distance D·r/(1−r) at or above
 * the camera floor (pass `dims` for the depth; without it a 5% floor
 * applies). Symmetric for left/right.
 */
export function clampStageDrag(marks, key, [u, v], dims = null) {
  const m = marks;
  u = clamp01(u); v = clamp01(v);
  const wLip = Math.abs(m.lipR[0] - m.lipL[0]);
  const wBack = Math.abs(m.backR[0] - m.backL[0]);
  const D = dims?.depth_ft > 0 ? dims.depth_ft : null;
  const rMin = Math.max(BACK_RATIO_MIN, D ? DIST_FLOOR_FT / (D + DIST_FLOOR_FT) : 0);
  const lipMin = Math.max(MIN_LIP_FRACTION + EPS, wBack / BACK_RATIO_MAX);   // the lip stays wider than the back (and than 5%, with margin)
  const lipMax = Math.max(lipMin, wBack / rMin);                         // ... but not so wide the camera lands on the lip
  const lipLow = Math.min(m.lipL[1], m.lipR[1]);                         // per-corner vertical fences
  const backHigh = Math.max(m.backL[1], m.backR[1]);
  switch (key) {
    case 'lipL':
      u = Math.min(u, m.lipR[0] - lipMin);
      u = Math.max(u, m.lipR[0] - lipMax);
      v = Math.max(v, Math.max(backHigh, m.top[1]) + EPS);
      break;
    case 'lipR':
      u = Math.max(u, m.lipL[0] + lipMin);
      u = Math.min(u, m.lipL[0] + lipMax);
      v = Math.max(v, Math.max(backHigh, m.top[1]) + EPS);
      break;
    case 'backL':
      u = Math.min(u, m.backR[0] - rMin * wLip - EPS);
      u = Math.max(u, m.backR[0] - BACK_RATIO_MAX * wLip);
      v = Math.min(v, lipLow - EPS);
      break;
    case 'backR':
      u = Math.max(u, m.backL[0] + rMin * wLip + EPS);
      u = Math.min(u, m.backL[0] + BACK_RATIO_MAX * wLip);
      v = Math.min(v, lipLow - EPS);
      break;
    case 'top':
      u = (m.lipL[0] + m.lipR[0]) / 2;
      v = Math.min(v, lipLow - EPS);
      break;
    default:
      throw new Error(`unknown handle ${key}`);
  }
  return [clamp01(u), clamp01(v)];
}

/** New marks with one handle moved (input untouched); the top handle stays at u_c. */
export function applyHandleDrag(marks, key, [u, v]) {
  const next = clone(marks);
  next[key] = key === 'top' ? [(marks.lipL[0] + marks.lipR[0]) / 2, v] : [u, v];
  return next;
}

/**
 * House cross-section in the proscenium plane (Z = 0) as image lines, plus
 * guide segments from each corner toward a point 0.5·depth toward the camera
 * (the room's side walls, floor and ceiling as seen from inside).
 */
export function houseEdgesPx(cam, house) {
  const { left_wall_ft: L, right_wall_ft: R, floor_drop_ft: drop, ceiling_ft: ceil, depth_ft: depth } = house;
  const pl = worldToPixel([L, 0, 0], cam), pr = worldToPixel([R, 0, 0], cam);
  const pf = worldToPixel([0, -drop, 0], cam), pc = worldToPixel([0, ceil, 0], cam);
  if (!pl || !pr || !pf || !pc) return null;   // the proscenium plane is behind the camera: nothing to draw
  const left = pl[0], right = pr[0], floor = pf[1], ceiling = pc[1];
  const guides = [];
  for (const [X, Y] of [[L, -drop], [L, ceil], [R, -drop], [R, ceil]]) {
    const from = worldToPixel([X, Y, 0], cam);
    // Step toward the camera, backing off while the point would sit behind it.
    let z = -HOUSE_GUIDE_FRACTION * depth;
    let to = null;
    for (let i = 0; i < 8 && !to; i++) {
      if (cam.dist_ft + z > Z_CAM_MIN) to = worldToPixel([X, Y, z], cam);
      z /= 2;
    }
    if (from && to) guides.push([[from[0], from[1]], [to[0], to[1]]]);
  }
  return { left, right, floor, ceiling, guides };
}

/** Inverse of houseEdgesPx for one edge at Z_cam = dist: X from u (walls), Y from v (floor/ceiling). */
export function housePxToFt(cam, edge, value) {
  if (edge === 'left' || edge === 'right') return (value - cam.u_c) * cam.dist_ft / cam.f;
  if (edge === 'floor' || edge === 'ceiling') {
    return cam.k_y * (cam.height_ft - (value * cam.aspect - cam.va_h) * cam.dist_ft / cam.f);
  }
  throw new Error(`unknown house edge ${edge}`);
}

/**
 * Apply a patch to the house within the rules: floor at or below the deck,
 * ceiling above the opening, walls at least a stage width apart, positive
 * depth. Any edit clears `estimated`. An empty patch returns the input.
 */
export function clampHouse(house, dims, patch = {}) {
  if (!patch || Object.keys(patch).length === 0) return house;
  const h = { ...house, ...patch };
  h.floor_drop_ft = Math.max(0, Number.isFinite(h.floor_drop_ft) ? h.floor_drop_ft : 0);
  h.ceiling_ft = Math.max(dims.height_ft + CEILING_MARGIN_FT, Number.isFinite(h.ceiling_ft) ? h.ceiling_ft : 0);
  h.depth_ft = Math.max(MIN_HOUSE_DEPTH_FT, Number.isFinite(h.depth_ft) ? h.depth_ft : 0);
  if ('left_wall_ft' in patch) h.left_wall_ft = Math.min(h.left_wall_ft, h.right_wall_ft - dims.width_ft);
  if ('right_wall_ft' in patch) h.right_wall_ft = Math.max(h.right_wall_ft, h.left_wall_ft + dims.width_ft);
  if (h.right_wall_ft - h.left_wall_ft < dims.width_ft) h.right_wall_ft = h.left_wall_ft + dims.width_ft;
  h.estimated = false;
  return h;
}

/**
 * A house that satisfies the venue rules for these stage dims: an estimated
 * (or malformed) house is re-derived from them, an edited one is clamped so
 * the walls stay at least a stage width apart and the ceiling clears the
 * opening. Used before a venue write and whenever the draft's dims change.
 */
export function houseForDims(house, dims) {
  if (!house || house.estimated || !Number.isFinite(house.left_wall_ft)) return defaultHouse(dims);
  return clampHouse(house, dims, { left_wall_ft: house.left_wall_ft });
}

/** The house patch for a handle drag on the photo: walls take X from u, floor and ceiling take Y from v. */
export function houseDragPatch(cam, edge, [u, v]) {
  switch (edge) {
    case 'left': return { left_wall_ft: housePxToFt(cam, 'left', u) };
    case 'right': return { right_wall_ft: housePxToFt(cam, 'right', u) };
    case 'floor': return { floor_drop_ft: -housePxToFt(cam, 'floor', v) };
    case 'ceiling': return { ceiling_ft: housePxToFt(cam, 'ceiling', v) };
    default: throw new Error(`unknown house edge ${edge}`);
  }
}

/** Walls for a typed house width: kept centred where they are, set the given distance apart. */
export function houseWidthPatch(house, widthFt) {
  const c = (house.left_wall_ft + house.right_wall_ft) / 2;
  return { left_wall_ft: c - widthFt / 2, right_wall_ft: c + widthFt / 2 };
}

/**
 * The gizmo delta that turns camera `from` into camera `to` (inverse of
 * cameraFromGizmoDelta, using `from`'s f/dist for the u_c → X conversion):
 * where the draft's stage box sits relative to the applied frame in 3D.
 */
export function cameraDelta(from, to) {
  return [
    (to.u_c - from.u_c) * from.dist_ft / from.f,
    from.height_ft - to.height_ft,     // the box lifted by dy = the camera dy lower
    to.dist_ft - from.dist_ft,
  ];
}

/**
 * Move the box by a 3D gizmo delta in feet with the camera as the thing
 * that really moves: dx slides the principal point (u_c += dx·f/dist), a
 * lift of dy puts the camera dy lower (so the stage rises on the photo),
 * dz moves the box away from the camera (dist += dz). Returns the camera
 * and its marks.
 */
export function cameraFromGizmoDelta(cam, dims, [dx, dy, dz]) {
  const camera = {
    ...cam,
    u_c: cam.u_c + dx * cam.f / cam.dist_ft,
    height_ft: cam.height_ft - dy,
    dist_ft: Math.max(Z_CAM_MIN * 2, cam.dist_ft + dz),
  };
  camera.perspective_ratio = camera.dist_ft / (camera.dist_ft + dims.depth_ft);
  return { camera, marks: marksFromCamera(camera, dims) };
}
