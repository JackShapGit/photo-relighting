// Ruler state machine (Spec 3). DOM-free, like placement.js: both pane
// adapters feed it world-space points in feet and it decides which is A and
// which is B. Measurements are session-only (decision 6) — nothing here
// touches storage or the scene document.
import { distanceFt } from './metric/measure.js';

const MIN_SPAN_FT = 0.01;      // closer than this is a mis-click, not a span

let _mid = 0;
const nextId = () => `m_${Date.now().toString(36)}_${(_mid++).toString(36)}`;

export function createMeasureTool({ onChange } = {}) {
  let phase = 'idle';          // idle | awaitingA | awaitingB
  let pendingA = null;
  const list = [];

  const fire = () => { if (onChange) onChange(); };

  function arm() {
    phase = 'awaitingA';
    pendingA = null;
    fire();
  }

  function disarm() {
    phase = 'idle';
    pendingA = null;
    fire();
  }

  /** Drop an in-progress span without leaving the tool. */
  function cancel() {
    phase = phase === 'idle' ? 'idle' : 'awaitingA';
    pendingA = null;
    fire();
  }

  function addPoint(pt) {
    if (phase === 'idle' || !Array.isArray(pt) || pt.length !== 3) return null;
    if (phase === 'awaitingA') {
      pendingA = pt.slice();
      phase = 'awaitingB';
      fire();
      return null;
    }
    const a = pendingA;
    const b = pt.slice();
    pendingA = null;
    phase = 'awaitingA';
    if (!a || distanceFt(a, b) < MIN_SPAN_FT) { fire(); return null; }
    const m = { id: nextId(), a, b };
    list.push(m);
    fire();
    return m;
  }

  function clear() {
    list.length = 0;
    pendingA = null;
    if (phase !== 'idle') phase = 'awaitingA';
    fire();
  }

  return {
    arm,
    disarm,
    cancel,
    clear,
    addPoint,
    isArmed: () => phase !== 'idle',
    phase: () => phase,
    pendingA: () => (pendingA ? pendingA.slice() : null),
    measurements: () => list.map((m) => ({ id: m.id, a: m.a.slice(), b: m.b.slice() })),
  };
}
