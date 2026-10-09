/** @vitest-environment happy-dom */
import { afterEach, expect, it, vi } from 'vitest';
import { WorkspaceExplorerView } from './WorkspaceExplorerView';
import { WorkspaceExplorer } from '../../../../desktop/src/renderer/workspace/WorkspaceExplorer';
import type { WorkspaceExplorerEntry } from './workspace-explorer-messages';

const entry: WorkspaceExplorerEntry = {
  id: 'document', rootId: 'workspace', name: '数据安全能力功能设计.md',
  relativePath: '功能设计/数据安全能力运营/数据安全能力功能设计.md', kind: 'file', writable: true,
};

afterEach(() => {
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

it.each(['extension', 'desktop'] as const)('%s submits rename once when Enter is followed by blur', async (host) => {
  vi.stubGlobal('requestAnimationFrame', vi.fn());
  let finish!: (result: unknown) => void;
  const request = vi.fn(() => new Promise((resolve) => { finish = resolve; }));
  const renamed = { ...entry, name: '新名称.md', relativePath: '功能设计/数据安全能力运营/新名称.md' };
  const prototype = (host === 'extension' ? WorkspaceExplorerView.prototype : WorkspaceExplorer.prototype) as unknown as {
    renderRenameInput(entry: WorkspaceExplorerEntry): HTMLInputElement;
    renameEntry(relativePath: string, name: string): Promise<void>;
  };
  const owner = {
    renameEntry: prototype.renameEntry,
    renamePath: entry.relativePath, renameRelativePath: entry.relativePath,
    setEditing: vi.fn(), findEntry: () => entry,
    requestOp: request, options: { api: { workspace: { rename: request } } },
    selected: new Set([entry.relativePath]), selectedRelativePaths: new Set([entry.relativePath]),
    loadDirectory: vi.fn(async () => undefined), post: vi.fn(), render: vi.fn(), showError: vi.fn(),
  };
  const input = prototype.renderRenameInput.call(owner as never, entry);
  document.body.append(input);
  input.value = renamed.name;
  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  input.dispatchEvent(new FocusEvent('blur'));
  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  expect(request).toHaveBeenCalledTimes(1);
  finish(host === 'extension' ? { ok: true, entry: renamed } : { ok: true, value: renamed });
  await vi.waitFor(() => expect(owner.loadDirectory).toHaveBeenCalledTimes(1));
  expect(owner.showError).not.toHaveBeenCalled();
});
