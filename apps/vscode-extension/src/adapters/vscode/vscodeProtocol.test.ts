import { describe, expect, it } from 'vitest';
import { isVscodeEditorHostActionMessage } from './vscodeProtocol';

describe('VS Code editor host action protocol', () => {
  it('accepts the two VS Code-only adapter actions', () => {
    expect(isVscodeEditorHostActionMessage({
      type: 'vscode.openSourceDocument',
      request: {
        content: '# Title',
        fullWidth: true,
        tocVisible: true,
        tableWrap: false,
        line: 2,
        character: 4,
      },
    })).toBe(true);
    expect(isVscodeEditorHostActionMessage({
      type: 'vscode.persistOpenEditorShortcut',
      shortcut: 'Alt+E',
    })).toBe(true);
  });

  it('rejects malformed and platform-neutral messages', () => {
    expect(isVscodeEditorHostActionMessage({
      type: 'vscode.openSourceDocument',
      request: { content: '# Title', line: -1 },
    })).toBe(false);
    expect(isVscodeEditorHostActionMessage({ type: 'ready' })).toBe(false);
  });
});
