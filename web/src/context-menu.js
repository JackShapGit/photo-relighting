// Tiny one-shot context menu. Call show({ x, y, items }) at the cursor;
// items are { label, cmd, disabled? } objects (or { divider: true }).
// Returns a Promise resolving to the picked cmd, or null if dismissed.

let menuEl = null;
let dismiss = null;

export function showContextMenu({ x, y, items }) {
  closeMenu();
  return new Promise((resolve) => {
    const root = document.createElement('div');
    root.className = 'context-menu';
    for (const it of items) {
      if (it.divider) {
        root.appendChild(document.createElement('hr'));
        continue;
      }
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = it.label;
      btn.disabled = !!it.disabled;
      btn.addEventListener('click', () => { resolve(it.cmd); closeMenu(); });
      root.appendChild(btn);
    }
    document.body.appendChild(root);
    menuEl = root;
    // Position, then nudge into the viewport if it overflows the right/bottom.
    root.style.left = `${x}px`;
    root.style.top = `${y}px`;
    const r = root.getBoundingClientRect();
    if (r.right > window.innerWidth) root.style.left = `${window.innerWidth - r.width - 4}px`;
    if (r.bottom > window.innerHeight) root.style.top = `${window.innerHeight - r.height - 4}px`;

    dismiss = () => { resolve(null); closeMenu(); };
    setTimeout(() => {
      document.addEventListener('mousedown', dismissOutside, { once: false });
      document.addEventListener('keydown', dismissEsc);
      window.addEventListener('blur', dismiss);
    }, 0);
  });
}

function dismissOutside(e) {
  if (!menuEl) return;
  if (menuEl.contains(e.target)) return;
  dismiss?.();
}

function dismissEsc(e) {
  if (e.key === 'Escape') dismiss?.();
}

function closeMenu() {
  if (menuEl) menuEl.remove();
  document.removeEventListener('mousedown', dismissOutside);
  document.removeEventListener('keydown', dismissEsc);
  window.removeEventListener('blur', dismiss);
  menuEl = null;
  dismiss = null;
}
