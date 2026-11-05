import * as vscode from 'vscode';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { VersionGuardService } from '@easyview/node-runtime';
import { guardTimelineComparison, isMarkdownFilePath, type GuardRequest, type GuardComparison } from '@easyview/contracts';
import { getLocale } from '@easyview/contracts/i18n';
import { resolveMarkdownDiskUri, openMarkdownInEasyViewEditor } from '../application/document/openMarkdownEditor';
import { MarkdownEditorProvider } from '../adapters/vscode/provider';
import { tGuardHost } from './guardHost.i18n';
export function registerVersionGuard(context: vscode.ExtensionContext): vscode.Disposable {
  let view: vscode.WebviewView | undefined;
  let watcher: vscode.FileSystemWatcher | undefined;
  const documents = (files: string[]) => vscode.workspace.textDocuments.filter(doc => doc.uri.scheme !== 'untitled' && files.includes(resolveMarkdownDiskUri(doc.uri).fsPath));
  const service = new VersionGuardService({
    discovered: (repositories, warnings) => post({ type: 'guard.discovery', repositories, warnings }),
    roots: () => (vscode.workspace.workspaceFolders ?? []).filter(folder => folder.uri.scheme === 'file').map(folder => folder.uri.fsPath),
    beforeStage: async files => {
      await MarkdownEditorProvider.flushFiles(files);
      for (const file of files) {
        const docs = documents([file]); const dirty = docs.filter(doc => doc.isDirty);
        if (new Set(dirty.map(doc => doc.getText())).size > 1) throw new Error(tGuardHost('inconsistent'));
        for (const doc of dirty) {
          const content = doc.getText(); if (!await doc.save()) throw new Error(tGuardHost('save'));
          if (doc.uri.scheme !== 'file' || doc.uri.fsPath !== file) await vscode.workspace.fs.writeFile(vscode.Uri.file(file), Buffer.from(content));
        }
      }
    },
    discard: async (files, action) => {
      await MarkdownEditorProvider.flushFiles(files);
      const docs = documents(files); const baselines = docs.map(doc => doc.version);
      const listed = [...files.slice(0, 10), ...(files.length > 10 ? [`… +${files.length - 10}`] : [])].join('\n');
      if (await vscode.window.showWarningMessage(`${tGuardHost('confirm')}\n\n${listed}`, { modal: true }, tGuardHost('discard')) !== tGuardHost('discard')) return false;
      if (docs.some((doc, i) => doc.version !== baselines[i])) throw new Error(tGuardHost('changed'));
      await action();
      const edit = new vscode.WorkspaceEdit(); const missing = new Set<string>();
      for (const file of files) {
        const raw = await fs.readFile(file, 'utf8').catch(error => { if (error.code === 'ENOENT') return null; throw error; });
        if (raw === null) { missing.add(file); continue; }
        for (const doc of documents([file])) edit.replace(doc.uri, new vscode.Range(0, 0, doc.lineCount, 0), raw);
      }
      if (!await vscode.workspace.applyEdit(edit)) throw new Error(tGuardHost('save'));
      for (const doc of docs.filter(doc => !missing.has(resolveMarkdownDiskUri(doc.uri).fsPath))) if (doc.isDirty && !await doc.save()) throw new Error(tGuardHost('save'));
      for (const file of files.filter(file => !missing.has(file))) await MarkdownEditorProvider.reloadPanelsForDocument(vscode.Uri.file(file), await fs.readFile(file, 'utf8'));
      // Resource deletion lets the host close dirty editors without recreating deleted files.
      if (missing.size) { const deletion = new vscode.WorkspaceEdit(); for (const doc of docs.filter(doc => missing.has(resolveMarkdownDiskUri(doc.uri).fsPath))) deletion.deleteFile(doc.uri, { ignoreIfNotExists: true }); if (!await vscode.workspace.applyEdit(deletion)) throw new Error(tGuardHost('save')); }
      return true;
    },
    trash: async file => { await vscode.workspace.fs.delete(vscode.Uri.file(file), { useTrash: true, recursive: false }); },
  });
  const post = (message: unknown) => { if (view) void view.webview.postMessage(message); };
  const active = () => {
    watcher?.dispose(); watcher = undefined;
    const enabled = !!view?.visible && vscode.window.state.focused;
    service.setActive(enabled, paths => post({ type: 'guard.changed', paths }));
    if (enabled) {
      watcher = vscode.workspace.createFileSystemWatcher('**/*');
      const invalidate = (uri: vscode.Uri) => post({ type: 'guard.changed', paths: [uri.fsPath] });
      watcher.onDidChange(invalidate); watcher.onDidCreate(invalidate); watcher.onDidDelete(invalidate);
    }
  };
  const panels = new Set<vscode.WebviewPanel>();
  const provider = vscode.window.registerWebviewViewProvider('easyviewMd.versionGuard', {
    resolveWebviewView(webviewView) {
      view = webviewView; const webview = view.webview;
      const dist = vscode.Uri.joinPath(context.extensionUri, 'dist');
      webview.options = { enableScripts: true, localResourceRoots: [dist] };
      webview.html = `<!doctype html><html lang="${getLocale()}"><head><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src ${webview.cspSource}; style-src ${webview.cspSource} 'unsafe-inline';"></head><body style="padding:0;height:100vh;overflow:hidden;--guard-accent:var(--vscode-button-background)"><main id="guard-root" style="height:100%"></main><script type="module" src="${webview.asWebviewUri(vscode.Uri.joinPath(dist, 'version-guard.js'))}"></script></body></html>`;
      const messages = webview.onDidReceiveMessage(async message => {
        if (message.type === 'guard.ready') { post({ type: 'guard.visible', visible: view?.visible }); active(); return; }
        if (message.type === 'guard.expandState') { void vscode.commands.executeCommand('setContext', 'easyviewMd.versionGuard.allExpanded', message.allExpanded === true); return; }
        if (message.type !== 'guard.request' || !Number.isSafeInteger(message.id)) return;
        try {
          if (!vscode.workspace.isTrusted) throw new Error(tGuardHost('trust'));
          const request = message.request as GuardRequest;
          let value: unknown;
          if (request?.method === 'active') { active(); value = true; }
          else if (request?.method === 'confirm') {
            const choices = (request.choices ?? []).map(String);
            const choice = await vscode.window.showWarningMessage(String(request.message ?? ''), { modal: true, detail: request.detail }, ...choices);
            value = choice === undefined ? -1 : choices.indexOf(choice);
          }
          else if (request?.method === 'openFile') {
            const repo = await service.repository(request.repository); const [file] = await service.files(repo, request.paths); const uri = vscode.Uri.file(path.join(repo.rootPath, file));
            if (isMarkdownFilePath(file)) await openMarkdownInEasyViewEditor(uri, context); else await vscode.commands.executeCommand('vscode.open', uri); value = true;
          } else if (request?.method === 'openDiff') {
            const comparison = guardTimelineComparison(await service.handle({ ...request, method: 'comparison' }) as GuardComparison);
            const panel = vscode.window.createWebviewPanel('easyviewMd.versionGuardDiff', `${path.basename(comparison.entry.filePath)} · ${comparison.contentLabel}`, vscode.ViewColumn.Active, { enableScripts: true, localResourceRoots: [dist] }); panels.add(panel);
            const css = panel.webview.asWebviewUri(vscode.Uri.joinPath(dist, 'webview.css')); const script = panel.webview.asWebviewUri(vscode.Uri.joinPath(dist, 'history-view.js')); const workerUrl = panel.webview.asWebviewUri(vscode.Uri.joinPath(dist, 'history-diff-worker.js')).toString();
            panel.webview.html = `<!doctype html><html lang="${getLocale()}"><head><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src ${panel.webview.cspSource}; worker-src blob:; connect-src ${panel.webview.cspSource}; style-src ${panel.webview.cspSource} 'unsafe-inline';"><link rel="stylesheet" href="${css}"></head><body style="padding:0;height:100vh;overflow:hidden"><main id="history-root"></main><script type="module" src="${script}"></script></body></html>`;
            const listener = panel.webview.onDidReceiveMessage(message => { if (message.type === 'history.ready') void panel.webview.postMessage({ type: 'history.init', comparison, workerUrl }); }); panel.onDidDispose(() => { listener.dispose(); panels.delete(panel); }); value = true;
          } else if (request?.method === 'copyText') {
            await vscode.env.clipboard.writeText(String(request.text ?? '')); value = true;
          } else if (request?.method === 'copyPath' || request?.method === 'copyRelativePath') {
            const files = await service.absolutePaths(request);
            await vscode.env.clipboard.writeText(files.map(file => request.method === 'copyRelativePath' ? vscode.workspace.asRelativePath(vscode.Uri.file(file), false) : file).join('\n')); value = true;
          } else if (request?.method === 'revealInIndexArea') {
            const [file] = await service.absolutePaths(request);
            await vscode.commands.executeCommand('easyviewMd.workspace.revealInIndexArea', vscode.Uri.file(file)); value = true;
          } else value = await service.handle(request);
          post({ type: 'guard.result', id: message.id, value });
        } catch (error) { post({ type: 'guard.result', id: message.id, error: error instanceof Error ? error.message : String(error) }); }
      });
      const visibility = view.onDidChangeVisibility(() => { active(); post({ type: 'guard.visible', visible: view?.visible }); });
      view.onDidDispose(() => { messages.dispose(); visibility.dispose(); view = undefined; active(); });
    },
  }, { webviewOptions: { retainContextWhenHidden: true } });
  const refresh = vscode.commands.registerCommand('easyviewMd.versionGuard.refresh', () => post({ type: 'guard.refresh' }));
  const expandAll = vscode.commands.registerCommand('easyviewMd.versionGuard.expandAll', () => post({ type: 'guard.expandAll' }));
  const collapseAll = vscode.commands.registerCommand('easyviewMd.versionGuard.collapseAll', () => post({ type: 'guard.collapseAll' }));
  const focus = vscode.window.onDidChangeWindowState(active);
  const roots = vscode.workspace.onDidChangeWorkspaceFolders(() => { post({ type: 'guard.reset' }); active(); });
  return vscode.Disposable.from(provider, refresh, expandAll, collapseAll, focus, roots, { dispose: () => { watcher?.dispose(); service.dispose(); for (const panel of panels) panel.dispose(); } });
}
