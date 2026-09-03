// Acting-area cell geometry (Spec 2 §Grid overlay). Pure: no DOM, no Three,
// so the 3D overlay and the 2D SVG overlay share one definition and it
// runs under node --test. World frame of Spec 1 (feet; +X audience right,
// +Y up, +Z upstage; origin at the centre of the lip on the deck).

/** The deck rectangle of a cell: { x0, x1, z0, z1 } (x0 < x1, z0 < z1), or null. */
export function cellBounds(venue, label) {
  const g = venue.grid; const i = parseInt(label, 10);
  if (!g || !Number.isInteger(i) || i < 1 || i > g.rows * g.cols) return null;
  const row = Math.floor((i - 1) / g.cols);            // 0 = downstage
  let col = (i - 1) % g.cols;                          // 0 = audience-left (−X)
  if (g.number_from_stage_left) col = g.cols - 1 - col;
  const cellW = venue.width_ft / g.cols, cellD = venue.depth_ft / g.rows;
  const x0 = -venue.width_ft / 2 + col * cellW;
  const z0 = row * cellD;
  return { x0, x1: x0 + cellW, z0, z1: z0 + cellD };
}

/**
 * Four deck corners of a cell as [X, 0, Z], downstage-left first, then
 * clockwise as seen from the house (up the stage, across, back down).
 */
export function cellCorners(venue, label) {
  const b = cellBounds(venue, label);
  if (!b) return null;
  return [
    [b.x0, 0, b.z0],
    [b.x0, 0, b.z1],
    [b.x1, 0, b.z1],
    [b.x1, 0, b.z0],
  ];
}
