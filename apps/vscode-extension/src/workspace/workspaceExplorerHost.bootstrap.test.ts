import { describe, expect, it, vi } from 'vitest';

const mock = vi.hoisted(() => ({
  provider: null as null | { resolveWebviewView(view: unknown, context: unknown, token: unknown): void },
  errors: [] as string[],
  focusOnStartup: false,
  readFile: async (): Promise<Uint8Array> => { throw new Error('No saved sort config'); },
}));

vi.mock('vscode', () => {
  const uri = (value: string, scheme = 'file'): object => ({
    scheme, path: value, fsPath: value, authority: '',
    toString: () => `${scheme}://${value}`,
    with: (change: { scheme: string }) => uri(value, change.scheme),
  });
  const disposable = () => ({ dispose() {} });
  return {
    env: { appName: 'Code' },
    Uri: { joinPath: (base: { path: string }, ...segments: string[]) => uri(`${base.path}/${segments.join('/')}`) },
    RelativePattern: class { constructor(_root: unknown, _pattern: string) {} },
    Disposable: { from: () => disposable() },
    workspace: {
      workspaceFolders: [{ name: 'Workspace', uri: uri('/workspace') }],
      getConfiguration: () => ({ get: () => mock.focusOnStartup }),
      onDidChangeWorkspaceFolders: disposable,
      onDidSaveTextDocument: disposable,
      onDidRenameFiles: disposable,
      createFileSystemWatcher: () => ({ ...disposable(), onDidCreate: disposable, onDidChange: disposable, onDidDelete: disposable }),
      fs: { readFile: () => mock.readFile() },
    },
    window: {
      tabGroups: { all: [{ tabs: [] }], activeTabGroup: { activeTab: undefined }, onDidChangeTabs: disposable, onDidChangeTabGroups: disposable },
      activeTextEditor: undefined,
      registerWebviewViewProvider: (_id: string, provider: typeof mock.provider) => { mock.provider = provider; return disposable(); },
      onDidChangeActiveTextEditor: disposable,
      onDidChangeWindowState: disposable,
      showErrorMessage: (message: string) => { mock.errors.push(message); },
    },
    commands: { registerCommand: disposable, executeCommand: vi.fn(async () => undefined) },
  };
});

import * as vscode from 'vscode';
import { registerWorkspaceExplorer } from './workspaceExplorerHost';

function memento(values = new Map<string, unknown>()) {
  return {
    get: <T>(key: string) => values.get(key) as T | undefined,
    update: async (key: string, value: unknown) => { values.set(key, value); },
  };
}

describe('workspace explorer startup', () => {
  it.each([
    { name: 'hides the sidebar in an empty welcome window', folder: false, tab: false, enabled: true, command: 'workbench.action.closeSidebar' },
    { name: 'shows Files when a workspace is open', folder: true, tab: false, enabled: true, command: 'workbench.view.extension.easyviewMd-workspacePanel' },
    { name: 'keeps the sidebar state for a standalone file', folder: false, tab: true, enabled: true, command: undefined },
    { name: 'respects disabled startup sidebar management', folder: false, tab: false, enabled: false, command: undefined },
  ])('$name', async ({ folder, tab, enabled, command }) => {
    vi.useFakeTimers();
    const folders = vscode.workspace.workspaceFolders;
    const groups = vscode.window.tabGroups.all;
    let subscription: vscode.Disposable | undefined;
    try {
      mock.focusOnStartup = enabled;
      Object.assign(vscode.workspace, { workspaceFolders: folder ? folders : undefined });
      Object.assign(vscode.window.tabGroups, { all: [{ tabs: tab ? [{ input: { uri: { scheme: 'file' } } }] : [] }] });
      subscription = registerWorkspaceExplorer({ extensionUri: { path: '/extension' }, globalStorageUri: { fsPath: '/tmp/easyview-timeline-test-storage' }, workspaceState: memento() } as never);
      const execute = vi.mocked(vscode.commands.executeCommand);
      execute.mockClear();
      await vi.advanceTimersByTimeAsync(250);
      const sidebarCommands = execute.mock.calls.filter(([id]) => id === 'workbench.action.closeSidebar' || id === 'workbench.view.extension.easyviewMd-workspacePanel');
      expect(sidebarCommands).toEqual(command ? [[command]] : []);
    } finally {
      subscription?.dispose();
      mock.focusOnStartup = false;
      Object.assign(vscode.workspace, { workspaceFolders: folders });
      Object.assign(vscode.window.tabGroups, { all: groups });
      vi.useRealTimers();
    }
  });

  it('reveals restored EasyView tabs using their disk URI and follows subsequent tab switches', async () => {
    const first = vscode.Uri.joinPath(vscode.workspace.workspaceFolders![0].uri, '功能设计', '设计.md').with({ scheme: 'easyviewMd' });
    const second = vscode.Uri.joinPath(vscode.workspace.workspaceFolders![0].uri, '笔记', '笔记本.md').with({ scheme: 'easyviewMd' });
    const tabGroup = vscode.window.tabGroups.activeTabGroup as unknown as { activeTab: unknown };
    tabGroup.activeTab = { input: { uri: first } } as never;
    const subscription = registerWorkspaceExplorer({ extensionUri: { path: '/extension' }, globalStorageUri: { fsPath: '/tmp/easyview-timeline-test-storage' }, workspaceState: memento() } as never);
    const events: Array<{ type: string; relativePath?: string; revealRelativePath?: string }> = [];
    const provider = mock.provider as unknown as {
      resolveWebviewView(view: unknown, context: unknown, token: unknown): void;
      dispatchRequest(message: unknown): Promise<void>;
      revealActive(force: boolean): void;
    };
    try {
      provider.resolveWebviewView({
        visible: true,
        webview: { options: {}, asWebviewUri: (uri: unknown) => uri, onDidReceiveMessage: () => ({ dispose() {} }), postMessage: async (event: typeof events[number]) => { events.push(event); return true; }, html: '' },
        onDidChangeVisibility: () => ({ dispose() {} }), onDidDispose: () => ({ dispose() {} }),
      }, {}, {});
      await provider.dispatchRequest({ type: 'ready' });
      await vi.waitFor(() => expect(events).toContainEqual(expect.objectContaining({ type: 'bootstrap', revealRelativePath: '功能设计/设计.md' })));
      tabGroup.activeTab = { input: { uri: second } } as never;
      provider.revealActive(false);
      expect(events).toContainEqual({ type: 'reveal', relativePath: '笔记/笔记本.md' });
    } finally {
      tabGroup.activeTab = undefined;
      subscription.dispose();
    }
  });

  it('routes PDF and Word tree actions to the existing converter commands for the clicked file', async () => {
    const subscription = registerWorkspaceExplorer({ extensionUri: { path: '/extension' }, globalStorageUri: { fsPath: '/tmp/easyview-timeline-test-storage' }, workspaceState: memento() } as never);
    const provider = mock.provider as unknown as { dispatchRequest(message: unknown): Promise<void> };
    const execute = vi.mocked(vscode.commands.executeCommand);
    try {
      execute.mockClear();
      await provider.dispatchRequest({ type: 'convertToMarkdown', relativePath: 'docs/report.pdf' });
      expect(execute).toHaveBeenCalledWith('easyviewMd.convertPdfToMarkdown', expect.objectContaining({ fsPath: '/workspace/docs/report.pdf' }));
      await provider.dispatchRequest({ type: 'convertToMarkdown', relativePath: 'docs/brief.docx' });
      expect(execute).toHaveBeenCalledWith('easyviewMd.convertWordToMarkdown', expect.objectContaining({ fsPath: '/workspace/docs/brief.docx' }));
      await expect(provider.dispatchRequest({ type: 'convertToMarkdown', relativePath: '../outside.pdf' })).rejects.toThrow();
    } finally {
      subscription.dispose();
    }
  });

  it('receives a ready message emitted during HTML assignment and bootstraps the root', async () => {
    const subscription = registerWorkspaceExplorer({ extensionUri: { path: '/extension' }, globalStorageUri: { fsPath: '/tmp/easyview-timeline-test-storage' }, workspaceState: memento() } as never);
    const events: Array<{ type: string; rootName?: string }> = [];
    let onMessage: ((message: unknown) => void) | undefined;
    const webview = {
      options: {},
      asWebviewUri: (value: unknown) => value,
      onDidReceiveMessage: (callback: (message: unknown) => void) => { onMessage = callback; return { dispose() {} }; },
      postMessage: async (event: { type: string; rootName?: string }) => { events.push(event); return true; },
      set html(_value: string) { onMessage?.({ type: 'ready' }); },
    };
    mock.provider!.resolveWebviewView({ webview, onDidChangeVisibility: () => ({ dispose() {} }), onDidDispose: () => ({ dispose() {} }) }, {}, {});
    await vi.waitFor(() => expect(events.some((event) => event.type === 'bootstrap' && event.rootName === 'Workspace')).toBe(true));
    expect(mock.errors).toEqual([]);
    subscription.dispose();
  });

  it('bootstraps only after tree-order.json is applied, even when the webview is ready first', async () => {
    const defaultReadFile = mock.readFile;
    let releaseConfig!: (bytes: Uint8Array) => void;
    mock.readFile = () => new Promise((settle) => { releaseConfig = settle; });
    const subscription = registerWorkspaceExplorer({ extensionUri: { path: '/extension' }, globalStorageUri: { fsPath: '/tmp/easyview-timeline-test-storage' }, workspaceState: memento() } as never);
    const events: Array<{ type: string; sort?: { sortMode: string; showDotEntries: boolean } }> = [];
    const provider = mock.provider as unknown as {
      resolveWebviewView(view: unknown, context: unknown, token: unknown): void;
      dispatchRequest(message: unknown): Promise<void>;
    };
    try {
      provider.resolveWebviewView({
        visible: true,
        webview: { options: {}, asWebviewUri: (uri: unknown) => uri, onDidReceiveMessage: () => ({ dispose() {} }), postMessage: async (event: typeof events[number]) => { events.push(event); return true; }, html: '' },
        onDidChangeVisibility: () => ({ dispose() {} }), onDidDispose: () => ({ dispose() {} }),
      }, {}, {});
      await provider.dispatchRequest({ type: 'ready' });
      await new Promise((settle) => setTimeout(settle, 20));
      expect(events.filter((event) => event.type === 'bootstrap')).toEqual([]);

      releaseConfig(new TextEncoder().encode(JSON.stringify({ version: 1, sortMode: 'custom', showDotEntries: false, orders: {} })));
      await vi.waitFor(() => expect(events.some((event) => event.type === 'bootstrap')).toBe(true));
      expect(events.filter((event) => event.type === 'bootstrap').map((event) => event.sort))
        .toEqual([expect.objectContaining({ sortMode: 'custom', showDotEntries: false })]);
    } finally {
      mock.readFile = defaultReadFile;
      subscription.dispose();
    }
  });

  it('restores the folders left expanded in the previous session', async () => {
    const workspaceState = memento();
    const start = () => {
      const subscription = registerWorkspaceExplorer({ extensionUri: { path: '/extension' }, globalStorageUri: { fsPath: '/tmp/easyview-timeline-test-storage' }, workspaceState } as never);
      const events: Array<{ type: string; expandedRelativePaths?: string[] }> = [];
      const provider = mock.provider as unknown as {
        resolveWebviewView(view: unknown, context: unknown, token: unknown): void;
        dispatchRequest(message: unknown): Promise<void>;
      };
      provider.resolveWebviewView({
        visible: true,
        webview: { options: {}, asWebviewUri: (uri: unknown) => uri, onDidReceiveMessage: () => ({ dispose() {} }), postMessage: async (event: typeof events[number]) => { events.push(event); return true; }, html: '' },
        onDidChangeVisibility: () => ({ dispose() {} }), onDidDispose: () => ({ dispose() {} }),
      }, {}, {});
      return { subscription, events, provider };
    };

    const first = start();
    await first.provider.dispatchRequest({ type: 'ready' });
    await vi.waitFor(() => expect(first.events.find((event) => event.type === 'bootstrap')?.expandedRelativePaths).toEqual([]));
    await first.provider.dispatchRequest({ type: 'setExpanded', relativePath: 'docs', expanded: true });
    await first.provider.dispatchRequest({ type: 'setExpanded', relativePath: 'docs/api', expanded: true });
    await first.provider.dispatchRequest({ type: 'setExpanded', relativePath: 'docs/api', expanded: false });
    first.subscription.dispose();

    const second = start();
    try {
      await second.provider.dispatchRequest({ type: 'ready' });
      await vi.waitFor(() => expect(second.events.find((event) => event.type === 'bootstrap')?.expandedRelativePaths).toEqual(['docs']));
    } finally {
      second.subscription.dispose();
    }
  });

  it('reloads a webview that never sends ready and reports a persistent failure', async () => {
    vi.useFakeTimers();
    try {
      mock.errors.length = 0;
      const subscription = registerWorkspaceExplorer({ extensionUri: { path: '/extension' }, globalStorageUri: { fsPath: '/tmp/easyview-timeline-test-storage' }, workspaceState: memento() } as never);
      let loads = 0;
      const webview = {
        options: {},
        asWebviewUri: (value: unknown) => value,
        onDidReceiveMessage: () => ({ dispose() {} }),
        postMessage: async () => true,
        set html(_value: string) { loads += 1; },
      };
      mock.provider!.resolveWebviewView({ webview, onDidChangeVisibility: () => ({ dispose() {} }), onDidDispose: () => ({ dispose() {} }) }, {}, {});
      expect(loads).toBe(1);
      await vi.advanceTimersByTimeAsync(15_000);
      expect(loads).toBe(3);
      expect(mock.errors).toContain('EasyView_Md 文件视图加载失败。请重新加载窗口后重试。');
      subscription.dispose();
    } finally {
      vi.useRealTimers();
    }
  });
});
