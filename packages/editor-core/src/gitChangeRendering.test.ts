// @vitest-environment jsdom
import { expect, it, vi } from 'vitest';
import type { EditorHostTransport, HostToEditorMessage } from '@easyview/contracts';
import { createEasyViewEditor } from './index';

it('renders every Git change through the host message boundary and clears reverted changes', async () => {
  document.body.innerHTML = '<div id="editor-body"><div id="editor-scroll-area"><div id="editor"></div></div></div>';
  const scrollArea = document.getElementById('editor-scroll-area')!;
  vi.spyOn(scrollArea, 'getBoundingClientRect').mockReturnValue({ top: 0, left: 0, right: 1000, bottom: 800, width: 1000, height: 800 } as DOMRect);
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  let receive!: (message: HostToEditorMessage) => void;
  const host: EditorHostTransport = {
    capabilities: { sourceMode: 'embedded', git: true, terminal: false, aiCommitMessage: false, aiChat: false, documentConversion: false, shortcutPersistence: false },
    postMessage: vi.fn(),
    subscribe(listener) { receive = listener; return { unsubscribe() {} }; },
  };
  const editor = createEasyViewEditor({ host });
  const markdown = '# Heading\n\n- changed item\n- unchanged\n\n```\nchanged code\n```\n\n| A | B |\n| --- | --- |\n| changed | value |\n\nEnd';
  try {
    receive({ type: 'documentSnapshot', documentId: 'git-test', revision: 1, content: markdown, contentHash: 'test', reason: 'initial' } as HostToEditorMessage);
    receive({ type: 'gitStatusChanged', snapshot: { indexObjectId: 'test', baseContent: '', currentContentHash: '', isUntracked: false }, documentId: 'git-test', revision: 1, lineRanges: [3, 7, 12].map((line) => ({ startLine: line, endLine: line, kind: 'modified' })) });
    expect(document.querySelectorAll('.block-ai-modified')).toHaveLength(3);
    expect(document.querySelectorAll('.ai-scroll-marker')).toHaveLength(3);
    receive({ type: 'gitStatusChanged', snapshot: { indexObjectId: 'test', baseContent: '', currentContentHash: '', isUntracked: false }, documentId: 'git-test', revision: 0, lineRanges: [] });
    expect(document.querySelectorAll('.ai-scroll-marker')).toHaveLength(3);
    receive({ type: 'gitStatusChanged', snapshot: { indexObjectId: 'test', baseContent: '', currentContentHash: '', isUntracked: false }, documentId: 'git-test', revision: 1, lineRanges: [] });
    expect(document.querySelectorAll('.block-ai-modified, .ai-scroll-marker')).toHaveLength(0);
  } finally {
    await new Promise((resolve) => setTimeout(resolve, 120));
    editor.dispose();
    document.body.replaceChildren();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  }
});

it('restores change view after switching documents or recreating the editor', async () => {
  document.body.innerHTML = '<div id="editor-body"><div id="editor-scroll-area"><div id="editor"></div></div></div>';
  const scrollArea = document.getElementById('editor-scroll-area')!;
  vi.spyOn(scrollArea, 'getBoundingClientRect').mockReturnValue({ top: 0, left: 0, right: 1000, bottom: 800, width: 1000, height: 800 } as DOMRect);
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  let receive!: (message: HostToEditorMessage) => void;
  const host: EditorHostTransport = {
    capabilities: { sourceMode: 'embedded', git: true, terminal: false, aiCommitMessage: false, aiChat: false, documentConversion: false, shortcutPersistence: false },
    postMessage: vi.fn(),
    subscribe(listener) { receive = listener; return { unsubscribe() {} }; },
  };
  const editor = createEasyViewEditor({ host });
  const markdown = '# Heading\nchanged\n';
  const gitStatus = (documentId: string, revision: number): HostToEditorMessage => ({
    type: 'gitStatusChanged',
    documentId,
    revision,
    lineRanges: [{ startLine: 2, endLine: 2, kind: 'modified' }],
    snapshot: { indexObjectId: 'test', baseContent: '# Heading\nkept\n', currentContentHash: '', isUntracked: false },
  });
  const snapshot = (documentId: string, filePath: string, revision: number, extras: Partial<Extract<HostToEditorMessage, { type: 'documentSnapshot' }>> = {}): HostToEditorMessage => ({
    type: 'documentSnapshot',
    documentId,
    revision,
    content: markdown,
    contentHash: 'test',
    filename: filePath.split('/').pop(),
    filePath,
    reason: extras.reason ?? 'visible',
    ...extras,
  });
  try {
    receive(snapshot('doc-a', '/tmp/a.md', 1, { reason: 'initial' }));
    receive(gitStatus('doc-a', 1));
    const toggle = document.querySelector('[data-action="toggleViewChanges"]') as HTMLButtonElement;
    expect(toggle.disabled).toBe(false);
    toggle.click();
    expect(document.querySelector('.easyview-change-view')).toBeTruthy();
    expect(editor.getUiState().viewChanges).toBe(true);

    receive(snapshot('doc-b', '/tmp/b.md', 1));
    receive(gitStatus('doc-b', 1));
    expect(document.querySelector('.easyview-change-view')).toBeNull();
    expect(editor.getUiState().viewChanges).toBe(false);

    receive(snapshot('doc-a', '/tmp/a.md', 1));
    receive(gitStatus('doc-a', 1));
    expect(document.querySelector('.easyview-change-view')).toBeTruthy();
    expect(editor.getUiState().viewChanges).toBe(true);
  } finally {
    await new Promise((resolve) => setTimeout(resolve, 120));
    editor.dispose();
    document.body.replaceChildren();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  }
});

it('reopens remembered change view from host uiState after a fresh editor boot', async () => {
  document.body.innerHTML = '<div id="editor-body"><div id="editor-scroll-area"><div id="editor"></div></div></div>';
  const scrollArea = document.getElementById('editor-scroll-area')!;
  vi.spyOn(scrollArea, 'getBoundingClientRect').mockReturnValue({ top: 0, left: 0, right: 1000, bottom: 800, width: 1000, height: 800 } as DOMRect);
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  let receive!: (message: HostToEditorMessage) => void;
  const host: EditorHostTransport = {
    capabilities: { sourceMode: 'embedded', git: true, terminal: false, aiCommitMessage: false, aiChat: false, documentConversion: false, shortcutPersistence: false },
    postMessage: vi.fn(),
    subscribe(listener) { receive = listener; return { unsubscribe() {} }; },
  };
  const editor = createEasyViewEditor({ host });
  try {
    receive({
      type: 'documentSnapshot',
      documentId: 'doc-a',
      revision: 1,
      content: '# Heading\nchanged\n',
      contentHash: 'test',
      filename: 'a',
      filePath: '/tmp/a.md',
      reason: 'initial',
      uiState: { viewChanges: true },
    } as HostToEditorMessage);
    receive({
      type: 'gitStatusChanged',
      documentId: 'doc-a',
      revision: 1,
      lineRanges: [{ startLine: 2, endLine: 2, kind: 'modified' }],
      snapshot: { indexObjectId: 'test', baseContent: '# Heading\nkept\n', currentContentHash: '', isUntracked: false },
    });
    expect(document.querySelector('.easyview-change-view')).toBeTruthy();
    expect(editor.getUiState().viewChanges).toBe(true);
  } finally {
    await new Promise((resolve) => setTimeout(resolve, 120));
    editor.dispose();
    document.body.replaceChildren();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  }
});

it('disables change view and closes it when git has no uncommitted changes', async () => {
  document.body.innerHTML = '<div id="editor-body"><div id="editor-scroll-area"><div id="editor"></div></div></div>';
  const scrollArea = document.getElementById('editor-scroll-area')!;
  vi.spyOn(scrollArea, 'getBoundingClientRect').mockReturnValue({ top: 0, left: 0, right: 1000, bottom: 800, width: 1000, height: 800 } as DOMRect);
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  let receive!: (message: HostToEditorMessage) => void;
  const host: EditorHostTransport = {
    capabilities: { sourceMode: 'embedded', git: true, terminal: false, aiCommitMessage: false, aiChat: false, documentConversion: false, shortcutPersistence: false },
    postMessage: vi.fn(),
    subscribe(listener) { receive = listener; return { unsubscribe() {} }; },
  };
  const editor = createEasyViewEditor({ host });
  const toggle = () => document.querySelector('[data-action="toggleViewChanges"]') as HTMLButtonElement;
  try {
    receive({
      type: 'documentSnapshot',
      documentId: 'doc-a',
      revision: 1,
      content: '# Heading\nclean\n',
      contentHash: 'test',
      filename: 'a.md',
      filePath: '/tmp/a.md',
      reason: 'initial',
    } as HostToEditorMessage);
    expect(toggle().disabled).toBe(true);

    receive({
      type: 'gitStatusChanged',
      documentId: 'doc-a',
      revision: 1,
      lineRanges: [],
      snapshot: { indexObjectId: 'test', baseContent: '# Heading\nclean\n', currentContentHash: '', isUntracked: false },
    });
    expect(toggle().disabled).toBe(true);
    toggle().click();
    expect(document.querySelector('.easyview-change-view')).toBeNull();

    receive({
      type: 'gitStatusChanged',
      documentId: 'doc-a',
      revision: 1,
      lineRanges: [{ startLine: 2, endLine: 2, kind: 'modified' }],
      snapshot: { indexObjectId: 'test', baseContent: '# Heading\nkept\n', currentContentHash: '', isUntracked: false },
    });
    expect(toggle().disabled).toBe(false);
    toggle().click();
    expect(document.querySelector('.easyview-change-view')).toBeTruthy();

    receive({
      type: 'gitStatusChanged',
      documentId: 'doc-a',
      revision: 1,
      lineRanges: [],
      snapshot: { indexObjectId: 'test', baseContent: '# Heading\nclean\n', currentContentHash: '', isUntracked: false },
    });
    expect(document.querySelector('.easyview-change-view')).toBeNull();
    expect(toggle().disabled).toBe(true);
    expect(editor.getUiState().viewChanges).toBe(false);
  } finally {
    await new Promise((resolve) => setTimeout(resolve, 120));
    editor.dispose();
    document.body.replaceChildren();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  }
});
