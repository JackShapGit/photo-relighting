/** Lightbox for viewing the polished image at native resolution.
 *
 * mountLightbox() attaches handlers to an existing DOM container. The HTML
 * structure lives in playground.html.
 */
export function mountLightbox({ rootEl, getBlobUrl }) {
  const imgEl = rootEl.querySelector('[data-polish-lightbox-img]');
  const closeBtn = rootEl.querySelector('[data-polish-lightbox-close]');
  const downloadPngBtn = rootEl.querySelector('[data-polish-lightbox-download-png]');
  const downloadJpegBtn = rootEl.querySelector('[data-polish-lightbox-download-jpeg]');

  function open() {
    const url = getBlobUrl();
    if (!url) return;
    imgEl.src = url;
    rootEl.classList.add('is-open');
  }

  function close() {
    rootEl.classList.remove('is-open');
    imgEl.src = '';
  }

  closeBtn.addEventListener('click', close);
  rootEl.addEventListener('click', (e) => {
    if (e.target === rootEl) close();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && rootEl.classList.contains('is-open')) close();
  });

  function download(filename) {
    const url = getBlobUrl();
    if (!url) return;
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
  }
  downloadPngBtn.addEventListener('click', () => download('polished.png'));
  downloadJpegBtn.addEventListener('click', () => download('polished.png'));

  return { open, close };
}
