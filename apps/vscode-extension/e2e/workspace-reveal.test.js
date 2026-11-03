const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const vscode = require('vscode');
const { buildSync } = require('esbuild');

suite('EasyView workspace reveal after restore', () => {
  test('maps restored custom tabs and subsequent tab changes to disk paths', async () => {
    await vscode.extensions.getExtension('zhangxy.easyview-md').activate();
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'easyview-workspace-reveal-'));
    let provider;
    let subscription;
    try {
      await fs.mkdir(path.join(directory, '功能设计'));
      await fs.mkdir(path.join(directory, '笔记'));
      const first = vscode.Uri.file(path.join(directory, '功能设计', '设计.md')).with({ scheme: 'easyviewMd' });
      const second = vscode.Uri.file(path.join(directory, '笔记', '笔记本.md')).with({ scheme: 'easyviewMd' });
      await fs.writeFile(first.fsPath, '# Design\n');
      await fs.writeFile(second.fsPath, '# Notes\n');
      // Use real tab events and file APIs, with an isolated sidebar message sink.
      const host = {
        Uri: vscode.Uri, FileType: vscode.FileType, Disposable: vscode.Disposable, RelativePattern: vscode.RelativePattern, env: vscode.env,
        workspace: { fs: vscode.workspace.fs, workspaceFolders: [{ name: 'Fixture', index: 0, uri: vscode.Uri.file(directory) }], onDidChangeWorkspaceFolders: vscode.workspace.onDidChangeWorkspaceFolders, onDidSaveTextDocument: vscode.workspace.onDidSaveTextDocument, onDidRenameFiles: vscode.workspace.onDidRenameFiles, createFileSystemWatcher: vscode.workspace.createFileSystemWatcher, getWorkspaceFolder: vscode.workspace.getWorkspaceFolder, getConfiguration: () => ({ get: () => false }) },
        window: { tabGroups: vscode.window.tabGroups, get activeTextEditor() { return vscode.window.activeTextEditor; }, onDidChangeActiveTextEditor: vscode.window.onDidChangeActiveTextEditor, onDidChangeWindowState: vscode.window.onDidChangeWindowState, showErrorMessage: vscode.window.showErrorMessage, registerWebviewViewProvider: (_id, value) => { provider = value; return new vscode.Disposable(() => {}); } },
        commands: { executeCommand: vscode.commands.executeCommand, registerCommand: () => new vscode.Disposable(() => {}) },
      };
      const source = path.resolve(__dirname, '../src/workspace/workspaceExplorerHost.ts');
      const compiled = buildSync({ entryPoints: [source], bundle: true, platform: 'node', format: 'cjs', external: ['vscode', 'node-pty'], write: false });
      const module = { exports: {} };
      new Function('require', 'module', 'exports', compiled.outputFiles[0].text)((name) => name === 'vscode' ? host : require(name), module, module.exports);
      await vscode.commands.executeCommand('vscode.openWith', first, 'easyviewMd.markdownEditor', { preview: false });
      const workspaceState = new Map();
      subscription = module.exports.registerWorkspaceExplorer({
        extensionUri: vscode.Uri.file(path.resolve(__dirname, '..')),
        globalStorageUri: vscode.Uri.file(path.join(directory, 'data', 'User', 'globalStorage', 'easyview')),
        workspaceState: { get: (key) => workspaceState.get(key), update: async (key, value) => { workspaceState.set(key, value); } },
      });
      const events = [];
      provider.resolveWebviewView({ visible: true, webview: { options: {}, asWebviewUri: (uri) => uri, onDidReceiveMessage: () => new vscode.Disposable(() => {}), postMessage: async (event) => { events.push(event); return true; }, html: '' }, onDidChangeVisibility: () => new vscode.Disposable(() => {}), onDidDispose: () => new vscode.Disposable(() => {}) }, {}, {});
      await provider.dispatchRequest({ type: 'ready' });
      const bootstrapDeadline = Date.now() + 10000;
      while (!events.some((event) => event.type === 'bootstrap' && event.revealRelativePath === '功能设计/设计.md')) {
        if (Date.now() > bootstrapDeadline) throw new Error(JSON.stringify(events));
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      await vscode.commands.executeCommand('vscode.openWith', second, 'easyviewMd.markdownEditor', { preview: false });
      const deadline = Date.now() + 10000;
      while (!events.some((event) => event.type === 'reveal' && event.relativePath === '笔记/笔记本.md')) {
        if (Date.now() > deadline) throw new Error(JSON.stringify(events));
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      assert.ok(events.some((event) => event.type === 'reveal' && event.relativePath === '笔记/笔记本.md'));
    } finally {
      subscription?.dispose();
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
      await fs.rm(directory, { recursive: true, force: true });
    }
  });
});
