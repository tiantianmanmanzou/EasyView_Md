let activePopup: HTMLDivElement | null = null;
let outsidePointerHandler: ((event: PointerEvent) => void) | null = null;
let escapeHandler: ((event: KeyboardEvent) => void) | null = null;

function closeActivePopup(): void {
  activePopup?.remove();
  activePopup = null;
  if (outsidePointerHandler) document.removeEventListener('pointerdown', outsidePointerHandler, true);
  if (escapeHandler) document.removeEventListener('keydown', escapeHandler, true);
  outsidePointerHandler = null;
  escapeHandler = null;
}

function ensureStyles(): void {
  if (document.getElementById('easyview-table-cell-popup-styles')) return;
  const style = document.createElement('style');
  style.id = 'easyview-table-cell-popup-styles';
  style.textContent = `
    .easyview-table-cell-popup { position:fixed; z-index:1000; box-sizing:border-box; max-width:calc(100vw - 20px); overflow:auto; padding:16px 20px; border:1px solid var(--vscode-editorWidget-border, rgba(128,128,128,.3)); border-radius:8px; background:var(--vscode-editorWidget-background, var(--vscode-editor-background, #fff)); color:var(--vscode-editor-foreground, #1f2328); box-shadow:0 10px 28px rgba(0,0,0,.22); font:inherit; line-height:inherit; white-space:normal; overflow-wrap:anywhere; }
    .easyview-table-cell-popup--small { width:min(42vw, 480px); max-height:min(38vh, 320px); }
    .easyview-table-cell-popup--medium { width:min(62vw, 760px); max-height:min(52vh, 520px); }
    .easyview-table-cell-popup--large { width:min(72vw, 1080px); max-height:min(64vh, 680px); }
    /* Do not inherit the editor canvas's centered 832px reading column. */
    .easyview-table-cell-popup.ProseMirror > * { max-width:none !important; margin-left:0 !important; margin-right:0 !important; }
    .easyview-table-cell-popup > :first-child { margin-top:0; }
    .easyview-table-cell-popup > :last-child { margin-bottom:0; }
    .easyview-table-cell-popup p { margin:0 0 12px; }
    .easyview-table-cell-popup ul,.easyview-table-cell-popup ol { margin:0 0 12px; padding-left:1.6em; }
    .easyview-table-cell-popup blockquote { margin:0 0 12px; padding-left:12px; border-left:3px solid var(--vscode-textBlockQuote-border, #888); }
    .easyview-table-cell-popup table { border-collapse:collapse; border-spacing:0; table-layout:fixed; width:max-content; min-width:100%; max-width:none; margin:8px 0; background:transparent; }
    .easyview-table-cell-popup th,.easyview-table-cell-popup td { position:relative; box-sizing:border-box; min-width:0; max-width:none; padding:8px 12px; border:1px solid var(--vscode-editorWidget-border, rgba(128,128,128,.3)); text-align:left; vertical-align:top; white-space:normal; overflow-wrap:anywhere; word-break:break-word; }
    .easyview-table-cell-popup thead,.easyview-table-cell-popup tbody,.easyview-table-cell-popup tr { position:static !important; transform:none !important; }
    .easyview-table-cell-popup th { position:relative !important; top:auto !important; display:table-cell !important; background:var(--vscode-editor-inactiveSelectionBackground, rgba(128,128,128,.12)); font-weight:600; }
    .easyview-table-cell-popup th > .easyview-table-cell-content,.easyview-table-cell-popup td > .easyview-table-cell-content { position:static !important; display:block !important; width:auto !important; height:auto !important; min-height:0 !important; max-height:none !important; overflow:visible !important; padding:0 !important; transform:none !important; }
    .easyview-table-cell-popup pre { max-width:100%; overflow:auto; padding:10px; border-radius:4px; background:var(--vscode-textCodeBlock-background, rgba(128,128,128,.12)); }
    .easyview-table-cell-popup img,.easyview-table-cell-popup video { max-width:100%; height:auto; }
    .easyview-table-cell-popup .easyview-popup-column-resizer { position:absolute; z-index:2; top:0; right:-5px; width:10px; height:100%; cursor:col-resize; touch-action:none; }
    .easyview-table-cell-popup .easyview-popup-column-resizer::after { content:''; position:absolute; top:5px; bottom:5px; left:4px; width:2px; border-radius:2px; background:transparent; }
    .easyview-table-cell-popup .easyview-popup-column-resizer:hover::after,.easyview-table-cell-popup .easyview-popup-column-resizer.is-dragging::after { background:var(--vscode-focusBorder, #3794ff); }
  `;
  document.head.appendChild(style);
}

function copyRenderedCellContent(content: HTMLElement): DocumentFragment {
  const fragment = document.createDocumentFragment();
  Array.from(content.childNodes).forEach((node) => fragment.appendChild(node.cloneNode(true)));

  // Table NodeViews include resize grips and scroll wrappers intended for the
  // inline editor. A popup is read-only, so retain only the rendered table.
  fragment.querySelectorAll<HTMLElement>('.table-wrapper').forEach((wrapper) => {
    const table = wrapper.querySelector(':scope table') ?? wrapper.querySelector('table');
    if (table) wrapper.replaceWith(table.cloneNode(true));
  });
  fragment.querySelectorAll<HTMLTableElement>('table').forEach((table) => {
    // Editor tables carry column-resize widths and sticky-header positioning.
    // A popup needs an independent, fully visible reading layout instead.
    table.querySelectorAll('colgroup').forEach((colgroup) => colgroup.remove());
    table.removeAttribute('style');
    table.querySelectorAll<HTMLElement>('th, td').forEach((cell) => {
      cell.removeAttribute('style');
      Array.from(cell.attributes).forEach((attribute) => {
        if (attribute.name.startsWith('data-easyview-')) cell.removeAttribute(attribute.name);
      });
      const content = cell.querySelector(':scope > .easyview-table-cell-content') as HTMLElement | null;
      if (content) {
        content.removeAttribute('style');
        content.removeAttribute('data-easyview-vertical-alignment');
      }
    });
  });
  fragment.querySelectorAll<HTMLElement>('[contenteditable]').forEach((element) => {
    element.contentEditable = 'false';
  });
  return fragment;
}

function getPopupTableColumnWidths(table: HTMLTableElement, columnCount: number): number[] {
  const firstCell = table.querySelector('th, td') as HTMLElement | null;
  const font = firstCell ? getComputedStyle(firstCell).font : getComputedStyle(document.body).font;
  const canvas = document.createElement('canvas');
  const context = canvas.getContext('2d');
  if (context) context.font = font;
  const widths = Array.from({ length: columnCount }, () => 150);

  table.querySelectorAll('tr').forEach((row) => {
    let column = 0;
    Array.from(row.children).forEach((child) => {
      if (!(child instanceof HTMLTableCellElement)) return;
      const span = Math.max(1, child.colSpan);
      const text = child.textContent?.replace(/\s+/g, ' ').trim() ?? '';
      const measured = context ? context.measureText(text).width : text.length * 16;
      // Wide columns keep long prose readable in fewer lines. Cap the value so
      // each column remains practical; the popup's horizontal scrollbar covers
      // tables whose combined preferred width exceeds its viewport.
      const preferred = Math.max(150, Math.min(620, Math.ceil(measured + 32)));
      const perColumn = preferred / span;
      for (let offset = 0; offset < span && column + offset < widths.length; offset += 1) {
        widths[column + offset] = Math.max(widths[column + offset], perColumn);
      }
      column += span;
    });
  });
  return widths.map((width) => Math.round(width));
}

function enablePopupTableColumnResizing(popup: HTMLElement): void {
  popup.querySelectorAll<HTMLTableElement>('table').forEach((table) => {
    const firstRow = table.querySelector('thead tr') ?? table.querySelector('tr');
    if (!firstRow) return;
    const cells = Array.from(firstRow.children).filter(
      (cell): cell is HTMLTableCellElement => cell instanceof HTMLTableCellElement,
    );
    if (cells.length < 2 || cells.some((cell) => cell.colSpan > 1)) return;

    const widths = getPopupTableColumnWidths(table, cells.length);
    const colgroup = document.createElement('colgroup');
    widths.forEach((width) => {
      const col = document.createElement('col');
      col.style.width = `${width}px`;
      colgroup.appendChild(col);
    });
    table.prepend(colgroup);
    table.style.width = `${Math.max(table.parentElement?.clientWidth ?? 0, widths.reduce((sum, width) => sum + width, 0))}px`;

    cells.slice(0, -1).forEach((cell, index) => {
      const handle = document.createElement('span');
      handle.className = 'easyview-popup-column-resizer';
      handle.contentEditable = 'false';
      handle.setAttribute('aria-label', 'Resize table column');
      handle.addEventListener('pointerdown', (event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        event.stopPropagation();
        const leftCol = colgroup.children[index] as HTMLTableColElement;
        const rightCol = colgroup.children[index + 1] as HTMLTableColElement;
        const leftStart = leftCol.getBoundingClientRect().width;
        const rightStart = rightCol.getBoundingClientRect().width;
        const pointerId = event.pointerId;
        handle.setPointerCapture(pointerId);
        handle.classList.add('is-dragging');
        const onMove = (moveEvent: PointerEvent) => {
          const delta = moveEvent.clientX - event.clientX;
          const nextLeft = Math.max(100, Math.min(leftStart + rightStart - 100, leftStart + delta));
          leftCol.style.width = `${nextLeft}px`;
          rightCol.style.width = `${leftStart + rightStart - nextLeft}px`;
        };
        const onEnd = () => {
          handle.classList.remove('is-dragging');
          window.removeEventListener('pointermove', onMove);
          window.removeEventListener('pointerup', onEnd);
          window.removeEventListener('pointercancel', onEnd);
        };
        window.addEventListener('pointermove', onMove);
        window.addEventListener('pointerup', onEnd, { once: true });
        window.addEventListener('pointercancel', onEnd, { once: true });
      });
      cell.appendChild(handle);
    });
  });
}

function getPopupSize(content: HTMLElement): 'small' | 'medium' | 'large' {
  const textLength = content.textContent?.trim().length ?? 0;
  const hasComplexBlock = Boolean(content.querySelector('table, pre, img, video, .table-wrapper'));
  const blockCount = content.querySelectorAll('p, li, blockquote, h1, h2, h3, h4, h5, h6').length;
  if (!hasComplexBlock && textLength <= 160 && blockCount <= 2) return 'small';
  if (!hasComplexBlock && textLength <= 900 && blockCount <= 10) return 'medium';
  return 'large';
}

export function showTableCellContentPopup(cell: HTMLTableCellElement): void {
  closeActivePopup();
  window.dispatchEvent(new Event('easyview-table-cell-popup-open'));
  ensureStyles();

  const content = cell.querySelector(':scope > .easyview-table-cell-content') as HTMLElement | null;
  if (!content || !content.textContent?.trim()) return;

  const popup = document.createElement('div');
  popup.className = `easyview-table-cell-popup easyview-table-cell-popup--${getPopupSize(content)} ProseMirror`;
  popup.setAttribute('role', 'dialog');
  popup.setAttribute('aria-label', 'Full table cell content');
  popup.contentEditable = 'false';
  popup.appendChild(copyRenderedCellContent(content));
  enablePopupTableColumnResizing(popup);
  document.body.appendChild(popup);
  activePopup = popup;

  const rect = cell.getBoundingClientRect();
  const margin = 10;
  const popupRect = popup.getBoundingClientRect();
  let left = Math.min(Math.max(margin, rect.left), window.innerWidth - popupRect.width - margin);
  let top = rect.bottom + margin;
  if (top + popupRect.height > window.innerHeight - margin) top = rect.top - popupRect.height - margin;
  top = Math.max(margin, Math.min(top, window.innerHeight - popupRect.height - margin));
  left = Math.max(margin, left);
  popup.style.left = `${left}px`;
  popup.style.top = `${top}px`;

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
  });
}

export function closeTableCellContentPopup(): void {
  closeActivePopup();
}
