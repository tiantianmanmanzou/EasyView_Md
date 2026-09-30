import {
  BrowserWindow,
  clipboard,
  dialog,
  shell,
} from 'electron';
import {
  operationFailure,
  operationSuccess,
} from '@easyview/contracts';
import { TerminalService } from '@easyview/node-runtime';
import type { AppStateStore } from '../document/appState';
import { DesktopWindowRegistry } from '../document/DesktopWindowRegistry';
import { WorkspaceWatcher } from '../workspace/WorkspaceWatcher';
import { HttpPreviewError } from '../preview/HttpPreviewService';
import { PreviewSessionError } from '../preview/PreviewSession';
import {
  filePathKey,
  type DocumentSession,
} from '../document/DocumentSessionService';
import { hashContent } from '@easyview/editor-sync';
import type {
  HostToEditorMessage,
  OperationErrorCode,
  OperationResult,
} from '@easyview/contracts';
import type {
  DesktopMenuState,
  DesktopTab,
  DesktopTabSnapshot,
  DesktopWorkspaceState,
  DocumentOpenResult,
} from '../../../contracts';
import type { AiChatHost } from '@easyview/node-runtime';
import {
  createDesktopWindowContext,
  currentDesktopWindowContext,
  runInDesktopWindowContext,
  type DesktopWindowContext,
} from './windowContext';

const defaultContext = createDesktopWindowContext('main-window', async (absolutePath) => {
  await shell.trashItem(absolutePath);
});
let activeContext = defaultContext;

function contextProxy<T extends object>(resolve: (context: DesktopWindowContext) => T): T {
  return new Proxy({} as T, {
    get(_target, property) {
      const value = Reflect.get(resolve(currentDesktopWindowContext(defaultContext)), property);
      return typeof value === 'function'
        ? value.bind(resolve(currentDesktopWindowContext(defaultContext)))
        : value;
    },
  });
}

export const tabRegistry = contextProxy((context) => context.tabs);
export const documentSessions = contextProxy((context) => context.documentSessions);
export const workspaceCore = contextProxy((context) => context.workspaceCore);
export const windowSessions = new DesktopWindowRegistry();
export const previewSessions = contextProxy((context) => context.previewSessions);
export const archivePreviewService = contextProxy((context) => context.archivePreviewService);
export const javaDecompileService = contextProxy((context) => context.javaDecompileService);
export const previewProtocolSessions = {
  async resolveContent(contentId: string) {
    for (const session of windowSessions.values()) {
      try { return await session.context.previewSessions.resolveContent(contentId); } catch { /* try next window */ }
    }
    throw new Error('Preview session not found');
  },
  async resolveRelatedContent(contentId: string, assetPath: string) {
    for (const session of windowSessions.values()) {
      try { return await session.context.previewSessions.resolveRelatedContent(contentId, assetPath); } catch { /* try next window */ }
    }
    throw new Error('Preview session not found');
  },
};

export let tableFirstRowStickyDefault = false;

export const hostHooks = {
  createMenu(): void {
    throw new Error('createMenu 尚未绑定');
  },
};

export function getWindowContext(): DesktopWindowContext {
  return currentDesktopWindowContext(activeContext);
}

export function setActiveWindowContext(context: DesktopWindowContext): void {
  activeContext = context;
}

export function getWindowContextForSender(sender: Electron.WebContents): DesktopWindowContext | null {
  return windowSessions.fromWebContents(sender)?.context ?? null;
}

export function runInWindowContext<T>(context: DesktopWindowContext, operation: () => T): T {
  return runInDesktopWindowContext(context, operation);
}

export function setMainWindow(window: BrowserWindow | undefined): void {
  getWindowContext().window = window;
}

export function setClosing(value: boolean): void {
  getWindowContext().isClosing = value;
}

export function setPendingOpenPath(value: string | undefined): void {
  getWindowContext().pendingOpenPath = value;
}

export function getPendingOpenPath(): string | undefined { return getWindowContext().pendingOpenPath; }
export function getMainWindow(): BrowserWindow | undefined { return getWindowContext().window; }
export function isWindowClosing(): boolean { return getWindowContext().isClosing; }
export function getTerminalService(): TerminalService | undefined { return getWindowContext().terminalService; }
export function getActiveTerminalSessionId(): string | undefined { return getWindowContext().activeTerminalSessionId; }
export function getWorkspaceFileClipboard(): { relativePath: string } | null { return getWindowContext().workspaceFileClipboard; }
export function getWorkspaceWatcher(): WorkspaceWatcher | undefined { return getWindowContext().workspaceWatcher; }
export function getAiChatHost(): AiChatHost | undefined { return getWindowContext().aiChatHost; }
export function getDesktopMenuState(): DesktopMenuState { return getWindowContext().desktopMenuState; }

export function setTableFirstRowStickyDefault(value: boolean): void {
  tableFirstRowStickyDefault = value;
}

export function setActiveTerminalSessionId(value: string | undefined): void {
  getWindowContext().activeTerminalSessionId = value;
}

export function setTerminalService(value: TerminalService | undefined): void {
  getWindowContext().terminalService = value;
}

export function setAppStateStore(value: AppStateStore): void {
  getWindowContext().appStateStore = value;
}

export function setAiChatHost(value: AiChatHost | undefined): void {
  getWindowContext().aiChatHost = value;
}

export function setDesktopMenuState(value: DesktopMenuState): void {
  getWindowContext().desktopMenuState = value;
}

export function setWorkspaceFileClipboard(value: { relativePath: string } | null): void {
  getWindowContext().workspaceFileClipboard = value;
}

export function setWorkspaceWatcher(value: WorkspaceWatcher | undefined): void {
  getWindowContext().workspaceWatcher = value;
}

export function getAppStateStore(): AppStateStore {
  const store = getWindowContext().appStateStore;
  if (!store) throw new Error('应用状态尚未初始化');
  return store;
}

export function success<T>(value: T): OperationResult<T> {
  return operationSuccess(value);
}

export function failure(code: OperationErrorCode, message: string): OperationResult<never> {
  return operationFailure(code, message);
}

export function previewFailure(error: unknown): OperationResult<never> {
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

export function trustedRenderer(event: { sender: Electron.WebContents }): boolean {
  return windowSessions.fromWebContents(event.sender) !== null;
}

export function rendererWindow(sender?: Electron.WebContents): BrowserWindow | null {
  if (sender) return BrowserWindow.fromWebContents(sender);
  return getMainWindow() ?? null;
}

export function showMessageBoxFor(owner: BrowserWindow | null, options: Electron.MessageBoxOptions): Promise<Electron.MessageBoxReturnValue> {
  return owner ? dialog.showMessageBox(owner, options) : dialog.showMessageBox(options);
}

export function sendToWindow(channel: string, ...args: unknown[]): boolean {
  const target = getMainWindow();
  if (!target || target.isDestroyed() || target.webContents.isDestroyed()) return false;
  target.webContents.send(channel, ...args);
  return true;
}

export function sendEditorMessage(message: HostToEditorMessage): void {
  sendToWindow('editor.message', message);
}

export function assertTrustedRenderer(event: { sender: Electron.WebContents }): OperationResult<never> | null {
  return trustedRenderer(event) ? null : failure('UNKNOWN', '拒绝非当前窗口的请求');
}

export function isMarkdownPath(filePath: string): boolean {
  return /\.(md|markdown|mdx)$/i.test(filePath);
}

export function markdownFileName(value: unknown, session?: DocumentSession): string | null {
  if (typeof value !== 'string') return null;
  let fileName = value.trim();
  if (!fileName || fileName === '.' || fileName === '..' || /[\\/]/.test(fileName)) return null;
  if (!isMarkdownPath(fileName)) {
    const extension = session?.filePath ? pathExtname(session.filePath) : '.md';
    fileName += extension || '.md';
  }
  return isMarkdownPath(fileName) ? fileName : null;
}

function pathExtname(filePath: string): string {
  const slash = Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\'));
  const base = slash >= 0 ? filePath.slice(slash + 1) : filePath;
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(dot) : '';
}

export function fileNameWithoutExtension(fileName: string): string {
  return fileName.replace(/\.(md|markdown|mdx)$/i, '');
}

export function documentResult(session: DocumentSession): DocumentOpenResult {
  return {
    filePath: session.filePath ?? '',
    fileName: session.fileName,
    content: session.content,
    lineEnding: session.lineEnding,
    mtimeMs: session.diskMtimeMs ?? 0,
  };
}

export function getWorkspaceState(): DesktopWorkspaceState {
  return getAppStateStore().getWorkspace();
}

export function setWorkspaceState(patch: Partial<DesktopWorkspaceState>): DesktopWorkspaceState {
  const next = { ...getWorkspaceState(), ...patch };
  getAppStateStore().setWorkspace(next);
  return next;
}

export function workspaceRoot(): string | null {
  return getWorkspaceState().rootPath;
}

export function tabSnapshot(): DesktopTabSnapshot {
  return tabRegistry.snapshot();
}

export function persistTabs(): void {
  const snapshot = tabSnapshot();
  setWorkspaceState({
    openTabs: tabRegistry.persisted(),
    activeTabId: snapshot.activeTabId,
    editorGroups: tabRegistry.persistedGroups(),
    activeEditorGroupId: snapshot.activeGroupId,
    editorGroupLayout: tabRegistry.persistedLayout(),
  });
}

export function publishTabs(): DesktopTabSnapshot {
  const snapshot = tabSnapshot();
  sendToWindow('tabs.changed', snapshot);
  return snapshot;
}

export function updateWindowTitle(): void {
  const active = tabRegistry.active();
  if (!active) {
    getMainWindow()?.setTitle('EasyView_Md');
    return;
  }
  const dirtyMarker = active.kind === 'editor' && active.dirty ? ' •' : '';
  getMainWindow()?.setTitle(`${active.fileName}${dirtyMarker} — EasyView_Md`);
}

export function syncTabState(): DesktopTabSnapshot {
  persistTabs();
  updateWindowTitle();
  const active = tabRegistry.active();
  setDesktopMenuState({ ...getDesktopMenuState(), hasActiveDocument: active?.kind === 'editor' });
  hostHooks.createMenu();
  return publishTabs();
}

export function activeEditorTab(): Extract<DesktopTab, { kind: 'editor' }> | null {
  const active = tabRegistry.active();
  return active?.kind === 'editor' ? active : null;
}

export function activateEditorSession(tabId: string): DocumentSession | null {
  return documentSessions.get(tabId) ?? null;
}

export function allOpenTabs(): DesktopTab[] {
  return tabSnapshot().groups.flatMap((group) => group.tabs);
}

export function sessionIsActive(session: DocumentSession): boolean {
  const active = activeEditorTab();
  return Boolean(active && documentSessions.get(active.id) === session);
}

export function activeSession(): DocumentSession | undefined {
  const tab = activeEditorTab();
  return tab ? documentSessions.get(tab.id) : undefined;
}

export function requireActiveSession(): OperationResult<DocumentSession> {
  return documentSessions.require(activeEditorTab()?.id);
}

export function editorDocumentMessage(
  session: DocumentSession,
  reason: 'initial' | 'visible' | 'resync' | 'reload' = 'visible',
): HostToEditorMessage {
  return {
    type: 'documentSnapshot',
    documentId: session.documentId,
    revision: session.sync.snapshot.revision,
    content: session.content,
    contentHash: hashContent(session.content),
    reason,
    filename: fileNameWithoutExtension(session.fileName),
    filePath: session.filePath ?? '',
    fullWidth: true,
    tocVisible: getWorkspaceState().outlineVisible,
    tableWrap: false,
    imagePathMap: {},
    tableFirstRowStickyDefault,
    initialCursorLine: 0,
    initialCursorCharacter: 0,
    initialTotalLines: Math.max(1, session.content.split('\n').length),
    uiState: session.uiState,
  };
}

export function currentEditorDocumentMessage(reason: 'initial' | 'visible' | 'resync' | 'reload' = 'visible'): HostToEditorMessage | null {
  const session = activeSession();
  return session ? editorDocumentMessage(session, reason) : null;
}

export function editorActivateMessage(session: DocumentSession): HostToEditorMessage {
  return {
    type: 'documentActivate',
    documentId: session.documentId,
    revision: session.sync.snapshot.revision,
    contentHash: hashContent(session.content),
    reason: 'visible',
  };
}

const gitChangeTasks = new Map<string, number>();

export async function notifyActiveGitChanges(session: DocumentSession): Promise<void> {
  const taskId = (gitChangeTasks.get(session.documentId) ?? 0) + 1;
  gitChangeTasks.set(session.documentId, taskId);
  const revision = session.sync.snapshot.revision;
  const contentHash = hashContent(session.content);
  const result = await documentSessions.getChangeSnapshot(session.tabId);
  if (!result.ok || !sessionIsActive(session) || gitChangeTasks.get(session.documentId) !== taskId
    || session.sync.snapshot.revision !== revision || hashContent(session.content) !== contentHash
    || result.value.currentContentHash !== contentHash) return;
  sendEditorMessage({
    type: 'gitStatusChanged',
    documentId: session.documentId,
    revision,
    lineRanges: result.value.lineRanges,
    snapshot: {
      indexObjectId: result.value.indexObjectId,
      baseContent: result.value.baseContent,
      currentContentHash: result.value.currentContentHash,
      isUntracked: result.value.isUntracked,
    },
  });
}

export function notifyActiveDocument(reason: 'initial' | 'visible' | 'resync' | 'reload' = 'visible'): void {
  const active = activeEditorTab();
  const session = active ? activateEditorSession(active.id) : null;
  if (!session) return;
  sendToWindow('document.changed', documentResult(session));
  sendEditorMessage(reason === 'visible' ? editorActivateMessage(session) : editorDocumentMessage(session, reason));
  void notifyActiveGitChanges(session);
}

export function publishMenuCommand(command: import('../../../contracts').DesktopMenuCommand): void {
  sendToWindow('desktop.menuCommand', command);
}

export function isAllowedExternalUrl(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  try {
    const protocol = new URL(value).protocol;
    return protocol === 'https:' || protocol === 'http:';
  } catch {
    return false;
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

export function sameFile(left: string, right: string): boolean {
  return filePathKey(left) === filePathKey(right);
}

export { clipboard, dialog, shell, filePathKey };
