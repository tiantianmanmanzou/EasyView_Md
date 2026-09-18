import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  Menu,
  nativeTheme,
  protocol,
  safeStorage,
  shell,
} from 'electron';
import { promises as fs, watch, type FSWatcher } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  operationFailure,
  operationSuccess,
  isEditorToHostMessage,
} from '@easyview/contracts';
import {
  buildXlsxBuffer,
  commitFile as commitGitFile,
  convertDocumentToMarkdown,
  DocumentConversionError,
  findRepository,
  getFileStatus,
  getUpstreamStatus,
  ImageServiceError,
  pickImage,
  readImageAsDataUrl,
  push as pushGitRepository,
  savePastedImage,
  stageFile as stageGitFile,
  writeDocxExport,
  writeFileAtomically,
  writeHtmlExport,
  writePdfBase64,
  AiChatHost,
} from '@easyview/node-runtime';
import { TerminalService } from '@easyview/node-runtime';
import { createAppStateStore, type AppStateStore, WINDOW_ZOOM_LEVEL_MAX, WINDOW_ZOOM_LEVEL_MIN } from '../../application/document/appState';
import { DesktopTabRegistry } from '../../application/document/DesktopTabRegistry';
import { DesktopWorkspaceCore, desktopWorkspaceErrorMessage } from '../../application/workspace/DesktopWorkspaceCore';
import { openWithSystemApplicationPicker } from '../../application/workspace/openWithSystemApplicationPicker';
import { DesktopWindowRegistry } from '../../application/document/DesktopWindowRegistry';
import { WorkspaceWatcher } from '../../application/workspace/WorkspaceWatcher';
import { ArchivePreviewService } from '../../application/preview/ArchivePreviewService';
import { requestHttpPreview, HttpPreviewError } from '../../application/preview/HttpPreviewService';
import { JavaDecompileService } from '../../application/preview/JavaDecompileService';
import { PreviewSessionError, PreviewSessionStore } from '../../application/preview/PreviewSession';
import { registerPreviewProtocol, registerPreviewScheme } from './previewProtocol';
import { isAllowedExternalUrl } from './rendererSecurity';
import type {
  HostToEditorMessage,
  OperationErrorCode,
  OperationResult,
  EditorToHostMessage,
} from '@easyview/contracts';
import type {
  DesktopMenuCommand,
  DesktopMenuState,
  DesktopTab,
  DesktopTabSnapshot,
  DesktopWorkspaceState,
  DocumentOpenResult,
  SaveDocumentResult,
  DesktopTabContextCommand,
  WorkspaceContextCommand,
  WorkspaceCreateRequest,
  WorkspaceDeleteRequest,
  WorkspaceEntry,
  WorkspacePasteRequest,
  WorkspaceRenameRequest,
} from '../../../contracts';
import { resolvePreviewRoute } from '../../../contracts';

interface DocumentSession {
  tabId: string;
  filePath: string | null;
  fileName: string;
  content: string;
  diskContent: string;
  lineEnding: '\n' | '\r\n';
  diskMtimeMs: number | null;
  dirty: boolean;
  watcher?: FSWatcher;
  externalConflict: { mtimeMs: number | null; content: string } | null;
}

let mainWindow: BrowserWindow | undefined;
const tabRegistry = new DesktopTabRegistry();
const documentSessions = new Map<string, DocumentSession>();
let documentSession: DocumentSession = createEmptySession();
let isClosing = false;
let tableFirstRowStickyDefault = false;
let pendingOpenPath: string | undefined;
let saveQueue: Promise<unknown> = Promise.resolve();
let terminalService: TerminalService | undefined;
let activeTerminalSessionId: string | undefined;
let appStateStore: AppStateStore | undefined;
const workspaceCore = new DesktopWorkspaceCore(async (absolutePath) => {
  await shell.trashItem(absolutePath);
});
/** In-app explorer clipboard for Copy → Paste of workspace entries. */
let workspaceFileClipboard: { relativePath: string } | null = null;
const windowSessions = new DesktopWindowRegistry();
const previewSessions = new PreviewSessionStore();
const archivePreviewService = new ArchivePreviewService(previewSessions);
const javaDecompileService = new JavaDecompileService(previewSessions);
registerPreviewScheme();
let workspaceWatcher: WorkspaceWatcher | undefined;
let aiChatHost: AiChatHost | undefined;
let desktopMenuState: DesktopMenuState = {
  sourceMode: false,
  outlineVisible: true,
  fullWidth: true,
  tableWrap: false,
  hasActiveDocument: false,
};

function getAppStateStore(): AppStateStore {
  if (!appStateStore) throw new Error('应用状态尚未初始化');
  return appStateStore;
}

function createEmptySession(): DocumentSession {
  return {
    tabId: '',
    filePath: null,
    fileName: 'Untitled.md',
    content: '',
    diskContent: '',
    lineEnding: '\n',
    diskMtimeMs: null,
    dirty: false,
    externalConflict: null,
  };
}

function success<T>(value: T): OperationResult<T> {
  return operationSuccess(value);
}

function failure(code: OperationErrorCode, message: string): OperationResult<never> {
  return operationFailure(code, message);
}

function previewFailure(error: unknown): OperationResult<never> {
  if (error instanceof PreviewSessionError) {
    const code: OperationErrorCode = error.kind === 'not-found' || error.kind === 'stale' ? 'NOT_FOUND'
      : error.kind === 'permission' ? 'PERMISSION_DENIED'
        : error.kind === 'unsupported' ? 'DEPENDENCY_MISSING'
          : 'INVALID_ARGUMENT';
    return failure(code, error.message);
  }
  if (error instanceof HttpPreviewError) {
    return failure(error.kind === 'permission' ? 'PERMISSION_DENIED' : error.kind === 'invalid' ? 'INVALID_ARGUMENT' : 'UNKNOWN', error.message);
  }
  return failure('UNKNOWN', error instanceof Error ? error.message : '预览操作失败');
}

function trustedRenderer(event: { sender: Electron.WebContents }): boolean {
  return windowSessions.fromWebContents(event.sender) !== null;
}

function rendererWindow(sender?: Electron.WebContents): BrowserWindow | null {
  if (sender) return BrowserWindow.fromWebContents(sender);
  return mainWindow ?? null;
}

function showMessageBoxFor(owner: BrowserWindow | null, options: Electron.MessageBoxOptions): Promise<Electron.MessageBoxReturnValue> {
  return owner ? dialog.showMessageBox(owner, options) : dialog.showMessageBox(options);
}

/**
 * Sends an IPC message only while the target window and its webContents are
 * still alive. `BrowserWindow` instances survive their own destruction, so the
 * optional-chain form still throws "Object has been destroyed" when a
 * debounced watcher or timer fires after the window closed.
 */
function sendToWindow(channel: string, ...args: unknown[]): boolean {
  const target = mainWindow;
  if (!target || target.isDestroyed() || target.webContents.isDestroyed()) return false;
  target.webContents.send(channel, ...args);
  return true;
}

function applyWindowZoomLevel(level: number): void {
  const next = Math.max(WINDOW_ZOOM_LEVEL_MIN, Math.min(WINDOW_ZOOM_LEVEL_MAX, Math.round(level)));
  getAppStateStore().setZoomLevel(next);
  const target = mainWindow;
  if (!target || target.isDestroyed() || target.webContents.isDestroyed()) return;
  target.webContents.setZoomLevel(next);
}

function zoomWindowBy(delta: number): void {
  applyWindowZoomLevel(getAppStateStore().getZoomLevel() + delta);
}

function resetWindowZoom(): void {
  applyWindowZoomLevel(0);
}

function assertTrustedRenderer(event: { sender: Electron.WebContents }): OperationResult<never> | null {
  return trustedRenderer(event) ? null : failure('UNKNOWN', '拒绝非当前窗口的请求');
}

function normalizeLineEnding(content: string): { content: string; lineEnding: '\n' | '\r\n' } {
  const lineEnding = content.includes('\r\n') ? '\r\n' : '\n';
  return { content: content.replace(/\r\n/g, '\n'), lineEnding };
}

function withLineEnding(content: string, lineEnding: '\n' | '\r\n'): string {
  const normalized = content.replace(/\r\n/g, '\n');
  return lineEnding === '\r\n' ? normalized.replace(/\n/g, '\r\n') : normalized;
}

function isMarkdownPath(filePath: string): boolean {
  return /\.(md|markdown|mdx)$/i.test(filePath);
}

function markdownFileName(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  let fileName = value.trim();
  if (!fileName || fileName === '.' || fileName === '..' || /[\\/]/.test(fileName)) return null;
  if (!isMarkdownPath(fileName)) {
    const extension = documentSession.filePath ? path.extname(documentSession.filePath) : '.md';
    fileName += extension || '.md';
  }
  return isMarkdownPath(fileName) ? fileName : null;
}

function resolveRendererPath(): string {
  return path.join(__dirname, '../renderer/index.html');
}

function isCurrentRendererUrl(value: string): boolean {
  try {
    return path.resolve(fileURLToPath(new URL(value))) === path.resolve(resolveRendererPath());
  } catch {
    return false;
  }
}

function enqueueSave<T>(operation: () => Promise<T>): Promise<T> {
  const result = saveQueue.then(operation, operation);
  saveQueue = result.then(() => undefined, () => undefined);
  return result;
}

function fileNameWithoutExtension(fileName: string): string {
  return fileName.replace(/\.(md|markdown|mdx)$/i, '');
}


function filePathKey(filePath: string): string {
  const resolved = path.resolve(filePath);
  return process.platform === 'win32' || process.platform === 'darwin'
    ? resolved.toLocaleLowerCase()
    : resolved;
}

function currentDocumentResult(): DocumentOpenResult {
  return {
    filePath: documentSession.filePath ?? '',
    fileName: documentSession.fileName,
    content: documentSession.content,
    lineEnding: documentSession.lineEnding,
    mtimeMs: documentSession.diskMtimeMs ?? 0,
  };
}

function getTerminalService(): TerminalService {
  if (terminalService) return terminalService;
  terminalService = new TerminalService({
    defaultCwd: documentDirectory(),
    onData: (sessionId, data) => {
      sendEditorMessage({ type: 'terminalData', sessionId, data });
    },
    onExit: (sessionId, exitCode, signal) => {
      if (activeTerminalSessionId === sessionId) activeTerminalSessionId = undefined;
      sendEditorMessage({ type: 'terminalExit', sessionId, code: exitCode, signal: signal ?? null });
    },
  });
  return terminalService;
}

async function resolveGitContext(): Promise<{ rootPath: string; filePath: string }> {
  const filePath = documentSession.filePath;
  if (!filePath) throw new Error('请先保存 Markdown 文档。');
  const repository = await findRepository(filePath);
  if (!repository) throw new Error('当前文档不属于 Git 仓库。');
  return { rootPath: repository.rootPath, filePath };
}

function currentEditorDocumentMessage(
  type: 'init' | 'documentChanged',
): HostToEditorMessage {
  return {
    type,
    content: documentSession.content,
    filename: fileNameWithoutExtension(documentSession.fileName),
    filePath: documentSession.filePath ?? '',
    fullWidth: true,
    tocVisible: getWorkspaceState().outlineVisible,
    tableWrap: false,
    imagePathMap: {},
    tableFirstRowStickyDefault,
    initialCursorLine: 0,
    initialCursorCharacter: 0,
    initialTotalLines: Math.max(1, documentSession.content.split('\n').length),
  };
}

function sendEditorMessage(message: HostToEditorMessage): void {
  sendToWindow('editor.message', message);
}

function createDesktopAiChatHost(): AiChatHost {
  const userDataPath = app.getPath('userData');
  const settingsFilePath = path.join(userDataPath, 'ai-chat-settings.json');
  const apiKeyPath = path.join(userDataPath, 'ai-chat-api-key.bin');
  return new AiChatHost({
    settingsFilePath,
    secretStore: {
      async getApiKey() {
        if (!safeStorage.isEncryptionAvailable()) return null;
        try {
          const encrypted = await fs.readFile(apiKeyPath);
          return safeStorage.decryptString(encrypted);
        } catch {
          return null;
        }
      },
      async setApiKey(apiKey) {
        if (!safeStorage.isEncryptionAvailable()) {
          throw new Error('当前系统不支持安全存储 API Key');
        }
        const encrypted = safeStorage.encryptString(apiKey);
        await fs.writeFile(apiKeyPath, encrypted);
      },
    },
    postMessage: sendEditorMessage,
    pickImages: {
      pickImages: async () => {
        const chosen = await dialog.showOpenDialog(mainWindow!, {
          properties: ['openFile', 'multiSelections'],
          filters: [
            {
              name: 'Images',
              extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'svg'],
            },
          ],
        });
        if (chosen.canceled) return [];
        const images: Array<{ name: string; dataUrl: string }> = [];
        for (const filePath of chosen.filePaths) {
          const bytes = await fs.readFile(filePath);
          const extension = path.extname(filePath).toLowerCase();
          const mimeType =
            extension === '.png' ? 'image/png'
              : extension === '.jpg' || extension === '.jpeg' ? 'image/jpeg'
                : extension === '.gif' ? 'image/gif'
                  : extension === '.webp' ? 'image/webp'
                    : extension === '.bmp' ? 'image/bmp'
                      : extension === '.svg' ? 'image/svg+xml'
                        : 'application/octet-stream';
          images.push({
            name: path.basename(filePath),
            dataUrl: `data:${mimeType};base64,${bytes.toString('base64')}`,
          });
        }
        return images;
      },
    },
  });
}

function getAiChatHost(): AiChatHost {
  if (!aiChatHost) aiChatHost = createDesktopAiChatHost();
  return aiChatHost;
}

function updateWindowTitle(): void {
  const active = tabRegistry.active();
  if (!active) {
    mainWindow?.setTitle('EasyView_Md');
    return;
  }
  const dirtyMarker = active.kind === 'editor' && active.dirty ? ' •' : '';
  mainWindow?.setTitle(`${active.fileName}${dirtyMarker} — EasyView_Md`);
}

function getWorkspaceState(): DesktopWorkspaceState {
  return getAppStateStore().getWorkspace();
}

function setWorkspaceState(patch: Partial<DesktopWorkspaceState>): DesktopWorkspaceState {
  const next = { ...getWorkspaceState(), ...patch };
  getAppStateStore().setWorkspace(next);
  return next;
}

function workspaceRoot(): string | null {
  return getWorkspaceState().rootPath;
}


function tabSnapshot(): DesktopTabSnapshot {
  return tabRegistry.snapshot();
}

function persistTabs(): void {
  const snapshot = tabSnapshot();
  setWorkspaceState({
    openTabs: tabRegistry.persisted(),
    activeTabId: snapshot.activeTabId,
    editorGroups: tabRegistry.persistedGroups(),
    activeEditorGroupId: snapshot.activeGroupId,
    editorGroupLayout: tabRegistry.persistedLayout(),
  });
}

function publishTabs(): DesktopTabSnapshot {
  const snapshot = tabSnapshot();
  sendToWindow('tabs.changed', snapshot);
  return snapshot;
}

function syncTabState(): DesktopTabSnapshot {
  persistTabs();
  updateWindowTitle();
  const active = tabRegistry.active();
  desktopMenuState = { ...desktopMenuState, hasActiveDocument: active?.kind === 'editor' };
  createMenu();
  return publishTabs();
}

function activeEditorTab(): Extract<DesktopTab, { kind: 'editor' }> | null {
  const active = tabRegistry.active();
  return active?.kind === 'editor' ? active : null;
}

function activateEditorSession(tabId: string): DocumentSession | null {
  const session = documentSessions.get(tabId) ?? null;
  if (!session) return null;
  documentSession = session;
  return session;
}

function notifyActiveDocument(type: 'init' | 'documentChanged' = 'init'): void {
  const active = activeEditorTab();
  if (!active || !activateEditorSession(active.id)) return;
  sendToWindow('document.changed', currentDocumentResult());
  sendEditorMessage(currentEditorDocumentMessage(type));
}

function publishMenuCommand(command: DesktopMenuCommand): void {
  sendToWindow('desktop.menuCommand', command);
}

function stopWorkspaceWatcher(): void {
  workspaceWatcher?.stop();
  workspaceWatcher = undefined;
}

function startWorkspaceWatcher(rootPath: string): void {
  stopWorkspaceWatcher();
  workspaceWatcher = new WorkspaceWatcher(rootPath, {
    onChange(relativePaths) {
      const affected = workspaceCore.invalidateFromWatcher(relativePaths);
      sendToWindow('workspace.changed', affected);
    },
  });
  try {
    workspaceWatcher.start();
  } catch (error) {
    console.warn('[EasyView_Md] 工作区监听不可用:', error);
    stopWorkspaceWatcher();
  }
}

async function closeAllTabResources(): Promise<void> {
  for (const session of documentSessions.values()) await stopWatcher(session);
  documentSessions.clear();
  tabRegistry.clear();
  documentSession = createEmptySession();
  previewSessions.closeAll();
}

async function openWorkspaceFolder(): Promise<OperationResult<DesktopWorkspaceState | null>> {
  const selected = await dialog.showOpenDialog(mainWindow!, {
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
      workspaceFileClipboard = null;
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

async function restoreWorkspace(): Promise<void> {
  const current = getWorkspaceState();
  let rootPath: string | null = null;
  if (current.rootPath) {
    try {
      rootPath = await workspaceCore.bindRoot(current.rootPath);
      startWorkspaceWatcher(rootPath);
    } catch {
      workspaceCore.clear();
      rootPath = null;
    }
  } else {
    workspaceCore.clear();
  }
  if (rootPath !== current.rootPath) setWorkspaceState({ rootPath });

  for (const tab of current.openTabs) {
    if (tab.kind === 'editor') {
      await loadEditorTab(tab.filePath, tab.id, false);
      continue;
    }
    if (!rootPath) continue;
    try {
      await registerPreviewTab(tab.relativePath, tab.id, false);
    } catch {
      // Missing or unsupported restored preview tabs are intentionally skipped.
    }
  }

  if (current.activeTabId && tabRegistry.get(current.activeTabId)) {
    tabRegistry.activate(current.activeTabId);
  }
  const active = tabRegistry.active();
  if (active?.kind === 'editor') activateEditorSession(active.id);
  persistTabs();
}

async function stopWatcher(session: DocumentSession = documentSession): Promise<void> {
  session.watcher?.close();
  session.watcher = undefined;
}

async function watchDocumentSession(session: DocumentSession): Promise<boolean> {
  await stopWatcher(session);
  if (!session.filePath) return true;
  try {
    session.watcher = watch(session.filePath, { persistent: false }, () => {
      void reloadIfChanged(session).catch((error) => {
        console.warn('[EasyView_Md] 文件变化检查失败:', error);
      });
    });
    return true;
  } catch (error) {
    session.watcher = undefined;
    console.warn('[EasyView_Md] 文件监听不可用:', error);
    return false;
  }
}

const reloadTimers = new Map<string, NodeJS.Timeout>();
async function reloadIfChanged(session: DocumentSession): Promise<void> {
  if (!session.filePath) return;
  const previous = reloadTimers.get(session.tabId);
  if (previous) clearTimeout(previous);
  const timer = setTimeout(async () => {
    reloadTimers.delete(session.tabId);
    if (!session.filePath || !documentSessions.has(session.tabId)) return;
    try {
      const stats = await fs.stat(session.filePath);
      if (stats.mtimeMs === session.diskMtimeMs) return;
      if (session.dirty && session.externalConflict?.mtimeMs === stats.mtimeMs) return;
      const raw = await fs.readFile(session.filePath, 'utf8');
      const normalized = normalizeLineEnding(raw);
      if (!session.dirty) {
        session.content = normalized.content;
        session.diskContent = normalized.content;
        session.lineEnding = normalized.lineEnding;
        session.diskMtimeMs = stats.mtimeMs;
        session.externalConflict = null;
        if (activeEditorTab()?.id === session.tabId) {
          documentSession = session;
          sendToWindow('document.changed', currentDocumentResult());
          sendEditorMessage(currentEditorDocumentMessage('documentChanged'));
        }
      } else {
        session.externalConflict = { mtimeMs: stats.mtimeMs, content: normalized.content };
        sendToWindow('document.externalChange', { filePath: session.filePath });
        if (activeEditorTab()?.id === session.tabId) await resolveExternalConflict(session, normalized.content, stats.mtimeMs);
      }
    } catch {
      if (session.dirty) session.externalConflict ??= { mtimeMs: null, content: '' };
      sendToWindow('document.externalChange', { filePath: session.filePath });
    }
  }, 350);
  reloadTimers.set(session.tabId, timer);
}

async function resolveExternalConflict(session: DocumentSession, diskContent = session.externalConflict?.content ?? '', diskMtimeMs = session.externalConflict?.mtimeMs ?? null): Promise<void> {
  if (!session.externalConflict || activeEditorTab()?.id !== session.tabId) return;
  const decision = await dialog.showMessageBox(mainWindow!, {
    type: 'warning',
    buttons: ['取消', '重新加载磁盘版本', '使用当前内容覆盖'],
    defaultId: 0,
    cancelId: 0,
    message: `${session.fileName} 已在外部修改`,
    detail: '请选择保留当前编辑内容、重新加载磁盘版本，或明确覆盖磁盘文件。',
  });
  if (decision.response === 1) {
    session.content = diskContent;
    session.diskContent = diskContent;
    session.diskMtimeMs = diskMtimeMs;
    session.externalConflict = null;
    session.dirty = false;
    tabRegistry.setEditorDirty(session.tabId, false);
    syncTabState();
    notifyActiveDocument('documentChanged');
  } else if (decision.response === 2 && diskMtimeMs !== null) {
    session.diskMtimeMs = diskMtimeMs;
    session.externalConflict = null;
    const result = await saveCurrent(session.content, diskMtimeMs);
    if (!result.ok) {
      session.externalConflict = { mtimeMs: diskMtimeMs, content: diskContent };
      await showOperationError(result);
    }
  }
}

async function loadEditorTab(filePath: string, requestedId?: string, notify = true): Promise<OperationResult<DocumentOpenResult>> {
  if (!isMarkdownPath(filePath)) return failure('INVALID_ARGUMENT', '仅支持 Markdown 文件');
  const resolvedPath = path.resolve(filePath);
  const existing = tabRegistry.snapshot().tabs.find((tab) => tab.kind === 'editor' && filePathKey(tab.filePath) === filePathKey(resolvedPath));
  if (existing?.kind === 'editor') {
    tabRegistry.activate(existing.id);
    activateEditorSession(existing.id);
    if (notify) {
      syncTabState();
      notifyActiveDocument('init');
    }
    return success(currentDocumentResult());
  }
  try {
    const [raw, stats] = await Promise.all([fs.readFile(resolvedPath, 'utf8'), fs.stat(resolvedPath)]);
    if (!stats.isFile()) return failure('INVALID_ARGUMENT', '只能打开普通 Markdown 文件');
    const normalized = normalizeLineEnding(raw);
    const tab = tabRegistry.openEditor(resolvedPath, path.basename(resolvedPath), requestedId);
    const session: DocumentSession = {
      tabId: tab.id,
      filePath: resolvedPath,
      fileName: path.basename(resolvedPath),
      content: normalized.content,
      diskContent: normalized.content,
      lineEnding: normalized.lineEnding,
      diskMtimeMs: stats.mtimeMs,
      dirty: false,
      externalConflict: null,
    };
    documentSessions.set(tab.id, session);
    documentSession = session;
    await watchDocumentSession(session);
    getAppStateStore().rememberRecentFile(resolvedPath);
    if (notify) {
      syncTabState();
      notifyActiveDocument('init');
    }
    return success(currentDocumentResult());
  } catch (error) {
    return failure('UNKNOWN', error instanceof Error ? error.message : '无法读取文件');
  }
}

async function resolveWorkspaceFilePath(relativePath: string): Promise<string> {
  const rootPath = workspaceRoot();
  if (!rootPath) throw new PreviewSessionError('invalid', '请先打开工作区');
  const root = await fs.realpath(rootPath);
  const targetPath = workspaceCore.resolveAbsolutePath(relativePath);
  const entry = await fs.lstat(targetPath);
  if (!entry.isFile() || entry.isSymbolicLink()) throw new PreviewSessionError('permission', '只能访问工作区内的普通文件');
  const realPath = await fs.realpath(targetPath);
  const relative = path.relative(root, realPath);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new PreviewSessionError('permission', '路径不能超出工作区根目录');
  }
  return realPath;
}

async function registerPreviewTab(relativePath: string, requestedId?: string, notify = true): Promise<DesktopTabSnapshot> {
  const rootPath = workspaceRoot();
  if (!rootPath) throw new PreviewSessionError('invalid', '请先打开工作区');
  const descriptor = await previewSessions.open(rootPath, relativePath);
  previewSessions.close(descriptor.sessionId);
  tabRegistry.openPreview(relativePath, descriptor.fileName, descriptor.route, requestedId);
  return notify ? syncTabState() : tabSnapshot();
}

async function openWorkspaceEntryTab(relativePath: string): Promise<OperationResult<DesktopTabSnapshot>> {
  const rootPath = workspaceRoot();
  if (!rootPath) return failure('INVALID_ARGUMENT', '请先打开工作区');
  try {
    const targetPath = await resolveWorkspaceFilePath(relativePath);
    if (isMarkdownPath(targetPath)) {
      const result = await loadEditorTab(targetPath);
      return result.ok ? success(tabSnapshot()) : result;
    }
    return success(await registerPreviewTab(relativePath));
  } catch (error) {
    return previewFailure(error);
  }
}

async function activateTab(tabId: string): Promise<OperationResult<DesktopTabSnapshot>> {
  const tab = tabRegistry.activate(tabId);
  if (!tab) return failure('NOT_FOUND', '标签页不存在');
  if (tab.kind === 'editor') {
    const session = activateEditorSession(tab.id);
    if (!session) return failure('NOT_FOUND', 'Markdown 会话不存在');
  }
  syncTabState();
  if (tab.kind === 'editor') {
    notifyActiveDocument('init');
    if (documentSession.externalConflict) void resolveExternalConflict(documentSession);
  }
  return success(tabSnapshot());
}

async function readDocument(filePath: string): Promise<OperationResult<DocumentOpenResult>> {
  return loadEditorTab(filePath);
}

async function chooseAndReadDocument(): Promise<OperationResult<DocumentOpenResult | null>> {
  const chosen = await dialog.showOpenDialog(mainWindow!, {
    properties: ['openFile'],
    filters: [{ name: 'Markdown', extensions: ['md', 'markdown', 'mdx'] }],
  });
  if (chosen.canceled || !chosen.filePaths[0]) return success(null);
  return readDocument(chosen.filePaths[0]);
}

async function writeDocument(
  filePath: string,
  content: string,
  lineEnding: '\n' | '\r\n',
): Promise<OperationResult<SaveDocumentResult>> {
  const targetContent = withLineEnding(content, lineEnding);
  try {
    await stopWatcher(documentSession);
    await writeFileAtomically(filePath, targetContent);
    const stats = await fs.stat(filePath);
    documentSession.filePath = filePath;
    documentSession.fileName = path.basename(filePath);
    documentSession.content = content;
    documentSession.diskContent = content;
    documentSession.diskMtimeMs = stats.mtimeMs;
    documentSession.externalConflict = null;
    documentSession.dirty = false;
    await watchDocumentSession(documentSession);
    if (documentSession.tabId) {
      tabRegistry.renameEditor(documentSession.tabId, filePath, documentSession.fileName);
      tabRegistry.setEditorDirty(documentSession.tabId, false);
    }
    syncTabState();
    if (activeEditorTab()?.id === documentSession.tabId) sendToWindow('document.changed', currentDocumentResult());
    return success({ filePath, fileName: documentSession.fileName, mtimeMs: stats.mtimeMs });
  } catch (error) {
    await watchDocumentSession(documentSession);
    return failure('UNKNOWN', error instanceof Error ? error.message : '无法保存文件');
  }
}

async function saveAsCurrentInternal(
  content: string,
  suggestedFileName: string,
  lineEnding: '\n' | '\r\n',
): Promise<OperationResult<SaveDocumentResult | null>> {
  const chosen = await dialog.showSaveDialog(mainWindow!, {
    defaultPath: markdownFileName(suggestedFileName) ?? 'Untitled.md',
    filters: [{ name: 'Markdown', extensions: ['md', 'markdown', 'mdx'] }],
  });
  if (chosen.canceled || !chosen.filePath) return success(null);
  if (!isMarkdownPath(chosen.filePath)) {
    return failure('INVALID_ARGUMENT', '保存目标必须是 Markdown 文件');
  }
  const duplicate = tabRegistry.snapshot().tabs.find((tab) =>
    tab.kind === 'editor'
    && tab.id !== documentSession.tabId
    && filePathKey(tab.filePath) === filePathKey(chosen.filePath!),
  );
  if (duplicate) return failure('CONFLICT', '该 Markdown 文件已在另一个标签中打开');
  documentSession.lineEnding = lineEnding;
  return writeDocument(chosen.filePath, content, lineEnding);
}

async function saveAsCurrent(
  content: string,
  suggestedFileName: string,
  lineEnding: '\n' | '\r\n',
): Promise<OperationResult<SaveDocumentResult | null>> {
  return enqueueSave(() => saveAsCurrentInternal(content, suggestedFileName, lineEnding));
}

async function saveCurrentInternal(
  content: string,
  expectedMtimeMs: number | null,
): Promise<OperationResult<SaveDocumentResult | null>> {
  if (!documentSession.filePath) {
    return saveAsCurrentInternal(content, documentSession.fileName, documentSession.lineEnding);
  }
  if (documentSession.externalConflict) {
    return failure('CONFLICT', '文件已在外部修改，请重新加载文件后再保存');
  }
  try {
    const stats = await fs.stat(documentSession.filePath);
    const baselineMtimeMs = documentSession.diskMtimeMs;
    if (baselineMtimeMs !== null && Math.abs(stats.mtimeMs - baselineMtimeMs) > 1) {
      documentSession.externalConflict ??= {
        mtimeMs: stats.mtimeMs,
        content: '',
      };
      return failure('CONFLICT', '文件已被其他程序修改，请先处理磁盘版本');
    }
    if (expectedMtimeMs !== null && Math.abs(stats.mtimeMs - expectedMtimeMs) > 1) {
      return failure('CONFLICT', '文件已被其他程序修改，请先处理磁盘版本');
    }
    return writeDocument(documentSession.filePath, content, documentSession.lineEnding);
  } catch (error) {
    return failure('UNKNOWN', error instanceof Error ? error.message : '无法保存文件');
  }
}

async function saveCurrent(
  content: string,
  expectedMtimeMs: number | null,
): Promise<OperationResult<SaveDocumentResult | null>> {
  return enqueueSave(() => saveCurrentInternal(content, expectedMtimeMs));
}

async function renameCurrent(value: unknown): Promise<OperationResult<SaveDocumentResult>> {
  if (!documentSession.filePath) return failure('NOT_FOUND', '当前没有已打开的文件');
  const fileName = markdownFileName(value);
  if (!fileName) return failure('INVALID_ARGUMENT', '文件名必须是合法的 Markdown 文件名');
  const targetPath = path.join(path.dirname(documentSession.filePath), fileName);
  if (targetPath === documentSession.filePath) {
    return success({
      filePath: documentSession.filePath,
      fileName,
      mtimeMs: documentSession.diskMtimeMs ?? 0,
    });
  }
  try {
    await stopWatcher(documentSession);
    await fs.link(documentSession.filePath, targetPath);
    try {
      await fs.unlink(documentSession.filePath);
    } catch (error) {
      await fs.unlink(targetPath).catch(() => undefined);
      throw error;
    }
    documentSession.filePath = targetPath;
    documentSession.fileName = fileName;
    const stats = await fs.stat(targetPath);
    documentSession.diskMtimeMs = stats.mtimeMs;
    await watchDocumentSession(documentSession);
    if (documentSession.tabId) tabRegistry.renameEditor(documentSession.tabId, targetPath, fileName);
    syncTabState();
    return success({ filePath: targetPath, fileName, mtimeMs: stats.mtimeMs });
  } catch (error) {
    await watchDocumentSession(documentSession);
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'EEXIST') return failure('CONFLICT', '目标文件已存在');
    return failure('UNKNOWN', error instanceof Error ? error.message : '无法重命名文件');
  }
}

async function confirmCloseSession(session: DocumentSession): Promise<boolean> {
  if (!session.dirty) return true;
  const response = await dialog.showMessageBox(mainWindow!, {
    type: 'warning',
    buttons: ['保存', '不保存', '取消'],
    defaultId: 0,
    cancelId: 2,
    message: `${session.fileName} 尚未保存`,
    detail: '关闭标签前是否保存当前修改？',
  });
  if (response.response === 2) return false;
  if (response.response === 1) {
    session.content = session.diskContent;
    session.dirty = false;
    session.externalConflict = null;
    tabRegistry.setEditorDirty(session.tabId, false);
    syncTabState();
    if (activeEditorTab()?.id === session.tabId) notifyActiveDocument('init');
    return true;
  }
  const previous = documentSession;
  documentSession = session;
  const result = await saveCurrent(session.content, session.diskMtimeMs);
  if (activeEditorTab()?.id !== session.tabId) documentSession = previous;
  if (!result.ok) {
    await dialog.showMessageBox(mainWindow!, { type: 'error', message: result.message });
    return false;
  }
  return result.value !== null;
}

async function confirmCloseAll(): Promise<boolean> {
  const dirtySessions = [...documentSessions.values()].filter((session) => session.dirty);
  if (dirtySessions.length === 0) return true;
  const response = await dialog.showMessageBox(mainWindow!, {
    type: 'warning',
    buttons: ['全部保存', '全部不保存', '取消'],
    defaultId: 0,
    cancelId: 2,
    message: `有 ${dirtySessions.length} 个文档尚未保存`,
    detail: '关闭前是否保存全部修改？',
  });
  if (response.response === 2) return false;
  if (response.response === 1) {
    for (const session of dirtySessions) {
      session.content = session.diskContent;
      session.dirty = false;
      session.externalConflict = null;
      tabRegistry.setEditorDirty(session.tabId, false);
    }
    syncTabState();
    return true;
  }
  const originalActiveId = tabSnapshot().activeTabId;
  for (const session of dirtySessions) {
    tabRegistry.activate(session.tabId);
    documentSession = session;
    const result = await saveCurrent(session.content, session.diskMtimeMs);
    if (!result.ok || !result.value) {
      syncTabState();
      notifyActiveDocument('init');
      await showOperationError(result.ok ? failure('CANCELLED', '保存已取消') : result);
      return false;
    }
  }
  if (originalActiveId && tabRegistry.get(originalActiveId)) {
    tabRegistry.activate(originalActiveId);
    const active = tabRegistry.active();
    if (active?.kind === 'editor') activateEditorSession(active.id);
  }
  syncTabState();
  return true;
}

async function closeTab(tabId: string): Promise<OperationResult<DesktopTabSnapshot | null>> {
  const tab = tabRegistry.get(tabId);
  if (!tab) return failure('NOT_FOUND', '标签页不存在');
  if (tab.kind === 'editor') {
    const session = documentSessions.get(tab.id);
    if (session && !(await confirmCloseSession(session))) return success(null);
    if (session) await stopWatcher(session);
    documentSessions.delete(tab.id);
  }
  tabRegistry.close(tabId);
  const active = tabRegistry.active();
  if (active?.kind === 'editor') activateEditorSession(active.id);
  else if (!active) documentSession = createEmptySession();
  syncTabState();
  if (active?.kind === 'editor') notifyActiveDocument('init');
  return success(tabSnapshot());
}

function documentDirectory(): string {
  return documentSession.filePath
    ? path.dirname(documentSession.filePath)
    : app.getPath('documents');
}

function suggestedExportName(extension: string): string {
  return `${fileNameWithoutExtension(documentSession.fileName)}.${extension}`;
}

async function chooseExportPath(extension: string, label: string): Promise<string | null> {
  const chosen = await dialog.showSaveDialog(mainWindow!, {
    defaultPath: path.join(documentDirectory(), suggestedExportName(extension)),
    filters: [{ name: label, extensions: [extension] }],
  });
  return chosen.canceled || !chosen.filePath ? null : chosen.filePath;
}

async function showExportCompleted(filePath: string): Promise<void> {
  const result = await dialog.showMessageBox(mainWindow!, {
    type: 'info',
    buttons: ['确定', '在文件夹中显示'],
    defaultId: 0,
    message: `已导出 ${path.basename(filePath)}`,
  });
  if (result.response === 1) shell.showItemInFolder(filePath);
}

function requireDocumentPath(): string | null {
  if (documentSession.filePath) return documentSession.filePath;
  void dialog.showMessageBox(mainWindow!, {
    type: 'info',
    message: '请先保存 Markdown 文档，再添加本地图片。',
  });
  return null;
}

function imageErrorMessage(error: unknown): string {
  if (error instanceof ImageServiceError) return error.message;
  return error instanceof Error ? error.message : '图片处理失败';
}

async function showOperationError(result: OperationResult<unknown>): Promise<void> {
  if (result.ok) return;
  await dialog.showMessageBox(mainWindow!, {
    type: 'error',
    message: result.message,
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
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

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isOptionalString(value: unknown): boolean {
  return value === undefined || typeof value === 'string';
}

function isOptionalPosition(value: unknown): boolean {
  return value === undefined || (typeof value === 'number' && Number.isInteger(value) && value >= 0);
}

function isRecordArray(value: unknown): value is Record<string, unknown>[] {
  return Array.isArray(value) && value.every(isRecord);
}

function validateEditorMessage(value: EditorToHostMessage): string | null {
  const message = value as unknown as Record<string, unknown>;
  switch (value.type) {
    case 'ready':
    case 'save':
    case 'openTerminal':
    case 'stageFile':
    case 'generateCommitMessage':
    case 'terminalClose':
      return null;
    case 'webviewRuntimeError':
      return isNonEmptyString(message.source) && typeof message.message === 'string' && isOptionalString(message.stack) ? null : '运行时错误消息字段无效';
    case 'openWithDebugLog':
      return isNonEmptyString(message.stage) && (message.meta === undefined || isRecord(message.meta)) ? null : '调试日志字段无效';
    case 'rowResizeDebug':
      return isNonEmptyString(message.stage) && isRecord(message.data) ? null : '表格调试字段无效';
    case 'getImageBase64':
      return isNonEmptyString(message.requestId) && typeof message.originalSrc === 'string' ? null : '图片读取请求字段无效';
    case 'pickImage':
      return isOptionalPosition(message.pos) ? null : '图片位置无效';
    case 'dropImages':
      return Array.isArray(message.paths) && message.paths.every((item) => typeof item === 'string') && isOptionalPosition(message.pos) ? null : '拖入图片字段无效';
    case 'pasteImage':
      return typeof message.dataUrl === 'string' && isOptionalString(message.mimeType) && isOptionalString(message.name) && isOptionalPosition(message.pos) ? null : '粘贴图片字段无效';
    case 'exportPdfBase64':
      return isNonEmptyString(message.data) ? null : 'PDF 导出数据无效';
    case 'exportHtml':
      return typeof message.html === 'string' && isRecordArray(message.images) && message.images.every((image) => typeof image.originalSrc === 'string' && isNonEmptyString(image.exportFilename) && typeof image.isExternal === 'boolean') ? null : 'HTML 导出字段无效';
    case 'exportXlsx':
      return isRecord(message.payload) && isNonEmptyString(message.fileName) ? null : 'XLSX 导出字段无效';
    case 'exportDocx':
      return typeof message.title === 'string' && typeof message.markdown === 'string' && isRecordArray(message.mermaidImages) && isRecordArray(message.asciiImages) && [...message.mermaidImages, ...message.asciiImages].every((image) => typeof image.source === 'string' && isNonEmptyString(image.pngBase64) && typeof image.width === 'number' && Number.isFinite(image.width) && image.width > 0 && typeof image.height === 'number' && Number.isFinite(image.height) && image.height > 0) ? null : 'DOCX 导出字段无效';
    case 'terminalInput':
      return typeof message.data === 'string' ? null : 'terminalInput.data 必须是字符串';
    case 'terminalResize':
      return Number.isInteger(message.cols) && (message.cols as number) > 0 && Number.isInteger(message.rows) && (message.rows as number) > 0 ? null : '终端尺寸无效';
    case 'aiChat.getSettings':
    case 'aiChat.abort':
      return isNonEmptyString(message.requestId) ? null : 'AI 对话请求 ID 无效';
    case 'aiChat.pickImage':
      return null;
    case 'aiChat.saveApiKey':
      return isNonEmptyString(message.requestId) && typeof message.apiKey === 'string' ? null : 'AI API Key 字段无效';
    case 'aiChat.saveSettings':
      return isNonEmptyString(message.requestId) && isRecord(message.settings) ? null : 'AI 设置字段无效';
    case 'aiChat.send':
      return isNonEmptyString(message.requestId)
        && (message.mode === 'chat' || message.mode === 'agent')
        && isNonEmptyString(message.model)
        && typeof message.userMessage === 'string'
        && Array.isArray(message.attachments)
        && Array.isArray(message.history)
        && (message.documentContent === undefined || typeof message.documentContent === 'string')
        && (message.documentFileName === undefined || typeof message.documentFileName === 'string')
        ? null
        : 'AI 对话请求字段无效';
    default:
      return null;
  }
}

async function handleEditorMessage(message: EditorToHostMessage): Promise<void> {
  const validationError = validateEditorMessage(message);
  if (validationError) {
    await showOperationError(failure('INVALID_ARGUMENT', validationError));
    return;
  }
  if (
    !activeEditorTab()
    && !message.type.startsWith('aiChat.')
    && message.type !== 'ready'
    && message.type !== 'edit'
    && message.type !== 'webviewRuntimeError'
    && message.type !== 'openWithDebugLog'
    && message.type !== 'rowResizeDebug'
  ) return;
  switch (message.type) {
    case 'aiChat.send':
    case 'aiChat.abort':
    case 'aiChat.getSettings':
    case 'aiChat.saveSettings':
    case 'aiChat.saveApiKey':
    case 'aiChat.pickImage':
      await getAiChatHost().handle(message);
      return;
    case 'ready':
      sendEditorMessage(currentEditorDocumentMessage('init'));
      return;
    case 'edit': {
      const wasDirty = documentSession.dirty;
      documentSession.content = message.content;
      documentSession.dirty = message.content !== documentSession.diskContent;
      if (documentSession.tabId) tabRegistry.setEditorDirty(documentSession.tabId, documentSession.dirty);
      if (wasDirty !== documentSession.dirty) syncTabState();
      return;
    }
    case 'save': {
      const result = await saveCurrent(documentSession.content, documentSession.diskMtimeMs);
      await showOperationError(result);
      if (result.ok && result.value) {
        sendEditorMessage({
          type: 'fileRenamed',
          fileName: fileNameWithoutExtension(result.value.fileName),
        });
      }
      return;
    }
    case 'rename': {
      const result = await renameCurrent(message.newName);
      await showOperationError(result);
      if (result.ok) {
        sendEditorMessage({
          type: 'fileRenamed',
          fileName: fileNameWithoutExtension(result.value.fileName),
        });
      }
      return;
    }
    case 'setTableFirstRowStickyDefault':
      tableFirstRowStickyDefault = message.sticky;
      return;
    case 'copyTextToClipboard':
      try {
        clipboard.writeText(message.text);
        sendEditorMessage({
          type: 'clipboardCopyCompleted',
          message: message.successMessage ?? 'Copied',
        });
      } catch (error) {
        sendEditorMessage({
          type: 'clipboardCopyFailed',
          message: error instanceof Error ? error.message : 'Copy failed',
        });
      }
      return;
    case 'openLink': {
      const url = message.href ?? message.url;
      if (isAllowedExternalUrl(url)) await shell.openExternal(url);
      return;
    }
    case 'showInfo':
      await dialog.showMessageBox(mainWindow!, { type: 'info', message: message.text });
      return;
    case 'requestTabCompletion':
      sendEditorMessage({
        type: 'tabCompletionResponse',
        requestId: message.requestId,
        insertText: null,
      });
      return;
    case 'stageFile': {
      try {
        const saveResult = await saveCurrent(documentSession.content, documentSession.diskMtimeMs);
        if (!saveResult.ok) throw new Error(saveResult.message);
        const context = await resolveGitContext();
        await stageGitFile(context.rootPath, context.filePath);
        sendEditorMessage({ type: 'stageFileCompleted', message: `已暂存 ${documentSession.fileName}` });
      } catch (error) {
        sendEditorMessage({
          type: 'stageFileFailed',
          message: error instanceof Error ? error.message : 'Git 暂存失败',
        });
      }
      return;
    }
    case 'generateCommitMessage':
      sendEditorMessage({
        type: 'commitMessageGenerationFailed',
        message: '桌面版尚未配置 AI 提交信息服务。',
      });
      return;
    case 'commitFile': {
      if (typeof message.message !== 'string' || !message.message.trim()) {
        sendEditorMessage({ type: 'commitFileFailed', message: '提交信息不能为空。' });
        return;
      }
      try {
        const saveResult = await saveCurrent(documentSession.content, documentSession.diskMtimeMs);
        if (!saveResult.ok) throw new Error(saveResult.message);
        const context = await resolveGitContext();
        const status = await getFileStatus(context.rootPath, context.filePath);
        if (!status.isModified) throw new Error('当前文件没有可提交的 Git 变更。');
        await commitGitFile(context.rootPath, context.filePath, message.message.trim());
        sendEditorMessage({ type: 'commitFileCompleted', message: `已提交 ${documentSession.fileName}` });
      } catch (error) {
        sendEditorMessage({
          type: 'commitFileFailed',
          message: error instanceof Error ? error.message : 'Git 提交失败',
        });
      }
      return;
    }
    case 'syncFile': {
      if (typeof message.message !== 'string' || !message.message.trim()) {
        sendEditorMessage({ type: 'syncFileFailed', message: '提交信息不能为空。' });
        return;
      }
      try {
        const saveResult = await saveCurrent(documentSession.content, documentSession.diskMtimeMs);
        if (!saveResult.ok) throw new Error(saveResult.message);
        const context = await resolveGitContext();
        const fileStatus = await getFileStatus(context.rootPath, context.filePath);
        if (fileStatus.isModified) {
          await commitGitFile(context.rootPath, context.filePath, message.message.trim());
        }
        const upstream = await getUpstreamStatus(context.rootPath);
        if (!upstream.upstream) throw new Error('当前分支未配置上游远端。');
        if (upstream.ahead <= 0) throw new Error('当前分支没有待推送提交。');
        await pushGitRepository(context.rootPath);
        sendEditorMessage({ type: 'syncFileCompleted', message: `已同步 ${documentSession.fileName}` });
      } catch (error) {
        sendEditorMessage({
          type: 'syncFileFailed',
          message: error instanceof Error ? error.message : 'Git 同步失败',
        });
      }
      return;
    }
    case 'openTerminal': {
      try {
        if (activeTerminalSessionId) getTerminalService().close(activeTerminalSessionId);
        const terminal = getTerminalService().open({ cwd: documentDirectory() });
        activeTerminalSessionId = terminal.sessionId;
        sendEditorMessage({
          type: 'terminalOpened',
          sessionId: terminal.sessionId,
          cwd: terminal.cwd,
          platform: process.platform,
          homeDir: os.homedir(),
        });
      } catch (error) {
        sendEditorMessage({
          type: 'terminalError',
          message: error instanceof Error ? error.message : '终端启动失败',
        });
      }
      return;
    }
    case 'webviewRuntimeError':
      console.error(`[EasyView Renderer] ${message.source}: ${message.message}`, message.stack ?? '');
      return;
    case 'openWithDebugLog':
      console.debug(`[EasyView Renderer] ${message.stage}`, message.meta ?? {});
      return;
    case 'rowResizeDebug':
      console.debug(`[EasyView Table] ${message.stage}`, message.data);
      return;
    case 'getImageBase64': {
      const documentPath = documentSession.filePath;
      if (!documentPath) {
        sendEditorMessage({
          type: 'imageBase64Response',
          requestId: message.requestId,
          base64: null,
        });
        return;
      }
      try {
        const base64 = await readImageAsDataUrl({
          documentPath,
          source: message.originalSrc,
        });
        sendEditorMessage({ type: 'imageBase64Response', requestId: message.requestId, base64 });
      } catch {
        sendEditorMessage({
          type: 'imageBase64Response',
          requestId: message.requestId,
          base64: null,
        });
      }
      return;
    }
    case 'pickImage': {
      const documentPath = requireDocumentPath();
      if (!documentPath) return;
      try {
        const selected = await pickImage({
          documentPath,
          selectPath: async () => {
            const chosen = await dialog.showOpenDialog(mainWindow!, {
              properties: ['openFile'],
              filters: [
                {
                  name: 'Images',
                  extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'svg'],
                },
              ],
            });
            return chosen.canceled ? null : (chosen.filePaths[0] ?? null);
          },
        });
        sendEditorMessage({
          type: 'imageSelected',
          src: selected.dataUrl,
          originalSrc: selected.relativePath,
          pos: message.pos,
        });
      } catch (error) {
        if (!(error instanceof ImageServiceError && error.code === 'IMAGE_SELECTION_CANCELLED')) {
          await dialog.showMessageBox(mainWindow!, { type: 'error', message: imageErrorMessage(error) });
        }
      }
      return;
    }
    case 'dropImages': {
      const documentPath = requireDocumentPath();
      if (!documentPath) return;
      const images = [];
      for (const imagePath of message.paths) {
        try {
          const selected = await pickImage({
            documentPath,
            selectPath: async () => imagePath,
          });
          images.push({ src: selected.dataUrl, originalSrc: selected.relativePath });
        } catch (error) {
          console.warn('[EasyView_Md] Dropped image rejected:', imageErrorMessage(error));
        }
      }
      if (images.length > 0) {
        sendEditorMessage({ type: 'imagesDropped', images, pos: message.pos });
      }
      return;
    }
    case 'pasteImage': {
      const documentPath = requireDocumentPath();
      if (!documentPath) return;
      try {
        const saved = await savePastedImage({
          documentPath,
          dataUrl: message.dataUrl,
          preferredName: message.name,
        });
        const dataUrl = await readImageAsDataUrl({ documentPath, source: saved.relativePath });
        sendEditorMessage({
          type: 'imageSelected',
          src: dataUrl,
          originalSrc: saved.relativePath,
          pos: message.pos,
        });
      } catch (error) {
        await dialog.showMessageBox(mainWindow!, { type: 'error', message: imageErrorMessage(error) });
      }
      return;
    }
    case 'exportHtml': {
      const targetPath = await chooseExportPath('html', 'HTML');
      if (!targetPath) return;
      try {
        const result = await writeHtmlExport({
          targetPath,
          documentDir: documentDirectory(),
          html: message.html,
          images: message.images,
        });
        await showExportCompleted(result.htmlPath);
      } catch (error) {
        await dialog.showMessageBox(mainWindow!, {
          type: 'error',
          message: error instanceof Error ? error.message : 'HTML 导出失败',
        });
      }
      return;
    }
    case 'exportPdfBase64': {
      const targetPath = await chooseExportPath('pdf', 'PDF');
      if (!targetPath) return;
      try {
        await writePdfBase64({ targetPath, data: message.data });
        await showExportCompleted(targetPath);
      } catch (error) {
        await dialog.showMessageBox(mainWindow!, {
          type: 'error',
          message: error instanceof Error ? error.message : 'PDF 导出失败',
        });
      }
      return;
    }
    case 'exportXlsx': {
      const targetPath = await chooseExportPath('xlsx', 'Excel Workbook');
      if (!targetPath) return;
      try {
        const buffer = await buildXlsxBuffer(message.payload);
        await writeFileAtomically(targetPath, buffer);
        await showExportCompleted(targetPath);
      } catch (error) {
        await dialog.showMessageBox(mainWindow!, {
          type: 'error',
          message: error instanceof Error ? error.message : 'XLSX 导出失败',
        });
      }
      return;
    }
    case 'exportDocx': {
      const targetPath = await chooseExportPath('docx', 'Word Document');
      if (!targetPath) return;
      try {
        await writeDocxExport({
          targetPath,
          markdown: message.markdown,
          title: message.title || fileNameWithoutExtension(documentSession.fileName),
          docDir: documentDirectory(),
          mermaidImages: message.mermaidImages,
          asciiImages: message.asciiImages,
        });
        await showExportCompleted(targetPath);
      } catch (error) {
        await dialog.showMessageBox(mainWindow!, {
          type: 'error',
          message: error instanceof Error ? error.message : 'DOCX 导出失败',
        });
      }
      return;
    }
    case 'terminalInput':
      if (activeTerminalSessionId && typeof message.data === 'string') {
        getTerminalService().write(activeTerminalSessionId, message.data);
      }
      return;
    case 'terminalResize':
      if (
        activeTerminalSessionId
        && Number.isInteger(message.cols)
        && Number.isInteger(message.rows)
      ) {
        getTerminalService().resize(activeTerminalSessionId, message.cols, message.rows);
      }
      return;
    case 'terminalClose':
      if (activeTerminalSessionId) {
        getTerminalService().close(activeTerminalSessionId);
        activeTerminalSessionId = undefined;
      }
      return;

  }
}


function workspaceEntryAbsolutePath(relativePath: string): string {
  return workspaceCore.resolveAbsolutePath(relativePath);
}

async function openWorkspacePreview(relativePath: string): Promise<OperationResult<DesktopTabSnapshot>> {
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

async function closeTabIds(tabIds: string[]): Promise<boolean> {
  for (const tabId of tabIds) {
    const tab = tabRegistry.get(tabId);
    if (!tab) continue;
    if (tab.kind === 'editor') {
      const session = documentSessions.get(tab.id);
      if (session && !(await confirmCloseSession(session))) return false;
      if (session) await stopWatcher(session);
      documentSessions.delete(tab.id);
    }
  }
  for (const tabId of tabIds) tabRegistry.close(tabId);
  const active = tabRegistry.active();
  if (active?.kind === 'editor') activateEditorSession(active.id);
  else if (!active) documentSession = createEmptySession();
  syncTabState();
  if (active?.kind === 'editor') notifyActiveDocument('init');
  return true;
}

async function closeOtherTabs(tabId: string): Promise<OperationResult<DesktopTabSnapshot>> {
  const group = tabRegistry.groupForTab(tabId);
  if (!group) return failure('NOT_FOUND', '标签页不存在');
  if (!(await closeTabIds(group.tabs.filter((tab) => tab.id !== tabId).map((tab) => tab.id)))) return failure('CANCELLED', '已取消关闭其他标签');
  tabRegistry.activate(tabId);
  syncTabState();
  const active = tabRegistry.active();
  if (active?.kind === 'editor') notifyActiveDocument('init');
  return success(tabSnapshot());
}

async function closeGroupTabs(tabId: string): Promise<OperationResult<DesktopTabSnapshot>> {
  const group = tabRegistry.groupForTab(tabId);
  if (!group) return failure('NOT_FOUND', '标签页不存在');
  if (!(await closeTabIds(group.tabs.map((tab) => tab.id)))) return failure('CANCELLED', '已取消关闭全部标签');
  return success(tabSnapshot());
}

function tabResourcePaths(tab: DesktopTab): { absolutePath: string; relativePath: string } | null {
  if (tab.kind === 'editor') {
    const rootPath = workspaceRoot();
    const relativePath = rootPath ? path.relative(rootPath, tab.filePath).split(path.sep).join('/') : tab.fileName;
    return { absolutePath: tab.filePath, relativePath };
  }
  if (!workspaceRoot()) return null;
  const paths = workspaceCore.resourcePaths(tab.relativePath);
  return { absolutePath: paths.absolutePath, relativePath: paths.relativePath };
}

async function executeTabContextCommand(tabId: string, command: DesktopTabContextCommand): Promise<OperationResult<DesktopTabSnapshot>> {
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
    return failure('DEPENDENCY_MISSING', 'editor-core 仍使用全局 DOM 标识，Desktop 已提供 Editor Group/布局模型与 IPC 集成点，但在支持多实例挂载前不会创建伪分屏。');
  }
  return failure('DEPENDENCY_MISSING', '多窗口数据模型和 webContents 路由已建立；编辑器运行时仍为单实例，暂不能安全移动活动编辑器到新窗口。');
}

async function renameWorkspaceEntry(request: WorkspaceRenameRequest): Promise<OperationResult<WorkspaceEntry>> {
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
    if (activeEditorTab()) notifyActiveDocument('documentChanged');
    sendToWindow('workspace.changed', [workspaceCore.parentRelativePath(request.relativePath), workspaceCore.parentRelativePath(entry.relativePath)]);
    return success(entry);
  } catch (error) {
    return failure('INVALID_ARGUMENT', desktopWorkspaceErrorMessage(error));
  }
}

async function deleteWorkspaceEntry(request: WorkspaceDeleteRequest, owner = mainWindow ?? null): Promise<OperationResult<boolean>> {
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

function copyWorkspaceEntryToClipboard(relativePath: string): OperationResult<boolean> {
  const rootPath = workspaceRoot();
  if (!rootPath) return failure('INVALID_ARGUMENT', '尚未打开工作区');
  try {
    const paths = workspaceCore.resourcePaths(relativePath);
    workspaceFileClipboard = { relativePath: paths.relativePath };
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

async function pasteWorkspaceClipboard(request: WorkspacePasteRequest, owner = mainWindow ?? null): Promise<OperationResult<WorkspaceEntry>> {
  const rootPath = workspaceRoot();
  if (!rootPath) return failure('INVALID_ARGUMENT', '尚未打开工作区');
  if (!workspaceFileClipboard) return failure('INVALID_ARGUMENT', '剪贴板中没有可粘贴的文件');
  try {
    const targetParentRelativePath = await resolvePasteTargetDirectory(request.targetRelativePath);
    const entry = await workspaceCore.copy({
      sourceRelativePath: workspaceFileClipboard.relativePath,
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

function showOpenWithPicker(relativePath: string, owner: Electron.BrowserWindow | null): void {
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

function showWorkspaceContextMenu(sender: Electron.WebContents, relativePath: string, kind: WorkspaceEntry['kind']): void {
  const isFile = kind === 'file' || kind === 'symlink';
  const canPaste = workspaceFileClipboard !== null;
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

function showTabContextMenu(sender: Electron.WebContents, tabId: string): void {
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

function registerIpc(): void {
  ipcMain.handle('document.open', async (event) => {
    const denied = assertTrustedRenderer(event);
    if (denied) return denied;
    return chooseAndReadDocument();
  });

  ipcMain.handle(
    'document.save',
    async (event, request: { content: unknown; expectedMtimeMs: unknown }) => {
      const denied = assertTrustedRenderer(event);
      if (denied) return denied;
      if (typeof request?.content !== 'string') {
        return failure('INVALID_ARGUMENT', 'content 必须是字符串');
      }
      if (request.expectedMtimeMs !== null && typeof request.expectedMtimeMs !== 'number') {
        return failure('INVALID_ARGUMENT', 'expectedMtimeMs 无效');
      }
      return saveCurrent(request.content, request.expectedMtimeMs);
    },
  );

  ipcMain.handle(
    'document.saveAs',
    async (
      event,
      request: { content: unknown; suggestedFileName: unknown; lineEnding: unknown },
    ) => {
      const denied = assertTrustedRenderer(event);
      if (denied) return denied;
      if (typeof request?.content !== 'string' || typeof request.suggestedFileName !== 'string') {
        return failure('INVALID_ARGUMENT', '保存参数无效');
      }
      if (request.lineEnding !== '\n' && request.lineEnding !== '\r\n') {
        return failure('INVALID_ARGUMENT', '换行符无效');
      }
      return saveAsCurrent(request.content, request.suggestedFileName, request.lineEnding);
    },
  );

  ipcMain.handle('document.rename', async (event, request: { fileName: unknown }) => {
    const denied = assertTrustedRenderer(event);
    if (denied) return denied;
    return renameCurrent(request?.fileName);
  });

  ipcMain.handle('window.requestClose', async (event) => {
    const denied = assertTrustedRenderer(event);
    if (denied) return denied;
    return success(await confirmCloseAll());
  });

  ipcMain.handle('external.open', async (event, value: unknown) => {
    const denied = assertTrustedRenderer(event);
    if (denied) return denied;
    if (!isAllowedExternalUrl(value)) {
      return failure('INVALID_ARGUMENT', '只允许打开 http/https 链接');
    }
    await shell.openExternal(value);
    return success(true);
  });

  ipcMain.handle('clipboard.writeText', async (event, value: unknown) => {
    const denied = assertTrustedRenderer(event);
    if (denied) return denied;
    if (typeof value !== 'string') return failure('INVALID_ARGUMENT', '剪贴板内容无效');
    clipboard.writeText(value);
    return success(true);
  });

  ipcMain.handle('app.getTheme', (event) => {
    const denied = assertTrustedRenderer(event);
    if (denied) return denied;
    return success(nativeTheme.shouldUseDarkColors ? 'dark' : 'light');
  });

  ipcMain.handle('tabs.getState', (event) => {
    const denied = assertTrustedRenderer(event);
    if (denied) return denied;
    return success(tabSnapshot());
  });

  ipcMain.handle('tabs.openWorkspaceEntry', async (event, relativePath: unknown) => {
    const denied = assertTrustedRenderer(event);
    if (denied) return denied;
    if (typeof relativePath !== 'string') return failure('INVALID_ARGUMENT', '工作区路径无效');
    return openWorkspaceEntryTab(relativePath);
  });

  ipcMain.handle('tabs.activate', async (event, tabId: unknown) => {
    const denied = assertTrustedRenderer(event);
    if (denied) return denied;
    if (typeof tabId !== 'string') return failure('INVALID_ARGUMENT', '标签标识无效');
    return activateTab(tabId);
  });

  ipcMain.handle('tabs.close', async (event, tabId: unknown) => {
    const denied = assertTrustedRenderer(event);
    if (denied) return denied;
    if (typeof tabId !== 'string') return failure('INVALID_ARGUMENT', '标签标识无效');
    return closeTab(tabId);
  });

  ipcMain.handle('tabs.closeOthers', async (event, tabId: unknown) => {
    const denied = assertTrustedRenderer(event);
    if (denied) return denied;
    if (typeof tabId !== 'string') return failure('INVALID_ARGUMENT', '标签标识无效');
    return closeOtherTabs(tabId);
  });

  ipcMain.handle('tabs.closeAll', async (event, tabId: unknown) => {
    const denied = assertTrustedRenderer(event);
    if (denied) return denied;
    if (typeof tabId !== 'string') return failure('INVALID_ARGUMENT', '标签标识无效');
    return closeGroupTabs(tabId);
  });

  ipcMain.handle('tabs.openPreview', async (event, relativePath: unknown) => {
    const denied = assertTrustedRenderer(event);
    if (denied) return denied;
    if (typeof relativePath !== 'string') return failure('INVALID_ARGUMENT', '工作区路径无效');
    return openWorkspacePreview(relativePath);
  });

  ipcMain.handle('tabs.showContextMenu', (event, tabId: unknown) => {
    const denied = assertTrustedRenderer(event);
    if (denied) return denied;
    if (typeof tabId !== 'string' || !tabRegistry.get(tabId)) return failure('NOT_FOUND', '标签页不存在');
    showTabContextMenu(event.sender, tabId);
    return success(true);
  });

  ipcMain.handle('tabs.executeContextCommand', async (event, request: unknown) => {
    const denied = assertTrustedRenderer(event);
    if (denied) return denied;
    if (!isRecord(request) || typeof request.tabId !== 'string' || typeof request.command !== 'string') return failure('INVALID_ARGUMENT', '标签菜单命令无效');
    return executeTabContextCommand(request.tabId, request.command as DesktopTabContextCommand);
  });

  ipcMain.handle('preview.open', async (event, request: unknown) => {
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

  ipcMain.handle('preview.close', async (event, sessionId: unknown) => {
    const denied = assertTrustedRenderer(event);
    if (denied) return denied;
    if (typeof sessionId !== 'string') return failure('INVALID_ARGUMENT', '预览会话标识无效');
    try {
      return success(previewSessions.close(sessionId));
    } catch (error) {
      return previewFailure(error);
    }
  });

  ipcMain.handle('preview.readText', async (event, sessionId: unknown) => {
    const denied = assertTrustedRenderer(event);
    if (denied) return denied;
    if (typeof sessionId !== 'string') return failure('INVALID_ARGUMENT', '预览会话标识无效');
    try {
      return success(await previewSessions.readText(sessionId));
    } catch (error) {
      return previewFailure(error);
    }
  });

  ipcMain.handle('preview.writeBytes', async (event, request: unknown) => {
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

  ipcMain.handle('preview.http.send', async (event, request: unknown) => {
    const denied = assertTrustedRenderer(event);
    if (denied) return denied;
    if (!isRecord(request) || typeof request.url !== 'string') return failure('INVALID_ARGUMENT', 'HTTP 请求无效');
    try {
      return success(await requestHttpPreview(request as unknown as import('../../../contracts').HttpPreviewRequest));
    } catch (error) {
      return previewFailure(error);
    }
  });

  ipcMain.handle('preview.java.decompile', async (event, sessionId: unknown) => {
    const denied = assertTrustedRenderer(event);
    if (denied) return denied;
    if (typeof sessionId !== 'string') return failure('INVALID_ARGUMENT', '预览会话标识无效');
    try {
      return success(await javaDecompileService.decompile(sessionId));
    } catch (error) {
      return previewFailure(error);
    }
  });

  ipcMain.handle('system.openWithDefaultApp', async (event, relativePath: unknown) => {
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

  ipcMain.handle('system.revealInFolder', async (event, relativePath: unknown) => {
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

  ipcMain.handle('archive.list', async (event, request: unknown) => {
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

  ipcMain.handle('archive.readEntry', async (event, request: unknown) => {
    const denied = assertTrustedRenderer(event);
    if (denied) return denied;
    if (!isRecord(request) || typeof request.sessionId !== 'string' || typeof request.entryPath !== 'string') return failure('INVALID_ARGUMENT', '压缩包条目请求无效');
    if (request.password !== undefined) return failure('DEPENDENCY_MISSING', '加密压缩包暂不支持预览');
    try {
      return success(await archivePreviewService.openEntry(request.sessionId, request.entryPath));
    } catch (error) {
      return previewFailure(error);
    }
  });

  ipcMain.handle('archive.exportEntry', async (event, request: unknown) => {
    const denied = assertTrustedRenderer(event);
    if (denied) return denied;
    if (!isRecord(request) || typeof request.sessionId !== 'string' || typeof request.entryPath !== 'string') return failure('INVALID_ARGUMENT', '压缩包条目请求无效');
    if (request.password !== undefined) return failure('DEPENDENCY_MISSING', '加密压缩包暂不支持导出');
    try {
      const selected = await dialog.showSaveDialog(mainWindow!, { title: '导出压缩包条目', defaultPath: path.basename(request.entryPath) });
      if (selected.canceled || !selected.filePath) return failure('CANCELLED', '已取消导出压缩包条目');
      await archivePreviewService.exportEntry(request.sessionId, request.entryPath, selected.filePath);
      return success(true);
    } catch (error) {
      return previewFailure(error);
    }
  });

  ipcMain.handle('workspace.openFolder', async (event) => {
    const denied = assertTrustedRenderer(event);
    if (denied) return denied;
    return openWorkspaceFolder();
  });

  ipcMain.handle('workspace.getState', (event) => {
    const denied = assertTrustedRenderer(event);
    if (denied) return denied;
    return success(getWorkspaceState());
  });

  ipcMain.handle('workspace.setState', (event, value: unknown) => {
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

  ipcMain.handle('workspace.readDirectory', async (event, relativePath: unknown) => {
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

  ipcMain.handle('workspace.create', async (event, request: WorkspaceCreateRequest) => {
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

  ipcMain.handle('workspace.rename', async (event, request: WorkspaceRenameRequest) => {
    const denied = assertTrustedRenderer(event);
    if (denied) return denied;
    if (!request || typeof request.relativePath !== 'string' || typeof request.newName !== 'string') return failure('INVALID_ARGUMENT', '重命名参数无效');
    return renameWorkspaceEntry(request);
  });

  ipcMain.handle('workspace.delete', async (event, request: WorkspaceDeleteRequest) => {
    const denied = assertTrustedRenderer(event);
    if (denied) return denied;
    if (!request || typeof request.relativePath !== 'string') return failure('INVALID_ARGUMENT', '删除参数无效');
    return deleteWorkspaceEntry(request, rendererWindow(event.sender));
  });

  ipcMain.handle('workspace.copyClipboard', (event, relativePath: unknown) => {
    const denied = assertTrustedRenderer(event);
    if (denied) return denied;
    if (typeof relativePath !== 'string') return failure('INVALID_ARGUMENT', '复制路径无效');
    return copyWorkspaceEntryToClipboard(relativePath);
  });

  ipcMain.handle('workspace.pasteClipboard', async (event, request: WorkspacePasteRequest) => {
    const denied = assertTrustedRenderer(event);
    if (denied) return denied;
    if (!request || typeof request.targetRelativePath !== 'string') return failure('INVALID_ARGUMENT', '粘贴目标无效');
    return pasteWorkspaceClipboard(request, rendererWindow(event.sender));
  });

  ipcMain.handle('workspace.getResourcePaths', (event, relativePath: unknown) => {
    const denied = assertTrustedRenderer(event);
    if (denied) return denied;
    const rootPath = workspaceRoot();
    if (!rootPath || typeof relativePath !== 'string') return failure('INVALID_ARGUMENT', '工作区路径无效');
    try { return success(workspaceCore.resourcePaths(relativePath)); }
    catch (error) { return failure('INVALID_ARGUMENT', desktopWorkspaceErrorMessage(error)); }
  });

  ipcMain.handle('workspace.showContextMenu', (event, request: unknown) => {
    const denied = assertTrustedRenderer(event);
    if (denied) return denied;
    if (!isRecord(request) || typeof request.relativePath !== 'string' || !['file', 'directory', 'symlink'].includes(String(request.kind))) return failure('INVALID_ARGUMENT', '目录菜单参数无效');
    showWorkspaceContextMenu(event.sender, request.relativePath, request.kind as WorkspaceEntry['kind']);
    return success(true);
  });

  ipcMain.handle('workspace.openEntry', async (event, relativePath: unknown) => {
    const denied = assertTrustedRenderer(event);
    if (denied) return denied;
    if (typeof relativePath !== 'string') return failure('INVALID_ARGUMENT', '工作区路径无效');
    const result = await openWorkspaceEntryTab(relativePath);
    return result.ok ? success(true) : result;
  });

  ipcMain.on('desktop.menuState', (event, value: unknown) => {
    if (!trustedRenderer(event) || !isRecord(value)) return;
    if (
      typeof value.sourceMode !== 'boolean'
      || typeof value.outlineVisible !== 'boolean'
      || typeof value.fullWidth !== 'boolean'
      || typeof value.tableWrap !== 'boolean'
      || typeof value.hasActiveDocument !== 'boolean'
    ) return;
    desktopMenuState = {
      sourceMode: value.sourceMode,
      outlineVisible: value.outlineVisible,
      fullWidth: value.fullWidth,
      tableWrap: value.tableWrap,
      hasActiveDocument: value.hasActiveDocument,
    } as DesktopMenuState;
    createMenu();
  });

  ipcMain.on('editor.message', (event, value: unknown) => {
    if (!trustedRenderer(event) || !isEditorToHostMessage(value)) return;
    void handleEditorMessage(value).catch((error) => {
      console.error('[EasyView_Md] 处理编辑器消息失败:', error);
      void showOperationError(failure('UNKNOWN', error instanceof Error ? error.message : '桌面操作失败'));
    });
  });
}

async function importDocument(extensions: string[], title: string): Promise<void> {
  const selected = await dialog.showOpenDialog(mainWindow!, {
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
      await dialog.showMessageBox(mainWindow!, {
        type: 'error',
        message: error instanceof Error ? error.message : '文档转换失败',
      });
      return;
    }
    const confirmation = await dialog.showMessageBox(mainWindow!, {
      type: 'warning',
      buttons: ['替换', '取消'],
      defaultId: 0,
      cancelId: 1,
      message: '目标 Markdown 已存在',
      detail: '是否替换现有 Markdown 和对应资源？',
    });
    if (confirmation.response !== 0) return;
    try {
      converted = await convertDocumentToMarkdown({ sourcePath, overwrite: true });
    } catch (retryError) {
      await dialog.showMessageBox(mainWindow!, {
        type: 'error',
        message: retryError instanceof Error ? retryError.message : '文档转换失败',
      });
      return;
    }
  }

  const result = await readDocument(converted.outputPath);
  await showOperationError(result);
}

async function requestOpenDocument(filePath?: string): Promise<void> {
  const result = filePath ? await readDocument(filePath) : await chooseAndReadDocument();
  await showOperationError(result);
}

async function openFromMenu(): Promise<void> {
  await requestOpenDocument();
}

async function saveFromMenu(saveAs: boolean): Promise<void> {
  const result = saveAs
    ? await saveAsCurrent(
      documentSession.content,
      documentSession.fileName,
      documentSession.lineEnding,
    )
    : await saveCurrent(documentSession.content, documentSession.diskMtimeMs);
  await showOperationError(result);
  if (result.ok && result.value) {
    sendEditorMessage({
      type: 'fileRenamed',
      fileName: fileNameWithoutExtension(result.value.fileName),
    });
  }
}

function restartApp(): void {
  // Bypass dirty-doc close confirmation; exit tears down windows immediately.
  isClosing = true;
  app.relaunch();
  app.exit(0);
}

const RESTART_FLAG = '--easyview-restart';

function argvRequestsRestart(argv: string[]): boolean {
  return argv.includes(RESTART_FLAG);
}

/** Register the same Restart action on each OS shell entry point Electron exposes. */
function syncShellRestartMenu(): void {
  if (process.platform === 'darwin' && app.dock) {
    app.dock.setMenu(Menu.buildFromTemplate([
      { label: '重启', click: () => restartApp() },
    ]));
    return;
  }

  if (process.platform === 'win32') {
    app.setUserTasks([
      {
        program: process.execPath,
        arguments: RESTART_FLAG,
        iconPath: process.execPath,
        iconIndex: 0,
        title: '重启',
        description: '重启 EasyView_Md',
      },
    ]);
  }
}

function createMenu(): void {
  const command = (label: string, value: DesktopMenuCommand, options: Partial<Electron.MenuItemConstructorOptions> = {}): Electron.MenuItemConstructorOptions => ({
    label,
    enabled: desktopMenuState.hasActiveDocument,
    click: () => publishMenuCommand(value),
    ...options,
  });
  const recentFiles = getAppStateStore().getRecentFiles();
  const template: Electron.MenuItemConstructorOptions[] = [
    {
      label: '文件',
      submenu: [
        {
          label: '打开文件…',
          accelerator: 'CmdOrCtrl+O',
          click: () => void openFromMenu(),
        },
        { label: '打开文件夹…', accelerator: 'CmdOrCtrl+Shift+O', click: () => void openWorkspaceFolder() },
        {
          label: '最近打开',
          submenu: recentFiles.length > 0
            ? recentFiles.map((filePath) => ({ label: path.basename(filePath), sublabel: filePath, click: () => void requestOpenDocument(filePath) }))
            : [{ label: '暂无最近文件', enabled: false }],
        },
        { type: 'separator' },
        { label: '重命名…', enabled: desktopMenuState.hasActiveDocument, click: () => publishMenuCommand('rename') },
        {
          label: '导入 Word…',
          click: () => void importDocument(['docx', 'doc'], 'Word Document'),
        },
        {
          label: '导入 PDF…',
          click: () => void importDocument(['pdf'], 'PDF Document'),
        },
        {
          label: '保存',
          accelerator: 'CmdOrCtrl+S',
          enabled: desktopMenuState.hasActiveDocument,
          click: () => void saveFromMenu(false),
        },
        {
          label: '另存为…',
          accelerator: 'CmdOrCtrl+Shift+S',
          enabled: desktopMenuState.hasActiveDocument,
          click: () => void saveFromMenu(true),
        },
        { type: 'separator' },
        {
          label: '重启',
          click: () => restartApp(),
        },
        { role: 'quit' },
      ],
    },
    {
      label: '编辑',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
        { type: 'separator' },
        command('查找和替换…', 'findReplace', { accelerator: 'CmdOrCtrl+H' }),
      ],
    },
    {
      label: '视图',
      submenu: [
        { label: '目录树', type: 'checkbox', checked: getWorkspaceState().explorerVisible, click: () => publishMenuCommand('toggleExplorer') },
        command('文档目录', 'toggleOutline', { type: 'checkbox', checked: desktopMenuState.outlineVisible }),
        command('源码模式', 'toggleSourceMode', { type: 'checkbox', checked: desktopMenuState.sourceMode }),
        command('全宽', 'toggleFullWidth', { type: 'checkbox', checked: desktopMenuState.fullWidth }),
        command('表格换行', 'toggleTableWrap', { type: 'checkbox', checked: desktopMenuState.tableWrap }),
        { type: 'separator' },
        {
          label: '放大',
          accelerator: 'CmdOrCtrl+=',
          registerAccelerator: true,
          click: () => zoomWindowBy(1),
        },
        {
          label: '放大',
          accelerator: 'CmdOrCtrl+Plus',
          visible: false,
          acceleratorWorksWhenHidden: true,
          click: () => zoomWindowBy(1),
        },
        {
          label: '缩小',
          accelerator: 'CmdOrCtrl+-',
          click: () => zoomWindowBy(-1),
        },
        {
          label: '重置缩放',
          accelerator: 'CmdOrCtrl+0',
          click: () => resetWindowZoom(),
        },
        { type: 'separator' },
        command('回到顶部', 'scrollTop'),
        command('回到底部', 'scrollBottom'),
      ],
    },
    { label: '文档', submenu: [command('全部展开/折叠标题', 'toggleHeadingCollapse'), command('历史记录', 'toggleHistory'), command('便签', 'toggleStickyNote')] },
    { label: '导出', submenu: [command('HTML（明亮）', 'exportHtmlLight'), command('HTML（暗色）', 'exportHtmlDark'), command('PDF（明亮）', 'exportPdfLight'), command('PDF（暗色）', 'exportPdfDark'), command('DOCX', 'exportDocx')] },
    { label: 'Git', submenu: [command('暂存', 'stageFile'), command('提交', 'openCommit'), command('同步', 'syncGit')] },
    { label: '工具', submenu: [command('AI 对话', 'toggleAiChat', { accelerator: 'Alt+I', enabled: true }), command('内置终端', 'openTerminal')] },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
  syncShellRestartMenu();
}

function createWindow(): void {
  const bounds = getAppStateStore().getWindowBounds();
  mainWindow = new BrowserWindow({
    width: bounds?.width ?? 1440,
    height: bounds?.height ?? 960,
    ...(bounds?.x !== undefined && bounds?.y !== undefined ? { x: bounds.x, y: bounds.y } : {}),
    minWidth: 960,
    minHeight: 640,
    show: false,
    ...(process.platform === 'darwin' ? { titleBarStyle: 'hiddenInset' as const } : {}),
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#1e1e1e' : '#ffffff',
    webPreferences: {
      preload: path.join(__dirname, '../preload/preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      devTools: !app.isPackaged,
    },
  });

  const webContentsId = mainWindow.webContents.id;
  windowSessions.register(mainWindow.webContents, tabRegistry);
  applyWindowZoomLevel(getAppStateStore().getZoomLevel());
  updateWindowTitle();
  for (const session of documentSessions.values()) void watchDocumentSession(session);
  mainWindow.once('ready-to-show', () => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.show();
  });
  const rememberWindowBounds = () => {
    if (!mainWindow || mainWindow.isDestroyed() || mainWindow.isMinimized() || mainWindow.isMaximized()) return;
    getAppStateStore().setWindowBounds(mainWindow.getBounds());
  };
  mainWindow.on('resize', rememberWindowBounds);
  mainWindow.on('move', rememberWindowBounds);
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (isAllowedExternalUrl(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!isCurrentRendererUrl(url)) event.preventDefault();
  });
  mainWindow.on('close', (event) => {
    if (isClosing || ![...documentSessions.values()].some((session) => session.dirty)) return;
    event.preventDefault();
    void confirmCloseAll().then((canClose) => {
      if (canClose) {
        isClosing = true;
        if (mainWindow && !mainWindow.isDestroyed()) mainWindow.close();
      }
    });
  });
  mainWindow.on('closed', () => {
    // Window native handle is already gone; never touch mainWindow.webContents here.
    windowSessions.unregister({ id: webContentsId });
    void Promise.all([...documentSessions.values()].map((session) => stopWatcher(session)));
    terminalService?.disposeAll();
    terminalService = undefined;
    previewSessions.closeAll();
    activeTerminalSessionId = undefined;
    mainWindow = undefined;
    isClosing = false;
  });
  void mainWindow.loadFile(resolveRendererPath());
}

function findMarkdownArgument(argv: string[]): string | undefined {
  return argv.find((argument) => path.isAbsolute(argument) && isMarkdownPath(argument));
}

const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', (_event, argv) => {
    if (argvRequestsRestart(argv)) {
      restartApp();
      return;
    }
    const filePath = findMarkdownArgument(argv);
    if (filePath) {
      void requestOpenDocument(filePath).catch((error) => {
        console.error('[EasyView_Md] 打开第二实例文档失败:', error);
      });
    }
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.on('open-file', (event, filePath) => {
    event.preventDefault();
    if (!isMarkdownPath(filePath)) return;
    if (!mainWindow) {
      pendingOpenPath = filePath;
      return;
    }
    void requestOpenDocument(filePath).catch((error) => {
      console.error('[EasyView_Md] 打开文件失败:', error);
    });
  });

  app.whenReady().then(async () => {
    pendingOpenPath ??= findMarkdownArgument(process.argv);
    appStateStore = createAppStateStore(app.getPath('userData'), {
      onSaveError: (error) => {
        console.warn('[EasyView_Md] 应用状态保存失败:', error);
      },
    });
    await appStateStore.load();
    aiChatHost = createDesktopAiChatHost();
    registerPreviewProtocol(protocol, previewSessions);
    registerIpc();
    await restoreWorkspace();
    createMenu();
    if (pendingOpenPath) {
      const filePath = pendingOpenPath;
      pendingOpenPath = undefined;
      const result = await readDocument(filePath);
      if (!result.ok) console.error('[EasyView_Md] 启动文件打开失败:', result.message);
    }
    createWindow();
    nativeTheme.on('updated', () => {
      sendToWindow(
        'app.themeChanged',
        nativeTheme.shouldUseDarkColors ? 'dark' : 'light',
      );
    });
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
