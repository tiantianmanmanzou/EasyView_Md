// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { EditorHostTransport, HostToEditorMessage } from '@easyview/contracts';
import type { EasyViewEditorInstance } from '@easyview/editor-core';
import {
  DesktopEditorInstanceRegistry,
} from './DesktopEditorInstanceRegistry';
import type { DesktopEditorTab } from '../contracts';

function editorTab(id: string, filePath: string): DesktopEditorTab {
  return {
    id,
    kind: 'editor',
    filePath,
    fileName: filePath.split('/').pop() ?? filePath,
    dirty: false,
    documentKey: filePath,
  };
}

function createFakeEditor(label: string, disposed: string[]): EasyViewEditorInstance {
  return {
    executeCommand: vi.fn(),
    setOutlineVisible: vi.fn(),
    getUiState: () => ({ sourceMode: false, outlineVisible: false, fullWidth: true, tableWrap: false, viewChanges: false }),
    subscribeUiState: () => ({ unsubscribe: vi.fn() }),
    setOutlineWidth: vi.fn(),
    getThemeState: () => ({ mode: 'light', depth: 0.5 }),
    setThemeMode: vi.fn(),
    setThemeDepth: vi.fn(),
    getAccentTheme: () => 'default',
    setAccentTheme: vi.fn(),
    setDocumentActive: vi.fn(),
    dispose: () => disposed.push(label),
  };
}

describe('DesktopEditorInstanceRegistry', () => {
  const mounts: HTMLElement[] = [];

  afterEach(() => {
    for (const mount of mounts.splice(0)) mount.remove();
  });

  function createRegistry(overrides: {
    retainLimit?: number;
    disposed?: string[];
    created?: string[];
    hosts?: EditorHostTransport[];
    editors?: EasyViewEditorInstance[];
  } = {}) {
    const mount = document.createElement('div');
    document.body.append(mount);
    mounts.push(mount);
    const disposed = overrides.disposed ?? [];
    const created = overrides.created ?? [];
    const hosts = overrides.hosts ?? [];
    const editors = overrides.editors ?? [];
    let listener: ((message: HostToEditorMessage) => void) | undefined;
    const registry = new DesktopEditorInstanceRegistry({
      mount,
      retainLimit: overrides.retainLimit ?? 2,
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
      subscribe: (next) => {
        listener = next;
        return { unsubscribe: () => { listener = undefined; } };
      },
      createEditor: ({ root, host }) => {
        created.push(root.dataset.tabId ?? '');
        hosts.push(host);
        const editor = createFakeEditor(root.dataset.tabId ?? '', disposed);
        editors.push(editor);
        return editor;
      },
    });
    return { registry, listener: () => listener, created, disposed, editors };
  }

  it('boots each session root hidden so body-level inlinemd-booting is not required', () => {
    const { registry } = createRegistry();
    registry.activate(editorTab('a', '/tmp/a.md'));
    const root = document.querySelector<HTMLElement>('.desktop-editor-session');
    expect(root?.classList.contains('inlinemd-booting')).toBe(true);
    expect(document.body.classList.contains('inlinemd-booting')).toBe(false);
  });

  it('creates a rooted instance per tab and does not reuse it when switching away and back within the retain window', () => {
    const { registry, created } = createRegistry({ retainLimit: 5 });
    registry.activate(editorTab('a', '/tmp/a.md'));
    registry.activate(editorTab('b', '/tmp/b.md'));
    registry.activate(editorTab('a', '/tmp/a.md'));
    expect(created).toEqual(['a', 'b']);
    expect(registry.size()).toBe(2);
    expect(registry.has('a')).toBe(true);
    expect(registry.has('b')).toBe(true);
  });

  it('evicts the least recently used instance after 5 live documents and recreates it later', () => {
    const { registry, created, disposed } = createRegistry({ retainLimit: 5 });
    for (const id of ['a', 'b', 'c', 'd', 'e']) {
      registry.activate(editorTab(id, `/tmp/${id}.md`));
    }
    expect(registry.size()).toBe(5);
    registry.activate(editorTab('f', '/tmp/f.md'));
    expect(disposed).toEqual(['a']);
    expect(registry.has('a')).toBe(false);
    expect(registry.size()).toBe(5);

    registry.activate(editorTab('a', '/tmp/a.md'));
    expect(created.filter((id) => id === 'a')).toEqual(['a', 'a']);
    expect(registry.has('a')).toBe(true);
  });

  it('routes a documentSnapshot only to the matching instance', () => {
    const hosts: EditorHostTransport[] = [];
    const { registry, listener } = createRegistry({ retainLimit: 5, hosts });
    registry.activate(editorTab('a', '/tmp/a.md'));
    registry.activate(editorTab('b', '/tmp/b.md'));
    const aMessages: HostToEditorMessage[] = [];
    const bMessages: HostToEditorMessage[] = [];
    hosts[0]?.subscribe((message) => aMessages.push(message));
    hosts[1]?.subscribe((message) => bMessages.push(message));

    listener()?.({
      type: 'documentSnapshot',
      documentId: '/tmp/a.md',
      revision: 1,
      content: '# A',
      contentHash: 'ignored',
    });
    expect(aMessages).toHaveLength(1);
    expect(bMessages).toHaveLength(0);
  });

  it('disposes instances whose tabs have closed', () => {
    const { registry, disposed } = createRegistry({ retainLimit: 5 });
    registry.activate(editorTab('a', '/tmp/a.md'));
    registry.activate(editorTab('b', '/tmp/b.md'));
    registry.syncOpenTabs(['b']);
    expect(disposed).toEqual(['a']);
    expect(registry.has('a')).toBe(false);
    expect(registry.has('b')).toBe(true);
  });

  it('keeps two visible instances mounted and routes the same document snapshot to both', () => {
    const hosts: EditorHostTransport[] = [];
    const { registry, listener } = createRegistry({ retainLimit: 2, hosts });
    const left = document.createElement('div');
    const right = document.createElement('div');
    document.body.append(left, right);
    const a = editorTab('a', '/tmp/a.md');
    const aSplit = editorTab('a-split', '/tmp/a.md');
    registry.setVisible([a, aSplit], new Map([['a', left], ['a-split', right]]));
    expect(left.querySelector<HTMLElement>('.desktop-editor-session')?.hidden).toBe(false);
    expect(right.querySelector<HTMLElement>('.desktop-editor-session')?.hidden).toBe(false);

    const aMessages: HostToEditorMessage[] = [];
    const splitMessages: HostToEditorMessage[] = [];
    hosts[0]?.subscribe((message) => aMessages.push(message));
    hosts[1]?.subscribe((message) => splitMessages.push(message));
    listener()?.({
      type: 'documentSnapshot',
      documentId: '/tmp/a.md',
      revision: 1,
      content: '# A',
      contentHash: 'ignored',
    });
    expect(aMessages).toHaveLength(1);
    expect(splitMessages).toHaveLength(1);
    left.remove();
    right.remove();
  });

  it('does not evict a visible pane when the retain window is exceeded', () => {
    const { registry, disposed } = createRegistry({ retainLimit: 1 });
    const left = document.createElement('div');
    const right = document.createElement('div');
    document.body.append(left, right);
    registry.setVisible(
      [editorTab('a', '/tmp/a.md'), editorTab('b', '/tmp/b.md')],
      new Map([['a', left], ['b', right]]),
    );
    expect(disposed).toEqual([]);
    expect(registry.has('a')).toBe(true);
    expect(registry.has('b')).toBe(true);
    expect(registry.size()).toBe(2);
    left.remove();
    right.remove();
  });
});
