/** @vitest-environment happy-dom */
import { expect, it, vi } from 'vitest';
import { WorkspaceExplorerView } from './WorkspaceExplorerView';
import type { WorkspaceExplorerEntry } from './workspace-explorer-messages';
import type { WorkspaceTreeDropTarget } from '@easyview/contracts';

const file = (relativePath: string, kind: WorkspaceExplorerEntry['kind'] = 'file'): WorkspaceExplorerEntry => ({
  id: relativePath, rootId: 'workspace', name: relativePath.split('/').at(-1)!, relativePath, kind, writable: true,
});
const prototype = WorkspaceExplorerView.prototype as unknown as {
  attachDragHandlers(row: HTMLElement, entry: WorkspaceExplorerEntry): void;
  orderedSelection(): string[];
  handleDrop(sources: string[], target: WorkspaceTreeDropTarget): Promise<void>;
};

it('drags the whole selection in on-screen order when the grabbed row is selected', () => {
  const owner = {
    selected: new Set(['c.md', 'a.md']), visibleRelativePaths: () => ['archive', 'a.md', 'b.md', 'c.md'],
    orderedSelection: prototype.orderedSelection, clearDropVisuals: vi.fn(), dragRelativePath: null, dragRelativePaths: [] as string[],
  };
  const grab = (entry: WorkspaceExplorerEntry) => {
    const row = document.createElement('div');
    prototype.attachDragHandlers.call(owner as never, row, entry);
    row.dispatchEvent(new Event('dragstart'));
    return owner.dragRelativePaths;
  };
  expect(grab(file('c.md'))).toEqual(['a.md', 'c.md']);
  expect(grab(file('b.md'))).toEqual(['b.md']);
  // Folders drag together too; an item inside a selected folder travels with that folder.
  owner.selected = new Set(['notes', 'docs/a.md', 'docs']);
  owner.visibleRelativePaths = () => ['archive', 'docs', 'docs/a.md', 'notes'];
  expect(grab(file('notes', 'directory'))).toEqual(['docs', 'notes']);
});

it('moves every dragged item into the target folder and keeps them selected', async () => {
  const requests: Array<Record<string, unknown>> = [];
  const owner = {
    entriesByDirectory: new Map([['archive', [file('archive/old.md')]]]),
    requestOp: vi.fn(async (build: (requestId: string) => Record<string, unknown>) => {
      const request = build(String(requests.length)); requests.push(request);
      if (request.type !== 'move') return { ok: true };
      const name = String(request.relativePath).split('/').at(-1)!;
      return { ok: true, entry: file(`${request.targetParentRelativePath}/${name}`) };
    }),
    ensureCustomSort: vi.fn(async () => true), reorderBefore: vi.fn(), showError: vi.fn(), post: vi.fn(),
    loadDirectory: vi.fn(async (_relativePath: string) => undefined), selected: new Set<string>(), expanded: new Set<string>(),
    primarySelected: null as string | null, anchor: null as string | null,
  };
  await prototype.handleDrop.call(owner as never, ['a.md', 'c.md'], { kind: 'into', relativePath: 'archive' });
  expect(requests.filter((request) => request.type === 'move').map((request) => request.relativePath)).toEqual(['a.md', 'c.md']);
  expect(requests.filter((request) => request.type === 'reorder').map((request) => request.movedName)).toEqual(['a.md', 'c.md']);
  expect([...owner.selected]).toEqual(['archive/a.md', 'archive/c.md']);
  expect(owner.post).toHaveBeenCalledWith({ type: 'setSelection', relativePaths: ['archive/a.md', 'archive/c.md'], anchorRelativePath: 'archive/a.md' });
  expect(owner.loadDirectory.mock.calls.map(([path]) => path).sort()).toEqual(['', 'archive']);
  expect(owner.showError).not.toHaveBeenCalled();

  requests.length = 0;
  await prototype.handleDrop.call(owner as never, ['docs', 'notes'], { kind: 'into', relativePath: 'archive' });
  expect(requests.filter((request) => request.type === 'move').map((request) => request.relativePath)).toEqual(['docs', 'notes']);
  expect([...owner.selected]).toEqual(['archive/docs', 'archive/notes']);

  requests.length = 0;
  await prototype.handleDrop.call(owner as never, ['archive', 'archive/x.md'], { kind: 'into', relativePath: 'archive' });
  expect(owner.showError).toHaveBeenCalledTimes(1);
  expect(requests).toEqual([]);
});
