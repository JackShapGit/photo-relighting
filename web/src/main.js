import {
  newState, newLightNode, newGroupNode, syncLights,
  ADD_LIGHT_ID, lightFromPreset, defaultSceneState,
  deleteNode, SCENE_ID,
} from './lights.js';
import { createPlacement } from './placement.js';
import { createDepthSampler } from './depth-sampler.js';
import {
  loadScene3D, mount3D, notifyPlacementPhase, refreshPointCloudColor, syncLightsToScene,
  setCalibration3D, setUnits3D, frameStage3D,
} from './3d/index.js';
import {
  prepare, listGobos, render as serverRender, renderLayers,
  listScenes, getScene, createScene, updateScene, renameScene,
  refineMask, getCapabilities, currentWorkspace, checkCalibration,
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
import { applyTargeting } from './targeting.js';
import { renderProps, renderAddLightPicker, setGoboPresets } from './controls.js';
import { mountTree } from './tree.js';
import { initTheme } from './theme.js';
import { openNewScenePopup } from './new-scene-popup.js';
import { openScenesListModal } from './scenes-list-modal.js';
import { createSplitView } from './split-view.js';
import {
  solveRecord, syncLightFromFeet, syncLightFromEngine, migrateLightsToFeet, clearMetric,
  syncLightsFromEngineEdits, clampEnginePosition,
} from './metric/light-metric.js';
import { toDisplay } from './metric/units.js';
import { mountCalibrationPanel } from './metric/calibration-panel.js';
import { mountPlacement2D } from './placement-pane-2d.js';

const state = newState();
let tree = null;
let handlesAPI = null;
let depthSampler = null;     // rebuilt on each scene load; used by 2D placement
let placement = null;        // created once below
let placement2D = null;      // 2D pane placement adapter (assigned below)
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

// The calibration record persists without the solved camera; it is re-solved
// from the marks (and the image aspect) whenever the scene loads.
function stripCamera(record) {
  const { camera, ...rest } = record;
  return rest;
}

function serializeSceneState() {
  return {
    tree: state.tree,
    ambient: state.ambient,
    ambientSubject: state.ambientSubject,
    ambientBackground: state.ambientBackground,
    ambientLinked: state.ambientLinked,
    debugView: state.debugView,
    shadowStyle: state.shadowStyle,
    selectedId: state.selectedId,
    calibration: state.calibration ? stripCamera(state.calibration) : null,
    units: state.units || 'ft',
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
  // Letterbox inside the 2D pane (not the whole stage) so the image keeps
  // its aspect ratio at any split width.
  const pane = document.getElementById('stage2d-wrap') || document.getElementById('stage');
  const wrap = document.getElementById('canvas-wrap');
  if (!state.width || !state.height) return;
  const sw = pane.clientWidth, sh = pane.clientHeight;
  const ar = state.width / state.height;
  let w, h;
  if (sw / sh > ar) { h = sh; w = Math.round(h * ar); }
  else { w = sw; h = Math.round(w / ar); }
  wrap.style.width = `${w}px`;
  wrap.style.height = `${h}px`;
}

window.addEventListener('resize', () => {
  fitCanvasWrap();
  // Re-render at the new canvas size (draw() resizes the backing buffer
  // from clientWidth/Height) and refresh the 3D texture mirror. Without
  // this the canvas is CSS-stretched over a stale buffer until the next
  // light edit. redraw is a no-op before a session exists.
  redraw();
});

const redraw = () => {
  if (!state.sessionId) return;
  draw(state);
  // Mirror the freshly-rendered 2D canvas into the 3D point cloud's texture
  // so the cloud reflects the current lighting. Done synchronously here
  // (before the browser composites) because WebGL drawing buffers may be
  // cleared after the next compositor cycle when preserveDrawingBuffer=false.
  refreshPointCloudColor();
};
const redrawAndSave = () => {
  syncDraggedLights();                 // engine-space edits re-derive feet fields first
  redraw();
  syncLightsToScene(state.lights, state.selectedId);
  scheduleSave();
};

const refreshProps = () => {
  const c = propsContainer();
  if (state.selectedId === ADD_LIGHT_ID) {
    renderAddLightPicker(state, c, onPickPreset);
  } else {
    renderProps(state, c, redrawAndSave, onChange);
  }
};

function commitPlacedLight(L, insertAt) {
  const where = insertAt || { parentArr: state.tree, index: state.tree.length };
  where.parentArr.splice(where.index, 0, L);
  state.selectedId = L.id;
  // Click-placement produces engine-space coordinates; derive feet when calibrated.
  if (state.calibration && L.type !== 'reflector') syncLightFromEngine(L, state.calibration);
  tree?.render();
  refreshProps();
  onChange();
}

function updatePlacedLight(L) {
  // Direction already derived by the controller; refresh props so the targeting
  // toggle reflects the new target, then sync + save.
  if (state.calibration && L.type !== 'reflector') syncLightFromEngine(L, state.calibration);
  refreshProps();
  onChange();
}

// Every engine-space edit (2D handle/target drags, Direction Z slider, the
// aim-at-target toggle, newly added lights) funnels through here before a
// redraw or save, so the feet fields the metric renderer reads never lag.
function syncDraggedLights() {
  if (state.calibration) syncLightsFromEngineEdits(state.lights, state.calibration);
}
const onHandlesChange = () => { syncDraggedLights(); redrawAndSave(); };

function removePlacedLight(L) {
  deleteNode(state.tree, L.id);
  syncLights(state);
  if (state.selectedId === L.id) state.selectedId = state.tree[0]?.id || SCENE_ID;
  tree?.render();
  refreshProps();
  onChange();
}

function onPlacementPhase(phase) {
  if (phase === 'awaitingLight') setStatus('Click in the photo or 3D view to place the light');
  else if (phase === 'awaitingTarget') setStatus('Click where the light should aim (Esc to cancel)');
  else setStatus('');
  placement2D?.setPhase(phase);
  notifyPlacementPhase(phase);
}

placement = createPlacement({
  commitLight: commitPlacedLight,
  updateLight: updatePlacedLight,
  removeLight: removePlacedLight,
  onPhaseChange: onPlacementPhase,
});

placement2D = mountPlacement2D({
  overlayEl: document.getElementById('placement-overlay'),
  controller: placement,
  getSampler: () => depthSampler,
});

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
    state.selectedId = lastSelectedBeforePicker || state.tree[0]?.id || SCENE_ID;
    lastSelectedBeforePicker = null;
    tree?.render();
    refreshProps();
    return;
  }
  const insertAt = pendingAddLight || { parentArr: state.tree, index: state.tree.length };
  const prevSelection = lastSelectedBeforePicker;   // remember what was selected before the picker
  const L = lightFromPreset(preset);
  L.name = uniqueName(preset.name);
  pendingAddLight = null;
  lastSelectedBeforePicker = null;

  const placeable = L.type === 'directional' || L.type === 'spotlight' || L.type === 'point';
  if (placeable && placement && state.assetUrls) {
    // Enter click-to-place. Keep the prior selection so dismissing the picker
    // shows something sensible and a cancel-before-first-click returns to it.
    // The first click commits the new light and selects it.
    state.selectedId = prevSelection || state.tree[0]?.id || SCENE_ID;
    tree?.render();
    refreshProps();
    placement.begin(L, insertAt);
    return;
  }

  // Reflector (or no assets yet): instant add at default position (legacy path).
  insertAt.parentArr.splice(insertAt.index, 0, L);
  state.selectedId = L.id;
  tree?.render();
  refreshProps();
  onChange();
}

const onChange = () => {
  invalidatePolish();
  syncLights(state);
  syncDraggedLights();
  if (state.sessionId) {
    handlesAPI = mountHandles(state, onHandlesChange, onCanvasSelect);
    redraw();
  }
  syncLightsToScene(state.lights, state.selectedId);
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
  syncLightsToScene(state.lights, state.selectedId);
  scheduleSave();
}

// ─── Scene loading ────────────────────────────────────────────────────────
async function applyScene(scene) {
  await flushSave();    // commit any pending auto-save against the previous scene
  if (placement?.isActive()) placement.cancel();

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
    depthSampler = null;
    initialized = true;     // allow auto-save once the user fixes it
    return;
  }

  const s = scene.state || {};
  if (Array.isArray(s.tree) && s.tree.length) state.tree = s.tree;
  state.ambient = s.ambient ?? 0.2;
  // Legacy scenes only have `ambient` — initialize subject/background to match.
  state.ambientSubject = s.ambientSubject ?? state.ambient;
  state.ambientBackground = s.ambientBackground ?? state.ambient;
  state.ambientLinked = s.ambientLinked ?? true;
  state.debugView = s.debugView ?? 'render';
  // Migrate the old castShadows boolean to the new shadowStyle enum.
  state.shadowStyle = s.shadowStyle ?? (s.castShadows ? 'heightfield' : 'off');
  state.selectedId = s.selectedId ?? state.tree[0]?.id;
  // Subject depth comes from the session's prepare metadata.
  const sm = scene.session_metadata || {};
  state.subjectMedianDepth = typeof sm.subject_median_depth === 'number'
    ? sm.subject_median_depth : 0.3;
  syncLights(state);
  // Recompute derived direction for any targeted lights (guards against a stale
  // stored direction in the loaded scene).
  for (const L of state.lights) applyTargeting(L);
  // 3D view picks up lights as soon as they're loaded.
  syncLightsToScene(state.lights, state.selectedId);

  state.width = scene.width;
  state.height = scene.height;
  state.assetUrls = scene.assets;

  // Calibration persists without the solved camera; re-solve against this
  // image's aspect and make sure every light carries feet coordinates.
  // (Display units are a viewer preference kept in localStorage, not restored
  // from the scene.)
  state.calibration = s.calibration ? solveRecord(s.calibration, state.height / state.width) : null;
  if (state.calibration) migrateLightsToFeet(state.lights, state.calibration);

  tree.render();
  refreshProps();

  if (state.assetUrls) {
    fitCanvasWrap();
    const canvas = document.getElementById('canvas');
    await initRenderer(canvas);
    await setAssets(state.assetUrls, canvas);
    await loadScene3D({ assetUrls: state.assetUrls, calibration: state.calibration, units: state.units });
    depthSampler = createDepthSampler(state.assetUrls.depth_png_url);
    handlesAPI = mountHandles(state, onHandlesChange, onCanvasSelect);
    redraw();
    syncLightsToScene(state.lights, state.selectedId);   // initial population
    frameStage3D();                                       // home view includes FOH fixtures
  }
  // Badge/props/3D listeners: the 3D side already holds this record (passed to
  // loadScene3D above), so its listener is a no-op here.
  document.dispatchEvent(new CustomEvent('relight:calibration', { detail: state.calibration }));
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
  if (caps.layers_export) {
    document.getElementById('export-layers-btn').hidden = false;
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
      ambientSubject: state.ambientLinked === false ? state.ambientSubject : null,
      ambientBackground: state.ambientLinked === false ? state.ambientBackground : null,
      shadowStyle: state.shadowStyle || 'off',
      calibration: state.calibration ? stripCamera(state.calibration) : null,
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

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && placement?.isActive()) {
    e.preventDefault();
    placement.cancel();
  }
});

(async () => {
  setupPolishUI();   // fire-and-forget; doesn't block scene loading
  mount3D({
    onSelectLight: (id) => {
      if (state.selectedId === id) return;
      state.selectedId = id;
      tree?.render();
      refreshProps();
      handlesAPI?.reposition();
      syncLightsToScene(state.lights, state.selectedId);
    },
    onUpdateLight: (id, patch) => {
      const L = state.lights.find((l) => l.id === id);
      if (!L) return;
      if (patch.position)  L.position  = patch.position;
      if (patch.direction) L.direction = patch.direction;
      if (patch.normal)    L.normal    = patch.normal;
      if ('target' in patch) L.target = patch.target;
      // Targeted lights derive direction from target - position; recompute after
      // any target OR position change so the beam tracks live.
      applyTargeting(L);
      // Metric sync: feet patches (calibrated gizmo/target drags) are
      // authoritative for feet; engine patches re-derive feet from engine.
      if (state.calibration && L.type !== 'reflector') {
        const feetPatch = patch.position_ft || 'target_ft' in patch || patch.direction_ft;
        if (feetPatch) {
          if (patch.position_ft) L.position_ft = patch.position_ft;
          if ('target_ft' in patch) L.target_ft = patch.target_ft;
          if (patch.direction_ft) L.direction_ft = patch.direction_ft;
          syncLightFromFeet(L, state.calibration);
          applyTargeting(L);
        } else {
          syncLightFromEngine(L, state.calibration);
        }
      }
      onChange();
      // Calibrated: the props pane shows feet fields that must follow gizmo
      // and target drags (the engine-space sliders never tracked drags).
      if (state.calibration && state.selectedId === id) refreshProps();
    },
    placement,
    getMedianDepth: () => state.subjectMedianDepth,
  });

  // Workspace badge in the header — hide for the default workspace so the
  // chrome stays clean for solo users; show "ws: alice" for namespaced URLs.
  const wsLabel = document.getElementById('workspace-label');
  if (wsLabel) {
    const ws = currentWorkspace();
    wsLabel.textContent = ws === 'default' ? '' : `ws: ${ws}`;
    wsLabel.hidden = ws === 'default';
  }

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

// 2D | Split | 3D view mode and the draggable divider. Every mode/ratio
// change fires a window 'resize' so fitCanvasWrap and the 3D renderer's
// resize re-measure against the new pane widths.
createSplitView({
  stageEl: document.getElementById('stage'),
  dividerEl: document.getElementById('stage-divider'),
  pane2dEl: document.getElementById('stage2d-wrap'),
  pane3dEl: document.getElementById('stage3d-wrap'),
  modeEl: document.getElementById('view-mode'),
  onLayout: () => window.dispatchEvent(new Event('resize')),
});

document.getElementById('export-btn').addEventListener('click', async () => {
  if (!state.sessionId) return;
  const body = {
    session_id: state.sessionId,
    lights: state.lights,
    ambient: state.ambient,
    ambient_subject: state.ambientLinked === false ? state.ambientSubject : null,
    ambient_background: state.ambientLinked === false ? state.ambientBackground : null,
    shadow_style: state.shadowStyle || 'off',
    output_format: 'png',
    output_bit_depth: 8,
    calibration: state.calibration ? stripCamera(state.calibration) : null,
  };
  const blob = await serverRender(body);
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${(state.sceneName || 'scene').replace(/[^\w-]+/g, '_')}-${Date.now()}.png`;
  document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
});

document.getElementById('export-layers-btn').addEventListener('click', async () => {
  if (!state.sessionId) return;
  const btn = document.getElementById('export-layers-btn');
  const origText = btn.textContent;
  btn.textContent = 'Exporting...';
  btn.disabled = true;
  try {
    const body = {
      session_id: state.sessionId,
      lights: state.lights,
      ambient: state.ambient,
      ambient_subject: state.ambientLinked === false ? state.ambientSubject : null,
      ambient_background: state.ambientLinked === false ? state.ambientBackground : null,
      shadow_style: state.shadowStyle || 'off',
      scene_name: state.sceneName || '',
      calibration: state.calibration ? stripCamera(state.calibration) : null,
    };
    const { blob, filename } = await renderLayers(body);
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a); a.click(); a.remove();
    URL.revokeObjectURL(url);
  } catch (err) {
    alert(`PSD export failed:\n${err.message}`);
  } finally {
    btn.textContent = origText;
    btn.disabled = false;
  }
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

// ─── Stage calibration ────────────────────────────────────────────────────
// Install (or remove, with null) a calibration record: solve the camera for
// this image, give every light feet coordinates, notify listeners, redraw+save.
let lastAppliedRecord = null;   // the panel's record object behind state.calibration
function applyCalibration(record) {
  lastAppliedRecord = record || null;
  state.calibration = record ? solveRecord(record, state.height / state.width) : null;
  if (state.calibration) migrateLightsToFeet(state.lights, state.calibration);
  else for (const L of state.lights) { clearMetric(L); clampEnginePosition(L); }   // keep FOH lights reachable
  document.dispatchEvent(new CustomEvent('relight:calibration', { detail: state.calibration }));
  redrawAndSave();
  handlesAPI?.reposition();   // edge arrows / hidden handles follow the calibration state
}

// Server-side metric-depth cross-check of a just-applied record. Persists
// depth_check on the live calibration when the model disagrees by more than
// 20% (and the record is still the applied one); returns the server's answer
// for the panel's warning. Missing model, offline, timeout: all silent.
async function crossCheckCalibration(record) {
  if (!state.sceneId) return null;
  const res = await checkCalibration(state.sceneId, record);
  if (res?.available && res.median_error_pct > 20
      && state.calibration && record === lastAppliedRecord) {
    state.calibration.depth_check = { median_error_pct: res.median_error_pct, warned: true };
    scheduleSave();
  }
  return res;
}
// Hooks for the parity spec and console use.
window.__applyCalibration = () => applyCalibration(state.calibration);
window.__syncMetricLights = () => { if (state.calibration) migrateLightsToFeet(state.lights, state.calibration); };
window.__redraw = () => redraw();

// ─── Display units (ft | m) and the calibrate badge ───────────────────────
// Units are a viewer preference: stored values stay in feet, only the props
// pane and the badge convert for display.
const UNITS_KEY = 'photo-relight:units';
const unitToggle = document.getElementById('unit-toggle');
const calibrateBtn = document.getElementById('calibrate-btn');
try { state.units = localStorage.getItem(UNITS_KEY) === 'm' ? 'm' : 'ft'; } catch {}

const NO_FIT_TITLE = 'No usable depth relief between the lip and back-line marks: upstage distances use a linear estimate (click to edit)';
function formatBadge(rec) {
  if (!rec) return 'Calibrate';
  const u = state.units || 'ft';
  const f = (ft) => toDisplay(ft, u).toFixed(1).replace(/\.0$/, '');
  const warn = rec.depth_fit ? '' : '⚠ ';      // spec: no depth fit is visible on the badge
  return `${warn}${f(rec.width_ft)} × ${f(rec.height_ft)} × ${f(rec.depth_ft)} ${u}`;
}
function updateBadge() {
  if (!calibrateBtn) return;
  const rec = state.calibration;
  calibrateBtn.textContent = formatBadge(rec);
  calibrateBtn.classList.toggle('is-calibrated', !!rec);
  calibrateBtn.classList.toggle('is-no-fit', !!rec && !rec.depth_fit);
  calibrateBtn.title = !rec
    ? 'Calibrate the stage so lights are placed in real-world units'
    : rec.depth_fit ? 'Stage calibration (click to edit)' : NO_FIT_TITLE;
}
function applyUnits(u) {
  state.units = u === 'm' ? 'm' : 'ft';
  try { localStorage.setItem(UNITS_KEY, state.units); } catch {}
  if (unitToggle) {
    for (const b of unitToggle.querySelectorAll('[data-unit]')) {
      b.setAttribute('aria-pressed', b.dataset.unit === state.units ? 'true' : 'false');
    }
  }
  document.dispatchEvent(new CustomEvent('relight:units', { detail: state.units }));
  updateBadge();
  refreshProps();
}
unitToggle?.addEventListener('click', (e) => {
  const b = e.target.closest('[data-unit]');
  if (b) applyUnits(b.dataset.unit);
});
// Calibration changes swap the props pane between engine-space and feet
// controls, so re-render it along with the badge; the 3D viewport rebuilds in
// the matching frame (no-op when it already holds this record) and re-syncs
// its light primitives.
document.addEventListener('relight:calibration', async (e) => {
  updateBadge();
  refreshProps();
  await setCalibration3D(e.detail, state.units);
  syncLightsToScene(state.lights, state.selectedId);
  frameStage3D();
});
document.addEventListener('relight:units', (e) => setUnits3D(e.detail));
applyUnits(state.units);

// ─── Calibration panel (five-click marking) ───────────────────────────────
const calibPanel = mountCalibrationPanel({
  panelEl: document.getElementById('calib-panel'),
  overlayEl: document.getElementById('calib-overlay'),
  canvasWrapEl: document.getElementById('canvas-wrap'),
  getState: () => state,
  sampleDepth: (u, v) => depthSampler?.sample(u, v) ?? NaN,
  onApply: applyCalibration,
  onClear: () => applyCalibration(null),
  onCrossCheck: crossCheckCalibration,
});
calibrateBtn?.addEventListener('click', () => {
  if (!state.sessionId) return;
  calibPanel?.open();
});
