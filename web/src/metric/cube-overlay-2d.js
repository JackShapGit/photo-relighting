// Calibration cube on the photo (calibration cube spec): the stage box
// projected through the draft's preview camera as an SVG under the light
// handles — twelve edges, five draggable handles (the lip corners, the back
// corners, and a bar on the front-top edge), and three editable edge labels
// (width, height, depth). The SVG itself takes no pointer events; only the
// handles and labels do, so the 2D light handles keep working. The house
// box group is created here and filled by Task 4.
//
// The elements are created once and updated on every render, so a handle
// keeps its pointer capture while a drag re-renders the box under it.
import { worldToPixel } from './calibration.js';
import { stageCorners, handlePoints } from './cube-geometry.js';
import { formatLength, toDisplay } from './units.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
const HANDLE_R = 7;                 // 14 px handles
const CLAMP_FLASH_MS = 300;
const TOP_BAR = { w: 26, h: 8 };
const HANDLE_KEYS = ['lipL', 'lipR', 'top', 'backL', 'backR'];
const HANDLE_TITLES = {
  lipL: 'Lip, audience left', lipR: 'Lip, audience right', top: 'Top of the opening',
  backL: 'Back line, audience left', backR: 'Back line, audience right',
};
// Edges as corner pairs; the back rectangle and the connectors are drawn lighter.
const EDGES = [
  ['fbl', 'fbr', 'front'], ['fbr', 'ftr', 'front'], ['ftr', 'ftl', 'front'], ['ftl', 'fbl', 'front'],
  ['bbl', 'bbr', 'back'], ['bbr', 'btr', 'back'], ['btr', 'btl', 'back'], ['btl', 'bbl', 'back'],
  ['fbl', 'bbl', 'side'], ['fbr', 'bbr', 'side'], ['ftl', 'btl', 'side'], ['ftr', 'btr', 'side'],
];
// Edge labels: which edge they sit on, which dimension they show.
const LABELS = [
  { field: 'width_ft', a: 'fbl', b: 'fbr', dx: 0, dy: 16 },
  { field: 'height_ft', a: 'fbl', b: 'ftl', dx: -12, dy: 0 },
  { field: 'depth_ft', a: 'fbl', b: 'bbl', dx: -12, dy: -6 },
];

const svgEl = (tag, cls) => {
  const e = document.createElementNS(SVG_NS, tag);
  if (cls) e.setAttribute('class', cls);
  return e;
};

/**
 * @param {object}   o
 * @param {SVGElement}  o.overlayEl        #cube-overlay inside #canvas-wrap
 * @param {HTMLElement} o.canvasWrapEl     #canvas-wrap (size + label input host)
 * @param {Function} o.getDraft            () => { marks, dims, house } | null
 * @param {Function} o.getPreviewCamera    () => CameraModel | null
 * @param {Function} o.getDims             () => { width_ft, height_ft, depth_ft } | null
 * @param {Function} o.getHouse            () => house | null            (Task 4)
 * @param {Function} o.getUnits            () => 'ft' | 'm'
 * @param {Function} o.isShown             () => { stage: boolean, house: boolean }
 * @param {Function} o.isDirty             () => boolean
 * @param {Function} o.onDrag              (kind, key, [u, v]) => boolean|void   (rAF-throttled while dragging;
 *                                          a truthy return means the drag was clamped and the handle flashes)
 * @param {Function} o.onLabelEdit         (kind, field, text) => void
 */
export function mountCubeOverlay({
  overlayEl, canvasWrapEl, getDraft, getPreviewCamera, getDims, getHouse, getUnits, isShown, isDirty, onDrag, onLabelEdit,
} = {}) {
  if (!overlayEl) return null;
  const stageG = svgEl('g', 'cube-stage');
  const houseG = svgEl('g', 'cube-house');
  const edgesG = svgEl('g', 'cube-edges');
  const labelsG = svgEl('g', 'cube-labels');
  const handlesG = svgEl('g', 'cube-handles');
  stageG.append(edgesG, labelsG, handlesG);
  overlayEl.append(houseG, stageG);

  const edgeEls = EDGES.map(([, , kind]) => {
    const l = svgEl('line', `cube-edge is-${kind}`);
    edgesG.appendChild(l);
    return l;
  });
  const labelEls = LABELS.map((spec) => {
    const t = svgEl('text', 'cube-label');
    t.dataset.field = spec.field;
    t.addEventListener('click', (e) => { e.stopPropagation(); startLabelEdit(spec.field, t); });
    labelsG.appendChild(t);
    return t;
  });
  const handleEls = new Map();
  for (const key of HANDLE_KEYS) {
    const h = key === 'top' ? svgEl('rect', 'cube-handle cube-handle-bar') : svgEl('circle', 'cube-handle');
    if (key === 'top') { h.setAttribute('width', TOP_BAR.w); h.setAttribute('height', TOP_BAR.h); h.setAttribute('rx', 3); }
    else h.setAttribute('r', HANDLE_R);
    h.dataset.key = key;
    const title = svgEl('title'); title.textContent = HANDLE_TITLES[key]; h.appendChild(title);
    bindDrag(h, key);
    handlesG.appendChild(h);
    handleEls.set(key, h);
  }

  let dragging = null;     // { key, pointerId }
  let pendingUv = null;
  let rafId = 0;
  let clampTimer = 0;
  const raf = typeof requestAnimationFrame === 'function' ? requestAnimationFrame : null;

  function uvFromEvent(e) {
    const r = overlayEl.getBoundingClientRect();
    if (!r.width || !r.height) return null;
    return [(e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height];
  }
  function flushDrag() {
    rafId = 0;
    if (!dragging || !pendingUv) return;
    const uv = pendingUv; pendingUv = null;
    const clamped = onDrag?.('stage', dragging.key, uv);
    if (clamped) flashClamped(handleEls.get(dragging.key));
  }
  function flashClamped(el) {
    if (!el) return;
    el.classList.add('is-clamped');
    if (clampTimer) clearTimeout(clampTimer);
    clampTimer = setTimeout(() => { clampTimer = 0; el.classList.remove('is-clamped'); }, CLAMP_FLASH_MS);
  }
  function bindDrag(el, key) {
    el.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault(); e.stopPropagation();
      dragging = { key, pointerId: e.pointerId };
      el.setPointerCapture?.(e.pointerId);
      el.classList.add('is-dragging');
    });
    el.addEventListener('pointermove', (e) => {
      if (!dragging || dragging.key !== key) return;
      pendingUv = uvFromEvent(e);
      if (raf) { if (!rafId) rafId = raf(flushDrag); } else flushDrag();
    });
    const end = (e) => {
      if (!dragging || dragging.key !== key) return;
      pendingUv = uvFromEvent(e) || pendingUv;
      if (rafId && typeof cancelAnimationFrame === 'function') { cancelAnimationFrame(rafId); rafId = 0; }
      flushDrag();
      el.classList.remove('is-dragging');
      if (el.hasPointerCapture?.(e.pointerId)) el.releasePointerCapture(e.pointerId);
      dragging = null;
    };
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);
  }

  // ── inline label edit ──
  let labelInput = null;
  function startLabelEdit(field, textEl) {
    finishLabelEdit(false);
    const dims = getDims?.();
    if (!dims) return;
    const units = getUnits?.() || 'ft';
    const input = document.createElement('input');
    input.className = 'cube-label-input';
    input.type = 'text'; input.inputMode = 'decimal';
    input.value = toDisplay(dims[field], units).toFixed(1);
    input.dataset.field = field;
    const x = parseFloat(textEl.getAttribute('x')) || 0, y = parseFloat(textEl.getAttribute('y')) || 0;
    input.style.left = `${x}px`; input.style.top = `${y}px`;
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); finishLabelEdit(true); }
      else if (e.key === 'Escape') { e.preventDefault(); finishLabelEdit(false); }
      e.stopPropagation();
    });
    input.addEventListener('blur', () => finishLabelEdit(false));
    canvasWrapEl.appendChild(input);
    labelInput = input;
    input.focus(); input.select();
  }
  function finishLabelEdit(commit) {
    const input = labelInput;
    if (!input) return;
    labelInput = null;
    const { field } = input.dataset; const text = input.value;
    input.remove();
    if (commit) onLabelEdit?.('stage', field, text);
  }

  function setLine(el, a, b, dirty) {
    if (!a || !b) { el.setAttribute('visibility', 'hidden'); return; }
    el.removeAttribute('visibility');
    el.setAttribute('x1', a[0].toFixed(1)); el.setAttribute('y1', a[1].toFixed(1));
    el.setAttribute('x2', b[0].toFixed(1)); el.setAttribute('y2', b[1].toFixed(1));
    el.classList.toggle('is-dirty', !!dirty);
  }

  function render() {
    const shown = isShown?.() || { stage: true, house: false };
    const cam = getPreviewCamera?.();
    const dims = getDims?.();
    const W = canvasWrapEl?.clientWidth || 0, H = canvasWrapEl?.clientHeight || 0;
    const canDraw = !!(cam && dims && W && H);
    overlayEl.toggleAttribute('hidden', !canDraw || (!shown.stage && !shown.house));
    stageG.toggleAttribute('hidden', !shown.stage || !canDraw);
    houseG.toggleAttribute('hidden', !shown.house || !canDraw);
    if (!canDraw) return;
    overlayEl.setAttribute('viewBox', `0 0 ${W} ${H}`);
    const px = (p) => { const r = worldToPixel(p, cam); return r ? [r[0] * W, r[1] * H] : null; };
    const corners = stageCorners(dims);
    const P = Object.fromEntries(Object.entries(corners).map(([k, p]) => [k, px(p)]));
    const dirty = !!isDirty?.();
    EDGES.forEach(([a, b], i) => setLine(edgeEls[i], P[a], P[b], dirty));

    const hp = handlePoints(cam, dims);
    for (const key of HANDLE_KEYS) {
      const el = handleEls.get(key);
      const p = hp[key];
      if (!p) { el.setAttribute('visibility', 'hidden'); continue; }
      el.removeAttribute('visibility');
      const x = p[0] * W, y = p[1] * H;
      if (key === 'top') { el.setAttribute('x', (x - TOP_BAR.w / 2).toFixed(1)); el.setAttribute('y', (y - TOP_BAR.h / 2).toFixed(1)); }
      else { el.setAttribute('cx', x.toFixed(1)); el.setAttribute('cy', y.toFixed(1)); }
    }

    const units = getUnits?.() || 'ft';
    LABELS.forEach((spec, i) => {
      const el = labelEls[i];
      const a = P[spec.a], b = P[spec.b];
      if (!a || !b) { el.setAttribute('visibility', 'hidden'); return; }
      el.removeAttribute('visibility');
      el.setAttribute('x', ((a[0] + b[0]) / 2 + spec.dx).toFixed(1));
      el.setAttribute('y', ((a[1] + b[1]) / 2 + spec.dy).toFixed(1));
      el.setAttribute('text-anchor', spec.dx < 0 ? 'end' : 'middle');
      el.textContent = formatLength(dims[spec.field], units);
    });
    void getDraft; void getHouse;   // house box: Task 4
  }

  function destroy() {
    finishLabelEdit(false);
    if (clampTimer) { clearTimeout(clampTimer); clampTimer = 0; }
    overlayEl.innerHTML = '';
  }

  return { render, destroy, isDragging: () => !!dragging };
}
