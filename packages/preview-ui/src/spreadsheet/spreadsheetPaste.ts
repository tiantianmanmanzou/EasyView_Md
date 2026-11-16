/**
 * x-data-spreadsheet's text paste splits only on CRLF, drops the last line (expecting Excel's
 * trailing newline) and strips every quote, so a plain phrase copied elsewhere pastes nothing.
 * It also pastes its stale internal clipboard over newer system text, and its window listener
 * swallows paste while a cell is being edited. This capture-phase handler takes those cases over.
 */
import type { XsSheetDataLike, XsSpreadsheetLike } from './xSpreadsheetTypes';

/** Index of the quote closing a quoted field opened at `start`, or -1 when the field is not quoted. */
function closingQuote(text: string, start: number): number {
  for (let i = start + 1; i < text.length; i++) {
    if (text[i] !== '"') continue;
    if (text[i + 1] === '"') {
      i++;
      continue;
    }
    const next = text[i + 1];
    return next === undefined || next === '\t' || next === '\r' || next === '\n' ? i : -1;
  }
  return -1;
}

/** Tab-separated clipboard text (Excel / Numbers / WPS / plain text) as rows of cell texts. */
export function parseClipboardTable(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let i = 0;
  while (i < text.length) {
    const quoteEnd = text[i] === '"' ? closingQuote(text, i) : -1;
    let end = quoteEnd;
    if (quoteEnd >= 0) {
      row.push(text.slice(i + 1, quoteEnd).replace(/""/g, '"'));
      end = quoteEnd + 1;
    } else {
      end = i;
      while (end < text.length && text[end] !== '\t' && text[end] !== '\r' && text[end] !== '\n') end++;
      row.push(text.slice(i, end));
    }
    i = end;
    if (text[i] === '\t') {
      i++;
      if (i === text.length) row.push('');
    } else if (i < text.length) {
      i += text.startsWith('\r\n', i) ? 2 : 1;
      rows.push(row);
      row = [];
    }
  }
  if (row.length) rows.push(row);
  return rows;
}

function trimGrid(grid: string[][]): string[][] {
  const rows = grid.map((row) => {
    let end = row.length;
    while (end > 0 && row[end - 1] === '') end--;
    return row.slice(0, end);
  });
  while (rows.length && !rows[rows.length - 1].length) rows.pop();
  return rows;
}

/** Whether `text` is still what the sheet's own copy/cut put on the system clipboard. */
function matchesInternalClipboard(data: XsSheetDataLike, text: string): boolean {
  const range = data.clipboard.range;
  if (data.clipboard.isClear() || !range) return false;
  const cells: string[][] = [];
  for (let ri = range.sri; ri <= range.eri; ri++) {
    const row: string[] = [];
    for (let ci = range.sci; ci <= range.eci; ci++) {
      const value = data.rows.getCell(ri, ci)?.text;
      row.push(value == null ? '' : String(value));
    }
    cells.push(row);
  }
  return JSON.stringify(trimGrid(cells)) === JSON.stringify(trimGrid(parseClipboardTable(text)));
}

/** Writes `grid` from the selection's top-left cell as one undoable change. */
export function pasteGrid(data: XsSheetDataLike, grid: string[][]): void {
  const { sri, sci } = data.selector.range;
  data.changeData(() => {
    grid.forEach((row, r) => row.forEach((value, c) => data.rows.setCellText(sri + r, sci + c, value)));
    data.rows.len = Math.max(data.rows.len, sri + grid.length);
    data.cols.len = Math.max(data.cols.len, sci + Math.max(...grid.map(row => row.length)));
  });
}

/** The selector's hidden IME input takes focus with the selection; a paste there belongs to the grid. */
export const isTextField = (target: EventTarget | null): boolean => (
  target instanceof HTMLTextAreaElement
  || (target instanceof HTMLInputElement && !target.closest('.hide-input'))
  || (target instanceof HTMLElement && target.isContentEditable)
);

/** Copy/cut/select/undo — not paste: execCommand('paste') often claims success without inserting in Electron. */
const EDITOR_COMMANDS: Record<string, string> = { a: 'selectAll', c: 'copy', x: 'cut', z: 'undo' };

/**
 * The cell editor stops every keydown from bubbling, so a webview host (VS Code / Cursor on macOS) never
 * sees Cmd+C/X/A/Z and nothing happens. The field runs those edit commands itself. Paste is left for the
 * capture-phase paste listener, which reads clipboardData reliably.
 */
function editorShortcut(event: KeyboardEvent, mount: HTMLElement): void {
  const field = event.target;
  if (!(field instanceof HTMLTextAreaElement) || !field.closest('.x-spreadsheet-editor') || !mount.contains(field)) return;
  const mac = /Mac|iPhone|iPad/.test(navigator.platform);
  if (event.altKey || (mac ? !event.metaKey || event.ctrlKey : !event.ctrlKey || event.metaKey)) return;
  const key = event.key.toLowerCase();
  const command = key === 'z' && event.shiftKey ? 'redo' : event.shiftKey ? undefined : EDITOR_COMMANDS[key];
  if (command && field.ownerDocument.execCommand(command)) event.preventDefault();
}

function insertIntoEditorField(field: HTMLTextAreaElement, text: string, atCaret: boolean): void {
  field.focus();
  const start = atCaret ? field.selectionStart : field.value.length;
  const end = atCaret ? field.selectionEnd : field.value.length;
  field.setRangeText(text, start, end, 'end');
  field.dispatchEvent(new Event('input', { bubbles: true }));
}

/** Capture-phase paste handling for one spreadsheet instance. Returns a disposer. */
export function attachSpreadsheetPaste(spreadsheet: XsSpreadsheetLike, mount: HTMLElement): () => void {
  const view = mount.ownerDocument.defaultView ?? window;
  const onKeydown = (event: KeyboardEvent): void => editorShortcut(event, mount);
  const onPaste = (event: ClipboardEvent): void => {
    const sheet = spreadsheet.sheet;
    const data = sheet?.data;
    if (!sheet || !data || data.settings.mode === 'read') return;
    if (isTextField(event.target)) {
      const target = event.target;
      // Cell editor: apply clipboardData ourselves (native/execCommand paste is flaky in VS Code webviews).
      if (
        target instanceof HTMLTextAreaElement
        && target.closest('.x-spreadsheet-editor')
        && mount.contains(target)
      ) {
        const text = event.clipboardData?.getData('text/plain') ?? '';
        if (text) {
          event.preventDefault();
          event.stopPropagation();
          insertIntoEditorField(target, text, true);
          return;
        }
      }
      // Other toolbar fields: keep the browser's own paste away from the grid handler.
      if (target instanceof Node && mount.contains(target)) event.stopPropagation();
      return;
    }
    if (!sheet.focusing) return;
    const text = event.clipboardData?.getData('text/plain') ?? '';
    const editor = mount.querySelector<HTMLElement>('.x-spreadsheet-editor');
    const field = editor?.querySelector('textarea');
    if (editor && field && editor.style.display !== 'none') {
      // The editor is open but focuses its textarea a tick later; paste goes into it, not the cells.
      event.preventDefault();
      event.stopPropagation();
      insertIntoEditorField(field, text, field.ownerDocument.activeElement === field);
      return;
    }
    if (matchesInternalClipboard(data, text)) return;
    event.preventDefault();
    event.stopPropagation();
    if (!data.clipboard.isClear()) {
      data.clearClipboard();
      sheet.selector?.hideClipboard();
    }
    const grid = parseClipboardTable(text);
    if (!grid.length) return;
    pasteGrid(data, grid);
    sheet.reload?.();
  };
  view.addEventListener('paste', onPaste, true);
  view.addEventListener('keydown', onKeydown, true);
  return () => {
    view.removeEventListener('paste', onPaste, true);
    view.removeEventListener('keydown', onKeydown, true);
  };
}
