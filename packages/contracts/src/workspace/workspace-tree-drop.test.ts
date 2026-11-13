import { describe, expect, it } from 'vitest';
import {
  filePathToWorkspaceDropUri,
  isExternalWorkspaceFileDrag,
  parseWorkspaceDropPlainPath,
  parseWorkspaceDropUriList,
  resolveWorkspaceTreeDropMode,
  resolveWorkspaceTreeDragSources,
  resolveWorkspaceTreeDropTarget,
  resolveWorkspaceTreeGapPlacement,
  resolveWorkspaceTreeRowDropZone,
  workspaceTreeDepthFromPointer,
  workspaceTreeDropParentRelativePath,
  workspaceTreeGapBeforeName,
} from './workspace-tree-drop';

describe('workspace tree level-aware drop slots', () => {
  it('splits directories into above / into / below bands and files into halves', () => {
    expect(resolveWorkspaceTreeRowDropZone('directory', 5, 0, 40)).toBe('above');
    expect(resolveWorkspaceTreeRowDropZone('directory', 20, 0, 40)).toBe('into');
    expect(resolveWorkspaceTreeRowDropZone('directory', 35, 0, 40)).toBe('below');
    expect(resolveWorkspaceTreeRowDropZone('file', 15, 0, 40)).toBe('above');
    expect(resolveWorkspaceTreeRowDropZone('file', 25, 0, 40)).toBe('below');
  });

  it('maps pointer X to depth at each level chevron midpoint', () => {
    expect(workspaceTreeDepthFromPointer(10)).toBe(-1);
    expect(workspaceTreeDepthFromPointer(16)).toBe(0);
    expect(workspaceTreeDepthFromPointer(31)).toBe(0);
    expect(workspaceTreeDepthFromPointer(32)).toBe(1);
    expect(workspaceTreeDepthFromPointer(300)).toBe(17);
  });

  it('lets the gap under the last nested child choose between staying in the folder and the outer level', () => {
    const previous = '功能设计/仪表盘功能';
    const next = '项目管理';
    expect(resolveWorkspaceTreeGapPlacement(previous, next, 9)).toEqual({
      depth: 1, parentRelativePath: '功能设计', afterName: '仪表盘功能',
    });
    expect(resolveWorkspaceTreeGapPlacement(previous, next, 0)).toEqual({
      depth: 0, parentRelativePath: '', beforeName: '项目管理',
    });
    expect(resolveWorkspaceTreeGapPlacement('a/b/c.md', 'd', 1)).toEqual({
      depth: 1, parentRelativePath: 'a', afterName: 'b',
    });
  });

  it('has a single slot between siblings and between a folder and its first child', () => {
    expect(resolveWorkspaceTreeGapPlacement('a.md', 'b.md', 0)).toEqual({ depth: 0, parentRelativePath: '', beforeName: 'b.md' });
    expect(resolveWorkspaceTreeGapPlacement('docs', 'docs/a.md', 0)).toEqual({ depth: 1, parentRelativePath: 'docs', beforeName: 'a.md' });
    expect(resolveWorkspaceTreeGapPlacement(null, 'a.md', 5)).toEqual({ depth: 0, parentRelativePath: '', beforeName: 'a.md' });
    expect(resolveWorkspaceTreeGapPlacement('docs/a.md', null, 0)).toEqual({ depth: 0, parentRelativePath: '', afterName: 'docs' });
  });

  it('resolves row drops and rejects dropping a folder into its own subtree', () => {
    const rows = [
      { relativePath: 'docs', kind: 'directory' as const },
      { relativePath: 'docs/a.md', kind: 'file' as const },
      { relativePath: 'notes.md', kind: 'file' as const },
    ];
    expect(resolveWorkspaceTreeDropTarget({ rows, index: 1, zone: 'below', pointerDepth: 3 })).toEqual({
      kind: 'gap', placement: { depth: 1, parentRelativePath: 'docs', afterName: 'a.md' }, lineRowIndex: 1, lineEdge: 'bottom',
    });
    expect(resolveWorkspaceTreeDropTarget({ rows, index: 2, zone: 'above', pointerDepth: 0 })).toEqual({
      kind: 'gap', placement: { depth: 0, parentRelativePath: '', beforeName: 'notes.md' }, lineRowIndex: 2, lineEdge: 'top',
    });
    expect(resolveWorkspaceTreeDropTarget({ rows, index: 0, zone: 'into', pointerDepth: 0 })).toEqual({ kind: 'into', relativePath: 'docs' });
    expect(resolveWorkspaceTreeDropTarget({ rows, index: 0, zone: 'into', pointerDepth: 0, draggedRelativePaths: ['docs'] })).toBeNull();
    expect(resolveWorkspaceTreeDropTarget({ rows, index: 1, zone: 'below', pointerDepth: 3, draggedRelativePaths: ['docs'] })).toBeNull();
    expect(resolveWorkspaceTreeDropTarget({ rows, index: 0, zone: 'into', pointerDepth: 0, draggedRelativePaths: ['notes.md', 'docs'] })).toBeNull();
  });

  it('drags the whole selection when the grabbed row is selected, folding items inside selected folders', () => {
    const selection = ['docs', 'docs/a.md', 'notes.md', 'z/b.md'];
    expect(resolveWorkspaceTreeDragSources(selection, 'notes.md')).toEqual(['docs', 'notes.md', 'z/b.md']);
    expect(resolveWorkspaceTreeDragSources(selection, 'other.md')).toEqual(['other.md']);
  });

  it('turns an "after" slot into the reorder beforeName', () => {
    expect(workspaceTreeGapBeforeName({ depth: 0, parentRelativePath: '', afterName: 'a' }, ['a', 'b'])).toBe('b');
    expect(workspaceTreeGapBeforeName({ depth: 0, parentRelativePath: '', afterName: 'b' }, ['a', 'b'])).toBeUndefined();
    expect(workspaceTreeGapBeforeName({ depth: 0, parentRelativePath: '', beforeName: 'a' }, ['a', 'b'])).toBe('a');
  });
});

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
