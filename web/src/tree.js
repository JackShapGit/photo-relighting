// Left-pane tree renderer. Owns all tree-mutating UX:
//   - Click row body         → select node
//   - Click eye icon         → toggle enabled (cascades on groups)
//   - Click chevron (groups) → toggle collapsed
//   - Right-click row        → context menu (Add Light / Group, Rename, Clone, Delete)
//   - Double-click name      → inline rename (Enter commits, Esc cancels)
//   - Drag a row             → drop above / below another row, or into a group
//
// All mutations are applied directly to state.tree, then onChange() is called
// so the host (main.js) can re-sync the flat lights array, remount canvas
// handles, and redraw.

import {
  SCENE_ID, cascadeEnabled, findNode, findParentArray,
  newGroupNode, cloneNode, deleteNode, moveNode, isInsideNode,
} from './lights.js';
import { showContextMenu } from './context-menu.js';

const SLOT_VARS = ['--slot-key', '--slot-fill', '--slot-rim'];

let draggedId = null;       // module-level so dragover can read it (dataTransfer is restricted there)

export function mountTree(state, onSelect, onChange, onRequestAddLight) {
  const root = document.getElementById('tree-root');

  function slotColor(light) {
    const idx = state.lights.indexOf(light);
    const v = getComputedStyle(document.documentElement)
      .getPropertyValue(SLOT_VARS[idx] || '').trim();
    return v || '#ffffff';
  }

  function render() {
    root.innerHTML = '';
    root.appendChild(makeSceneRow());
    for (const node of state.tree) root.appendChild(renderNode(node, 0));
    root.appendChild(makeRootDropzone());
  }

  // ─── Rendering ─────────────────────────────────────────────────────────

  function makeSceneRow() {
    const li = document.createElement('li');
    li.className = 'tree-row tree-scene';
    li.dataset.id = SCENE_ID;
    if (state.selectedId === SCENE_ID) li.classList.add('selected');
    li.appendChild(spacer(0));
    li.appendChild(span('tree-icon', '⌂'));
    li.appendChild(span('tree-name', 'Scene'));
    li.addEventListener('click', () => selectId(SCENE_ID));
    li.addEventListener('contextmenu', (e) => openContextMenu(e, null /* scene */));
    return li;
  }

  function renderNode(node, depth) {
    if (node.kind === 'light') return renderLightRow(node, depth);
    return renderGroupRow(node, depth);
  }

  function lightIcon(type) {
    const icons = {
      directional: '☀',
      point: '⊙',
      spotlight: '◉',
      reflector: '▭',
    };
    return icons[type] || '○';
  }

  function renderLightRow(L, depth) {
    const li = document.createElement('li');
    li.className = 'tree-row tree-light';
    li.dataset.id = L.id;
    if (state.selectedId === L.id) li.classList.add('selected');
    if (!L.enabled) li.classList.add('disabled');
    li.appendChild(spacer(depth));
    const dot = document.createElement('span');
    dot.className = 'tree-dot';
    dot.style.background = slotColor(L);
    li.appendChild(dot);
    li.appendChild(span('tree-icon', lightIcon(L.type)));
    li.appendChild(span('tree-name', L.name));
    li.appendChild(eyeButton(L));
    li.addEventListener('click', (e) => {
      if (e.target.closest('.tree-eye')) return;
      selectId(L.id);
    });
    li.addEventListener('dblclick', (e) => {
      if (e.target.closest('.tree-eye, .tree-chevron')) return;
      startRename(L, li);
    });
    li.addEventListener('contextmenu', (e) => openContextMenu(e, L));
    setupDrag(li, L);
    return li;
  }

  function renderGroupRow(G, depth) {
    const li = document.createElement('li');
    li.className = 'tree-row tree-group';
    li.dataset.id = G.id;
    if (state.selectedId === G.id) li.classList.add('selected');
    if (!G.enabled) li.classList.add('disabled');
    li.appendChild(spacer(depth));

    const chevron = document.createElement('span');
    chevron.className = 'tree-chevron';
    chevron.textContent = G.collapsed ? '▸' : '▾';
    chevron.addEventListener('click', (e) => {
      e.stopPropagation();
      G.collapsed = !G.collapsed;
      render();
    });
    li.appendChild(chevron);

    li.appendChild(span('tree-icon', '🗂'));
    li.appendChild(span('tree-name', G.name));
    li.appendChild(eyeButton(G));
    li.addEventListener('click', (e) => {
      if (e.target.closest('.tree-eye, .tree-chevron')) return;
      selectId(G.id);
    });
    li.addEventListener('dblclick', (e) => {
      if (e.target.closest('.tree-eye, .tree-chevron')) return;
      startRename(G, li);
    });
    li.addEventListener('contextmenu', (e) => openContextMenu(e, G));
    setupDrag(li, G);

    const wrap = document.createDocumentFragment();
    wrap.appendChild(li);
    if (!G.collapsed) for (const c of G.children) wrap.appendChild(renderNode(c, depth + 1));
    return wrap;
  }

  function eyeButton(node) {
    const btn = document.createElement('button');
    btn.className = 'tree-eye';
    btn.type = 'button';
    btn.innerHTML = node.enabled ? '👁' : '⊘';
    btn.title = node.enabled ? 'Disable' : 'Enable';
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      node.enabled = !node.enabled;
      if (node.kind === 'group') cascadeEnabled(node);
      render();
      onChange?.();
    });
    return btn;
  }

  function makeRootDropzone() {
    const d = document.createElement('li');
    d.className = 'tree-dropzone-root';
    d.textContent = 'Drop here to move to root';
    d.addEventListener('dragover', (e) => {
      if (!draggedId) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      d.classList.add('drop-active');
    });
    d.addEventListener('dragleave', () => d.classList.remove('drop-active'));
    d.addEventListener('drop', (e) => {
      e.preventDefault();
      d.classList.remove('drop-active');
      if (!draggedId) return;
      if (moveNode(state.tree, draggedId, state.tree, state.tree.length)) {
        render();
        onChange?.();
      }
    });
    return d;
  }

  function spacer(depth) {
    const s = document.createElement('span');
    s.className = 'tree-indent';
    s.style.width = `${depth * 14}px`;
    return s;
  }

  function span(cls, text) {
    const s = document.createElement('span');
    s.className = cls;
    s.textContent = text;
    return s;
  }

  function selectId(id) {
    if (state.selectedId === id) return;
    state.selectedId = id;
    render();
    onSelect?.();
  }

  // ─── Drag-and-drop ─────────────────────────────────────────────────────

  function setupDrag(li, node) {
    li.draggable = true;
    li.addEventListener('dragstart', (e) => {
      draggedId = node.id;
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', node.id);
      li.classList.add('dragging');
    });
    li.addEventListener('dragend', () => {
      draggedId = null;
      document.querySelectorAll('.tree-row.dragging, .drop-above, .drop-below, .drop-into')
        .forEach((el) => el.classList.remove('dragging', 'drop-above', 'drop-below', 'drop-into'));
      document.querySelectorAll('.tree-dropzone-root.drop-active')
        .forEach((el) => el.classList.remove('drop-active'));
    });

    // Compute drop mode from cursor Y position. Used by both dragover (for
    // visual feedback) and drop (for the actual mutation) — don't rely on
    // classList between them, since dragleave can strip classes when the
    // cursor enters a child element of the row.
    function computeDropMode(clientY) {
      const rect = li.getBoundingClientRect();
      const y = clientY - rect.top;
      if (node.kind === 'group' && y > rect.height * 0.25 && y < rect.height * 0.75) return 'into';
      return y < rect.height * 0.5 ? 'above' : 'below';
    }

    li.addEventListener('dragover', (e) => {
      if (!draggedId || draggedId === node.id) return;
      const parentArr = node.kind === 'group' ? node.children : null;
      if (parentArr && isInsideNode(state.tree, draggedId, parentArr)) {
        e.dataTransfer.dropEffect = 'none';
        return;
      }
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      const mode = computeDropMode(e.clientY);
      li.classList.remove('drop-above', 'drop-below', 'drop-into');
      li.classList.add(`drop-${mode}`);
    });
    li.addEventListener('dragleave', (e) => {
      // Only clear classes when the pointer truly leaves the row, not when
      // it enters a descendant element. relatedTarget is the element being
      // entered; if it's still inside li, this is a phantom leave.
      if (li.contains(e.relatedTarget)) return;
      li.classList.remove('drop-above', 'drop-below', 'drop-into');
    });
    li.addEventListener('drop', (e) => {
      e.preventDefault();
      li.classList.remove('drop-above', 'drop-below', 'drop-into');
      if (!draggedId || draggedId === node.id) return;
      const mode = computeDropMode(e.clientY);

      let targetArr, targetIdx;
      if (mode === 'into') {
        targetArr = node.children;
        targetIdx = targetArr.length;
        if (node.kind === 'group') node.collapsed = false;   // expand to reveal the moved node
      } else {
        const parent = findParentArray(state.tree, node.id);
        const idx = parent.indexOf(node);
        targetArr = parent;
        targetIdx = mode === 'above' ? idx : idx + 1;
      }
      if (moveNode(state.tree, draggedId, targetArr, targetIdx)) {
        render();
        onChange?.();
      }
    });
  }

  // ─── Inline rename ─────────────────────────────────────────────────────

  function startRename(node, rowEl) {
    const nameSpan = rowEl.querySelector('.tree-name');
    if (!nameSpan) return;
    const input = document.createElement('input');
    input.className = 'tree-rename';
    input.type = 'text';
    input.value = node.name;
    nameSpan.replaceWith(input);
    input.focus();
    input.select();
    let done = false;
    const finish = (save) => {
      if (done) return;
      done = true;
      if (save) {
        const t = input.value.trim();
        if (t) node.name = t;
      }
      render();
      onChange?.();
    };
    input.addEventListener('blur', () => finish(true));
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); finish(true); }
      else if (e.key === 'Escape') { e.preventDefault(); finish(false); }
    });
  }

  // ─── Context menu ──────────────────────────────────────────────────────

  async function openContextMenu(e, node) {
    e.preventDefault();
    e.stopPropagation();
    const items = [];
    // Add commands available everywhere (Scene, Group, Light)
    if (node === null || node.kind === 'group') {
      items.push({ label: '+ Add Light', cmd: 'add-light' });
      items.push({ label: '+ Add Group', cmd: 'add-group' });
    } else {
      // Light: Add adds as sibling
      items.push({ label: '+ Add Light (sibling)', cmd: 'add-light-sibling' });
      items.push({ label: '+ Add Group (sibling)', cmd: 'add-group-sibling' });
    }
    if (node !== null) {
      items.push({ divider: true });
      items.push({ label: 'Rename', cmd: 'rename' });
      items.push({ label: 'Clone', cmd: 'clone' });
      items.push({ label: 'Delete', cmd: 'delete' });
    }
    const cmd = await showContextMenu({ x: e.clientX, y: e.clientY, items });
    if (cmd) handleCommand(cmd, node);
  }

  function handleCommand(cmd, node) {
    switch (cmd) {
      case 'add-light':       return doAddLight(node);
      case 'add-group':       return doAddGroup(node);
      case 'add-light-sibling':  return doAddLightSibling(node);
      case 'add-group-sibling':  return doAddGroupSibling(node);
      case 'rename': {
        const li = root.querySelector(`.tree-row[data-id="${cssEscape(node.id)}"]`);
        if (li) startRename(node, li);
        return;
      }
      case 'clone':           return doClone(node);
      case 'delete':          return doDelete(node);
    }
  }

  function uniqueGroupName() {
    const taken = new Set();
    const walk = (arr) => {
      for (const n of arr) {
        if (n.kind === 'group') { taken.add(n.name); walk(n.children); }
      }
    };
    walk(state.tree);
    let n = 1;
    while (taken.has(`Group ${n}`)) n += 1;
    return `Group ${n}`;
  }

  function doAddLight(parentNode) {
    // Hand off to the host's picker flow; we just supply the insertion target.
    const arr = parentNode === null ? state.tree : parentNode.children;
    if (parentNode?.kind === 'group') parentNode.collapsed = false;
    onRequestAddLight?.({ parentArr: arr, index: arr.length });
  }

  function doAddGroup(parentNode) {
    const arr = parentNode === null ? state.tree : parentNode.children;
    const G = newGroupNode({ name: uniqueGroupName() });
    arr.push(G);
    if (parentNode?.kind === 'group') parentNode.collapsed = false;
    state.selectedId = G.id;
    render();
    onChange?.();
    onSelect?.();
  }

  function doAddLightSibling(node) {
    const parent = findParentArray(state.tree, node.id);
    const idx = parent.indexOf(node);
    onRequestAddLight?.({ parentArr: parent, index: idx + 1 });
  }

  function doAddGroupSibling(node) {
    const parent = findParentArray(state.tree, node.id);
    const idx = parent.indexOf(node);
    const G = newGroupNode({ name: uniqueGroupName() });
    parent.splice(idx + 1, 0, G);
    state.selectedId = G.id;
    render();
    onChange?.();
    onSelect?.();
  }

  function doClone(node) {
    const parent = findParentArray(state.tree, node.id);
    const idx = parent.indexOf(node);
    const copy = cloneNode(node);
    parent.splice(idx + 1, 0, copy);
    state.selectedId = copy.id;
    render();
    onChange?.();
    onSelect?.();
  }

  function doDelete(node) {
    const isGroup = node.kind === 'group';
    const childCount = isGroup ? countDescendantLights(node) : 0;
    let prompt = `Delete ${isGroup ? 'group' : 'light'} "${node.name}"?`;
    if (isGroup && childCount > 0) {
      prompt += `\nThis will also delete ${childCount} child light${childCount === 1 ? '' : 's'}.`;
    }
    if (!window.confirm(prompt)) return;
    const wasSelected = state.selectedId === node.id ||
      (isGroup && containsId(node, state.selectedId));
    deleteNode(state.tree, node.id);
    if (wasSelected) state.selectedId = SCENE_ID;
    render();
    onChange?.();
    if (wasSelected) onSelect?.();
  }

  function countDescendantLights(group) {
    let n = 0;
    for (const c of group.children) {
      if (c.kind === 'light') n += 1;
      else if (c.kind === 'group') n += countDescendantLights(c);
    }
    return n;
  }

  function containsId(group, id) {
    for (const c of group.children) {
      if (c.id === id) return true;
      if (c.kind === 'group' && containsId(c, id)) return true;
    }
    return false;
  }

  // CSS.escape isn't on every test runner; tiny shim.
  function cssEscape(id) {
    return String(id).replace(/[^a-zA-Z0-9_-]/g, (c) => `\\${c}`);
  }

  // ─── Keyboard shortcuts ────────────────────────────────────────────────
  // F2 → rename, Delete/Backspace → delete (with confirm), Ctrl/Cmd-D → clone.
  // Ignored when focus is in any text input/textarea/contenteditable so they
  // don't fire while the user is typing in a rename input or scene-name field.
  document.addEventListener('keydown', (e) => {
    const t = e.target;
    if (t && t.matches?.('input, textarea, select, [contenteditable="true"]')) return;
    if (!state.selectedId || state.selectedId === SCENE_ID) return;
    const node = findNode(state.tree, state.selectedId);
    if (!node) return;

    if (e.key === 'F2') {
      e.preventDefault();
      const li = root.querySelector(`.tree-row[data-id="${cssEscape(node.id)}"]`);
      if (li) startRename(node, li);
    } else if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault();
      doDelete(node);
    } else if ((e.ctrlKey || e.metaKey) && (e.key === 'd' || e.key === 'D')) {
      e.preventDefault();
      doClone(node);
    }
  });

  render();
  return { render };
}
