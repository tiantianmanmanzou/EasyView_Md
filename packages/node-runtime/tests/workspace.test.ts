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
  type WorkspaceRenameRequest,
  WorkspaceOperationError,
} from '@easyview/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  getWorkspaceAncestorPaths,
  LocalWorkspaceGateway,
  normalizeWorkspaceRelativePath,
  WorkspaceFileOperationService,
  WorkspaceTreeModel,
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

  async delete(_rootId: string, _request: WorkspaceDeleteRequest): Promise<void> {
    throw new Error('not used');
  }
}

function entry(rootId: string, relativePath: string, kind: WorkspaceEntry['kind']): WorkspaceEntry {
  return {
    id: 'gateway-specific-id',
    rootId,
    relativePath,
    name: relativePath.split('/').at(-1) ?? relativePath,
    kind,
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
    expect(listed).toContainEqual({
      id: createWorkspaceNodeId('root', 'linked'),
      rootId: 'root',
      relativePath: 'linked',
      name: 'linked',
      kind: 'symlink',
    });
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
});
