/**
 * Pure calibration math. No DOM, no Three.js.
 *
 * Image coords: u in [0,1] left→right, v in [0,1] top→bottom. All camera
 * quantities are in "u units": v is scaled by aspect = H/W (va = v * aspect)
 * so a square patch has equal extent in u and va.
 *
 * World frame (feet): origin at the center of the lip on the deck, +X toward
 * audience right, +Y up, +Z upstage (negative Z into the house).
 */
export const Z_CAM_MIN = 0.5;
export const Z_CAM_MAX = 10000;
const MIN_LIP_FRACTION = 0.05;
const FLAT_DEPTH_EPS = 0.02;

export function validateMarks(record) {
  const errors = [];
  const m = record?.marks || {};
  for (const k of ['lipL', 'lipR', 'top', 'backL', 'backR']) {
    if (!Array.isArray(m[k]) || m[k].length !== 2 || !m[k].every(Number.isFinite)) {
      errors.push(`Missing mark: ${k}`);
    }
  }
  for (const k of ['width_ft', 'height_ft', 'depth_ft']) {
    if (!(record?.[k] > 0)) errors.push(`${k.replace('_ft', '')} must be greater than zero`);
  }
  if (errors.length) return { ok: false, errors };
  const wLip = Math.abs(m.lipR[0] - m.lipL[0]);
  const wBack = Math.abs(m.backR[0] - m.backL[0]);
  const vLip = (m.lipL[1] + m.lipR[1]) / 2;
  const vBack = (m.backL[1] + m.backR[1]) / 2;
  if (wLip < MIN_LIP_FRACTION) errors.push('Lip marks are too close together');
  if (m.top[1] >= vLip) errors.push('Top of opening must be above the lip');
  if (wBack >= wLip) errors.push('Back line must be narrower than the lip (is the photo head-on from the house?)');
  if (vBack >= vLip) errors.push('Back line must appear above the lip line');
  return { ok: errors.length === 0, errors };
}

export function solveCamera(record, aspect) {
  const m = record.marks;
  const wLip = Math.abs(m.lipR[0] - m.lipL[0]);
  const wBack = Math.abs(m.backR[0] - m.backL[0]);
  const r = wBack / wLip;
  const dist = record.depth_ft * r / (1 - r);
  const f = wLip * dist / record.width_ft;
  const vaLip = ((m.lipL[1] + m.lipR[1]) / 2) * aspect;
  const vaBack = ((m.backL[1] + m.backR[1]) / 2) * aspect;
  const vaTop = m.top[1] * aspect;
  const h = (vaLip - vaBack) / (f * (1 / dist - 1 / (dist + record.depth_ft)));
  const vaH = vaLip - f * h / dist;
  const predictedOpening = f * record.height_ft / dist;
  const observedOpening = vaLip - vaTop;
  const kY = predictedOpening / observedOpening;
  return {
    f, dist_ft: dist, height_ft: h, u_c: (m.lipL[0] + m.lipR[0]) / 2,
    va_h: vaH, k_y: kY, aspect,
    height_check_pct: Math.abs(kY - 1) * 100,
    perspective_ratio: r,     // back-line width / lip width; > 0.9 means a shallow stage relative to camera distance
  };
}

export function pixelToWorld(u, v, zCam, cam) {
  const X = (u - cam.u_c) * zCam / cam.f;
  const Y = cam.k_y * (cam.height_ft - (v * cam.aspect - cam.va_h) * zCam / cam.f);
  const Z = zCam - cam.dist_ft;
  return [X, Y, Z];
}

export function worldToPixel([X, Y, Z], cam) {
  const zCam = Z + cam.dist_ft;
  if (!(zCam >= Z_CAM_MIN)) return null;
  const u = cam.u_c + X * cam.f / zCam;
  const va = cam.va_h + (cam.height_ft - Y / cam.k_y) * cam.f / zCam;
  return [u, va / cam.aspect, zCam];
}

function medianAlong(a, b, sample, n = 64) {
  const vals = [];
  for (let i = 0; i < n; i++) {
    const t = (i + 0.5) / n;
    vals.push(sample(a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t));
  }
  vals.sort((x, y) => x - y);
  return vals[Math.floor(n / 2)];
}

export function fitDepth(record, cam, sampleDepth) {
  const m = record.marks;
  const dLip = medianAlong(m.lipL, m.lipR, sampleDepth);
  const dBack = medianAlong(m.backL, m.backR, sampleDepth);
  if (!Number.isFinite(dLip) || !Number.isFinite(dBack)) return null;
  if (Math.abs(dLip - dBack) < FLAT_DEPTH_EPS) return null;
  const invLip = 1 / cam.dist_ft;
  const invBack = 1 / (cam.dist_ft + record.depth_ft);
  const a = (invLip - invBack) / (dLip - dBack);
  const b = invLip - a * dLip;
  return { a, b };
}

export function depthToZcam(d, fit) {
  const inv = fit.a * d + fit.b;
  const z = 1 / Math.max(inv, 1 / Z_CAM_MAX);
  return Math.min(Z_CAM_MAX, Math.max(Z_CAM_MIN, z));
}

export function zcamToDepth(zCam, fit) {
  return (1 / zCam - fit.b) / fit.a;
}

/** World feet → engine [x, y, z] (z = 1 − depth). null if no projection. */
export function worldToEngine(w, cam, fit) {
  const p = worldToPixel(w, cam);
  if (!p) return null;
  const [u, v, zCam] = p;
  return [u, v, 1 - zcamToDepth(zCam, fit)];
}

/** Engine [x, y, z] → world feet (used to migrate existing lights). */
export function engineToWorld([x, y, z], cam, fit) {
  const zCam = depthToZcam(1 - z, fit);
  return pixelToWorld(x, y, zCam, cam);
}

export function engineDirToWorld([x, y, z]) { return [x, -y, -z]; }
export function worldDirToEngine([x, y, z]) { return [x, -y, -z]; }

export function falloffToMetric(falloff, record) {
  return falloff / (record.width_ft * record.width_ft);
}

/** Shared synthetic fixture (see plan Global Constraints). */
export const SYNTHETIC_STAGE = {
  aspect: 0.75,
  record: {
    version: 1, units: 'ft', width_ft: 40, height_ft: 20, depth_ft: 30,
    marks: {
      lipL: [0.1, 0.61333], lipR: [0.9, 0.61333], top: [0.5, 0.08],
      backL: [0.23333, 0.54222], backR: [0.76667, 0.54222],
    },
    depth_fit: null, depth_check: null,
  },
  expected: { dist_ft: 60, height_ft: 8, f: 1.2 },
};
