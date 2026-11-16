import { releaseHistoryComparison, clearHistoryComparisons } from '../timeline/desktopTimeline';
import { captureDesktopHistory, desktopHistory } from './desktopHistory';
import { app, dialog } from 'electron';
import { promises as fs, watch } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { isLocalHtmlPath } from '../browser/browserPolicy';
import { disposeBrowserViews, openBrowserTab, releaseBrowserTabs } from '../browser/browserWorkflow';
import { hashContent, minimalTextPatch } from '@easyview/editor-sync';
import { MARKDOWN_FILE_EXTENSIONS, type OperationResult } from '@easyview/contracts';
import type { DesktopTabSnapshot, DocumentOpenResult, SaveDocumentResult } from '../../../contracts';
import { PreviewSessionError } from '../preview/PreviewSession';
import {
  activateEditorSession,
  activeSession,
  allOpenTabs,
  documentResult,
  documentSessions,
  failure,
  fileNameWithoutExtension,
  getAppStateStore,
  isMarkdownPath,
  getMainWindow,
  getWindowContext,
  markdownFileName,
  notifyActiveDocument,
  notifyActiveGitChanges,
  persistTabs,
  previewFailure,
  previewSessions,
  requireActiveSession,
  sameFile,
  sendEditorMessage,
  sendToWindow,
  sessionIsActive,
  setWorkspaceState,
  shell,
  success,
  syncTabState,
  tabRegistry,
  tabSnapshot,
  workspaceCore,
  workspaceRoot,
  runInWindowContext,
} from '../host/desktopRuntime';
import { DesktopDocumentAdapter } from './desktopDocumentAdapter';
import { flushDesktopEditors } from './flushDesktopEditors';
import { recentFolderStore } from '../workspace/recentFolders';
import type { DocumentSession } from './DocumentSessionService';
import { toOperationResult } from './DocumentSessionService';
import { tDocument } from './document.i18n';

export async function stopWatcher(session: DocumentSession): Promise<void> {
  session.watcher?.close();
  session.watcher = undefined;
}

export async function watchDocumentSession(session: DocumentSession): Promise<boolean> {
  await stopWatcher(session);
  if (!session.filePath) return true;
  const context = getWindowContext();
  try {
    session.watcher = watch(session.filePath, { persistent: false }, () => {
      runInWindowContext(context, () => {
        void reloadIfChanged(session).catch((error) => {
          console.warn('[EasyView_Md] File change check failed:', error);
        });
      });
    });
    return true;
  } catch (error) {
    session.watcher = undefined;
    console.warn('[EasyView_Md] File watcher unavailable:', error);
    return false;
  }
}

const reloadTimers = new Map<string, NodeJS.Timeout>();
const MARKDOWN_DIALOG_EXTENSIONS = MARKDOWN_FILE_EXTENSIONS.map((extension) => extension.slice(1));
export async function reloadIfChanged(session: DocumentSession): Promise<void> {
  if (!session.filePath) return;
  const previous = reloadTimers.get(session.tabId);
  if (previous) clearTimeout(previous);
  const timer = setTimeout(async () => {
    reloadTimers.delete(session.tabId);
    if (!session.filePath || !documentSessions.has(session.tabId)) return;
    try {
      const stats = await fs.stat(session.filePath);
      const raw = await fs.readFile(session.filePath, 'utf8');
      const rawHash = hashContent(raw);
      if (rawHash !== session.diskContentHash) void captureDesktopHistory(session.filePath, raw, tDocument('history.externalChange')).catch((error) => console.warn('[Timeline]', error));
      // mtime is only a cheap watcher hint. Content hash is the source of
      // truth because sync folders and coarse filesystems can preserve mtime.
      if (rawHash === session.diskContentHash) {
        session.diskMtimeMs = stats.mtimeMs;
        return;
      }
      if (session.dirty && session.externalConflict?.contentHash) {
        const alreadySeen = rawHash === session.externalConflict.contentHash;
        if (alreadySeen) return;
      }
      const externalAdapter = new DesktopDocumentAdapter(raw);
      if (!session.dirty) {
        const previousContent = session.content;
        const externalPatch = minimalTextPatch(previousContent, externalAdapter.content);
        session.documentAdapter.replaceRaw(raw);
        session.rawContent = raw;
        session.content = externalAdapter.content;
        session.diskContent = externalAdapter.content;
        session.lineEnding = externalAdapter.lineEnding;
        session.diskMtimeMs = stats.mtimeMs;
        session.diskContentHash = rawHash;
        session.externalConflict = null;
        const nextRevision = session.sync.snapshot.revision + 1;
        session.sync.applySnapshot(session.content, nextRevision);
        if (sessionIsActive(session)) {
          sendToWindow('document.changed', documentResult(session));
          sendEditorMessage({
            type: 'documentPatched', documentId: session.documentId,
            baseRevision: nextRevision - 1, revision: nextRevision,
            edits: externalPatch, resultHash: hashContent(session.content), source: 'external',
            skipAutoScroll: true,
          });
          void notifyActiveGitChanges(session);
        }
      } else {
        documentSessions.markExternalConflict(session, raw, rawHash);
        sendToWindow('document.externalChange', { filePath: session.filePath });
        if (sessionIsActive(session)) {
          sendEditorMessage({
            type: 'resyncRequired', documentId: session.documentId,
            revision: session.sync.snapshot.revision,
            reason: 'External modification conflicts with unsaved local edits',
          });
          await resolveExternalConflict(session, raw, stats.mtimeMs);
        }
      }
    } catch {
      if (session.dirty) session.externalConflict ??= { contentHash: null, content: '' };
      sendToWindow('document.externalChange', { filePath: session.filePath });
    }
  }, 350);
  reloadTimers.set(session.tabId, timer);
}

export async function resolveExternalConflict(
  session: DocumentSession,
  diskContent = session.externalConflict?.content ?? '',
  diskMtimeMs: number | null = session.diskMtimeMs,
): Promise<void> {
  if (!session.externalConflict || !sessionIsActive(session)) return;
  const decision = await dialog.showMessageBox(getMainWindow()!, {
    type: 'warning',
    buttons: [tDocument('conflict.cancel'), tDocument('conflict.reload'), tDocument('conflict.overwrite')],
    defaultId: 0,
    cancelId: 0,
    message: tDocument('conflict.message', { fileName: session.fileName }),
    detail: tDocument('conflict.detail'),
  });
  if (decision.response === 1) {
    documentSessions.applyDiskReload(session, diskContent, diskMtimeMs);
    tabRegistry.setEditorDirty(session.tabId, false);
    syncTabState();
    notifyActiveDocument('reload');
  } else if (decision.response === 2) {
    session.externalConflict = null;
    session.diskMtimeMs = diskMtimeMs;
    const result = await saveSession(session.tabId, session.content, { overwrite: true });
    if (!result.ok) {
      documentSessions.markExternalConflict(session, diskContent, hashContent(diskContent));
      await showOperationError(result);
    }
  }
}

export async function loadEditorTab(
  filePath: string,
  requestedId?: string,
  notify = true,
  groupId?: string,
): Promise<OperationResult<DocumentOpenResult>> {
  if (!isMarkdownPath(filePath)) return failure('INVALID_ARGUMENT', tDocument('open.markdownOnly'));
  let resolvedPath: string;
  try {
    resolvedPath = await fs.realpath(filePath);
  } catch (error) {
    return failure('UNKNOWN', error instanceof Error ? error.message : tDocument('open.readFailed'));
  }
  const targetGroupId = groupId ?? tabSnapshot().activeGroupId;
  const targetGroup = tabSnapshot().groups.find((group) => group.id === targetGroupId);
  const existingInGroup = targetGroup?.tabs.find((tab) => (
    tab.kind === 'editor' && sameFile(tab.filePath, resolvedPath)
  ));
  if (existingInGroup?.kind === 'editor') {
    tabRegistry.activate(existingInGroup.id);
    activateEditorSession(existingInGroup.id);
    if (notify) {
      syncTabState();
      notifyActiveDocument('initial');
    }
    const existingSession = documentSessions.get(existingInGroup.id);
    if (!existingSession) return failure('NOT_FOUND', tDocument('session.markdownNotFound'));
    return success(documentResult(existingSession));
  }
  const shared = documentSessions.findByFilePath(resolvedPath)[0];
  if (shared) {
    const tab = tabRegistry.openEditor(resolvedPath, path.basename(resolvedPath), requestedId, targetGroupId, shared.documentId);
    documentSessions.alias(tab.id, shared.tabId);
    if (notify) {
      syncTabState();
      notifyActiveDocument('initial');
    }
    return success(documentResult(shared));
  }
  try {
    const [raw, stats] = await Promise.all([fs.readFile(resolvedPath, 'utf8'), fs.stat(resolvedPath)]);
    if (!stats.isFile()) return failure('INVALID_ARGUMENT', tDocument('open.regularMarkdownOnly'));
    const tab = tabRegistry.openEditor(resolvedPath, path.basename(resolvedPath), requestedId, targetGroupId);
    const session = documentSessions.open({
      tabId: tab.id,
      filePath: resolvedPath,
      fileName: path.basename(resolvedPath),
      raw,
      mtimeMs: stats.mtimeMs,
    });
    tabRegistry.setEditorDocumentId(tab.id, session.documentId);
    await watchDocumentSession(session);
    getAppStateStore().rememberRecentFile(resolvedPath);
    if (notify) {
      syncTabState();
      notifyActiveDocument('initial');
    }
    return success(documentResult(session));
  } catch (error) {
    return failure('UNKNOWN', error instanceof Error ? error.message : tDocument('open.readFailed'));
  }
}

export async function resolveWorkspaceFilePath(relativePath: string): Promise<string> {
  const rootPath = workspaceRoot();
  if (!rootPath) throw new PreviewSessionError('invalid', tDocument('workspace.openFirst'));
  const root = await fs.realpath(rootPath);
  const targetPath = workspaceCore.resolveAbsolutePath(relativePath);
  const entry = await fs.lstat(targetPath);
  if (!entry.isFile() || entry.isSymbolicLink()) throw new PreviewSessionError('permission', tDocument('workspace.regularFilesOnly'));
  const realPath = await fs.realpath(targetPath);
  const relative = path.relative(root, realPath);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new PreviewSessionError('permission', tDocument('workspace.outsideRoot'));
  }
  return realPath;
}

export async function registerPreviewTab(
  relativePath: string,
  requestedId?: string,
  notify = true,
  groupId?: string,
): Promise<DesktopTabSnapshot> {
  const rootPath = workspaceRoot();
  if (!rootPath) throw new PreviewSessionError('invalid', tDocument('workspace.openFirst'));
  const descriptor = await previewSessions.open(rootPath, relativePath);
  previewSessions.close(descriptor.sessionId);
  tabRegistry.openPreview(relativePath, descriptor.fileName, descriptor.route, requestedId, groupId);
  return notify ? syncTabState() : tabSnapshot();
}

export async function openWorkspaceEntryTab(relativePath: string): Promise<OperationResult<DesktopTabSnapshot>> {
  const rootPath = workspaceRoot();
  if (!rootPath) return failure('INVALID_ARGUMENT', tDocument('workspace.openFirst'));
  try {
    const targetPath = await resolveWorkspaceFilePath(relativePath);
    if (isMarkdownPath(targetPath)) {
      const result = await loadEditorTab(targetPath);
      return result.ok ? success(tabSnapshot()) : result;
    }
    if (isLocalHtmlPath(targetPath)) {
      return openBrowserTab({ url: pathToFileURL(targetPath).href, relativePath });
    }
    return success(await registerPreviewTab(relativePath));
  } catch (error) {
    return previewFailure(error);
  }
}

export async function activateTab(tabId: string): Promise<OperationResult<DesktopTabSnapshot>> {
  const tab = tabRegistry.activate(tabId);
  if (!tab) return failure('NOT_FOUND', tDocument('tabs.notFound'));
  if (tab.kind === 'editor') {
    const session = activateEditorSession(tab.id);
    if (!session) return failure('NOT_FOUND', tDocument('session.markdownNotFound'));
  }
  syncTabState();
  if (tab.kind === 'editor') {
    notifyActiveDocument('visible');
    const session = documentSessions.get(tab.id);
    if (session?.externalConflict) void resolveExternalConflict(session);
  }
  return success(tabSnapshot());
}

export async function readDocument(filePath: string): Promise<OperationResult<DocumentOpenResult>> {
  return loadEditorTab(filePath);
}

export async function chooseAndReadDocument(): Promise<OperationResult<DocumentOpenResult | null>> {
  const chosen = await dialog.showOpenDialog(getMainWindow()!, {
    properties: ['openFile'],
    filters: [{ name: 'Markdown', extensions: MARKDOWN_DIALOG_EXTENSIONS }],
  });
  if (chosen.canceled || !chosen.filePaths[0]) return success(null);
  return readDocument(chosen.filePaths[0]);
}

export async function publishSaveOutcome(
  sessionId: string,
  outcome: Awaited<ReturnType<DocumentSessionService['save']>>,
): Promise<OperationResult<SaveDocumentResult | null>> {
  if (outcome.kind === 'error') return outcome.error;
  const session = documentSessions.get(sessionId);
  if (outcome.kind === 'saved' && session) {
    tabRegistry.renameEditor(session.tabId, session.filePath!, session.fileName);
    tabRegistry.setEditorDirty(session.tabId, session.dirty);
    await watchDocumentSession(session);
    syncTabState();
    if (sessionIsActive(session)) sendToWindow('document.changed', documentResult(session));
  }
  return toOperationResult(outcome);
}

export async function saveAsSession(
  sessionId: string,
  content: string,
  suggestedFileName: string,
  lineEnding: '\n' | '\r\n',
): Promise<OperationResult<SaveDocumentResult | null>> {
  const required = documentSessions.require(sessionId);
  if (!required.ok) return required;
  const session = required.value;
  const chosen = await dialog.showSaveDialog(getMainWindow()!, {
    defaultPath: markdownFileName(suggestedFileName, session) ?? 'Untitled.md',
    filters: [{ name: 'Markdown', extensions: MARKDOWN_DIALOG_EXTENSIONS }],
  });
  if (chosen.canceled || !chosen.filePath) return success(null);
  if (!isMarkdownPath(chosen.filePath)) {
    return failure('INVALID_ARGUMENT', tDocument('save.targetMustBeMarkdown'));
  }
  let targetPath: string;
  try {
    targetPath = path.join(await fs.realpath(path.dirname(chosen.filePath)), path.basename(chosen.filePath));
  } catch (error) {
    return failure('UNKNOWN', error instanceof Error ? error.message : tDocument('save.directoryUnavailable'));
  }
  await stopWatcher(session);
  const outcome = await documentSessions.writeToPath(sessionId, targetPath, content, lineEnding);
  if (outcome.kind !== 'saved') await watchDocumentSession(session);
  return publishSaveOutcome(sessionId, outcome);
}

export async function saveSession(
  sessionId: string,
  content: string,
  options: { overwrite?: boolean } = {},
): Promise<OperationResult<SaveDocumentResult | null>> {
  const required = documentSessions.require(sessionId);
  if (!required.ok) return required;
  const session = required.value;
  await stopWatcher(session);
  const outcome = await documentSessions.save(sessionId, content, options);
  if (outcome.kind === 'needs-save-as') {
    return saveAsSession(sessionId, content, session.fileName, session.lineEnding);
  }
  if (outcome.kind !== 'saved') await watchDocumentSession(session);
  return publishSaveOutcome(sessionId, outcome);
}

export async function renameSession(sessionId: string, value: unknown): Promise<OperationResult<SaveDocumentResult>> {
  const required = documentSessions.require(sessionId);
  if (!required.ok) return required;
  const session = required.value;
  const fileName = markdownFileName(value, session);
  if (!fileName) return failure('INVALID_ARGUMENT', tDocument('rename.invalidFileName'));
  await stopWatcher(session);
  const oldPath = documentSessions.get(sessionId)?.filePath;
  const outcome = await documentSessions.rename(sessionId, fileName);
  if (outcome.kind !== 'saved') await watchDocumentSession(session);
  const published = await publishSaveOutcome(sessionId, outcome);
  if (!published.ok) return published;
  if (!published.value) return failure('NOT_FOUND', tDocument('rename.noOpenFile'));
  if (oldPath && oldPath !== published.value.filePath) await (await desktopHistory()).local.migrate(oldPath, published.value.filePath);
  return success(published.value);
}

export async function renameCurrent(value: unknown): Promise<OperationResult<SaveDocumentResult>> {
  const required = requireActiveSession();
  if (!required.ok) return required;
  return renameSession(required.value.tabId, value);
}

export async function confirmCloseSession(session: DocumentSession): Promise<boolean> {
  if (!session.dirty) return true;
  const response = await dialog.showMessageBox(getMainWindow()!, {
    type: 'warning',
    buttons: [tDocument('close.save'), tDocument('close.dontSave'), tDocument('close.cancel')],
    defaultId: 0,
    cancelId: 2,
    message: tDocument('close.unsavedMessage', { fileName: session.fileName }),
    detail: tDocument('close.unsavedDetail'),
  });
  if (response.response === 2) return false;
  if (response.response === 1) {
    await documentSessions.revertToDisk(session);
    tabRegistry.setEditorDirty(session.tabId, false);
    syncTabState();
    if (sessionIsActive(session)) notifyActiveDocument('initial');
    return true;
  }
  const result = await saveSession(session.tabId, session.content);
  if (!result.ok) {
    await dialog.showMessageBox(getMainWindow()!, { type: 'error', message: result.message });
    return false;
  }
  return result.value !== null && !session.dirty;
}

/** Ask Save / Don't Save / Cancel for one preview file (used when switching away). */
export async function confirmUnsavedPreview(fileName: string): Promise<'save' | 'discard' | 'cancel'> {
  const response = await dialog.showMessageBox(getMainWindow()!, {
    type: 'warning',
    buttons: [tDocument('close.save'), tDocument('close.dontSave'), tDocument('close.cancel')],
    defaultId: 0,
    cancelId: 2,
    message: tDocument('close.unsavedMessage', { fileName }),
    detail: tDocument('close.unsavedDetail'),
  });
  if (response.response === 2) return 'cancel';
  if (response.response === 1) return 'discard';
  return 'save';
}

const pendingPreviewSaves = new Map<string, { resolve: (ok: boolean) => void; timer: NodeJS.Timeout }>();

/** Ask the renderer to run the active preview viewer's save for this path. */
export function requestPreviewSave(relativePath: string): Promise<boolean> {
  const requestId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pendingPreviewSaves.delete(requestId);
      resolve(false);
    }, 60_000);
    pendingPreviewSaves.set(requestId, { resolve, timer });
    if (!sendToWindow('preview.saveRequest', { requestId, relativePath })) {
      clearTimeout(timer);
      pendingPreviewSaves.delete(requestId);
      resolve(false);
    }
  });
}

export function completePreviewSave(requestId: string, ok: boolean): void {
  const pending = pendingPreviewSaves.get(requestId);
  if (!pending) return;
  clearTimeout(pending.timer);
  pendingPreviewSaves.delete(requestId);
  pending.resolve(ok);
}

export async function confirmClosePreview(relativePath: string, fileName: string): Promise<boolean> {
  const action = await confirmUnsavedPreview(fileName);
  if (action === 'cancel') return false;
  if (action === 'discard') {
    sendToWindow('preview.clearDirty', relativePath);
    tabRegistry.setPreviewDirty(relativePath, false);
    syncTabState();
    return true;
  }
  const saved = await requestPreviewSave(relativePath);
  if (!saved) {
    await dialog.showMessageBox(getMainWindow()!, {
      type: 'error',
      message: tDocument('save.failed'),
    });
    return false;
  }
  tabRegistry.setPreviewDirty(relativePath, false);
  syncTabState();
  return true;
}

export async function confirmCloseAll(): Promise<boolean> {
  const dirtySessions = documentSessions.dirtySessions();
  const dirtyPreviews = tabRegistry.dirtyPreviewTabs();
  const count = dirtySessions.length + dirtyPreviews.length;
  if (count === 0) return true;
  const response = await dialog.showMessageBox(getMainWindow()!, {
    type: 'warning',
    buttons: [tDocument('closeAll.saveAll'), tDocument('closeAll.discardAll'), tDocument('close.cancel')],
    defaultId: 0,
    cancelId: 2,
    message: tDocument('closeAll.message', { count }),
    detail: tDocument('closeAll.detail'),
  });
  if (response.response === 2) return false;
  if (response.response === 1) {
    for (const session of dirtySessions) {
      await documentSessions.revertToDisk(session);
      tabRegistry.setEditorDirty(session.tabId, false);
    }
    for (const preview of dirtyPreviews) {
      sendToWindow('preview.clearDirty', preview.relativePath);
      tabRegistry.setPreviewDirty(preview.relativePath, false);
    }
    syncTabState();
    return true;
  }
  const originalActiveId = tabSnapshot().activeTabId;
  for (const session of dirtySessions) {
    const result = await saveSession(session.tabId, session.content);
    if (!result.ok || !result.value) {
      syncTabState();
      notifyActiveDocument('visible');
      await showOperationError(result.ok ? failure('CANCELLED', tDocument('save.cancelled')) : result);
      return false;
    }
  }
  for (const preview of dirtyPreviews) {
    if (!(await requestPreviewSave(preview.relativePath))) {
      await dialog.showMessageBox(getMainWindow()!, {
        type: 'error',
        message: tDocument('save.failed'),
      });
      return false;
    }
    tabRegistry.setPreviewDirty(preview.relativePath, false);
  }
  if (originalActiveId && tabRegistry.get(originalActiveId)) {
    tabRegistry.activate(originalActiveId);
  }
  syncTabState();
  return !documentSessions.hasDirty() && !tabRegistry.hasDirtyPreviews();
}

export async function releaseEditorTabs(tabIds: readonly string[]): Promise<boolean> {
  const closing = new Set(tabIds);
  const remaining = allOpenTabs().filter((tab) => !closing.has(tab.id));
  const seen = new Set<DocumentSession>();
  const dispose: DocumentSession[] = [];
  for (const tabId of tabIds) {
    const tab = tabRegistry.get(tabId);
    if (tab?.kind !== 'editor') continue;
    const session = documentSessions.get(tab.id);
    if (!session || seen.has(session)) continue;
    seen.add(session);
    const fileRemains = remaining.some((candidate) => (
      candidate.kind === 'editor' && sameFile(candidate.filePath, tab.filePath)
    ));
    if (fileRemains) continue;
    if (!(await confirmCloseSession(session))) return false;
    dispose.push(session);
  }
  for (const tabId of tabIds) documentSessions.delete(tabId);
  for (const session of dispose) {
    documentSessions.delete(session.tabId);
    await stopWatcher(session);
  }
  return true;
}

/** Prompt for dirty preview tabs that will disappear with this close. */
export async function releasePreviewTabs(tabIds: readonly string[]): Promise<boolean> {
  const closing = new Set(tabIds);
  const remaining = allOpenTabs().filter((tab) => !closing.has(tab.id));
  const seen = new Set<string>();
  for (const tabId of tabIds) {
    const tab = tabRegistry.get(tabId);
    if (tab?.kind !== 'preview' || !tab.dirty) continue;
    if (seen.has(tab.relativePath)) continue;
    seen.add(tab.relativePath);
    const fileRemains = remaining.some((candidate) => (
      candidate.kind === 'preview' && candidate.relativePath === tab.relativePath
    ));
    if (fileRemains) continue;
    if (!(await confirmClosePreview(tab.relativePath, tab.fileName))) return false;
  }
  return true;
}

export async function closeTab(tabId: string): Promise<OperationResult<DesktopTabSnapshot | null>> {
  const tab = tabRegistry.get(tabId);
  if (!tab) return failure('NOT_FOUND', tDocument('tabs.notFound'));
  if (!(await releaseEditorTabs([tabId]))) return success(null);
  if (!(await releasePreviewTabs([tabId]))) return success(null);
  releaseHistoryComparison(tabId);
  releaseBrowserTabs([tabId]);
  tabRegistry.close(tabId);
  const active = tabRegistry.active();
  syncTabState();
  if (active?.kind === 'editor') notifyActiveDocument('visible');
  return success(tabSnapshot());
}

export async function closeTabIds(tabIds: string[]): Promise<boolean> {
  if (!(await releaseEditorTabs(tabIds))) return false;
  if (!(await releasePreviewTabs(tabIds))) return false;
  releaseBrowserTabs(tabIds);
  for (const tabId of tabIds) { releaseHistoryComparison(tabId); tabRegistry.close(tabId); }
  const active = tabRegistry.active();
  syncTabState();
  if (active?.kind === 'editor') notifyActiveDocument('visible');
  return true;
}

export async function closeOtherTabs(tabId: string): Promise<OperationResult<DesktopTabSnapshot>> {
  const group = tabRegistry.groupForTab(tabId);
  if (!group) return failure('NOT_FOUND', tDocument('tabs.notFound'));
  const closing = group.tabs.filter((tab) => tab.id !== tabId && !tab.pinned).map((tab) => tab.id);
  if (!(await closeTabIds(closing))) return failure('CANCELLED', tDocument('tabs.closeOthersCancelled'));
  tabRegistry.activate(tabId);
  syncTabState();
  const active = tabRegistry.active();
  if (active?.kind === 'editor') notifyActiveDocument('visible');
  return success(tabSnapshot());
}

export async function closeGroupTabs(tabId: string): Promise<OperationResult<DesktopTabSnapshot>> {
  const group = tabRegistry.groupForTab(tabId);
  if (!group) return failure('NOT_FOUND', tDocument('tabs.notFound'));
  if (!(await closeTabIds(group.tabs.filter((tab) => !tab.pinned).map((tab) => tab.id)))) return failure('CANCELLED', tDocument('tabs.closeAllCancelled'));
  return success(tabSnapshot());
}

export async function closeAllTabResources(): Promise<void> {
  disposeBrowserViews();
  clearHistoryComparisons(tabRegistry.snapshot().groups.flatMap((group) => group.tabs.map((tab) => tab.id)));
  for (const session of documentSessions.values()) await stopWatcher(session);
  documentSessions.clear();
  tabRegistry.clear();
  previewSessions.closeAll();
}

export async function restoreWorkspace(): Promise<void> {
  const current = getAppStateStore().getWorkspace();
  let rootPath: string | null = null;
  if (current.rootPath) {
    try {
      rootPath = await workspaceCore.bindRoot(current.rootPath);
      const { startWorkspaceWatcher } = await import('../workspace/workspaceWorkflow');
      startWorkspaceWatcher(rootPath);
      if (!(await recentFolderStore().paths()).includes(rootPath)) await recentFolderStore().remember(rootPath);
    } catch {
      workspaceCore.clear();
      rootPath = null;
    }
  } else {
    workspaceCore.clear();
  }
  if (rootPath !== current.rootPath) setWorkspaceState({ rootPath });

  if (current.editorGroups && current.editorGroups.length > 0) {
    tabRegistry.restoreStructure(
      current.editorGroups.map((group) => ({ id: group.id })),
      current.editorGroupLayout ?? { kind: 'group', groupId: current.editorGroups[0].id },
      current.activeEditorGroupId ?? current.editorGroups[0].id,
    );
    for (const group of current.editorGroups) {
      for (const tab of group.openTabs) {
        if (tab.kind === 'editor') {
          await loadEditorTab(tab.filePath, tab.id, false, group.id);
        } else if (tab.kind === 'browser') {
          await restoreBrowserTab(tab, rootPath, group.id);
        } else if (rootPath) {
          try {
            await registerPreviewTab(tab.relativePath, tab.id, false, group.id);
          } catch {
            // Missing or unsupported restored preview tabs are intentionally skipped.
          }
        }
        if (tab.pinned) tabRegistry.setPinned(tab.id, true);
      }
    }
  } else {
    for (const tab of current.openTabs) {
      if (tab.kind === 'editor') {
        await loadEditorTab(tab.filePath, tab.id, false);
      } else if (tab.kind === 'browser') {
        await restoreBrowserTab(tab, rootPath);
      } else if (rootPath) {
        try {
          await registerPreviewTab(tab.relativePath, tab.id, false);
        } catch {
          // Missing or unsupported restored preview tabs are intentionally skipped.
        }
      }
      if (tab.pinned) tabRegistry.setPinned(tab.id, true);
    }
  }

  if (current.activeTabId && tabRegistry.get(current.activeTabId)) {
    tabRegistry.activate(current.activeTabId);
  }
  const active = tabRegistry.active();
  if (active?.kind === 'editor') activateEditorSession(active.id);
  persistTabs();
}

async function restoreBrowserTab(
  tab: { id: string; url: string; relativePath?: string },
  rootPath: string | null,
  groupId?: string,
): Promise<void> {
  try {
    let url = tab.url;
    if (tab.relativePath) {
      if (!rootPath) return;
      url = pathToFileURL(await resolveWorkspaceFilePath(tab.relativePath)).href;
    }
    await openBrowserTab({ id: tab.id, url, relativePath: tab.relativePath, groupId, notify: false });
  } catch {
    // A missing local page is skipped, same as a missing preview tab.
  }
}

export function documentDirectory(session = activeSession()): string {
  return session?.filePath
    ? path.dirname(session.filePath)
    : app.getPath('documents');
}

export function suggestedExportName(extension: string, session = activeSession()): string {
  return `${fileNameWithoutExtension(session?.fileName ?? 'Untitled')}.${extension}`;
}

export async function chooseExportPath(extension: string, label: string): Promise<string | null> {
  const chosen = await dialog.showSaveDialog(getMainWindow()!, {
    defaultPath: path.join(documentDirectory(), suggestedExportName(extension)),
    filters: [{ name: label, extensions: [extension] }],
  });
  return chosen.canceled || !chosen.filePath ? null : chosen.filePath;
}

export async function showExportCompleted(filePath: string): Promise<void> {
  const result = await dialog.showMessageBox(getMainWindow()!, {
    type: 'info',
    buttons: [tDocument('export.ok'), tDocument('export.showInFolder')],
    defaultId: 0,
    message: tDocument('export.completed', { fileName: path.basename(filePath) }),
  });
  if (result.response === 1) shell.showItemInFolder(filePath);
}

export function requireDocumentPath(): string | null {
  if (activeSession()?.filePath) return activeSession()!.filePath;
  void dialog.showMessageBox(getMainWindow()!, {
    type: 'info',
    message: tDocument('image.saveDocumentFirst'),
  });
  return null;
}

export async function showOperationError(result: OperationResult<unknown>): Promise<void> {
  if (result.ok) return;
  await dialog.showMessageBox(getMainWindow()!, {
    type: 'error',
    message: result.message,
  });
}

export async function requestOpenDocument(filePath?: string): Promise<void> {
  const result = filePath ? await readDocument(filePath) : await chooseAndReadDocument();
  if (result.ok && result.value) sendToWindow('app.revealDocument');
  await showOperationError(result);
}

export async function openFromMenu(): Promise<void> {
  await requestOpenDocument();
}

export async function saveFromMenu(saveAs: boolean): Promise<void> {
  const pending = activeSession();
  if (!pending) return;
  // The menu accelerator (Cmd/Ctrl+S) reaches main before the renderer's debounced edits do;
  // pull them in first, or the save writes the content from before the last keystrokes.
  await flushDesktopEditors(getWindowContext(), [pending]).catch(() => undefined);
  const session = activeSession();
  if (!session) return;
  const result = saveAs
    ? await saveAsSession(session.tabId, session.content, session.fileName, session.lineEnding)
    : await saveSession(session.tabId, session.content);
  await showOperationError(result);
  if (result.ok && result.value) {
    sendEditorMessage({
      type: 'fileRenamed',
      fileName: fileNameWithoutExtension(result.value.fileName),
    });
  }
}

export async function importDocument(extensions: string[], title: string): Promise<void> {
  const { convertDocumentToMarkdown, DocumentConversionError } = await import('@easyview/node-runtime');
  const selected = await dialog.showOpenDialog(getMainWindow()!, {
    properties: ['openFile'],
    title,
    filters: [{ name: title, extensions }],
  });
  const sourcePath = selected.filePaths[0];
  if (selected.canceled || !sourcePath) return;

  let converted;
  try {
    converted = await convertDocumentToMarkdown({ sourcePath, overwrite: false });
  } catch (error) {
    if (!(error instanceof DocumentConversionError) || error.code !== 'OUTPUT_EXISTS') {
      await dialog.showMessageBox(getMainWindow()!, {
        type: 'error',
        message: error instanceof Error ? error.message : tDocument('import.conversionFailed'),
      });
      return;
    }
    const confirmation = await dialog.showMessageBox(getMainWindow()!, {
      type: 'warning',
      buttons: [tDocument('import.replace'), tDocument('import.cancel')],
      defaultId: 0,
      cancelId: 1,
      message: tDocument('import.targetExists'),
      detail: tDocument('import.replaceDetail'),
    });
    if (confirmation.response !== 0) return;
    try {
      converted = await convertDocumentToMarkdown({ sourcePath, overwrite: true });
    } catch (retryError) {
      await dialog.showMessageBox(getMainWindow()!, {
        type: 'error',
        message: retryError instanceof Error ? retryError.message : tDocument('import.conversionFailed'),
      });
      return;
    }
  }

  const result = await readDocument(converted.outputPath);
  await showOperationError(result);
}

type DocumentSessionService = import('./DocumentSessionService').DocumentSessionService;
