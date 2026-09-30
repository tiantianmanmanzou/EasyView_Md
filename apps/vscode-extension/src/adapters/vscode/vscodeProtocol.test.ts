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
    expect(isVscodeEditorHostActionMessage({
      type: 'vscode.openChatWithPrompt',
      prompt: '文件：sample.md\n内容位置：Root》Target',
    })).toBe(true);
  });

  it('validates iTerm2 insertion payloads', () => {
    expect(isVscodeEditorHostActionMessage({ type: 'vscode.insertIntoITerm', prompt: '\n内容位置：a.md  》标题\n' })).toBe(true);
    expect(isVscodeEditorHostActionMessage({ type: 'vscode.insertIntoITerm', prompt: '' })).toBe(false);
    expect(isVscodeEditorHostActionMessage({ type: 'vscode.insertIntoITerm', prompt: 1 })).toBe(false);
  });

  it('rejects malformed and platform-neutral messages', () => {
    expect(isVscodeEditorHostActionMessage({
      type: 'vscode.openSourceDocument',
      request: { content: '# Title', line: -1 },
    })).toBe(false);
    expect(isVscodeEditorHostActionMessage({ type: 'vscode.openChatWithPrompt', prompt: '   ' })).toBe(false);
    expect(isVscodeEditorHostActionMessage({ type: 'ready' })).toBe(false);
  });
});
