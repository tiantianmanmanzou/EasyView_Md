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

    editor.dispose();
    error.mockRestore();
    vi.unstubAllGlobals();
  });

});
