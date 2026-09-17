/**
 * ContextMenu — custom right-click menu for the editor.
 * Provides Cut, Copy, Paste, and Paste as Text options.
 */

import type { EditorView } from 'prosemirror-view';
import type { MarkdownParser } from 'prosemirror-markdown';
import { handlePastePlainText, handlePasteFromClipboard } from '../editor/EditorEventHandlers';

let menuEl: HTMLElement | null = null;

function getMenuEl(): HTMLElement {
  if (!menuEl) {
    menuEl = document.createElement('div');
    menuEl.className = 'context-menu';
    document.body.appendChild(menuEl);
  }
  return menuEl;
}

function hide() {
  if (menuEl) {
    menuEl.classList.remove('visible');
  }
}

interface ContextMenuOptions {
  view: EditorView;
  pasteParser: MarkdownParser;
  x: number;
  y: number;
}

export function showContextMenu({ view, pasteParser, x, y }: ContextMenuOptions) {
  const menu = getMenuEl();
  menu.innerHTML = '';

  const items: { label: string; shortcut?: string; action: () => void }[] = [
    {
      label: 'Cut',
      shortcut: 'Ctrl+X',
      action: () => {
        document.execCommand('cut');
        hide();
      },
    },
    {
      label: 'Copy',
      shortcut: 'Ctrl+C',
      action: () => {
        document.execCommand('copy');
        hide();
      },
    },
    {
      label: 'Paste',
      shortcut: 'Ctrl+V',
      action: () => {
        handlePasteFromClipboard(view, pasteParser);
        hide();
      },
    },
    {
      label: 'Paste as Text',
      shortcut: 'Ctrl+Shift+V',
      action: () => {
        handlePastePlainText(view);
        hide();
      },
    },
  ];

  for (const item of items) {
    const el = document.createElement('div');
    el.className = 'context-menu-item';

    const labelSpan = document.createElement('span');
    labelSpan.className = 'context-menu-label';
    labelSpan.textContent = item.label;
    el.appendChild(labelSpan);

    if (item.shortcut) {
      const shortcutSpan = document.createElement('span');
      shortcutSpan.className = 'context-menu-shortcut';
      shortcutSpan.textContent = item.shortcut;
      el.appendChild(shortcutSpan);
    }

    el.addEventListener('mousedown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      item.action();
    });

    menu.appendChild(el);
  }

  // Position menu, ensuring it stays within viewport
  menu.style.left = `${x}px`;
  menu.style.top = `${y}px`;
  menu.classList.add('visible');

  // Adjust if overflowing
  requestAnimationFrame(() => {
    const rect = menu.getBoundingClientRect();
    if (rect.right > window.innerWidth) {
      menu.style.left = `${x - rect.width}px`;
    }
    if (rect.bottom > window.innerHeight) {
      menu.style.top = `${y - rect.height}px`;
    }
  });
}

/** Initialize context menu on the editor element */
export function initContextMenu(editorElement: HTMLElement, getView: () => EditorView | null, getPasteParser: () => MarkdownParser) {
  editorElement.addEventListener('contextmenu', (e) => {
    const view = getView();
    if (!view) return;
    e.preventDefault();
    showContextMenu({ view, pasteParser: getPasteParser(), x: e.clientX, y: e.clientY });
  });

  // Hide on click outside or escape
  document.addEventListener('mousedown', (e) => {
    if (menuEl && !menuEl.contains(e.target as Node)) {
      hide();
    }
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') hide();
  });
}
