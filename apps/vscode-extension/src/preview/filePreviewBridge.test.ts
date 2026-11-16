import { beforeEach, describe, expect, it, vi } from 'vitest';
import ExcelJS from 'exceljs';
import { previewFileThemeStorageKey } from '@easyview/contracts';
import { LazyWorkbook } from '../../../../packages/preview-ui/src/spreadsheet/lazyWorkbook';

/**
 * Extension side of the preview toolbar: the webview → extension message bridge.
 * Save (xlsx/docx) arrives as `writeBytes`; the theme button as `writePreviewFileTheme`.
 * Bytes come from the real x-spreadsheet serialiser (LazyWorkbook) and are re-read with ExcelJS.
 */
const disk = new Map<string, Uint8Array>();
type WatchListener = (uri: { toString(): string }) => void;
const mocks = vi.hoisted(() => ({
  disk: undefined as unknown as Map<string, Uint8Array>,
  mtime: 1234,
  watchers: [] as Array<{ change: WatchListener[]; create: WatchListener[] }>,
}));

vi.mock('vscode', () => {
  const uri = (fsPath: string) => ({ scheme: 'file', fsPath, path: fsPath, toString: () => `file://${fsPath}`, with: () => uri(fsPath) });
  return {
    Uri: { file: uri, joinPath: (base: { fsPath: string }, ...parts: string[]) => uri([base.fsPath, ...parts].join('/')) },
    EventEmitter: class {
      event = () => ({ dispose() {} });
      fire() {}
      dispose() {}
    },
    RelativePattern: class { constructor(readonly base: unknown, readonly pattern: string) {} },
    window: { registerCustomEditorProvider: vi.fn() },
    workspace: {
      getWorkspaceFolder: () => ({ uri: uri('/ws') }),
      asRelativePath: (u: { fsPath: string }) => u.fsPath.replace('/ws/', ''),
      createFileSystemWatcher: () => {
        const watcher = { change: [] as WatchListener[], create: [] as WatchListener[] };
        mocks.watchers.push(watcher);
        return {
          onDidChange: (listener: WatchListener) => { watcher.change.push(listener); return { dispose() {} }; },
          onDidCreate: (listener: WatchListener) => { watcher.create.push(listener); return { dispose() {} }; },
          dispose() {},
        };
      },
      fs: {
        stat: async (u: { fsPath: string }) => { const b = mocks.disk.get(u.fsPath); if (!b) throw new Error('ENOENT'); return { size: b.byteLength, mtime: mocks.mtime }; },
        readFile: async (u: { fsPath: string }) => mocks.disk.get(u.fsPath)!,
        writeFile: async (u: { fsPath: string }, bytes: Uint8Array) => { mocks.disk.set(u.fsPath, bytes); },
      },
    },
  };
});

import * as vscode from 'vscode';
import { FilePreviewProvider } from './filePreviewProvider';

function fakePanel() {
  let onMessage: ((message: unknown) => Promise<void>) | undefined;
  let onViewState: (() => void) | undefined;
  const posted: Array<Record<string, unknown>> = [];
  const panel = {
    visible: true,
    webview: {
      options: {}, html: '', cspSource: 'vscode-resource:',
      asWebviewUri: (u: { toString(): string }) => {
        const web = (query = '') => ({ toString: () => `https://webview/${u.toString()}${query ? `?${query}` : ''}`, with: (change: { query?: string }) => web(change.query ?? '') });
        return web();
      },
      postMessage: async (message: Record<string, unknown>) => { posted.push(message); return true; },
      onDidReceiveMessage: (handler: (message: unknown) => Promise<void>) => { onMessage = handler; return { dispose() {} }; },
    },
    onDidChangeViewState: (handler: () => void) => { onViewState = handler; return { dispose() {} }; },
    onDidDispose: () => ({ dispose() {} }),
  };
  const setVisible = (visible: boolean) => { panel.visible = visible; onViewState?.(); };
  return { panel, posted, setVisible, send: (message: unknown) => onMessage!(message) };
}

const workspaceState = new Map<string, unknown>();
const context = {
  extensionUri: (vscode.Uri as any).file('/ext'),
  extension: { packageJSON: { version: 'test' } },
  globalState: { get: () => undefined, update: async () => undefined },
  workspaceState: { get: (key: string) => workspaceState.get(key), update: async (key: string, value: unknown) => { workspaceState.set(key, value); } },
};

async function open(file: string) {
  const provider = new FilePreviewProvider(context as any);
  const { panel, posted, setVisible, send } = fakePanel();
  const uri = (vscode.Uri as any).file(`/ws/${file}`);
  await provider.resolveCustomEditor(await provider.openCustomDocument(uri, {} as any, {} as any), panel as any, {} as any);
  const watcher = mocks.watchers.at(-1)!;
  const fileEvent = (kind: 'change' | 'create') => { for (const listener of watcher[kind]) listener(uri); };
  return { panel, posted, setVisible, send, fileEvent };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 200));

async function seedBook(): Promise<ArrayBuffer> {
  const book = new ExcelJS.Workbook(); const sheet = book.addWorksheet('Data');
  for (let r = 1; r <= 5; r += 1) for (let c = 1; c <= 4; c += 1) sheet.getCell(r, c).value = r * 10 + c;
  const bytes = new Uint8Array(await book.xlsx.writeBuffer());
  disk.set('/ws/book.xlsx', bytes);
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

beforeEach(() => { mocks.disk = disk; mocks.mtime = 1234; mocks.watchers.length = 0; disk.clear(); workspaceState.clear(); });

describe('VS Code preview toolbar bridge', () => {
  it('Save: toolbar edits serialised by the webview reach disk intact (bold, fill, border, merge, freeze, filter)', async () => {
    const original = await seedBook();
    const lazy = await LazyWorkbook.open(original);
    const data = await lazy.load(0);
    data.styles = [{ font: { bold: true }, bgcolor: '#ffc000', border: { top: ['thin', '#000000'], right: ['thin', '#000000'], bottom: ['thin', '#000000'], left: ['thin', '#000000'] } }];
    data.rows![1].cells![1].style = 0; // B2
    data.merges = ['B4:C4']; data.freeze = 'C3'; data.autofilter = { ref: 'A1:D5', filters: [] };
    const bytes = await lazy.save([{ index: 0, data }]);

    const { send, posted } = await open('book.xlsx');
    await send({ type: 'writeBytes', id: 'w1', encoding: 'base64', bytes: Buffer.from(bytes).toString('base64') });
    expect(posted.at(-1)).toMatchObject({ type: 'writeBytesResult', id: 'w1', ok: true, value: { size: bytes.byteLength, mtimeMs: 1234 } });

    const book = new ExcelJS.Workbook(); await book.xlsx.load(disk.get('/ws/book.xlsx')! as unknown as ExcelJS.Buffer);
    const ws = book.worksheets[0]; const b2 = ws.getCell('B2');
    expect(b2.font?.bold).toBe(true);
    expect((b2.fill as ExcelJS.FillPattern).fgColor?.argb).toMatch(/FFC000/i);
    expect(b2.border?.top?.style).toBe('thin'); expect(b2.border?.left?.style).toBe('thin');
    expect((ws.model as { merges?: string[] }).merges).toContain('B4:C4');
    expect(ws.views[0]).toMatchObject({ state: 'frozen', xSplit: 2, ySplit: 2 });
    expect(ws.autoFilter).toBe('A1:D5');
  });

  it('Save: rejects empty payloads and read-only routes without touching disk', async () => {
    await seedBook(); const before = disk.get('/ws/book.xlsx');
    const xlsx = await open('book.xlsx');
    await xlsx.send({ type: 'writeBytes', id: 'w2', encoding: 'base64', bytes: '' });
    expect(xlsx.posted.at(-1)).toMatchObject({ type: 'writeBytesResult', id: 'w2', ok: false });
    expect(disk.get('/ws/book.xlsx')).toBe(before);
    disk.set('/ws/a.pdf', new Uint8Array([1, 2, 3]));
    const pdf = await open('a.pdf');
    await pdf.send({ type: 'writeBytes', id: 'w3', encoding: 'base64', bytes: Buffer.from('x').toString('base64') });
    expect(pdf.posted.at(-1)).toMatchObject({ type: 'writeBytesResult', id: 'w3', ok: false });
    expect(Array.from(disk.get('/ws/a.pdf')!)).toEqual([1, 2, 3]);
  });

  it('Theme: the per-file theme button is persisted in workspace state and restored on reopen', async () => {
    await seedBook();
    const first = await open('book.xlsx');
    expect(first.panel.webview.html).toContain('data-easyview-theme="light"');
    await first.send({ type: 'writePreviewFileTheme', relativePath: 'book.xlsx', mode: 'dark' });
    expect(workspaceState.get(previewFileThemeStorageKey('book.xlsx'))).toBe('dark');
    await first.send({ type: 'writePreviewFileTheme', relativePath: 'book.xlsx', mode: 'purple' });
    expect(workspaceState.get(previewFileThemeStorageKey('book.xlsx'))).toBe('dark');
    const reopened = await open('book.xlsx');
    expect(reopened.panel.webview.html).toMatch(/"fileTheme":\s*"dark"/);
  });
});

describe('VS Code preview lifecycle', () => {
  it('re-renders after an external change, with a cache-busted content URL', async () => {
    await seedBook();
    const preview = await open('book.xlsx');
    const before = preview.panel.webview.html;
    mocks.mtime = 5678;
    disk.set('/ws/book.xlsx', new Uint8Array([1, 2, 3]));
    preview.fileEvent('create');
    await settle();
    expect(preview.panel.webview.html).not.toBe(before);
    expect(preview.panel.webview.html).toContain('book.xlsx?v=5678');
  });

  it('does not re-render after saving from the preview itself', async () => {
    await seedBook();
    const preview = await open('book.xlsx');
    mocks.mtime = 5678;
    await preview.send({ type: 'writeBytes', id: 'w', encoding: 'base64', bytes: Buffer.from('PK-saved').toString('base64') });
    const afterSave = preview.panel.webview.html;
    preview.fileEvent('change');
    await settle();
    expect(preview.panel.webview.html).toBe(afterSave);
  });

  it('keeps Office previews alive while hidden but releases other previews', async () => {
    await seedBook();
    const xlsx = await open('book.xlsx');
    const xlsxHtml = xlsx.panel.webview.html;
    xlsx.setVisible(false);
    expect(xlsx.panel.webview.html).toBe(xlsxHtml);

    disk.set('/ws/a.pdf', new Uint8Array([1, 2, 3]));
    const pdf = await open('a.pdf');
    pdf.setVisible(false);
    expect(pdf.panel.webview.html).not.toContain('a.pdf');
    pdf.setVisible(true);
    expect(pdf.panel.webview.html).toContain('a.pdf');
  });
});
