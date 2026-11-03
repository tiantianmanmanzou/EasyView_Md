import { acceptDesktopEditorFlush } from '../../application/document/flushDesktopEditors';
import { handleVersionGuard } from '../../application/version-guard/desktopVersionGuard';
import { handleDesktopTimeline, getHistoryComparison, desktopTimelineDiagnostics } from '../../application/timeline/desktopTimeline';
import { getHistorySettings, setHistorySettings } from '../../application/document/desktopHistory';
import type { TimelineRequestMessage } from '@easyview/contracts';
import { clipboard, dialog, ipcMain, Menu, nativeTheme, shell, systemPreferences } from 'electron';
import path from 'node:path';
import { isEditorToHostMessage } from '@easyview/contracts';
import { DESKTOP_ACCENTS, DESKTOP_APPEARANCE_MODES, normalizeDesktopPanelLayout } from '../../../contracts';
import type {
  DesktopAccent,
  DesktopAppearanceMode,
  DesktopTabContextCommand,
  HttpPreviewRequest,
  WorkspaceCreateRequest,
  WorkspaceDeleteRequest,
  WorkspaceEntry,
  WorkspaceMoveRequest,
  WorkspaceImportExternalRequest,
  WorkspacePasteRequest,
  WorkspaceRenameRequest,
  WorkspaceReorderRequest,
  WorkspaceTreeSortMode,
} from '../../../contracts';
import { requestHttpPreview } from '../../application/preview/HttpPreviewService';
import {
  activateTab,
  chooseAndReadDocument,
  closeGroupTabs,
  closeOtherTabs,
  closeTab,
  confirmCloseAll,
  openWorkspaceEntryTab,
  renameSession,
  resolveWorkspaceFilePath,
  saveAsSession,
  saveSession,
  showOperationError,
} from '../../application/document/documentWorkflow';
import { handleEditorMessage } from '../../application/editor/editorMessageHandler';
import { createMenu, createNewWindow } from '../../application/window/windowService';
import {
  activeEditorTab,
  archivePreviewService,
  assertTrustedRenderer,
  failure,
  getWorkspaceState,
  isAllowedExternalUrl,
  isRecord,
  javaDecompileService,
  getMainWindow,
  getWindowContextForSender,
  previewFailure,
  previewSessions,
  sendToWindow,
  setDesktopMenuState,
  setWorkspaceState,
  success,
  tabRegistry,
  tabSnapshot,
  trustedRenderer,
  workspaceCore,
  workspaceRoot,
  runInWindowContext,
} from '../../application/host/desktopRuntime';
import { desktopWorkspaceErrorMessage } from '../../application/workspace/DesktopWorkspaceCore';
import {
  copyWorkspaceEntryToClipboard,
  deleteWorkspaceEntry,
  importExternalWorkspaceEntries,
  executeTabContextCommand,
  openWorkspaceFolder,
  openWorkspacePreview,
  pasteWorkspaceClipboard,
  renameWorkspaceEntry,
  showTabContextMenu,
  showWorkspaceContextMenu,
  showNewFileTypeMenu,
} from '../../application/workspace/workspaceWorkflow';
import { rendererWindow } from '../../application/host/desktopRuntime';
import { recentFolderStore } from '../../application/workspace/recentFolders';
import { explorerExpansionStore } from '../../application/workspace/explorerExpansion';
import { tRuntime } from '../../application/host/desktopRuntime.i18n';
import { tIpc } from './desktopIpc.i18n';

function registerHandle<TArgs extends unknown[], TResult>(
  channel: string,
  handler: (event: Electron.IpcMainInvokeEvent, ...args: TArgs) => TResult | Promise<TResult>,
): void {
  ipcMain.handle(channel, (event, ...args) => {
    const context = getWindowContextForSender(event.sender);
    if (!context) return failure('UNKNOWN', tRuntime('request.untrustedWindow'));
    return runInWindowContext(context, () => handler(event, ...(args as TArgs)));
  });
}

function registerEvent<TArgs extends unknown[]>(
  channel: string,
  handler: (event: Electron.IpcMainEvent, ...args: TArgs) => void,
): void {
  ipcMain.on(channel, (event, ...args) => {
    const context = getWindowContextForSender(event.sender);
    if (!context) return;
    runInWindowContext(context, () => handler(event, ...(args as TArgs)));
  });
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

const CSS_COLOR = /^(#[0-9a-f]{3,8}|rgba?\(\s*\d{1,3}(\s*,\s*\d{1,3}){2}(\s*,\s*(0|1|0?\.\d+))?\s*\))$/i;

function isCssColor(value: unknown): value is string {
  return typeof value === 'string' && CSS_COLOR.test(value);
}

function decodePreviewBytes(bytes: unknown, encoding: unknown): Buffer | null {
  if (encoding === 'base64' && typeof bytes === 'string' && bytes.length > 0) {
    try {
      return Buffer.from(bytes, 'base64');
    } catch {
      return null;
    }
  }
  if (bytes instanceof Uint8Array) return Buffer.from(bytes);
  if (ArrayBuffer.isView(bytes)) {
    return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }
  if (Array.isArray(bytes) && bytes.every((item) => typeof item === 'number')) {
    return Buffer.from(bytes);
  }
  return null;
}

export function registerDesktopIpc(): void {
  registerHandle('versionGuard.request', async (event, request: import('@easyview/contracts').GuardRequest) => {
    const denied = assertTrustedRenderer(event); if (denied) return denied;
    try { return success(await handleVersionGuard(event.sender, request)); }
    catch (error) { return failure('UNKNOWN', error instanceof Error ? error.message : String(error)); }
  });
  registerEvent('timeline.message', (event, message: TimelineRequestMessage) => {
    if (!trustedRenderer(event)) return;
    void handleDesktopTimeline(event.sender, message).catch((error) => { if (!event.sender.isDestroyed()) event.sender.send('timeline.message', { type: 'timeline.result', id: message && typeof message === 'object' && 'id' in message ? message.id : '', error: String(error) }); });
  });
  registerHandle('timeline.diagnostics', async (event) => { const denied = assertTrustedRenderer(event); if (denied) return denied; return success(await desktopTimelineDiagnostics(event.sender.id)); });
  registerHandle('timeline.comparison', (event, tabId: string) => {
    const denied = assertTrustedRenderer(event); if (denied) return denied;
    if (tabRegistry.get(tabId)?.kind !== 'history') return failure('NOT_FOUND', tIpc('timeline.historyTabNotFound'));
    const comparison = getHistoryComparison(tabId); return comparison ? success(comparison) : failure('NOT_FOUND', tIpc('timeline.comparisonNotFound'));
  });
  registerHandle('timeline.settings.get', async (event) => { const denied = assertTrustedRenderer(event); if (denied) return denied; return success(await getHistorySettings()); });
  registerHandle('timeline.settings.set', async (event, settings: unknown) => { const denied = assertTrustedRenderer(event); if (denied) return denied; await setHistorySettings(settings); return success(true); });

  registerHandle('document.open', async (event) => {
    const denied = assertTrustedRenderer(event);
    if (denied) return denied;
    return chooseAndReadDocument();
  });

  registerHandle('document.save', async (event, request: { sessionId?: unknown; content: unknown }) => {
    const denied = assertTrustedRenderer(event);
    if (denied) return denied;
    if (typeof request?.content !== 'string') return failure('INVALID_ARGUMENT', tIpc('document.contentNotString'));
    const sessionId = typeof request.sessionId === 'string' ? request.sessionId : activeEditorTab()?.id;
    if (!sessionId) return failure('NOT_FOUND', tIpc('document.sessionNotFound'));
    return saveSession(sessionId, request.content);
  });

  registerHandle('document.saveAs', async (event, request: { sessionId?: unknown; content: unknown; suggestedFileName: unknown; lineEnding: unknown }) => {
    const denied = assertTrustedRenderer(event);
    if (denied) return denied;
    if (typeof request?.content !== 'string' || typeof request.suggestedFileName !== 'string') {
      return failure('INVALID_ARGUMENT', tIpc('document.invalidSaveArguments'));
    }
    if (request.lineEnding !== '\n' && request.lineEnding !== '\r\n') {
      return failure('INVALID_ARGUMENT', tIpc('document.invalidLineEnding'));
    }
    const sessionId = typeof request.sessionId === 'string' ? request.sessionId : activeEditorTab()?.id;
    if (!sessionId) return failure('NOT_FOUND', tIpc('document.sessionNotFound'));
    return saveAsSession(sessionId, request.content, request.suggestedFileName, request.lineEnding);
  });

  registerHandle('document.rename', async (event, request: { sessionId?: unknown; fileName: unknown }) => {
    const denied = assertTrustedRenderer(event);
    if (denied) return denied;
    const sessionId = typeof request?.sessionId === 'string' ? request.sessionId : activeEditorTab()?.id;
    if (!sessionId) return failure('NOT_FOUND', tIpc('document.sessionNotFound'));
    return renameSession(sessionId, request?.fileName);
  });

  registerHandle('window.requestClose', async (event) => {
    const denied = assertTrustedRenderer(event);
    if (denied) return denied;
    return success(await confirmCloseAll());
  });

  registerHandle('window.setTitleBarOverlay', (event, color: unknown, symbolColor: unknown) => {
    const denied = assertTrustedRenderer(event);
    if (denied) return denied;
    if (!isCssColor(color) || !isCssColor(symbolColor)) return failure('INVALID_ARGUMENT', tIpc('window.invalidOverlayColor'));
    const owner = rendererWindow(event.sender);
    if (process.platform === 'darwin' || !owner || owner.isDestroyed()) return success(false);
    owner.setTitleBarOverlay({ color, symbolColor });
    return success(true);
  });

  registerHandle('window.titleBarDoubleClick', (event) => {
    const denied = assertTrustedRenderer(event);
    if (denied) return denied;
    const owner = rendererWindow(event.sender);
    if (process.platform !== 'darwin' || !owner || owner.isDestroyed() || owner.isFullScreen()) return success(false);
    const action = systemPreferences.getUserDefault('AppleActionOnDoubleClick', 'string');
    if (action === 'None') return success(false);
    if (action === 'Minimize') owner.minimize();
    else if (owner.isMaximized()) owner.unmaximize();
    else owner.maximize();
    return success(true);
  });

  registerHandle('window.popupAppMenu', (event, x: unknown, y: unknown) => {
    const denied = assertTrustedRenderer(event);
    if (denied) return denied;
    if (!Number.isFinite(x) || !Number.isFinite(y)) return failure('INVALID_ARGUMENT', tIpc('window.invalidMenuPosition'));
    const menu = Menu.getApplicationMenu();
    if (!menu) return success(false);
    menu.popup({ window: rendererWindow(event.sender) ?? undefined, x: Math.round(x as number), y: Math.round(y as number) });
    return success(true);
  });

  registerHandle('external.open', async (event, value: unknown) => {
    const denied = assertTrustedRenderer(event);
    if (denied) return denied;
    if (!isAllowedExternalUrl(value)) return failure('INVALID_ARGUMENT', tIpc('external.onlyHttp'));
    await shell.openExternal(value);
    return success(true);
  });

  registerHandle('clipboard.writeText', async (event, value: unknown) => {
    const denied = assertTrustedRenderer(event);
    if (denied) return denied;
    if (typeof value !== 'string') return failure('INVALID_ARGUMENT', tIpc('clipboard.invalidContent'));
    clipboard.writeText(value);
    return success(true);
  });

  registerHandle('app.getTheme', (event) => {
    const denied = assertTrustedRenderer(event);
    if (denied) return denied;
    return success(nativeTheme.shouldUseDarkColors ? 'dark' : 'light');
  });

  registerHandle('app.newWindow', async (event) => {
    const denied = assertTrustedRenderer(event);
    if (denied) return denied;
    await createNewWindow();
    return success(true);
  });

  registerHandle('tabs.getState', (event) => {
    const denied = assertTrustedRenderer(event);
    if (denied) return denied;
    return success(tabSnapshot());
  });

  registerHandle('tabs.openWorkspaceEntry', async (event, relativePath: unknown) => {
    const denied = assertTrustedRenderer(event);
    if (denied) return denied;
    if (typeof relativePath !== 'string') return failure('INVALID_ARGUMENT', tIpc('workspace.invalidPath'));
    return openWorkspaceEntryTab(relativePath);
  });

  registerHandle('tabs.activate', async (event, tabId: unknown) => {
    const denied = assertTrustedRenderer(event);
    if (denied) return denied;
    if (typeof tabId !== 'string') return failure('INVALID_ARGUMENT', tIpc('tabs.invalidId'));
    return activateTab(tabId);
  });

  registerHandle('tabs.close', async (event, tabId: unknown) => {
    const denied = assertTrustedRenderer(event);
    if (denied) return denied;
    if (typeof tabId !== 'string') return failure('INVALID_ARGUMENT', tIpc('tabs.invalidId'));
    return closeTab(tabId);
  });

  registerHandle('tabs.closeOthers', async (event, tabId: unknown) => {
    const denied = assertTrustedRenderer(event);
    if (denied) return denied;
    if (typeof tabId !== 'string') return failure('INVALID_ARGUMENT', tIpc('tabs.invalidId'));
    return closeOtherTabs(tabId);
  });

  registerHandle('tabs.closeAll', async (event, tabId: unknown) => {
    const denied = assertTrustedRenderer(event);
    if (denied) return denied;
    if (typeof tabId !== 'string') return failure('INVALID_ARGUMENT', tIpc('tabs.invalidId'));
    return closeGroupTabs(tabId);
  });

  registerHandle('tabs.openPreview', async (event, relativePath: unknown) => {
    const denied = assertTrustedRenderer(event);
    if (denied) return denied;
    if (typeof relativePath !== 'string') return failure('INVALID_ARGUMENT', tIpc('workspace.invalidPath'));
    return openWorkspacePreview(relativePath);
  });

  registerHandle('tabs.showContextMenu', (event, tabId: unknown) => {
    const denied = assertTrustedRenderer(event);
    if (denied) return denied;
    if (typeof tabId !== 'string' || !tabRegistry.get(tabId)) return failure('NOT_FOUND', tIpc('tabs.notFound'));
    showTabContextMenu(event.sender, tabId);
    return success(true);
  });

  registerHandle('tabs.executeContextCommand', async (event, request: unknown) => {
    const denied = assertTrustedRenderer(event);
    if (denied) return denied;
    if (!isRecord(request) || typeof request.tabId !== 'string' || typeof request.command !== 'string') {
      return failure('INVALID_ARGUMENT', tIpc('tabs.invalidContextCommand'));
    }
    return executeTabContextCommand(request.tabId, request.command as DesktopTabContextCommand);
  });

  registerHandle('preview.open', async (event, request: unknown) => {
    const denied = assertTrustedRenderer(event);
    if (denied) return denied;
    const rootPath = workspaceRoot();
    const relativePath = typeof request === 'string' ? request : isRecord(request) && typeof request.relativePath === 'string' ? request.relativePath : null;
    if (!rootPath || !relativePath) return failure('INVALID_ARGUMENT', tIpc('preview.invalidRequest'));
    try {
      return success(await previewSessions.open(rootPath, relativePath));
    } catch (error) {
      return previewFailure(error);
    }
  });

  registerHandle('preview.close', async (event, sessionId: unknown) => {
    const denied = assertTrustedRenderer(event);
    if (denied) return denied;
    if (typeof sessionId !== 'string') return failure('INVALID_ARGUMENT', tIpc('preview.invalidSessionId'));
    try {
      return success(previewSessions.close(sessionId));
    } catch (error) {
      return previewFailure(error);
    }
  });

  registerHandle('preview.readText', async (event, sessionId: unknown) => {
    const denied = assertTrustedRenderer(event);
    if (denied) return denied;
    if (typeof sessionId !== 'string') return failure('INVALID_ARGUMENT', tIpc('preview.invalidSessionId'));
    try {
      return success(await previewSessions.readText(sessionId));
    } catch (error) {
      return previewFailure(error);
    }
  });

  registerHandle('preview.writeBytes', async (event, request: unknown) => {
    const denied = assertTrustedRenderer(event);
    if (denied) return denied;
    if (!isRecord(request) || typeof request.sessionId !== 'string') return failure('INVALID_ARGUMENT', tIpc('preview.invalidWriteRequest'));
    const bytes = decodePreviewBytes(request.bytes, request.encoding);
    if (!bytes) return failure('INVALID_ARGUMENT', tIpc('preview.invalidWriteContent'));
    try {
      const descriptor = await previewSessions.writeBytes(request.sessionId, bytes);
      return success({ size: descriptor.size, mtimeMs: descriptor.mtimeMs });
    } catch (error) {
      return previewFailure(error);
    }
  });

  registerHandle('preview.http.send', async (event, request: unknown) => {
    const denied = assertTrustedRenderer(event);
    if (denied) return denied;
    if (!isRecord(request) || typeof request.url !== 'string') return failure('INVALID_ARGUMENT', tIpc('preview.invalidHttpRequest'));
    try {
      return success(await requestHttpPreview(request as unknown as HttpPreviewRequest));
    } catch (error) {
      return previewFailure(error);
    }
  });

  registerHandle('preview.java.decompile', async (event, sessionId: unknown) => {
    const denied = assertTrustedRenderer(event);
    if (denied) return denied;
    if (typeof sessionId !== 'string') return failure('INVALID_ARGUMENT', tIpc('preview.invalidSessionId'));
    try {
      return success(await javaDecompileService.decompile(sessionId));
    } catch (error) {
      return previewFailure(error);
    }
  });

  registerHandle('system.openWithDefaultApp', async (event, relativePath: unknown) => {
    const denied = assertTrustedRenderer(event);
    if (denied) return denied;
    if (typeof relativePath !== 'string') return failure('INVALID_ARGUMENT', tIpc('workspace.invalidPath'));
    try {
      const targetPath = await resolveWorkspaceFilePath(relativePath);
      const error = await shell.openPath(targetPath);
      return error ? failure('UNKNOWN', error) : success(true);
    } catch (error) {
      return previewFailure(error);
    }
  });

  registerHandle('system.revealInFolder', async (event, relativePath: unknown) => {
    const denied = assertTrustedRenderer(event);
    if (denied) return denied;
    if (typeof relativePath !== 'string') return failure('INVALID_ARGUMENT', tIpc('workspace.invalidPath'));
    try {
      shell.showItemInFolder(await resolveWorkspaceFilePath(relativePath));
      return success(true);
    } catch (error) {
      return previewFailure(error);
    }
  });

  registerHandle('archive.list', async (event, request: unknown) => {
    const denied = assertTrustedRenderer(event);
    if (denied) return denied;
    if (!isRecord(request) || typeof request.sessionId !== 'string') return failure('INVALID_ARGUMENT', tIpc('archive.invalidRequest'));
    if (request.password !== undefined) return failure('DEPENDENCY_MISSING', tIpc('archive.encryptedPreviewUnsupported'));
    try {
      return success(await archivePreviewService.list(request.sessionId));
    } catch (error) {
      return previewFailure(error);
    }
  });

  registerHandle('archive.readEntry', async (event, request: unknown) => {
    const denied = assertTrustedRenderer(event);
    if (denied) return denied;
    if (!isRecord(request) || typeof request.sessionId !== 'string' || typeof request.entryPath !== 'string') {
      return failure('INVALID_ARGUMENT', tIpc('archive.invalidEntryRequest'));
    }
    if (request.password !== undefined) return failure('DEPENDENCY_MISSING', tIpc('archive.encryptedPreviewUnsupported'));
    try {
      return success(await archivePreviewService.openEntry(request.sessionId, request.entryPath));
    } catch (error) {
      return previewFailure(error);
    }
  });

  registerHandle('archive.exportEntry', async (event, request: unknown) => {
    const denied = assertTrustedRenderer(event);
    if (denied) return denied;
    if (!isRecord(request) || typeof request.sessionId !== 'string' || typeof request.entryPath !== 'string') {
      return failure('INVALID_ARGUMENT', tIpc('archive.invalidEntryRequest'));
    }
    if (request.password !== undefined) return failure('DEPENDENCY_MISSING', tIpc('archive.encryptedExportUnsupported'));
    try {
      const selected = await dialog.showSaveDialog(getMainWindow()!, { title: tIpc('archive.exportTitle'), defaultPath: path.basename(request.entryPath) });
      if (selected.canceled || !selected.filePath) return failure('CANCELLED', tIpc('archive.exportCancelled'));
      await archivePreviewService.exportEntry(request.sessionId, request.entryPath, selected.filePath);
      return success(true);
    } catch (error) {
      return previewFailure(error);
    }
  });

  registerHandle('workspace.openFolder', async (event) => {
    const denied = assertTrustedRenderer(event);
    if (denied) return denied;
    return openWorkspaceFolder();
  });

  registerHandle('workspace.openRecentFolder', async (event, folderPath: unknown) => {
    const denied = assertTrustedRenderer(event);
    if (denied) return denied;
    if (typeof folderPath !== 'string' || !(await recentFolderStore().paths()).includes(folderPath)) {
      return failure('INVALID_ARGUMENT', tIpc('workspace.recentFolderOnly'));
    }
    return openWorkspaceFolder(folderPath);
  });

  registerHandle('workspace.getRecentFolders', async (event) => {
    const denied = assertTrustedRenderer(event);
    if (denied) return denied;
    return success(await recentFolderStore().list());
  });

  registerHandle('workspace.removeRecentFolder', async (event, folderPath: unknown) => {
    const denied = assertTrustedRenderer(event);
    if (denied) return denied;
    if (typeof folderPath !== 'string') return failure('INVALID_ARGUMENT', tIpc('workspace.invalidFolderPath'));
    await recentFolderStore().forget(folderPath);
    createMenu();
    return success(true);
  });

  registerHandle('workspace.getState', (event) => {
    const denied = assertTrustedRenderer(event);
    if (denied) return denied;
    return success(getWorkspaceState());
  });

  registerHandle('workspace.setState', (event, value: unknown) => {
    const denied = assertTrustedRenderer(event);
    if (denied) return denied;
    if (!isRecord(value)) return failure('INVALID_ARGUMENT', tIpc('workspace.invalidState'));
    const next = setWorkspaceState({
      expandedRelativePaths: Array.isArray(value.expandedRelativePaths)
        ? value.expandedRelativePaths.filter((item): item is string => typeof item === 'string')
        : getWorkspaceState().expandedRelativePaths,
      ...(value.explorerDisplayMode === 'icons' || value.explorerDisplayMode === 'list' ? { explorerDisplayMode: value.explorerDisplayMode } : {}),
      ...(typeof value.explorerIconDirectory === 'string' ? { explorerIconDirectory: value.explorerIconDirectory } : {}),
      versionGuardVisible: typeof value.versionGuardVisible === 'boolean' ? value.versionGuardVisible : getWorkspaceState().versionGuardVisible,
      aiChatVisible: typeof value.aiChatVisible === 'boolean' ? value.aiChatVisible : getWorkspaceState().aiChatVisible,
      versionGuardWidth: typeof value.versionGuardWidth === 'number' ? Math.max(280, Math.min(8000, value.versionGuardWidth)) : getWorkspaceState().versionGuardWidth,
      explorerVisible: typeof value.explorerVisible === 'boolean' ? value.explorerVisible : getWorkspaceState().explorerVisible,
      outlineVisible: typeof value.outlineVisible === 'boolean' ? value.outlineVisible : getWorkspaceState().outlineVisible,
      explorerWidth: typeof value.explorerWidth === 'number' ? value.explorerWidth : getWorkspaceState().explorerWidth,
      outlineWidth: typeof value.outlineWidth === 'number' ? value.outlineWidth : getWorkspaceState().outlineWidth,
      ...(value.panelLayout !== undefined ? { panelLayout: normalizeDesktopPanelLayout(value.panelLayout) } : {}),
    });
    if (next.rootPath) {
      void explorerExpansionStore().remember(next.rootPath, next.expandedRelativePaths)
        .catch((error: unknown) => console.warn('[EasyView_Md] Failed to save explorer expansion:', error));
    }
    createMenu();
    return success(next);
  });

  registerHandle('workspace.readDirectory', async (event, relativePath: unknown) => {
    const denied = assertTrustedRenderer(event);
    if (denied) return denied;
    const rootPath = workspaceRoot();
    if (!rootPath || typeof relativePath !== 'string') return failure('INVALID_ARGUMENT', tIpc('workspace.noReadableDirectory'));
    try {
      return success(await workspaceCore.listChildren(relativePath));
    } catch (error) {
      return failure('INVALID_ARGUMENT', desktopWorkspaceErrorMessage(error));
    }
  });

  registerHandle('workspace.getEntrySize', async (event, relativePath: unknown) => {
    const denied = assertTrustedRenderer(event);
    if (denied) return denied;
    if (!workspaceRoot() || typeof relativePath !== 'string' || !relativePath) return failure('INVALID_ARGUMENT', tIpc('workspace.noReadableDirectory'));
    try { return success(await workspaceCore.getEntrySize(relativePath)); }
    catch (error) { return failure('INVALID_ARGUMENT', desktopWorkspaceErrorMessage(error)); }
  });

  registerHandle('workspace.search', async (event, query: unknown) => {
    const denied = assertTrustedRenderer(event);
    if (denied) return denied;
    if (!workspaceRoot() || typeof query !== 'string' || query.length > 200) return failure('INVALID_ARGUMENT', tIpc('workspace.invalidSearch'));
    try {
      return success(await workspaceCore.search(query));
    } catch (error) {
      return failure('INVALID_ARGUMENT', desktopWorkspaceErrorMessage(error));
    }
  });

  registerHandle('workspace.getSortMode', (event) => {
    const denied = assertTrustedRenderer(event);
    if (denied) return denied;
    if (!workspaceRoot()) return failure('INVALID_ARGUMENT', tIpc('workspace.notOpen'));
    return success(workspaceCore.getSortMode());
  });

  registerHandle('workspace.setSortMode', async (event, sortMode: unknown) => {
    const denied = assertTrustedRenderer(event);
    if (denied) return denied;
    if (sortMode !== 'name' && sortMode !== 'created' && sortMode !== 'custom') {
      return failure('INVALID_ARGUMENT', tIpc('workspace.invalidSortMode'));
    }
    try {
      const next = await workspaceCore.setSortMode(sortMode as WorkspaceTreeSortMode);
      sendToWindow('workspace.changed', null);
      return success(next);
    } catch (error) {
      return failure('INVALID_ARGUMENT', desktopWorkspaceErrorMessage(error));
    }
  });

  const booleanWorkspaceSetting = (
    channelGet: string,
    channelSet: string,
    read: () => boolean,
    write: (value: boolean) => Promise<boolean>,
    invalid: Parameters<typeof tIpc>[0],
  ): void => {
    registerHandle(channelGet, (event) => {
      const denied = assertTrustedRenderer(event);
      if (denied) return denied;
      if (!workspaceRoot()) return failure('INVALID_ARGUMENT', tIpc('workspace.notOpen'));
      return success(read());
    });
    registerHandle(channelSet, async (event, value: unknown) => {
      const denied = assertTrustedRenderer(event);
      if (denied) return denied;
      if (typeof value !== 'boolean') return failure('INVALID_ARGUMENT', tIpc(invalid));
      try {
        const next = await write(value);
        sendToWindow('workspace.changed', null);
        return success(next);
      } catch (error) {
        return failure('INVALID_ARGUMENT', desktopWorkspaceErrorMessage(error));
      }
    });
  };

  booleanWorkspaceSetting('workspace.getShowSizeHover', 'workspace.setShowSizeHover', () => workspaceCore.getShowSizeHover(), (value) => workspaceCore.setShowSizeHover(value), 'workspace.invalidShowCreatedAt');
  booleanWorkspaceSetting('workspace.getShowSize', 'workspace.setShowSize', () => workspaceCore.getShowSize(), (value) => workspaceCore.setShowSize(value), 'workspace.invalidShowCreatedAt');
  booleanWorkspaceSetting('workspace.getShowCreatedAt', 'workspace.setShowCreatedAt', () => workspaceCore.getShowCreatedAt(), (value) => workspaceCore.setShowCreatedAt(value), 'workspace.invalidShowCreatedAt');
  booleanWorkspaceSetting('workspace.getShowUpdatedAt', 'workspace.setShowUpdatedAt', () => workspaceCore.getShowUpdatedAt(), (value) => workspaceCore.setShowUpdatedAt(value), 'workspace.invalidShowUpdatedAt');
  booleanWorkspaceSetting('workspace.getShowDotEntries', 'workspace.setShowDotEntries', () => workspaceCore.getShowDotEntries(), (value) => workspaceCore.setShowDotEntries(value), 'workspace.invalidShowDotEntries');
  booleanWorkspaceSetting('workspace.getShowTimestampHover', 'workspace.setShowTimestampHover', () => workspaceCore.getShowTimestampHover(), (value) => workspaceCore.setShowTimestampHover(value), 'workspace.invalidShowTimestampHover');

  registerHandle('workspace.create', async (event, request: WorkspaceCreateRequest) => {
    const denied = assertTrustedRenderer(event);
    if (denied) return denied;
    const rootPath = workspaceRoot();
    if (!rootPath || !request || typeof request.parentRelativePath !== 'string' || typeof request.name !== 'string') {
      return failure('INVALID_ARGUMENT', tIpc('workspace.invalidCreate'));
    }
    if (request.kind !== 'file' && request.kind !== 'directory') return failure('INVALID_ARGUMENT', tIpc('workspace.invalidKind'));
    try {
      const entry = await workspaceCore.create(request);
      sendToWindow('workspace.changed', [request.parentRelativePath]);
      return success(entry);
    } catch (error) {
      return failure('INVALID_ARGUMENT', desktopWorkspaceErrorMessage(error));
    }
  });

  registerHandle('workspace.rename', async (event, request: WorkspaceRenameRequest) => {
    const denied = assertTrustedRenderer(event);
    if (denied) return denied;
    if (!request || typeof request.relativePath !== 'string' || typeof request.newName !== 'string') return failure('INVALID_ARGUMENT', tIpc('workspace.invalidRename'));
    return renameWorkspaceEntry(request);
  });

  registerHandle('workspace.move', async (event, request: WorkspaceMoveRequest) => {
    const denied = assertTrustedRenderer(event);
    if (denied) return denied;
    if (!request || typeof request.relativePath !== 'string' || typeof request.targetParentRelativePath !== 'string') {
      return failure('INVALID_ARGUMENT', tIpc('workspace.invalidMove'));
    }
    try {
      const entry = await workspaceCore.move(request);
      sendToWindow('workspace.changed', [
        workspaceCore.parentRelativePath(request.relativePath),
        request.targetParentRelativePath,
      ]);
      return success(entry);
    } catch (error) {
      return failure('INVALID_ARGUMENT', desktopWorkspaceErrorMessage(error));
    }
  });

  registerHandle('workspace.reorder', async (event, request: WorkspaceReorderRequest) => {
    const denied = assertTrustedRenderer(event);
    if (denied) return denied;
    if (
      !request
      || typeof request.parentRelativePath !== 'string'
      || typeof request.movedName !== 'string'
      || !Array.isArray(request.siblingNames)
    ) {
      return failure('INVALID_ARGUMENT', tIpc('workspace.invalidReorder'));
    }
    try {
      await workspaceCore.reorder(
        request.parentRelativePath,
        request.movedName,
        request.siblingNames.filter((name): name is string => typeof name === 'string'),
        typeof request.beforeName === 'string' ? request.beforeName : undefined,
      );
      sendToWindow('workspace.changed', [request.parentRelativePath]);
      return success(true);
    } catch (error) {
      return failure('INVALID_ARGUMENT', desktopWorkspaceErrorMessage(error));
    }
  });

  registerHandle('workspace.delete', async (event, request: WorkspaceDeleteRequest) => {
    const denied = assertTrustedRenderer(event);
    if (denied) return denied;
    if (!request || typeof request.relativePath !== 'string') return failure('INVALID_ARGUMENT', tIpc('workspace.invalidDelete'));
    return deleteWorkspaceEntry(request, rendererWindow(event.sender));
  });

  registerHandle('workspace.copyClipboard', (event, relativePaths: unknown) => {
    const denied = assertTrustedRenderer(event);
    if (denied) return denied;
    if (!isStringArray(relativePaths) || relativePaths.length === 0) return failure('INVALID_ARGUMENT', tIpc('workspace.invalidCopyPath'));
    return copyWorkspaceEntryToClipboard(relativePaths);
  });

  registerHandle('workspace.pasteClipboard', async (event, request: WorkspacePasteRequest) => {
    const denied = assertTrustedRenderer(event);
    if (denied) return denied;
    if (!request || typeof request.targetRelativePath !== 'string') return failure('INVALID_ARGUMENT', tIpc('workspace.invalidPasteTarget'));
    return pasteWorkspaceClipboard(request, rendererWindow(event.sender));
  });

  registerHandle('workspace.importExternal', async (event, request: WorkspaceImportExternalRequest) => {
    const denied = assertTrustedRenderer(event);
    if (denied) return denied;
    if (!request || typeof request.targetParentRelativePath !== 'string') return failure('INVALID_ARGUMENT', tIpc('workspace.invalidImportTarget'));
    return importExternalWorkspaceEntries(request, rendererWindow(event.sender));
  });

  registerHandle('workspace.getResourcePaths', (event, relativePath: unknown) => {
    const denied = assertTrustedRenderer(event);
    if (denied) return denied;
    const rootPath = workspaceRoot();
    if (!rootPath || typeof relativePath !== 'string') return failure('INVALID_ARGUMENT', tIpc('workspace.invalidPath'));
    try { return success(workspaceCore.resourcePaths(relativePath)); }
    catch (error) { return failure('INVALID_ARGUMENT', desktopWorkspaceErrorMessage(error)); }
  });

  registerHandle('workspace.showContextMenu', (event, request: unknown) => {
    const denied = assertTrustedRenderer(event);
    if (denied) return denied;
    if (!isRecord(request) || typeof request.relativePath !== 'string' || !['file', 'directory', 'symlink'].includes(String(request.kind))
      || !isStringArray(request.selectedRelativePaths)) {
      return failure('INVALID_ARGUMENT', tIpc('workspace.invalidContextMenu'));
    }
    showWorkspaceContextMenu(event.sender, request.relativePath, request.kind as WorkspaceEntry['kind'], request.selectedRelativePaths);
    return success(true);
  });

  registerHandle('workspace.popupNewFileMenu', (event, request: unknown) => {
    const denied = assertTrustedRenderer(event);
    if (denied) return denied;
    if (
      !isRecord(request)
      || typeof request.parentRelativePath !== 'string'
      || typeof request.x !== 'number' || !Number.isFinite(request.x)
      || typeof request.y !== 'number' || !Number.isFinite(request.y)
    ) {
      return failure('INVALID_ARGUMENT', tIpc('workspace.invalidContextMenu'));
    }
    showNewFileTypeMenu(event.sender, request.parentRelativePath, request.x, request.y);
    return success(true);
  });

  registerHandle('workspace.openEntry', async (event, relativePath: unknown) => {
    const denied = assertTrustedRenderer(event);
    if (denied) return denied;
    if (typeof relativePath !== 'string') return failure('INVALID_ARGUMENT', tIpc('workspace.invalidPath'));
    const result = await openWorkspaceEntryTab(relativePath);
    return result.ok ? success(true) : result;
  });

  registerEvent('desktop.menuState', (event, value: unknown) => {
    if (!trustedRenderer(event) || !isRecord(value)) return;
    if (
      typeof value.sourceMode !== 'boolean'
      || typeof value.outlineVisible !== 'boolean'
      || typeof value.fullWidth !== 'boolean'
      || typeof value.tableWrap !== 'boolean'
      || typeof value.viewChanges !== 'boolean'
      || typeof value.hasActiveDocument !== 'boolean'
      || typeof value.isMarkdownDocument !== 'boolean'
      || !DESKTOP_APPEARANCE_MODES.includes(value.themeMode as DesktopAppearanceMode)
      || typeof value.themeDepth !== 'number' || !Number.isFinite(value.themeDepth)
      || !DESKTOP_ACCENTS.includes(value.accent as DesktopAccent)
    ) return;
    setDesktopMenuState({
      sourceMode: value.sourceMode,
      outlineVisible: value.outlineVisible,
      fullWidth: value.fullWidth,
      tableWrap: value.tableWrap,
      viewChanges: value.viewChanges,
      hasActiveDocument: value.hasActiveDocument,
      isMarkdownDocument: value.isMarkdownDocument,
      themeMode: value.themeMode as DesktopAppearanceMode,
      themeDepth: Math.max(0, Math.min(100, value.themeDepth)),
      accent: value.accent as DesktopAccent,
    });
    createMenu();
  });

  registerEvent('editor.message', (event, value: unknown) => {
    if (!trustedRenderer(event) || !isEditorToHostMessage(value)) return;
    if (acceptDesktopEditorFlush(event.sender, value)) return;
    void handleEditorMessage(value).catch((error) => {
      console.error('[EasyView_Md] Failed to handle editor message:', error);
      void showOperationError(failure('UNKNOWN', error instanceof Error ? error.message : tIpc('editor.operationFailed')));
    });
  });
}
