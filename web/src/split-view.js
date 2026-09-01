/**
 * Split view: 2D | Split | 3D mode control plus a draggable divider between
 * the photo canvas pane and the 3D viewport pane.
 *
 * Pure helpers (computeSplitRatio, modeVisibility, migrateMode, ...) have no
 * DOM dependency so they run under node --test. createSplitView() wires them
 * to the DOM and is the only thing main.js needs to call.
 */

export const MODES = ['2d', 'split', '3d'];
export const DEFAULT_MODE = 'split';
export const DEFAULT_RATIO = 0.5;
export const DIVIDER_PX = 6;        // must match .stage-divider flex-basis in playground.css
export const MIN_PANE_PX = 200;     // each pane keeps at least this much width while dragging
const NARROW_MIN_FRACTION = 0.2;    // proportional min when the stage is too narrow for MIN_PANE_PX
const NARROW_FACTOR = 2.5;          // usable < NARROW_FACTOR * minPx -> proportional min
const RATIO_MIN = 0.05;             // wide sanity range; drag clamps (minPx/usable) can go below 0.1 on 4K/ultrawide
const RATIO_MAX = 0.95;

export const VIEW_MODE_KEY = 'photo-relight:view-mode';
export const SPLIT_RATIO_KEY = 'photo-relight:split-ratio';
export const LEGACY_SHOW_3D_KEY = 'photo-relight:show-3d';

export function normalizeMode(value) {
  return MODES.includes(value) ? value : DEFAULT_MODE;
}

/** Pick the mode on first load: new key wins, else legacy '0' means "3D hidden". */
export function migrateMode({ stored, legacyShow3d } = {}) {
  if (stored != null && stored !== '') return normalizeMode(stored);
  if (legacyShow3d === '0') return '2d';
  return DEFAULT_MODE;
}

export function modeVisibility(mode) {
  switch (normalizeMode(mode)) {
    case '2d':    return { show2d: true,  show3d: false, showDivider: false };
    case '3d':    return { show2d: false, show3d: true,  showDivider: false };
    default:      return { show2d: true,  show3d: true,  showDivider: true };
  }
}

/**
 * Clamp a ratio into the sanity range. Only non-finite input falls back to
 * DEFAULT_RATIO; out-of-range values are clamped, never snapped to centre
 * (a drag limit of minPx/usable is legitimately < 0.1 on a wide stage).
 */
export function clampRatio(r) {
  if (!Number.isFinite(r)) return DEFAULT_RATIO;
  return Math.min(RATIO_MAX, Math.max(RATIO_MIN, r));
}

/** Persisted ratio -> usable ratio; missing/garbage -> 0.5, out-of-range -> clamped. */
export function resolveInitialRatio(stored) {
  if (stored == null || stored === '') return DEFAULT_RATIO;
  return clampRatio(Number(stored));
}

/**
 * Pointer x -> split ratio. The ratio is a fraction of the *usable* width
 * (stage width minus the divider) so the divider lands under the pointer.
 * Each pane keeps >= minPx; on a stage too narrow for that, each pane keeps
 * >= 20% instead.
 */
export function computeSplitRatio({
  clientX,
  stageLeft,
  stageWidth,
  dividerWidth = DIVIDER_PX,
  minPx = MIN_PANE_PX,
} = {}) {
  const usable = stageWidth - dividerWidth;
  if (!Number.isFinite(clientX) || !Number.isFinite(stageLeft) || !Number.isFinite(usable) || usable <= 0) {
    return DEFAULT_RATIO;
  }
  const raw = (clientX - stageLeft) / usable;
  const minRatio = usable >= NARROW_FACTOR * minPx ? minPx / usable : NARROW_MIN_FRACTION;
  const maxRatio = 1 - minRatio;
  if (minRatio >= maxRatio) return DEFAULT_RATIO;
  return Math.min(maxRatio, Math.max(minRatio, raw));
}

// ── DOM wiring ──────────────────────────────────────────────────────────

function safeGet(storage, key) {
  try { return storage ? storage.getItem(key) : null; } catch { return null; }
}
function safeSet(storage, key, value) {
  try { storage?.setItem(key, value); } catch {}
}

/**
 * @param {object} opts
 * @param {HTMLElement} opts.stageEl    #stage (flex row container)
 * @param {HTMLElement} opts.dividerEl  #stage-divider
 * @param {HTMLElement} opts.pane2dEl   #stage2d-wrap
 * @param {HTMLElement} opts.pane3dEl   #stage3d-wrap
 * @param {HTMLElement} opts.modeEl     #view-mode (contains button[data-mode])
 * @param {Storage}     [opts.storage]  defaults to localStorage
 * @param {Function}    [opts.onLayout] called after any mode or ratio change
 */
export function createSplitView({
  stageEl,
  dividerEl,
  pane2dEl,
  pane3dEl,
  modeEl,
  storage,
  onLayout,
} = {}) {
  if (!stageEl || !dividerEl || !pane2dEl || !pane3dEl) return null;
  const store = storage !== undefined
    ? storage
    : (typeof localStorage !== 'undefined' ? localStorage : null);
  const body = stageEl.ownerDocument?.body;

  let mode = migrateMode({
    stored: safeGet(store, VIEW_MODE_KEY),
    legacyShow3d: safeGet(store, LEGACY_SHOW_3D_KEY),
  });
  let ratio = resolveInitialRatio(safeGet(store, SPLIT_RATIO_KEY));

  const modeButtons = modeEl ? Array.from(modeEl.querySelectorAll('[data-mode]')) : [];

  function applyRatio() {
    stageEl.style.setProperty('--split', String(ratio));
  }

  function applyMode() {
    const vis = modeVisibility(mode);
    // The 2D pane is never display:none. In 3D mode the CSS keeps it laid
    // out but invisible so the WebGL canvas keeps a non-zero backing buffer
    // for the point-cloud texture mirror (renderer.draw sizes from clientWidth).
    pane3dEl.hidden = !vis.show3d;
    dividerEl.hidden = !vis.showDivider;
    for (const m of MODES) stageEl.classList.toggle(`stage--mode-${m}`, m === mode);
    for (const btn of modeButtons) {
      const active = btn.dataset.mode === mode;
      btn.setAttribute('aria-pressed', active ? 'true' : 'false');
      btn.classList.toggle('is-active', active);
    }
  }

  function layout() {
    if (typeof onLayout === 'function') onLayout({ mode, ratio });
  }

  function setMode(next) {
    mode = normalizeMode(next);
    safeSet(store, VIEW_MODE_KEY, mode);
    applyMode();
    layout();
  }

  function setRatio(next, { persist = true } = {}) {
    ratio = clampRatio(next);
    if (persist) safeSet(store, SPLIT_RATIO_KEY, String(ratio));
    applyRatio();
    layout();
  }

  // ── mode buttons ──
  const onModeClick = (e) => {
    const btn = e.target.closest('[data-mode]');
    if (!btn) return;
    setMode(btn.dataset.mode);
  };
  modeEl?.addEventListener('click', onModeClick);

  // ── divider drag ──
  let dragging = false;
  let pendingX = null;
  let rafId = 0;

  const flushDrag = () => {
    rafId = 0;
    if (pendingX == null) return;
    const rect = stageEl.getBoundingClientRect();
    const next = computeSplitRatio({
      clientX: pendingX,
      stageLeft: rect.left,
      stageWidth: rect.width,
      dividerWidth: dividerEl.getBoundingClientRect().width || DIVIDER_PX,
    });
    pendingX = null;
    if (next !== ratio) setRatio(next, { persist: false });
  };

  const onPointerDown = (e) => {
    if (mode !== 'split' || e.button !== 0) return;
    dragging = true;
    dividerEl.setPointerCapture?.(e.pointerId);
    dividerEl.classList.add('is-active');
    body?.classList.add('is-resizing-split');
    e.preventDefault();
  };
  const onPointerMove = (e) => {
    if (!dragging) return;
    pendingX = e.clientX;
    if (!rafId) rafId = requestAnimationFrame(flushDrag);
  };
  const endDrag = (e) => {
    if (!dragging) return;
    dragging = false;
    if (rafId) { cancelAnimationFrame(rafId); rafId = 0; }
    if (e && Number.isFinite(e.clientX)) pendingX = e.clientX;
    flushDrag();
    safeSet(store, SPLIT_RATIO_KEY, String(ratio));
    dividerEl.classList.remove('is-active');
    body?.classList.remove('is-resizing-split');
    if (e && dividerEl.hasPointerCapture?.(e.pointerId)) dividerEl.releasePointerCapture(e.pointerId);
  };
  const onDblClick = () => {
    if (mode !== 'split') return;
    setRatio(DEFAULT_RATIO);
  };

  dividerEl.addEventListener('pointerdown', onPointerDown);
  dividerEl.addEventListener('pointermove', onPointerMove);
  dividerEl.addEventListener('pointerup', endDrag);
  dividerEl.addEventListener('pointercancel', endDrag);
  dividerEl.addEventListener('dblclick', onDblClick);

  // Initial state: write the migrated mode so the legacy key stops mattering.
  safeSet(store, VIEW_MODE_KEY, mode);
  applyRatio();
  applyMode();
  layout();

  return {
    getMode: () => mode,
    setMode,
    getRatio: () => ratio,
    setRatio,
    resetRatio: () => setRatio(DEFAULT_RATIO),
    destroy() {
      modeEl?.removeEventListener('click', onModeClick);
      dividerEl.removeEventListener('pointerdown', onPointerDown);
      dividerEl.removeEventListener('pointermove', onPointerMove);
      dividerEl.removeEventListener('pointerup', endDrag);
      dividerEl.removeEventListener('pointercancel', endDrag);
      dividerEl.removeEventListener('dblclick', onDblClick);
      if (rafId) cancelAnimationFrame(rafId);
    },
  };
}
