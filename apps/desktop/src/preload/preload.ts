import { contextBridge, ipcRenderer, webFrame } from 'electron';
import type {
  EditorHostSubscription,
  HostToEditorMessage,
  OperationResult,
  EditorToHostMessage,
  WorkspaceSearchResult,
} from '@easyview/contracts';
import type {
  DesktopMenuCommand,
  DesktopMenuState,
  DesktopThemeMode,
  DocumentOpenResult,
  SaveDocumentResult,
  WorkspaceCreateRequest,
  WorkspaceDeleteRequest,
  WorkspaceMoveRequest,
  WorkspacePasteRequest,
  WorkspaceRenameRequest,
  WorkspaceReorderRequest,
  WorkspaceContextCommand,
  DesktopTabContextCommand,
  DesktopWorkspaceState,
  RecentFolder,
  WorkspaceEntry,
  WorkspaceTreeSortMode,
  HttpPreviewRequest,
} from '../contracts';
import type { EasyViewDesktopApi } from './desktopApi';
import { DEFAULT_LOCALE, normalizeLocale, setLocale, type Locale } from '@easyview/contracts/i18n';
import { DESKTOP_LOCALE_ARGUMENT_PREFIX, DESKTOP_OPENED_FILE_AT_LAUNCH_ARGUMENT } from '../contracts/desktop';
import { tPreload } from './preload.i18n';

function assertString(value: unknown, name: string): asserts value is string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`${name} must be a non-empty string`);
  }
}

function assertRelativePath(value: unknown): asserts value is string {
  if (typeof value !== 'string' || value.includes('\0')) throw new TypeError(tPreload('invalidArgument', { name: 'relativePath' }));
}

const locale: Locale = normalizeLocale(
  process.argv.find((argument) => argument.startsWith(DESKTOP_LOCALE_ARGUMENT_PREFIX))?.slice(DESKTOP_LOCALE_ARGUMENT_PREFIX.length),
) ?? DEFAULT_LOCALE;
setLocale(locale);

function subscription(unsubscribe: () => void): EditorHostSubscription {
  return { unsubscribe };
}

const api: EasyViewDesktopApi = {
  versionGuard: {
    onDiscovery: listener => { const handler = (_event: Electron.IpcRendererEvent, repositories: import('@easyview/contracts').GuardRepository[], warnings: string[]) => listener(repositories, warnings); ipcRenderer.on('versionGuard.discovery', handler); return { dispose: () => ipcRenderer.removeListener('versionGuard.discovery', handler) }; },
    request: request => ipcRenderer.invoke('versionGuard.request', request),
    subscribe: listener => { const handler = (_event: Electron.IpcRendererEvent, paths: string[] | null) => listener(paths); ipcRenderer.on('versionGuard.changed', handler); return { dispose: () => ipcRenderer.removeListener('versionGuard.changed', handler) }; },
  },
  timeline: {
    post: (message) => ipcRenderer.send('timeline.message', message),
    subscribe: (listener) => { const handle = (_event: Electron.IpcRendererEvent, message: import('@easyview/contracts').TimelineResultMessage) => listener(message); ipcRenderer.on('timeline.message', handle); return { dispose: () => ipcRenderer.removeListener('timeline.message', handle) }; },
    diagnostics: () => ipcRenderer.invoke('timeline.diagnostics'),
    comparison: (tabId) => ipcRenderer.invoke('timeline.comparison', tabId),
    getSettings: () => ipcRenderer.invoke('timeline.settings.get'),
    setSettings: (settings) => ipcRenderer.invoke('timeline.settings.set', settings),
  },

  document: {
    open: () => ipcRenderer.invoke('document.open') as Promise<OperationResult<DocumentOpenResult | null>>,
    save: (content, sessionId) => {
      assertString(content, 'content');
      assertString(sessionId, 'sessionId');
      return ipcRenderer.invoke('document.save', { content, sessionId }) as Promise<OperationResult<SaveDocumentResult | null>>;
    },
    saveAs: (content, suggestedFileName, lineEnding, sessionId) => {
      assertString(content, 'content');
      assertString(suggestedFileName, 'suggestedFileName');
      assertString(sessionId, 'sessionId');
      if (lineEnding !== '\n' && lineEnding !== '\r\n') throw new TypeError('invalid lineEnding');
      return ipcRenderer.invoke('document.saveAs', { content, suggestedFileName, lineEnding, sessionId }) as Promise<OperationResult<SaveDocumentResult | null>>;
    },
    rename: (fileName, sessionId) => {
      assertString(fileName, 'fileName');
      assertString(sessionId, 'sessionId');
      return ipcRenderer.invoke('document.rename', { fileName, sessionId }) as Promise<OperationResult<SaveDocumentResult>>;
    },
    onChanged: (listener) => {
      const handler = (_event: Electron.IpcRendererEvent, payload: DocumentOpenResult) => listener(payload);
      ipcRenderer.on('document.changed', handler);
      return subscription(() => ipcRenderer.removeListener('document.changed', handler));
    },
  },
  window: {
    requestClose: () => ipcRenderer.invoke('window.requestClose') as Promise<OperationResult<boolean>>,
    titleBarDoubleClick: () => ipcRenderer.invoke('window.titleBarDoubleClick') as Promise<OperationResult<boolean>>,
    popupAppMenu: (x, y) => {
      const zoom = webFrame.getZoomFactor();
      return ipcRenderer.invoke('window.popupAppMenu', x * zoom, y * zoom) as Promise<OperationResult<boolean>>;
    },
    setTitleBarOverlay: (color, symbolColor) => {
      assertString(color, 'color');
      assertString(symbolColor, 'symbolColor');
      return ipcRenderer.invoke('window.setTitleBarOverlay', color, symbolColor) as Promise<OperationResult<boolean>>;
    },
  },
  external: {
    open: (url) => {
      assertString(url, 'url');
      return ipcRenderer.invoke('external.open', url) as Promise<OperationResult<boolean>>;
    },
  },
  clipboard: {
    writeText: (text) => {
      assertString(text, 'text');
      return ipcRenderer.invoke('clipboard.writeText', text) as Promise<OperationResult<boolean>>;
    },
  },
  app: {
    getTheme: () => ipcRenderer.invoke('app.getTheme') as Promise<OperationResult<DesktopThemeMode>>,
    newWindow: () => ipcRenderer.invoke('app.newWindow') as Promise<OperationResult<boolean>>,
    getZoomFactor: () => webFrame.getZoomFactor(),
    locale,
    openedFileAtLaunch: process.argv.includes(DESKTOP_OPENED_FILE_AT_LAUNCH_ARGUMENT),
    onThemeChanged: (listener) => {
      const handler = (_event: Electron.IpcRendererEvent, theme: DesktopThemeMode) => listener(theme);
      ipcRenderer.on('app.themeChanged', handler);
      return subscription(() => ipcRenderer.removeListener('app.themeChanged', handler));
    },
    onRevealDocument: (listener) => {
      const handler = () => listener();
      ipcRenderer.on('app.revealDocument', handler);
      return subscription(() => ipcRenderer.removeListener('app.revealDocument', handler));
    },
  },
  workspace: {
    openFolder: () => ipcRenderer.invoke('workspace.openFolder'),
    openRecentFolder: (folderPath: string) => {
      assertString(folderPath, 'folderPath');
      return ipcRenderer.invoke('workspace.openRecentFolder', folderPath);
    },
    getRecentFolders: () => ipcRenderer.invoke('workspace.getRecentFolders') as Promise<OperationResult<RecentFolder[]>>,
    removeRecentFolder: (folderPath: string) => {
      assertString(folderPath, 'folderPath');
      return ipcRenderer.invoke('workspace.removeRecentFolder', folderPath) as Promise<OperationResult<boolean>>;
    },
    onRootChanged: (listener) => {
      const handler = (_event: Electron.IpcRendererEvent, state: DesktopWorkspaceState) => listener(state);
      ipcRenderer.on('workspace.rootChanged', handler);
      return subscription(() => ipcRenderer.removeListener('workspace.rootChanged', handler));
    },
    getState: () => ipcRenderer.invoke('workspace.getState'),
    setState: (state: DesktopWorkspaceState) => ipcRenderer.invoke('workspace.setState', state),
    readDirectory: (relativePath: string) => {
      assertRelativePath(relativePath);
      return ipcRenderer.invoke('workspace.readDirectory', relativePath) as Promise<OperationResult<WorkspaceEntry[]>>;
    },
    search: (query: string) => {
      if (typeof query !== 'string') throw new TypeError(tPreload('invalidArgument', { name: 'query' }));
      return ipcRenderer.invoke('workspace.search', query) as Promise<OperationResult<WorkspaceSearchResult>>;
    },
    getSortMode: () => ipcRenderer.invoke('workspace.getSortMode') as Promise<OperationResult<WorkspaceTreeSortMode>>,
    setSortMode: (sortMode: WorkspaceTreeSortMode) => {
      if (sortMode !== 'name' && sortMode !== 'created' && sortMode !== 'custom') {
        throw new TypeError(tPreload('invalidSortMode'));
      }
      return ipcRenderer.invoke('workspace.setSortMode', sortMode) as Promise<OperationResult<WorkspaceTreeSortMode>>;
    },
    getEntrySize: (relativePath: string) => {
      assertRelativePath(relativePath);
      return ipcRenderer.invoke('workspace.getEntrySize', relativePath) as Promise<OperationResult<number>>;
    },
    getShowSizeHover: () => ipcRenderer.invoke('workspace.getShowSizeHover') as Promise<OperationResult<boolean>>,
    setShowSizeHover: (showSizeHover: boolean) => {
      if (typeof showSizeHover !== 'boolean') throw new TypeError(tPreload('invalidArgument', { name: 'showSizeHover' }));
      return ipcRenderer.invoke('workspace.setShowSizeHover', showSizeHover) as Promise<OperationResult<boolean>>;
    },
    getShowSize: () => ipcRenderer.invoke('workspace.getShowSize') as Promise<OperationResult<boolean>>,
    setShowSize: (showSize: boolean) => {
      if (typeof showSize !== 'boolean') throw new TypeError(tPreload('invalidArgument', { name: 'showSize' }));
      return ipcRenderer.invoke('workspace.setShowSize', showSize) as Promise<OperationResult<boolean>>;
    },
    getShowCreatedAt: () => ipcRenderer.invoke('workspace.getShowCreatedAt') as Promise<OperationResult<boolean>>,
    setShowCreatedAt: (showCreatedAt: boolean) => {
      if (typeof showCreatedAt !== 'boolean') throw new TypeError(tPreload('invalidArgument', { name: 'showCreatedAt' }));
      return ipcRenderer.invoke('workspace.setShowCreatedAt', showCreatedAt) as Promise<OperationResult<boolean>>;
    },
    getShowUpdatedAt: () => ipcRenderer.invoke('workspace.getShowUpdatedAt') as Promise<OperationResult<boolean>>,
    setShowUpdatedAt: (showUpdatedAt: boolean) => {
      if (typeof showUpdatedAt !== 'boolean') throw new TypeError(tPreload('invalidArgument', { name: 'showUpdatedAt' }));
      return ipcRenderer.invoke('workspace.setShowUpdatedAt', showUpdatedAt) as Promise<OperationResult<boolean>>;
    },
    getShowDotEntries: () => ipcRenderer.invoke('workspace.getShowDotEntries') as Promise<OperationResult<boolean>>,
    setShowDotEntries: (showDotEntries: boolean) => {
      if (typeof showDotEntries !== 'boolean') throw new TypeError(tPreload('invalidArgument', { name: 'showDotEntries' }));
      return ipcRenderer.invoke('workspace.setShowDotEntries', showDotEntries) as Promise<OperationResult<boolean>>;
    },
    getShowTimestampHover: () => ipcRenderer.invoke('workspace.getShowTimestampHover') as Promise<OperationResult<boolean>>,
    setShowTimestampHover: (showTimestampHover: boolean) => {
      if (typeof showTimestampHover !== 'boolean') throw new TypeError(tPreload('invalidArgument', { name: 'showTimestampHover' }));
      return ipcRenderer.invoke('workspace.setShowTimestampHover', showTimestampHover) as Promise<OperationResult<boolean>>;
    },
    create: (request: WorkspaceCreateRequest) => {
      assertRelativePath(request?.parentRelativePath);
      if (!request || (request.kind !== 'file' && request.kind !== 'directory')) throw new TypeError(tPreload('invalidCreate'));
      assertString(request.name, 'name');
      return ipcRenderer.invoke('workspace.create', request) as Promise<OperationResult<WorkspaceEntry>>;
    },
    rename: (request: WorkspaceRenameRequest) => {
      assertRelativePath(request?.relativePath);
      assertString(request?.newName, 'newName');
      return ipcRenderer.invoke('workspace.rename', request) as Promise<OperationResult<WorkspaceEntry>>;
    },
    move: (request: WorkspaceMoveRequest) => {
      assertRelativePath(request?.relativePath);
      assertRelativePath(request?.targetParentRelativePath);
      return ipcRenderer.invoke('workspace.move', request) as Promise<OperationResult<WorkspaceEntry>>;
    },
    reorder: (request: WorkspaceReorderRequest) => {
      assertRelativePath(request?.parentRelativePath);
      assertString(request?.movedName, 'movedName');
      if (!Array.isArray(request?.siblingNames)) throw new TypeError(tPreload('invalidArgument', { name: 'siblingNames' }));
      return ipcRenderer.invoke('workspace.reorder', request) as Promise<OperationResult<boolean>>;
    },
    delete: (request: WorkspaceDeleteRequest) => {
      assertRelativePath(request?.relativePath);
      return ipcRenderer.invoke('workspace.delete', request) as Promise<OperationResult<boolean>>;
    },
    copyClipboard: (relativePaths: string[]) => {
      relativePaths.forEach(assertRelativePath);
      return ipcRenderer.invoke('workspace.copyClipboard', relativePaths) as Promise<OperationResult<boolean>>;
    },
    pasteClipboard: (request: WorkspacePasteRequest) => {
      assertRelativePath(request?.targetRelativePath);
      return ipcRenderer.invoke('workspace.pasteClipboard', request) as Promise<OperationResult<WorkspaceEntry>>;
    },
    importExternal: (request) => {
      assertRelativePath(request?.targetParentRelativePath);
      return ipcRenderer.invoke('workspace.importExternal', request) as Promise<OperationResult<WorkspaceEntry>>;
    },
    getResourcePaths: (relativePath: string) => {
      assertRelativePath(relativePath);
      return ipcRenderer.invoke('workspace.getResourcePaths', relativePath);
    },
    showContextMenu: (relativePath: string, kind: WorkspaceEntry['kind'], selectedRelativePaths: string[]) => {
      assertRelativePath(relativePath);
      selectedRelativePaths.forEach(assertRelativePath);
      if (kind !== 'file' && kind !== 'directory' && kind !== 'symlink') throw new TypeError(tPreload('invalidKind'));
      return ipcRenderer.invoke('workspace.showContextMenu', { relativePath, kind, selectedRelativePaths });
    },
    popupNewFileMenu: (parentRelativePath: string, x: number, y: number) => {
      assertRelativePath(parentRelativePath);
      if (typeof x !== 'number' || !Number.isFinite(x) || typeof y !== 'number' || !Number.isFinite(y)) {
        throw new TypeError(tPreload('invalidArgument', { name: 'popupNewFileMenu' }));
      }
      return ipcRenderer.invoke('workspace.popupNewFileMenu', { parentRelativePath, x, y });
    },
    openEntry: (relativePath: string) => {
      assertRelativePath(relativePath);
      return ipcRenderer.invoke('workspace.openEntry', relativePath) as Promise<OperationResult<boolean>>;
    },
    onChanged: (listener) => {
      const handler = (_event: Electron.IpcRendererEvent, paths: string[] | null) => listener(paths);
      ipcRenderer.on('workspace.changed', handler);
      return subscription(() => ipcRenderer.removeListener('workspace.changed', handler));
    },
    onContextCommand: (listener) => {
      const handler = (_event: Electron.IpcRendererEvent, command: WorkspaceContextCommand, relativePath: string, detail?: string) => listener(command, relativePath, detail);
      ipcRenderer.on('workspace.contextCommand', handler);
      return subscription(() => ipcRenderer.removeListener('workspace.contextCommand', handler));
    },
  },
  tabs: {
    getState: () => ipcRenderer.invoke('tabs.getState'),
    openWorkspaceEntry: (relativePath: string) => {
      assertRelativePath(relativePath);
      return ipcRenderer.invoke('tabs.openWorkspaceEntry', relativePath);
    },
    openPreview: (relativePath: string) => {
      assertRelativePath(relativePath);
      return ipcRenderer.invoke('tabs.openPreview', relativePath);
    },
    activate: (tabId: string) => {
      assertString(tabId, 'tabId');
      return ipcRenderer.invoke('tabs.activate', tabId);
    },
    close: (tabId: string) => {
      assertString(tabId, 'tabId');
      return ipcRenderer.invoke('tabs.close', tabId);
    },
    closeOthers: (tabId: string) => {
      assertString(tabId, 'tabId');
      return ipcRenderer.invoke('tabs.closeOthers', tabId);
    },
    closeAll: (tabId: string) => {
      assertString(tabId, 'tabId');
      return ipcRenderer.invoke('tabs.closeAll', tabId);
    },
    showContextMenu: (tabId: string) => {
      assertString(tabId, 'tabId');
      return ipcRenderer.invoke('tabs.showContextMenu', tabId);
    },
    executeContextCommand: (tabId: string, command: DesktopTabContextCommand) => {
      assertString(tabId, 'tabId');
      assertString(command, 'command');
      return ipcRenderer.invoke('tabs.executeContextCommand', { tabId, command });
    },
    onChanged: (listener) => {
      const handler = (_event: Electron.IpcRendererEvent, state: import('../contracts').DesktopTabSnapshot) => listener(state);
      ipcRenderer.on('tabs.changed', handler);
      return subscription(() => ipcRenderer.removeListener('tabs.changed', handler));
    },
  },
  preview: {
    open: (relativePath: string) => {
      assertRelativePath(relativePath);
      return ipcRenderer.invoke('preview.open', relativePath);
    },
    close: (sessionId: string) => {
      assertString(sessionId, 'sessionId');
      return ipcRenderer.invoke('preview.close', sessionId);
    },
    readText: (sessionId: string) => {
      assertString(sessionId, 'sessionId');
      return ipcRenderer.invoke('preview.readText', sessionId);
    },
    writeBytes: (sessionId: string, bytesBase64: string) => {
      assertString(sessionId, 'sessionId');
      assertString(bytesBase64, 'bytesBase64');
      return ipcRenderer.invoke('preview.writeBytes', {
        sessionId,
        encoding: 'base64',
        bytes: bytesBase64,
      });
    },
    sendHttp: (request: HttpPreviewRequest) => {
      if (!request || typeof request.url !== 'string') throw new TypeError(tPreload('invalidHttpRequest'));
      return ipcRenderer.invoke('preview.http.send', request);
    },
    decompileJava: (sessionId: string) => {
      assertString(sessionId, 'sessionId');
      return ipcRenderer.invoke('preview.java.decompile', sessionId);
    },
    onFileChanged: (listener) => {
      const handler = (_event: Electron.IpcRendererEvent, relativePaths: string[]) => listener(relativePaths);
      ipcRenderer.on('preview.fileChanged', handler);
      return subscription(() => ipcRenderer.removeListener('preview.fileChanged', handler));
    },
  },
  system: {
    openWithDefaultApp: (relativePath: string) => {
      assertRelativePath(relativePath);
      return ipcRenderer.invoke('system.openWithDefaultApp', relativePath);
    },
    revealInFolder: (relativePath: string) => {
      assertRelativePath(relativePath);
      return ipcRenderer.invoke('system.revealInFolder', relativePath);
    },
  },
  archive: {
    list: (sessionId: string, password?: string) => {
      assertString(sessionId, 'sessionId');
      if (password !== undefined) assertString(password, 'password');
      return ipcRenderer.invoke('archive.list', { sessionId, password });
    },
    readEntry: (sessionId: string, entryPath: string, password?: string) => {
      assertString(sessionId, 'sessionId');
      assertRelativePath(entryPath);
      if (password !== undefined) assertString(password, 'password');
      return ipcRenderer.invoke('archive.readEntry', { sessionId, entryPath, password });
    },
    exportEntry: (sessionId: string, entryPath: string, password?: string) => {
      assertString(sessionId, 'sessionId');
      assertRelativePath(entryPath);
      if (password !== undefined) assertString(password, 'password');
      return ipcRenderer.invoke('archive.exportEntry', { sessionId, entryPath, password });
    },
  },
  menu: {
    publishState: (state: DesktopMenuState) => ipcRenderer.send('desktop.menuState', state),
    onCommand: (listener) => {
      const handler = (_event: Electron.IpcRendererEvent, command: DesktopMenuCommand) => listener(command);
      ipcRenderer.on('desktop.menuCommand', handler);
      return subscription(() => ipcRenderer.removeListener('desktop.menuCommand', handler));
    },
    onRevealInIndexArea: (listener) => {
      const handler = (_event: Electron.IpcRendererEvent, relativePath: unknown) => {
        if (typeof relativePath === 'string') listener(relativePath);
      };
      ipcRenderer.on('workspace.revealInIndexArea', handler);
      return subscription(() => ipcRenderer.removeListener('workspace.revealInIndexArea', handler));
    },
  },
  editor: {
    postMessage: (message: EditorToHostMessage) => ipcRenderer.send('editor.message', message),
    subscribe: (listener: (message: HostToEditorMessage) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, message: HostToEditorMessage) => listener(message);
      ipcRenderer.on('editor.message', handler);
      return subscription(() => ipcRenderer.removeListener('editor.message', handler));
    },
  },
};

contextBridge.exposeInMainWorld('easyViewDesktop', api);
