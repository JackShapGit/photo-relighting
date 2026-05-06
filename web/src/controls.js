// Wire the per-slot HTML controls to state.lights[i] and call redraw on change.

import { ensureGoboTexture } from './webgl/renderer.js';

const SLOT_INDEX = { key: 0, fill: 1, rim: 2 };

function hexToLinearRGB(hex) {
  const r = parseInt(hex.slice(1, 3), 16) / 255;
  const g = parseInt(hex.slice(3, 5), 16) / 255;
  const b = parseInt(hex.slice(5, 7), 16) / 255;
  const lin = (c) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
  return [lin(r), lin(g), lin(b)];
}

export function mountControls(state, redraw) {
  for (const row of document.querySelectorAll('.light-row')) {
    const i = SLOT_INDEX[row.dataset.slot];
    const L = state.lights[i];
    const $ = (sel) => row.querySelector(sel);

    const bind = (el, fn) => el.addEventListener('input', async (e) => { await fn(e.target); redraw(); });

    bind($('.type'), (t) => { L.type = t.value; });
    bind($('.intensity'), (t) => { L.intensity = parseFloat(t.value); });
    bind($('.color'), (t) => { L.color = hexToLinearRGB(t.value); L.color_temperature = null; });
    bind($('.kelvin'), (t) => { L.color_temperature = parseFloat(t.value); L.color = [1, 1, 1]; });
    bind($('.cone'), (t) => { L.cone_angle = parseFloat(t.value); });
    bind($('.softness'), (t) => { L.softness = parseFloat(t.value); });
    bind($('.falloff'), (t) => { L.falloff = parseFloat(t.value); });
    bind($('.affects'), (t) => { L.affects = t.value; });
    bind($('.enabled'), (t) => { L.enabled = t.checked; });
    bind($('.gobo'), async (t) => {
      if (t.value) {
        await ensureGoboTexture(t.value);
        L.gobo = { texture_id: t.value, scale: 1, rotation: 0,
                   offset: [0, 0], blur: 0, invert: false };
      } else {
        L.gobo = null;
      }
    });
  }

  const ambient = document.getElementById('ambient');
  ambient.addEventListener('input', () => { state.ambient = parseFloat(ambient.value); redraw(); });

  const debug = document.getElementById('debug-view');
  debug.addEventListener('change', () => { state.debugView = debug.value; redraw(); });
}
