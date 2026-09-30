// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { EditorHostTransport, HostToEditorMessage } from '@easyview/contracts';
import { createEasyViewEditor } from './index';

function createHost(): EditorHostTransport {
  return {
    capabilities: {
      sourceMode: 'embedded',
      git: false,
      terminal: false,
      aiCommitMessage: false,
      aiChat: false,
      documentConversion: false,
      shortcutPersistence: false,
    },
    postMessage: vi.fn(),
    subscribe: (_listener: (message: HostToEditorMessage) => void) => ({ unsubscribe: vi.fn() }),
  };
}

afterEach(() => {
  document.body.replaceChildren();
  document.head.querySelectorAll('style[id^="easyview-"]').forEach((node) => node.remove());
});

describe('createEasyViewEditor entry boundary', () => {
  it('can be imported without creating an editor or reading the host runtime', () => {
    expect(createEasyViewEditor).toBeTypeOf('function');
  });

  it('starts when Follow is enabled before the editor view exists', () => {
    localStorage.setItem('mdpre-external-follow-scroll', 'true');
    const root = document.createElement('section');
    document.body.append(root);
    let editor: ReturnType<typeof createEasyViewEditor> | undefined;
    try {
      editor = createEasyViewEditor({ host: createHost(), root });
      expect(editor).toBeDefined();
    } finally {
      editor?.dispose();
      localStorage.removeItem('mdpre-external-follow-scroll');
    }
  });

  it('creates and disposes simultaneous rooted instances without sharing facade state', () => {
    const firstRoot = document.createElement('section');
    const secondRoot = document.createElement('section');
    document.body.append(firstRoot, secondRoot);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const first = createEasyViewEditor({ host: createHost(), root: firstRoot });
    const second = createEasyViewEditor({ host: createHost(), root: secondRoot });

    first.setOutlineVisible(true);
    expect(first.getUiState().outlineVisible).toBe(true);
    expect(second.getUiState().outlineVisible).toBe(false);

    first.dispose();
    expect(() => second.setOutlineVisible(true)).not.toThrow();
    expect(second.getUiState().outlineVisible).toBe(true);
    second.dispose();
    error.mockRestore();
  });
  it('reveals the editor after the initial document snapshot is rendered', async () => {
    localStorage.setItem('mdpre-external-follow-scroll', 'true');
    const root = document.createElement('section');
    root.classList.add('inlinemd-booting');
    root.innerHTML = `
      <div id="title-bar"></div>
      <div id="editor-body">
        <div id="editor-scroll-area"><div id="editor"></div></div>
      </div>
    `;
    document.body.append(root);
    let listener: ((message: HostToEditorMessage) => void) | undefined;
    const host = createHost();
    host.subscribe = (next) => {
      listener = next;
      return { unsubscribe: vi.fn() };
    };
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.stubGlobal('ResizeObserver', class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    });
    const editor = createEasyViewEditor({ host, root });

    expect(listener).toBeTypeOf('function');
    listener?.({
      type: 'documentSnapshot',
      documentId: 'test-document',
      revision: 1,
      content: '# Heading\n\nBody',
      contentHash: 'ignored',
      filename: 'test',
      filePath: '/tmp/test.md',
      fullWidth: false,
      tocVisible: true,
      tableWrap: false,
      tableFirstRowStickyDefault: false,
      initialCursorLine: 0,
      initialCursorCharacter: 0,
      initialTotalLines: 3,
      imagePathMap: {},
      uiState: {},
      reason: 'initial',
    });

    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));

    expect(root.classList.contains('inlinemd-booting')).toBe(false);
    expect(root.classList.contains('inlinemd-ready')).toBe(true);
    expect(root.querySelector('.ProseMirror')?.textContent).toContain('Heading');
    expect(document.querySelector('.ai-changes-toast.visible .ai-changes-toast-summary')?.textContent).toBe('No changes');

    editor.dispose();
    localStorage.removeItem('mdpre-external-follow-scroll');
    error.mockRestore();
    vi.unstubAllGlobals();
  });

  it('keeps undo-related facade state isolated across five simultaneous instances', () => {
    vi.stubGlobal('ResizeObserver', class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    });
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const editors = Array.from({ length: 5 }, () => {
      const root = document.createElement('section');
      root.innerHTML = `
        <div id="title-bar"></div>
        <div id="editor-body">
          <div id="editor-scroll-area"><div id="editor"></div></div>
        </div>
      `;
      document.body.append(root);
      return createEasyViewEditor({ host: createHost(), root });
    });

    editors[0]?.setOutlineVisible(true);
    editors[2]?.setOutlineVisible(true);
    expect(editors.map((editor) => editor.getUiState().outlineVisible)).toEqual([
      true, false, true, false, false,
    ]);

    editors[0]?.dispose();
    expect(editors[2]?.getUiState().outlineVisible).toBe(true);
    editors.slice(1).forEach((editor) => editor.dispose());
    error.mockRestore();
    vi.unstubAllGlobals();
  });

  it('does not throw when a document switch arrives after a source-mode toggle (tab switch reuse)', async () => {
    // Regression guard for cross-document undo leakage: on desktop, tab switches reuse the
    // same editor-core instance and only send a new documentSnapshot (no dispose/recreate).
    // Toggling source mode records a DualModeHistory snapshot; switching to a different
    // filePath afterwards must clear that snapshot instead of leaving it to be restored
    // into the new document once its native undo stack is exhausted.
    const root = document.createElement('section');
    root.innerHTML = `
      <div id="title-bar"></div>
      <div id="editor-body">
        <div id="editor-scroll-area"><div id="editor"></div></div>
      </div>
    `;
    document.body.append(root);
    let listener: ((message: HostToEditorMessage) => void) | undefined;
    const host = createHost();
    host.subscribe = (next) => {
      listener = next;
      return { unsubscribe: vi.fn() };
    };
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.stubGlobal('ResizeObserver', class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    });
    const editor = createEasyViewEditor({ host, root });

    const baseSnapshot = {
      type: 'documentSnapshot' as const,
      documentId: 'doc-a',
      revision: 1,
      contentHash: 'ignored',
      filename: 'a',
      fullWidth: false,
      tocVisible: true,
      tableWrap: false,
      tableFirstRowStickyDefault: false,
      initialCursorLine: 0,
      initialCursorCharacter: 0,
      initialTotalLines: 1,
      imagePathMap: {},
      uiState: {},
      reason: 'initial' as const,
    };

    listener?.({ ...baseSnapshot, content: '# Doc A', filePath: '/tmp/a.md' });
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));

    // Leave a stale cross-mode snapshot behind for doc A.
    expect(() => editor.executeCommand('toggleSourceMode')).not.toThrow();

    // Switch to a different document without disposing the instance (desktop tab switch).
    expect(() => listener?.({ ...baseSnapshot, content: '# Doc B', filePath: '/tmp/b.md', reason: 'visible' })).not.toThrow();

    editor.dispose();
    error.mockRestore();
    vi.unstubAllGlobals();
  });

});
