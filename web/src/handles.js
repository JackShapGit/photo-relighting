// Floating handles over the canvas. Each light gets a position-handle (filled
// circle, draggable in X/Y); the currently-selected light gets a second
// "direction-handle" tip (open circle on a tether line) that you drag to
// rotate the light's direction in X/Y. The direction's Z component lives in
// the props panel slider.
//
// Interactions:
//   - Click position-handle (no drag) → select that light in the tree
//   - Drag position-handle              → light.position[0..1]
//   - Mouse-wheel on position-handle    → light.position[2]
//   - Drag direction-handle             → light.direction[0..1] (Z untouched)
//   - Shift-drag on position-handle is no longer used (replaced by direction handle)

import { isTargeted, applyTargeting } from './targeting.js';

const SLOT_VARS = ['--slot-key', '--slot-fill', '--slot-rim'];
const CLICK_THRESHOLD_PX = 3;
const DIR_HANDLE_SCALE_PX = 60;     // distance from position to direction tip per unit direction

function slotColor(i) {
  const v = getComputedStyle(document.documentElement).getPropertyValue(SLOT_VARS[i] || '').trim();
  return v || '#ffffff';
}

export function mountHandles(state, redraw, onSelect) {
  const root = document.getElementById('handles');
  root.innerHTML = '';

  const els = state.lights.map((L, i) => {
    const el = document.createElement('div');
    el.className = 'handle';
    el.style.background = slotColor(i);
    el.dataset.id = L.id;
    el.classList.toggle('handle--reflector', L.type === 'reflector');
    root.appendChild(el);
    return el;
  });

  // One pair of direction widgets — only the selected light has them visible.
  const dirLine = document.createElement('div');
  dirLine.className = 'direction-line';
  const dirHandle = document.createElement('div');
  dirHandle.className = 'direction-handle';
  dirHandle.style.display = 'none';
  dirLine.style.display = 'none';
  root.appendChild(dirLine);
  root.appendChild(dirHandle);

  // Target handle — shown only for the selected, targeted light. Dragging it
  // moves light.target in X/Y (Z unchanged); direction is re-derived live.
  const tgtLine = document.createElement('div');
  tgtLine.className = 'direction-line';        // reuse the tether styling
  const tgtHandle = document.createElement('div');
  tgtHandle.className = 'direction-handle target-handle';
  tgtHandle.style.display = 'none';
  tgtLine.style.display = 'none';
  root.appendChild(tgtLine);
  root.appendChild(tgtHandle);

  function selectedLight() {
    return state.lights.find((L) => L.id === state.selectedId);
  }

  function placeTarget(sel) {
    if (!(sel && isTargeted(sel))) {
      tgtHandle.style.display = 'none';
      tgtLine.style.display = 'none';
      return;
    }
    const r2 = root.getBoundingClientRect();
    const lpx = sel.position[0] * r2.width;
    const lpy = sel.position[1] * r2.height;
    const tpx = sel.target[0] * r2.width;
    const tpy = sel.target[1] * r2.height;
    tgtHandle.style.left = `${tpx}px`;
    tgtHandle.style.top  = `${tpy}px`;
    tgtHandle.style.display = '';
    const tdx = tpx - lpx, tdy = tpy - lpy;
    tgtLine.style.left = `${lpx}px`;
    tgtLine.style.top  = `${lpy}px`;
    tgtLine.style.width = `${Math.hypot(tdx, tdy)}px`;
    tgtLine.style.transform = `rotate(${Math.atan2(tdy, tdx) * 180 / Math.PI}deg)`;
    tgtLine.style.display = '';
  }

  const place = () => {
    const r = root.getBoundingClientRect();
    state.lights.forEach((L, i) => {
      els[i].style.left = `${L.position[0] * r.width}px`;
      els[i].style.top  = `${L.position[1] * r.height}px`;
      els[i].style.display = L.enabled ? '' : 'none';
      els[i].classList.toggle('selected', L.id === state.selectedId);
    });

    // Direction widgets: visible for any selected, enabled light. (Point
    // lights don't actually use direction in the lighting math, but hiding
    // the handle based on type is a more confusing UI than letting the user
    // see it always.)
    const sel = selectedLight();
    const targeted = sel && isTargeted(sel);
    const showDir = sel && sel.enabled && !targeted;
    if (!showDir) {
      dirHandle.style.display = 'none';
      dirLine.style.display = 'none';
      placeTarget(sel);
      return;
    }
    const px = sel.position[0] * r.width;
    const py = sel.position[1] * r.height;
    const tipX = px + sel.direction[0] * DIR_HANDLE_SCALE_PX;
    const tipY = py + sel.direction[1] * DIR_HANDLE_SCALE_PX;
    dirHandle.style.left = `${tipX}px`;
    dirHandle.style.top  = `${tipY}px`;
    dirHandle.style.display = '';
    const dx = tipX - px;
    const dy = tipY - py;
    const len = Math.hypot(dx, dy);
    const angle = Math.atan2(dy, dx) * 180 / Math.PI;
    dirLine.style.left = `${px}px`;
    dirLine.style.top  = `${py}px`;
    dirLine.style.width = `${len}px`;
    dirLine.style.transform = `rotate(${angle}deg)`;
    dirLine.style.display = '';
    placeTarget(sel);
  };
  place();
  window.addEventListener('resize', place);

  // ─── Position-handle drag ──────────────────────────────────────────────
  els.forEach((el, i) => {
    let startX = 0, startY = 0, startPos = null, moved = false;
    el.addEventListener('pointerdown', (e) => {
      el.setPointerCapture(e.pointerId);
      el.classList.add('dragging');
      startX = e.clientX; startY = e.clientY;
      startPos = state.lights[i].position.slice();
      moved = false;
    });
    el.addEventListener('pointermove', (e) => {
      if (!el.hasPointerCapture(e.pointerId)) return;
      const dxPx = e.clientX - startX;
      const dyPx = e.clientY - startY;
      if (Math.abs(dxPx) > CLICK_THRESHOLD_PX || Math.abs(dyPx) > CLICK_THRESHOLD_PX) {
        moved = true;
      }
      if (!moved) return;
      const r = root.getBoundingClientRect();
      const dx = dxPx / r.width;
      const dy = dyPx / r.height;
      state.lights[i].position = [
        Math.max(0, Math.min(1, startPos[0] + dx)),
        Math.max(0, Math.min(1, startPos[1] + dy)),
        startPos[2],
      ];
      applyTargeting(state.lights[i]);   // re-derive direction if this light is targeted
      place();
      redraw();
    });
    el.addEventListener('pointerup', (e) => {
      el.releasePointerCapture(e.pointerId);
      el.classList.remove('dragging');
      if (!moved && onSelect) onSelect(state.lights[i].id);
    });
    el.addEventListener('wheel', (e) => {
      e.preventDefault();
      state.lights[i].position[2] += Math.sign(e.deltaY) * 0.05;
      applyTargeting(state.lights[i]);   // re-derive direction if this light is targeted
      redraw();
    }, { passive: false });
  });

  // ─── Direction-handle drag ─────────────────────────────────────────────
  {
    let startX = 0, startY = 0, startDir = null;
    dirHandle.addEventListener('pointerdown', (e) => {
      const sel = selectedLight();
      if (!sel) return;
      e.stopPropagation();
      dirHandle.setPointerCapture(e.pointerId);
      dirHandle.classList.add('dragging');
      startX = e.clientX;
      startY = e.clientY;
      startDir = sel.direction.slice();
    });
    dirHandle.addEventListener('pointermove', (e) => {
      if (!dirHandle.hasPointerCapture(e.pointerId)) return;
      const sel = selectedLight();
      if (!sel) return;
      const dxPx = e.clientX - startX;
      const dyPx = e.clientY - startY;
      // Convert pixel delta to direction-units. The handle currently sits at
      // startDir[0..1] * SCALE_PX from the position; new direction is the
      // (start + delta) interpreted back in direction units.
      sel.direction = [
        startDir[0] + dxPx / DIR_HANDLE_SCALE_PX,
        startDir[1] + dyPx / DIR_HANDLE_SCALE_PX,
        startDir[2],
      ];
      place();
      redraw();
    });
    dirHandle.addEventListener('pointerup', (e) => {
      dirHandle.releasePointerCapture(e.pointerId);
      dirHandle.classList.remove('dragging');
    });
  }

  // ─── Target-handle drag ────────────────────────────────────────────────
  {
    let startX = 0, startY = 0, startTarget = null;
    tgtHandle.addEventListener('pointerdown', (e) => {
      const sel = selectedLight();
      if (!sel || !isTargeted(sel)) return;
      e.stopPropagation();
      tgtHandle.setPointerCapture(e.pointerId);
      tgtHandle.classList.add('dragging');
      startX = e.clientX; startY = e.clientY;
      startTarget = sel.target.slice();
    });
    tgtHandle.addEventListener('pointermove', (e) => {
      if (!tgtHandle.hasPointerCapture(e.pointerId)) return;
      const sel = selectedLight();
      if (!sel || !isTargeted(sel)) return;
      const r = root.getBoundingClientRect();
      const dx = (e.clientX - startX) / r.width;
      const dy = (e.clientY - startY) / r.height;
      sel.target = [startTarget[0] + dx, startTarget[1] + dy, startTarget[2]];
      applyTargeting(sel);   // re-derive direction live
      place();
      redraw();
    });
    tgtHandle.addEventListener('pointerup', (e) => {
      tgtHandle.releasePointerCapture(e.pointerId);
      tgtHandle.classList.remove('dragging');
    });
  }

  return { reposition: place };
}
