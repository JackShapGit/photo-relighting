// 2D "Areas" overlay (Spec 2 §Grid overlay): the venue's acting-area cells
// projected through the calibration onto the photo as deck-level polygons
// with their labels, in an SVG that sits under the light handles and never
// takes pointer events. Shown only when the header checkbox is on and the
// scene is in rig mode (calibrated with a venue).
import { worldToPixel } from './metric/calibration.js';
import { areaLabels, areaCenter } from './rig/geometry.js';
import { cellCorners } from './rig/areas.js';
import { rigMode } from './rig/tree-mirror.js';

export const SHOW_AREAS_KEY = 'photo-relight:show-areas';
const SVG_NS = 'http://www.w3.org/2000/svg';

/**
 * @param {object}      opts
 * @param {SVGElement}  opts.overlayEl   #areas-overlay inside #canvas-wrap
 * @param {Function}    opts.getState    () => state (calibration, venue, units)
 * @param {HTMLInputElement} [opts.toggleEl]  #show-areas checkbox
 * @param {Storage}     [opts.storage]   defaults to localStorage
 */
export function mountAreasOverlay({ overlayEl, getState, toggleEl, storage } = {}) {
  if (!overlayEl) return null;
  const store = storage !== undefined ? storage : (typeof localStorage !== 'undefined' ? localStorage : null);

  if (toggleEl) {
    try { toggleEl.checked = store?.getItem(SHOW_AREAS_KEY) === '1'; } catch {}
    toggleEl.addEventListener('change', () => {
      try { store?.setItem(SHOW_AREAS_KEY, toggleEl.checked ? '1' : '0'); } catch {}
      render();
    });
  }

  function isOn() {
    return !!(toggleEl ? toggleEl.checked : true) && rigMode(getState());
  }

  function render() {
    const st = getState();
    const on = isOn();
    overlayEl.toggleAttribute('hidden', !on);   // SVG elements have no `hidden` IDL property
    while (overlayEl.firstChild) overlayEl.removeChild(overlayEl.firstChild);
    if (!on) return;
    const cam = st.calibration.camera, venue = st.venue;
    const W = overlayEl.clientWidth || overlayEl.parentElement?.clientWidth || 0;
    const H = overlayEl.clientHeight || overlayEl.parentElement?.clientHeight || 0;
    if (!W || !H) return;
    overlayEl.setAttribute('viewBox', `0 0 ${W} ${H}`);
    const px = (p) => { const r = worldToPixel(p, cam); return r ? [r[0] * W, r[1] * H] : null; };
    for (const label of areaLabels(venue.grid || { rows: 3, cols: 3 })) {
      const corners = cellCorners(venue, label);
      if (!corners) continue;
      const pts = corners.map(px);
      if (pts.some((p) => !p)) continue;            // a corner behind the camera: skip the cell
      const poly = document.createElementNS(SVG_NS, 'polygon');
      poly.setAttribute('points', pts.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' '));
      poly.setAttribute('class', 'area-cell');
      poly.dataset.label = label;
      overlayEl.appendChild(poly);
      const c = px([areaCenter(venue, label)[0], 0, areaCenter(venue, label)[2]]);
      if (!c) continue;
      const text = document.createElementNS(SVG_NS, 'text');
      text.setAttribute('x', c[0].toFixed(1));
      text.setAttribute('y', c[1].toFixed(1));
      text.setAttribute('class', 'area-label');
      text.textContent = label;
      overlayEl.appendChild(text);
    }
  }

  return { render, isOn };
}
