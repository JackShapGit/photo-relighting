// Right-pane property editors. Builds controls dynamically based on what's
// selected in the tree:
//   - Scene root  → renderSceneProps  (ambient, debug view)
//   - A light     → renderLightProps  (full per-light controls)
//
// Replaces the old static .light-row HTML — controls live entirely in JS now.

import { ensureGoboTexture } from './webgl/renderer.js';
import { SCENE_ID, findNode } from './lights.js';
import { PRESETS } from './presets.js';
import { isTargeted, targetSpawnPoint, applyTargeting } from './targeting.js';
import { toDisplay, parseLength } from './metric/units.js';
import { syncLightFromFeet } from './metric/light-metric.js';

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

export function renderProps(state, container, redraw, onStructural) {
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
  renderLightProps(node, idx, container, redraw, onStructural, state);
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
    <label>Ambient (All) <input id="ambient" type="range" min="0" max="1" step="0.01" /></label>
    <label class="checkbox-row">
      <input type="checkbox" id="ambient-per-zone" />
      Per zone (subject / background)
    </label>
    <div id="ambient-zones" hidden>
      <label>Subject    <input id="ambient-subject"    type="range" min="0" max="1" step="0.01" /></label>
      <label>Background <input id="ambient-background" type="range" min="0" max="1" step="0.01" /></label>
    </div>
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
  const perZone = container.querySelector('#ambient-per-zone');
  const zones   = container.querySelector('#ambient-zones');
  const subj    = container.querySelector('#ambient-subject');
  const bg      = container.querySelector('#ambient-background');

  ambient.value = state.ambient;
  subj.value    = state.ambientSubject ?? state.ambient;
  bg.value      = state.ambientBackground ?? state.ambient;
  perZone.checked = state.ambientLinked === false;
  zones.hidden    = !perZone.checked;

  ambient.addEventListener('input', () => {
    const v = parseFloat(ambient.value);
    state.ambient = v;
    // When linked, the All slider drives both zones so they stay in sync —
    // this matches the back-compat behavior of a single ambient knob.
    if (state.ambientLinked !== false) {
      state.ambientSubject = v;
      state.ambientBackground = v;
      subj.value = v;
      bg.value = v;
    }
    redraw();
  });
  perZone.addEventListener('change', () => {
    state.ambientLinked = !perZone.checked;
    zones.hidden = !perZone.checked;
    // Re-linking snaps both zones back to the All value.
    if (!perZone.checked) {
      state.ambientSubject = state.ambient;
      state.ambientBackground = state.ambient;
      subj.value = state.ambient;
      bg.value = state.ambient;
    }
    redraw();
  });
  subj.addEventListener('input', () => {
    state.ambientSubject = parseFloat(subj.value);
    redraw();
  });
  bg.addEventListener('input', () => {
    state.ambientBackground = parseFloat(bg.value);
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

function renderLightProps(L, slotIdx, container, redraw, onStructural, state = {}) {
  if (L.type === 'reflector') {
    renderReflectorProps(L, slotIdx, container, redraw);
    return;
  }
  const goboOptions = ['<option value="">none</option>']
    .concat(goboPresets.map((g) =>
      `<option value="${g.gobo_id}">${escapeHtml(g.name)}</option>`))
    .join('');

  const canTarget = L.type === 'directional' || L.type === 'spotlight';

  // Calibrated scenes edit the light in feet/meters (world frame); the
  // engine-space Position Z slider is hidden then because position_ft is
  // authoritative and the engine position is derived from it.
  const units = state.units || 'ft';
  const metric = !!(state.calibration && L.position_ft);
  const ftFields = (cls) => `
      <label>Stage L/R <input class="${cls}-x" type="number" step="0.1" /></label>
      <label>Height <input class="${cls}-y" type="number" step="0.1" /></label>
      <label>Upstage <input class="${cls}-z" type="number" step="0.1" /></label>`;
  const posBlock = metric ? `
    <fieldset class="metric-pos"><legend>Position (${units})</legend>${ftFields('pos')}
    </fieldset>
    ${L.target_ft ? `<fieldset class="metric-tgt"><legend>Target (${units})</legend>${ftFields('tgt')}
    </fieldset>` : ''}` : '';

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
    ${metric ? posBlock : '<label>Position Z <input class="position-z" type="range" min="-2" max="3" step="0.05" /></label>'}
    <label>Direction Z <input class="direction-z" type="range" min="-1" max="1" step="0.02" /></label>
    ${canTarget ? '<label class="checkbox-row"><input type="checkbox" class="aim-at-target" /> Aim at target</label>' : ''}
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
  if (!metric) $('.position-z').value = L.position[2];
  $('.direction-z').value = L.direction[2];
  if (canTarget) {
    const targeted = isTargeted(L);
    $('.aim-at-target').checked = targeted;
    $('.direction-z').disabled = targeted;   // direction is derived while targeted
  }
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
  if (!metric) bind('.position-z', (t) => { L.position[2] = parseFloat(t.value); });
  bind('.direction-z', (t) => { L.direction[2] = parseFloat(t.value); });

  if (metric) {
    // Values display in the current unit; edits parse back to feet (accepting
    // "12.5", "3.8 m", "12'6\"") and re-derive the engine proxies.
    const fill = (cls, arr) => ['x', 'y', 'z'].forEach((ax, i) => {
      const el = $(`.${cls}-${ax}`);
      if (el && arr) el.value = toDisplay(arr[i], units).toFixed(1);
    });
    fill('pos', L.position_ft);
    fill('tgt', L.target_ft);
    const bindFt = (sel, arrKey, i) => $(sel)?.addEventListener('change', (e) => {
      const ft = parseLength(e.target.value, units);
      if (ft == null) return;
      L[arrKey][i] = ft;
      syncLightFromFeet(L, state.calibration);
      applyTargeting(L);
      e.target.value = toDisplay(ft, units).toFixed(1);
      redraw();
    });
    ['x', 'y', 'z'].forEach((ax, i) => {
      bindFt(`.pos-${ax}`, 'position_ft', i);
      if (L.target_ft) bindFt(`.tgt-${ax}`, 'target_ft', i);
    });
  }
  if (canTarget) {
    $('.aim-at-target').addEventListener('change', (e) => {
      if (e.target.checked) {
        L.target = targetSpawnPoint(L);   // spawn in front; beam won't jump
        applyTargeting(L);                // derive (unchanged at spawn)
      } else {
        L.target = null;                  // back to free-aim; keep last direction
      }
      // direction is derived while targeted — disable its slider directly (onChange
      // does not re-render the props panel, so we update this DOM in place).
      $('.direction-z').disabled = e.target.checked;
      if (onStructural) onStructural();   // remount 2D handles, sync 3D, save
    });
  }
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

function renderReflectorProps(L, slotIdx, container, redraw) {
  container.innerHTML = `
    <div class="props-header">
      <span class="slot-dot" style="background: ${slotColor(slotIdx)}"></span>
      <h2 class="props-name">${escapeHtml(L.name)}</h2>
    </div>
    <label>Enabled <input type="checkbox" class="r-enabled" ${L.enabled === false ? '' : 'checked'} /></label>
    <label>Affects
      <select class="r-affects">
        <option value="all"        ${L.affects === 'all'        ? 'selected' : ''}>all</option>
        <option value="subject"    ${L.affects === 'subject'    ? 'selected' : ''}>subject</option>
        <option value="background" ${L.affects === 'background' ? 'selected' : ''}>background</option>
      </select>
    </label>
    <label>Width       <input type="range" class="r-size0" min="0.1" max="2.0" step="0.05" value="${L.size?.[0] ?? 0.6}" /></label>
    <label>Height      <input type="range" class="r-size1" min="0.1" max="2.0" step="0.05" value="${L.size?.[1] ?? 0.4}" /></label>
    <label>Color       <input type="color" class="r-color" value="${linearToHex(L.color)}" /></label>
    <label>Reflectance <input type="range" class="r-reflectance" min="0" max="1" step="0.05" value="${L.reflectance ?? 0.7}" /></label>
    <label>Glossy ←→ Matte <input type="range" class="r-roughness" min="0" max="1" step="0.05" value="${L.roughness ?? 0.5}" /></label>
  `;

  const $ = (sel) => container.querySelector(sel);
  const bind = (sel, fn) =>
    $(sel).addEventListener('input', (e) => { fn(e.target); redraw(); });

  bind('.r-enabled',     (t) => { L.enabled = t.checked; });
  bind('.r-affects',     (t) => { L.affects = t.value; });
  bind('.r-size0',       (t) => { L.size = [parseFloat(t.value), L.size?.[1] ?? 0.4]; });
  bind('.r-size1',       (t) => { L.size = [L.size?.[0] ?? 0.6, parseFloat(t.value)]; });
  bind('.r-color',       (t) => { L.color = hexToLinearRGB(t.value); });
  bind('.r-reflectance', (t) => { L.reflectance = parseFloat(t.value); });
  bind('.r-roughness',   (t) => { L.roughness = parseFloat(t.value); });

  const nameEl = $('.props-name');
  if (nameEl) {
    nameEl.contentEditable = 'true';
    nameEl.addEventListener('blur', () => {
      L.name = nameEl.textContent.trim() || 'Reflector';
      redraw();
    });
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
