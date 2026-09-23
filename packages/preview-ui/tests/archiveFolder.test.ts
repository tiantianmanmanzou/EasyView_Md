import { describe, expect, it } from 'vitest';
import { buildArchiveTree, listCurrentFolder, normalizeArchiveEntries } from '../src/viewers/ArchiveViewer';

describe('archive folder navigation', () => {
  it('shows only the current directory level by default', () => {
    const entries = normalizeArchiveEntries([
      { path: 'README.md', directory: false, compressedSize: 10, uncompressedSize: 10 },
      { path: 'src/main.ts', directory: false, compressedSize: 20, uncompressedSize: 20 },
      { path: 'src/util/help.ts', directory: false, compressedSize: 30, uncompressedSize: 30 },
      { path: '.git/hooks/pre-push.sample', directory: false, compressedSize: 40, uncompressedSize: 40 },
    ]);

    const root = listCurrentFolder(entries, '');
    expect(root.some((row) => row.kind === 'up')).toBe(false);
    expect(root.filter((row) => row.kind === 'directory').map((row) => row.name)).toEqual(['.git', 'src']);
    expect(root.filter((row) => row.kind === 'file').map((row) => row.name)).toEqual(['README.md']);

    const src = listCurrentFolder(entries, 'src/');
    expect(src.some((row) => row.kind === 'up')).toBe(true);
    expect(src.filter((row) => row.kind === 'directory').map((row) => row.name)).toEqual(['util']);
    expect(src.filter((row) => row.kind === 'file').map((row) => row.name)).toEqual(['main.ts']);
  });

  it('builds a collapsed-by-default folder tree from entries', () => {
    const entries = normalizeArchiveEntries([
      { path: 'README.md', directory: false, compressedSize: 10, uncompressedSize: 10 },
      { path: 'src/main.ts', directory: false, compressedSize: 20, uncompressedSize: 20 },
      { path: 'src/util/help.ts', directory: false, compressedSize: 30, uncompressedSize: 30 },
    ]);
    const tree = buildArchiveTree(entries);
    expect(tree.map((node) => node.name)).toEqual(['src']);
    expect(tree[0].children.map((node) => node.name)).toEqual(['util']);
    expect(tree[0].children[0].children).toEqual([]);
  });
});
