import { flushDesktopEditors } from '../document/flushDesktopEditors';
import { clipboard, dialog, shell, type WebContents } from 'electron';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { VersionGuardService, guardDiagnostics } from '@easyview/node-runtime';
import { guardTimelineComparison, type GuardComparison, type GuardRequest } from '@easyview/contracts';
import { getWindowContext, windowSessions, workspaceRoot, runInWindowContext, sendEditorMessage, editorDocumentMessage, syncTabState } from '../host/desktopRuntime';
import { saveSession, openWorkspaceEntryTab, stopWatcher, watchDocumentSession, closeTab } from '../document/documentWorkflow';
import { openReadOnlyComparison } from '../timeline/desktopTimeline';
import { tGuardHost } from './guardHost.i18n';
const services = new Map<number, VersionGuardService>();
const listFiles = (files: string[]): string => [...files.slice(0, 10), ...(files.length > 10 ? [`… +${files.length - 10}`] : [])].join('\n');
async function flushFiles(files: string[]): Promise<void> {
  for (const window of windowSessions.values()) await flushDesktopEditors(window.context, files.flatMap(file => window.context.documentSessions.findByFilePath(file)));
}
export async function handleVersionGuard(sender: WebContents, request: GuardRequest): Promise<unknown> {
  let service = services.get(sender.id);
  const context = getWindowContext();
  const matching = (files: string[]) => windowSessions.values().flatMap(window => files.flatMap(file => window.context.documentSessions.findByFilePath(file).map(session => ({ context: window.context, session }))));
  if (!service) {
    service = new VersionGuardService({
      discovered: (repositories, warnings) => { if (!sender.isDestroyed()) sender.send('versionGuard.discovery', repositories, warnings); },
      roots: () => { const root = context.workspaceCore.getRootPath(); return root ? [root] : []; },
      beforeStage: async files => {
        await flushFiles(files);
        const entries = matching(files);
        for (const file of files) if (new Set(entries.filter(entry => entry.session.filePath === file && entry.session.dirty).map(entry => entry.session.content)).size > 1) throw new Error(tGuardHost('inconsistent'));
        for (const entry of entries) if (entry.session.dirty) {
          const outcome = await runInWindowContext(entry.context, () => saveSession(entry.session.tabId, entry.session.content));
          if (!outcome.ok) throw new Error(outcome.message);
        }
      },
      discard: async (files, action) => {
        await flushFiles(files);
        const entries = matching(files); const baselines = entries.map(entry => entry.session.content);
        const response = await dialog.showMessageBox(context.window!, { type: 'warning', buttons: [tGuardHost('cancel'), tGuardHost('discard')], defaultId: 0, cancelId: 0, message: tGuardHost('confirm'), detail: listFiles(files) });
        if (response.response !== 1) return false;
        const owners = [...new Set(entries.map(entry => entry.context))];
        const lock = (index: number): Promise<void> => index === owners.length ? perform() : owners[index].documentSessions.mutateGitFiles(files, () => lock(index + 1));
        const perform = async () => {
          if (entries.some((entry, i) => entry.session.content !== baselines[i])) throw new Error(tGuardHost('changed'));
          await Promise.all(entries.map(entry => stopWatcher(entry.session)));
          try {
            await action();
            for (const entry of entries) {
              const raw = await fs.readFile(entry.session.filePath!, 'utf8').catch(error => { if (error.code === 'ENOENT') return null; throw error; });
              await runInWindowContext(entry.context, async () => {
                if (raw === null) { await entry.context.documentSessions.revertToDisk(entry.session); await closeTab(entry.session.tabId); }
                else { entry.context.documentSessions.applyDiskReload(entry.session, raw, (await fs.stat(entry.session.filePath!)).mtimeMs); sendEditorMessage(editorDocumentMessage(entry.session, 'reload')); syncTabState(); }
              });
            }
          } finally { await Promise.all(entries.filter(entry => entry.context.documentSessions.has(entry.session.tabId)).map(entry => runInWindowContext(entry.context, () => watchDocumentSession(entry.session)))); }
        };
        await lock(0); return true;
      },
      trash: file => shell.trashItem(file),
    });
    services.set(sender.id, service); sender.once('destroyed', () => { service?.dispose(); services.delete(sender.id); });
  }
  if (request?.method === 'confirm') {
    const choices = (request.choices ?? []).map(String);
    const { response } = await dialog.showMessageBox(context.window!, { type: 'question', buttons: [...choices, tGuardHost('cancel')], defaultId: 0, cancelId: choices.length, message: String(request.message ?? ''), detail: request.detail });
    return response < choices.length ? response : -1;
  }
  if (request?.method === 'active') { service.setActive(request.active === true, paths => { if (!sender.isDestroyed()) sender.send('versionGuard.changed', paths); }); return true; }
  if (request?.method === 'openDiff') {
    const comparison = await service.handle({ ...request, method: 'comparison' }) as GuardComparison;
    openReadOnlyComparison(guardTimelineComparison(comparison)); return true;
  }
  if (request?.method === 'openFile') {
    const repository = await service.repository(request.repository); const [relative] = await service.files(repository, request.paths);
    const result = await openWorkspaceEntryTab(path.relative(workspaceRoot()!, path.join(repository.rootPath, relative)));
    if (!result.ok) throw new Error(result.message); return true;
  }
  if (request?.method === 'copyText') {
    clipboard.writeText(String(request.text ?? '')); return true;
  }
  if (request?.method === 'copyPath' || request?.method === 'copyRelativePath') {
    const files = await service.absolutePaths(request); const root = workspaceRoot();
    clipboard.writeText(files.map(file => request.method === 'copyRelativePath' && root ? path.relative(root, file) : file).join('\n')); return true;
  }
  if (request?.method === 'revealInIndexArea') {
    const [file] = await service.absolutePaths(request); const root = workspaceRoot();
    if (root) sender.send('workspace.revealInIndexArea', path.relative(root, file).split(path.sep).join('/')); return true;
  }
  return service.handle(request);
}
export { guardDiagnostics };
