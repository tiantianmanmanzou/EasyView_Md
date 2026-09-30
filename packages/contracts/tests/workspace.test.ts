// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import {
  createWorkspaceNodeId,
  isWorkspaceOperationError,
  collectVisibleWorkspaceTreeRelativePaths,
  computeNextWorkspaceTreeSelection,
  normalizeWorkspaceViewRelativePath,
  parentOfWorkspaceViewRelativePath,
  resolveWorkspaceTreeDropMode,
  resolveWorkspaceTreeIcon,
  workspaceEntryNameSelectionRange,
  WORKSPACE_TREE_SORT_MODE_LABELS,
  WorkspaceOperationError,
} from '../src';

describe('workspace contracts', () => {
  it('creates deterministic platform-neutral node identities', () => {
    expect(createWorkspaceNodeId('root:1', 'docs\\guide.md')).toBe(
      createWorkspaceNodeId('root:1', 'docs/guide.md'),
    );
    expect(createWorkspaceNodeId('root:1', 'docs/guide.md')).not.toBe(
      createWorkspaceNodeId('root:2', 'docs/guide.md'),
    );
  });

  it('exposes typed workspace operation errors', () => {
    const error = new WorkspaceOperationError('ROOT_ESCAPE', 'outside root');
    expect(isWorkspaceOperationError(error)).toBe(true);
    expect(error).toMatchObject({ name: 'WorkspaceOperationError', code: 'ROOT_ESCAPE' });
    expect(isWorkspaceOperationError(new Error('outside root'))).toBe(false);
  });

  it('resolves shared Seti explorer icons for Desktop and Extension', () => {
    expect(resolveWorkspaceTreeIcon({ kind: 'root', name: 'repo' }).codicon).toBe('root-folder');
    expect(resolveWorkspaceTreeIcon({ kind: 'root', name: 'repo', expanded: true }).codicon).toBe('root-folder-opened');
    expect(resolveWorkspaceTreeIcon({ kind: 'directory', name: 'src', expanded: true }).id).toBe('folder-opened');
    expect(resolveWorkspaceTreeIcon({ kind: 'directory', name: '.git' }).id).toBe('folder-dot');
    expect(resolveWorkspaceTreeIcon({ kind: 'directory', name: '.vscode', expanded: true }).id).toBe('folder-dot-opened');
    expect(resolveWorkspaceTreeIcon({ kind: 'directory', name: '.git' }).codicon).toBe('settings-gear');
    expect(resolveWorkspaceTreeIcon({ kind: 'directory', name: '.git' }).svg).not.toBe(
      resolveWorkspaceTreeIcon({ kind: 'directory', name: 'src' }).svg,
    );
    expect(resolveWorkspaceTreeIcon({ kind: 'symlink', name: 'link' }).codicon).toBe('file-symlink-file');

    const markdown = resolveWorkspaceTreeIcon({ kind: 'file', name: 'guide.md' });
    expect(markdown.id).toBe('seti:markdown');
    expect(markdown.color).toBe('#519aba');
    expect(markdown.svg).toContain('<svg');

    const python = resolveWorkspaceTreeIcon({ kind: 'file', name: 'main.py' });
    expect(python.id).toBe('seti:python');
    expect(python.svg).not.toBe(markdown.svg);

    expect(resolveWorkspaceTreeIcon({ kind: 'file', name: 'data.xlsx' }).id).toBe('seti:xls');
    const ppt = resolveWorkspaceTreeIcon({ kind: 'file', name: 'deck.pptx' });
    expect(ppt.id).toBe('seti:powerpoint');
    expect(ppt.color).toBe('#e37933');
    expect(ppt.svg).not.toBe(resolveWorkspaceTreeIcon({ kind: 'file', name: 'report.pdf' }).svg);
    expect(resolveWorkspaceTreeIcon({ kind: 'file', name: 'notes.docx' }).id).toBe('seti:word');
    expect(resolveWorkspaceTreeIcon({ kind: 'file', name: 'report.pdf' }).id).toBe('seti:pdf');
    expect(resolveWorkspaceTreeIcon({ kind: 'file', name: 'README.md' }).id).toBe('seti:info');
    expect(resolveWorkspaceTreeIcon({ kind: 'file', name: '.gitignore' }).id).toBe('seti:git');
  });

  it('resolves drop mode from row Y (directory top 30% = before, else into)', () => {
    expect(resolveWorkspaceTreeDropMode('file', 10, 0, 26)).toBe('before');
    expect(resolveWorkspaceTreeDropMode('symlink', 20, 0, 26)).toBe('before');
    expect(resolveWorkspaceTreeDropMode('directory', 0, 0, 100)).toBe('before');
    expect(resolveWorkspaceTreeDropMode('directory', 29, 0, 100)).toBe('before');
    expect(resolveWorkspaceTreeDropMode('directory', 30, 0, 100)).toBe('into');
    expect(resolveWorkspaceTreeDropMode('directory', 99, 0, 100)).toBe('into');
    expect(resolveWorkspaceTreeDropMode('directory', 50, 0, 0)).toBe('into');
  });

  it('shares sort-mode labels between Desktop and Extension tree menus', () => {
    expect(WORKSPACE_TREE_SORT_MODE_LABELS).toEqual({
      created: 'Sort by Created Time',
      name: 'Sort by Name',
      custom: 'Custom',
    });
  });

  it('normalizes View-layer relative paths leniently (characterization of prior duplicated logic)', () => {
    expect(normalizeWorkspaceViewRelativePath('docs/guide.md')).toBe('docs/guide.md');
    expect(normalizeWorkspaceViewRelativePath('docs\\guide.md')).toBe('docs/guide.md');
    expect(normalizeWorkspaceViewRelativePath('./docs/guide.md')).toBe('docs/guide.md');
    expect(normalizeWorkspaceViewRelativePath('docs/guide.md/')).toBe('docs/guide.md');
    expect(normalizeWorkspaceViewRelativePath('')).toBe('');
    // Lenient by design: unlike the Gateway-side normalizer, it does not reject '..' or collapse
    // interior '.' segments — Views only ever see paths a Gateway already produced or validated.
    expect(normalizeWorkspaceViewRelativePath('a/./b')).toBe('a/./b');
    expect(normalizeWorkspaceViewRelativePath('../escape')).toBe('../escape');
  });

  it('computes the parent of a View-layer relative path', () => {
    expect(parentOfWorkspaceViewRelativePath('docs/guide.md')).toBe('docs');
    expect(parentOfWorkspaceViewRelativePath('guide.md')).toBe('');
    expect(parentOfWorkspaceViewRelativePath('a/b/c.md')).toBe('a/b');
    expect(parentOfWorkspaceViewRelativePath('a\\b\\c.md')).toBe('a/b');
    expect(parentOfWorkspaceViewRelativePath('')).toBe('');
  });

  it('computes the base-name selection range for a rename input, excluding the extension', () => {
    expect(workspaceEntryNameSelectionRange('guide.md')).toEqual([0, 5]);
    // Leading dot is not treated as an extension separator (dot index must be > 0).
    expect(workspaceEntryNameSelectionRange('.gitignore')).toEqual([0, 10]);
    expect(workspaceEntryNameSelectionRange('untitled')).toEqual([0, 8]);

    // Still usable directly against a real input element.
    const input = document.createElement('input');
    input.value = 'guide.md';
    input.setSelectionRange(...workspaceEntryNameSelectionRange(input.value));
    expect([input.selectionStart, input.selectionEnd]).toEqual([0, 5]);
  });

  it('walks entriesByDirectory depth-first, descending only into expanded directories', () => {
    const entriesByDirectory = new Map<string, { relativePath: string; kind: string }[]>([
      ['', [
        { relativePath: 'a', kind: 'directory' },
        { relativePath: 'b.md', kind: 'file' },
      ]],
      ['a', [
        { relativePath: 'a/nested', kind: 'directory' },
        { relativePath: 'a/c.md', kind: 'file' },
      ]],
      ['a/nested', [{ relativePath: 'a/nested/d.md', kind: 'file' }]],
    ]);

    // Nothing expanded: only root entries are visible.
    expect(collectVisibleWorkspaceTreeRelativePaths(entriesByDirectory, () => false)).toEqual(['a', 'b.md']);

    // 'a' expanded but not 'a/nested': its children show, grandchildren don't.
    const expandedA = new Set(['a']);
    expect(collectVisibleWorkspaceTreeRelativePaths(entriesByDirectory, (p) => expandedA.has(p))).toEqual([
      'a', 'a/nested', 'a/c.md', 'b.md',
    ]);

    // Both expanded: full depth-first order.
    const expandedBoth = new Set(['a', 'a/nested']);
    expect(collectVisibleWorkspaceTreeRelativePaths(entriesByDirectory, (p) => expandedBoth.has(p))).toEqual([
      'a', 'a/nested', 'a/nested/d.md', 'a/c.md', 'b.md',
    ]);
  });

  describe('computeNextWorkspaceTreeSelection (Desktop + Extension shared multi-select algorithm)', () => {
    const visible = ['a', 'b', 'c', 'd', 'e'];

    it('plain click replaces the selection and anchors on the target', () => {
      const current = { selected: new Set(['a', 'b']), anchor: 'a' };
      const next = computeNextWorkspaceTreeSelection(current, { target: 'c', visible });
      expect([...next.selected]).toEqual(['c']);
      expect(next.anchor).toBe('c');
    });

    it('toggle key adds an unselected target and keeps the rest', () => {
      const current = { selected: new Set(['a']), anchor: 'a' };
      const next = computeNextWorkspaceTreeSelection(current, { target: 'c', visible, toggleKey: true });
      expect([...next.selected].sort()).toEqual(['a', 'c']);
      expect(next.anchor).toBe('c');
    });

    it('toggle key removes an already-selected target', () => {
      const current = { selected: new Set(['a', 'c']), anchor: 'c' };
      const next = computeNextWorkspaceTreeSelection(current, { target: 'c', visible, toggleKey: true });
      expect([...next.selected]).toEqual(['a']);
      expect(next.anchor).toBe('c');
    });

    it('shift-click extends the range from the anchor and keeps the anchor fixed', () => {
      const current = { selected: new Set(['b']), anchor: 'b' };
      const forward = computeNextWorkspaceTreeSelection(current, { target: 'd', visible, shiftKey: true });
      expect(forward.selected).toEqual(new Set(['b', 'c', 'd']));
      expect(forward.anchor).toBe('b');

      // Shift-clicking back past the anchor re-ranges from the same anchor (not the old target).
      const backward = computeNextWorkspaceTreeSelection(forward, { target: 'a', visible, shiftKey: true });
      expect(backward.selected).toEqual(new Set(['a', 'b']));
      expect(backward.anchor).toBe('b');
    });

    it('shift-click with no anchor falls back to a plain single selection', () => {
      const current = { selected: new Set<string>(), anchor: null };
      const next = computeNextWorkspaceTreeSelection(current, { target: 'c', visible, shiftKey: true });
      expect([...next.selected]).toEqual(['c']);
      expect(next.anchor).toBe('c');
    });

    it('shift-click falls back to single selection when the anchor is no longer visible', () => {
      const current = { selected: new Set(['stale']), anchor: 'stale' };
      const next = computeNextWorkspaceTreeSelection(current, { target: 'c', visible, shiftKey: true });
      expect([...next.selected]).toEqual(['c']);
      expect(next.anchor).toBe('c');
    });
  });
});
