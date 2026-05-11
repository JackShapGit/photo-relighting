/** Polish state machine + side-effect orchestration.
 *
 * States: 'idle' | 'polishing' | 'ready' | 'error'.
 * Transitions are explicit; the main module subscribes via onPolishChange().
 */
import { polishScene } from './api.js';

let state = {
  status: 'idle',
  blobUrl: null,
  prompt: '',
  error: null,
};
const listeners = new Set();

function emit() {
  for (const cb of listeners) cb(state);
}

export function onPolishChange(cb) {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export function getPolishState() {
  return state;
}

export function setPolishPrompt(prompt) {
  state = { ...state, prompt };
  emit();
}

/** Invalidate polished image — called when any classical render input changes. */
export function invalidatePolish() {
  if (state.blobUrl) URL.revokeObjectURL(state.blobUrl);
  state = { status: 'idle', blobUrl: null, prompt: state.prompt, error: null };
  emit();
}

/** Fire a polish request. Returns early if already in flight. */
export async function startPolish({ sessionId, lights, ambient, shadowStyle, seed = null }) {
  if (state.status === 'polishing') return;
  state = { ...state, status: 'polishing', error: null };
  emit();
  try {
    const blob = await polishScene({
      sessionId, lights, ambient, shadowStyle,
      prompt: state.prompt, seed,
    });
    const blobUrl = URL.createObjectURL(blob);
    state = { ...state, status: 'ready', blobUrl };
    emit();
  } catch (e) {
    state = { ...state, status: 'error', error: e.message || String(e) };
    emit();
  }
}
