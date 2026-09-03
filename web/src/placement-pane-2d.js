// 2D-photo-pane adapter for click-to-place. While placement is active, a full
// overlay captures clicks over the photo, samples depth at the click, and feeds
// the controller an engine-space surface point [u, v, 1 - depth]. Between the
// light click and the target click it draws a dashed tether from the light to
// the cursor.
import { uvDepthToLight } from './3d/coords.js';

export function mountPlacement2D({ overlayEl, controller, getSampler }) {
  const tether = document.createElement('div');
  tether.className = 'placement-tether';
  tether.style.display = 'none';
  overlayEl.appendChild(tether);

  function uv(e) {
    const r = overlayEl.getBoundingClientRect();
    return [(e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height];
  }

  function engPointAt(e) {
    const [u, v] = uv(e);
    if (u < 0 || u > 1 || v < 0 || v > 1) return null;
    const depth = getSampler()?.sample(u, v) ?? 0.5;
    return uvDepthToLight(u, v, depth);
  }

  overlayEl.addEventListener('pointerdown', (e) => {
    if (!controller.isActive() || e.button !== 0) return;
    const engPt = engPointAt(e);
    if (!engPt) return;
    e.preventDefault();
    controller.acceptSurfacePoint(engPt);
  });

  overlayEl.addEventListener('pointermove', (e) => {
    if (controller.phase() !== 'awaitingTarget') { tether.style.display = 'none'; return; }
    const L = controller.pendingLight();
    if (!L) { tether.style.display = 'none'; return; }
    const r = overlayEl.getBoundingClientRect();
    const lx = L.position[0] * r.width;
    const ly = L.position[1] * r.height;
    const cx = e.clientX - r.left;
    const cy = e.clientY - r.top;
    const dx = cx - lx, dy = cy - ly;
    tether.style.left = `${lx}px`;
    tether.style.top = `${ly}px`;
    tether.style.width = `${Math.hypot(dx, dy)}px`;
    tether.style.transform = `rotate(${Math.atan2(dy, dx) * 180 / Math.PI}deg)`;
    tether.style.display = '';
  });

  // Right-click cancels placement.
  overlayEl.addEventListener('contextmenu', (e) => {
    if (!controller.isActive()) return;
    e.preventDefault();
    controller.cancel();
  });

  function setPhase(phase) {
    const active = phase !== 'idle';
    overlayEl.hidden = !active;
    if (!active || phase !== 'awaitingTarget') tether.style.display = 'none';
  }

  return { setPhase };
}
