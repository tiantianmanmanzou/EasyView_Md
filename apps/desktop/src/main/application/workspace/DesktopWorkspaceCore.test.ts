/** @vitest-environment node */
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DesktopWorkspaceCore } from './DesktopWorkspaceCore';

const directories: string[] = [];

async function tempWorkspace(): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'easyview-desktop-workspace-'));
  directories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

describe('DesktopWorkspaceCore', () => {
  it('lists hidden files and sorts directories before files via shared model', async () => {
    const root = await tempWorkspace();
    await fs.mkdir(path.join(root, 'z-folder'));
    await fs.mkdir(path.join(root, '.hidden-folder'));
    await fs.writeFile(path.join(root, 'a.md'), '');
    await fs.writeFile(path.join(root, '.hidden.md'), '');
    const core = new DesktopWorkspaceCore();
    await core.bindRoot(root);
    const entries = await core.listChildren('');
    expect(entries.map((entry) => entry.name)).toEqual(['.hidden-folder', 'z-folder', '.hidden.md', 'a.md']);
    expect(entries.every((entry) => entry.rootId === 'desktop' && entry.id.startsWith('workspace:'))).toBe(true);
  });

  it('invalidates only affected directory caches after watcher events', async () => {
    const root = await tempWorkspace();
    await fs.mkdir(path.join(root, 'docs'));
    await fs.writeFile(path.join(root, 'docs', 'a.md'), '');
    const core = new DesktopWorkspaceCore();
    await core.bindRoot(root);
    await core.listChildren('');
    await core.listChildren('docs');
    await fs.writeFile(path.join(root, 'docs', 'b.md'), '');
    expect(core.invalidateFromWatcher(['docs/b.md'])).toEqual(['docs', 'docs/b.md']);
    expect((await core.listChildren('docs')).map((entry) => entry.name)).toEqual(['a.md', 'b.md']);
  });

  it('creates and renames entries only inside the workspace', async () => {
    const root = await fs.realpath(await tempWorkspace());
    const core = new DesktopWorkspaceCore();
    await core.bindRoot(root);
    await core.create({ parentRelativePath: '', name: 'untitled.md', kind: 'file' });
    const renamed = await core.rename({ relativePath: 'untitled.md', newName: 'notes.md' });
    expect(renamed).toMatchObject({ name: 'notes.md', relativePath: 'notes.md', kind: 'file', rootId: 'desktop' });
    expect(core.resourcePaths('notes.md')).toMatchObject({
      absolutePath: path.join(root, 'notes.md'),
      relativePath: 'notes.md',
    });
    await expect(core.create({ parentRelativePath: '', name: 'notes.md', kind: 'file' })).rejects.toThrow('already exists');
    await expect(core.create({ parentRelativePath: '../', name: 'escape.md', kind: 'file' })).rejects.toThrow();
    await expect(core.create({ parentRelativePath: '', name: '../escape.md', kind: 'file' })).rejects.toThrow();
  });

  it('exposes symlinks as nodes without traversing them', async () => {
    const root = await fs.realpath(await tempWorkspace());
    const outside = await fs.realpath(await tempWorkspace());
    await fs.symlink(outside, path.join(root, 'linked-directory'));
    const core = new DesktopWorkspaceCore();
    await core.bindRoot(root);
    const entries = await core.listChildren('');
    expect(entries).toContainEqual(expect.objectContaining({
      name: 'linked-directory',
      relativePath: 'linked-directory',
      kind: 'symlink',
    }));
    await expect(core.listChildren('linked-directory')).rejects.toThrow();
  });

  it('copies files with unique names and rejects pasting a folder into itself', async () => {
    const root = await fs.realpath(await tempWorkspace());
    const core = new DesktopWorkspaceCore();
    await core.bindRoot(root);
    await fs.mkdir(path.join(root, 'docs'));
    await fs.writeFile(path.join(root, 'docs', 'notes.md'), 'hello');
    const first = await core.copy({ sourceRelativePath: 'docs/notes.md', targetParentRelativePath: 'docs' });
    expect(first).toMatchObject({ name: 'notes copy.md', relativePath: 'docs/notes copy.md', kind: 'file' });
    expect(await fs.readFile(path.join(root, 'docs', 'notes copy.md'), 'utf8')).toBe('hello');
    const second = await core.copy({ sourceRelativePath: 'docs/notes.md', targetParentRelativePath: 'docs' });
    expect(second.name).toBe('notes copy 2.md');
    await expect(core.copy({ sourceRelativePath: 'docs', targetParentRelativePath: 'docs' })).rejects.toThrow('自身');
  });

  it('deletes through the shared operation service using trash handler', async () => {
    const root = await fs.realpath(await tempWorkspace());
    const trashed: string[] = [];
    const core = new DesktopWorkspaceCore(async (absolutePath) => {
      trashed.push(absolutePath);
      await fs.rm(absolutePath, { recursive: true, force: true });
    });
    await core.bindRoot(root);
    await core.create({ parentRelativePath: '', name: 'gone.md', kind: 'file' });
    await core.delete({ relativePath: 'gone.md', options: { useTrash: true } });
    expect(trashed).toEqual([path.join(root, 'gone.md')]);
    expect(await core.listChildren('')).toEqual([]);
  });
});
