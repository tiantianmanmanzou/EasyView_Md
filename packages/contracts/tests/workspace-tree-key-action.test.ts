import { describe, expect, it } from 'vitest';
import { resolveWorkspaceTreeKeyAction } from '../src/workspace/workspace-tree-view';

function event(partial: { key: string; metaKey?: boolean; ctrlKey?: boolean }) {
  return { key: partial.key, metaKey: partial.metaKey ?? false, ctrlKey: partial.ctrlKey ?? false };
}

describe('resolveWorkspaceTreeKeyAction', () => {
  it('ignores shortcuts while a rename/create input is focused', () => {
    expect(resolveWorkspaceTreeKeyAction(event({ key: 'F2' }), {
      targetIsEditable: true,
      hasSelection: true,
      hasPrimarySelection: true,
    })).toBeNull();
  });

  it('renames on F2 or Enter when a primary row is selected', () => {
    expect(resolveWorkspaceTreeKeyAction(event({ key: 'F2' }), {
      targetIsEditable: false,
      hasSelection: true,
      hasPrimarySelection: true,
    })).toBe('rename');
    expect(resolveWorkspaceTreeKeyAction(event({ key: 'Enter' }), {
      targetIsEditable: false,
      hasSelection: true,
      hasPrimarySelection: true,
    })).toBe('rename');
    expect(resolveWorkspaceTreeKeyAction(event({ key: 'F2' }), {
      targetIsEditable: false,
      hasSelection: false,
      hasPrimarySelection: false,
    })).toBeNull();
  });

  it('copies with Cmd/Ctrl+C when any row is selected', () => {
    expect(resolveWorkspaceTreeKeyAction(event({ key: 'c', metaKey: true }), {
      targetIsEditable: false,
      hasSelection: true,
    })).toBe('copy');
    expect(resolveWorkspaceTreeKeyAction(event({ key: 'C', ctrlKey: true }), {
      targetIsEditable: false,
      hasSelection: true,
    })).toBe('copy');
    expect(resolveWorkspaceTreeKeyAction(event({ key: 'c', metaKey: true }), {
      targetIsEditable: false,
      hasSelection: false,
    })).toBeNull();
  });

  it('pastes with Cmd/Ctrl+V even when the tree has no selection', () => {
    expect(resolveWorkspaceTreeKeyAction(event({ key: 'v', metaKey: true }), {
      targetIsEditable: false,
      hasSelection: false,
    })).toBe('paste');
  });

  it('deletes with Delete or Cmd+Backspace when any row is selected', () => {
    expect(resolveWorkspaceTreeKeyAction(event({ key: 'Delete' }), {
      targetIsEditable: false,
      hasSelection: true,
    })).toBe('delete');
    expect(resolveWorkspaceTreeKeyAction(event({ key: 'Backspace', metaKey: true }), {
      targetIsEditable: false,
      hasSelection: true,
    })).toBe('delete');
    expect(resolveWorkspaceTreeKeyAction(event({ key: 'Delete' }), {
      targetIsEditable: false,
      hasSelection: false,
    })).toBeNull();
  });
});
