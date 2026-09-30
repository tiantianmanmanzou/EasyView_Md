import { clipboard, dialog, ipcMain, nativeTheme, shell } from 'electron';
import path from 'node:path';
import { isEditorToHostMessage } from '@easyview/contracts';
import type {
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
} from '../../application/workspace/workspaceWorkflow';
import { rendererWindow } from '../../application/host/desktopRuntime';

function registerHandle<TArgs extends unknown[], TResult>(
  channel: string,
  handler: (event: Electron.IpcMainInvokeEvent, ...args: TArgs) => TResult | Promise<TResult>,
): void {
  ipcMain.handle(channel, (event, ...args) => {
    const context = getWindowContextForSender(event.sender);
    if (!context) return failure('UNKNOWN', '拒绝非当前窗口的请求');
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
  registerHandle('document.open', async (event) => {
    const denied = assertTrustedRenderer(event);
    if (denied) return denied;
    return chooseAndReadDocument();
  });

  registerHandle('document.save', async (event, request: { sessionId?: unknown; content: unknown }) => {
    const denied = assertTrustedRenderer(event);
    if (denied) return denied;
    if (typeof request?.content !== 'string') return failure('INVALID_ARGUMENT', 'content 必须是字符串');
    const sessionId = typeof request.sessionId === 'string' ? request.sessionId : activeEditorTab()?.id;
    if (!sessionId) return failure('NOT_FOUND', '文档会话不存在');
    return saveSession(sessionId, request.content);
  });

  registerHandle('document.saveAs', async (event, request: { sessionId?: unknown; content: unknown; suggestedFileName: unknown; lineEnding: unknown }) => {
    const denied = assertTrustedRenderer(event);
    if (denied) return denied;
    if (typeof request?.content !== 'string' || typeof request.suggestedFileName !== 'string') {
      return failure('INVALID_ARGUMENT', '保存参数无效');
    }
    if (request.lineEnding !== '\n' && request.lineEnding !== '\r\n') {
      return failure('INVALID_ARGUMENT', '换行符无效');
    }
    const sessionId = typeof request.sessionId === 'string' ? request.sessionId : activeEditorTab()?.id;
    if (!sessionId) return failure('NOT_FOUND', '文档会话不存在');
    return saveAsSession(sessionId, request.content, request.suggestedFileName, request.lineEnding);
  });

  registerHandle('document.rename', async (event, request: { sessionId?: unknown; fileName: unknown }) => {
    const denied = assertTrustedRenderer(event);
    if (denied) return denied;
    const sessionId = typeof request?.sessionId === 'string' ? request.sessionId : activeEditorTab()?.id;
    if (!sessionId) return failure('NOT_FOUND', '文档会话不存在');
    return renameSession(sessionId, request?.fileName);
  });

  registerHandle('window.requestClose', async (event) => {
    const denied = assertTrustedRenderer(event);
    if (denied) return denied;
    return success(await confirmCloseAll());
  });

  registerHandle('external.open', async (event, value: unknown) => {
    const denied = assertTrustedRenderer(event);
    if (denied) return denied;
    if (!isAllowedExternalUrl(value)) return failure('INVALID_ARGUMENT', '只允许打开 http/https 链接');
    await shell.openExternal(value);
    return success(true);
  });

  registerHandle('clipboard.writeText', async (event, value: unknown) => {
    const denied = assertTrustedRenderer(event);
    if (denied) return denied;
    if (typeof value !== 'string') return failure('INVALID_ARGUMENT', '剪贴板内容无效');
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
    if (typeof relativePath !== 'string') return failure('INVALID_ARGUMENT', '工作区路径无效');
    return openWorkspaceEntryTab(relativePath);
  });

  registerHandle('tabs.activate', async (event, tabId: unknown) => {
    const denied = assertTrustedRenderer(event);
    if (denied) return denied;
    if (typeof tabId !== 'string') return failure('INVALID_ARGUMENT', '标签标识无效');
    return activateTab(tabId);
  });

  registerHandle('tabs.close', async (event, tabId: unknown) => {
    const denied = assertTrustedRenderer(event);
    if (denied) return denied;
    if (typeof tabId !== 'string') return failure('INVALID_ARGUMENT', '标签标识无效');
    return closeTab(tabId);
  });

  registerHandle('tabs.closeOthers', async (event, tabId: unknown) => {
    const denied = assertTrustedRenderer(event);
    if (denied) return denied;
    if (typeof tabId !== 'string') return failure('INVALID_ARGUMENT', '标签标识无效');
    return closeOtherTabs(tabId);
  });

  registerHandle('tabs.closeAll', async (event, tabId: unknown) => {
    const denied = assertTrustedRenderer(event);
    if (denied) return denied;
    if (typeof tabId !== 'string') return failure('INVALID_ARGUMENT', '标签标识无效');
    return closeGroupTabs(tabId);
  });

  registerHandle('tabs.openPreview', async (event, relativePath: unknown) => {
    const denied = assertTrustedRenderer(event);
    if (denied) return denied;
    if (typeof relativePath !== 'string') return failure('INVALID_ARGUMENT', '工作区路径无效');
    return openWorkspacePreview(relativePath);
  });

  registerHandle('tabs.showContextMenu', (event, tabId: unknown) => {
    const denied = assertTrustedRenderer(event);
    if (denied) return denied;
    if (typeof tabId !== 'string' || !tabRegistry.get(tabId)) return failure('NOT_FOUND', '标签页不存在');
    showTabContextMenu(event.sender, tabId);
    return success(true);
  });

  registerHandle('tabs.executeContextCommand', async (event, request: unknown) => {
    const denied = assertTrustedRenderer(event);
    if (denied) return denied;
    if (!isRecord(request) || typeof request.tabId !== 'string' || typeof request.command !== 'string') {
      return failure('INVALID_ARGUMENT', '标签菜单命令无效');
    }
    return executeTabContextCommand(request.tabId, request.command as DesktopTabContextCommand);
  });

  registerHandle('preview.open', async (event, request: unknown) => {
    const denied = assertTrustedRenderer(event);
    if (denied) return denied;
    const rootPath = workspaceRoot();
    const relativePath = typeof request === 'string' ? request : isRecord(request) && typeof request.relativePath === 'string' ? request.relativePath : null;
    if (!rootPath || !relativePath) return failure('INVALID_ARGUMENT', '预览请求无效');
    try {
      return success(await previewSessions.open(rootPath, relativePath));
    } catch (error) {
      return previewFailure(error);
    }
  });

  registerHandle('preview.close', async (event, sessionId: unknown) => {
    const denied = assertTrustedRenderer(event);
    if (denied) return denied;
    if (typeof sessionId !== 'string') return failure('INVALID_ARGUMENT', '预览会话标识无效');
    try {
      return success(previewSessions.close(sessionId));
    } catch (error) {
      return previewFailure(error);
    }
  });

  registerHandle('preview.readText', async (event, sessionId: unknown) => {
    const denied = assertTrustedRenderer(event);
    if (denied) return denied;
    if (typeof sessionId !== 'string') return failure('INVALID_ARGUMENT', '预览会话标识无效');
    try {
      return success(await previewSessions.readText(sessionId));
    } catch (error) {
      return previewFailure(error);
    }
  });

  registerHandle('preview.writeBytes', async (event, request: unknown) => {
    const denied = assertTrustedRenderer(event);
    if (denied) return denied;
    if (!isRecord(request) || typeof request.sessionId !== 'string') return failure('INVALID_ARGUMENT', '预览写入请求无效');
    const bytes = decodePreviewBytes(request.bytes, request.encoding);
    if (!bytes) return failure('INVALID_ARGUMENT', '预览写入内容无效');
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
    if (!isRecord(request) || typeof request.url !== 'string') return failure('INVALID_ARGUMENT', 'HTTP 请求无效');
    try {
      return success(await requestHttpPreview(request as unknown as HttpPreviewRequest));
    } catch (error) {
      return previewFailure(error);
    }
  });

  registerHandle('preview.java.decompile', async (event, sessionId: unknown) => {
    const denied = assertTrustedRenderer(event);
    if (denied) return denied;
    if (typeof sessionId !== 'string') return failure('INVALID_ARGUMENT', '预览会话标识无效');
    try {
      return success(await javaDecompileService.decompile(sessionId));
    } catch (error) {
      return previewFailure(error);
    }
  });

  registerHandle('system.openWithDefaultApp', async (event, relativePath: unknown) => {
    const denied = assertTrustedRenderer(event);
    if (denied) return denied;
    if (typeof relativePath !== 'string') return failure('INVALID_ARGUMENT', '工作区路径无效');
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
    if (typeof relativePath !== 'string') return failure('INVALID_ARGUMENT', '工作区路径无效');
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
    if (!isRecord(request) || typeof request.sessionId !== 'string') return failure('INVALID_ARGUMENT', '压缩包请求无效');
    if (request.password !== undefined) return failure('DEPENDENCY_MISSING', '加密压缩包暂不支持预览');
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
      return failure('INVALID_ARGUMENT', '压缩包条目请求无效');
    }
    if (request.password !== undefined) return failure('DEPENDENCY_MISSING', '加密压缩包暂不支持预览');
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
      return failure('INVALID_ARGUMENT', '压缩包条目请求无效');
    }
    if (request.password !== undefined) return failure('DEPENDENCY_MISSING', '加密压缩包暂不支持导出');
    try {
      const selected = await dialog.showSaveDialog(getMainWindow()!, { title: '导出压缩包条目', defaultPath: path.basename(request.entryPath) });
      if (selected.canceled || !selected.filePath) return failure('CANCELLED', '已取消导出压缩包条目');
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

  registerHandle('workspace.getState', (event) => {
    const denied = assertTrustedRenderer(event);
    if (denied) return denied;
    return success(getWorkspaceState());
  });

  registerHandle('workspace.setState', (event, value: unknown) => {
    const denied = assertTrustedRenderer(event);
    if (denied) return denied;
    if (!isRecord(value)) return failure('INVALID_ARGUMENT', '工作区状态无效');
    const next = setWorkspaceState({
      expandedRelativePaths: Array.isArray(value.expandedRelativePaths)
        ? value.expandedRelativePaths.filter((item): item is string => typeof item === 'string')
        : getWorkspaceState().expandedRelativePaths,
      explorerVisible: typeof value.explorerVisible === 'boolean' ? value.explorerVisible : getWorkspaceState().explorerVisible,
      outlineVisible: typeof value.outlineVisible === 'boolean' ? value.outlineVisible : getWorkspaceState().outlineVisible,
      explorerWidth: typeof value.explorerWidth === 'number' ? value.explorerWidth : getWorkspaceState().explorerWidth,
      outlineWidth: typeof value.outlineWidth === 'number' ? value.outlineWidth : getWorkspaceState().outlineWidth,
    });
    createMenu();
    return success(next);
  });

  registerHandle('workspace.readDirectory', async (event, relativePath: unknown) => {
    const denied = assertTrustedRenderer(event);
    if (denied) return denied;
    const rootPath = workspaceRoot();
    if (!rootPath || typeof relativePath !== 'string') return failure('INVALID_ARGUMENT', '没有可读取的工作区目录');
    try {
      return success(await workspaceCore.listChildren(relativePath));
    } catch (error) {
      return failure('INVALID_ARGUMENT', desktopWorkspaceErrorMessage(error));
    }
  });

  registerHandle('workspace.getSortMode', (event) => {
    const denied = assertTrustedRenderer(event);
    if (denied) return denied;
    if (!workspaceRoot()) return failure('INVALID_ARGUMENT', '尚未打开工作区');
    return success(workspaceCore.getSortMode());
  });

  registerHandle('workspace.setSortMode', async (event, sortMode: unknown) => {
    const denied = assertTrustedRenderer(event);
    if (denied) return denied;
    if (sortMode !== 'name' && sortMode !== 'created' && sortMode !== 'custom') {
      return failure('INVALID_ARGUMENT', '排序方式无效');
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
    invalid: string,
  ): void => {
    registerHandle(channelGet, (event) => {
      const denied = assertTrustedRenderer(event);
      if (denied) return denied;
      if (!workspaceRoot()) return failure('INVALID_ARGUMENT', '尚未打开工作区');
      return success(read());
    });
    registerHandle(channelSet, async (event, value: unknown) => {
      const denied = assertTrustedRenderer(event);
      if (denied) return denied;
      if (typeof value !== 'boolean') return failure('INVALID_ARGUMENT', invalid);
      try {
        const next = await write(value);
        sendToWindow('workspace.changed', null);
        return success(next);
      } catch (error) {
        return failure('INVALID_ARGUMENT', desktopWorkspaceErrorMessage(error));
      }
    });
  };

  booleanWorkspaceSetting('workspace.getShowCreatedAt', 'workspace.setShowCreatedAt', () => workspaceCore.getShowCreatedAt(), (value) => workspaceCore.setShowCreatedAt(value), '创建时间显示参数无效');
  booleanWorkspaceSetting('workspace.getShowUpdatedAt', 'workspace.setShowUpdatedAt', () => workspaceCore.getShowUpdatedAt(), (value) => workspaceCore.setShowUpdatedAt(value), '更新时间显示参数无效');
  booleanWorkspaceSetting('workspace.getShowDotEntries', 'workspace.setShowDotEntries', () => workspaceCore.getShowDotEntries(), (value) => workspaceCore.setShowDotEntries(value), '点开头条目显示参数无效');
  booleanWorkspaceSetting('workspace.getShowTimestampHover', 'workspace.setShowTimestampHover', () => workspaceCore.getShowTimestampHover(), (value) => workspaceCore.setShowTimestampHover(value), '时间悬停显示参数无效');

  registerHandle('workspace.create', async (event, request: WorkspaceCreateRequest) => {
    const denied = assertTrustedRenderer(event);
    if (denied) return denied;
    const rootPath = workspaceRoot();
    if (!rootPath || !request || typeof request.parentRelativePath !== 'string' || typeof request.name !== 'string') {
      return failure('INVALID_ARGUMENT', '新建节点参数无效');
    }
    if (request.kind !== 'file' && request.kind !== 'directory') return failure('INVALID_ARGUMENT', '节点类型无效');
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
    if (!request || typeof request.relativePath !== 'string' || typeof request.newName !== 'string') return failure('INVALID_ARGUMENT', '重命名参数无效');
    return renameWorkspaceEntry(request);
  });

  registerHandle('workspace.move', async (event, request: WorkspaceMoveRequest) => {
    const denied = assertTrustedRenderer(event);
    if (denied) return denied;
    if (!request || typeof request.relativePath !== 'string' || typeof request.targetParentRelativePath !== 'string') {
      return failure('INVALID_ARGUMENT', '移动参数无效');
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
      return failure('INVALID_ARGUMENT', '排序参数无效');
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
    if (!request || typeof request.relativePath !== 'string') return failure('INVALID_ARGUMENT', '删除参数无效');
    return deleteWorkspaceEntry(request, rendererWindow(event.sender));
  });

  registerHandle('workspace.copyClipboard', (event, relativePath: unknown) => {
    const denied = assertTrustedRenderer(event);
    if (denied) return denied;
    if (typeof relativePath !== 'string') return failure('INVALID_ARGUMENT', '复制路径无效');
    return copyWorkspaceEntryToClipboard(relativePath);
  });

  registerHandle('workspace.pasteClipboard', async (event, request: WorkspacePasteRequest) => {
    const denied = assertTrustedRenderer(event);
    if (denied) return denied;
    if (!request || typeof request.targetRelativePath !== 'string') return failure('INVALID_ARGUMENT', '粘贴目标无效');
    return pasteWorkspaceClipboard(request, rendererWindow(event.sender));
  });

  registerHandle('workspace.importExternal', async (event, request: WorkspaceImportExternalRequest) => {
    const denied = assertTrustedRenderer(event);
    if (denied) return denied;
    if (!request || typeof request.targetParentRelativePath !== 'string') return failure('INVALID_ARGUMENT', '导入目标无效');
    return importExternalWorkspaceEntries(request, rendererWindow(event.sender));
  });

  registerHandle('workspace.getResourcePaths', (event, relativePath: unknown) => {
    const denied = assertTrustedRenderer(event);
    if (denied) return denied;
    const rootPath = workspaceRoot();
    if (!rootPath || typeof relativePath !== 'string') return failure('INVALID_ARGUMENT', '工作区路径无效');
    try { return success(workspaceCore.resourcePaths(relativePath)); }
    catch (error) { return failure('INVALID_ARGUMENT', desktopWorkspaceErrorMessage(error)); }
  });

  registerHandle('workspace.showContextMenu', (event, request: unknown) => {
    const denied = assertTrustedRenderer(event);
    if (denied) return denied;
    if (!isRecord(request) || typeof request.relativePath !== 'string' || !['file', 'directory', 'symlink'].includes(String(request.kind))) {
      return failure('INVALID_ARGUMENT', '目录菜单参数无效');
    }
    showWorkspaceContextMenu(event.sender, request.relativePath, request.kind as WorkspaceEntry['kind']);
    return success(true);
  });

  registerHandle('workspace.openEntry', async (event, relativePath: unknown) => {
    const denied = assertTrustedRenderer(event);
    if (denied) return denied;
    if (typeof relativePath !== 'string') return failure('INVALID_ARGUMENT', '工作区路径无效');
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
      || typeof value.hasActiveDocument !== 'boolean'
    ) return;
    setDesktopMenuState({
      sourceMode: value.sourceMode,
      outlineVisible: value.outlineVisible,
      fullWidth: value.fullWidth,
      tableWrap: value.tableWrap,
      hasActiveDocument: value.hasActiveDocument,
    });
    createMenu();
  });

  registerEvent('editor.message', (event, value: unknown) => {
    if (!trustedRenderer(event) || !isEditorToHostMessage(value)) return;
    void handleEditorMessage(value).catch((error) => {
      console.error('[EasyView_Md] 处理编辑器消息失败:', error);
      void showOperationError(failure('UNKNOWN', error instanceof Error ? error.message : '桌面操作失败'));
    });
  });
}
