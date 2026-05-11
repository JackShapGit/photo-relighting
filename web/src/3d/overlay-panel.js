/** Floating control overlay in the 3D viewport corner.
 *
 * Renders into the existing #stage3d-overlay container. Exposes setters that
 * the rest of the 3D module calls to apply visual changes; emits events when
 * the user manipulates a control.
 */

export function mountOverlayPanel({ rootEl, hooks }) {
  rootEl.innerHTML = `
    <label>
      <input type="checkbox" data-show-points checked />
      Show points
    </label>
    <label>
      Size
      <input type="range" min="1" max="6" step="1" value="2" data-point-size />
    </label>
    <label>
      Opacity
      <input type="range" min="0" max="100" step="5" value="80" data-point-opacity />
    </label>
    <label>
      View
      <select data-projection>
        <option value="perspective" selected>Perspective</option>
        <option value="orthographic">Orthographic</option>
      </select>
    </label>
    <button type="button" data-reset-camera>Reset camera</button>
  `;

  const showCb = rootEl.querySelector('[data-show-points]');
  const sizeSl = rootEl.querySelector('[data-point-size]');
  const opaSl  = rootEl.querySelector('[data-point-opacity]');
  const projSel = rootEl.querySelector('[data-projection]');
  const resetBtn = rootEl.querySelector('[data-reset-camera]');

  showCb.addEventListener('change', () => hooks.onShowPointsChange(showCb.checked));
  sizeSl.addEventListener('input', () => {
    // Map slider [1..6] → world-space size [0.002 .. 0.012].
    const s = 0.002 * Number(sizeSl.value);
    hooks.onPointSizeChange(s);
  });
  opaSl.addEventListener('input', () => {
    hooks.onPointOpacityChange(Number(opaSl.value) / 100);
  });
  projSel.addEventListener('change', () => hooks.onProjectionChange(projSel.value));
  resetBtn.addEventListener('click', () => hooks.onResetCamera());
}
