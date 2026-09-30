import { Menu, clipboard, dialog, shell } from 'electron';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeWorkspaceRelativePath } from '@easyview/node-runtime';
import type { OperationResult } from '@easyview/contracts';
import type {
  DesktopTab,
  DesktopTabContextCommand,
  DesktopTabSnapshot,
  DesktopWorkspaceState,
  WorkspaceContextCommand,
  WorkspaceDeleteRequest,
  WorkspaceEntry,
  WorkspaceImportExternalRequest,
  WorkspacePasteRequest,
  WorkspaceRenameRequest,
} from '../../../contracts';
import { desktopWorkspaceErrorMessage } from './DesktopWorkspaceCore';
import { openWithSystemApplicationPicker } from './openWithSystemApplicationPicker';
import { WorkspaceWatcher } from './WorkspaceWatcher';
import { resolvePreviewRoute } from '../../../contracts';
import {
  documentSessions,
  failure,
  filePathKey,
  isMarkdownPath,
  getMainWindow,
  getWorkspaceFileClipboard,
  getWorkspaceWatcher,
  getWindowContext,
  notifyActiveDocument,
  previewFailure,
  rendererWindow,
  sendToWindow,
  setWorkspaceFileClipboard,
  setWorkspaceState,
  showMessageBoxFor,
  success,
  syncTabState,
  tabRegistry,
  tabSnapshot,
  workspaceCore,
  workspaceRoot,
  setWorkspaceWatcher,
  runInWindowContext,
} from '../host/desktopRuntime';
import {
  closeAllTabResources,
  closeGroupTabs,
  closeOtherTabs,
  closeTab,
  closeTabIds,
  confirmCloseAll,
  openWorkspaceEntryTab,
  registerPreviewTab,
  resolveWorkspaceFilePath,
  stopWatcher,
  watchDocumentSession,
} from '../document/documentWorkflow';

export function stopWorkspaceWatcher(): void {
  getWorkspaceWatcher()?.stop();
  setWorkspaceWatcher(undefined);
}

export function startWorkspaceWatcher(rootPath: string): void {
  stopWorkspaceWatcher();
  const context = getWindowContext();
  const watcher = new WorkspaceWatcher(rootPath, {
    onChange(relativePaths) {
      runInWindowContext(context, () => {
        const affected = workspaceCore.invalidateFromWatcher(relativePaths);
        sendToWindow('workspace.changed', affected);
      });
    },
  });
  setWorkspaceWatcher(watcher);
  try {
    watcher.start();
  } catch (error) {
    console.warn('[EasyView_Md] 工作区监听不可用:', error);
    stopWorkspaceWatcher();
  }
}

export async function openWorkspaceFolder(): Promise<OperationResult<DesktopWorkspaceState | null>> {
  const selected = await dialog.showOpenDialog(getMainWindow()!, {
    properties: ['openDirectory'],
    title: '打开文件夹',
  });
  if (selected.canceled || !selected.filePaths[0]) return success(null);
  try {
    const candidateRoot = await fs.realpath(selected.filePaths[0]);
    const candidateStat = await fs.stat(candidateRoot);
    if (!candidateStat.isDirectory()) return failure('INVALID_ARGUMENT', '所选路径不是文件夹');
    if (workspaceRoot() !== candidateRoot) {
      if (!(await confirmCloseAll())) return success(null);
      await closeAllTabResources();
      setWorkspaceFileClipboard(null);
    }
    const rootPath = await workspaceCore.bindRoot(candidateRoot);
    const next = setWorkspaceState({ rootPath, openTabs: [], activeTabId: null, expandedRelativePaths: [] });
    startWorkspaceWatcher(rootPath);
    syncTabState();
    return success(next);
  } catch (error) {
    return failure('INVALID_ARGUMENT', desktopWorkspaceErrorMessage(error));
  }
}

export function workspaceEntryAbsolutePath(relativePath: string): string {
  return workspaceCore.resolveAbsolutePath(relativePath);
}

export async function openWorkspacePreview(relativePath: string): Promise<OperationResult<DesktopTabSnapshot>> {
  try {
    const filePath = await resolveWorkspaceFilePath(relativePath);
    const stat = await fs.lstat(filePath);
    if (!stat.isFile() && !stat.isSymbolicLink()) return failure('INVALID_ARGUMENT', '只能预览文件');
    const snapshot = await registerPreviewTab(relativePath);
    return success(snapshot);
  } catch (error) {
    return previewFailure(error);
  }
}

export function tabResourcePaths(tab: DesktopTab): { absolutePath: string; relativePath: string } | null {
  if (tab.kind === 'editor') {
    const rootPath = workspaceRoot();
    const relativePath = rootPath ? path.relative(rootPath, tab.filePath).split(path.sep).join('/') : tab.fileName;
    return { absolutePath: tab.filePath, relativePath };
  }
  if (!workspaceRoot()) return null;
  const paths = workspaceCore.resourcePaths(tab.relativePath);
  return { absolutePath: paths.absolutePath, relativePath: paths.relativePath };
}

export async function executeTabContextCommand(tabId: string, command: DesktopTabContextCommand): Promise<OperationResult<DesktopTabSnapshot>> {
  const tab = tabRegistry.get(tabId);
  if (!tab) return failure('NOT_FOUND', '标签页不存在');
  if (command === 'close') {
    const result = await closeTab(tabId);
    return result.ok && result.value ? success(result.value) : result.ok ? failure('CANCELLED', '已取消关闭标签') : result;
  }
  if (command === 'closeOthers') return closeOtherTabs(tabId);
  if (command === 'closeAll') return closeGroupTabs(tabId);
  if (command === 'copyPath' || command === 'copyRelativePath') {
    const paths = tabResourcePaths(tab);
    if (!paths) return failure('INVALID_ARGUMENT', '当前标签没有可复制的文件路径');
    clipboard.writeText(command === 'copyPath' ? paths.absolutePath : paths.relativePath);
    return success(tabSnapshot());
  }
  if (command === 'splitUp' || command === 'splitDown' || command === 'splitLeft' || command === 'splitRight') {
    const direction = command === 'splitUp' ? 'up' : command === 'splitDown' ? 'down' : command === 'splitLeft' ? 'left' : 'right';
    const group = tabRegistry.split(tabId, direction);
    if (!group) return failure('NOT_FOUND', '无法分屏');
    const created = group.tabs[0];
    if (created?.kind === 'editor') {
      const source = documentSessions.get(tabId);
      if (source) documentSessions.alias(created.id, source.tabId);
    }
    syncTabState();
    if (created?.kind === 'editor') notifyActiveDocument('initial');
    return success(tabSnapshot());
  }
  return failure('DEPENDENCY_MISSING', '多窗口数据模型和 webContents 路由已建立；编辑器运行时仍为单实例，暂不能安全移动活动编辑器到新窗口。');
}

export async function renameWorkspaceEntry(request: WorkspaceRenameRequest): Promise<OperationResult<WorkspaceEntry>> {
  const rootPath = workspaceRoot();
  if (!rootPath) return failure('INVALID_ARGUMENT', '尚未打开工作区');
  try {
    const oldPaths = workspaceCore.resourcePaths(request.relativePath);
    const entry = await workspaceCore.rename(request);
    const nextPaths = workspaceCore.resourcePaths(entry.relativePath);
    for (const session of documentSessions.values()) {
      if (!session.filePath || filePathKey(session.filePath) !== filePathKey(oldPaths.absolutePath)) continue;
      await stopWatcher(session);
      session.filePath = nextPaths.absolutePath;
      session.fileName = entry.name;
      tabRegistry.renameEditor(session.tabId, nextPaths.absolutePath, entry.name);
      void watchDocumentSession(session);
    }
    tabRegistry.renamePreview(request.relativePath, entry.relativePath, entry.name);
    syncTabState();
    if (tabRegistry.active()?.kind === 'editor') notifyActiveDocument('reload');
    sendToWindow('workspace.changed', [workspaceCore.parentRelativePath(request.relativePath), workspaceCore.parentRelativePath(entry.relativePath)]);
    return success(entry);
  } catch (error) {
    return failure('INVALID_ARGUMENT', desktopWorkspaceErrorMessage(error));
  }
}

export async function deleteWorkspaceEntry(request: WorkspaceDeleteRequest, owner = getMainWindow() ?? null): Promise<OperationResult<boolean>> {
  const rootPath = workspaceRoot();
  if (!rootPath) return failure('INVALID_ARGUMENT', '尚未打开工作区');
  try {
    const paths = workspaceCore.resourcePaths(request.relativePath);
    const stat = await fs.lstat(paths.absolutePath);
    const confirmation = await showMessageBoxFor(owner, {
      type: 'warning',
      buttons: ['移到废纸篓', '取消'],
      defaultId: 0,
      cancelId: 1,
      message: `确定删除“${path.basename(paths.absolutePath)}”吗？`,
      detail: '该项目将使用系统废纸篓删除。',
    });
    if (confirmation.response !== 0) return failure('CANCELLED', '已取消删除');

    const affectedTabs = tabSnapshot().groups.flatMap((group) => group.tabs).filter((tab) => {
      if (tab.kind === 'editor') {
        const key = filePathKey(tab.filePath);
        const targetKey = filePathKey(paths.absolutePath);
        return key === targetKey || (stat.isDirectory() && key.startsWith(`${targetKey}${path.sep}`));
      }
      const normalized = tab.relativePath.replace(/\\/g, '/');
      return normalized === request.relativePath || (stat.isDirectory() && normalized.startsWith(`${request.relativePath}/`));
    });
    if (!(await closeTabIds([...new Set(affectedTabs.map((tab) => tab.id))]))) return failure('CANCELLED', '已取消删除');
    await workspaceCore.delete({ relativePath: request.relativePath, options: { useTrash: true, recursive: true } });
    sendToWindow('workspace.changed', [workspaceCore.parentRelativePath(request.relativePath)]);
    return success(true);
  } catch (error) {
    return failure('UNKNOWN', desktopWorkspaceErrorMessage(error));
  }
}

export function copyWorkspaceEntryToClipboard(relativePath: string): OperationResult<boolean> {
  const rootPath = workspaceRoot();
  if (!rootPath) return failure('INVALID_ARGUMENT', '尚未打开工作区');
  try {
    const paths = workspaceCore.resourcePaths(relativePath);
    setWorkspaceFileClipboard({ relativePath: paths.relativePath });
    clipboard.writeText(paths.absolutePath);
    return success(true);
  } catch (error) {
    return failure('INVALID_ARGUMENT', desktopWorkspaceErrorMessage(error));
  }
}

async function resolvePasteTargetDirectory(targetRelativePath: string): Promise<string> {
  const rootPath = workspaceRoot();
  if (!rootPath) throw new Error('尚未打开工作区');
  const paths = workspaceCore.resourcePaths(targetRelativePath);
  const stat = await fs.lstat(paths.absolutePath);
  if (stat.isDirectory() && !stat.isSymbolicLink()) return paths.relativePath;
  return workspaceCore.parentRelativePath(paths.relativePath);
}

export async function importExternalWorkspaceEntries(
  request: WorkspaceImportExternalRequest,
  owner = getMainWindow() ?? null,
): Promise<OperationResult<WorkspaceEntry>> {
  const rootPath = workspaceRoot();
  if (!rootPath) return failure('INVALID_ARGUMENT', '尚未打开工作区');
  const sourcePaths = [
    ...(Array.isArray(request.sourcePaths) ? request.sourcePaths : []),
    ...urisToFilePaths(request.sourceUris),
  ].filter((value) => typeof value === 'string' && value.trim().length > 0);
  const items = Array.isArray(request.items) ? request.items : [];
  if (sourcePaths.length === 0 && items.length === 0) return failure('INVALID_ARGUMENT', '没有可导入的文件');
  try {
    const targetParentRelativePath = normalizeWorkspaceRelativePath(request.targetParentRelativePath ?? '');
    let last: WorkspaceEntry | undefined;
    if (sourcePaths.length > 0) {
      for (const sourcePath of sourcePaths) {
        last = await workspaceCore.importExternal(sourcePath, targetParentRelativePath);
      }
    } else {
      last = await workspaceCore.importExternalItems(
        targetParentRelativePath,
        items.map((item) => ({
          kind: item.kind,
          relativePath: item.relativePath,
          ...(item.dataBase64 ? { data: Buffer.from(item.dataBase64, 'base64') } : {}),
        })),
      );
    }
    if (!last) return failure('INVALID_ARGUMENT', '没有可导入的文件');
    sendToWindow('workspace.changed', [targetParentRelativePath]);
    return success(last);
  } catch (error) {
    const message = desktopWorkspaceErrorMessage(error);
    void showMessageBoxFor(owner, { type: 'error', message });
    return failure('INVALID_ARGUMENT', message);
  }
}

function urisToFilePaths(uris: unknown): string[] {
  if (!Array.isArray(uris)) return [];
  const paths: string[] = [];
  for (const value of uris) {
    if (typeof value !== 'string' || !value.trim()) continue;
    try {
      paths.push(fileURLToPath(value));
    } catch {
      // Ignore non-file URIs from the renderer drop payload.
    }
  }
  return paths;
}

export async function pasteWorkspaceClipboard(request: WorkspacePasteRequest, owner = getMainWindow() ?? null): Promise<OperationResult<WorkspaceEntry>> {
  const rootPath = workspaceRoot();
  if (!rootPath) return failure('INVALID_ARGUMENT', '尚未打开工作区');
  const clipboardState = getWorkspaceFileClipboard();
  if (!clipboardState) return failure('INVALID_ARGUMENT', '剪贴板中没有可粘贴的文件');
  try {
    const targetParentRelativePath = await resolvePasteTargetDirectory(request.targetRelativePath);
    const entry = await workspaceCore.copy({
      sourceRelativePath: clipboardState.relativePath,
      targetParentRelativePath,
    });
    sendToWindow('workspace.changed', [targetParentRelativePath]);
    return success(entry);
  } catch (error) {
    const message = desktopWorkspaceErrorMessage(error);
    void showMessageBoxFor(owner, { type: 'error', message });
    return failure('INVALID_ARGUMENT', message);
  }
}

export function showOpenWithPicker(relativePath: string, owner: Electron.BrowserWindow | null): void {
  const absolutePath = workspaceEntryAbsolutePath(relativePath);
  const fileName = path.basename(absolutePath);
  const markdown = isMarkdownPath(absolutePath);
  const previewRoute = resolvePreviewRoute(fileName);
  const items: Electron.MenuItemConstructorOptions[] = [];

  if (markdown) {
    items.push({
      label: 'EasyView Editor',
      click: () => {
        void openWorkspaceEntryTab(relativePath).then((result) => {
          if (!result.ok) void showMessageBoxFor(owner, { type: 'error', message: result.message });
        });
      },
    });
  }
  if (previewRoute || !markdown) {
    items.push({
      label: 'Preview',
      click: () => {
        void openWorkspacePreview(relativePath).then((result) => {
          if (!result.ok) void showMessageBoxFor(owner, { type: 'error', message: result.message });
        });
      },
    });
  }
  items.push({
    label: 'Default Application',
    click: () => {
      void shell.openPath(absolutePath).then((error) => {
        if (error) void showMessageBoxFor(owner, { type: 'error', message: error });
      });
    },
  });
  items.push({ type: 'separator' });
  items.push({
    label: 'Choose Application…',
    click: () => {
      void openWithSystemApplicationPicker(absolutePath, owner).catch((error) => {
        void showMessageBoxFor(owner, {
          type: 'error',
          message: error instanceof Error ? error.message : '无法打开文件',
        });
      });
    },
  });

  Menu.buildFromTemplate(items).popup({ window: owner ?? undefined });
}

export function showWorkspaceContextMenu(sender: Electron.WebContents, relativePath: string, kind: WorkspaceEntry['kind']): void {
  const isFile = kind === 'file' || kind === 'symlink';
  const canPaste = getWorkspaceFileClipboard() !== null;
  const owner = rendererWindow(sender);
  const run = (command: WorkspaceContextCommand): void => {
    if (command === 'rename') {
      sender.send('workspace.contextCommand', command, relativePath);
      return;
    }
    if (command === 'delete') {
      void deleteWorkspaceEntry({ relativePath }, owner).then((result) => {
        if (!result.ok && result.code !== 'CANCELLED') void showMessageBoxFor(owner, { type: 'error', message: result.message });
      });
      return;
    }
    if (command === 'openPreview') { void openWorkspacePreview(relativePath); return; }
    if (command === 'openWith') { showOpenWithPicker(relativePath, owner); return; }
    if (command === 'openDefault') { void shell.openPath(workspaceEntryAbsolutePath(relativePath)); return; }
    if (command === 'reveal') { shell.showItemInFolder(workspaceEntryAbsolutePath(relativePath)); return; }
    if (command === 'copy') {
      const result = copyWorkspaceEntryToClipboard(relativePath);
      if (!result.ok) void showMessageBoxFor(owner, { type: 'error', message: result.message });
      return;
    }
    if (command === 'paste') {
      void pasteWorkspaceClipboard({ targetRelativePath: relativePath }, owner).then((result) => {
        if (result.ok) sender.send('workspace.contextCommand', 'paste', result.value.relativePath);
      });
      return;
    }
    const rootPath = workspaceRoot();
    if (!rootPath) return;
    const paths = workspaceCore.resourcePaths(relativePath);
    clipboard.writeText(command === 'copyPath' ? paths.absolutePath : paths.relativePath);
  };
  const template: Electron.MenuItemConstructorOptions[] = [
    { label: 'Open Preview', enabled: isFile, click: () => run('openPreview') },
    { label: 'Open With...', enabled: isFile, click: () => run('openWith') },
    { label: 'Open with Default Application', enabled: isFile, click: () => run('openDefault') },
    { label: process.platform === 'darwin' ? 'Reveal in Finder' : 'Reveal in File Explorer', click: () => run('reveal') },
    { type: 'separator' },
    { label: 'Copy', accelerator: 'CmdOrCtrl+C', click: () => run('copy') },
    { label: 'Paste', accelerator: 'CmdOrCtrl+V', enabled: canPaste, click: () => run('paste') },
    { label: 'Copy Path', click: () => run('copyPath') },
    { label: 'Copy Relative Path', click: () => run('copyRelativePath') },
    { type: 'separator' },
    { label: 'Rename', click: () => run('rename') },
    { label: 'Delete', accelerator: process.platform === 'darwin' ? 'Cmd+Backspace' : 'Delete', click: () => run('delete') },
  ];
  Menu.buildFromTemplate(template).popup({ window: owner ?? undefined });
}

export function showTabContextMenu(sender: Electron.WebContents, tabId: string): void {
  const tab = tabRegistry.get(tabId);
  if (!tab) return;
  const run = (command: DesktopTabContextCommand): void => {
    void executeTabContextCommand(tabId, command).then((result) => {
      if (!result.ok) void showMessageBoxFor(rendererWindow(sender), { type: 'info', message: result.message });
    });
  };
  const splitEnabled = tabSnapshot().splitRenderingAvailable;
  Menu.buildFromTemplate([
    { label: 'Close', click: () => run('close') },
    { label: 'Close Others', click: () => run('closeOthers') },
    { label: 'Close All', click: () => run('closeAll') },
    { type: 'separator' },
    { label: 'Copy Path', click: () => run('copyPath') },
    { label: 'Copy Relative Path', click: () => run('copyRelativePath') },
    { type: 'separator' },
    { label: 'Split & Move', submenu: [
      { label: 'Split Up', enabled: splitEnabled, click: () => run('splitUp') },
      { label: 'Split Down', enabled: splitEnabled, click: () => run('splitDown') },
      { label: 'Split Left', enabled: splitEnabled, click: () => run('splitLeft') },
      { label: 'Split Right', enabled: splitEnabled, click: () => run('splitRight') },
      { type: 'separator' },
      { label: 'Move into New Window', enabled: splitEnabled, click: () => run('moveNewWindow') },
    ] },
  ]).popup({ window: rendererWindow(sender) ?? undefined });
}
