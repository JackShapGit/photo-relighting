// 2D photo-pane ruler (Spec 3). Two layers inside #canvas-wrap:
//   #measure-overlay  an SVG that takes NO pointer events and draws the
//                     committed spans plus the in-progress rubber band. It
//                     sits above #handles so labels stay readable over a
//                     light handle without blocking it.
//   #measure-capture  a full-bleed div that captures clicks ONLY while the
//                     tool is armed, so the ruler never fights the light
//                     handles, the cube handles or orbit.
// Picking: sample the scene's depth PNG at the click, turn (u, v, depth) into
// an engine point, then into world feet. Per spec decision 4 an endpoint may
// land on the depth surface, and per decision 5 the reading is not marked.
import { worldToPixel, engineToWorld, effectiveFit } from './metric/calibration.js';
import { distanceFt } from './metric/measure.js';
import { formatLength } from './metric/units.js';
import { uvDepthToLight } from './3d/coords.js';

const SVG_NS = 'http://www.w3.org/2000/svg';

export function mountMeasure2D({ svgEl, captureEl, tool, getState, getSampler } = {}) {
  if (!svgEl || !captureEl || !tool) return null;
  let hover = null;                       // cursor in world feet, for the rubber band

  function worldAt(e) {
    const r = captureEl.getBoundingClientRect();
    if (!r.width || !r.height) return null;
    const u = (e.clientX - r.left) / r.width;
    const v = (e.clientY - r.top) / r.height;
    const sampler = getSampler?.();
    const st = getState();
    if (!sampler || !st?.calibration?.camera) return null;
    const d = sampler.sample(u, v);
    if (!Number.isFinite(d)) return null;
    const eng = uvDepthToLight(u, v, d);
    return engineToWorld(eng, st.calibration.camera, effectiveFit(st.calibration));
  }

  captureEl.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    const p = worldAt(e);
    if (!p) return;                       // sample failed: ignore, hold the phase
    tool.addPoint(p);
  });

  captureEl.addEventListener('pointermove', (e) => {
    if (tool.phase() !== 'awaitingB') { if (hover) { hover = null; render(); } return; }
    hover = worldAt(e);
    render();
  });

  function setArmed(on) {
    captureEl.toggleAttribute('hidden', !on);
    if (!on) hover = null;
    render();
  }

  function render() {
    const st = getState();
    const ms = tool.measurements();
    const pending = tool.pendingA();
    const on = !!(st?.calibration?.camera) && (ms.length > 0 || !!pending);
    svgEl.toggleAttribute('hidden', !on);   // SVG has no `hidden` IDL property
    while (svgEl.firstChild) svgEl.removeChild(svgEl.firstChild);
    if (!on) return;
    const W = svgEl.clientWidth || svgEl.parentElement?.clientWidth || 0;
    const H = svgEl.clientHeight || svgEl.parentElement?.clientHeight || 0;
    if (!W || !H) return;
    svgEl.setAttribute('viewBox', `0 0 ${W} ${H}`);
    const cam = st.calibration.camera;
    const units = st.units || 'ft';
    const px = (p) => { const r = worldToPixel(p, cam); return r ? [r[0] * W, r[1] * H] : null; };

    const draw = (a, b, cls) => {
      const pa = px(a), pb = px(b);
      if (!pa || !pb) return;                       // behind the camera: skip
      const line = document.createElementNS(SVG_NS, 'line');
      line.setAttribute('x1', pa[0].toFixed(1)); line.setAttribute('y1', pa[1].toFixed(1));
      line.setAttribute('x2', pb[0].toFixed(1)); line.setAttribute('y2', pb[1].toFixed(1));
      line.setAttribute('class', cls);
      svgEl.appendChild(line);
      const text = document.createElementNS(SVG_NS, 'text');
      text.setAttribute('x', ((pa[0] + pb[0]) / 2).toFixed(1));
      text.setAttribute('y', ((pa[1] + pb[1]) / 2).toFixed(1));
      text.setAttribute('class', 'measure-label');
      text.textContent = formatLength(distanceFt(a, b), units);
      svgEl.appendChild(text);
    };

    for (const m of ms) draw(m.a, m.b, 'measure-line');
    if (pending && hover) draw(pending, hover, 'measure-line is-pending');
  }

  return { render, setArmed };
}
