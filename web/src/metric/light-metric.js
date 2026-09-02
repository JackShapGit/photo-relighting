// Keeps a light's feet-space fields (position_ft, target_ft, direction_ft) and
// its engine-space proxies (position_eng, direction_eng, falloff_ft) coherent.
// The renderer (webgl/renderer.js) reads the proxies in metric mode; the 2D
// handles and the 3D fallback keep using position/direction/target.
import {
  solveCamera, worldToEngine, engineToWorld, engineDirToWorld, worldDirToEngine, falloffToMetric,
  effectiveFit,
} from './calibration.js';

const EPS = 1e-9;
const norm = (v) => { const n = Math.hypot(...v) || 1; return v.map((c) => c / n); };
const vecEq = (a, b) => Array.isArray(a) && Array.isArray(b) && a.length === b.length
  && a.every((v, i) => v === b[i]);
const TARGET_SPAWN_FRACTION = 0.5;   // of the camera distance, down the beam (behind-camera aim-on)
const ENGINE_XY = [0.02, 0.98];      // 2D handle reach after Clear calibration
const ENGINE_Z = [-2, 3];            // the Position Z slider's range

/** Copy of the calibration record with the solved camera attached. */
export function solveRecord(record, aspect) {
  return { ...record, camera: solveCamera(record, aspect) };
}

// A record with no depth fit still maps depth linearly (spec §Error
// handling), so every light gets feet fields and an engine proxy.
export function syncLightFromFeet(L, record) {
  const cam = record.camera, fit = effectiveFit(record);
  if (L.target_ft) {
    const d = [0, 1, 2].map((i) => L.target_ft[i] - L.position_ft[i]);
    L.direction_ft = Math.hypot(...d) > EPS ? norm(d) : engineDirToWorld(L.direction);
  } else if (!L.direction_ft) {
    L.direction_ft = norm(engineDirToWorld(L.direction));
  }
  L.direction_eng = worldDirToEngine(L.direction_ft);
  L.falloff_ft = falloffToMetric(L.falloff ?? 1, record);
  L.position_eng = worldToEngine(L.position_ft, cam, fit);
  if (L.position_eng) L.position = L.position_eng.slice();
  if (L.target_ft) {
    const t = worldToEngine(L.target_ft, cam, fit);
    if (t) L.target = t;
  }
  // The engine direction is canonical for the server: it is what the shader
  // marches shadows and ortho gobos along, and what the Python engine reads.
  L.direction = L.direction_eng.slice();
  return L;
}

export function syncLightFromEngine(L, record) {
  const cam = record.camera, fit = effectiveFit(record);
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

/**
 * Central sync after any engine-space edit (2D handle drags, the Direction Z
 * slider, the aim-at-target toggle, a target-handle drag, a newly added
 * light): re-derives the feet fields from whatever changed, then the engine
 * proxies from feet. Idempotent, so every change/redraw path can call it.
 */
export function syncLightsFromEngineEdits(lights, record) {
  const cam = record.camera, fit = effectiveFit(record);
  for (const L of lights) {
    if (L.type === 'reflector') continue;
    if (!L.position_ft) { syncLightFromEngine(L, record); continue; }
    // Position moved in engine space: the whole light re-derives from engine.
    if (L.position_eng && !vecEq(L.position, L.position_eng)) { syncLightFromEngine(L, record); continue; }
    if (Array.isArray(L.target)) {
      if (!L.target_ft) {
        // Aim-at-target just switched on. The engine spawn point is a
        // perspective-warped guess, so spawn the feet target down the current
        // beam instead: the beam does not jump and the target lands on stage.
        const d = L.direction_ft || norm(engineDirToWorld(L.direction));
        L.target_ft = [0, 1, 2].map((i) => L.position_ft[i] + d[i] * TARGET_SPAWN_FRACTION * cam.dist_ft);
      } else if (L.position_eng) {
        // Target-handle drag (engine target moved): re-derive the feet target.
        const targetEng = worldToEngine(L.target_ft, cam, fit);
        if (!targetEng || !vecEq(L.target, targetEng)) L.target_ft = engineToWorld(L.target, cam, fit);
      }
    } else {
      delete L.target_ft;                                   // aim-at-target switched off
      if (!vecEq(L.direction, L.direction_eng)) L.direction_ft = norm(engineDirToWorld(L.direction));
    }
    syncLightFromFeet(L, record);
  }
}

export function clearMetric(L) {
  for (const k of ['position_ft', 'target_ft', 'direction_ft', 'position_eng', 'direction_eng', 'falloff_ft']) delete L[k];
}

/** After Clear calibration: keep the engine position where a 2D handle can reach it. */
export function clampEnginePosition(L) {
  const c = (v, [lo, hi]) => Math.min(hi, Math.max(lo, v));
  L.position = [c(L.position[0], ENGINE_XY), c(L.position[1], ENGINE_XY), c(L.position[2], ENGINE_Z)];
  return L;
}
