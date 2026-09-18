/**
 * ContextMenu — custom right-click menu for the editor.
 * Provides Cut, Copy, Paste, and Paste as Text options.
 */

import type { EditorView } from 'prosemirror-view';
import type { MarkdownParser } from 'prosemirror-markdown';
import { handlePastePlainText, handlePasteFromClipboard } from '../editor/EditorEventHandlers';
import { createEditorDomContext, type EditorDomContext, type EasyViewEditorRoot } from '../runtime/editorDomContext';

interface ContextMenuOptions {
  view: EditorView;
  pasteParser: MarkdownParser;
  x: number;
  y: number;
}

/** Initialize one context menu owned by one editor root. */
export function initContextMenu(
  editorElement: HTMLElement,
  getView: () => EditorView | null,
  getPasteParser: () => MarkdownParser,
  root: EasyViewEditorRoot = document,
): () => void {
  const dom = createEditorDomContext(root);
  let disposed = false;
  let menuEl: HTMLElement | null = null;
  let menuPositionFrame: number | null = null;

  const getMenuEl = (): HTMLElement => {
    if (!menuEl) {
      menuEl = dom.document.createElement('div');
      menuEl.className = 'context-menu';
      dom.overlayRoot.appendChild(menuEl);
    }
    return menuEl;
  };

  const hide = (): void => {
    menuEl?.classList.remove('visible');
  };

  const show = ({ view, pasteParser, x, y }: ContextMenuOptions): void => {
    const menu = getMenuEl();
    menu.innerHTML = '';

    const items: { label: string; shortcut?: string; action: () => void }[] = [
      {
        label: 'Cut',
        shortcut: 'Ctrl+X',
        action: () => {
          dom.document.execCommand('cut');
          hide();
        },
      },
      {
        label: 'Copy',
        shortcut: 'Ctrl+C',
        action: () => {
          dom.document.execCommand('copy');
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
      const el = dom.document.createElement('div');
      el.className = 'context-menu-item';

      const labelSpan = dom.document.createElement('span');
      labelSpan.className = 'context-menu-label';
      labelSpan.textContent = item.label;
      el.appendChild(labelSpan);

      if (item.shortcut) {
        const shortcutSpan = dom.document.createElement('span');
        shortcutSpan.className = 'context-menu-shortcut';
        shortcutSpan.textContent = item.shortcut;
        el.appendChild(shortcutSpan);
      }

      el.addEventListener('mousedown', (event) => {
        event.preventDefault();
        event.stopPropagation();
        item.action();
      });
      menu.appendChild(el);
    }

    menu.style.left = `${x}px`;
    menu.style.top = `${y}px`;
    menu.classList.add('visible');

    if (menuPositionFrame !== null) dom.window.cancelAnimationFrame(menuPositionFrame);
    menuPositionFrame = dom.window.requestAnimationFrame(() => {
      const rect = menu.getBoundingClientRect();
      if (rect.right > dom.window.innerWidth) menu.style.left = `${x - rect.width}px`;
      if (rect.bottom > dom.window.innerHeight) menu.style.top = `${y - rect.height}px`;
      menuPositionFrame = null;
    });
  };

  const handleContextMenu = (event: MouseEvent): void => {
    if (disposed) return;
    const view = getView();
    if (!view) return;
    event.preventDefault();
    show({ view, pasteParser: getPasteParser(), x: event.clientX, y: event.clientY });
  };

  const handleRootMouseDown = (event: MouseEvent): void => {
    if (!disposed && menuEl && !menuEl.contains(event.target as Node)) hide();
  };
  const handleRootKeyDown = (event: KeyboardEvent): void => {
    if (!disposed && event.key === 'Escape') hide();
  };

  editorElement.addEventListener('contextmenu', handleContextMenu);
  dom.root.addEventListener('mousedown', handleRootMouseDown as EventListener);
  dom.root.addEventListener('keydown', handleRootKeyDown as EventListener);

  let cleanedUp = false;
  return (): void => {
    if (cleanedUp) return;
    cleanedUp = true;
    disposed = true;
    editorElement.removeEventListener('contextmenu', handleContextMenu);
    dom.root.removeEventListener('mousedown', handleRootMouseDown as EventListener);
    dom.root.removeEventListener('keydown', handleRootKeyDown as EventListener);
    if (menuPositionFrame !== null) dom.window.cancelAnimationFrame(menuPositionFrame);
    menuPositionFrame = null;
    hide();
    menuEl?.remove();
    menuEl = null;
  };
}
