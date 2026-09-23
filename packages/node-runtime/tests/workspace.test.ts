/** @vitest-environment node */
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  createWorkspaceNodeId,
  type WorkspaceCreateRequest,
  type WorkspaceDeleteRequest,
  type WorkspaceEntry,
  type WorkspaceGateway,
  type WorkspaceMoveRequest,
  type WorkspaceRenameRequest,
  describeWorkspaceEntryTimestamps,
  formatWorkspaceEntryTimestamps,
  formatWorkspaceTimestamp,
  WorkspaceOperationError,
} from '@easyview/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  applyEntryDeleted,
  applyEntryRenamed,
  getWorkspaceAncestorPaths,
  LocalWorkspaceGateway,
  normalizeWorkspaceRelativePath,
  parseWorkspaceTreeOrderConfig,
  sortWorkspaceEntries,
  WorkspaceFileOperationService,
  WorkspaceTreeModel,
  WorkspaceTreeOrderState,
} from '../src/workspace';

const tempDirectories: string[] = [];

async function tempWorkspace(): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'easyview-workspace-core-'));
  tempDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    tempDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});

class ListingGateway implements WorkspaceGateway {
  listCalls = 0;

  async listChildren(rootId: string, relativePath: string): Promise<WorkspaceEntry[]> {
    this.listCalls += 1;
    if (relativePath === 'linked') {
      throw new WorkspaceOperationError('SYMLINK_NOT_TRAVERSABLE', 'leaf');
    }
    return [
      entry(rootId, 'file10.md', 'file'),
      entry(rootId, 'z-folder', 'directory'),
      entry(rootId, '.hidden.md', 'file'),
      entry(rootId, 'file2.md', 'file'),
      entry(rootId, 'a-folder', 'directory'),
      entry(rootId, 'linked', 'symlink'),
    ];
  }

  async create(_rootId: string, _request: WorkspaceCreateRequest): Promise<WorkspaceEntry> {
    throw new Error('not used');
  }

  async rename(_rootId: string, _request: WorkspaceRenameRequest): Promise<WorkspaceEntry> {
    throw new Error('not used');
  }

  async move(_rootId: string, _request: WorkspaceMoveRequest): Promise<WorkspaceEntry> {
    throw new Error('not used');
  }

  async delete(_rootId: string, _request: WorkspaceDeleteRequest): Promise<void> {
    throw new Error('not used');
  }
}

function entry(
  rootId: string,
  relativePath: string,
  kind: WorkspaceEntry['kind'],
  createdAt?: number,
): WorkspaceEntry {
  return {
    id: 'gateway-specific-id',
    rootId,
    relativePath,
    name: relativePath.split('/').at(-1) ?? relativePath,
    kind,
    ...(createdAt !== undefined ? { createdAt } : {}),
  };
}

describe('WorkspaceTreeModel', () => {
  it('loads lazily, caches reads, preserves hidden entries, and applies directory-first natural sorting', async () => {
    const gateway = new ListingGateway();
    const model = new WorkspaceTreeModel(gateway);

    const [first, concurrent] = await Promise.all([
      model.listChildren('root'),
      model.listChildren('root'),
    ]);

    expect(gateway.listCalls).toBe(1);
    expect(concurrent).toBe(first);
    expect(first.map((item) => item.name)).toEqual([
      'a-folder',
      'z-folder',
      '.hidden.md',
      'file2.md',
      'file10.md',
      'linked',
    ]);
    expect(first[0]?.id).toBe(createWorkspaceNodeId('root', 'a-folder'));

    model.invalidateDirectory('root');
    const refreshed = await model.listChildren('root');
    expect(gateway.listCalls).toBe(2);
    expect(refreshed[0]?.id).toBe(first[0]?.id);
  });

  it('treats known symlinks as leaves and computes root-to-parent ancestor paths', async () => {
    const model = new WorkspaceTreeModel(new ListingGateway());
    await model.listChildren('root');

    await expect(model.listChildren('root', 'linked')).rejects.toMatchObject({
      code: 'SYMLINK_NOT_TRAVERSABLE',
    });
    expect(model.getAncestorPaths('docs/api/readme.md')).toEqual(['', 'docs', 'docs/api']);
    expect(getWorkspaceAncestorPaths('readme.md')).toEqual(['']);
  });

  it('invalidates both old and new parents for rename changes', async () => {
    const gateway = new ListingGateway();
    const model = new WorkspaceTreeModel(gateway);
    await model.listChildren('root');

    expect(model.invalidateChanges([
      {
        rootId: 'root',
        kind: 'renamed',
        previousRelativePath: 'old/file.md',
        relativePath: 'new/file.md',
      },
    ])).toEqual(expect.arrayContaining([
      { rootId: 'root', relativePath: 'old' },
      { rootId: 'root', relativePath: 'new' },
    ]));
  });
});

describe('LocalWorkspaceGateway and WorkspaceFileOperationService', () => {
  it('lists hidden entries and performs create, rename, and permanent delete safely', async () => {
    const root = await tempWorkspace();
    await fs.mkdir(path.join(root, 'folder10'));
    await fs.mkdir(path.join(root, 'folder2'));
    await fs.writeFile(path.join(root, '.hidden.md'), 'hidden');

    const gateway = new LocalWorkspaceGateway([{ id: 'root', rootPath: root }]);
    const service = new WorkspaceFileOperationService(gateway);
    expect((await service.model.listChildren('root')).map((item) => item.name)).toEqual([
      'folder2',
      'folder10',
      '.hidden.md',
    ]);

    await service.create('root', { parentRelativePath: '', name: 'docs', kind: 'directory' });
    await service.create('root', { parentRelativePath: 'docs', name: 'note.md', kind: 'file' });
    expect(await fs.readFile(path.join(root, 'docs', 'note.md'), 'utf8')).toBe('');

    await expect(
      service.create('root', { parentRelativePath: 'docs', name: 'note.md', kind: 'file' }),
    ).rejects.toMatchObject({ code: 'ALREADY_EXISTS' });

    const renamed = await service.rename('root', {
      relativePath: 'docs/note.md',
      newName: 'guide.md',
    });
    expect(renamed).toMatchObject({ relativePath: 'docs/guide.md', kind: 'file' });
    await expect(fs.stat(path.join(root, 'docs', 'guide.md'))).resolves.toBeDefined();

    await service.delete('root', { relativePath: 'docs/guide.md' });
    await expect(fs.stat(path.join(root, 'docs', 'guide.md'))).rejects.toMatchObject({ code: 'ENOENT' });
    await service.delete('root', { relativePath: 'docs' });
  });

  it('rejects invalid names, traversal, overwrite, and non-recursive non-empty directory deletion', async () => {
    const root = await tempWorkspace();
    await fs.mkdir(path.join(root, 'docs'));
    await fs.writeFile(path.join(root, 'docs', 'note.md'), 'note');
    const service = new WorkspaceFileOperationService(
      new LocalWorkspaceGateway([{ id: 'root', rootPath: root }]),
    );

    expect(() => normalizeWorkspaceRelativePath('../outside')).toThrowError(
      expect.objectContaining({ code: 'ROOT_ESCAPE' }),
    );
    await expect(
      service.create('root', { parentRelativePath: '../outside', name: 'bad.md', kind: 'file' }),
    ).rejects.toMatchObject({ code: 'ROOT_ESCAPE' });
    await expect(
      service.create('root', { parentRelativePath: '', name: '../bad.md', kind: 'file' }),
    ).rejects.toMatchObject({ code: 'INVALID_NAME' });
    await fs.writeFile(path.join(root, 'docs', 'taken.md'), 'taken');
    await expect(
      service.rename('root', { relativePath: 'docs/note.md', newName: 'taken.md' }),
    ).rejects.toMatchObject({ code: 'ALREADY_EXISTS' });
    await expect(service.delete('root', { relativePath: 'docs' })).rejects.toMatchObject({
      code: 'DIRECTORY_NOT_EMPTY',
    });
    await service.delete('root', { relativePath: 'docs', options: { recursive: true } });
  });

  it('exposes symlinks as stable leaf nodes and blocks traversal through them', async () => {
    const root = await tempWorkspace();
    const outside = await tempWorkspace();
    await fs.mkdir(path.join(outside, 'child'));
    await fs.writeFile(path.join(outside, 'child', 'secret.md'), 'secret');
    await fs.symlink(outside, path.join(root, 'linked'));

    const gateway = new LocalWorkspaceGateway([{ id: 'root', rootPath: root }]);
    const model = new WorkspaceTreeModel(gateway);
    const listed = await model.listChildren('root');
    expect(listed).toContainEqual(expect.objectContaining({
      id: createWorkspaceNodeId('root', 'linked'),
      rootId: 'root',
      relativePath: 'linked',
      name: 'linked',
      kind: 'symlink',
    }));
    await expect(model.listChildren('root', 'linked')).rejects.toMatchObject({
      code: 'SYMLINK_NOT_TRAVERSABLE',
    });
    await expect(gateway.listChildren('root', 'linked/child')).rejects.toMatchObject({ code: 'SYMLINK_NOT_TRAVERSABLE' });
    await expect(
      gateway.create('root', { parentRelativePath: 'linked', name: 'escape.md', kind: 'file' }),
    ).rejects.toMatchObject({ code: 'SYMLINK_NOT_TRAVERSABLE' });
    await expect(fs.readFile(path.join(outside, 'child', 'secret.md'), 'utf8')).resolves.toBe('secret');
  });

  it('resolves a symlinked workspace root to its real path without allowing sibling escape', async () => {
    const realRoot = await tempWorkspace();
    const linkContainer = await tempWorkspace();
    const linkedRoot = path.join(linkContainer, 'workspace-link');
    await fs.symlink(realRoot, linkedRoot);

    const gateway = new LocalWorkspaceGateway([{ id: 'root', rootPath: linkedRoot }]);
    await gateway.create('root', { parentRelativePath: '', name: 'inside.md', kind: 'file' });
    expect(await fs.readFile(path.join(realRoot, 'inside.md'), 'utf8')).toBe('');
    await expect(
      gateway.create('root', { parentRelativePath: '../', name: 'outside.md', kind: 'file' }),
    ).rejects.toMatchObject({ code: 'ROOT_ESCAPE' });
  });

  it('uses an injected trash handler and fails explicitly when trash is unavailable', async () => {
    const root = await tempWorkspace();
    await fs.writeFile(path.join(root, 'trash.md'), 'trash');
    const trash = vi.fn(async ({ absolutePath }: { absolutePath: string }) => {
      await fs.unlink(absolutePath);
    });
    const withTrash = new LocalWorkspaceGateway([{ id: 'root', rootPath: root }], { trash });

    await withTrash.delete('root', { relativePath: 'trash.md', options: { useTrash: true } });
    expect(trash).toHaveBeenCalledWith(expect.objectContaining({
      rootId: 'root',
      relativePath: 'trash.md',
      absolutePath: path.join(await fs.realpath(root), 'trash.md'),
    }));

    await fs.writeFile(path.join(root, 'no-trash.md'), 'trash');
    const withoutTrash = new LocalWorkspaceGateway([{ id: 'root', rootPath: root }]);
    await expect(
      withoutTrash.delete('root', { relativePath: 'no-trash.md', options: { useTrash: true } }),
    ).rejects.toMatchObject({ code: 'TRASH_UNAVAILABLE' });
  });

  it('moves entries across directories and rejects moving a folder into itself', async () => {
    const root = await tempWorkspace();
    await fs.mkdir(path.join(root, 'docs'));
    await fs.mkdir(path.join(root, 'docs', 'nested'));
    await fs.writeFile(path.join(root, 'docs', 'note.md'), 'note');
    const gateway = new LocalWorkspaceGateway([{ id: 'root', rootPath: root }]);
    const service = new WorkspaceFileOperationService(gateway);

    const moved = await service.move('root', {
      relativePath: 'docs/note.md',
      targetParentRelativePath: '',
    });
    expect(moved.relativePath).toBe('note.md');
    await expect(fs.readFile(path.join(root, 'note.md'), 'utf8')).resolves.toBe('note');

    await expect(service.move('root', {
      relativePath: 'docs',
      targetParentRelativePath: 'docs/nested',
    })).rejects.toMatchObject({ code: 'INVALID_PATH' });
  });
});

describe('workspace tree order', () => {
  it('sorts by name, created time, and custom order with unlisted names appended', () => {
    const entries: WorkspaceEntry[] = [
      entry('root', 'b.md', 'file', 200),
      entry('root', 'a.md', 'file', 100),
      entry('root', 'z-dir', 'directory', 50),
      entry('root', 'a-dir', 'directory', 300),
    ];

    expect(sortWorkspaceEntries(entries, 'name').map((item) => item.name)).toEqual([
      'a-dir',
      'z-dir',
      'a.md',
      'b.md',
    ]);
    expect(sortWorkspaceEntries(entries, 'created').map((item) => item.name)).toEqual([
      'z-dir',
      'a-dir',
      'a.md',
      'b.md',
    ]);
    expect(sortWorkspaceEntries(entries, 'custom', ['b.md', 'a-dir']).map((item) => item.name)).toEqual([
      'a-dir',
      'z-dir',
      'b.md',
      'a.md',
    ]);
  });

  it('parses config and patches orders on rename, move, and delete', () => {
    const config = parseWorkspaceTreeOrderConfig({
      version: 1,
      sortMode: 'custom',
      showCreatedAt: true,
      showUpdatedAt: false,
      orders: {
        '': ['docs', 'a.md'],
        docs: ['note.md', 'guide.md'],
      },
    });
    expect(config.showCreatedAt).toBe(true);
    expect(config.showUpdatedAt).toBe(false);
    expect(config.showDotEntries).toBe(true);
    expect(config.showTimestampHover).toBe(true);

    const legacy = parseWorkspaceTreeOrderConfig({
      version: 1,
      sortMode: 'name',
      showTimestamps: true,
      orders: {},
    });
    expect(legacy.showCreatedAt).toBe(true);
    expect(legacy.showUpdatedAt).toBe(true);
    expect(legacy.showDotEntries).toBe(true);

    const hideDots = parseWorkspaceTreeOrderConfig({
      version: 1,
      sortMode: 'name',
      showDotEntries: false,
      orders: {},
    });
    expect(hideDots.showDotEntries).toBe(false);

    const hideHover = parseWorkspaceTreeOrderConfig({
      version: 1,
      sortMode: 'name',
      showTimestampHover: false,
      orders: {},
    });
    expect(hideHover.showTimestampHover).toBe(false);

    const renamed = applyEntryRenamed(config, 'docs/note.md', 'docs/intro.md');
    expect(renamed.orders.docs).toEqual(['intro.md', 'guide.md']);

    const moved = applyEntryRenamed(config, 'docs/note.md', 'note.md');
    expect(moved.orders.docs).toEqual(['guide.md']);
    expect(moved.orders['']).toEqual(['docs', 'a.md', 'note.md']);

    const deleted = applyEntryDeleted(config, 'docs');
    expect(deleted.orders['']).toEqual(['a.md']);
    expect(deleted.orders.docs).toBeUndefined();
  });

  it('formats local timestamps as YYYY-MM-DD HH:mm:ss', () => {
    const stamp = formatWorkspaceTimestamp(Date.UTC(2026, 8, 22, 2, 0, 0));
    // Local timezone dependent — just assert shape when defined.
    expect(stamp).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    expect(formatWorkspaceEntryTimestamps({
      createdAt: Date.UTC(2026, 8, 22, 2, 0, 0),
      updatedAt: Date.UTC(2026, 8, 22, 3, 0, 0),
    }, { showCreatedAt: true, showUpdatedAt: true })).toMatch(/^Created \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} · Updated \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    expect(formatWorkspaceEntryTimestamps({
      createdAt: Date.UTC(2026, 8, 22, 2, 0, 0),
      updatedAt: Date.UTC(2026, 8, 22, 3, 0, 0),
    }, { showCreatedAt: true, showUpdatedAt: false })).toMatch(/^Created \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    expect(formatWorkspaceEntryTimestamps({
      createdAt: Date.UTC(2026, 8, 22, 2, 0, 0),
      updatedAt: Date.UTC(2026, 8, 22, 3, 0, 0),
    }, { showCreatedAt: false, showUpdatedAt: true })).toMatch(/^Updated \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);

    const both = describeWorkspaceEntryTimestamps({
      createdAt: Date.UTC(2026, 8, 22, 2, 0, 0),
      updatedAt: Date.UTC(2026, 8, 22, 3, 0, 0),
    }, { showCreatedAt: true, showUpdatedAt: true });
    expect(both?.parts.map((part) => part.kind)).toEqual(['created', 'updated']);
    expect(both?.parts.every((part) => /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(part.value))).toBe(true);
    expect(both?.title).toMatch(/^Created .+\nUpdated .+$/);

    const hoverOnly = describeWorkspaceEntryTimestamps({
      createdAt: Date.UTC(2026, 8, 22, 2, 0, 0),
      updatedAt: Date.UTC(2026, 8, 22, 3, 0, 0),
    });
    expect(hoverOnly?.parts).toEqual([]);
    expect(hoverOnly?.title).toMatch(/^Created .+\nUpdated .+$/);
  });

  it('applies order state through WorkspaceTreeModel', async () => {
    const gateway = new ListingGateway();
    const orderState = new WorkspaceTreeOrderState();
    orderState.setSortMode('custom');
    orderState.reorder('', 'file10.md', [
      'a-folder',
      'z-folder',
      '.hidden.md',
      'file2.md',
      'file10.md',
      'linked',
    ], 'file2.md');
    const model = new WorkspaceTreeModel(gateway, { sortProvider: orderState });
    const listed = await model.listChildren('root');
    expect(listed.map((item) => item.name)).toEqual([
      'a-folder',
      'z-folder',
      '.hidden.md',
      'file10.md',
      'file2.md',
      'linked',
    ]);
  });
});
