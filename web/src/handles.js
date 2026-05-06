// Floating handles over the canvas. Drag updates light.position.x/y.
// Shift-drag rotates direction. Wheel adjusts position.z.

const HANDLE_COLORS = { 0: '#ffd966', 1: '#9fc5e8', 2: '#ea9999' };

export function mountHandles(state, redraw) {
  const root = document.getElementById('handles');
  root.innerHTML = '';
  const els = state.lights.map((L, i) => {
    const el = document.createElement('div');
    el.className = 'handle';
    el.style.background = HANDLE_COLORS[i] || '#fff';
    root.appendChild(el);
    return el;
  });

  const place = () => {
    const r = root.getBoundingClientRect();
    state.lights.forEach((L, i) => {
      els[i].style.left = `${L.position[0] * r.width}px`;
      els[i].style.top  = `${L.position[1] * r.height}px`;
      els[i].style.display = L.enabled ? '' : 'none';
    });
  };
  place();
  window.addEventListener('resize', place);

  els.forEach((el, i) => {
    let startX = 0, startY = 0, startPos = null, shift = false;
    el.addEventListener('pointerdown', (e) => {
      el.setPointerCapture(e.pointerId);
      el.classList.add('dragging');
      startX = e.clientX; startY = e.clientY;
      startPos = state.lights[i].position.slice();
      shift = e.shiftKey;
    });
    el.addEventListener('pointermove', (e) => {
      if (!el.hasPointerCapture(e.pointerId)) return;
      const r = root.getBoundingClientRect();
      const dx = (e.clientX - startX) / r.width;
      const dy = (e.clientY - startY) / r.height;
      if (shift) {
        // shift-drag → tilt direction in xy
        state.lights[i].direction = [dx * 2, dy * 2, state.lights[i].direction[2]];
      } else {
        state.lights[i].position = [
          Math.max(0, Math.min(1, startPos[0] + dx)),
          Math.max(0, Math.min(1, startPos[1] + dy)),
          startPos[2],
        ];
      }
      place();
      redraw();
    });
    el.addEventListener('pointerup', (e) => {
      el.releasePointerCapture(e.pointerId);
      el.classList.remove('dragging');
    });
    el.addEventListener('wheel', (e) => {
      e.preventDefault();
      state.lights[i].position[2] += Math.sign(e.deltaY) * 0.05;
      redraw();
    }, { passive: false });
  });

  return { reposition: place };
}
