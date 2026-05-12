/** Per-reflector emission + dominant reflected direction.
 *
 * Mirrors `relighting_engine/lighting/reflectors.py`. Inputs are the flat
 * `state.lights` array (mixed lights + reflectors). Output is an array of
 * { emission: [r, g, b], dominantDir: [x, y, z] } per reflector in input
 * order (preserves visual indexing into the shader's uniform arrays).
 *
 * Note: kelvinToRGB is inlined here from renderer.js (not exported there).
 * Both copies must stay in sync if the Kelvin algorithm changes.
 */

// ---------------------------------------------------------------------------
// Kelvin → linear-RGB, white-balanced to 5500 K (mirrors renderer.js).
// ---------------------------------------------------------------------------
function _kelvinRaw(t) {
  // t is k/100 already, in [10, 400]. Returns un-normalized RGB.
  let r, g, b;
  if (t <= 66) r = 1.0;
  else r = Math.min(1, Math.max(0, 329.698727446 * Math.pow(t - 60, -0.1332047592) / 255));
  if (t <= 66) g = (99.4708025861 * Math.log(t) - 161.1195681661) / 255;
  else g = (288.1221695283 * Math.pow(t - 60, -0.0755148492)) / 255;
  g = Math.min(1, Math.max(0, g));
  if (t >= 66) b = 1.0;
  else if (t <= 19) b = 0.0;
  else b = Math.min(1, Math.max(0, (138.5177312231 * Math.log(t - 10) - 305.0447927307) / 255));
  return [r, g, b];
}

const _REF_5500 = _kelvinRaw(55); // ~(1.0, 0.931, 0.871)

function kelvinToRGB(k) {
  k = Math.max(1000, Math.min(40000, k));
  const raw = _kelvinRaw(k / 100);
  return [
    Math.min(1, Math.max(0, raw[0] / _REF_5500[0])),
    Math.min(1, Math.max(0, raw[1] / _REF_5500[1])),
    Math.min(1, Math.max(0, raw[2] / _REF_5500[2])),
  ];
}

// ---------------------------------------------------------------------------
// Vector math helpers
// ---------------------------------------------------------------------------
function vlen(v) { return Math.hypot(v[0], v[1], v[2]); }
function vnorm(v) {
  const L = vlen(v) || 1;
  return [v[0] / L, v[1] / L, v[2] / L];
}
function vdot(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
function vsub(a, b) { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]; }
function vmul(v, s) { return [v[0] * s, v[1] * s, v[2] * s]; }
function vadd(a, b) { return [a[0] + b[0], a[1] + b[1], a[2] + b[2]]; }

// ---------------------------------------------------------------------------
// Color resolution (mirrors renderer.js resolveColor + gels.py resolve_color)
// ---------------------------------------------------------------------------
function effectiveLightColor(L) {
  const base = L.color || [1, 1, 1];
  // Apply Kelvin only when color is white (same logic as renderer.js resolveColor).
  const isWhite = base[0] === 1 && base[1] === 1 && base[2] === 1;
  if (isWhite && L.color_temperature != null) {
    return kelvinToRGB(L.color_temperature);
  }
  return [base[0], base[1], base[2]];
}

// ---------------------------------------------------------------------------
// Stage 1: compute per-reflector emission + dominant reflected direction
// ---------------------------------------------------------------------------

/**
 * Compute Stage 1 reflector emission for all reflectors in `lights`.
 *
 * @param {Array} lights - Flat array of light objects (emitters + reflectors mixed).
 * @returns {Array<{emission: number[], dominantDir: number[]}>}
 *   One entry per reflector in input order. `emission` is linear-sRGB [r,g,b];
 *   `dominantDir` is a unit vector [x,y,z].
 */
export function computeReflectorEmission(lights) {
  const reflectors = lights.filter((L) => L.type === 'reflector');
  const emitters = lights.filter((L) => L.type !== 'reflector' && L.enabled !== false);

  return reflectors.map((R) => {
    let normal = R.normal || [0, 0, 1];
    if (vlen(normal) < 1e-9) normal = [0, 0, 1];
    normal = vnorm(normal);

    if (R.enabled === false) {
      return { emission: [0, 0, 0], dominantDir: normal };
    }

    let acc = [0, 0, 0];
    let totalIrr = 0;
    let dom = [0, 0, 0];

    for (const L of emitters) {
      let Ldir;
      let distAtten;

      if (L.type === 'directional') {
        const d = L.direction || [0, 0, -1];
        const dLen = vlen(d);
        if (dLen < 1e-9) continue;
        Ldir = vmul(d, -1 / dLen); // toward light source (negate direction vector)
        distAtten = 1.0;
      } else {
        const delta = vsub(L.position, R.position);
        const dist = vlen(delta);
        if (dist < 1e-9) continue;
        Ldir = vmul(delta, 1 / dist);
        distAtten = 1.0 / (1.0 + (L.falloff ?? 1) * dist * dist);
      }

      const facing = vdot(normal, Ldir);
      if (facing <= 0) continue;

      const Lc = effectiveLightColor(L);
      const irr = (L.intensity ?? 1) * distAtten * facing;
      acc = vadd(acc, vmul(Lc, irr));
      totalIrr += irr;

      // Reflect the *incoming* ray (-Ldir) across the reflector normal.
      const inc = vmul(Ldir, -1);
      const refl = vsub(inc, vmul(normal, 2 * vdot(inc, normal)));
      dom = vadd(dom, vmul(refl, irr));
    }

    const tint = R.color || [1, 1, 1];
    const refl = R.reflectance ?? 0.7;
    const emission = [
      acc[0] * refl * tint[0],
      acc[1] * refl * tint[1],
      acc[2] * refl * tint[2],
    ];

    const dominantDir =
      totalIrr > 0 && vlen(dom) > 1e-9 ? vnorm(dom) : normal;

    return { emission, dominantDir };
  });
}
