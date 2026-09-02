/**
 * Left-pane divider (Spec 2 §Room for the editor): a draggable edge between
 * #tree-pane and #stage. The pane's width is a pixel value on
 * paneEl.style.width, remembered per tab (Lights / Rig) so the Rig tables
 * get room without widening the Lights tree.
 *
 * Pure helpers (clampPaneWidth, resolveTabWidth, paneWidthKey) run under
 * node --test; createPaneDivider wires them to the DOM via the shared
 * createDragDivider from split-view.js.
 */
import { createDragDivider } from './split-view.js';

export const MIN_PANE_WIDTH = 220;
export const MAX_PANE_FRACTION = 0.6;          // of the window width
export const DEFAULT_PANE_WIDTHS = { lights: 260, rig: 580 };   // Rig: both tables fit without a horizontal scroll
export const PANE_WIDTH_KEY_PREFIX = 'photo-relight:left-pane-width:';
export const LEFT_TAB_KEY = 'photo-relight:left-tab';

export function paneWidthKey(tab) { return `${PANE_WIDTH_KEY_PREFIX}${tab}`; }

/** Whole pixels between MIN_PANE_WIDTH and 60% of the window; garbage → minimum. */
export function clampPaneWidth(px, windowWidth) {
  const n = Number(px);
  if (!Number.isFinite(n)) return MIN_PANE_WIDTH;
  const max = Number.isFinite(windowWidth) ? Math.floor(windowWidth * MAX_PANE_FRACTION) : MIN_PANE_WIDTH;
  return Math.max(MIN_PANE_WIDTH, Math.min(Math.max(max, MIN_PANE_WIDTH), Math.round(n)));
}

/** Persisted value → width for a tab: a finite positive number, else that tab's default. */
export function resolveTabWidth(stored, tab) {
  const fallback = DEFAULT_PANE_WIDTHS[tab] ?? DEFAULT_PANE_WIDTHS.lights;
  if (stored == null || stored === '') return fallback;
  const n = Number(stored);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function safeGet(storage, key) {
  try { return storage ? storage.getItem(key) : null; } catch { return null; }
}
function safeSet(storage, key, value) {
  try { storage?.setItem(key, value); } catch {}
}

/**
 * @param {object} opts
 * @param {HTMLElement} opts.paneEl       #tree-pane (gets style.width)
 * @param {HTMLElement} opts.dividerEl    #pane-divider
 * @param {Function}    opts.getTab       () => 'lights' | 'rig'
 * @param {Storage}     [opts.storage]    defaults to localStorage
 * @param {Function}    [opts.onLayout]   called with the width after any change
 * @param {Function}    [opts.windowWidth] () => px, defaults to window.innerWidth
 */
export function createPaneDivider({ paneEl, dividerEl, getTab, storage, onLayout, windowWidth } = {}) {
  if (!paneEl || !dividerEl) return null;
  const store = storage !== undefined
    ? storage
    : (typeof localStorage !== 'undefined' ? localStorage : null);
  const winWidth = typeof windowWidth === 'function'
    ? windowWidth
    : () => (typeof window !== 'undefined' ? window.innerWidth : NaN);
  const tab = () => (typeof getTab === 'function' ? getTab() : 'lights') || 'lights';

  let width = 0;

  function layout() {
    if (typeof onLayout === 'function') onLayout(width);
  }

  function setWidth(px, { persist = true } = {}) {
    width = clampPaneWidth(px, winWidth());
    paneEl.style.width = `${width}px`;
    if (persist) safeSet(store, paneWidthKey(tab()), String(width));
    layout();
  }

  /** Switch to a tab's remembered (or default) width without persisting it. */
  function applyTab(next) {
    const t = next || tab();
    setWidth(resolveTabWidth(safeGet(store, paneWidthKey(t)), t), { persist: false });
  }

  const drag = createDragDivider({
    dividerEl,
    onDrag: (clientX) => {
      const left = paneEl.getBoundingClientRect().left;
      setWidth(clientX - left, { persist: false });
    },
    onEnd: () => safeSet(store, paneWidthKey(tab()), String(width)),
    onDblClick: () => setWidth(DEFAULT_PANE_WIDTHS[tab()] ?? DEFAULT_PANE_WIDTHS.lights),
  });

  applyTab(tab());

  return {
    getWidth: () => width,
    setWidth,
    applyTab,
    destroy() { drag.destroy(); },
  };
}
