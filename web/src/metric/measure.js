// Per-fixture readout geometry (Spec 3). Pure: no DOM, no Three, so the rig
// tab, the props pane, the ruler and node --test all share one definition.
// World frame of Spec 1 (feet; +X audience right, +Y up, +Z upstage; origin
// at the centre of the lip on the deck, so the house is at negative Z).
import { defaultHouse } from '../rig/geometry.js';
import { toDisplay } from './units.js';

const EPS = 1e-9;
const MIN_CONE = 1e-4;                        // radians: below this there is no pool
const MAX_CONE = 89 * Math.PI / 180;          // half-angle: tan explodes past this
const NO_BEAM_TYPES = new Set(['linear', 'reflector']);

/** Plain 3D euclidean distance in feet. */
export function distanceFt(a, b) {
  return Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
}

/**
 * Where origin + t·dir crosses the horizontal plane Y = y, or null when the
 * ray is parallel to it, points away from it, or already starts on it.
 */
export function planeHitY(origin, dir, y) {
  if (!Array.isArray(origin) || !Array.isArray(dir)) return null;
  if (Math.abs(dir[1]) < EPS) return null;
  const t = (y - origin[1]) / dir[1];
  if (!(t > EPS)) return null;
  return [origin[0] + dir[0] * t, y, origin[2] + dir[2] * t];
}

/**
 * True when a point lies inside the venue's house-box footprint. Used to
 * reject a mathematically valid focus-plane hit hundreds of feet outside the
 * building (a beam aimed almost parallel to the plane).
 */
export function insideHouse(pt, venue) {
  if (!Array.isArray(pt) || !venue) return false;
  const h = venue.house || defaultHouse(venue);
  return pt[0] >= h.left_wall_ft && pt[0] <= h.right_wall_ft
    && pt[2] >= -h.depth_ft && pt[2] <= venue.depth_ft;
}

/**
 * Throw distance and field diameter for one fixture, both in feet.
 * `reason` is 'ok' when both are numbers, else why they are null:
 *   no-beam        cyc/linear/reflector, or cone_angle outside (0°, 89°)
 *   no-crossing    axis parallel to the focus plane, aimed away from it, or
 *                  crossing it outside the house box
 *   degenerate     the target sits on the fixture
 *   no-venue       unaimed, and there is no venue to supply a focus height
 *   not-calibrated no position_ft
 */
export function throwAndDiameter(light, venue) {
  const none = (reason) => ({ throwFt: null, fieldDiaFt: null, reason });
  if (!light || !Array.isArray(light.position_ft)) return none('not-calibrated');
  if (NO_BEAM_TYPES.has(light.type)) return none('no-beam');
  const cone = light.cone_angle;
  if (!Number.isFinite(cone) || cone < MIN_CONE || cone > MAX_CONE) return none('no-beam');

  let aim = Array.isArray(light.target_ft) ? light.target_ft : null;
  if (!aim) {
    if (!venue) return none('no-venue');
    aim = planeHitY(light.position_ft, light.direction_ft, venue.focus_height_ft ?? 5);
    if (!aim || !insideHouse(aim, venue)) return none('no-crossing');
  }
  const throwFt = distanceFt(light.position_ft, aim);
  if (!(throwFt > EPS)) return none('degenerate');
  return { throwFt, fieldDiaFt: 2 * throwFt * Math.tan(cone), reason: 'ok' };
}

const TOOLTIPS = {
  'no-beam': 'No usable beam angle for this fixture',
  'no-crossing': 'This beam never crosses the focus height',
  degenerate: 'Target is at the fixture',
  'no-venue': 'No venue: aim this fixture to get a throw',
  'not-calibrated': 'Calibrate the scene to measure',
};

/** Tooltip for a reason code; '' for 'ok'. */
export function reasonTooltip(reason) {
  return TOOLTIPS[reason] || '';
}

/**
 * Text and tooltip for one readout cell. `kind` is 'throw' or 'dia'.
 * Pure so the fixtures table, the props pane and node --test can never word
 * the same fixture state differently.
 */
export function readoutCellText(light, venue, units, kind) {
  const r = throwAndDiameter(light, venue);
  if (r.reason !== 'ok') return { text: '—', title: reasonTooltip(r.reason) };
  const v = kind === 'throw' ? r.throwFt : r.fieldDiaFt;
  return { text: toDisplay(v, units).toFixed(1), title: '' };
}
