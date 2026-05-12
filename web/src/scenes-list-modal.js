// Scenes-list modal: thumbnail + name + date for every scene in the DB.
// Click a row → resolves with that scene's id (caller loads it).
// Click delete → DELETE /scenes/{id} after confirmation, then refresh.
// Returns null if the user dismissed the modal without picking a scene.

import { listScenes, deleteScene, exportSceneBlob, importScene } from './api.js';

export function openScenesListModal({ currentSceneId } = {}) {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `
      <div class="modal modal-wide" role="dialog" aria-label="Scenes">
        <div class="modal-toolbar">
          <h2>Scenes</h2>
          <span class="modal-spacer"></span>
          <button id="scenes-import" type="button">Import .relight.zip</button>
          <input id="scenes-import-file" type="file" accept=".zip,application/zip" hidden />
        </div>
        <div id="scenes-list" class="scenes-list"></div>
        <div class="modal-actions">
          <button id="scenes-close" type="button">Close</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);

    const listEl = overlay.querySelector('#scenes-list');
    const closeBtn = overlay.querySelector('#scenes-close');
    const importBtn = overlay.querySelector('#scenes-import');
    const importFile = overlay.querySelector('#scenes-import-file');

    function close(value) {
      document.body.removeChild(overlay);
      resolve(value);
    }

    closeBtn.addEventListener('click', () => close(null));
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) close(null);
    });

    importBtn.addEventListener('click', () => importFile.click());
    importFile.addEventListener('change', async () => {
      const f = importFile.files?.[0];
      if (!f) return;
      importBtn.disabled = true;
      importBtn.textContent = 'Importing…';
      try {
        const created = await importScene(f);
        // Hand control back to the caller so it can load the new scene.
        close({ action: 'load', sceneId: created.id });
      } catch (e) {
        alert(`Import failed:\n${e.message}`);
        importBtn.disabled = false;
        importBtn.textContent = 'Import .relight.zip';
        importFile.value = '';
      }
    });

    async function refresh() {
      listEl.innerHTML = '<div class="scenes-empty">Loading…</div>';
      let scenes;
      try {
        scenes = await listScenes();
      } catch (e) {
        listEl.innerHTML = `<div class="scenes-empty">Failed to load scenes: ${e.message}</div>`;
        return;
      }
      if (scenes.length === 0) {
        listEl.innerHTML = '<div class="scenes-empty">No scenes yet. Create one with + New Scene.</div>';
        return;
      }
      listEl.innerHTML = '';
      for (const s of scenes) {
        listEl.appendChild(renderRow(s));
      }
    }

    function renderRow(s) {
      const row = document.createElement('div');
      row.className = 'scenes-row';
      if (s.id === currentSceneId) row.classList.add('current');

      const thumb = document.createElement('div');
      thumb.className = 'scenes-thumb';
      if (s.thumbnail_url) {
        const img = document.createElement('img');
        img.src = s.thumbnail_url;
        img.alt = '';
        thumb.appendChild(img);
      } else {
        thumb.classList.add('scenes-thumb-empty');
        thumb.textContent = '—';
      }
      row.appendChild(thumb);

      const meta = document.createElement('div');
      meta.className = 'scenes-meta';
      const name = document.createElement('div');
      name.className = 'scenes-name';
      name.textContent = s.name;
      const date = document.createElement('div');
      date.className = 'scenes-date';
      date.textContent = formatDate(s.updated_at);
      meta.appendChild(name);
      meta.appendChild(date);
      row.appendChild(meta);

      if (s.id === currentSceneId) {
        const tag = document.createElement('span');
        tag.className = 'scenes-current-tag';
        tag.textContent = 'current';
        row.appendChild(tag);
      }

      const exportBtn = document.createElement('button');
      exportBtn.className = 'scenes-export';
      exportBtn.type = 'button';
      exportBtn.textContent = 'Export';
      exportBtn.title = 'Download .relight.zip';
      exportBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        try {
          const { blob, filename } = await exportSceneBlob(s.id);
          const url = URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = url;
          a.download = filename;
          document.body.appendChild(a);
          a.click();
          a.remove();
          URL.revokeObjectURL(url);
        } catch (err) {
          alert(`Export failed:\n${err.message}`);
        }
      });
      row.appendChild(exportBtn);

      const del = document.createElement('button');
      del.className = 'scenes-delete';
      del.type = 'button';
      del.textContent = 'Delete';
      del.title = 'Delete scene';
      del.addEventListener('click', async (e) => {
        e.stopPropagation();
        if (!window.confirm(`Delete scene "${s.name}"?\nThis cannot be undone.`)) return;
        try {
          await deleteScene(s.id);
          await refresh();
        } catch (err) {
          alert(`Couldn't delete: ${err.message}`);
        }
      });
      row.appendChild(del);

      // Whole row is clickable for loading (except the Delete button).
      row.addEventListener('click', () => close({ action: 'load', sceneId: s.id }));
      return row;
    }

    refresh();
  });
}

function formatDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  // YYYY-MM-DD HH:MM in local time.
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
