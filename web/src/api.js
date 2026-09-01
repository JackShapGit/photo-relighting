// Workspace namespace — read once from the URL (?ws=alice). Defaults to
// 'default' so people landing on the bare URL share one workspace. Append it
// to scene-CRUD endpoints so two people on different URLs never see each
// other's scene lists.
const WORKSPACE = (() => {
  try {
    const ws = new URLSearchParams(window.location.search).get('ws');
    return ws && /^[A-Za-z0-9_-]{1,32}$/.test(ws) ? ws : 'default';
  } catch {
    return 'default';
  }
})();

export function currentWorkspace() { return WORKSPACE; }

function wsUrl(path) {
  const sep = path.includes('?') ? '&' : '?';
  return `${path}${sep}workspace=${encodeURIComponent(WORKSPACE)}`;
}

export async function prepare(file, mode, segmenter = 'rmbg') {
  const fd = new FormData();
  fd.append('image', file);
  fd.append('mode', mode);
  fd.append('segmenter', segmenter);
  const r = await fetch('/prepare', { method: 'POST', body: fd });
  if (!r.ok) throw new Error(`/prepare: ${r.status} ${await r.text()}`);
  return r.json();
}

export async function render(body) {
  const r = await fetch('/render', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`/render: ${r.status}`);
  return r.blob();
}

export async function renderLayers(body) {
  const r = await fetch('/render/layers', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`/render/layers: ${r.status}`);
  const cd = r.headers.get('content-disposition') || '';
  const m = cd.match(/filename="?([^"]+)"?/i);
  const filename = m ? m[1] : 'relighting_export.psd';
  return { blob: await r.blob(), filename };
}

export async function listGobos() {
  const r = await fetch('/gobos');
  if (!r.ok) throw new Error(`/gobos: ${r.status}`);
  return r.json();
}

export async function refineMask(sessionId, points) {
  // points: [{ x, y, label }] in source-image pixel coords.
  const r = await fetch('/refine_mask', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      session_id: sessionId,
      points: points.map((p) => [p.x, p.y]),
      labels: points.map((p) => p.label),
    }),
  });
  if (!r.ok) throw new Error(`/refine_mask: ${r.status} ${await r.text()}`);
  return r.json();
}

// ─── Scenes API ──────────────────────────────────────────────────────────

export async function listScenes() {
  const r = await fetch(wsUrl('/scenes'));
  if (!r.ok) throw new Error(`/scenes: ${r.status}`);
  return r.json();
}

export async function getScene(id) {
  const r = await fetch(wsUrl(`/scenes/${id}`));
  if (!r.ok) throw new Error(`/scenes/${id}: ${r.status}`);
  return r.json();
}

export async function createScene({ name, sessionId, state }) {
  const r = await fetch(wsUrl('/scenes'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name, session_id: sessionId, state }),
  });
  if (!r.ok) throw new Error(`/scenes POST: ${r.status} ${await r.text()}`);
  return r.json();
}

export async function updateScene(id, state) {
  const r = await fetch(wsUrl(`/scenes/${id}`), {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ state }),
  });
  if (!r.ok) throw new Error(`/scenes PUT: ${r.status}`);
  return r.json();
}

export async function renameScene(id, name) {
  const r = await fetch(wsUrl(`/scenes/${id}/name`), {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name }),
  });
  if (!r.ok) throw new Error(`/scenes PATCH name: ${r.status}`);
  return r.json();
}

export async function deleteScene(id) {
  const r = await fetch(wsUrl(`/scenes/${id}`), { method: 'DELETE' });
  if (!r.ok) throw new Error(`/scenes DELETE: ${r.status}`);
  return r.json();
}

export async function exportSceneBlob(id) {
  const r = await fetch(wsUrl(`/scenes/${id}/export`));
  if (!r.ok) throw new Error(`/scenes export: ${r.status}`);
  // Pull the filename out of Content-Disposition so saved files match
  // the server's "{name}.relight.zip" convention.
  const cd = r.headers.get('content-disposition') || '';
  const m = cd.match(/filename="?([^"]+)"?/i);
  const filename = m ? m[1] : 'scene.relight.zip';
  return { blob: await r.blob(), filename };
}

export async function importScene(file) {
  const fd = new FormData();
  fd.append('file', file);
  const r = await fetch(wsUrl('/scenes/import'), { method: 'POST', body: fd });
  if (!r.ok) throw new Error(`/scenes import: ${r.status} ${await r.text()}`);
  return r.json();
}

// ─── Calibration cross-check ─────────────────────────────────────────────

// Optional metric-depth cross-check of a stage calibration record. The server
// answers { available: false, median_error_pct: null } when the metric model
// is not installed; callers treat every failure as "no opinion".
export async function checkCalibration(sceneId, calibration) {
  const r = await fetch(wsUrl(`/scenes/${sceneId}/calibration/check`), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ calibration }),
    signal: AbortSignal.timeout(30000),
  });
  if (!r.ok) throw new Error(`/scenes calibration/check: ${r.status}`);
  return r.json();
}

// ─── Polish API ──────────────────────────────────────────────────────────

export async function getCapabilities() {
  const r = await fetch('/healthz');
  if (!r.ok) throw new Error(`/healthz: ${r.status}`);
  const body = await r.json();
  return body.capabilities || { polish: false, segmenters: [] };
}

export async function polishScene({ sessionId, lights, ambient,
                                    ambientSubject = null, ambientBackground = null,
                                    shadowStyle,
                                    prompt = '', seed = null,
                                    outputFormat = 'png', outputBitDepth = 8,
                                    outputResolution = null, calibration = null }) {
  const r = await fetch('/polish', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      session_id: sessionId,
      lights,
      ambient,
      calibration,
      ambient_subject: ambientSubject,
      ambient_background: ambientBackground,
      shadow_style: shadowStyle,
      prompt,
      seed,
      output_format: outputFormat,
      output_bit_depth: outputBitDepth,
      output_resolution: outputResolution,
    }),
  });
  if (!r.ok) {
    const text = await r.text();
    const err = new Error(`/polish: ${r.status} ${text}`);
    err.status = r.status;
    throw err;
  }
  return r.blob();
}
