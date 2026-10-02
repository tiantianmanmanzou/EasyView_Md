import { describe, expect, it, vi } from 'vitest';

const mock = vi.hoisted(() => ({
  provider: null as null | { resolveWebviewView(view: unknown, context: unknown, token: unknown): void },
  errors: [] as string[],
}));

vi.mock('vscode', () => {
  const uri = (value: string) => ({
    scheme: 'file', path: value, fsPath: value, authority: '',
    toString: () => `file://${value}`,
  });
  const disposable = () => ({ dispose() {} });
  return {
    Uri: { joinPath: (base: { path: string }, ...segments: string[]) => uri(`${base.path}/${segments.join('/')}`) },
    RelativePattern: class { constructor(_root: unknown, _pattern: string) {} },
    Disposable: { from: () => disposable() },
    workspace: {
      workspaceFolders: [{ name: 'Workspace', uri: uri('/workspace') }],
      getConfiguration: () => ({ get: () => false }),
      onDidChangeWorkspaceFolders: disposable,
      createFileSystemWatcher: () => ({ ...disposable(), onDidCreate: disposable, onDidChange: disposable, onDidDelete: disposable }),
      fs: { readFile: async () => { throw new Error('No saved sort config'); } },
    },
    window: {
      tabGroups: { activeTabGroup: { activeTab: undefined }, onDidChangeTabs: disposable, onDidChangeTabGroups: disposable },
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

describe('workspace explorer startup', () => {
  it('routes PDF and Word tree actions to the existing converter commands for the clicked file', async () => {
    const subscription = registerWorkspaceExplorer({ extensionUri: { path: '/extension' } } as never);
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
    const subscription = registerWorkspaceExplorer({ extensionUri: { path: '/extension' } } as never);
    const events: Array<{ type: string; rootName?: string }> = [];
    let onMessage: ((message: unknown) => void) | undefined;
    const webview = {
      options: {},
      asWebviewUri: (value: unknown) => value,
      onDidReceiveMessage: (callback: (message: unknown) => void) => { onMessage = callback; return { dispose() {} }; },
      postMessage: async (event: { type: string; rootName?: string }) => { events.push(event); return true; },
      set html(_value: string) { onMessage?.({ type: 'ready' }); },
    };
    mock.provider!.resolveWebviewView({ webview, onDidDispose: () => ({ dispose() {} }) }, {}, {});
    await vi.waitFor(() => expect(events.some((event) => event.type === 'bootstrap' && event.rootName === 'Workspace')).toBe(true));
    expect(mock.errors).toEqual([]);
    subscription.dispose();
  });

  it('reloads a webview that never sends ready and reports a persistent failure', async () => {
    vi.useFakeTimers();
    try {
      mock.errors.length = 0;
      const subscription = registerWorkspaceExplorer({ extensionUri: { path: '/extension' } } as never);
      let loads = 0;
      const webview = {
        options: {},
        asWebviewUri: (value: unknown) => value,
        onDidReceiveMessage: () => ({ dispose() {} }),
        postMessage: async () => true,
        set html(_value: string) { loads += 1; },
      };
      mock.provider!.resolveWebviewView({ webview, onDidDispose: () => ({ dispose() {} }) }, {}, {});
      expect(loads).toBe(1);
      await vi.advanceTimersByTimeAsync(15_000);
      expect(loads).toBe(3);
      expect(mock.errors).toContain('EasyView_Md Files could not load its view. Reload the window to retry.');
      subscription.dispose();
    } finally {
      vi.useRealTimers();
    }
  });
});
