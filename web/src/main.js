import { newState } from './lights.js';
import { prepare, listGobos, render as serverRender } from './api.js';
import { init as initRenderer, setAssets, draw } from './webgl/renderer.js';
import { mountHandles } from './handles.js';
import { mountControls } from './controls.js';

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
  document.dispatchEvent(new CustomEvent('relight:prepared'));
});

document.addEventListener('relight:prepared', async () => {
  const canvas = document.getElementById('canvas');
  await initRenderer(canvas);
  await setAssets(state.assetUrls, canvas);
  const redraw = () => draw(state);
  mountHandles(state, redraw);
  mountControls(state, redraw);
  redraw();
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

document.getElementById('export-btn').addEventListener('click', async () => {
  if (!state.sessionId) return;
  const body = {
    session_id: state.sessionId,
    lights: state.lights,
    ambient: state.ambient,
    output_format: 'png',
    output_bit_depth: 8,
  };
  const blob = await serverRender(body);
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `relit-${Date.now()}.png`;
  document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
});

window.__state = state;  // for console debugging
