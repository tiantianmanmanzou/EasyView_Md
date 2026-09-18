import type { Node as ProsemirrorNode } from 'prosemirror-model';
import type { EditorRuntimeContext } from '../../../runtime/editorRuntimeContext';
import {
  createCellPopupEditor,
  disposeCellPopupEditor,
  getCellPopupEditor,
  locateCellNode,
  saveCellPopupContent,
  handlePopupImageSelected,
} from './cellPopupEditor';

let activePopup: HTMLDivElement | null = null;
let activeCell: HTMLTableCellElement | null = null;
let activeRuntimeContext: EditorRuntimeContext | null = null;
let outsidePointerHandler: ((event: PointerEvent) => void) | null = null;
let escapeHandler: ((event: KeyboardEvent) => void) | null = null;
let repositionHandler: ((event: Event) => void) | null = null;

function closeActivePopup(): void {
  if (!activePopup) return;

  // Save edited content back into the cell on every exit path.
  const view = activeRuntimeContext?.getEditorView() ?? null;
  if (view && activeCell) {
    saveCellPopupContent(view, activeCell);
    view.focus();
  }
  disposeCellPopupEditor();
  activePopup.remove();
  activePopup = null;
  activeCell = null;
  activeRuntimeContext = null;
  if (outsidePointerHandler) document.removeEventListener('pointerdown', outsidePointerHandler, true);
  if (escapeHandler) document.removeEventListener('keydown', escapeHandler, true);
  if (repositionHandler) {
    document.removeEventListener('scroll', repositionHandler, true);
    window.removeEventListener('resize', repositionHandler);
    repositionHandler = null;
  }
  outsidePointerHandler = null;
  escapeHandler = null;
}

function ensureStyles(): void {
  if (document.getElementById('easyview-table-cell-popup-styles')) return;
  const style = document.createElement('style');
  style.id = 'easyview-table-cell-popup-styles';
  style.textContent = `
    /* The doubled linear-gradient flattens semi-transparent theme widget backgrounds
       the same way webview.scss does for its floating layers, so the popup is fully
       opaque and never shows the table/cell behind it. z-index sits above every
       webview layer (max elsewhere: 10050). */
    .easyview-table-cell-popup { position:fixed; z-index:100000; box-sizing:border-box; max-width:calc(100vw - 20px); overflow:auto; padding:16px 20px; border:1px solid var(--vscode-editorWidget-border, rgba(128,128,128,.3)); border-radius:8px; background:linear-gradient(var(--vscode-editorWidget-background, #252526), var(--vscode-editorWidget-background, #252526)), var(--vscode-editor-background, #1e1e1e); color:var(--vscode-editor-foreground, #1f2328); box-shadow:0 10px 28px rgba(0,0,0,.22); font:inherit; line-height:inherit; white-space:normal; overflow-wrap:anywhere; cursor:text; text-align:left; }
    .easyview-table-cell-popup:focus, .easyview-table-cell-popup .ProseMirror { outline:none; }
    .easyview-table-cell-popup--small { width:min(42vw, 480px); max-height:min(38vh, 320px); }
    .easyview-table-cell-popup--medium { width:min(62vw, 760px); max-height:min(52vh, 520px); }
    .easyview-table-cell-popup--large { width:min(72vw, 1080px); max-height:min(64vh, 680px); }
    /* EditorView nests a .ProseMirror inside the mount. Cancel the canvas's
       centered 832px reading column for every block in that nested editor. */
    .easyview-table-cell-popup.ProseMirror > *,
    .easyview-table-cell-popup .ProseMirror > * { max-width:none !important; margin-left:0 !important; margin-right:0 !important; text-align:left !important; }
    .easyview-table-cell-popup > :first-child { margin-top:0; }
    .easyview-table-cell-popup > :last-child { margin-bottom:0; }
    .easyview-table-cell-popup p { margin:0 0 12px; text-align:left !important; }
    .easyview-table-cell-popup ul,.easyview-table-cell-popup ol { margin:0 0 12px; padding-left:1.6em; text-align:left !important; }
    .easyview-table-cell-popup blockquote { margin:0 0 12px; padding-left:12px; border-left:3px solid var(--vscode-textBlockQuote-border, #888); text-align:left !important; }
    .easyview-table-cell-popup pre { max-width:100%; overflow:auto; padding:10px; border-radius:4px; background:var(--vscode-textCodeBlock-background, rgba(128,128,128,.12)); text-align:left !important; }
    .easyview-table-cell-popup img,.easyview-table-cell-popup video { max-width:100%; height:auto; }
    .easyview-table-cell-popup .table-wrapper { width:100% !important; max-width:none !important; overflow:auto; margin:8px 0 !important; }
    .easyview-table-cell-popup table { border-collapse:collapse; border-spacing:0; table-layout:fixed; width:100%; max-width:none; margin-left:0 !important; margin-right:0 !important; }
    /* !important beats cell alignment attrs written as inline text-align. */
    .easyview-table-cell-popup th,.easyview-table-cell-popup td { position:relative; box-sizing:border-box; min-width:0; max-width:none; padding:8px 12px; border:1px solid var(--vscode-editorWidget-border, rgba(128,128,128,.3)); text-align:left !important; vertical-align:top; white-space:normal; overflow-wrap:anywhere; word-break:break-word; }
    .easyview-table-cell-popup th { background:var(--vscode-editor-inactiveSelectionBackground, rgba(128,128,128,.12)); font-weight:600; }
    .easyview-table-cell-popup .easyview-table-cell-content { text-align:left !important; align-items:stretch !important; }
  `;
  document.head.appendChild(style);
}

function getPopupSize(node: ProsemirrorNode): 'small' | 'medium' | 'large' {
  const textLength = node.textContent?.trim().length ?? 0;
  let hasComplexBlock = false;
  let blockCount = 0;
  node.descendants((child) => {
    if (child.isBlock && child.type.name !== 'paragraph') blockCount += 1;
    if (['table', 'code_block', 'image', 'video', 'audio', 'math_block'].includes(child.type.name)) {
      hasComplexBlock = true;
    }
    return true;
  });
  if (!hasComplexBlock && textLength <= 160 && blockCount <= 2) return 'small';
  if (!hasComplexBlock && textLength <= 900 && blockCount <= 10) return 'medium';
  return 'large';
}

export function showTableCellContentPopup(cell: HTMLTableCellElement, runtime: EditorRuntimeContext): void {
  closeActivePopup();
  window.dispatchEvent(new Event('easyview-table-cell-popup-open'));
  ensureStyles();

  const view = runtime.getEditorView();
  if (!view) return;
  const located = locateCellNode(view, cell);
  if (!located) return;

  // A dedicated ProseMirror editor mounted inside the popup, giving the same
  // typing experience as the main editor (markdown shortcuts, undo, paste).
  const popup = document.createElement('div');
  popup.className = `easyview-table-cell-popup easyview-table-cell-popup--${getPopupSize(located.node)} ProseMirror`;
  popup.setAttribute('role', 'dialog');
  popup.setAttribute('aria-label', 'Edit table cell');
  const popupEditor = createCellPopupEditor(located.node, popup);
  if (!popupEditor) return;
  document.body.appendChild(popup);
  activePopup = popup;
  activeCell = cell;
  activeRuntimeContext = runtime;

  const padding = 10;

  // Anchor the popup to the cell's top-left corner so it reads as an
  // expansion of the cell itself rather than a detached second window.
  // Clamp only to keep the whole popup on screen when the cell hugs an edge.
  const placePopup = (): void => {
    if (!activePopup || !activeCell) return;
    const rect = activeCell.getBoundingClientRect();
    // Once the cell scrolls out of the viewport there is no anchor left;
    // close (and save) instead of leaving a floating window.
    if (
      rect.right < padding ||
      rect.bottom < padding ||
      rect.left > window.innerWidth - padding ||
      rect.top > window.innerHeight - padding
    ) {
      closeActivePopup();
      return;
    }
    const size = activePopup.getBoundingClientRect();
    const left = Math.max(0, Math.min(rect.left, window.innerWidth - size.width - padding));
    const top = Math.max(0, Math.min(rect.top, window.innerHeight - size.height - padding));
    activePopup.style.left = `${left}px`;
    activePopup.style.top = `${top}px`;
  };
  placePopup();

  // The popup sits on the cell, so keep it glued to the cell while the
  // document scrolls; the illusion breaks if it is left behind.
  repositionHandler = (event: Event) => {
    // Scrolling inside the popup must not move its anchor.
    if (event.target instanceof Node && activePopup?.contains(event.target)) return;
    placePopup();
  };
  document.addEventListener('scroll', repositionHandler, true);
  window.addEventListener('resize', repositionHandler);

  outsidePointerHandler = (event) => {
    if (!activePopup?.contains(event.target as Node)) closeActivePopup();
  };
  escapeHandler = (event) => {
    if (event.key === 'Escape') closeActivePopup();
  };
  requestAnimationFrame(() => {
    if (!activePopup) return;
    document.addEventListener('pointerdown', outsidePointerHandler!, true);
    document.addEventListener('keydown', escapeHandler!, true);
    // Focus the popup editor with the caret at the end of its content.
    getCellPopupEditor()?.focus();
  });
}

export function closeTableCellContentPopup(_runtime?: EditorRuntimeContext): void {
  closeActivePopup();
}

// Re-exported so index.ts can route `imageSelected` replies into the popup
// editor without importing the editor module directly.
export { handlePopupImageSelected as cellPopupImageSelected };
