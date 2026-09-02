// Stage calibration panel (calibration cube spec): the numbers behind the
// draggable stage box on the photo. Stage dimensions are typed here and go
// to the draft (the box on the photo never moves when a dimension changes;
// the solve does); the buttons commit or discard the draft and walk the
// undo history. The five-click marking flow is gone — the marks are the
// box's handles.
//
// The panel lives inside #canvas-wrap (as before) but owns no overlay: the
// box is cube-overlay-2d.js, the draft/history reducer is
// calibration-draft.js, and main.js owns both plus the preview camera.
import { validateMarks, fitDepth } from './calibration.js';
import { clampHouse } from './cube-geometry.js';
import { toDisplay, fromDisplay } from './units.js';

const CROSS_CHECK_WARN_PCT = 20;
const HEIGHT_WARN_PCT = 10;
const PERSPECTIVE_WARN = 0.9;
const HEIGHT_REFS = [['deck', 'Deck'], ['house_floor', 'House floor'], ['ceiling', 'Ceiling']];
// House fields (calibration cube spec §House box): typed values go through
// clampHouse; a value the clamp would alter is rejected with its rule.
const HOUSE_FIELDS = [
  ['left_wall_ft', 'Left wall', 'The left wall must sit at least the stage width from the right wall'],
  ['right_wall_ft', 'Right wall', 'The right wall must sit at least the stage width from the left wall'],
  ['floor_drop_ft', 'Floor drop', 'The house floor is at or below the deck (0 or more)'],
  ['ceiling_ft', 'Ceiling', 'The ceiling must clear the opening height'],
  ['depth_ft', 'House depth', 'House depth must be at least 1 ft'],
];
const REJECT_FLASH_MS = 600;
const crossCheckMessage = (pct) =>
  `Metric depth model disagrees with your marks by ${Math.round(pct)}%; recheck the lip and back-line handles.`;

/**
 * Dimensions to show when the panel opens: the calibration record's when it
 * has them, else the scene's venue's (Spec 2: dimensions belong to the
 * venue), else blanks. `source` says which.
 */
export function panelDims(record, venue) {
  if (record && Number.isFinite(record.width_ft)) {
    return { width_ft: record.width_ft, height_ft: record.height_ft, depth_ft: record.depth_ft, source: 'record' };
  }
  if (venue && Number.isFinite(venue.width_ft)) {
    return { width_ft: venue.width_ft, height_ft: venue.height_ft, depth_ft: venue.depth_ft, source: 'venue' };
  }
  return { width_ft: null, height_ft: null, depth_ft: null, source: null };
}

/**
 * A dimension field back to feet. While the field still shows exactly what
 * the panel prefilled, the exact prefilled value is used (so a venue's
 * 40.25 ft shown as "40.3" is not written back as 40.3); an edit is parsed
 * in the panel's unit. NaN when unparseable.
 */
export function readDim(text, shown, exact, units) {
  if (exact != null && text === shown) return exact;
  const v = parseFloat(text);
  return Number.isFinite(v) ? fromDisplay(v, units) : NaN;
}

/** Live warnings for a draft: its preview camera and (when a sampler is given) the depth fit. */
export function draftWarnings(cam, depthFit) {
  const warns = [];
  if (!cam) return warns;
  if (cam.height_check_pct > HEIGHT_WARN_PCT) {
    warns.push(`Photo implies an opening height ${cam.height_check_pct.toFixed(0)}% different from what you entered; check the top handle.`);
  }
  if (cam.perspective_ratio > PERSPECTIVE_WARN) {
    warns.push('Stage depth is small relative to the camera distance, so upstage distances are sensitive to the back-line handles. Place them carefully.');
  }
  if (depthFit === null) {
    warns.push('Depth map has no usable relief between lip and back line; upstage distances fall back to a linear estimate.');
  }
  return warns;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/**
 * @param {object} o
 * @param {HTMLElement} o.panelEl         #calib-panel
 * @param {() => object} o.getState       main.js state (calibration, width, height, units)
 * @param {() => object} o.getDraftState  the reducer state { applied, draft, history, redo, dirty }
 * @param {() => object|null} o.getPreviewCamera  camera solved from the draft (null when it cannot be)
 * @param {(action) => void} o.dispatch   reducer dispatch (used for `edit` and `revert`)
 * @param {(record, venuePatch) => void|Promise} o.onApplyCommit  Apply: the draft's record + { dims, house, default_height_ref }
 * @param {(entry) => void|Promise} o.onUndoRestore   Undo: the latest history entry
 * @param {(entry) => void|Promise} o.onRedoRestore   Redo: the redo-slot entry
 * @param {() => void|Promise} o.onClearCommit          Clear
 * @param {() => string} o.getUnits       'ft' | 'm' (display)
 * @param {() => object|null} [o.getVenue]
 * @param {(u, v) => number} [o.sampleDepth]  depth at a photo coordinate (for the live "no fit" warning and the applied record)
 * @param {(record) => Promise} [o.onCrossCheck]  server-side cross-check after Apply (silent on failure)
 * @param {(open: boolean) => void} [o.onToggle]   called after open()/close()
 */
export function mountCalibrationPanel({
  panelEl, getState, getDraftState, getPreviewCamera, dispatch, onApplyCommit, onUndoRestore, onRedoRestore, onClearCommit,
  getUnits, getVenue = null, sampleDepth = null, onCrossCheck = null, onToggle = null,
}) {
  if (!panelEl) return null;

  panelEl.innerHTML = `
    <h3>Stage calibration</h3>
    <p class="cal-help">Drag the box's corners on the photo to fit the stage; type its real size here.</p>
    <label>Width <input class="cal-w" type="number" step="0.1" min="0" /></label>
    <label>Height <input class="cal-h" type="number" step="0.1" min="0" /></label>
    <label>Depth <input class="cal-d" type="number" step="0.1" min="0" /></label>
    <div class="cal-note" hidden></div>
    <div class="view-mode cal-units" role="group" aria-label="Calibration units">
      <button type="button" data-unit="ft" aria-pressed="true">ft</button>
      <button type="button" data-unit="m" aria-pressed="false">m</button>
    </div>
    <div class="cal-house" hidden>
      <div class="cal-house-title">House</div>
      ${HOUSE_FIELDS.map(([k, l]) => `<label>${l} <input type="number" step="0.1" data-house="${k}" /></label>`).join('')}
      <div class="cal-house-note" hidden>House dimensions are estimates until you set them.</div>
      <div class="cal-house-msg" hidden></div>
    </div>
    <label>Default height reference
      <select class="cal-href">${HEIGHT_REFS.map(([v, l]) => `<option value="${v}">${l}</option>`).join('')}</select>
    </label>
    <div class="cal-warn" hidden></div>
    <div class="cal-dirty" hidden>Unapplied changes — Apply to commit, Revert to discard.</div>
    <div class="cal-actions">
      <button type="button" class="cal-apply">Apply</button>
      <button type="button" class="cal-revert">Revert</button>
      <button type="button" class="cal-undo" title="Undo the last Apply">Undo</button>
      <button type="button" class="cal-redo" title="Redo the undone Apply">Redo</button>
      <button type="button" class="cal-clear">Clear calibration</button>
      <button type="button" class="cal-close">Close</button>
    </div>`;

  const $ = (sel) => panelEl.querySelector(sel);
  const wIn = $('.cal-w'), hIn = $('.cal-h'), dIn = $('.cal-d');
  const warnEl = $('.cal-warn');
  const FIELDS = [[wIn, 'width_ft'], [hIn, 'height_ft'], [dIn, 'depth_ft']];

  let units = 'ft';
  // What the dimension fields currently show (exact feet + text), so an
  // untouched field never re-rounds a value and a unit toggle keeps it exact.
  let prefill = { width_ft: null, height_ft: null, depth_ft: null };
  let shown = { width_ft: '', height_ft: '', depth_ft: '' };
  let persistedWarning = null;   // cross-check warning that survives reopen until the next Apply

  function draft() { return getDraftState?.()?.draft || null; }

  // ── units (panel-local display; the draft stores feet) ──
  function setUnits(next, convert = true) {
    const prev = units;
    units = next === 'm' ? 'm' : 'ft';
    for (const b of panelEl.querySelectorAll('.cal-units [data-unit]')) {
      b.setAttribute('aria-pressed', b.dataset.unit === units ? 'true' : 'false');
    }
    if (convert && prev !== units) {
      for (const [el, key] of FIELDS) {
        const untouched = el.value === shown[key] && prefill[key] != null;
        const v = parseFloat(el.value);
        if (untouched) el.value = toDisplay(prefill[key], units).toFixed(1);
        else if (Number.isFinite(v)) el.value = toDisplay(fromDisplay(v, prev), units).toFixed(1);
        if (untouched) shown[key] = el.value;
      }
      fillHouse();                             // house values are exact feet in the draft: just re-show them
    }
  }
  panelEl.querySelector('.cal-units').addEventListener('click', (e) => {
    const b = e.target.closest('[data-unit]');
    if (b) setUnits(b.dataset.unit);
  });

  function fillDims() {
    const d = draft();
    const dims = d?.dims || panelDims(getState().calibration, typeof getVenue === 'function' ? getVenue() : null);
    prefill = { width_ft: dims.width_ft, height_ft: dims.height_ft, depth_ft: dims.depth_ft };
    for (const [el, key] of FIELDS) {
      if (document.activeElement === el) continue;      // do not clobber a field being typed in
      const ft = prefill[key];
      el.value = ft != null ? toDisplay(ft, units).toFixed(1) : '';
      shown[key] = el.value;
    }
  }
  function readDims() {
    return {
      width_ft: readDim(wIn.value, shown.width_ft, prefill.width_ft, units),
      height_ft: readDim(hIn.value, shown.height_ft, prefill.height_ft, units),
      depth_ft: readDim(dIn.value, shown.depth_ft, prefill.depth_ft, units),
    };
  }

  // Typing a dimension changes the solve, never the box: it is a draft edit.
  for (const [el, key] of FIELDS) {
    el.addEventListener('change', () => {
      const v = readDims()[key];
      if (!(v > 0)) { fillDims(); return; }
      dispatch?.({ type: 'edit', patch: { dims: { [key]: v } } });
      render();
    });
  }
  // ── house fields: typed in the current unit, clamped through clampHouse ──
  const houseEl = $('.cal-house');
  const houseNoteEl = $('.cal-house-note'), houseMsgEl = $('.cal-house-msg');
  const houseInputs = HOUSE_FIELDS.map(([k, , rule]) => [k, houseEl.querySelector(`input[data-house="${k}"]`), rule]);
  const houseShown = {};
  function fillHouse() {
    const h = draft()?.house;
    const ok = !!h && Number.isFinite(h.left_wall_ft);
    houseEl.hidden = !ok;
    if (!ok) return;
    for (const [k, el] of houseInputs) {
      if (document.activeElement === el) continue;
      el.value = Number.isFinite(h[k]) ? toDisplay(h[k], units).toFixed(1) : '';
      houseShown[k] = el.value;
    }
    houseNoteEl.hidden = !h.estimated;
  }
  let rejectTimer = 0;
  function rejectHouse(el, key, msg) {
    el.value = houseShown[key] ?? '';
    el.classList.remove('is-rejected');
    void el.offsetWidth;                     // restart the flash
    el.classList.add('is-rejected');
    if (rejectTimer) clearTimeout(rejectTimer);
    rejectTimer = setTimeout(() => { rejectTimer = 0; el.classList.remove('is-rejected'); }, REJECT_FLASH_MS);
    houseMsgEl.hidden = false;
    houseMsgEl.textContent = msg;
  }
  for (const [key, el, rule] of houseInputs) {
    el.addEventListener('change', () => {
      const d = draft();
      if (!d?.house || !d.dims) return;
      const v = parseFloat(el.value);
      if (!Number.isFinite(v)) { rejectHouse(el, key, 'Enter a number'); return; }
      const ft = fromDisplay(v, units);
      const clamped = clampHouse(d.house, d.dims, { [key]: ft });
      if (Math.abs(clamped[key] - ft) > 1e-6) { rejectHouse(el, key, rule); return; }
      houseMsgEl.hidden = true;
      dispatch?.({ type: 'edit', patch: { house: clamped } });
      render();
    });
  }

  let defaultHeightRef = 'deck';
  $('.cal-href').addEventListener('change', (e) => {
    defaultHeightRef = e.target.value;
    dispatch?.({ type: 'edit', patch: { dims: {} } });   // no-op edit: marks the draft dirty; the value rides along on Apply
    render();
  });

  // ── messages ──
  function showWarnings(list) {
    warnEl.hidden = list.length === 0;
    warnEl.innerHTML = list.map((m) => `<div>${escapeHtml(m)}</div>`).join('');
  }
  let checkSeq = 0;
  function crossCheck(rec) {
    if (typeof onCrossCheck !== 'function') return;
    const seq = ++checkSeq;
    let p;
    try { p = Promise.resolve(onCrossCheck(rec)); } catch { return; }
    p.then((res) => {
      if (seq !== checkSeq) return;
      if (!res || !res.available || !(res.median_error_pct > CROSS_CHECK_WARN_PCT)) return;
      persistedWarning = crossCheckMessage(res.median_error_pct);
      render();
    }).catch(() => {});
  }

  /** The record Apply would commit: the draft's marks and dims, depth fit from the real sampler. */
  function recordFromDraft(d) {
    const rec = {
      version: 1, units, width_ft: d.dims.width_ft, height_ft: d.dims.height_ft, depth_ft: d.dims.depth_ft,
      marks: JSON.parse(JSON.stringify(d.marks)),
      depth_fit: null, depth_check: null,
    };
    return rec;
  }

  // ── render: numbers, warnings, button states ──
  function render() {
    const S = getDraftState?.() || null;
    const d = S?.draft || null;
    const st = getState();
    fillDims();
    fillHouse();
    if (!S?.dirty) houseMsgEl.hidden = true;   // a rejection message lives only while the draft is being edited
    const venue = typeof getVenue === 'function' ? getVenue() : null;
    const noteEl = $('.cal-note');
    noteEl.hidden = !venue;
    noteEl.textContent = venue ? `Dimensions belong to venue ${venue.name} (shared by its scenes)` : '';
    if (venue?.default_height_ref && !S?.dirty) defaultHeightRef = venue.default_height_ref;
    $('.cal-href').value = defaultHeightRef;

    const cam = d?.marks ? getPreviewCamera?.() : null;
    let fit;
    if (cam && d && typeof sampleDepth === 'function') fit = fitDepth(recordFromDraft(d), cam, sampleDepth);
    const warns = draftWarnings(cam, fit === undefined ? undefined : fit);
    if (!S?.dirty && persistedWarning) warns.push(persistedWarning);
    else if (!S?.dirty && st.calibration?.depth_check?.warned && st.calibration.depth_check.median_error_pct > CROSS_CHECK_WARN_PCT) {
      warns.push(crossCheckMessage(st.calibration.depth_check.median_error_pct));
    }
    showWarnings(warns);

    const dirty = !!S?.dirty;
    $('.cal-dirty').hidden = !dirty;
    const apply = $('.cal-apply');
    apply.classList.toggle('is-dirty', dirty);
    apply.disabled = !(d?.marks && cam);
    $('.cal-revert').disabled = !dirty;
    $('.cal-undo').disabled = !(S?.history?.length);
    $('.cal-redo').disabled = !S?.redo;
    $('.cal-clear').disabled = !st.calibration;
  }

  // ── actions ──
  async function apply() {
    const d = draft();
    if (!d?.marks) return;
    const rec = recordFromDraft(d);
    const v = validateMarks(rec);
    if (!v.ok) { showWarnings(v.errors); return; }
    const cam = getPreviewCamera?.();
    if (!cam) return;
    if (typeof sampleDepth === 'function') rec.depth_fit = fitDepth(rec, cam, sampleDepth);
    persistedWarning = null;
    checkSeq++;
    const venuePatch = { dims: { ...d.dims }, house: d.house ? { ...d.house } : null, default_height_ref: defaultHeightRef };
    await onApplyCommit?.(rec, venuePatch);
    crossCheck(rec);
    render();
  }
  function revert() { dispatch?.({ type: 'revert' }); render(); }
  async function undo() {
    const S = getDraftState?.();
    if (!S?.history?.length) return;
    await onUndoRestore?.(S.history[S.history.length - 1]);
    render();
  }
  async function redo() {
    const S = getDraftState?.();
    if (!S?.redo) return;
    await onRedoRestore?.(S.redo);
    render();
  }
  async function clear() {
    checkSeq++; persistedWarning = null;
    await onClearCommit?.();
    render();
  }
  function open() {
    const st = getState();
    setUnits(st.calibration?.units || getUnits?.() || st.units || 'ft', false);
    render();
    panelEl.hidden = false;
    onToggle?.(true);
  }
  function close() {
    panelEl.hidden = true;
    onToggle?.(false);
  }
  $('.cal-apply').addEventListener('click', apply);
  $('.cal-revert').addEventListener('click', revert);
  $('.cal-undo').addEventListener('click', undo);
  $('.cal-redo').addEventListener('click', redo);
  $('.cal-clear').addEventListener('click', clear);
  $('.cal-close').addEventListener('click', close);

  return { open, close, render, isOpen: () => !panelEl.hidden, apply, undo, redo, revert, clear };
}
