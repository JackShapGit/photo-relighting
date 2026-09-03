/**
 * Draft / applied / history reducer for the calibration cube (pure).
 *
 * State: { applied, draft, history, redo, dirty }
 *   applied, draft: { marks, dims, house } | null   (marks may be null before a solve)
 *   history: up to HISTORY_CAP caller-supplied snapshots
 *            { calibration, venue: { dims, house }, fixtures: [...] }
 *   redo:    a single snapshot slot (filled by undo, cleared by a new apply)
 *   dirty:   the draft differs from the applied state
 *
 * Actions: edit {patch}, apply {snapshot}, revert, undo {snapshot},
 * redo {snapshot}, clear {snapshot, draft}. Snapshots describe the state
 * being left (apply/clear) or the current state being undone/redone, so the
 * caller can restore calibration, venue and fixture feet fields.
 */
export const HISTORY_CAP = 10;

const clone = (v) => (v == null ? null : JSON.parse(JSON.stringify(v)));
const push = (history, entry) => (entry ? [...history, clone(entry)].slice(-HISTORY_CAP) : history);

/** A draft from a history snapshot (null marks when the entry had no calibration). */
function draftFromSnapshot(entry) {
  return {
    marks: clone(entry?.calibration?.marks) ?? null,
    dims: clone(entry?.venue?.dims) ?? null,
    house: clone(entry?.venue?.house) ?? null,
  };
}

export function createDraftState(applied) {
  return { applied: clone(applied), draft: clone(applied), history: [], redo: null, dirty: false };
}

export function reduce(S, action) {
  switch (action?.type) {
    case 'edit': {
      const draft = clone(S.draft) || {};
      for (const key of ['marks', 'dims', 'house']) {
        if (action.patch?.[key]) draft[key] = { ...(draft[key] || {}), ...clone(action.patch[key]) };
      }
      return { ...S, draft, dirty: true };
    }
    case 'apply':
      return { ...S, applied: clone(S.draft), draft: clone(S.draft), history: push(S.history, action.snapshot), redo: null, dirty: false };
    case 'revert':
      return { ...S, draft: clone(S.applied), dirty: false };
    case 'undo': {
      if (!S.history.length) return S;
      const entry = S.history[S.history.length - 1];
      const restored = entry.calibration ? draftFromSnapshot(entry) : null;
      return {
        ...S,
        applied: restored,
        draft: restored ? clone(restored) : draftFromSnapshot(entry),
        history: S.history.slice(0, -1),
        redo: clone(action.snapshot) ?? null,
        dirty: false,
      };
    }
    case 'redo': {
      if (!S.redo) return S;
      const restored = S.redo.calibration ? draftFromSnapshot(S.redo) : null;
      return {
        ...S,
        applied: restored,
        draft: restored ? clone(restored) : draftFromSnapshot(S.redo),
        history: push(S.history, action.snapshot),
        redo: null,
        dirty: false,
      };
    }
    case 'clear':
      return { ...S, applied: null, draft: clone(action.draft) ?? null, history: push(S.history, action.snapshot), redo: null, dirty: false };
    default:
      return S;
  }
}

/** The latest history entry (persisted as state.calibration_undo), or null. */
export function serializeUndo(S) {
  return S.history.length ? clone(S.history[S.history.length - 1]) : null;
}

/** Seed the history with a persisted entry (one undo survives a reload). */
export function hydrateUndo(S, entry) {
  return entry ? { ...S, history: push(S.history, entry) } : S;
}
