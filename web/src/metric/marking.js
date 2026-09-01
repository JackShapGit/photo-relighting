// Five-click stage marking state: which mark comes next, undo, cancel.
// Pure (no DOM) so the calibration panel can be driven from tests.
export const MARK_ORDER = ['lipL', 'lipR', 'top', 'backL', 'backR'];
export const MARK_LABELS = {
  lipL: 'Click the LEFT end of the stage lip (at the deck)',
  lipR: 'Click the RIGHT end of the stage lip (at the deck)',
  top: 'Click the TOP of the proscenium opening',
  backL: 'Click the LEFT end of the upstage edge (at the deck)',
  backR: 'Click the RIGHT end of the upstage edge (at the deck)',
};

export function createMarking(initial = {}) {
  const start = JSON.parse(JSON.stringify(initial));
  let marks = JSON.parse(JSON.stringify(initial));
  const history = [];
  const current = () => MARK_ORDER.find((k) => !(k in marks)) ?? null;
  return {
    next(u, v) { const k = current(); if (!k) return null; marks[k] = [u, v]; history.push(k); return k; },
    undo() { const k = history.pop(); if (k) delete marks[k]; },
    cancel() { marks = JSON.parse(JSON.stringify(start)); history.length = 0; },
    get marks() { return marks; },
    get current() { return current(); },
    get done() { return current() === null; },
  };
}
