// Right-pane property editors. Builds controls dynamically based on what's
// selected in the tree:
//   - Scene root  → renderSceneProps  (ambient, debug view)
//   - A light     → renderLightProps  (full per-light controls)
//
// Replaces the old static .light-row HTML — controls live entirely in JS now.

import { ensureGoboTexture } from './webgl/renderer.js';
import { SCENE_ID, findNode } from './lights.js';
import { PRESETS } from './presets.js';

const SLOT_VARS = ['--slot-key', '--slot-fill', '--slot-rim'];

function slotColor(idx) {
  const v = getComputedStyle(document.documentElement)
    .getPropertyValue(SLOT_VARS[idx] || '').trim();
  return v || '#fff';
}

function hexToLinearRGB(hex) {
  const r = parseInt(hex.slice(1, 3), 16) / 255;
  const g = parseInt(hex.slice(3, 5), 16) / 255;
  const b = parseInt(hex.slice(5, 7), 16) / 255;
  const lin = (c) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
  return [lin(r), lin(g), lin(b)];
}

function linearToHex(rgb) {
  const enc = (c) => {
    const v = c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
    return Math.round(Math.min(1, Math.max(0, v)) * 255);
  };
  const [r, g, b] = rgb.map(enc);
  return `#${[r, g, b].map((c) => c.toString(16).padStart(2, '0')).join('')}`;
}

let goboPresets = [];   // populated once by setGoboPresets() from main.js

export function setGoboPresets(presets) {
  goboPresets = presets;
}

export function renderProps(state, container, redraw) {
  if (state.selectedId === SCENE_ID) {
    renderSceneProps(state, container, redraw);
    return;
  }
  const node = findNode(state.tree, state.selectedId);
  if (!node) {
    container.innerHTML = '<p class="props-empty">Select a node in the tree.</p>';
    return;
  }
  if (node.kind === 'group') {
    renderGroupProps(node, container);
    return;
  }
  const idx = state.lights.indexOf(node);
  renderLightProps(node, idx, container, redraw);
}

function renderGroupProps(G, container) {
  const lightCount = countLights(G);
  container.innerHTML = `
    <div class="props-header">
      <span class="tree-icon">🗂</span>
      <h2 class="props-name">${escapeHtml(G.name)}</h2>
    </div>
    <p class="props-empty">
      Group with ${lightCount} ${lightCount === 1 ? 'light' : 'lights'}.<br>
      Rename, delete, and clone arrive in Phase 3.
    </p>
  `;
}

function countLights(G) {
  let n = 0;
  for (const c of G.children) {
    if (c.kind === 'light') n += 1;
    else if (c.kind === 'group') n += countLights(c);
  }
  return n;
}

// Inline picker shown when the user clicks "+ Add Light" — the right pane
// becomes a card grid of fixture presets. Click a card → onPick(preset);
// click Cancel → onPick(null). Card thumbnails are placeholder Unicode
// glyphs in Phase 1 of the picker; pre-rendered PNGs land in step 4.
export function renderAddLightPicker(state, container, onPick) {
  container.innerHTML = `
    <div class="props-header">
      <span class="tree-icon">+</span>
      <h2>Add Light</h2>
    </div>
    <p class="props-empty">Pick a fixture preset to add. You can adjust everything afterward.</p>
    <div class="preset-grid">
      ${PRESETS.map((p) => `
        <button class="preset-card" type="button" data-id="${p.id}" title="${escapeHtml(p.description)}">
          <div class="preset-thumb">
            <img class="preset-img" src="/web/preset-thumbs/${p.id}.jpg" alt="${escapeHtml(p.name)}"
                 onerror="this.style.display='none';this.nextElementSibling.style.display='flex';" />
            <span class="preset-glyph" style="display:none">${escapeHtml(p.icon)}</span>
          </div>
          <div class="preset-name">${escapeHtml(p.name)}</div>
        </button>
      `).join('')}
    </div>
    <div class="modal-actions">
      <button id="add-cancel" type="button">Cancel</button>
    </div>
  `;
  for (const card of container.querySelectorAll('.preset-card')) {
    card.addEventListener('click', () => {
      const id = card.dataset.id;
      const preset = PRESETS.find((p) => p.id === id);
      onPick?.(preset || null);
    });
  }
  container.querySelector('#add-cancel').addEventListener('click', () => onPick?.(null));
}

function renderSceneProps(state, container, redraw) {
  container.innerHTML = `
    <div class="props-header">
      <span class="tree-icon">⌂</span>
      <h2>Scene</h2>
    </div>
    <label>Ambient <input id="ambient" type="range" min="0" max="1" step="0.01" /></label>
    <label>Show
      <select id="debug-view">
        <option value="render">Render</option>
        <option value="depth">Depth</option>
        <option value="normals">Normals</option>
        <option value="mask">Mask</option>
      </select>
    </label>
    <label>Shadows
      <select id="shadow-style">
        <option value="off">Off</option>
        <option value="heightfield">Heightfield (ray-march)</option>
        <option value="planar">Planar (silhouette)</option>
      </select>
    </label>
  `;
  const ambient = container.querySelector('#ambient');
  ambient.value = state.ambient;
  ambient.addEventListener('input', () => {
    state.ambient = parseFloat(ambient.value);
    redraw();
  });
  const debug = container.querySelector('#debug-view');
  debug.value = state.debugView;
  debug.addEventListener('change', () => {
    state.debugView = debug.value;
    redraw();
  });
  const shadows = container.querySelector('#shadow-style');
  shadows.value = state.shadowStyle || 'off';
  shadows.addEventListener('change', () => {
    state.shadowStyle = shadows.value;
    redraw();
  });
}

function renderLightProps(L, slotIdx, container, redraw) {
  const goboOptions = ['<option value="">none</option>']
    .concat(goboPresets.map((g) =>
      `<option value="${g.gobo_id}">${escapeHtml(g.name)}</option>`))
    .join('');

  container.innerHTML = `
    <div class="props-header">
      <span class="slot-dot" style="background: ${slotColor(slotIdx)}"></span>
      <h2 class="props-name">${escapeHtml(L.name)}</h2>
    </div>
    <label>Type
      <select class="type">
        <option value="directional">directional</option>
        <option value="point">point</option>
        <option value="spotlight">spotlight</option>
      </select>
    </label>
    <label>Position Z <input class="position-z" type="range" min="-2" max="3" step="0.05" /></label>
    <label>Direction Z <input class="direction-z" type="range" min="-1" max="1" step="0.02" /></label>
    <label>Intensity <input class="intensity" type="range" min="0" max="3" step="0.01" /></label>
    <label>Color <input class="color" type="color" /></label>
    <label>Kelvin <input class="kelvin" type="range" min="1500" max="10000" step="50" /></label>
    <label>Cone <input class="cone" type="range" min="0.05" max="1.4" step="0.01" /></label>
    <label>Softness <input class="softness" type="range" min="0" max="0.5" step="0.01" /></label>
    <label>Falloff <input class="falloff" type="range" min="0" max="3" step="0.05" /></label>
    <label>Gobo <select class="gobo">${goboOptions}</select></label>
    <label>Affects
      <select class="affects">
        <option value="all">all</option>
        <option value="subject">subject</option>
        <option value="background">background</option>
      </select>
    </label>
    <label class="checkbox-row"><input type="checkbox" class="enabled" /> enabled</label>
  `;

  const $ = (sel) => container.querySelector(sel);

  $('.type').value = L.type;
  $('.position-z').value = L.position[2];
  $('.direction-z').value = L.direction[2];
  $('.intensity').value = L.intensity;
  $('.color').value = linearToHex(L.color);
  $('.kelvin').value = L.color_temperature ?? 5500;
  $('.cone').value = L.cone_angle;
  $('.softness').value = L.softness;
  $('.falloff').value = L.falloff;
  $('.gobo').value = L.gobo?.texture_id ?? '';
  $('.affects').value = L.affects;
  $('.enabled').checked = L.enabled;

  const bind = (sel, fn) =>
    $(sel).addEventListener('input', async (e) => { await fn(e.target); redraw(); });

  bind('.type', (t) => { L.type = t.value; });
  bind('.position-z', (t) => { L.position[2] = parseFloat(t.value); });
  bind('.direction-z', (t) => { L.direction[2] = parseFloat(t.value); });
  bind('.intensity', (t) => { L.intensity = parseFloat(t.value); });
  bind('.color', (t) => { L.color = hexToLinearRGB(t.value); L.color_temperature = null; });
  bind('.kelvin', (t) => { L.color_temperature = parseFloat(t.value); L.color = [1, 1, 1]; });
  bind('.cone', (t) => { L.cone_angle = parseFloat(t.value); });
  bind('.softness', (t) => { L.softness = parseFloat(t.value); });
  bind('.falloff', (t) => { L.falloff = parseFloat(t.value); });
  bind('.affects', (t) => { L.affects = t.value; });
  bind('.enabled', (t) => { L.enabled = t.checked; });
  bind('.gobo', async (t) => {
    if (t.value) {
      await ensureGoboTexture(t.value);
      L.gobo = { texture_id: t.value, scale: 1, rotation: 0,
                 offset: [0, 0], blur: 0, invert: false };
    } else {
      L.gobo = null;
    }
  });
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
