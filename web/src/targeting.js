// Pure helpers for optional light targeting.
//
// A light is "targeted" iff its `target` field is a non-null [x, y, z] point in
// ENGINE space (the same space as `position`). When targeted, the light's
// `direction` is DERIVED from `target - position` and must never be hand-edited;
// the free-aim direction controls are suppressed by the UI in that mode.
//
// Only directional/spotlight lights may be targeted (point lights are
// omnidirectional; reflectors aim via `normal`).

export const TARGET_SPAWN_DIST = 1.0;   // engine-space units in front of the light
const EPS = 1e-6;

export function isTargeted(light) {
  return (light.type === 'directional' || light.type === 'spotlight')
    && Array.isArray(light.target);
}

// Normalized direction a targeted light should point. Returns a copy of the
// light's existing direction when not targeted, or when target coincides with
// position (degenerate — avoids normalizing a zero vector).
export function deriveDirection(light) {
  if (!isTargeted(light)) return light.direction.slice();
  const [px, py, pz] = light.position;
  const [tx, ty, tz] = light.target;
  const vx = tx - px, vy = ty - py, vz = tz - pz;
  const len = Math.hypot(vx, vy, vz);
  if (len < EPS) return light.direction.slice();
  return [vx / len, vy / len, vz / len];
}

// Spawn point for a freshly-toggled target: a fixed distance along the light's
// current (normalized) direction, so direction — and the rendered beam — does
// not visibly jump when targeting turns on.
export function targetSpawnPoint(light, dist = TARGET_SPAWN_DIST) {
  const [px, py, pz] = light.position;
  let [dx, dy, dz] = light.direction;
  const len = Math.hypot(dx, dy, dz);
  if (len < EPS) { dx = 0; dy = 0; dz = -1; } else { dx /= len; dy /= len; dz /= len; }
  return [px + dx * dist, py + dy * dist, pz + dz * dist];
}

// Recompute + store the derived direction in place when targeted; no-op
// otherwise. Call after any change to a light's target or position.
export function applyTargeting(light) {
  // Calibrated lights carry a feet-space target: the beam is derived in feet
  // and the engine direction is its flip (x, -y, -z), so the server and the
  // shader march shadows along the same vector. Engine target − position is
  // a perspective-warped vector and must not override it.
  if (light.position_ft && light.target_ft) {
    const d = [0, 1, 2].map((i) => light.target_ft[i] - light.position_ft[i]);
    const n = Math.hypot(...d);
    if (n > EPS) {
      light.direction_ft = d.map((c) => c / n);
      light.direction = [light.direction_ft[0], -light.direction_ft[1], -light.direction_ft[2]];
      return light;
    }
  }
  if (isTargeted(light)) light.direction = deriveDirection(light);
  return light;
}
