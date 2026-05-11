import {
  newState, newLightNode, newGroupNode, syncLights,
  ADD_LIGHT_ID, lightFromPreset, defaultSceneState,
} from './lights.js';
import {
  prepare, listGobos, render as serverRender,
  listScenes, getScene, createScene, updateScene, renameScene,
  refineMask, getCapabilities,
} from './api.js';
import {
  invalidatePolish,
  onPolishChange,
  setPolishPrompt,
  startPolish,
} from './polish.js';
import { mountLightbox } from './polish-lightbox.js';
import { init as initRenderer, setAssets, draw, reloadMaskTexture } from './webgl/renderer.js';
import { mountHandles } from './handles.js';
import { renderProps, renderAddLightPicker, setGoboPresets } from './controls.js';
import { mountTree } from './tree.js';
import { initTheme } from './theme.js';
import { openNewScenePopup } from './new-scene-popup.js';
import { openScenesListModal } from './scenes-list-modal.js';

const state = newState();
let tree = null;
let handlesAPI = null;
// Suppress auto-save until the initial scene has been loaded — otherwise the
// default in-memory state would overwrite the just-loaded scene's data on
// the very first change. Set true at the end of applyScene().
let initialized = false;
// While the +Add-Light picker is up, remember where the new light should go.
// Cleared once the user picks a preset or cancels.
let pendingAddLight = null;     // { parentArr, index } | null
// Remember the previously-selected node so Cancel returns there.
let lastSelectedBeforePicker = null;

// Refine-mask mode (UI-only; not persisted to the scene).
state.refineMode = false;
state.refinePoints = [];          // [{ x, y, label, u, v }]
let refineSeq = 0;                // serial for discarding stale /refine_mask responses

const propsContainer = () => document.getElementById('props-content');
const statusEl = () => document.getElementById('save-status');

initTheme(state);

// ─── Auto-save ────────────────────────────────────────────────────────────
let saveTimer = null;

function setStatus(t) { statusEl().textContent = t; }

function serializeSceneState() {
  return {
    tree: state.tree,
    ambient: state.ambient,
    debugView: state.debugView,
    shadowStyle: state.shadowStyle,
    selectedId: state.selectedId,
  };
}

function scheduleSave() {
  if (!initialized || !state.sceneId) return;
  setStatus('Saving…');
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    saveTimer = null;
    try {
      await updateScene(state.sceneId, serializeSceneState());
      setStatus('Saved');
    } catch (e) {
      setStatus('Save failed');
      console.error('autosave', e);
    }
  }, 500);
}

async function flushSave() {
  if (!saveTimer) return;
  clearTimeout(saveTimer);
  saveTimer = null;
  if (!state.sceneId) return;
  try { await updateScene(state.sceneId, serializeSceneState()); }
  catch (e) { console.error('flushSave', e); }
}

// ─── Render plumbing ──────────────────────────────────────────────────────
function fitCanvasWrap() {
  const stage = document.getElementById('stage');
  const wrap = document.getElementById('canvas-wrap');
  if (!state.width || !state.height) return;
  const sw = stage.clientWidth, sh = stage.clientHeight;
  const ar = state.width / state.height;
  let w, h;
  if (sw / sh > ar) { h = sh; w = Math.round(h * ar); }
  else { w = sw; h = Math.round(w / ar); }
  wrap.style.width = `${w}px`;
  wrap.style.height = `${h}px`;
}

window.addEventListener('resize', () => {
  fitCanvasWrap();
  if (state.sessionId) document.dispatchEvent(new Event('relight:redraw'));
});

const redraw = () => { if (state.sessionId) draw(state); };
const redrawAndSave = () => { redraw(); scheduleSave(); };

const refreshProps = () => {
  const c = propsContainer();
  if (state.selectedId === ADD_LIGHT_ID) {
    renderAddLightPicker(state, c, onPickPreset);
  } else {
    renderProps(state, c, redrawAndSave);
  }
};

function onRequestAddLight({ parentArr, index }) {
  pendingAddLight = { parentArr, index };
  lastSelectedBeforePicker = state.selectedId;
  state.selectedId = ADD_LIGHT_ID;
  tree?.render();
  refreshProps();
}

function onPickPreset(preset) {
  if (!preset) {
    // Cancel — restore previous selection.
    pendingAddLight = null;
    state.selectedId = lastSelectedBeforePicker || state.tree[0]?.id || '__scene__';
    lastSelectedBeforePicker = null;
    tree?.render();
    refreshProps();
    return;
  }
  const target = pendingAddLight || { parentArr: state.tree, index: state.tree.length };
  const L = lightFromPreset(preset);
  L.name = uniqueName(preset.name);
  target.parentArr.splice(target.index, 0, L);
  pendingAddLight = null;
  lastSelectedBeforePicker = null;
  state.selectedId = L.id;
  tree?.render();
  refreshProps();
  onChange();
}

const onChange = () => {
  invalidatePolish();
  syncLights(state);
  if (state.sessionId) {
    handlesAPI = mountHandles(state, redrawAndSave, onCanvasSelect);
    redraw();
  }
  scheduleSave();
};

const onTreeSelect = () => {
  refreshProps();
  handlesAPI?.reposition();
  scheduleSave();
};

function onCanvasSelect(lightId) {
  if (state.selectedId === lightId) return;
  state.selectedId = lightId;
  tree?.render();
  refreshProps();
  handlesAPI?.reposition();
  scheduleSave();
}

// ─── Scene loading ────────────────────────────────────────────────────────
async function applyScene(scene) {
  await flushSave();    // commit any pending auto-save against the previous scene

  // Reset transient refine UI from any previous scene.
  if (state.refineMode) setRefineMode(false);
  refineSeq += 1;       // invalidate any in-flight /refine_mask response

  state.sceneId = scene.id;
  state.sceneName = scene.name;
  state.sessionId = scene.session_id;

  document.getElementById('scene-name').value = scene.name;

  if (scene.session_missing) {
    setStatus('Image missing — recreate scene');
    state.sessionId = null;
    state.assetUrls = null;
    state.width = state.height = 0;
    initialized = true;     // allow auto-save once the user fixes it
    return;
  }

  const s = scene.state || {};
  if (Array.isArray(s.tree) && s.tree.length) state.tree = s.tree;
  state.ambient = s.ambient ?? 0.2;
  state.debugView = s.debugView ?? 'render';
  // Migrate the old castShadows boolean to the new shadowStyle enum.
  state.shadowStyle = s.shadowStyle ?? (s.castShadows ? 'heightfield' : 'off');
  state.selectedId = s.selectedId ?? state.tree[0]?.id;
  // Subject depth comes from the session's prepare metadata.
  const sm = scene.session_metadata || {};
  state.subjectMedianDepth = typeof sm.subject_median_depth === 'number'
    ? sm.subject_median_depth : 0.3;
  syncLights(state);

  state.width = scene.width;
  state.height = scene.height;
  state.assetUrls = scene.assets;

  tree.render();
  refreshProps();

  if (state.assetUrls) {
    fitCanvasWrap();
    const canvas = document.getElementById('canvas');
    await initRenderer(canvas);
    await setAssets(state.assetUrls, canvas);
    handlesAPI = mountHandles(state, redrawAndSave, onCanvasSelect);
    redraw();
  }
  initialized = true;
  setStatus('');
}

async function runNewSceneFlow({ canCancel }) {
  while (true) {
    const result = await openNewScenePopup({ canCancel });
    if (!result) return null;     // cancelled
    try {
      setStatus('Preparing image…');
      const prepared = await prepare(result.file, result.mode, result.segmenter);
      // A new scene gets a fresh default light tree (Key + Rim), not the
      // current scene's lighting. Otherwise +New Scene would inherit your
      // last setup, which is rarely what you want.
      const created = await createScene({
        name: result.name,
        sessionId: prepared.session_id,
        state: defaultSceneState(),
      });
      const full = await getScene(created.id);
      await applyScene(full);
      return full;
    } catch (e) {
      setStatus('');
      alert(`Couldn't create scene:\n${e.message || e}`);
      // loop and reopen the popup so the user can try again
    }
  }
}

// ─── Polish UI ────────────────────────────────────────────────────────────

async function setupPolishUI() {
  const controls = document.querySelector('[data-polish-controls]');
  const toggle = document.querySelector('[data-polish-toggle]');
  const toggleClassicalBtn = document.querySelector('[data-polish-toggle-classical]');
  const togglePolishedBtn = document.querySelector('[data-polish-toggle-polished]');
  const promptInput = document.querySelector('[data-polish-prompt]');
  const polishBtn = document.querySelector('[data-polish-btn]');
  const shimmer = document.querySelector('[data-polish-shimmer]');
  const shimmerText = document.querySelector('[data-polish-shimmer-text]');
  const expandBtn = document.querySelector('[data-polish-expand-btn]');
  const lightboxEl = document.querySelector('[data-polish-lightbox]');

  let caps;
  try {
    caps = await getCapabilities();
  } catch {
    caps = { polish: false };
  }
  if (!caps.polish) {
    controls?.remove();
    shimmer?.remove();
    expandBtn?.remove();
    lightboxEl?.remove();
    return;
  }

  controls.hidden = false;

  let currentBlobUrl = null;
  const lightbox = mountLightbox({
    rootEl: lightboxEl,
    getBlobUrl: () => currentBlobUrl,
  });
  expandBtn.addEventListener('click', () => lightbox.open());

  promptInput.addEventListener('input', (e) => setPolishPrompt(e.target.value));

  polishBtn.addEventListener('click', () => {
    if (!state.sessionId) return;
    startPolish({
      sessionId: state.sessionId,
      lights: state.lights,
      ambient: state.ambient,
      shadowStyle: state.shadowStyle || 'off',
    });
  });

  let shimmerTimer = null;
  let viewMode = 'classical';

  function ensurePolishedImg() {
    let img = document.querySelector('[data-polished-img]');
    if (!img) {
      img = document.createElement('img');
      img.dataset.polishedImg = '';
      img.style.position = 'absolute';
      img.style.inset = '0';
      img.style.width = '100%';
      img.style.height = '100%';
      img.style.objectFit = 'contain';
      img.style.pointerEvents = 'none';
      img.style.display = 'none';
      document.getElementById('canvas-wrap').appendChild(img);
    }
    return img;
  }

  function applyViewMode() {
    toggleClassicalBtn.classList.toggle('is-active', viewMode === 'classical');
    togglePolishedBtn.classList.toggle('is-active', viewMode === 'polished');
    const canvas = document.getElementById('canvas');
    const img = ensurePolishedImg();
    if (viewMode === 'polished' && currentBlobUrl) {
      canvas.style.visibility = 'hidden';
      img.src = currentBlobUrl;
      img.style.display = 'block';
    } else {
      canvas.style.visibility = 'visible';
      img.style.display = 'none';
      img.src = '';
    }
  }
  toggleClassicalBtn.addEventListener('click', () => { viewMode = 'classical'; applyViewMode(); });
  togglePolishedBtn.addEventListener('click', () => { viewMode = 'polished'; applyViewMode(); });

  onPolishChange((s) => {
    polishBtn.disabled = s.status === 'polishing' || !state.sessionId;
    promptInput.disabled = s.status === 'polishing';

    if (s.status === 'polishing') {
      shimmer.hidden = false;
      shimmerText.textContent = 'Polishing…';
      clearTimeout(shimmerTimer);
      shimmerTimer = setTimeout(() => {
        shimmerText.textContent = 'Loading polish model (one-time, ~6 GB)…';
      }, 5000);
    } else {
      clearTimeout(shimmerTimer);
      shimmer.hidden = true;
    }

    if (s.status === 'ready') {
      currentBlobUrl = s.blobUrl;
      toggle.hidden = false;
      expandBtn.hidden = false;
      viewMode = 'polished';
      applyViewMode();
    }

    if (s.status === 'idle' || s.status === 'error') {
      currentBlobUrl = null;
      toggle.hidden = true;
      expandBtn.hidden = true;
      viewMode = 'classical';
      applyViewMode();
    }

    if (s.status === 'error') {
      console.error('polish error:', s.error);
    }
  });
}

// ─── Bootstrap ────────────────────────────────────────────────────────────
tree = mountTree(state, onTreeSelect, onChange, onRequestAddLight);
refreshProps();

(async () => {
  setupPolishUI();   // fire-and-forget; doesn't block scene loading

  try {
    const gobos = await listGobos();
    setGoboPresets(gobos.presets);
    refreshProps();   // pick up gobo options in the open props panel
  } catch (e) { console.warn('gobo list', e); }

  let scenes;
  try {
    scenes = await listScenes();
  } catch (e) {
    alert('Failed to fetch scenes from server.');
    console.error(e);
    return;
  }
  if (scenes.length === 0) {
    await runNewSceneFlow({ canCancel: false });
  } else {
    try {
      const full = await getScene(scenes[0].id);
      await applyScene(full);
    } catch (e) {
      console.error('load most-recent scene', e);
      await runNewSceneFlow({ canCancel: false });
    }
  }
})();

// ─── Header buttons ───────────────────────────────────────────────────────
document.getElementById('new-scene-btn').addEventListener('click', async () => {
  await runNewSceneFlow({ canCancel: true });
});

document.getElementById('scenes-btn').addEventListener('click', async () => {
  const result = await openScenesListModal({ currentSceneId: state.sceneId });
  if (!result || result.action !== 'load') {
    // Modal dismissed, or the user just deleted scenes. If they deleted the
    // current one, the in-memory state is now orphaned — fall back to the
    // most-recent remaining scene, or the new-scene popup if none left.
    try {
      const fresh = await listScenes();
      if (fresh.length === 0) {
        // Everything got deleted — force the user to create one.
        await runNewSceneFlow({ canCancel: false });
      } else if (state.sceneId && !fresh.find((s) => s.id === state.sceneId)) {
        // Current scene was deleted — load the most recent remaining one.
        const full = await getScene(fresh[0].id);
        await applyScene(full);
      }
    } catch (e) { console.warn('post-modal sync', e); }
    return;
  }
  if (result.sceneId === state.sceneId) return;
  try {
    const full = await getScene(result.sceneId);
    await applyScene(full);
  } catch (e) {
    alert(`Couldn't load scene: ${e.message}`);
  }
});

document.getElementById('scene-name').addEventListener('change', async (ev) => {
  if (!state.sceneId) return;
  const newName = ev.target.value.trim();
  if (!newName || newName === state.sceneName) {
    ev.target.value = state.sceneName || '';
    return;
  }
  try {
    await renameScene(state.sceneId, newName);
    state.sceneName = newName;
    setStatus('Renamed');
  } catch (e) {
    alert('Rename failed.');
    ev.target.value = state.sceneName || '';
  }
});

document.getElementById('show-anchors').addEventListener('change', (ev) => {
  document.getElementById('handles').hidden = !ev.target.checked;
});

// ─── Refine Mask mode ─────────────────────────────────────────────────────
const refineBtn = document.getElementById('refine-mask-btn');
const refineClearBtn = document.getElementById('refine-clear-btn');
const refineOverlay = document.getElementById('refine-overlay');

function setRefineMode(on) {
  state.refineMode = !!on;
  state.refinePoints = state.refinePoints || [];
  refineBtn.classList.toggle('active', state.refineMode);
  refineOverlay.hidden = !state.refineMode;
  refineClearBtn.hidden = !state.refineMode;
  document.getElementById('handles').hidden =
    state.refineMode || !document.getElementById('show-anchors').checked;
  if (!state.refineMode) {
    state.refinePoints = [];
    refineOverlay.innerHTML = '';
  }
  redraw();
}

refineBtn.addEventListener('click', () => {
  if (!state.sessionId) return;
  setRefineMode(!state.refineMode);
});
refineClearBtn.addEventListener('click', () => {
  state.refinePoints = [];
  refineOverlay.innerHTML = '';
});

refineOverlay.addEventListener('contextmenu', (e) => e.preventDefault());

refineOverlay.addEventListener('pointerdown', async (e) => {
  if (!state.sessionId || !state.refineMode) return;
  e.preventDefault();
  const r = refineOverlay.getBoundingClientRect();
  const u = (e.clientX - r.left) / r.width;
  const v = (e.clientY - r.top) / r.height;
  if (u < 0 || u > 1 || v < 0 || v > 1) return;
  // right-click or shift-click → negative; otherwise positive.
  const label = (e.button === 2 || e.shiftKey) ? 0 : 1;
  const x = Math.round(u * (state.width || 1));
  const y = Math.round(v * (state.height || 1));
  state.refinePoints.push({ x, y, label, u, v });
  // Render the marker immediately so the click feels responsive.
  const m = document.createElement('div');
  m.className = `refine-point ${label === 1 ? 'positive' : 'negative'}`;
  m.style.left = `${u * 100}%`;
  m.style.top  = `${v * 100}%`;
  refineOverlay.appendChild(m);

  refineSeq += 1;
  const mySeq = refineSeq;
  setStatus('Refining mask…');
  try {
    const res = await refineMask(state.sessionId, state.refinePoints);
    if (mySeq !== refineSeq) return;   // a newer click is in flight; discard
    await reloadMaskTexture(res.mask_png_url);
    setStatus('Mask updated');
    redraw();
  } catch (err) {
    if (mySeq === refineSeq) {
      setStatus('Refine failed');
      console.error('refine_mask', err);
    }
  }
});

document.getElementById('export-btn').addEventListener('click', async () => {
  if (!state.sessionId) return;
  const body = {
    session_id: state.sessionId,
    lights: state.lights,
    ambient: state.ambient,
    shadow_style: state.shadowStyle || 'off',
    output_format: 'png',
    output_bit_depth: 8,
  };
  const blob = await serverRender(body);
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${(state.sceneName || 'scene').replace(/[^\w-]+/g, '_')}-${Date.now()}.png`;
  document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
});

// ─── + Light / + Group buttons in the tree pane header ───────────────────
document.getElementById('add-light-btn').addEventListener('click', () => {
  onRequestAddLight({ parentArr: state.tree, index: state.tree.length });
});
document.getElementById('add-group-btn').addEventListener('click', () => {
  const G = newGroupNode({ name: uniqueName('Group') });
  state.tree.push(G);
  state.selectedId = G.id;
  tree.render();
  refreshProps();
  onChange();
});

function uniqueName(prefix) {
  const taken = new Set();
  const walk = (arr) => {
    for (const n of arr) {
      taken.add(n.name);
      if (n.kind === 'group') walk(n.children);
    }
  };
  walk(state.tree);
  let i = 1;
  while (taken.has(`${prefix} ${i}`)) i += 1;
  return `${prefix} ${i}`;
}

window.__state = state;  // for console debugging
