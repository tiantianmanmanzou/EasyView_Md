import { describe, expect, it } from 'vitest';
import {
  createWorkspaceNodeId,
  isWorkspaceOperationError,
  resolveWorkspaceTreeDropMode,
  resolveWorkspaceTreeIcon,
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
});
