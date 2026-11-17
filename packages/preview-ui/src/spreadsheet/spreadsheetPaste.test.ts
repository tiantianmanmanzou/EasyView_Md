/** @vitest-environment happy-dom */
import { afterEach, expect, it } from 'vitest';
import { attachSpreadsheetPaste, parseClipboardTable } from './spreadsheetPaste';
import type { XsCellRangeLike, XsSheetDataLike, XsSpreadsheetLike } from './xSpreadsheetTypes';

function fakeSheet(cells: Record<string, string> = {}) {
  const changes: string[] = [];
  let clipboard: XsCellRangeLike | null = null;
  const data: XsSheetDataLike = {
    settings: { mode: 'edit' },
    selector: { range: { sri: 1, sci: 1, eri: 1, eci: 1 } },
    clipboard: { get range() { return clipboard; }, isClear: () => clipboard === null },
    rows: {
      len: 3,
      getCell: (ri, ci) => (`${ri},${ci}` in cells ? { text: cells[`${ri},${ci}`] } : null),
      setCellText: (ri, ci, text) => { cells[`${ri},${ci}`] = text; },
    },
    cols: { len: 3 },
    changeData: (callback) => { changes.push('change'); callback(); },
    clearClipboard: () => { clipboard = null; },
  };
  let reloads = 0;
  const spreadsheet: XsSpreadsheetLike = { sheet: { focusing: true, data, selector: { hideClipboard: () => undefined }, reload: () => { reloads++; } } };
  return { spreadsheet, data, cells, changes, copy: (range: XsCellRangeLike) => { clipboard = range; }, reloads: () => reloads };
}

function paste(target: EventTarget, text: string): ClipboardEvent {
  const event = new Event('paste', { bubbles: true, cancelable: true }) as ClipboardEvent;
  Object.defineProperty(event, 'clipboardData', { value: { getData: (type: string) => (type === 'text/plain' ? text : '') } });
  target.dispatchEvent(event);
  return event;
}

afterEach(() => {
  document.body.innerHTML = '';
});

it('parses plain, Excel and quoted clipboard text', () => {
  expect(parseClipboardTable('hello')).toEqual([['hello']]);
  expect(parseClipboardTable('a\tb\r\nc\td\r\n')).toEqual([['a', 'b'], ['c', 'd']]);
  expect(parseClipboardTable('a\nb\n')).toEqual([['a'], ['b']]);
  expect(parseClipboardTable('he said "hi"\tx')).toEqual([['he said "hi"', 'x']]);
  expect(parseClipboardTable('"line 1\nline 2"\t"say ""hi"""\n')).toEqual([['line 1\nline 2', 'say "hi"']]);
  expect(parseClipboardTable('a\t')).toEqual([['a', '']]);
  expect(parseClipboardTable('')).toEqual([]);
});

it('pastes external text from the selected cell as one undoable change and grows the grid', () => {
  const sheet = fakeSheet();
  const mount = document.createElement('div');
  document.body.append(mount);
  const dispose = attachSpreadsheetPaste(sheet.spreadsheet, mount);
  const event = paste(document.body, 'a\tb\tc\nd\n');
  expect(event.defaultPrevented).toBe(true);
  expect(sheet.cells).toEqual({ '1,1': 'a', '1,2': 'b', '1,3': 'c', '2,1': 'd' });
  expect(sheet.changes).toEqual(['change']);
  expect(sheet.data.cols.len).toBe(4);
  expect(sheet.reloads()).toBe(1);
  dispose();
});

it('leaves the sheet\'s own copy to the library but prefers newer external text', () => {
  const sheet = fakeSheet({ '0,0': 'A1', '0,1': '' });
  const mount = document.createElement('div');
  document.body.append(mount);
  const dispose = attachSpreadsheetPaste(sheet.spreadsheet, mount);
  sheet.copy({ sri: 0, sci: 0, eri: 0, eci: 1 });
  expect(paste(document.body, 'A1\t\n').defaultPrevented).toBe(false);
  expect(paste(document.body, 'fresh').defaultPrevented).toBe(true);
  expect(sheet.data.clipboard.isClear()).toBe(true);
  expect(sheet.cells['1,1']).toBe('fresh');
  dispose();
});

it('lets the cell editor receive the paste and ignores an unfocused sheet', () => {
  const sheet = fakeSheet();
  const mount = document.createElement('div');
  mount.innerHTML = '<div class="x-spreadsheet-editor" style="display:block"><textarea>14</textarea></div>';
  document.body.append(mount);
  const field = mount.querySelector('textarea')!;
  const dispose = attachSpreadsheetPaste(sheet.spreadsheet, mount);
  let reachedLibrary = false;
  window.addEventListener('paste', () => { reachedLibrary = true; }, { once: true });
  expect(paste(field, '+x').defaultPrevented).toBe(true);
  expect(field.value).toBe('14+x');
  expect(reachedLibrary).toBe(false);
  sheet.spreadsheet.sheet!.focusing = false;
  expect(paste(document.body, 'x').defaultPrevented).toBe(false);
  expect(sheet.cells).toEqual({});
  dispose();
});

it('treats the selector\'s hidden IME input as the grid, not a text field', () => {
  const sheet = fakeSheet();
  const mount = document.createElement('div');
  mount.innerHTML = '<div class="x-spreadsheet-selector"><div class="hide-input"><input></div></div>';
  document.body.append(mount);
  const dispose = attachSpreadsheetPaste(sheet.spreadsheet, mount);
  expect(paste(mount.querySelector('input')!, 'hello').defaultPrevented).toBe(true);
  expect(sheet.cells).toEqual({ '1,1': 'hello' });
  dispose();
});

it('runs clipboard shortcuts in the cell editor, whose keydown never reaches the host', () => {
  const sheet = fakeSheet();
  const mount = document.createElement('div');
  mount.innerHTML = '<div class="x-spreadsheet-editor"><textarea></textarea></div>';
  document.body.append(mount);
  const field = mount.querySelector('textarea')!;
  field.addEventListener('keydown', (event) => event.stopPropagation());
  const commands: string[] = [];
  const execCommand = document.execCommand;
  document.execCommand = (command: string) => { commands.push(command); return true; };
  const mac = /Mac|iPhone|iPad/.test(navigator.platform);
  const press = (key: string, shiftKey = false) => {
    const event = new KeyboardEvent('keydown', { key, shiftKey, metaKey: mac, ctrlKey: !mac, bubbles: true, cancelable: true });
    field.dispatchEvent(event);
    return event.defaultPrevented;
  };
  const dispose = attachSpreadsheetPaste(sheet.spreadsheet, mount);
  try {
    // Paste is intentionally not handled on keydown (see spreadsheetPaste.ts); Ctrl/Cmd+V must reach the paste event.
    expect([press('v'), press('c'), press('x'), press('a'), press('z'), press('Z', true), press('b')]).toEqual([false, true, true, true, true, true, false]);
    expect(commands).toEqual(['copy', 'cut', 'selectAll', 'undo', 'redo']);
  } finally {
    document.execCommand = execCommand;
    dispose();
  }
});

it('pastes into an open cell editor that has not taken focus yet', () => {
  const sheet = fakeSheet();
  const mount = document.createElement('div');
  mount.innerHTML = '<div class="x-spreadsheet-editor" style="display:block"><textarea>14</textarea></div>';
  document.body.append(mount);
  const field = mount.querySelector('textarea')!;
  const inputs: string[] = [];
  field.addEventListener('input', () => inputs.push(field.value));
  const dispose = attachSpreadsheetPaste(sheet.spreadsheet, mount);
  expect(paste(document.body, '+x').defaultPrevented).toBe(true);
  expect(inputs).toEqual(['14+x']);
  expect(sheet.cells).toEqual({});
  dispose();
});
