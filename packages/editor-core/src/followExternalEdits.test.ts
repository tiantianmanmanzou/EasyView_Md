/** @vitest-environment jsdom */
import { expect, it, vi } from 'vitest';
import type { EditorHostTransport, HostToEditorMessage } from '@easyview/contracts';
import { hashContent } from '@easyview/editor-sync';
import { createEasyViewEditor } from './index';

it('keeps the page still and omits the jump prompt for external edits when Follow is off', async () => {
  localStorage.setItem('mdpre-external-follow-scroll', 'false');
  document.body.innerHTML = '<div id="editor-body"><div id="editor-scroll-area"><div id="editor"></div></div></div>';
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  const scrollIntoView = vi.fn();
  const originalScrollIntoView = HTMLElement.prototype.scrollIntoView;
  HTMLElement.prototype.scrollIntoView = scrollIntoView;
  let receive!: (message: HostToEditorMessage) => void;
  const host: EditorHostTransport = {
    capabilities: { sourceMode: 'embedded', git: false, terminal: false, aiCommitMessage: false, aiChat: false, documentConversion: false, shortcutPersistence: false },
    postMessage: vi.fn(),
    subscribe(listener) { receive = listener; return { unsubscribe() {} }; },
  };
  const editor = createEasyViewEditor({ host });
  try {
    const before = '# Before\n\nParagraph';
    const after = '# After\n\nParagraph';
    receive({ type: 'documentSnapshot', documentId: 'follow-test', revision: 1, content: before,
      contentHash: hashContent(before), filePath: '/workspace/follow.md', reason: 'initial', gitRefreshStatus: 'loading' } as HostToEditorMessage);
    await new Promise((resolve) => setTimeout(resolve, 150));
    const scrollArea = document.getElementById('editor-scroll-area')!;
    scrollArea.scrollTop = 50;
    scrollIntoView.mockClear();
    const followButton = document.querySelector<HTMLButtonElement>('[data-action="toggleExternalFollow"]')!;
    followButton.click();
    const navigator = document.querySelector<HTMLElement>('.ai-changes-toast.visible')!;
    expect(navigator.querySelector('.ai-changes-toast-summary')?.textContent).toBe('Loading Git changes…');
    expect(navigator.querySelector('.ai-changes-toast-count')?.textContent).toBe('0/0');
    expect(navigator.querySelector<HTMLButtonElement>('.ai-changes-toast-prev')?.disabled).toBe(true);
    expect(navigator.querySelector<HTMLButtonElement>('.ai-changes-toast-next')?.disabled).toBe(true);
    expect(scrollArea.scrollTop).toBe(50);
    receive({ type: 'gitRefreshStatus', documentId: 'follow-test', revision: 1, status: 'error' });
    expect(navigator.querySelector('.ai-changes-toast-summary')?.textContent).toBe('Git read failed');
    receive({ type: 'gitRefreshStatus', documentId: 'follow-test', revision: 1, status: 'loading' });
    expect(navigator.querySelector('.ai-changes-toast-summary')?.textContent).toBe('Loading Git changes…');
    receive({ type: 'gitStatusChanged', documentId: 'follow-test', revision: 1,
      lineRanges: [], snapshot: { baseContent: before, indexObjectId: 'test', currentContentHash: hashContent(before), isUntracked: false },
    });
    expect(navigator.querySelector('.ai-changes-toast-summary')?.textContent).toBe('No changes');
    receive({ type: 'gitStatusChanged', documentId: 'follow-test', revision: 1,
      lineRanges: [{ startLine: 1, endLine: 1, kind: 'modified' }],
      snapshot: { baseContent: '# Earlier\n\nParagraph' },
    } as HostToEditorMessage);
    expect(navigator.querySelector<HTMLElement>('.ai-changes-toast-summary')?.hidden).toBe(true);
    expect(navigator.querySelector('.ai-changes-toast-count')?.textContent).toBe('1/1');
    followButton.click();
    expect(document.querySelector('.ai-changes-toast.visible')).toBeNull();
    receive({ type: 'documentPatched', documentId: 'follow-test', baseRevision: 1, revision: 2,
      edits: [{ from: 2, to: 8, insert: 'After' }], resultHash: hashContent(after), source: 'external' });
    await new Promise((resolve) => setTimeout(resolve, 1100));
    expect(scrollArea.scrollTop).toBe(50);
    expect(scrollIntoView).not.toHaveBeenCalled();
    expect(document.querySelector('.ai-changes-toast.visible')).toBeNull();
  } finally {
    editor.dispose();
    localStorage.removeItem('mdpre-external-follow-scroll');
    document.body.replaceChildren();
    if (originalScrollIntoView) HTMLElement.prototype.scrollIntoView = originalScrollIntoView;
    else delete (HTMLElement.prototype as Partial<HTMLElement>).scrollIntoView;
    vi.unstubAllGlobals();
  }
});
