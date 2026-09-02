// Fixtures on lights (Spec 2): a light's `fixture` block records how its
// feet-space coordinates were derived from the venue's hanging positions and
// area grid. The engine fields (position_ft, target_ft, endpoints…) stay the
// truth; this module re-derives them from the rig and keeps the Spec 1 sync
// helper in the loop so the engine proxies follow.
//
// Detach rules (spec §Detaching): a direct move sets position_id = null
// (Custom) and keeps the coordinates; an aim edit drops the area. Editing a
// position's numbers never touches Custom fixtures.
import { positionToWorld, nearestOffset, areaCenter, linearEndpoints } from './geometry.js';
import { PRESETS, applyFixturePreset } from './presets.js';
import { syncLightFromFeet, syncLightFromEngine, syncLightsFromEngineEdits, markCustom, engineEdits } from '../metric/light-metric.js';
import { engineToWorld, effectiveFit } from '../metric/calibration.js';
import { MAX_EMITTERS } from '../webgl/renderer.js';

export function findPosition(venue, id) {
  return (venue?.positions || []).find((p) => p.id === id) || null;
}

/**
 * Re-hang one light from its fixture block. Returns true when the light was
 * placed from the rig (position resolved), false when it is Custom, has no
 * fixture, or references a position the venue no longer has.
 */
export function syncFixtureFromRig(L, venue, record) {
  const f = L.fixture;
  if (!f || !f.position_id) return false;
  const pos = findPosition(venue, f.position_id);
  if (!pos) return false;
  const preset = PRESETS[f.type] || PRESETS.other;
  const offset = Number.isFinite(f.offset_ft) ? f.offset_ft : 0;
  if (L.type === 'linear' || preset.engineType === 'linear') {
    const [a, b] = linearEndpoints(pos, offset, f.length_ft ?? PRESETS.cyc.defaultOption);
    L.endpoint_a_ft = a;
    L.endpoint_b_ft = b;
    L.position_ft = [0, 1, 2].map((i) => (a[i] + b[i]) / 2);
  } else {
    L.position_ft = positionToWorld(pos, offset);
    if (f.area != null && preset.aimed !== 'none') {
      const c = areaCenter(venue, f.area);
      if (c) L.target_ft = c;
    }
  }
  if (record) syncLightFromFeet(L, record);
  return true;
}

/** Re-hang every rig-attached emitter (reflectors and Custom lights untouched). */
export function syncAllFixtures(lights, venue, record) {
  for (const L of lights || []) {
    if (L.type === 'reflector' || !L.fixture?.position_id) continue;
    syncFixtureFromRig(L, venue, record);
  }
}

/** A direct move: the fixture becomes Custom, coordinates stay. */
export function detachFixture(L) { markCustom(L); return L; }

/** An aim edit: the fixture keeps its position but no longer follows an area. */
export function detachAim(L) {
  if (L.fixture && L.fixture.area != null) L.fixture.area = null;
  return L;
}

/** Hang a light on a position at the offset nearest its current feet
 * coordinates (X for pipes/floor, Y for booms), then re-derive. */
export function attachFixture(L, position, venue, record) {
  const from = Array.isArray(L.position_ft) ? L.position_ft : [0, 0, 0];
  L.fixture = { type: 'other', area: null, ...(L.fixture || {}), position_id: position.id, offset_ft: nearestOffset(position, from) };
  syncFixtureFromRig(L, venue, record);
  return L;
}

/**
 * Direct moves made in engine space (2D handle drags, the Position Z slider,
 * a target-handle drag, the aim-at-target toggle) detach before the rig
 * re-hangs anything, so the user's edit wins: a moved light becomes Custom,
 * a re-aimed one drops its area. Switching aim-at-target off also drops the
 * feet target here, since syncFixtureFromRig would otherwise push it back
 * into the engine. Returns the number of lights touched.
 */
export function detachFromEngineEdits(lights, record) {
  let n = 0;
  for (const L of lights || []) {
    if (!L.fixture || L.type === 'reflector') continue;
    const { moved, retargeted } = engineEdits(L, record);
    if (moved) { detachFixture(L); n += 1; }
    if (retargeted) {
      // Re-derive the feet target now: re-hanging syncs feet → engine and
      // would otherwise push the stale feet target back over the drag.
      if (!Array.isArray(L.target)) delete L.target_ft;
      else L.target_ft = engineToWorld(L.target, record.camera, effectiveFit(record));
      detachAim(L);
      n += 1;
    }
  }
  return n;
}

/**
 * The one sync main.js runs before every redraw and save in a calibrated
 * scene: detach on direct moves, re-hang what is still attached from the
 * venue, then the Spec 1 engine-edit sync so custom edits are re-derived
 * last. A scene without a venue only gets the Spec 1 half. Returns the
 * number of detaches, so the caller can regroup the tree when one happened.
 */
export function syncRig(lights, venue, record) {
  if (!record) return 0;
  const detached = detachFromEngineEdits(lights, record);
  if (venue) syncAllFixtures(lights, venue, record);
  syncLightsFromEngineEdits(lights, record);
  return detached;
}

export const CAP_MESSAGE = `${MAX_EMITTERS} lights maximum; disable one first`;
const LINEAR_SEED_HALF_FT = 2;        // a new bar is 4 ft long
const LINEAR_SEED_HALF_ENGINE = 0.1;  // engine-space half length when uncalibrated

/**
 * Change a light's engine type from the props pane. A linear light needs
 * endpoints: a fixture hung on a position becomes a cyc there (preset +
 * linearEndpoints); a Custom or uncalibrated light gets a 4 ft bar centred
 * on its feet position (engine ±0.1 when there is no calibration). Leaving
 * linear drops the endpoint fields. Re-derives the engine proxies.
 */
export function setLightType(L, type, record, venue = null) {
  if (!L || L.type === type) return L;
  if (type === 'linear') {
    if (L.fixture?.position_id && findPosition(venue, L.fixture.position_id)) {
      applyFixturePreset(L, 'cyc');
      L.fixture.area = null;
      syncFixtureFromRig(L, venue, record);
      return L;
    }
    L.type = 'linear';
    L.target = null;
    delete L.target_ft;
    if (record && L.position_ft) {
      const [X, Y, Z] = L.position_ft;
      L.endpoint_a_ft = [X - LINEAR_SEED_HALF_FT, Y, Z];
      L.endpoint_b_ft = [X + LINEAR_SEED_HALF_FT, Y, Z];
      syncLightFromFeet(L, record);
    } else {
      const [x, y, z] = L.position;
      L.endpoint_a = [x - LINEAR_SEED_HALF_ENGINE, y, z];
      L.endpoint_b = [x + LINEAR_SEED_HALF_ENGINE, y, z];
      if (record) syncLightFromEngine(L, record);
    }
    return L;
  }
  L.type = type;
  for (const k of ['endpoint_a_ft', 'endpoint_b_ft', 'endpoint_a', 'endpoint_b']) delete L[k];
  if (record) {
    if (L.position_ft) { delete L.direction_ft; syncLightFromFeet(L, record); }
    else syncLightFromEngine(L, record);
  }
  return L;
}

/**
 * Turn a light on or off, refusing the 65th enabled emitter. Shared by the
 * Rig tab's checkbox and the props pane so both show the same message.
 * @returns {{ ok: boolean, message?: string }}
 */
export function tryEnable(lights, L, on) {
  if (!on) { L.enabled = false; return { ok: true }; }
  if (!canEnable(lights, L)) return { ok: false, message: CAP_MESSAGE };
  L.enabled = true;
  return { ok: true };
}

export function enabledEmitterCount(lights) {
  return (lights || []).filter((L) => L && L.type !== 'reflector' && L.enabled !== false).length;
}

/** False when the light is disabled and the emitter cap is already reached. */
export function canEnable(lights, L) {
  if (!L || L.enabled !== false) return true;
  return enabledEmitterCount(lights) < MAX_EMITTERS;
}
