// Venue editor (Spec 2 §Venue editor): a modal for the house — name, stage
// dimensions, acting-area grid, focus height, numbering direction, and the
// hanging positions (the Rig tab's positions table, reused). Save hands a
// validated venue to the caller; Duplicate and Delete delegate too, so this
// module never talks to the API itself and its pure helpers (badgeText,
// venueFromForm) run under node --test.
import { renderPositionsTable } from './rig-tab.js';
import { toDisplay, parseLength, formatLength } from '../metric/units.js';
import { clampHouse } from '../metric/cube-geometry.js';
import { defaultHouse } from './geometry.js';
import { HEIGHT_REFS } from './height-ref.js';

const HOUSE_FIELDS = [
  ['left', 'Left wall', 'left_wall_ft'], ['right', 'Right wall', 'right_wall_ft'], ['floor_drop', 'Floor drop', 'floor_drop_ft'],
  ['ceiling', 'Ceiling', 'ceiling_ft'], ['depth', 'House depth', 'depth_ft'],
];
const REF_LABELS = { deck: 'Deck', house_floor: 'House floor', ceiling: 'Ceiling' };

const GRID_MIN = 1, GRID_MAX = 6;

/** Header badge: "<name> · 40 × 20 × 30 ft" (trailing .0 trimmed; meters when units is 'm'). */
export function badgeText(venue, units = 'ft') {
  const u = units === 'm' ? 'm' : 'ft';
  const f = (ft) => toDisplay(ft, u).toFixed(1).replace(/\.0$/, '');
  return `${venue.name} · ${f(venue.width_ft)} × ${f(venue.height_ft)} × ${f(venue.depth_ft)} ${u}`;
}

/** The rule behind each house field the clamp had to alter (`wanted` = the values as stated). */
function houseRuleErrors(house, wanted, dims, units) {
  const errors = [];
  const altered = (f) => f in wanted && Math.abs(house[f] - wanted[f]) > 1e-6;
  if (altered('floor_drop_ft')) errors.push('Floor drop must be zero or more (the house floor is at or below the deck)');
  if (altered('ceiling_ft')) errors.push(`Ceiling must clear the opening height (at least ${formatLength(dims.height_ft + 0.5, units)})`);
  if (altered('left_wall_ft') || altered('right_wall_ft')) errors.push(`Walls must be at least the stage width apart (${formatLength(dims.width_ft, units)})`);
  if (altered('depth_ft')) errors.push(`House depth must be at least ${formatLength(1, units)}`);
  return errors;
}

function clampGrid(v) {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return 3;
  return Math.max(GRID_MIN, Math.min(GRID_MAX, n));
}

/**
 * Form values → venue (feet) plus a list of validation messages. Dimensions
 * and the focus height are parsed with parseLength in the given unit (so
 * "40'6\"" and "6 m" work); rows/cols are clamped to 1–6.
 * @param {object} values  { name, width, height, depth, rows, cols, focus, number_from_stage_left, positions }
 * @param {string} units   'ft' | 'm'
 * @param {object} [base]  the venue being edited (id and any server fields carried over)
 */
export function venueFromForm(values, units = 'ft', base = {}) {
  const errors = [];
  const name = String(values.name ?? '').trim();
  if (!name) errors.push('Name is required');
  const dim = (label, text) => {
    const ft = parseLength(String(text ?? ''), units);
    if (ft == null || !(ft > 0)) { errors.push(`${label} must be a positive length`); return NaN; }
    return ft;
  };
  const width_ft = dim('Width', values.width);
  const height_ft = dim('Height', values.height);
  const depth_ft = dim('Depth', values.depth);
  let focus_height_ft = parseLength(String(values.focus ?? ''), units);
  if (focus_height_ft == null || focus_height_ft < 0) { errors.push('Focus height must be zero or more'); focus_height_ft = NaN; }
  const venue = {
    ...base,
    name, width_ft, height_ft, depth_ft,
    grid: { rows: clampGrid(values.rows), cols: clampGrid(values.cols), number_from_stage_left: !!values.number_from_stage_left },
    focus_height_ft,
    positions: values.positions || base.positions || [],
  };
  // House (calibration cube). Edited house fields are parsed in the unit and
  // run through clampHouse; a value the clamp would alter is reported with
  // its rule (the clamped value is kept on the venue, but the errors block
  // Save). With no house edit the house is still checked against the PARSED
  // dims: an estimated house follows them silently (as the draft does live),
  // an edited one that no longer clears the rules reports the rule — so a
  // dims-only edit can never reach the API with a house it rejects.
  let house = base.house || null;
  const dims = Number.isFinite(width_ft) && Number.isFinite(height_ft) && Number.isFinite(depth_ft)
    ? { width_ft, height_ft, depth_ft } : null;
  if (values.house && values.house_edited) {
    const patch = {};
    for (const [key, label, field] of HOUSE_FIELDS) {
      const ft = parseLength(String(values.house[key] ?? ''), units);
      if (ft == null) errors.push(`${label} must be a length`); else patch[field] = ft;
    }
    if (dims) {
      house = clampHouse(house || defaultHouse(dims), dims, patch);
      errors.push(...houseRuleErrors(house, patch, dims, units));
    }
  } else if (house && dims) {
    if (house.estimated || !Number.isFinite(house.left_wall_ft)) {
      house = defaultHouse(dims);
    } else {
      const clamped = clampHouse(house, dims, { left_wall_ft: house.left_wall_ft });
      errors.push(...houseRuleErrors(clamped, house, dims, units));
      house = clamped;
    }
  }
  if (house) venue.house = house;
  venue.default_height_ref = HEIGHT_REFS.includes(values.default_height_ref)
    ? values.default_height_ref : (base.default_height_ref || 'deck');
  return { venue, errors };
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/**
 * Open the editor. Resolves with 'saved' | 'duplicated' | 'deleted' | null (closed).
 * @param {object}   opts
 * @param {object}   opts.venue          the venue to edit (not mutated)
 * @param {string}   [opts.units]        'ft' | 'm' for display
 * @param {Function} opts.onSave         async (venue) => void
 * @param {Function} [opts.onDuplicate]  async (name) => void
 * @param {Function} [opts.onDelete]     async ({ force }) => void — a 409 rejection (err.status, err.body.scene_count) asks to force
 * @param {Function} [opts.onCalibrate]  () => void — closes the editor and opens the photo calibration panel (stage box)
 */
export function openVenueEditor({ venue, units = 'ft', onSave, onDuplicate, onDelete, onCalibrate } = {}) {
  return new Promise((resolve) => {
    const u = units === 'm' ? 'm' : 'ft';
    const f = (ft) => (Number.isFinite(ft) ? toDisplay(ft, u).toFixed(1) : '');
    let positions = (venue.positions || []).map((p) => ({ ...p }));   // local draft; Save commits
    const house0 = venue.house || defaultHouse(venue);
    let houseEdited = false;

    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `
      <div class="modal modal-wide venue-editor" role="dialog" aria-label="Venue">
        <div class="modal-toolbar">
          <h2>Venue</h2>
          <span class="modal-spacer"></span>
        </div>
        <div class="modal-row"><span>Name</span><input id="ve-name" type="text" value="${escapeHtml(venue.name || '')}" /></div>
        <div class="venue-dims">
          <label>Width (${u}) <input id="ve-width" type="text" inputmode="decimal" value="${f(venue.width_ft)}" /></label>
          <label>Height (${u}) <input id="ve-height" type="text" inputmode="decimal" value="${f(venue.height_ft)}" /></label>
          <label>Depth (${u}) <input id="ve-depth" type="text" inputmode="decimal" value="${f(venue.depth_ft)}" /></label>
        </div>
        <p class="venue-note">Dimensions belong to this venue and apply to every scene that uses it.</p>
        <div class="venue-dims">
          <label>Area rows <input id="ve-rows" type="number" min="1" max="6" step="1" value="${venue.grid?.rows ?? 3}" /></label>
          <label>Area columns <input id="ve-cols" type="number" min="1" max="6" step="1" value="${venue.grid?.cols ?? 3}" /></label>
          <label>Focus height (${u}) <input id="ve-focus" type="text" inputmode="decimal" value="${f(venue.focus_height_ft ?? 5)}" /></label>
        </div>
        <label class="checkbox-row"><input id="ve-from-sl" type="checkbox" ${venue.grid?.number_from_stage_left ? 'checked' : ''} /> Number areas from stage left</label>
        <h3 class="rig-heading">House</h3>
        <div class="venue-dims">
          ${HOUSE_FIELDS.map(([key, label, field]) => `<label>${label} (${u}) <input id="ve-h-${key}" class="ve-house" type="text" inputmode="decimal" value="${f(house0[field])}" /></label>`).join('')}
        </div>
        <p class="venue-note" id="ve-house-note" ${house0.estimated ? '' : 'hidden'}>House values are estimated from the stage; edit any of them to confirm.</p>
        <div class="venue-dims">
          <label>Default height reference <select id="ve-href">${HEIGHT_REFS.map((r) => `<option value="${r}" ${(venue.default_height_ref || 'deck') === r ? 'selected' : ''}>${REF_LABELS[r]}</option>`).join('')}</select></label>
        </div>
        <h3 class="rig-heading">Positions</h3>
        <div id="ve-positions" class="rig-table-wrap"></div>
        <div id="ve-dup" class="venue-dup" hidden>
          <span>Copy as</span>
          <input id="ve-dup-name" type="text" />
          <button id="ve-dup-ok" type="button">Duplicate</button>
          <button id="ve-dup-cancel" type="button">Cancel</button>
        </div>
        <div id="ve-errors" class="modal-error" hidden></div>
        <div class="modal-actions">
          ${onDelete ? '<button id="ve-delete" type="button" class="venue-danger">Delete</button>' : ''}
          ${onDuplicate ? '<button id="ve-duplicate" type="button">Duplicate…</button>' : ''}
          ${onCalibrate ? '<button id="ve-calibrate" type="button" title="Fit the stage box on the photo (the dimensions stay with the venue)">Calibration…</button>' : ''}
          <span class="modal-spacer"></span>
          <button id="ve-close" type="button">Close</button>
          <button id="ve-save" type="button" class="venue-primary">Save</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);
    const $ = (sel) => overlay.querySelector(sel);
    const errorsEl = $('#ve-errors');

    function close(value) {
      if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
      resolve(value);
    }
    function showErrors(list) {
      errorsEl.hidden = list.length === 0;
      errorsEl.innerHTML = list.map((m) => `<div>${escapeHtml(m)}</div>`).join('');
    }
    function busy(on) {
      for (const b of overlay.querySelectorAll('.modal-actions button, #ve-dup button')) b.disabled = on;
    }

    function drawPositions() {
      // The editor's own default-reference select governs positions added here.
      const default_height_ref = $('#ve-href')?.value || venue.default_height_ref || 'deck';
      renderPositionsTable($('#ve-positions'), { ...venue, house: house0, positions, default_height_ref }, (next) => {
        positions = next.positions;
        drawPositions();
      }, { units: u });
    }
    drawPositions();

    function readForm() {
      const houseValues = Object.fromEntries(HOUSE_FIELDS.map(([key]) => [key, $(`#ve-h-${key}`).value]));
      return venueFromForm({
        name: $('#ve-name').value, width: $('#ve-width').value, height: $('#ve-height').value, depth: $('#ve-depth').value,
        rows: $('#ve-rows').value, cols: $('#ve-cols').value, focus: $('#ve-focus').value,
        number_from_stage_left: $('#ve-from-sl').checked, positions,
        house: houseValues, house_edited: houseEdited, default_height_ref: $('#ve-href').value,
      }, u, { ...venue, house: house0 });
    }
    for (const input of overlay.querySelectorAll('.ve-house')) {
      input.addEventListener('input', () => { houseEdited = true; $('#ve-house-note').hidden = true; });
    }
    $('#ve-href').addEventListener('change', drawPositions);

    $('#ve-close').addEventListener('click', () => close(null));
    if (onCalibrate) $('#ve-calibrate').addEventListener('click', () => { close('calibrate'); onCalibrate(); });
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(null); });
    overlay.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(null); } });

    $('#ve-save').addEventListener('click', async () => {
      const { venue: next, errors } = readForm();
      showErrors(errors);
      if (errors.length) return;
      busy(true);
      try { await onSave?.(next); close('saved'); }
      catch (e) { showErrors([`Save failed: ${e.message || e}`]); busy(false); }
    });

    if (onDuplicate) {
      $('#ve-duplicate').addEventListener('click', () => {
        $('#ve-dup').hidden = false;
        $('#ve-dup-name').value = `${$('#ve-name').value.trim() || venue.name} copy`;
        $('#ve-dup-name').focus();
      });
      $('#ve-dup-cancel').addEventListener('click', () => { $('#ve-dup').hidden = true; });
      $('#ve-dup-ok').addEventListener('click', async () => {
        const name = $('#ve-dup-name').value.trim();
        if (!name) { showErrors(['Give the copy a name']); return; }
        busy(true);
        try { await onDuplicate(name); close('duplicated'); }
        catch (e) { showErrors([`Duplicate failed: ${e.message || e}`]); busy(false); }
      });
    }

    if (onDelete) {
      $('#ve-delete').addEventListener('click', async () => {
        // Click-driven only: the confirm never fires from a key handler.
        if (!window.confirm(`Delete venue "${venue.name}"?`)) return;
        busy(true);
        try {
          await onDelete({ force: false });
          close('deleted');
        } catch (e) {
          if (e?.status === 409) {
            const n = e.body?.scene_count ?? 'some';
            if (window.confirm(`Used by ${n} scene(s). Delete anyway? They keep their embedded copy.`)) {
              try { await onDelete({ force: true }); close('deleted'); return; }
              catch (e2) { showErrors([`Delete failed: ${e2.message || e2}`]); }
            }
          } else {
            showErrors([`Delete failed: ${e.message || e}`]);
          }
          busy(false);
        }
      });
    }

    $('#ve-name').focus();
  });
}
