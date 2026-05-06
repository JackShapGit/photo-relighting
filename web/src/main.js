import { newState } from './lights.js';
import { prepare, listGobos } from './api.js';
// renderer + controls modules wired up in later tasks.

const state = newState();

document.getElementById('file').addEventListener('change', async (ev) => {
  const f = ev.target.files?.[0];
  if (!f) return;
  const mode = document.getElementById('prepare-mode').value;
  const resp = await prepare(f, mode);
  state.sessionId = resp.session_id;
  state.width = resp.width;
  state.height = resp.height;
  state.assetUrls = resp.assets;
  // Renderer init happens in Task 23.
  document.dispatchEvent(new CustomEvent('relight:prepared'));
});

(async () => {
  try {
    const gobos = await listGobos();
    for (const sel of document.querySelectorAll('.gobo')) {
      for (const g of gobos.presets) {
        const o = document.createElement('option');
        o.value = g.gobo_id;
        o.textContent = g.name;
        sel.appendChild(o);
      }
    }
  } catch (e) {
    console.warn('gobo preset list failed', e);
  }
})();

window.__state = state;  // for console debugging
