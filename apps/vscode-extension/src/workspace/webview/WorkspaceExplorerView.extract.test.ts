/** @vitest-environment jsdom */
import { expect, it, vi } from 'vitest';
import { WorkspaceExplorerView } from './WorkspaceExplorerView';
import type { WorkspaceExplorerEntry } from './workspace-explorer-messages';

interface MenuItem { label: string; action: () => void }
const view = WorkspaceExplorerView.prototype as unknown as {
  buildContextMenuItems(entry: WorkspaceExplorerEntry): MenuItem[];
  extractArchiveAt(relativePath: string): Promise<void>;
};
const entry = (name: string, writable = true): WorkspaceExplorerEntry => ({
  id: name, rootId: 'root', relativePath: `downloads/${name}`, name, kind: 'file', writable,
});

it('offers extraction only for writable archives Node can extract', () => {
  const owner = { extractArchiveAt: vi.fn(async () => undefined), post: vi.fn() };
  for (const name of ['资料.zip', 'bundle.tar.gz', 'plugin.vsix']) {
    const item = view.buildContextMenuItems.call(owner as never, entry(name)).find((candidate) => candidate.label === '解压到同名文件夹');
    expect(item).toBeDefined();
    item!.action();
    expect(owner.extractArchiveAt).toHaveBeenLastCalledWith(`downloads/${name}`);
  }
  for (const candidate of [entry('backup.7z'), entry('notes.md'), entry('资料.zip', false)]) {
    expect(view.buildContextMenuItems.call(owner as never, candidate).some((item) => item.label === '解压到同名文件夹')).toBe(false);
  }
});

it('selects the extracted folder and reloads the archive parent', async () => {
  const folder: WorkspaceExplorerEntry = { id: 'f', rootId: 'root', relativePath: 'downloads/资料 2', name: '资料 2', kind: 'directory', writable: true };
  const owner = {
    selected: new Set(['downloads/资料.zip']),
    primarySelected: 'downloads/资料.zip',
    anchor: 'downloads/资料.zip',
    requestOp: vi.fn(async (build: (requestId: string) => unknown) => {
      expect(build('r1')).toEqual({ type: 'extractArchive', requestId: 'r1', relativePath: 'downloads/资料.zip' });
      return { type: 'opResult', requestId: 'r1', ok: true, entry: folder };
    }),
    loadDirectory: vi.fn(async (_relativePath: string) => undefined),
    showError: vi.fn(),
  };
  await view.extractArchiveAt.call(owner as never, 'downloads/资料.zip');
  expect([...owner.selected]).toEqual(['downloads/资料 2']);
  expect(owner.primarySelected).toBe('downloads/资料 2');
  expect(owner.loadDirectory).toHaveBeenCalledWith('downloads');
  expect(owner.showError).not.toHaveBeenCalled();
});
