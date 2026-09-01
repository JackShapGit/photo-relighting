// Keeps a light's feet-space fields (position_ft, target_ft, direction_ft) and
// its engine-space proxies (position_eng, direction_eng, falloff_ft) coherent.
// The renderer (webgl/renderer.js) reads the proxies in metric mode; the 2D
// handles and the 3D fallback keep using position/direction/target.
import {
  solveCamera, worldToEngine, engineToWorld, engineDirToWorld, worldDirToEngine, falloffToMetric,
} from './calibration.js';

const EPS = 1e-9;
const norm = (v) => { const n = Math.hypot(...v) || 1; return v.map((c) => c / n); };

/** Copy of the calibration record with the solved camera attached. */
export function solveRecord(record, aspect) {
  return { ...record, camera: solveCamera(record, aspect) };
}

function fitOf(record) { return record.depth_fit || null; }

export function syncLightFromFeet(L, record) {
  const cam = record.camera, fit = fitOf(record);
  if (L.target_ft) {
    const d = [0, 1, 2].map((i) => L.target_ft[i] - L.position_ft[i]);
    L.direction_ft = Math.hypot(...d) > EPS ? norm(d) : engineDirToWorld(L.direction);
  } else if (!L.direction_ft) {
    L.direction_ft = norm(engineDirToWorld(L.direction));
  }
  L.direction_eng = worldDirToEngine(L.direction_ft);
  L.falloff_ft = falloffToMetric(L.falloff ?? 1, record);
  L.position_eng = fit ? worldToEngine(L.position_ft, cam, fit) : null;
  if (L.position_eng) L.position = L.position_eng.slice();
  if (L.target_ft && fit) {
    const t = worldToEngine(L.target_ft, cam, fit);
    if (t) L.target = t;
  }
  if (L.position_eng || L.target) L.direction = L.direction_eng.slice();
  return L;
}

export function syncLightFromEngine(L, record) {
  const cam = record.camera, fit = fitOf(record);
  if (!fit) return L;
  L.position_ft = engineToWorld(L.position, cam, fit);
  if (Array.isArray(L.target)) L.target_ft = engineToWorld(L.target, cam, fit);
  else delete L.target_ft;
  delete L.direction_ft;
  return syncLightFromFeet(L, record);
}

export function migrateLightsToFeet(lights, record) {
  for (const L of lights) {
    if (L.type === 'reflector') continue;
    if (!L.position_ft) syncLightFromEngine(L, record);
    else syncLightFromFeet(L, record);
  }
}

export function clearMetric(L) {
  for (const k of ['position_ft', 'target_ft', 'direction_ft', 'position_eng', 'direction_eng', 'falloff_ft']) delete L[k];
}
