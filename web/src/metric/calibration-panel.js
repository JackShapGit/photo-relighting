// Stage calibration panel: stage dimensions + five-click marking on the photo.
//
// The panel and the marking overlay live inside #canvas-wrap so marker
// positions map to photo (u, v) exactly the way #placement-overlay does:
// u = (clientX - rect.left) / rect.width, v likewise (see placement-pane-2d.js).
import { createMarking, MARK_ORDER, MARK_LABELS } from './marking.js';
import { validateMarks, solveCamera, fitDepth } from './calibration.js';
import { toDisplay, fromDisplay } from './units.js';

const SHORT = { lipL: 'lip L', lipR: 'lip R', top: 'top', backL: 'back L', backR: 'back R' };
const DONE_PROMPT = 'All five marks set. Adjust by dragging, then Apply.';

const isTextField = (el) => el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT');

/**
 * @param {object} o
 * @param {HTMLElement} o.panelEl       #calib-panel (inside #canvas-wrap)
 * @param {HTMLElement} o.overlayEl     #calib-overlay (inside #canvas-wrap, inset 0)
 * @param {HTMLElement} o.canvasWrapEl  #canvas-wrap (for the photo rect)
 * @param {() => object} o.getState     returns main.js state (calibration, units, width, height)
 * @param {(u:number,v:number)=>number} o.sampleDepth  depth at a photo coordinate (NaN if unknown)
 * @param {(record:object)=>void} o.onApply
 * @param {()=>void} o.onClear
 * @param {(record:object)=>void} [o.onCrossCheck]  reserved for the Task 13 server cross-check; no-op today
 */
export function mountCalibrationPanel({
  panelEl, overlayEl, canvasWrapEl, getState, sampleDepth, onApply, onClear, onCrossCheck = null,
}) {
  if (!panelEl || !overlayEl) return null;

  panelEl.innerHTML = `
    <h3>Stage calibration</h3>
    <label>Width <input class="cal-w" type="number" step="0.1" min="0" /></label>
    <label>Height <input class="cal-h" type="number" step="0.1" min="0" /></label>
    <label>Depth <input class="cal-d" type="number" step="0.1" min="0" /></label>
    <div class="view-mode cal-units" role="group" aria-label="Calibration units">
      <button type="button" data-unit="ft" aria-pressed="true">ft</button>
      <button type="button" data-unit="m" aria-pressed="false">m</button>
    </div>
    <button type="button" class="cal-mark">Mark on photo</button>
    <div class="cal-prompt" hidden></div>
    <ul class="cal-errors"></ul>
    <div class="cal-warn" hidden></div>
    <div class="cal-actions">
      <button type="button" class="cal-apply">Apply</button>
      <button type="button" class="cal-clear">Clear calibration</button>
      <button type="button" class="cal-close">Close</button>
    </div>`;

  const $ = (sel) => panelEl.querySelector(sel);
  const wIn = $('.cal-w'), hIn = $('.cal-h'), dIn = $('.cal-d');
  const promptEl = $('.cal-prompt'), errorsEl = $('.cal-errors'), warnEl = $('.cal-warn');
  const markBtn = $('.cal-mark');

  let units = 'ft';
  let marking = createMarking({});
  let markingActive = false;
  const markerEls = new Map();   // key -> div.cal-marker

  // ── units (panel-local display; the record stores feet) ──
  function setUnits(next, convert = true) {
    const prev = units;
    units = next === 'm' ? 'm' : 'ft';
    for (const b of panelEl.querySelectorAll('.cal-units [data-unit]')) {
      b.setAttribute('aria-pressed', b.dataset.unit === units ? 'true' : 'false');
    }
    if (convert && prev !== units) {
      for (const el of [wIn, hIn, dIn]) {
        const v = parseFloat(el.value);
        if (Number.isFinite(v)) el.value = toDisplay(fromDisplay(v, prev), units).toFixed(1);
      }
    }
  }
  panelEl.querySelector('.cal-units').addEventListener('click', (e) => {
    const b = e.target.closest('[data-unit]');
    if (b) setUnits(b.dataset.unit);
  });

  // ── messages ──
  function showErrors(list) {
    errorsEl.innerHTML = list.map((m) => `<li>${escapeHtml(m)}</li>`).join('');
  }
  function showWarnings(list) {
    warnEl.hidden = list.length === 0;
    warnEl.innerHTML = list.map((m) => `<div>${escapeHtml(m)}</div>`).join('');
  }
  function updatePrompt() {
    if (!markingActive) { promptEl.hidden = true; return; }
    promptEl.hidden = false;
    promptEl.textContent = marking.done ? DONE_PROMPT : MARK_LABELS[marking.current];
  }

  // ── markers ──
  function uvFromEvent(e) {
    const r = overlayEl.getBoundingClientRect();
    const u = (e.clientX - r.left) / r.width;
    const v = (e.clientY - r.top) / r.height;
    return [Math.min(1, Math.max(0, u)), Math.min(1, Math.max(0, v))];
  }
  function placeMarker(el, [u, v]) {
    el.style.left = `${u * 100}%`;
    el.style.top = `${v * 100}%`;
  }
  function addMarker(key, uv) {
    let el = markerEls.get(key);
    if (!el) {
      el = document.createElement('div');
      el.className = 'cal-marker';
      el.dataset.key = SHORT[key] || key;
      el.dataset.mark = key;
      el.title = MARK_LABELS[key];
      el.addEventListener('pointerdown', (e) => startDrag(e, key, el));
      overlayEl.appendChild(el);
      markerEls.set(key, el);
    }
    placeMarker(el, uv);
  }
  function removeMarker(key) {
    const el = markerEls.get(key);
    if (el) { el.remove(); markerEls.delete(key); }
  }
  function renderMarkers() {
    for (const key of [...markerEls.keys()]) if (!(key in marking.marks)) removeMarker(key);
    for (const key of MARK_ORDER) if (marking.marks[key]) addMarker(key, marking.marks[key]);
  }
  function startDrag(e, key, el) {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();            // the overlay must not treat this as a new mark
    el.setPointerCapture?.(e.pointerId);
    el.classList.add('is-dragging');
    const move = (ev) => {
      const uv = uvFromEvent(ev);
      marking.marks[key] = uv;
      placeMarker(el, uv);
    };
    const up = (ev) => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', up);
      el.classList.remove('is-dragging');
      if (el.hasPointerCapture?.(ev.pointerId)) el.releasePointerCapture(ev.pointerId);
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
  }

  // ── marking mode ──
  function onOverlayPointerDown(e) {
    if (e.button !== 0 || e.target !== overlayEl) return;
    if (marking.done) return;
    e.preventDefault();
    const uv = uvFromEvent(e);
    const key = marking.next(uv[0], uv[1]);
    if (key) addMarker(key, uv);
    updatePrompt();
  }
  function onKeyDown(e) {
    if (!markingActive || isTextField(e.target)) return;
    if (e.key !== 'Escape' && e.key !== 'Backspace') return;
    // Capture-phase listener: swallow the key entirely so the tree's
    // Delete/Backspace shortcut (which deletes the selected light behind a
    // confirm dialog) and the placement/3D Escape handlers never see it.
    e.preventDefault();
    e.stopImmediatePropagation();
    if (e.key === 'Escape') { marking.cancel(); renderMarkers(); exitMarking(); }
    else { marking.undo(); renderMarkers(); updatePrompt(); }
  }
  function startMarking() {
    markingActive = true;
    overlayEl.hidden = false;
    overlayEl.classList.add('is-marking');
    renderMarkers();
    updatePrompt();
    markBtn.textContent = 'Done marking';
    document.addEventListener('keydown', onKeyDown, true);
  }
  function exitMarking() {
    markingActive = false;
    overlayEl.hidden = true;
    overlayEl.classList.remove('is-marking');
    markBtn.textContent = 'Mark on photo';
    updatePrompt();
    document.removeEventListener('keydown', onKeyDown, true);
  }
  overlayEl.addEventListener('pointerdown', onOverlayPointerDown);
  markBtn.addEventListener('click', () => (markingActive ? exitMarking() : startMarking()));

  // ── open / close / apply / clear ──
  function open() {
    const st = getState();
    const rec = st.calibration;
    setUnits(rec?.units || st.units || 'ft', false);
    const fill = (el, ft) => { el.value = ft != null ? toDisplay(ft, units).toFixed(1) : ''; };
    fill(wIn, rec?.width_ft); fill(hIn, rec?.height_ft); fill(dIn, rec?.depth_ft);
    marking = createMarking(rec?.marks || {});
    showErrors([]); showWarnings([]);
    panelEl.hidden = false;
    // Existing marks are shown right away so they can be adjusted.
    if (Object.keys(marking.marks).length) startMarking(); else exitMarking();
  }
  function close() {
    exitMarking();
    panelEl.hidden = true;
  }
  function readDims() {
    const num = (el) => { const v = parseFloat(el.value); return Number.isFinite(v) ? fromDisplay(v, units) : NaN; };
    return { width_ft: num(wIn), height_ft: num(hIn), depth_ft: num(dIn) };
  }
  function apply() {
    const dims = readDims();
    const rec = {
      version: 1, units, ...dims,
      marks: JSON.parse(JSON.stringify(marking.marks)),
      depth_fit: null, depth_check: null,
    };
    const v = validateMarks(rec);
    if (!v.ok) { showErrors(v.errors); showWarnings([]); return; }
    showErrors([]);
    const { width, height } = getState();
    const cam = solveCamera(rec, height / width);
    rec.depth_fit = fitDepth(rec, cam, sampleDepth);
    const warns = [];
    if (cam.height_check_pct > 10) {
      warns.push(`Photo implies an opening height ${cam.height_check_pct.toFixed(0)}% different from what you entered; check the top mark.`);
    }
    if (cam.perspective_ratio > 0.9) {
      warns.push('Stage depth is small relative to the camera distance, so upstage distances are sensitive to the back-line marks. Place them carefully.');
    }
    if (!rec.depth_fit) {
      warns.push('Depth map has no usable relief between lip and back line; upstage distances fall back to a linear estimate.');
    }
    showWarnings(warns);
    exitMarking();
    onApply(rec);
    if (typeof onCrossCheck === 'function') onCrossCheck(rec);   // Task 13 hook (no-op today)
  }
  function clear() {
    marking = createMarking({});
    renderMarkers();
    showErrors([]); showWarnings([]);
    close();
    onClear();
  }
  $('.cal-apply').addEventListener('click', apply);
  $('.cal-clear').addEventListener('click', clear);
  $('.cal-close').addEventListener('click', close);

  return { open, close, isMarking: () => markingActive, get marking() { return marking; } };
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
