// Click-to-place state machine. DOM-free: it mutates a light node and signals
// the host through injected callbacks. Both panes feed it engine-space surface
// points; it decides whether a point becomes the light's position (click 1) or
// its aim target (click 2).
//
// Phases: 'idle' → 'awaitingLight' → 'awaitingTarget' (the last only for
// directional/spotlight; point lights finish on click 1).

import { applyTargeting } from './targeting.js';

export const LIGHT_STANDOFF = 0.8;        // engine-z units, pulled toward camera
const Z_MIN = -2, Z_MAX = 3;              // matches the Position Z slider range

const clampZ = (z) => Math.max(Z_MIN, Math.min(Z_MAX, z));
const isTargetable = (L) => L.type === 'directional' || L.type === 'spotlight';

export function createPlacement({ commitLight, updateLight, removeLight, onPhaseChange }) {
  let phase = 'idle';
  let light = null;
  let insertAt = null;
  let committed = false;

  function setPhase(p) {
    phase = p;
    if (onPhaseChange) onPhaseChange(p);
  }

  function reset() {
    light = null;
    insertAt = null;
    committed = false;
    setPhase('idle');
  }

  // Start placing a (not-yet-inserted) light. `where` = { parentArr, index }.
  // Defensively cancels any in-flight placement first so a second begin() never
  // orphans a previously-committed light.
  function begin(newLight, where) {
    if (phase !== 'idle') cancel();
    light = newLight;
    insertAt = where;
    committed = false;
    setPhase('awaitingLight');
  }

  function acceptSurfacePoint(engPt) {
    if (phase === 'awaitingLight') {
      light.position = [engPt[0], engPt[1], clampZ(engPt[2] + LIGHT_STANDOFF)];
      commitLight(light, insertAt);
      committed = true;
      if (isTargetable(light)) {
        setPhase('awaitingTarget');
      } else {
        reset();                          // point light: done on click 1
      }
    } else if (phase === 'awaitingTarget') {
      light.target = [engPt[0], engPt[1], engPt[2]];
      applyTargeting(light);              // derive direction from target - position
      updateLight(light);
      reset();
    }
  }

  function cancel() {
    if (committed && light && removeLight) removeLight(light);
    reset();
  }

  return {
    begin,
    acceptSurfacePoint,
    cancel,
    isActive: () => phase !== 'idle',
    phase: () => phase,
    pendingLight: () => light,
  };
}
