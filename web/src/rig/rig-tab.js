// Rig tab (Spec 2 §Rig tab): two stacked tables — hanging positions above
// fixtures — plus a status line. Pure view-model helpers (rowsForVenue,
// nextOffset, positionLabels, buildFixtureLight, the per-field setters…)
// have no DOM dependency and run under node --test; mountRigTab and
// renderPositionsTable wire them to plain DOM in the style of tree.js.
//
// Numbers are stored in feet and shown in the viewer's unit (Spec 1
// units.js); every edit goes through parseLength so "12'6\"" and "3 m" work.
import { newLightNode, newId } from '../lights.js';
import { FIXTURE_TYPES, PRESETS, PAR_LAMPS, applyFixturePreset } from './presets.js';
import {
  POSITION_KINDS, areaLabels, defaultFixtureName, positionToWorld,
} from './geometry.js';
import {
  syncFixtureFromRig, attachFixture, detachFixture, findPosition,
  enabledEmitterCount, tryEnable, CAP_MESSAGE,
} from './fixture-sync.js';
import { syncLightFromFeet } from '../metric/light-metric.js';
import { toDisplay, parseLength } from '../metric/units.js';
import { readoutCellText, throwAndDiameter, reasonTooltip } from '../metric/measure.js';
import { MAX_EMITTERS } from '../webgl/renderer.js';
import { defaultHouse } from './geometry.js';
import {
  HEIGHT_REFS, fromDeck, describeHeight, positionWithHeightRef, positionWithHeightInput, fixtureWithHeightInput,
} from './height-ref.js';

const REF_LABELS = { deck: 'Deck', house_floor: 'House floor', ceiling: 'Ceiling' };
const REF_OPTIONS = HEIGHT_REFS.map((r) => ({ value: r, label: REF_LABELS[r] }));
const REF_HINTS = { deck: 'above deck', house_floor: 'above house floor', ceiling: 'below ceiling' };

/** How a height stated in this reference reads next to its number ("below ceiling"). */
export function heightRefHint(ref) { return REF_HINTS[ref] || REF_HINTS.deck; }

export const CUSTOM_ROW_ID = 'custom';
export { CAP_MESSAGE };
const OFFSET_LIMIT_FACTOR = 3;        // offsets beyond ±3× the stage width are rejected
const HEIGHT_LIMIT_FACTOR = 3;        // boom heights above 3× the opening are rejected
const ADD_STEP_FT = 2;
const NEW_PIPE_STEP_FT = 8;

// ── pure view-model ─────────────────────────────────────────────────────

/** Fixture rows grouped by hanging position in venue order, then Custom. Reflectors excluded. */
export function rowsForVenue(lights, venue) {
  const emitters = (lights || []).filter((L) => L && L.type !== 'reflector');
  const positions = venue?.positions || [];
  const known = new Set(positions.map((p) => p.id));
  const rows = positions.map((p) => ({
    id: `pos:${p.id}`, name: p.name, position: p,
    fixtures: emitters.filter((L) => L.fixture?.position_id === p.id),
  }));
  rows.push({
    id: CUSTOM_ROW_ID, name: 'Custom', position: null,
    fixtures: emitters.filter((L) => !L.fixture?.position_id || !known.has(L.fixture.position_id)),
  });
  return rows;
}

/** Offset for the next fixture on a position: the last one there + 2 ft, else 0. */
export function nextOffset(lights, positionId) {
  if (!positionId) return 0;
  const on = (lights || []).filter((L) => L?.fixture?.position_id === positionId);
  if (!on.length) return 0;
  const last = on[on.length - 1].fixture.offset_ft;
  return (Number.isFinite(last) ? last : 0) + ADD_STEP_FT;
}

export function positionLabels(kind, units = 'ft') {
  switch (kind) {
    case 'boom':  return { n1: `Offset (${units})`, n2: `Upstage (${units})` };
    case 'floor': return { n1: `Upstage (${units})`, n2: '—' };
    default:      return { n1: `Upstage (${units})`, n2: `Trim (${units})` };
  }
}

export function positionFields(kind) {
  switch (kind) {
    case 'boom':  return { n1: 'offset_ft', n2: 'upstage_ft' };
    case 'floor': return { n1: 'upstage_ft', n2: null };
    default:      return { n1: 'upstage_ft', n2: 'trim_ft' };
  }
}

/** A copy of the position with the kind's fields: drops what no longer applies, fills what is now required. */
export function changeKind(position, kind, venue) {
  if (!POSITION_KINDS.includes(kind) || position.kind === kind) return position;
  const next = { id: position.id, name: position.name, kind, upstage_ft: position.upstage_ft ?? 0 };
  if (kind === 'pipe') next.trim_ft = venue?.height_ft ?? 20;
  if (kind === 'boom') next.offset_ft = 0;
  return next;
}

const freshPositionId = () => `pos_${newId()}`;

/** "Add position": a pipe 8 ft upstage of the last position at the venue's
 * opening height, its height stated in the venue's default reference
 * (trim_ft stays deck-relative; height_input_ft carries the stated number). */
export function newPosition(venue) {
  const ps = venue?.positions || [];
  const last = ps.length ? ps[ps.length - 1] : null;
  const trim_ft = venue?.height_ft ?? 20;
  const ref = HEIGHT_REFS.includes(venue?.default_height_ref) ? venue.default_height_ref : 'deck';
  const p = {
    id: freshPositionId(),
    name: `Pipe ${ps.length + 1}`,
    kind: 'pipe',
    upstage_ft: last ? (last.upstage_ft ?? 0) + NEW_PIPE_STEP_FT : 0,
    trim_ft,
    height_ref: ref,
  };
  if (ref !== 'deck') {
    const house = venue?.house || defaultHouse({ width_ft: venue?.width_ft ?? 40, height_ft: trim_ft, depth_ft: venue?.depth_ft ?? 30 });
    p.height_input_ft = fromDeck(trim_ft, ref, house);
  }
  return p;
}

export function validPositionValue(field, ft, venue) {
  if (!Number.isFinite(ft)) return false;
  if (field === 'trim_ft') return ft >= 0;
  if (field === 'offset_ft') return Math.abs(ft) <= OFFSET_LIMIT_FACTOR * (venue?.width_ft ?? 40);
  return true;   // upstage: any finite distance (negative into the house)
}

/** A fixture offset on a position: X along a pipe/floor row, height on a boom. */
export function validOffset(position, ft, venue) {
  if (!Number.isFinite(ft)) return false;
  if (position?.kind === 'boom') return ft >= 0 && ft <= HEIGHT_LIMIT_FACTOR * (venue?.height_ft ?? 20);
  return Math.abs(ft) <= OFFSET_LIMIT_FACTOR * (venue?.width_ft ?? 40);
}

/** The type-specific option column. */
export function optionControl(type) {
  const p = PRESETS[type] || PRESETS.other;
  if (!p.optionKey) return { key: null, kind: 'none', label: '' };
  if (p.optionKey === 'barrel_deg') return { key: 'barrel_deg', kind: 'select', values: p.optionValues.slice(), label: 'Barrel' };
  if (p.optionKey === 'lamp') return { key: 'lamp', kind: 'select', values: Object.keys(PAR_LAMPS), label: 'Lamp' };
  if (p.optionKey === 'length_ft') return { key: 'length_ft', kind: 'length', label: 'Length' };
  return { key: p.optionKey, kind: 'number', min: p.range[0], max: p.range[1], step: 1, label: 'Beam °' };
}

const fixtureCountOn = (lights, positionId) =>
  (lights || []).filter((L) => L?.type !== 'reflector' && L?.fixture?.position_id === positionId).length;

/** A new fixture light on a position (null = Custom), preset applied, not yet synced. */
export function buildFixtureLight(venue, position, type, offsetFt, index) {
  const name = position ? defaultFixtureName(position, index) : `Custom-${index}`;
  const L = newLightNode({
    name, type: 'spotlight',
    fixture: { type, position_id: position?.id ?? null, offset_ft: offsetFt, area: null },
  });
  applyFixturePreset(L, type);
  return L;
}

/** Copy of a fixture light: new id, next default name on its position (or "<name> Copy"), offset + 2 ft. */
export function cloneFixture(L, lights, venue) {
  const C = JSON.parse(JSON.stringify(L));
  C.id = newId();
  const pos = findPosition(venue, L.fixture?.position_id);
  C.name = pos ? defaultFixtureName(pos, fixtureCountOn(lights, pos.id) + 1) : `${L.name} Copy`;
  if (C.fixture) C.fixture.offset_ft = (Number.isFinite(C.fixture.offset_ft) ? C.fixture.offset_ft : 0) + ADD_STEP_FT;
  return C;
}

// ── shared per-field updates (used by the tables and the props pane) ─────

/** A fixture-less emitter edited from the rig becomes a Custom "other". */
export function ensureFixture(L) {
  if (!L.fixture) L.fixture = { type: 'other', position_id: null, offset_ft: 0, area: null };
  return L.fixture;
}

function resync(L, venue, record) {
  if (!syncFixtureFromRig(L, venue, record) && record && L.position_ft) syncLightFromFeet(L, record);
}

/** Change the fixture type: preset re-applied, position/offset/area/name/enabled/intensity kept. */
export function setFixtureType(L, type, venue, record) {
  const preset = PRESETS[type]; if (!preset) return { goboRemoved: false };
  const hadGobo = !!L.gobo;
  const current = preset.optionKey ? L.fixture?.[preset.optionKey] : undefined;
  const keep = { position_id: L.fixture?.position_id ?? null, offset_ft: L.fixture?.offset_ft ?? 0, area: L.fixture?.area ?? null };
  L.fixture = { type, ...keep };
  applyFixturePreset(L, type, current);
  if (preset.aimed === 'none') L.fixture.area = null;
  if (L.type === 'linear') {
    // A bar needs endpoints; a Custom one gets them around its feet position.
    if (!L.fixture.position_id && L.position_ft) {
      const h = (L.fixture.length_ft ?? PRESETS.cyc.defaultOption) / 2;
      L.endpoint_a_ft = [L.position_ft[0] - h, L.position_ft[1], L.position_ft[2]];
      L.endpoint_b_ft = [L.position_ft[0] + h, L.position_ft[1], L.position_ft[2]];
    }
  } else {
    for (const k of ['endpoint_a_ft', 'endpoint_b_ft', 'endpoint_a', 'endpoint_b']) delete L[k];
  }
  resync(L, venue, record);
  return { goboRemoved: hadGobo && !L.gobo };
}

export function setFixtureOption(L, value, venue, record) {
  ensureFixture(L);
  const ctl = optionControl(L.fixture.type);
  if (!ctl.key) return L;
  L.fixture[ctl.key] = value;
  applyFixturePreset(L, L.fixture.type, value);
  if (L.type === 'linear' && !L.fixture.position_id && L.position_ft) {
    const h = value / 2;
    L.endpoint_a_ft = [L.position_ft[0] - h, L.position_ft[1], L.position_ft[2]];
    L.endpoint_b_ft = [L.position_ft[0] + h, L.position_ft[1], L.position_ft[2]];
  }
  resync(L, venue, record);
  return L;
}

/** Hang on a position (snapping to the nearest offset) or, with null, make it Custom. */
export function setFixturePosition(L, positionId, venue, record) {
  const pos = findPosition(venue, positionId);
  ensureFixture(L);
  if (!pos) { detachFixture(L); return L; }
  attachFixture(L, pos, venue, record);
  return L;
}

export function setFixtureOffset(L, ft, venue, record) {
  ensureFixture(L).offset_ft = ft;
  resync(L, venue, record);
  return L;
}

export function setFixtureArea(L, area, venue, record) {
  ensureFixture(L).area = area || null;
  resync(L, venue, record);
  return L;
}

// ── DOM helpers ─────────────────────────────────────────────────────────

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
const fmt = (ft, units) => (Number.isFinite(ft) ? toDisplay(ft, units).toFixed(1) : '');
const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
};
const cell = (child, cls) => {
  const td = el('td', cls);
  if (typeof child === 'string') td.textContent = child; else if (child) td.appendChild(child);
  return td;
};
function lengthInput(ft, units, key, onCommit) {
  const input = el('input', 'rig-num');
  input.type = 'text'; input.inputMode = 'decimal';
  input.value = fmt(ft, units);
  input.dataset.key = key;
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); input.blur(); } });
  input.addEventListener('change', () => {
    const v = parseLength(input.value, units);
    if (v == null || !onCommit(v)) { input.value = fmt(ft, units); input.classList.add('is-invalid'); setTimeout(() => input.classList.remove('is-invalid'), 800); return; }
    input.value = fmt(v, units);
  });
  return input;
}
function textInput(value, key, onCommit) {
  const input = el('input', 'rig-text');
  input.type = 'text'; input.value = value; input.dataset.key = key;
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); input.blur(); } });
  input.addEventListener('change', () => {
    const t = input.value.trim();
    if (!t) { input.value = value; return; }
    onCommit(t);
  });
  return input;
}
function select(options, value, key, onCommit) {
  const s = el('select', 'rig-select');
  for (const o of options) {
    const opt = el('option', null, o.label);
    opt.value = o.value;
    s.appendChild(opt);
  }
  s.value = String(value);
  s.dataset.key = key;
  s.addEventListener('change', () => onCommit(s.value));
  return s;
}
function smallButton(label, title, onClick) {
  const b = el('button', 'rig-btn', label);
  b.type = 'button'; b.title = title;
  b.addEventListener('click', (e) => { e.stopPropagation(); onClick(); });
  return b;
}

// ── positions table (shared with the venue editor, Task 8) ───────────────

/**
 * @param {HTMLElement} container
 * @param {object} venue
 * @param {Function} onChange   (updatedVenue) => void — every edit hands back a new venue object
 * @param {object} [opts]       { units, fixtureCounts: Map<positionId, n>, onAddFixture(position), onDeletePosition(position) → boolean (false = veto), onLoadFromVenue() }
 */
export function renderPositionsTable(container, venue, onChange, opts = {}) {
  const units = opts.units || 'ft';
  const counts = opts.fixtureCounts || new Map();
  const positions = venue?.positions || [];
  const house = venue?.house || defaultHouse(venue || { width_ft: 40, height_ft: 20, depth_ft: 30 });
  container.innerHTML = '';

  const update = (idx, patch) => {
    const next = positions.map((p, i) => (i === idx ? { ...p, ...patch } : p));
    onChange({ ...venue, positions: next });
  };
  const replace = (idx, position) => {
    const next = positions.map((p, i) => (i === idx ? position : p));
    onChange({ ...venue, positions: next });
  };

  const table = el('table', 'rig-table rig-positions');
  const thead = el('thead');
  const hr = el('tr');
  for (const h of ['Position', 'Kind', 'Number 1', 'Number 2', 'Ref', 'Fixtures', '']) hr.appendChild(el('th', null, h));
  thead.appendChild(hr);
  table.appendChild(thead);
  const tbody = el('tbody');

  positions.forEach((p, idx) => {
    const tr = el('tr');
    tr.dataset.positionId = p.id;
    const labels = positionLabels(p.kind, units);
    const fields = positionFields(p.kind);
    tr.appendChild(cell(textInput(p.name, `pos:${p.id}:name`, (name) => update(idx, { name }))));
    tr.appendChild(cell(select(POSITION_KINDS.map((k) => ({ value: k, label: k })), p.kind, `pos:${p.id}:kind`,
      (kind) => replace(idx, changeKind(p, kind, venue)))));
    const n1 = lengthInput(p[fields.n1], units, `pos:${p.id}:${fields.n1}`, (ft) => {
      if (!validPositionValue(fields.n1, ft, venue)) return false;
      update(idx, { [fields.n1]: ft }); return true;
    });
    n1.title = labels.n1;
    tr.appendChild(cell(n1));
    const ref = p.height_ref || 'deck';
    if (fields.n2 === 'trim_ft') {
      // A pipe's height as the user states it (deck / house floor / ceiling);
      // trim_ft stays deck-relative underneath.
      const shown = ref === 'deck' ? p.trim_ft : (Number.isFinite(p.height_input_ft) ? p.height_input_ft : fromDeck(p.trim_ft, ref, house));
      const n2 = lengthInput(shown, units, `pos:${p.id}:trim_ft`, (v) => {
        const next = positionWithHeightInput(p, v, house);
        if (!validPositionValue('trim_ft', next.trim_ft, venue)) return false;
        replace(idx, next); return true;
      });
      n2.title = `${ref === 'deck' ? labels.n2 : `${REF_LABELS[ref]} (${units})`} · ${describeHeight(p.trim_ft, house, units)}`;
      tr.appendChild(cell(n2));
    } else if (fields.n2) {
      const n2 = lengthInput(p[fields.n2], units, `pos:${p.id}:${fields.n2}`, (ft) => {
        if (!validPositionValue(fields.n2, ft, venue)) return false;
        update(idx, { [fields.n2]: ft }); return true;
      });
      n2.title = labels.n2;
      tr.appendChild(cell(n2));
    } else {
      tr.appendChild(cell('—', 'rig-muted'));
    }
    if (p.kind === 'floor') {
      tr.appendChild(cell('—', 'rig-muted'));
    } else {
      const refSel = select(REF_OPTIONS, ref, `pos:${p.id}:ref`, (r) => replace(idx, positionWithHeightRef(p, r, house)));
      refSel.className = 'rig-select rig-ref';
      refSel.title = p.kind === 'boom' ? 'How fixture heights on this boom are stated' : 'How this pipe\'s trim is stated';
      tr.appendChild(cell(refSel));
    }
    tr.appendChild(cell(String(counts.get(p.id) || 0), 'rig-count'));
    const actions = el('span', 'rig-actions');
    if (opts.onAddFixture) actions.appendChild(smallButton('+', `Add a fixture on ${p.name}`, () => opts.onAddFixture(p)));
    actions.appendChild(smallButton('×', `Delete ${p.name}`, () => {
      if (opts.onDeletePosition && opts.onDeletePosition(p) === false) return;
      onChange({ ...venue, positions: positions.filter((_, i) => i !== idx) });
    }));
    tr.appendChild(cell(actions));
    // Column labels change with the kind: show them under the header as a hint row title.
    tr.title = `${labels.n1} · ${labels.n2}`;
    tbody.appendChild(tr);
  });
  table.appendChild(tbody);
  container.appendChild(table);

  const bar = el('div', 'rig-toolbar');
  bar.appendChild(smallButton('+ Add position', 'Append a pipe 8 ft upstage of the last position', () => {
    onChange({ ...venue, positions: [...positions, newPosition(venue)] });
  }));
  if (opts.onLoadFromVenue) bar.appendChild(smallButton('Load from venue…', 'Append another venue\'s positions', () => opts.onLoadFromVenue()));
  container.appendChild(bar);
  return table;
}

// ── the tab ─────────────────────────────────────────────────────────────

/**
 * @param {object}   opts
 * @param {HTMLElement} opts.rootEl            #rig-root
 * @param {Function} opts.getState            () => state (venue, lights, calibration, units, selectedId)
 * @param {Function} opts.onVenueChange       (venue) => void — persist, re-sync fixtures, redraw
 * @param {Function} opts.onLightsChange      () => void — after any light mutation (sync, tree, redraw, save)
 * @param {Function} opts.onSelect            (lightId) => void
 * @param {Function} [opts.openVenueEditor]   () => void
 * @param {Function} [opts.listVenues]        async () => venue[] (for "Load from venue…")
 */
export function mountRigTab({ rootEl, getState, onVenueChange, onLightsChange, onSelect, openVenueEditor, listVenues } = {}) {
  let message = '';           // transient status-line message (cap refusal, gobo removed)
  let messageTtl = 0;         // renders the message survives: shown now, gone at the next change
  let loadPicker = null;      // venues fetched for "Load from venue…" while the picker is open

  function say(text) { message = text || ''; messageTtl = 2; render(); }

  function addFixture(position, type = 'ers') {
    const st = getState();
    const lights = st.lights || [];
    const L = buildFixtureLight(st.venue, position, type, nextOffset(lights, position?.id), fixtureCountOn(lights, position?.id ?? null) + 1);
    if (!position) L.name = `Custom-${lights.filter((x) => x.fixture && !x.fixture.position_id).length + 1}`;
    if (enabledEmitterCount(lights) >= MAX_EMITTERS) L.enabled = false;
    st.tree.push(L);           // the rig rebuild files it under its position
    if (position) syncFixtureFromRig(L, st.venue, st.calibration);
    onLightsChange();
    onSelect?.(L.id);
    if (!L.enabled) say(CAP_MESSAGE);
  }

  function render() {
    const st = getState();
    const venue = st.venue;
    const units = st.units || 'ft';
    const lights = st.lights || [];
    const record = st.calibration;
    const focusKey = rootEl.contains(document.activeElement) ? document.activeElement.dataset?.key : null;
    if (messageTtl > 0) messageTtl -= 1; else message = '';
    rootEl.innerHTML = '';
    if (!venue || !record?.camera) {
      rootEl.appendChild(el('p', 'props-empty', 'Calibrate the scene to build a rig.'));
      return;
    }

    // Status line.
    const status = el('div', 'rig-status');
    const n = enabledEmitterCount(lights);
    status.appendChild(el('span', 'rig-status-count', `${n} of ${MAX_EMITTERS} enabled`));
    status.appendChild(el('span', 'rig-status-sep', ' · '));
    status.appendChild(el('span', 'rig-status-venue', `venue: ${venue.name}`));
    if (openVenueEditor) status.appendChild(smallButton('Venue…', 'Edit the venue', () => openVenueEditor()));
    if (message) status.appendChild(el('span', 'rig-msg', message));
    rootEl.appendChild(status);

    // Positions.
    const counts = new Map();
    for (const L of lights) if (L.fixture?.position_id && L.type !== 'reflector') counts.set(L.fixture.position_id, (counts.get(L.fixture.position_id) || 0) + 1);
    rootEl.appendChild(el('h3', 'rig-heading', 'Positions'));
    const posWrap = el('div', 'rig-table-wrap');
    renderPositionsTable(posWrap, venue, (next) => { message = ''; onVenueChange(next); }, {
      units, fixtureCounts: counts,
      onAddFixture: (p) => addFixture(p, lastType(lights, p.id)),
      onDeletePosition: (p) => {
        const hung = lights.filter((L) => L.fixture?.position_id === p.id);
        if (hung.length) {
          // Click-driven only (no key path), so the confirm cannot fire during a key-capturing mode.
          if (!window.confirm(`Delete ${p.name}? Its ${hung.length} fixture${hung.length === 1 ? '' : 's'} become Custom.`)) return false;
          for (const L of hung) detachFixture(L);
        }
        return true;
      },
      onLoadFromVenue: listVenues ? () => openLoadPicker() : null,
    });
    rootEl.appendChild(posWrap);
    if (loadPicker) rootEl.appendChild(renderLoadPicker(venue));

    // Fixtures.
    rootEl.appendChild(el('h3', 'rig-heading', 'Fixtures'));
    const fixWrap = el('div', 'rig-table-wrap');
    fixWrap.appendChild(renderFixturesTable(lights, venue, units, record, st.selectedId));
    rootEl.appendChild(fixWrap);
    const bar = el('div', 'rig-toolbar');
    bar.appendChild(smallButton('+ Add fixture', 'Append a fixture like the selected row (or the last one)', () => {
      // Like the selected fixture row when there is one (each add selects
      // the new light, so repeated clicks build a run on one position);
      // otherwise like the last row of the table.
      const emitters = lights.filter((L) => L.type !== 'reflector');
      const like = emitters.find((L) => L.id === st.selectedId && L.fixture)
        || [...emitters].reverse().find((L) => L.fixture) || null;
      addFixture(findPosition(venue, like?.fixture?.position_id) || null, like?.fixture?.type || 'ers');
    }));
    rootEl.appendChild(bar);

    if (focusKey) rootEl.querySelector(`[data-key="${cssEscape(focusKey)}"]`)?.focus();
  }

  function lastType(lights, positionId) {
    const on = lights.filter((L) => L.fixture?.position_id === positionId);
    return on.length ? on[on.length - 1].fixture.type : 'ers';
  }

  function renderFixturesTable(lights, venue, units, record, selectedId) {
    const table = el('table', 'rig-table rig-fixtures');
    const thead = el('thead');
    const hr = el('tr');
    for (const h of ['Name', 'Type', 'Option', 'Position', `Offset (${units})`, 'Area',
                     `Throw (${units})`, `Ø (${units})`, 'On', '']) hr.appendChild(el('th', null, h));
    thead.appendChild(hr);
    table.appendChild(thead);
    const tbody = el('tbody');
    const areas = areaLabels(venue.grid);
    const positionOptions = [{ value: '', label: 'Custom' }, ...venue.positions.map((p) => ({ value: p.id, label: p.name }))];
    const commit = () => { message = ''; onLightsChange(); };

    for (const group of rowsForVenue(lights, venue)) {
      const gh = el('tr', 'rig-group');
      const th = el('th', null, `${group.name} (${group.fixtures.length})`);
      th.colSpan = 10;
      gh.appendChild(th);
      tbody.appendChild(gh);
      for (const L of group.fixtures) {
        // A fixture-less emitter shows as a Custom "other"; the block is only
        // written when a rig field is edited (ensureFixture in the setters).
        const f = L.fixture || { type: 'other', position_id: null, offset_ft: 0, area: null };
        const pos = group.position;
        const tr = el('tr', 'rig-fixture');
        tr.dataset.id = L.id;
        if (L.id === selectedId) tr.classList.add('selected');
        if (L.enabled === false) tr.classList.add('disabled');
        tr.addEventListener('click', (e) => {
          if (e.target.closest('input, select, button')) return;
          onSelect?.(L.id);
        });
        tr.appendChild(cell(textInput(L.name, `fix:${L.id}:name`, (name) => { L.name = name; commit(); })));
        tr.appendChild(cell(select(FIXTURE_TYPES.map((t) => ({ value: t.id, label: t.label })), f.type, `fix:${L.id}:type`, (type) => {
          const { goboRemoved } = setFixtureType(L, type, venue, record);
          onLightsChange();
          if (goboRemoved) say(`${L.name}: gobo removed (${FIXTURE_TYPES.find((t) => t.id === type)?.label} has no gobo)`);
        })));
        tr.appendChild(cell(optionCell(L, f, units, venue, record, commit)));
        tr.appendChild(cell(select(positionOptions, f.position_id || '', `fix:${L.id}:position`, (pid) => {
          setFixturePosition(L, pid || null, venue, record); commit();
        })));
        if (pos && pos.kind === 'boom') {
          // Height on the boom, stated in the boom's reference; offset_ft stays deck-relative.
          const house = venue.house || defaultHouse(venue);
          const bref = pos.height_ref || 'deck';
          const shown = bref === 'deck' ? f.offset_ft : (Number.isFinite(f.height_input_ft) ? f.height_input_ft : fromDeck(f.offset_ft, bref, house));
          const off = lengthInput(shown, units, `fix:${L.id}:offset`, (v) => {
            const probe = { fixture: { ...f } };
            fixtureWithHeightInput(probe, v, pos, house);
            if (!validOffset(pos, probe.fixture.offset_ft, venue)) return false;
            fixtureWithHeightInput(L, v, pos, house);
            setFixtureOffset(L, L.fixture.offset_ft, venue, record); commit(); return true;
          });
          off.title = `${bref === 'deck' ? 'Height' : REF_LABELS[bref]} (${units}) · ${describeHeight(f.offset_ft, house, units)}`;
          // The column header says "Offset"; a boom height reads in the boom's reference.
          const heightCell = cell(off);
          heightCell.appendChild(el('span', 'rig-ref-hint', heightRefHint(bref)));
          tr.appendChild(heightCell);
        } else if (pos) {
          const off = lengthInput(f.offset_ft, units, `fix:${L.id}:offset`, (ft) => {
            if (!validOffset(pos, ft, venue)) return false;
            setFixtureOffset(L, ft, venue, record); commit(); return true;
          });
          off.title = `Offset (${units})`;
          tr.appendChild(cell(off));
        } else {
          const xyz = L.position_ft ? L.position_ft.map((v) => fmt(v, units)).join(' / ') : '—';
          tr.appendChild(cell(xyz, 'rig-muted rig-xyz')).title = `Stage L/R / Height / Upstage (${units})`;
        }
        const aimed = (PRESETS[f.type] || PRESETS.other).aimed !== 'none';
        const areaSel = select([{ value: '', label: '—' }, ...areas.map((a) => ({ value: a, label: a }))], f.area || '', `fix:${L.id}:area`,
          (a) => { setFixtureArea(L, a || null, venue, record); commit(); });
        areaSel.disabled = !aimed;
        if (!aimed) areaSel.title = 'A wash has no acting area';
        tr.appendChild(cell(areaSel));
        for (const kind of ['throw', 'dia']) {
          const { text, title } = readoutCellText(L, venue, units, kind);
          const td = cell(text, 'rig-muted rig-readout');
          td.dataset.readout = kind;
          if (title) td.title = title;
          tr.appendChild(td);
        }
        const on = el('input');
        on.type = 'checkbox'; on.checked = L.enabled !== false; on.dataset.key = `fix:${L.id}:on`;
        on.title = on.checked ? 'Disable' : 'Enable';
        on.addEventListener('change', () => {
          const r = tryEnable(lights, L, on.checked);
          if (!r.ok) { on.checked = false; say(r.message); return; }
          commit();
        });
        tr.appendChild(cell(on));
        const actions = el('span', 'rig-actions');
        actions.appendChild(smallButton('⧉', 'Clone', () => {
          const C = cloneFixture(L, lights, venue);
          if (enabledEmitterCount(lights) >= MAX_EMITTERS) C.enabled = false;
          getState().tree.push(C);
          if (C.fixture?.position_id) syncFixtureFromRig(C, venue, record);
          commit();
          onSelect?.(C.id);
          if (!C.enabled) say(CAP_MESSAGE);
        }));
        actions.appendChild(smallButton('×', 'Remove', () => {
          const st = getState();
          removeFromTree(st.tree, L.id);
          if (st.selectedId === L.id) st.selectedId = null;
          commit();
        }));
        tr.appendChild(cell(actions));
        tbody.appendChild(tr);
      }
    }
    table.appendChild(tbody);
    return table;
  }

  function optionCell(L, f, units, venue, record, commit) {
    const ctl = optionControl(f.type);
    if (ctl.kind === 'none') return el('span', 'rig-muted', '—');
    const key = `fix:${L.id}:option`;
    if (ctl.kind === 'select') {
      const s = select(ctl.values.map((v) => ({ value: v, label: typeof v === 'number' ? `${v}°` : v })), f[ctl.key], key,
        (v) => { setFixtureOption(L, typeof ctl.values[0] === 'number' ? Number(v) : v, venue, record); commit(); });
      s.title = ctl.label;
      return s;
    }
    if (ctl.kind === 'length') {
      const i = lengthInput(f.length_ft ?? PRESETS.cyc.defaultOption, units, key, (ft) => {
        if (!(ft > 0 && ft <= OFFSET_LIMIT_FACTOR * venue.width_ft)) return false;
        setFixtureOption(L, ft, venue, record); commit(); return true;
      });
      i.title = `${ctl.label} (${units})`;
      return i;
    }
    const i = el('input', 'rig-num');
    i.type = 'number'; i.min = ctl.min; i.max = ctl.max; i.step = ctl.step; i.value = f[ctl.key]; i.dataset.key = key; i.title = ctl.label;
    i.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); i.blur(); } });
    i.addEventListener('change', () => {
      const v = parseFloat(i.value);
      if (!Number.isFinite(v) || v < ctl.min || v > ctl.max) { i.value = f[ctl.key]; return; }
      setFixtureOption(L, v, venue, record); commit();
    });
    return i;
  }

  async function openLoadPicker() {
    try {
      const all = await listVenues();
      const st = getState();
      loadPicker = { venues: all.filter((v) => v.id !== st.venue?.id), choice: null };
      if (!loadPicker.venues.length) { loadPicker = null; say('No other venue to load from'); return; }
      loadPicker.choice = loadPicker.venues[0].id;
      render();
    } catch (e) {
      console.warn('listVenues', e);
      say('Could not list venues');
    }
  }

  function renderLoadPicker(venue) {
    const row = el('div', 'rig-load');
    row.appendChild(el('span', null, 'Append positions from '));
    row.appendChild(select(loadPicker.venues.map((v) => ({ value: v.id, label: v.name })), loadPicker.choice, 'rig:load', (id) => { loadPicker.choice = id; }));
    row.appendChild(smallButton('Append', 'Append that venue\'s positions with fresh ids', () => {
      const src = loadPicker.venues.find((v) => v.id === loadPicker.choice);
      loadPicker = null;
      if (!src) { render(); return; }
      const added = (src.positions || []).map((p) => ({ ...p, id: freshPositionId() }));
      onVenueChange({ ...venue, positions: [...venue.positions, ...added] });
    }));
    row.appendChild(smallButton('Cancel', 'Close', () => { loadPicker = null; render(); }));
    return row;
  }

  /**
   * Refresh only the readout cells, without rebuilding the table. Called on
   * every redraw (including each pointermove of a drag), so it must stay
   * allocation-light and write only what changed.
   */
  function updateReadouts() {
    if (!rootEl) return;
    const st = getState();
    const units = st.units || 'ft';
    for (const tr of rootEl.querySelectorAll('tr.rig-fixture[data-id]')) {
      const L = st.lights?.find((x) => x.id === tr.dataset.id);
      if (!L) continue;
      // One geometry solve per fixture, both cells formatted from it — see
      // ruling M3. Calling readoutCellText per kind would re-run
      // throwAndDiameter twice per fixture on every pointermove.
      const r = throwAndDiameter(L, st.venue);
      const title = r.reason === 'ok' ? '' : reasonTooltip(r.reason);
      for (const [kind, v] of [['throw', r.throwFt], ['dia', r.fieldDiaFt]]) {
        const td = tr.querySelector(`[data-readout="${kind}"]`);
        if (!td) continue;
        const text = r.reason === 'ok' ? toDisplay(v, units).toFixed(1) : '—';
        if (td.textContent !== text) td.textContent = text;
        if (td.title !== title) td.title = title;
      }
    }
  }

  return { render, updateReadouts };
}

function removeFromTree(arr, id) {
  for (let i = 0; i < arr.length; i++) {
    if (arr[i].id === id) { arr.splice(i, 1); return true; }
    if (arr[i].kind === 'group' && removeFromTree(arr[i].children, id)) return true;
  }
  return false;
}

function cssEscape(s) { return String(s).replace(/["\\]/g, '\\$&'); }

// Exposed for the props pane's compact "Rig" fieldset (controls.js).
export { FIXTURE_TYPES, positionToWorld, escapeHtml as rigEscapeHtml };
