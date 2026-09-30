// @vitest-environment jsdom
import { expect, it, vi } from 'vitest';
import type { EditorHostTransport, HostToEditorMessage } from '@easyview/contracts';
import { createEasyViewEditor } from './index';

it('prefills Cursor chat with the selected heading outline context without sending it', async () => {
  document.body.innerHTML = '<div id="editor-body"><div id="editor-scroll-area"><div id="editor"></div></div></div>';
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  const hostActions = { openChatWithPrompt: vi.fn().mockResolvedValue(undefined), insertIntoITerm: vi.fn() };
  let receive!: (message: HostToEditorMessage) => void;
  const host: EditorHostTransport = {
    capabilities: { sourceMode: 'embedded', git: false, terminal: false, aiCommitMessage: false, aiChat: false, documentConversion: false, shortcutPersistence: false },
    postMessage: vi.fn(),
    subscribe(listener) { receive = listener; return { unsubscribe() {} }; },
  };
  const editor = createEasyViewEditor({ host, hostActions });
  try {
    receive({
      type: 'documentSnapshot',
      documentId: 'heading-chat-test',
      revision: 1,
      content: '# Root\n\n## Target heading',
      contentHash: 'test',
      filename: 'sample.md',
      filePath: '/workspace/docs/sample.md',
      reason: 'initial',
    } as HostToEditorMessage);

    const buttons = document.querySelectorAll<HTMLButtonElement>('.heading-send-to-chat');
    expect(buttons).toHaveLength(2);
    buttons[1].dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }));
    await Promise.resolve();
    await Promise.resolve();

    expect(hostActions.openChatWithPrompt).toHaveBeenCalledWith('\n内容位置：sample.md  》Root  》Target heading\n');
    const copy = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: copy } });
    document.querySelectorAll<HTMLButtonElement>('.heading-copy-outline:not(.heading-insert-iterm)')[1]
      .dispatchEvent(new MouseEvent('mousedown', { bubbles: false, button: 0 }));
    document.querySelectorAll<HTMLButtonElement>('.heading-insert-iterm')[1]
      .dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }));
    expect(copy).toHaveBeenCalledWith('\n内容位置：sample.md  》Root  》Target heading\n');
    expect(hostActions.insertIntoITerm).toHaveBeenCalledWith(copy.mock.calls[0][0]);
  } finally {
    await new Promise((resolve) => setTimeout(resolve, 120));
    editor.dispose();
    document.body.replaceChildren();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  }
});
