/** @vitest-environment happy-dom */
import { beforeEach, describe, expect, it } from 'vitest';
import type { EditorToHostMessage } from '@easyview/contracts';
import { createAiChatPanel } from './AiChatPanel';

describe('AiChatPanel host and document context', () => {
  beforeEach(() => {
    document.body.innerHTML = '<div id="editor-body"></div><aside id="global-ai-host"></aside>';
    window.localStorage.clear();
  });

  it('mounts in the supplied global host and disables Agent outside Markdown', () => {
    const messages: EditorToHostMessage[] = [];
    const host = document.getElementById('global-ai-host')!;
    const panel = createAiChatPanel({
      container: host,
      postMessage: (message) => messages.push(message),
      getDocumentContent: () => '# Document',
      getFilePath: () => '/workspace/document.md',
      getFileName: () => 'document.md',
      applyDocumentEdit: () => undefined,
      copyText: () => undefined,
    });

    const root = host.querySelector<HTMLElement>('.ai-chat-panel');
    expect(root).not.toBeNull();
    panel.open();
    expect(root?.classList.contains('hidden')).toBe(false);
    expect(messages.some((message) => message.type === 'aiChat.getSettings')).toBe(true);

    panel.setDocumentContextAvailable(false);
    panel.setFilePath('');
    const agent = root?.querySelector<HTMLButtonElement>('[data-mode="agent"]');
    expect(agent?.disabled).toBe(true);
    expect(agent?.title).toContain('仅 Markdown');
    expect(root?.querySelector('[data-mode="chat"]')?.classList.contains('active')).toBe(true);

    panel.setDocumentContextAvailable(true);
    panel.setFilePath('/workspace/document.md');
    expect(agent?.disabled).toBe(false);
    panel.destroy();
    expect(host.querySelector('.ai-chat-panel')).toBeNull();
  });
});
