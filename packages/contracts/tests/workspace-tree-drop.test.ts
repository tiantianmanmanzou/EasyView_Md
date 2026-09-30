import { describe, expect, it } from 'vitest';
import {
  filePathToWorkspaceDropUri,
  isExternalWorkspaceFileDrag,
  parseWorkspaceDropPlainPath,
  parseWorkspaceDropUriList,
  resolveWorkspaceTreeDropMode,
  workspaceTreeDropParentRelativePath,
} from '../src/workspace/workspace-tree-drop';

describe('workspace tree external drop helpers', () => {
  it('nests into a directory except the top band, and always uses the parent for files', () => {
    expect(resolveWorkspaceTreeDropMode('directory', 10, 0, 40)).toBe('before');
    expect(resolveWorkspaceTreeDropMode('directory', 20, 0, 40)).toBe('into');
    expect(resolveWorkspaceTreeDropMode('file', 30, 0, 40)).toBe('before');
  });

  it('resolves the import parent for row drops and empty-tree drops', () => {
    expect(workspaceTreeDropParentRelativePath(
      { kind: 'directory', relativePath: 'docs' },
      'into',
    )).toBe('docs');
    expect(workspaceTreeDropParentRelativePath(
      { kind: 'file', relativePath: 'docs/notes.md' },
      'before',
    )).toBe('docs');
    expect(workspaceTreeDropParentRelativePath(null, 'into')).toBe('');
  });

  it('treats Explorer/uri-list drags as external only when the tree is not already dragging a row', () => {
    expect(isExternalWorkspaceFileDrag({ types: ['Files'] }, false)).toBe(true);
    expect(isExternalWorkspaceFileDrag({ types: ['text/uri-list'] }, false)).toBe(true);
    expect(isExternalWorkspaceFileDrag({ types: ['application/vnd.code.uri-list'] }, false)).toBe(true);
    expect(isExternalWorkspaceFileDrag({ types: ['Files'] }, true)).toBe(false);
    expect(isExternalWorkspaceFileDrag({ types: ['text/plain'] }, false)).toBe(false);
  });

  it('parses file:// lines from a uri-list payload', () => {
    expect(parseWorkspaceDropUriList('# comment\nfile:///tmp/a.md\n\nfile:///tmp/b.txt')).toEqual([
      'file:///tmp/a.md',
      'file:///tmp/b.txt',
    ]);
  });

  it('accepts absolute Explorer paths and file URIs, but ignores relative tree paths', () => {
    expect(parseWorkspaceDropPlainPath('file:///tmp/a.md')).toEqual({ uri: 'file:///tmp/a.md' });
    expect(parseWorkspaceDropPlainPath('/tmp/notes.md')).toEqual({
      path: '/tmp/notes.md',
      uri: 'file:///tmp/notes.md',
    });
    expect(parseWorkspaceDropPlainPath('C:\\docs\\a.md')).toEqual({
      path: 'C:\\docs\\a.md',
      uri: filePathToWorkspaceDropUri('C:\\docs\\a.md'),
    });
    expect(parseWorkspaceDropPlainPath('docs/notes.md')).toEqual({});
  });
});
