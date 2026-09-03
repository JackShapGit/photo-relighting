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
import { throwAndDiameter, reasonTooltip } from './metric/measure.js';
import { FIXTURE_TYPES, PRESETS as FIXTURE_PRESETS } from './rig/presets.js';
import { detachFixture, detachAim, findPosition, setLightType, tryEnable } from './rig/fixture-sync.js';
import { areaLabels } from './rig/geometry.js';
import {
  optionControl, validOffset, setFixtureType, setFixtureOption, setFixturePosition, setFixtureOffset, setFixtureArea,
} from './rig/rig-tab.js';

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

export function renderProps(state, container, redraw, onStructural, onRigEdit) {
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
  renderLightProps(node, idx, container, redraw, onStructural, state, onRigEdit);
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
    <h3 class="preset-section">Fixtures</h3>
    <p class="props-empty">Theatre instruments. Added as Custom; the Rig tab hangs them on a position.</p>
    <div class="preset-grid">
      ${FIXTURE_TYPES.map((t) => `
        <button class="preset-card fixture-card" type="button" data-fixture="${t.id}" title="${escapeHtml(t.label)}">
          <div class="preset-thumb"><span class="preset-glyph">◆</span></div>
          <div class="preset-name">${escapeHtml(t.label)}</div>
        </button>
      `).join('')}
    </div>
    <div class="modal-actions">
      <button id="add-cancel" type="button">Cancel</button>
    </div>
  `;
  for (const card of container.querySelectorAll('.preset-card:not(.fixture-card)')) {
    card.addEventListener('click', () => {
      const id = card.dataset.id;
      const preset = PRESETS.find((p) => p.id === id);
      onPick?.(preset || null);
    });
  }
  for (const card of container.querySelectorAll('.fixture-card')) {
    card.addEventListener('click', () => {
      const t = FIXTURE_TYPES.find((x) => x.id === card.dataset.fixture);
      onPick?.(t ? { kind: 'fixture', id: t.id, label: t.label } : null);
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

function renderLightProps(L, slotIdx, container, redraw, onStructural, state = {}, onRigEdit = null) {
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

  // Rig mode (Spec 2): a fixture's type / option / position / offset / area
  // live in a compact fieldset above the light controls, sharing the rig
  // tab's setters so both places behave the same.
  const rig = !!(state.venue && state.calibration?.camera && L.fixture);
  const rigPos = rig ? findPosition(state.venue, L.fixture.position_id) : null;
  const rigBlock = rig ? `
    <fieldset class="rig-props"><legend>Rig</legend>
      <label>Fixture <select class="rig-type">${FIXTURE_TYPES.map((t) => `<option value="${t.id}">${escapeHtml(t.label)}</option>`).join('')}</select></label>
      <label class="rig-option-row"><span class="rig-option-label"></span><span class="rig-option-slot"></span></label>
      <label>Position <select class="rig-position"><option value="">Custom</option>${state.venue.positions.map((p) => `<option value="${escapeHtml(p.id)}">${escapeHtml(p.name)}</option>`).join('')}</select></label>
      ${rigPos ? `<label>${rigPos.kind === 'boom' ? 'Height' : 'Offset'} (${units}) <input class="rig-offset" type="text" inputmode="decimal" /></label>` : ''}
      <label>Area <select class="rig-area"><option value="">—</option>${areaLabels(state.venue.grid).map((a) => `<option value="${a}">${a}</option>`).join('')}</select></label>
    </fieldset>` : '';

  container.innerHTML = `
    <div class="props-header">
      <span class="slot-dot" style="background: ${slotColor(slotIdx)}"></span>
      <h2 class="props-name">${escapeHtml(L.name)}</h2>
    </div>
    ${rigBlock}
    <div class="readout-block">
      <div class="readout-row"><span class="readout-key">Throw</span><span class="readout-val" data-readout="throw">—</span></div>
      <div class="readout-row"><span class="readout-key">Field Ø</span><span class="readout-val" data-readout="dia">—</span></div>
    </div>
    <label>Type
      <select class="type" ${rig ? 'disabled title="Set by the fixture type"' : ''}>
        <option value="directional">directional</option>
        <option value="point">point</option>
        <option value="spotlight">spotlight</option>
        <option value="linear">linear</option>
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
    <div class="props-msg" hidden></div>
  `;

  // Spec 3: throw and field diameter for the selected fixture. The block's
  // markup lives in the template above, next to the rig fields it describes;
  // updateReadoutBlock fills it in so a drag can refresh it without
  // re-rendering the whole props pane.
  updateReadoutBlock(container, L, state.venue, state.units || 'ft');

  const $ = (sel) => container.querySelector(sel);

  if (rig) {
    const venue = state.venue, record = state.calibration;
    const done = () => (onRigEdit ? onRigEdit() : onStructural?.());
    const f = L.fixture;
    $('.rig-type').value = f.type;
    $('.rig-type').addEventListener('change', (e) => { setFixtureType(L, e.target.value, venue, record); done(); });
    $('.rig-position').value = f.position_id || '';
    $('.rig-position').addEventListener('change', (e) => { setFixturePosition(L, e.target.value || null, venue, record); done(); });
    const areaSel = $('.rig-area');
    areaSel.value = f.area || '';
    areaSel.disabled = (FIXTURE_PRESETS[f.type] || FIXTURE_PRESETS.other).aimed === 'none';
    areaSel.addEventListener('change', (e) => { setFixtureArea(L, e.target.value || null, venue, record); done(); });
    const offIn = $('.rig-offset');
    if (offIn) {
      offIn.value = toDisplay(f.offset_ft ?? 0, units).toFixed(1);
      offIn.addEventListener('change', (e) => {
        const ft = parseLength(e.target.value, units);
        if (ft == null || !validOffset(rigPos, ft, venue)) { e.target.value = toDisplay(f.offset_ft ?? 0, units).toFixed(1); return; }
        setFixtureOffset(L, ft, venue, record); done();
      });
    }
    // Option control per type: barrel/lamp select, beam number, cyc length.
    const ctl = optionControl(f.type);
    const row = $('.rig-option-row');
    if (ctl.kind === 'none') row.hidden = true;
    else {
      $('.rig-option-label').textContent = ctl.kind === 'length' ? `${ctl.label} (${units})` : ctl.label;
      const slot = $('.rig-option-slot');
      let input;
      if (ctl.kind === 'select') {
        input = document.createElement('select');
        input.innerHTML = ctl.values.map((v) => `<option value="${v}">${typeof v === 'number' ? `${v}°` : v}</option>`).join('');
        input.value = String(f[ctl.key]);
        input.addEventListener('change', () => { setFixtureOption(L, typeof ctl.values[0] === 'number' ? Number(input.value) : input.value, venue, record); done(); });
      } else if (ctl.kind === 'length') {
        input = document.createElement('input');
        input.type = 'text'; input.inputMode = 'decimal';
        input.value = toDisplay(f.length_ft ?? 4, units).toFixed(1);
        input.addEventListener('change', () => {
          const ft = parseLength(input.value, units);
          if (ft == null || ft <= 0) { input.value = toDisplay(f.length_ft ?? 4, units).toFixed(1); return; }
          setFixtureOption(L, ft, venue, record); done();
        });
      } else {
        input = document.createElement('input');
        input.type = 'number'; input.min = ctl.min; input.max = ctl.max; input.step = ctl.step;
        input.value = f[ctl.key];
        input.addEventListener('change', () => {
          const v = parseFloat(input.value);
          if (!Number.isFinite(v) || v < ctl.min || v > ctl.max) { input.value = f[ctl.key]; return; }
          setFixtureOption(L, v, venue, record); done();
        });
      }
      input.className = 'rig-option';
      slot.appendChild(input);
    }
  }

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

  $('.type').addEventListener('change', (e) => {
    // A linear light needs endpoints (the server rejects one without); the
    // shared setter seeds them and re-derives the proxies. Structural: the
    // 3D primitive and the handles change shape.
    setLightType(L, e.target.value, state.calibration || null, state.venue || null);
    if (onStructural) onStructural(); else redraw();
    renderLightProps(L, slotIdx, container, redraw, onStructural, state, onRigEdit);
  });
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
      // Typed feet are a direct move (Custom) or a direct aim (no area).
      if (arrKey === 'position_ft') detachFixture(L); else detachAim(L);
      syncLightFromFeet(L, state.calibration);
      applyTargeting(L);
      e.target.value = toDisplay(ft, units).toFixed(1);
      // The engine position changed too, so the 2D handles must be remounted
      // (the structural path also syncs the 3D scene and saves).
      if (onStructural) onStructural(); else redraw();
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
      // In a calibrated scene the structural sync just created or dropped
      // target_ft (and re-derived the direction), so the Target fields and the
      // Direction Z slider must be re-rendered to match.
      if (metric) renderLightProps(L, slotIdx, container, redraw, onStructural, state);
    });
  }
  bind('.intensity', (t) => { L.intensity = parseFloat(t.value); });
  bind('.color', (t) => { L.color = hexToLinearRGB(t.value); L.color_temperature = null; });
  bind('.kelvin', (t) => { L.color_temperature = parseFloat(t.value); L.color = [1, 1, 1]; });
  bind('.cone', (t) => { L.cone_angle = parseFloat(t.value); });
  bind('.softness', (t) => { L.softness = parseFloat(t.value); });
  bind('.falloff', (t) => { L.falloff = parseFloat(t.value); });
  bind('.affects', (t) => { L.affects = t.value; });
  $('.enabled').addEventListener('change', (e) => {
    // Same gate and message as the Rig tab: at most 64 emitters may be on.
    const r = tryEnable(state.lights || [], L, e.target.checked);
    const msg = $('.props-msg');
    if (!r.ok) { e.target.checked = false; msg.hidden = false; msg.textContent = r.message; return; }
    msg.hidden = true; msg.textContent = '';
    if (onStructural) onStructural(); else redraw();   // the tree row and the rig table follow
  });
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

/**
 * Refresh the props-pane readout values in place. Safe to call on every
 * redraw: it writes only when the text actually changed, and no-ops when the
 * pane is not showing a light.
 */
export function updateReadoutBlock(container, light, venue, units = 'ft') {
  if (!container || !light) return;
  const block = container.querySelector('.readout-block');
  if (!block) return;
  // One geometry solve for both cells (ruling M3) — see the matching shape
  // in rig-tab.js's updateReadouts. readoutCellText (Task 2) is unchanged
  // and still used per-cell by the table's static render, where the double
  // solve this avoids does not arise.
  const r = throwAndDiameter(light, venue);
  const title = r.reason === 'ok' ? '' : reasonTooltip(r.reason);
  for (const [kind, v] of [['throw', r.throwFt], ['dia', r.fieldDiaFt]]) {
    const el = block.querySelector(`[data-readout="${kind}"]`);
    if (!el) continue;
    const text = r.reason === 'ok' ? toDisplay(v, units).toFixed(1) : '—';
    if (el.textContent !== text) el.textContent = text;
    if (el.title !== title) el.title = title;
  }
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
