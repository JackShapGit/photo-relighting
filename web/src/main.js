import {
  newState, newLightNode, newGroupNode, syncLights, findNode,
  ADD_LIGHT_ID, lightFromPreset, defaultSceneState,
  deleteNode, SCENE_ID,
} from './lights.js';
import { createPlacement } from './placement.js';
import { createDepthSampler } from './depth-sampler.js';
import {
  loadScene3D, mount3D, notifyPlacementPhase, refreshPointCloudColor, syncLightsToScene,
  setCalibration3D, setUnits3D, frameStage3D, setVenue3D,
} from './3d/index.js';
import { mountAreasOverlay } from './areas-overlay-2d.js';
import {
  prepare, listGobos, render as serverRender, renderLayers,
  listScenes, getScene, createScene, updateScene, renameScene,
  refineMask, getCapabilities, currentWorkspace, checkCalibration,
  listVenues, createVenue, getVenue, updateVenue, duplicateVenue, deleteVenue,
} from './api.js';
import { mergeVenueIntoCalibration, defaultHouse } from './rig/geometry.js';
import { recomputePositionsForHouse, recomputeBoomFixturesForHouse } from './rig/height-ref.js';
import { rigMode, buildRigTree } from './rig/tree-mirror.js';
import { syncRig, syncAllFixtures, detachFixture, detachAim } from './rig/fixture-sync.js';
import { applyFixturePreset } from './rig/presets.js';
import { mountRigTab, buildFixtureLight, nextOffset } from './rig/rig-tab.js';
import { openVenueEditor, badgeText } from './rig/venue-editor.js';
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
import { createPaneDivider, LEFT_TAB_KEY } from './pane-divider.js';
import {
  solveRecord, syncLightFromFeet, syncLightFromEngine, migrateLightsToFeet, clearMetric,
  syncLightsFromEngineEdits, clampEnginePosition,
} from './metric/light-metric.js';
import { toDisplay, parseLength } from './metric/units.js';
import { mountCalibrationPanel } from './metric/calibration-panel.js';
import { mountCubeOverlay } from './metric/cube-overlay-2d.js';
import { createDraftState, reduce as reduceDraft, serializeUndo, hydrateUndo } from './metric/calibration-draft.js';
import {
  guessCamera, marksFromCamera, clampStageDrag, applyHandleDrag, clampHouse, houseForDims, houseDragPatch, houseWidthPatch,
} from './metric/cube-geometry.js';
import { solveCamera, validateMarks } from './metric/calibration.js';
import { mountPlacement2D } from './placement-pane-2d.js';

const state = newState();
let tree = null;
let rigTab = null;           // Rig tab (mounted after the tree below)
let handlesAPI = null;
let depthSampler = null;     // rebuilt on each scene load; used by 2D placement
let placement = null;        // created once below
let placement2D = null;      // 2D pane placement adapter (assigned below)
let cubeOverlay = null;      // calibration cube on the photo (mounted below)
let calibPanel = null;       // calibration panel (mounted below)
// Calibration cube draft/applied/history state (reducer in calibration-draft.js).
// main.js owns it: the overlay and the panel read it, every change goes
// through dispatchDraft, and its latest history entry persists as
// state.calibration_undo.
state.cal_draft = createDraftState(null);
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
    calibration_undo: state.calibration_undo ?? null,   // one calibration Undo survives a reload
    units: state.units || 'ft',
    // Venue reference (Spec 2): the id plus an embedded copy so a deleted or
    // unreachable venue never breaks the scene. state.venue itself is live.
    venue_id: state.venue_id ?? null,
    venue_snapshot: state.venue_snapshot ?? null,
  };
}

// ─── Venue reference (Spec 2) ─────────────────────────────────────────────
const DEFAULT_GRID = { rows: 3, cols: 3, number_from_stage_left: false };

function venueFromCalibration(name, cal) {
  return {
    name: (name || '').trim() || 'Untitled venue',
    width_ft: cal.width_ft, height_ft: cal.height_ft, depth_ft: cal.depth_ft,
    grid: DEFAULT_GRID, focus_height_ft: 5, positions: [],   // server fills the starter rig
  };
}

// A venue record as the client uses it: the house envelope is always present
// (calibration cube; the API fills defaults on read, older snapshots may not).
function withHouse(v) {
  return v && !v.house ? { ...v, house: defaultHouse(v) } : v;
}

// Before a venue is written: heights stated against the house floor or
// ceiling are re-derived (pipe trims on the positions, fixture heights on
// booms) so they stay where the user stated them when the house changed.
function prepareVenueForSave(venue) {
  const house = venue.house || defaultHouse(venue);
  const positions = recomputePositionsForHouse(venue.positions, house);
  recomputeBoomFixturesForHouse(state.lights, positions, house);
  return { ...venue, house, positions };
}

// Resolve the scene's venue on load. Migration: a calibrated scene with no
// venue gets one named after itself (dimensions from the calibration, starter
// positions) and is saved. Returns true when the scene needs saving.
async function loadSceneVenue(scene, s) {
  state.venue_id = s.venue_id ?? null;
  state.venue_snapshot = s.venue_snapshot ?? null;
  state.venue = null;
  state.venueMissing = false;
  state.venueMigrated = false;
  const cal = s.calibration || null;
  let dirty = false;
  if (cal?.width_ft && !state.venue_id) {
    try {
      const v = withHouse(await createVenue(venueFromCalibration(scene.name, cal)));
      state.venue_id = v.id; state.venue = v; state.venue_snapshot = v;
      state.venueMigrated = true;
      dirty = true;
    } catch (e) {
      console.warn('venue migration failed; scene keeps its calibration dimensions', e);
    }
  }
  if (state.venue_id && !state.venue) {
    try {
      state.venue = withHouse(await getVenue(state.venue_id));
      if (JSON.stringify(state.venue) !== JSON.stringify(state.venue_snapshot)) {
        state.venue_snapshot = state.venue;
        dirty = true;
      }
    } catch (e) {
      // 404 (deleted) or unreachable: run from the embedded snapshot.
      state.venue = withHouse(state.venue_snapshot);
      state.venue_snapshot = state.venue;
      state.venueMissing = true;
      console.warn('venue unavailable; using the scene snapshot', e);
    }
  }
  return dirty;
}

// Keep the venue's dimensions in step with a calibration applied from the
// panel (the panel's dimension fields write to the venue); a scene without a
// venue gets one now rather than on its next load.
async function syncVenueWithCalibration(record) {
  if (!record || !state.sceneId) return;
  try {
    if (!state.venue_id) {
      const v = withHouse(await createVenue(venueFromCalibration(state.sceneName, record)));
      state.venue_id = v.id; state.venue = v; state.venue_snapshot = v; state.venueMissing = false;
    } else if (state.venue && !state.venueMissing
        && ['width_ft', 'height_ft', 'depth_ft'].some((k) => state.venue[k] !== record[k])) {
      const v = withHouse(await updateVenue(state.venue_id, prepareVenueForSave({
        ...state.venue, width_ft: record.width_ft, height_ft: record.height_ft, depth_ft: record.depth_ft,
      })));
      state.venue = v; state.venue_snapshot = v;
    } else {
      return;
    }
    updateBadge();
    tree?.render();     // a venue-less scene just gained one: rig mode starts here
    if (rigMode(state)) setLeftTab('rig');
    refreshVenueOverlays();
    scheduleSave();
  } catch (e) {
    console.warn('venue sync failed', e);
  }
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
    renderProps(state, c, redrawAndSave, onChange, structuralEdit);
  }
};

// A change that can regroup the tree or alter what the tables show: sync,
// redraw, save (onChange), then re-render the tree, the rig tab, and props.
function structuralEdit() {
  onChange();
  tree?.render();
  refreshProps();
}

function commitPlacedLight(L, insertAt) {
  insertLight(L, insertAt);
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
  // Spec 2 order: direct moves detach, the rig re-hangs attached fixtures,
  // then the Spec 1 engine-edit sync runs last so custom edits win.
  if (!state.calibration) return;
  const detached = syncRig(state.lights, state.venue, state.calibration);
  // A handle drag that detached a fixture moves it to the Custom group: the
  // tree must regroup now, not on the next structural change.
  if (detached && rigMode(state)) tree?.render();
}

// Put a new light into the tree. In rig mode the groups are generated from
// the venue (rebuildRigTree), so the requested slot is meaningless and may
// even be a stale array from a previous rebuild: append and let the next
// rebuild file the light under its position (Custom for a new one).
function insertLight(L, insertAt) {
  if (rigMode(state)) { state.tree.push(L); return; }
  const where = insertAt || { parentArr: state.tree, index: state.tree.length };
  where.parentArr.splice(where.index, 0, L);
}

// Re-flatten the lights and, in a calibrated scene with a venue, regenerate
// the tree's groups from the hang positions (spec: Lights tab in calibrated
// scenes). Light nodes keep their identity; only the group shells are rebuilt.
function rebuildRigTree() {
  syncLights(state);
  if (!rigMode(state)) return;
  state.tree = buildRigTree(state.lights, state.venue, state.tree);
  syncLights(state);
  const sel = state.selectedId;
  if (sel && sel !== SCENE_ID && sel !== ADD_LIGHT_ID && !findNode(state.tree, sel)) state.selectedId = SCENE_ID;
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
  let L;
  if (preset.kind === 'fixture') {
    // A theatre instrument (Spec 2): a Custom fixture of the chosen type.
    // The rig tab hangs it on a position; until then it is placed like any
    // other light (click-placement, or the default spot for a cyc bar).
    L = newLightNode({
      name: uniqueName(preset.label), type: 'spotlight',
      fixture: { type: preset.id, position_id: null, offset_ft: 0, area: null },
    });
    applyFixturePreset(L, preset.id);
    if (L.type === 'linear') {
      // A bar needs two engine endpoints; give it a short one at its position.
      const [x, y, z] = L.position;
      L.endpoint_a = [x - 0.1, y, z];
      L.endpoint_b = [x + 0.1, y, z];
    }
  } else {
    L = lightFromPreset(preset);
    L.name = uniqueName(preset.name);
  }
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

  // Reflector, cyc bar, or no assets yet: instant add at the default position.
  insertLight(L, insertAt);
  state.selectedId = L.id;
  tree?.render();
  refreshProps();
  onChange();
}

const onChange = () => {
  invalidatePolish();
  rebuildRigTree();
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
    state.calibration_undo = null;
    state.cal_draft = createDraftState(null);
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

  // Venue first (migrating a calibrated scene without one), then the
  // calibration: its stage dimensions mirror the venue, the camera is
  // re-solved against this image's aspect, and every light gets feet
  // coordinates. (Display units are a viewer preference kept in
  // localStorage, not restored from the scene.)
  const venueDirty = await loadSceneVenue(scene, s);
  const calRecord = mergeVenueIntoCalibration(s.calibration || null, state.venue);
  state.calibration = calRecord ? solveRecord(calRecord, state.height / state.width) : null;
  if (state.calibration) migrateLightsToFeet(state.lights, state.calibration);
  // Calibration cube: the draft mirrors the applied record (default pose when
  // there is none); the persisted history entry seeds one Undo.
  state.calibration_undo = s.calibration_undo ?? null;
  resetCalibrationDraft(state.calibration_undo);
  // Fixtures follow their venue: a position edited since the last load
  // moves the lights hung on it (spec: Venue editor).
  if (rigMode(state)) syncAllFixtures(state.lights, state.venue, state.calibration);

  tree.render();      // rig mode: regenerates the groups from the venue
  refreshProps();

  if (state.assetUrls) {
    fitCanvasWrap();
    const canvas = document.getElementById('canvas');
    await initRenderer(canvas);
    await setAssets(state.assetUrls, canvas);
    setVenue3D(state.venue, state.units);          // the load builds the rig overlay with the stage
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
  if (venueDirty) scheduleSave();     // persist the migrated venue reference / refreshed snapshot
}

async function runNewSceneFlow({ canCancel }) {
  while (true) {
    let venues = [];
    try { venues = await listVenues(); } catch (e) { console.warn('venue list', e); }
    const result = await openNewScenePopup({ canCancel, venues });
    if (!result) return null;     // cancelled
    try {
      setStatus('Preparing image…');
      const prepared = await prepare(result.file, result.mode, result.segmenter);
      // A new scene gets a fresh default light tree (Key + Rim), not the
      // current scene's lighting. Otherwise +New Scene would inherit your
      // last setup, which is rarely what you want. The picked venue (if any)
      // is referenced from the start; "New venue…" stays null until a
      // calibration creates one.
      const created = await createScene({
        name: result.name,
        sessionId: prepared.session_id,
        state: { ...defaultSceneState(), venue_id: result.venueId || null, venue_snapshot: null },
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
// Every tree render first regenerates the rig groups when in rig mode, so
// callers never have to know which mode the scene is in.
const treeView = mountTree(state, onTreeSelect, onChange, onRequestAddLight);
tree = { render() { rebuildRigTree(); treeView.render(); rigTab?.render(); refreshLeftTabs(); } };
refreshProps();

// ─── Rig tab (Spec 2): positions and fixtures tables ─────────────────────
rigTab = mountRigTab({
  rootEl: document.getElementById('rig-root'),
  getState: () => state,
  onVenueChange: applyVenueEdit,
  onLightsChange: structuralEdit,
  onSelect: onCanvasSelect,
  openVenueEditor: () => openVenueEditorForScene(),
  listVenues,
});

// ─── Venue editor (Spec 2): the house behind the scene ───────────────────
// Adopt a venue record as the scene's: live venue + snapshot, dimensions
// mirrored into the calibration (re-solved against this image; marks are
// unchanged), every light re-derived, tree/rig/props/3D refreshed, saved.
function adoptVenue(v, { missing = false } = {}) {
  v = withHouse(v);
  state.venue = v;
  state.venue_snapshot = v;
  state.venueMissing = missing;
  if (state.calibration) {
    const base = lastAppliedRecord || stripCamera(state.calibration);
    state.calibration = solveRecord(mergeVenueIntoCalibration(base, v), state.height / state.width);
    migrateLightsToFeet(state.lights, state.calibration);
    syncAllFixtures(state.lights, state.venue, state.calibration);
    document.dispatchEvent(new CustomEvent('relight:calibration', { detail: state.calibration }));
  }
  syncDraftWithApplied();
  structuralEdit();
  handlesAPI?.reposition();
  updateBadge();
  refreshVenueOverlays();
  scheduleSave();
}

// Both overlays follow the venue: 3D cells/bars rebuilt in place, 2D areas re-projected.
function refreshVenueOverlays() {
  setVenue3D(state.venue, state.units);
  areasOverlay?.render();
}

async function openVenueEditorForScene() {
  if (!state.venue || !state.venue_id) return null;
  if (state.venueMissing) return offerRecreateVenue();
  return openVenueEditor({
    venue: state.venue,
    units: state.units,
    onSave: async (venue) => {
      const v = await updateVenue(state.venue_id, prepareVenueForSave(venue));
      adoptVenue(v);
    },
    onDuplicate: async (name) => {
      const copy = await duplicateVenue(state.venue_id, name);
      // The server gives the copy fresh position ids (positions are copied in
      // order), so every fixture hung on the old venue follows by index.
      const idMap = new Map((state.venue.positions || []).map((p, i) => [p.id, copy.positions?.[i]?.id]));
      for (const L of state.lights) {
        const pid = L.fixture?.position_id;
        if (pid && idMap.get(pid)) L.fixture.position_id = idMap.get(pid);
      }
      state.venue_id = copy.id;            // the scene now points at the copy
      adoptVenue(copy);
    },
    onCalibrate: () => calibPanel?.open(),   // the marks still live in the calibration panel
    onDelete: async ({ force }) => {
      await deleteVenue(state.venue_id, { force });   // 409 propagates to the editor
      // Deleted: the scene keeps its embedded copy and shows "venue missing".
      adoptVenue(state.venue_snapshot, { missing: true });
    },
  });
}

// "Recreate venue from snapshot": a new server record from the embedded copy.
async function offerRecreateVenue() {
  if (!state.venue_snapshot) return null;
  if (!window.confirm(`Venue "${state.venue_snapshot.name}" is missing. Recreate it from this scene's copy?`)) return null;
  try {
    const { id, workspace_id, created_at, updated_at, ...body } = state.venue_snapshot;
    const v = await createVenue(body);
    state.venue_id = v.id;
    adoptVenue(v);
    return 'recreated';
  } catch (e) {
    console.warn('recreate venue failed', e);
    setStatus('Recreate venue failed');
    return null;
  }
}
window.__openVenueEditor = openVenueEditorForScene;   // console / spec hook
document.addEventListener('relight:units', () => rigTab?.render());
window.__rig = { buildFixtureLight, nextOffset };   // console / spec hook (pure builders)

// A rig-tab edit to the venue (positions): the live venue and its snapshot
// change at once so fixtures re-hang immediately; the server copy follows.
async function applyVenueEdit(venue) {
  venue = prepareVenueForSave(venue);
  state.venue = venue;
  state.venue_snapshot = venue;
  syncDraftWithApplied();
  syncAllFixtures(state.lights, state.venue, state.calibration);
  structuralEdit();
  updateBadge();
  refreshVenueOverlays();
  if (state.venue_id && !state.venueMissing) {
    try {
      const v = await updateVenue(state.venue_id, venue);
      state.venue = v; state.venue_snapshot = v;
    } catch (e) {
      console.warn('venue update failed', e);
      setStatus('Venue save failed');
    }
  }
  scheduleSave();
}

// ─── Left pane: Lights | Rig tabs and the draggable divider (Spec 2) ─────
// The Rig tab only makes sense in rig mode (calibrated scene with a venue);
// it opens by itself when such a scene loads. The pane width is remembered
// per tab so the Rig tables get room without widening the Lights tree.
const LEFT_TABS = ['lights', 'rig'];
const RIG_TAB_HINT = 'Calibrate the scene to build a rig';
const leftTabButtons = Array.from(document.querySelectorAll('#tree-pane .pane-tabs button[data-tab]'));
let leftTab = 'lights';
const paneDivider = createPaneDivider({
  paneEl: document.getElementById('tree-pane'),
  dividerEl: document.getElementById('pane-divider'),
  getTab: () => leftTab,
  onLayout: () => window.dispatchEvent(new Event('resize')),   // fitCanvasWrap + 3D resize listen
});

function setLeftTab(next, { persist = true } = {}) {
  const tab = LEFT_TABS.includes(next) && !(next === 'rig' && !rigMode(state)) ? next : 'lights';
  leftTab = tab;
  document.getElementById('tree-root').hidden = tab !== 'lights';
  document.getElementById('rig-root').hidden = tab !== 'rig';
  for (const b of leftTabButtons) b.setAttribute('aria-pressed', b.dataset.tab === tab ? 'true' : 'false');
  paneDivider?.applyTab(tab);
  if (persist) { try { localStorage.setItem(LEFT_TAB_KEY, tab); } catch {} }
  refreshLeftTabs();
}

// Enable/disable the Rig tab from the scene's mode; runs with every tree render.
function refreshLeftTabs() {
  const rig = rigMode(state);
  for (const b of leftTabButtons) {
    if (b.dataset.tab !== 'rig') continue;
    b.setAttribute('aria-disabled', rig ? 'false' : 'true');
    b.title = rig ? 'Hang positions and fixtures' : RIG_TAB_HINT;
  }
  if (!rig && leftTab === 'rig') setLeftTab('lights');
}

for (const b of leftTabButtons) {
  b.addEventListener('click', () => {
    if (b.getAttribute('aria-disabled') === 'true') return;
    setLeftTab(b.dataset.tab);
  });
}
{
  let storedTab = 'lights';
  try { storedTab = localStorage.getItem(LEFT_TAB_KEY) || 'lights'; } catch {}
  setLeftTab(storedTab, { persist: false });
}
window.__setLeftTab = setLeftTab;   // console / spec hook

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
      // Spec 2: a gizmo move detaches the fixture from its hang position
      // (Custom, coordinates kept); a re-aim drops its acting area.
      if (patch.position || patch.position_ft) detachFixture(L);
      if (patch.direction || patch.direction_ft || 'target' in patch || 'target_ft' in patch) detachAim(L);
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
  if (rigMode(state)) return;          // groups follow hang positions in a calibrated scene
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
  syncDraftWithApplied();     // cube: a record installed from outside the panel (specs, console) resets the draft
  document.dispatchEvent(new CustomEvent('relight:calibration', { detail: state.calibration }));
  redrawAndSave();
  handlesAPI?.reposition();   // edge arrows / hidden handles follow the calibration state
  tree?.render();             // rig mode may have switched on or off with the venue
  if (record) syncVenueWithCalibration(record);   // async; the scene keeps its venue on Clear
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
// Full change path (rig re-hang, engine sync, tree/handles/3D refresh, save):
// what the UI runs after any structural edit; for console checks and specs.
window.__onChange = () => { onChange(); tree?.render(); refreshProps(); };

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
  const warn = rec.depth_fit ? '' : '⚠ ';      // spec: no depth fit is visible on the badge
  if (state.venue && state.venueMissing) return `${warn}${state.venue.name} · venue missing ⚠`;
  if (state.venue) return `${warn}${badgeText(state.venue, u)}`;   // Spec 2: "<venue> · W × H × D"
  const f = (ft) => toDisplay(ft, u).toFixed(1).replace(/\.0$/, '');
  return `${warn}${f(rec.width_ft)} × ${f(rec.height_ft)} × ${f(rec.depth_ft)} ${u}`;
}
function updateBadge() {
  if (!calibrateBtn) return;
  const rec = state.calibration;
  calibrateBtn.textContent = formatBadge(rec);
  calibrateBtn.classList.toggle('is-calibrated', !!rec);
  calibrateBtn.classList.toggle('is-no-fit', !!rec && !rec.depth_fit);
  calibrateBtn.classList.toggle('is-dirty', !!state.cal_draft?.dirty);   // unapplied cube changes
  let title = !rec
    ? 'Calibrate the stage so lights are placed in real-world units'
    : rec.depth_fit ? 'Stage calibration (click to edit)' : NO_FIT_TITLE;
  if (rec && state.venue) {
    if (state.venueMissing) title = 'Recreate venue from snapshot';
    else {
      title = rec.depth_fit ? 'Edit the venue (click)' : `${NO_FIT_TITLE} · Venue: ${state.venue.name}`;
      if (state.venueMigrated) title += ' · created from this scene';
    }
  }
  calibrateBtn.classList.toggle('is-venue-missing', !!(rec && state.venue && state.venueMissing));
  calibrateBtn.title = title;
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
  refreshCalibrationUI();
  refreshProps();
  setLeftTab(rigMode(state) ? 'rig' : 'lights');   // Rig opens with a calibrated scene
  setVenue3D(state.venue, state.units);              // overlay built with the stage on the next load
  areasOverlay?.render();
  await setCalibration3D(e.detail, state.units);
  syncLightsToScene(state.lights, state.selectedId);
  frameStage3D();
});
document.addEventListener('relight:units', (e) => { setUnits3D(e.detail); areasOverlay?.render(); cubeOverlay?.render(); });

// ─── 2D "Areas" overlay (Spec 2): acting-area cells projected on the photo ─
const areasOverlay = mountAreasOverlay({
  overlayEl: document.getElementById('areas-overlay'),
  toggleEl: document.getElementById('show-areas'),
  getState: () => state,
});
window.addEventListener('resize', () => areasOverlay?.render());
window.__areasOverlay = areasOverlay;   // console / spec hook
applyUnits(state.units);

// ─── Calibration cube: draft state, preview camera, photo overlay, panel ──
// The stored record stays the single source of truth. Drags and typing edit
// a draft (marks, stage dims, house) that is re-solved into a preview camera
// for the overlay and the panel; Apply commits through applyCalibration and
// a venue save, Revert discards, Undo/Redo walk a per-scene history whose
// latest entry persists as state.calibration_undo.
const SHOW_STAGE_BOX_KEY = 'photo-relight:show-stage-box';
const SHOW_HOUSE_BOX_KEY = 'photo-relight:show-house-box';
const DEFAULT_DIMS = { width_ft: 40, height_ft: 20, depth_ft: 30 };
const FEET_FIELDS = ['position_ft', 'target_ft', 'direction_ft', 'endpoint_a_ft', 'endpoint_b_ft'];
const ENGINE_FIELDS = ['position', 'target', 'direction', 'endpoint_a', 'endpoint_b'];
const cloneJson = (v) => (v == null ? null : JSON.parse(JSON.stringify(v)));
const imageAspect = () => (state.width && state.height ? state.height / state.width : 0.75);
let previewCache = { key: null, cam: null };

// Stage dimensions for the draft: the venue's (mirrored into the record), else
// the record's, else the spec's 40 × 20 × 30 starting point.
function sceneDims() {
  const src = state.venue || state.calibration;
  return src && Number.isFinite(src.width_ft)
    ? { width_ft: src.width_ft, height_ft: src.height_ft, depth_ft: src.depth_ft }
    : { ...DEFAULT_DIMS };
}

/** The reducer's "applied" entry for the live scene: marks from the record, dims and house from the venue. */
function appliedFromState() {
  const cal = state.calibration;
  if (!cal?.marks) return null;
  return { marks: cloneJson(cal.marks), dims: sceneDims(), house: cloneJson(state.venue?.house) ?? null };
}

// A draft without marks (uncalibrated scene, or undone/cleared to none) shows
// the default pose: the box projected through the guessed camera.
function normalizeDraft(S) {
  if (!state.width || !state.height) return S;
  const d = S.draft;
  if (d?.marks && d.dims) return S;
  const dims = d?.dims || sceneDims();
  const house = d?.house || cloneJson(state.venue?.house) || defaultHouse(dims);
  const marks = d?.marks || marksFromCamera(guessCamera(dims, imageAspect()), dims);
  return { ...S, draft: { marks, dims, house } };
}

function resetCalibrationDraft(undoEntry = null) {
  state.cal_draft = normalizeDraft(hydrateUndo(createDraftState(appliedFromState()), undoEntry));
  previewCache = { key: null, cam: null };
}

function dispatchDraft(action) {
  let S = normalizeDraft(reduceDraft(state.cal_draft, action));
  // An estimated house was derived from the stage dims: it follows them until edited.
  if (action.type === 'edit' && action.patch?.dims && S.draft?.house?.estimated) {
    S = { ...S, draft: { ...S.draft, house: houseForDims(S.draft.house, S.draft.dims) } };
  }
  state.cal_draft = S;
  state.calibration_undo = serializeUndo(state.cal_draft);
  refreshCalibrationUI();
}

// After applyCalibration or a venue change: the draft's applied entry follows
// the live record (a no-op when Apply/Undo already put them in step).
function syncDraftWithApplied() {
  const applied = appliedFromState();
  const S = state.cal_draft;
  if (JSON.stringify(applied) === JSON.stringify(S.applied)) return;
  state.cal_draft = normalizeDraft({ ...S, applied, draft: cloneJson(applied), dirty: false });
  refreshCalibrationUI();
}

function refreshCalibrationUI() {
  refreshCubeToggles();
  cubeOverlay?.render();
  calibPanel?.render();
  updateBadge();
}

// Preview camera: the draft's marks and dims solved once per change.
function previewCamera() {
  const d = state.cal_draft?.draft;
  if (!d?.marks || !d.dims || !state.width) return null;
  const key = JSON.stringify([d.marks, d.dims, imageAspect()]);
  if (previewCache.key !== key) {
    const rec = { ...d.dims, marks: d.marks };
    let cam = null;
    if (validateMarks(rec).ok) {
      cam = solveCamera(rec, imageAspect());
      if (![cam.f, cam.dist_ft, cam.height_ft, cam.va_h, cam.k_y].every(Number.isFinite)) cam = null;
    }
    previewCache = { key, cam };
  }
  return previewCache.cam;
}

// ── toggles: each box remembered separately; both default to on while the
// scene is uncalibrated or the panel is open (the box is the calibration UI
// then), the stored value rules otherwise. A click while the default applies
// overrides it for the session and is remembered too.
const stageBoxToggle = document.getElementById('show-stage-box');
const houseBoxToggle = document.getElementById('show-house-box');
const BOX_TOGGLES = [['stage', stageBoxToggle, SHOW_STAGE_BOX_KEY], ['house', houseBoxToggle, SHOW_HOUSE_BOX_KEY]];
let boxOverride = { stage: null, house: null };
let boxesWereForced = null;
const readBoxToggle = (key) => { try { return localStorage.getItem(key) !== '0'; } catch { return true; } };
const boxesForced = () => !state.calibration || !!calibPanel?.isOpen();
function boxesShown() {
  const forced = boxesForced();
  if (forced !== boxesWereForced) { boxOverride = { stage: null, house: null }; boxesWereForced = forced; }
  const shown = {};
  for (const [kind, , key] of BOX_TOGGLES) shown[kind] = forced ? (boxOverride[kind] ?? true) : readBoxToggle(key);
  return shown;
}
function refreshCubeToggles() {
  const shown = boxesShown();
  for (const [kind, el] of BOX_TOGGLES) if (el) el.checked = shown[kind];
}
for (const [kind, el, key] of BOX_TOGGLES) {
  el?.addEventListener('change', () => {
    boxOverride[kind] = el.checked;
    try { localStorage.setItem(key, el.checked ? '1' : '0'); } catch {}
    cubeOverlay?.render();
  });
}

// ── overlay edits → draft ──
// Stage handles write marks (clamped so the solve always validates); house
// handles write feet through the preview camera (clamped to the house rules).
// Both return whether the drag was clamped so the handle can flash.
let houseDragOrigin = null;   // { key, startUv, house } for the house drag in progress
function onCubeDrag(kind, key, uv, startUv = null) {
  const d = state.cal_draft?.draft;
  if (kind === 'house') {
    const cam = previewCamera();
    if (!d?.house || !d.dims || !cam) return false;
    // A house edge moves by the pointer's travel since the press (not to the
    // pointer), so the handle parked at the image edge for an off-image wall
    // or ceiling still nudges the real one.
    if (!startUv) houseDragOrigin = null;
    else if (!houseDragOrigin || houseDragOrigin.startUv !== startUv || houseDragOrigin.key !== key) {
      houseDragOrigin = { key, startUv, house: cloneJson(d.house) };
    }
    const to = houseDragPatch(cam, key, uv);
    const [field] = Object.keys(to);
    const want = houseDragOrigin
      ? houseDragOrigin.house[field] + (to[field] - houseDragPatch(cam, key, houseDragOrigin.startUv)[field])
      : to[field];
    const house = applyHousePatch({ [field]: want });
    return !!house && Math.abs(house[field] - want) > 1e-6;
  }
  if (!d?.marks) return false;
  const clamped = clampStageDrag(d.marks, key, uv);
  // The top handle only moves vertically, so only v counts as a clamp there.
  const wasClamped = (key !== 'top' && Math.abs(clamped[0] - uv[0]) > 1e-6) || Math.abs(clamped[1] - uv[1]) > 1e-6;
  dispatchDraft({ type: 'edit', patch: { marks: applyHandleDrag(d.marks, key, clamped) } });
  return wasClamped;
}
function onCubeLabelEdit(kind, field, text) {
  const v = parseLength(text, state.units);
  if (!Number.isFinite(v)) return;
  if (kind === 'house') {
    const h = state.cal_draft?.draft?.house;
    if (!h) return;
    if (field === 'width_ft') { if (v > 0) applyHousePatch(houseWidthPatch(h, v)); }
    else if (field === 'ceiling_ft' || field === 'floor_drop_ft') applyHousePatch({ [field]: v });
    return;
  }
  if (!(v > 0)) return;
  dispatchDraft({ type: 'edit', patch: { dims: { [field]: v } } });
}
/** Clamp a house patch against the draft's dims and dispatch it; returns the clamped house (null when there is none). */
function applyHousePatch(patch) {
  const d = state.cal_draft?.draft;
  if (!patch || !d?.house || !d.dims) return null;
  const house = clampHouse(d.house, d.dims, patch);
  dispatchDraft({ type: 'edit', patch: { house } });
  return house;
}

cubeOverlay = mountCubeOverlay({
  overlayEl: document.getElementById('cube-overlay'),
  canvasWrapEl: document.getElementById('canvas-wrap'),
  getDraft: () => state.cal_draft?.draft || null,
  getPreviewCamera: previewCamera,
  getDims: () => state.cal_draft?.draft?.dims || null,
  getHouse: () => state.cal_draft?.draft?.house || null,
  getUnits: () => state.units,
  isShown: boxesShown,
  isDirty: () => !!state.cal_draft?.dirty,
  onDrag: onCubeDrag,
  onLabelEdit: onCubeLabelEdit,
});
window.addEventListener('resize', () => cubeOverlay?.render());

// ── history snapshots: what Undo restores (calibration, venue dims/house, fixture coordinates) ──
function historySnapshot() {
  const v = state.venue;
  return {
    calibration: state.calibration ? stripCamera(state.calibration) : null,
    venue: v ? {
      dims: { width_ft: v.width_ft, height_ft: v.height_ft, depth_ft: v.depth_ft },
      house: cloneJson(v.house) ?? null,
      default_height_ref: v.default_height_ref || 'deck',
    } : null,
    fixtures: state.lights.map((L) => {
      const f = { id: L.id };
      for (const k of [...FEET_FIELDS, ...ENGINE_FIELDS]) f[k] = cloneJson(L[k]) ?? null;
      return f;
    }),
  };
}
function restoreFixtureFields(fixtures) {
  if (!Array.isArray(fixtures)) return;
  const byId = new Map(fixtures.map((f) => [f.id, f]));
  for (const L of state.lights) {
    const f = byId.get(L.id);
    if (!f) continue;
    for (const k of FEET_FIELDS) { if (k in f) { if (f[k] == null) delete L[k]; else L[k] = cloneJson(f[k]); } }
    for (const k of ENGINE_FIELDS) {
      if (!(k in f)) continue;
      if (f[k] == null && (k === 'position' || k === 'direction')) continue;   // never blank a required engine field
      L[k] = cloneJson(f[k]);
    }
  }
}

// Venue write for Apply: dims from the record, house and default reference
// from the draft. Runs before applyCalibration so the mirrored dims are fresh.
// A scene without a venue gets one here (rather than in syncVenueWithCalibration).
async function saveVenueForCalibration(record, venuePatch) {
  if (!state.sceneId) return;
  const dims = { width_ft: record.width_ft, height_ft: record.height_ft, depth_ft: record.depth_ft };
  const house = houseForDims(venuePatch?.house || state.venue?.house || null, dims);
  const default_height_ref = venuePatch?.default_height_ref || state.venue?.default_height_ref || 'deck';
  try {
    if (!state.venue_id) {
      const v = withHouse(await createVenue({ ...venueFromCalibration(state.sceneName, record), house, default_height_ref }));
      state.venue_id = v.id; state.venue = v; state.venue_snapshot = v; state.venueMissing = false;
    } else if (state.venue) {
      const next = prepareVenueForSave({ ...state.venue, ...dims, house, default_height_ref });
      const v = state.venueMissing ? next : withHouse(await updateVenue(state.venue_id, next));
      state.venue = v; state.venue_snapshot = v;
    }
  } catch (e) {
    console.warn('venue save failed', e);
    setStatus('Venue save failed');
  }
}
async function restoreVenueFromEntry(entry) {
  if (!entry || !state.venue) return;    // a scene that had no venue keeps the one it gained (never orphan it)
  const next = prepareVenueForSave({
    ...state.venue, ...entry.dims,
    house: entry.house || state.venue.house, default_height_ref: entry.default_height_ref || 'deck',
  });
  try {
    const v = (state.venue_id && !state.venueMissing) ? withHouse(await updateVenue(state.venue_id, next)) : next;
    state.venue = v; state.venue_snapshot = v;
  } catch (e) {
    console.warn('venue restore failed', e);
    setStatus('Venue save failed');
  }
}

// ── Apply / Undo / Redo / Clear (the panel's buttons) ──
async function commitCalibration(record, venuePatch) {
  const snapshot = historySnapshot();                // the state being left
  dispatchDraft({ type: 'apply', snapshot });
  await saveVenueForCalibration(record, venuePatch);
  applyCalibration(record);
  structuralEdit();
}
async function restoreCalibrationEntry(entry, type) {
  if (!entry) return;
  const snapshot = historySnapshot();                // undo: fills the redo slot; redo: back onto the history
  dispatchDraft({ type, snapshot });
  restoreFixtureFields(entry.fixtures);
  await restoreVenueFromEntry(entry.venue);
  applyCalibration(entry.calibration ? cloneJson(entry.calibration) : null);
  structuralEdit();
}
async function clearCalibration() {
  const snapshot = historySnapshot();
  dispatchDraft({ type: 'clear', snapshot, draft: null });   // normalizeDraft installs the default pose
  applyCalibration(null);
  structuralEdit();
}

calibPanel = mountCalibrationPanel({
  panelEl: document.getElementById('calib-panel'),
  getState: () => state,
  getDraftState: () => state.cal_draft,
  getPreviewCamera: previewCamera,
  dispatch: dispatchDraft,
  onApplyCommit: commitCalibration,
  onUndoRestore: (entry) => restoreCalibrationEntry(entry, 'undo'),
  onRedoRestore: (entry) => restoreCalibrationEntry(entry, 'redo'),
  onClearCommit: clearCalibration,
  getUnits: () => state.units,
  getVenue: () => state.venue || null,   // prefill + note whenever the scene references a venue
  sampleDepth: (u, v) => depthSampler?.sample(u, v) ?? NaN,
  onCrossCheck: crossCheckCalibration,
  onToggle: () => refreshCalibrationUI(),   // the boxes default to shown while the panel is open
});
calibrateBtn?.addEventListener('click', () => {
  if (!state.sessionId) return;
  // Rig mode: the badge is the venue; otherwise it is the calibration panel.
  if (state.venue && state.venueMissing) { offerRecreateVenue(); return; }
  if (rigMode(state)) { openVenueEditorForScene(); return; }
  calibPanel?.open();
});
// Console / spec hooks for the cube.
window.__calDraft = () => state.cal_draft;
window.__calPreview = () => previewCamera();
window.__cubeOverlay = cubeOverlay;
window.__calPanel = calibPanel;
