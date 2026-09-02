// Rig geometry: hanging positions, area grid, and starter rigs, all in the
// Spec 1 world frame (feet; origin centre of the lip on the deck, +X audience
// right, +Y up, +Z upstage). Pure: no DOM, no Three.

export const POSITION_KINDS = ['pipe', 'boom', 'floor'];
export const FLOOR_LIFT_FT = 0.5;

export function positionToWorld(p, offsetFt) {
  switch (p.kind) {
    case 'pipe':  return [offsetFt, p.trim_ft, p.upstage_ft];
    case 'boom':  return [p.offset_ft, offsetFt, p.upstage_ft];
    case 'floor': return [offsetFt, FLOOR_LIFT_FT, p.upstage_ft];
    default: throw new Error(`unknown position kind ${p.kind}`);
  }
}

export function nearestOffset(p, [X, Y]) { return p.kind === 'boom' ? Y : X; }

export function areaLabels(grid) {
  const n = grid.rows * grid.cols; const out = [];
  for (let i = 1; i <= n; i++) out.push(String(i));
  return out;
}

export function areaCenter(venue, label) {
  const g = venue.grid; const i = parseInt(label, 10);
  if (!Number.isInteger(i) || i < 1 || i > g.rows * g.cols) return null;
  const row = Math.floor((i - 1) / g.cols);            // 0 = downstage
  let col = (i - 1) % g.cols;                          // 0 = audience-left (−X)
  if (g.number_from_stage_left) col = g.cols - 1 - col;
  const cellW = venue.width_ft / g.cols, cellD = venue.depth_ft / g.rows;
  const X = -venue.width_ft / 2 + (col + 0.5) * cellW;
  const Z = (row + 0.5) * cellD;
  return [X, venue.focus_height_ft ?? 5, Z];
}

export function linearEndpoints(p, offsetFt, lengthFt) {
  const c = positionToWorld(p, offsetFt); const h = lengthFt / 2;
  return p.kind === 'boom'
    ? [[c[0], c[1] - h, c[2]], [c[0], c[1] + h, c[2]]]
    : [[c[0] - h, c[1], c[2]], [c[0] + h, c[1], c[2]]];
}

let _pid = 0;
const pid = () => `pos_${Date.now().toString(36)}_${(_pid++).toString(36)}`;

export function starterPositions({ width_ft, height_ft, depth_ft }) {
  const r = (v) => Math.round(v * 10) / 10;
  return [
    { id: pid(), name: 'FOH truss',    kind: 'pipe', upstage_ft: r(-depth_ft * 1.3), trim_ft: r(height_ft + 2) },
    { id: pid(), name: '1st electric', kind: 'pipe', upstage_ft: r(depth_ft * 0.20), trim_ft: r(height_ft) },
    { id: pid(), name: '2nd electric', kind: 'pipe', upstage_ft: r(depth_ft * 0.47), trim_ft: r(height_ft) },
    { id: pid(), name: '3rd electric', kind: 'pipe', upstage_ft: r(depth_ft * 0.73), trim_ft: r(height_ft) },
    { id: pid(), name: 'Boom SR', kind: 'boom', offset_ft: r(-(width_ft / 2 + 2)), upstage_ft: r(depth_ft * 0.27) },
    { id: pid(), name: 'Boom SL', kind: 'boom', offset_ft: r(width_ft / 2 + 2),  upstage_ft: r(depth_ft * 0.27) },
  ];
}

// Short position name for default fixture names: leading digits of a word
// that starts with one ("1st" → "1"), a two-letter all-caps word whole
// ("SR", "SL"), otherwise the initial; single words keep up to three
// characters. Max four characters. "1st electric" → 1E, "FOH truss" → FT,
// "Boom SR" → BSR.
export function shortName(name) {
  const words = String(name).trim().split(/\s+/);
  let s = words.map((w) => {
    if (/^\d/.test(w)) return w.match(/^\d+/)[0];
    if (/^[A-Z]{1,2}$/.test(w)) return w;
    return w[0].toUpperCase();
  }).join('');
  if (words.length === 1) s = words[0].replace(/[^A-Za-z0-9]/g, '').slice(0, 3).toUpperCase();
  return s.slice(0, 4);
}
export function defaultFixtureName(position, index) { return `${shortName(position.name)}-${index}`; }

/**
 * The calibration record keeps only photo-specific parts (marks, depth fit,
 * units); its stage dimensions are a read-only mirror of the scene's venue.
 * Returns a copy with the venue's width/height/depth, or the input untouched
 * when either side is missing.
 */
export function mergeVenueIntoCalibration(calibration, venue) {
  if (!calibration || !venue) return calibration;
  return {
    ...calibration,
    width_ft: venue.width_ft,
    height_ft: venue.height_ft,
    depth_ft: venue.depth_ft,
  };
}

// House defaults for a venue without `house` (calibration cube spec):
// walls ±0.75·width, floor 3 ft below the deck, ceiling 10 ft above the
// opening, house depth twice the stage depth; `estimated` until edited.
export function defaultHouse({ width_ft, height_ft, depth_ft }) {
  return {
    left_wall_ft: -0.75 * width_ft,
    right_wall_ft: 0.75 * width_ft,
    floor_drop_ft: 3,
    ceiling_ft: height_ft + 10,
    depth_ft: 2 * depth_ft,
    estimated: true,
  };
}

export const SYNTHETIC_VENUE = {
  id: 'venue_test', name: 'Test House', width_ft: 40, height_ft: 20, depth_ft: 30,
  grid: { rows: 3, cols: 3, number_from_stage_left: false }, focus_height_ft: 5,
  positions: [
    { id: 'p_foh', name: 'FOH', kind: 'pipe', upstage_ft: -52, trim_ft: 22 },
    { id: 'p_1e', name: '1E', kind: 'pipe', upstage_ft: 6, trim_ft: 20 },
    { id: 'p_2e', name: '2E', kind: 'pipe', upstage_ft: 14, trim_ft: 20 },
    { id: 'p_3e', name: '3E', kind: 'pipe', upstage_ft: 22, trim_ft: 20 },
    { id: 'p_bsr', name: 'BSR', kind: 'boom', offset_ft: -22, upstage_ft: 8 },
    { id: 'p_bsl', name: 'BSL', kind: 'boom', offset_ft: 22, upstage_ft: 8 },
  ],
};
