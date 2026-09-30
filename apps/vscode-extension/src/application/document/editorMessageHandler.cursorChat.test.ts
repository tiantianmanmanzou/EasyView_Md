import { afterEach, expect, it, vi } from 'vitest';
import type { MessageHandlerContext } from './editorMessageHandler';
import type { VscodeEditorHostActionMessage } from '../../adapters/vscode/vscodeProtocol';

const vscodeMock = vi.hoisted(() => ({
  commands: { executeCommand: vi.fn() },
  env: { clipboard: { readText: vi.fn().mockResolvedValue('old clipboard'), writeText: vi.fn().mockResolvedValue(undefined) } },
}));
vi.mock('vscode', () => vscodeMock);

import { handleVscodeEditorHostAction } from './editorMessageHandler';

afterEach(() => {
  vscodeMock.commands.executeCommand.mockReset();
  vscodeMock.env.clipboard.readText.mockReset().mockResolvedValue('old clipboard');
  vscodeMock.env.clipboard.writeText.mockReset().mockResolvedValue(undefined);
});

const message: VscodeEditorHostActionMessage = {
  type: 'vscode.openChatWithPrompt',
  prompt: '文件：sample.md\n内容位置：Root》Target',
};

it('fills the selected Agent composer without opening a new chat', async () => {
  vscodeMock.commands.executeCommand.mockResolvedValueOnce(['composer-id']);

  await handleVscodeEditorHostAction({} as MessageHandlerContext, message);

  expect(vscodeMock.env.clipboard.readText).toHaveBeenCalledTimes(1);
  expect(vscodeMock.commands.executeCommand.mock.calls).toEqual([
    ['composer.getOrderedSelectedComposerIds'],
    ['composer.focusComposer'],
    ['editor.action.clipboardPasteAction'],
  ]);
  expect(vscodeMock.env.clipboard.writeText.mock.calls).toEqual([
    [message.prompt],
    ['old clipboard'],
  ]);
});

it('opens a prefilled chat only when no Agent composer is already selected', async () => {
  vscodeMock.commands.executeCommand.mockResolvedValueOnce([]);

  await handleVscodeEditorHostAction({} as MessageHandlerContext, message);

  expect(vscodeMock.commands.executeCommand.mock.calls).toEqual([
    ['composer.getOrderedSelectedComposerIds'],
    ['workbench.action.chat.open', { query: message.prompt }],
  ]);
});
