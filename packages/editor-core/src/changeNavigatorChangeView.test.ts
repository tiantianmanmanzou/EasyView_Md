/** @vitest-environment jsdom */
import { expect, it, vi } from 'vitest';
import type { EditorHostTransport, HostToEditorMessage } from '@easyview/contracts';
import { hashContent } from '@easyview/editor-sync';
import { ChangeViewController } from './controllers/ChangeViewController';
import { createEasyViewEditor } from './index';

it('navigates Git changes through Change mode instead of the hidden preview', async () => {
  localStorage.setItem('mdpre-external-follow-scroll', 'true');
  document.body.innerHTML = '<div id="editor-body"><div id="editor-scroll-area"><div id="editor"></div></div></div>';
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  const originalScrollIntoView = HTMLElement.prototype.scrollIntoView;
  const previewScroll = vi.fn();
  HTMLElement.prototype.scrollIntoView = previewScroll;
  const changeScroll = vi.spyOn(ChangeViewController.prototype, 'scrollToLine');
  const scrollArea = document.getElementById('editor-scroll-area')!;
  scrollArea.scrollTo = vi.fn();
  let receive!: (message: HostToEditorMessage) => void;
  const host: EditorHostTransport = {
    capabilities: { sourceMode: 'embedded', git: true, terminal: false, aiCommitMessage: false, aiChat: false, documentConversion: false, shortcutPersistence: false },
    postMessage: vi.fn(),
    subscribe(listener) { receive = listener; return { unsubscribe() {} }; },
  };
  const editor = createEasyViewEditor({ host });
  try {
    const content = '# Root\n\nParagraph\n\nEnding';
    receive({ type: 'documentSnapshot', documentId: 'change-mode-test', revision: 1, content,
      contentHash: hashContent(content), filePath: '/workspace/change-mode.md', reason: 'initial' } as HostToEditorMessage);
    await new Promise((resolve) => setTimeout(resolve, 150));
    receive({ type: 'gitStatusChanged', documentId: 'change-mode-test', revision: 1,
      lineRanges: [
        { startLine: 1, endLine: 1, kind: 'modified' },
        { startLine: 5, endLine: 5, kind: 'modified' },
      ],
      snapshot: { baseContent: '# Old\n\nParagraph\n\nPrevious' },
    } as HostToEditorMessage);
    document.querySelector<HTMLButtonElement>('[data-action="toggleViewChanges"]')!.click();
    expect(document.querySelector('.easyview-change-view')).not.toBeNull();
    previewScroll.mockClear();
    (scrollArea.scrollTo as ReturnType<typeof vi.fn>).mockClear();
    document.querySelector<HTMLButtonElement>('.ai-changes-toast-next')!.click();
    expect(changeScroll).toHaveBeenCalledWith(5);
    expect(scrollArea.scrollTo).toHaveBeenCalled();
    expect(previewScroll).not.toHaveBeenCalled();
  } finally {
    editor.dispose();
    changeScroll.mockRestore();
    localStorage.removeItem('mdpre-external-follow-scroll');
    document.body.replaceChildren();
    if (originalScrollIntoView) HTMLElement.prototype.scrollIntoView = originalScrollIntoView;
    else delete (HTMLElement.prototype as Partial<HTMLElement>).scrollIntoView;
    vi.unstubAllGlobals();
  }
});
