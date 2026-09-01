// Modal dialog for creating a new scene. Resolves to the picked
// { name, file, mode } once the user clicks Create, or null if cancelled
// (Cancel is hidden when canCancel === false — i.e. fresh DB, no scenes yet).

export function openNewScenePopup({ canCancel, title = 'New Scene' } = {}) {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `
      <div class="modal" role="dialog" aria-modal="true" aria-label="${title}">
        <h2>${title}</h2>
        <label class="modal-row">
          <span>Name</span>
          <input id="ns-name" type="text" placeholder="Untitled scene" />
        </label>
        <label class="modal-row">
          <span>Image</span>
          <input id="ns-file" type="file" title="JPEG, PNG, TIFF, HEIC, WEBP or camera raw (DNG, CR2/CR3, NEF, ARW, RAF, ORF, RW2)" />
        </label>
        <label class="modal-row">
          <span>Mode</span>
          <select id="ns-mode">
            <option value="interactive" selected>Interactive (1024)</option>
            <option value="quality">Quality (native)</option>
          </select>
        </label>
        <label class="modal-row">
          <span>Segmenter</span>
          <select id="ns-segmenter">
            <option value="rmbg" selected>RMBG-2.0 (default)</option>
            <option value="sam2">SAM2 (better edges)</option>
          </select>
        </label>
        <div class="modal-thumb-wrap">
          <img id="ns-thumb" alt="preview" hidden />
          <span id="ns-thumb-empty">Pick an image to preview…</span>
        </div>
        <div class="modal-error" id="ns-error" hidden></div>
        <div class="modal-actions">
          ${canCancel ? '<button id="ns-cancel" type="button">Cancel</button>' : ''}
          <button id="ns-create" type="button" disabled>Create Scene</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);

    const $ = (sel) => overlay.querySelector(sel);
    const nameInput = $('#ns-name');
    const fileInput = $('#ns-file');
    const modeSelect = $('#ns-mode');
    const segSelect = $('#ns-segmenter');
    const thumb = $('#ns-thumb');
    const thumbEmpty = $('#ns-thumb-empty');
    const errEl = $('#ns-error');
    const createBtn = $('#ns-create');
    const cancelBtn = $('#ns-cancel');

    let pickedFile = null;
    let objectUrl = null;

    function update() {
      createBtn.disabled = !nameInput.value.trim() || !pickedFile;
    }

    function showError(msg) {
      errEl.textContent = msg;
      errEl.hidden = !msg;
    }

    nameInput.addEventListener('input', update);
    nameInput.focus();

    fileInput.addEventListener('change', () => {
      const f = fileInput.files?.[0];
      pickedFile = f || null;
      if (objectUrl) { URL.revokeObjectURL(objectUrl); objectUrl = null; }
      if (!f) {
        thumb.hidden = true;
        thumb.removeAttribute('src');
        thumbEmpty.hidden = false;
        update();
        return;
      }
      objectUrl = URL.createObjectURL(f);
      thumb.src = objectUrl;
      thumb.onload = () => { thumb.hidden = false; thumbEmpty.hidden = true; };
      thumb.onerror = () => {
        thumb.hidden = true;
        thumbEmpty.hidden = false;
        thumbEmpty.textContent = 'Preview unavailable for this format.';
      };
      update();
    });

    cancelBtn?.addEventListener('click', cleanupAnd(null));

    createBtn.addEventListener('click', () => {
      const result = {
        name: nameInput.value.trim(),
        file: pickedFile,
        mode: modeSelect.value,
        segmenter: segSelect.value,
      };
      cleanupAnd(result)();
    });

    function cleanupAnd(value) {
      return () => {
        if (objectUrl) URL.revokeObjectURL(objectUrl);
        document.body.removeChild(overlay);
        resolve(value);
      };
    }
  });
}
