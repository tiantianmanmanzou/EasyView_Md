import { contextBridge, ipcRenderer } from 'electron';
import type {
  EditorHostSubscription,
  HostToEditorMessage,
  OperationResult,
  EditorToHostMessage,
} from '@easyview/contracts';
import type {
  DesktopMenuCommand,
  DesktopMenuState,
  DesktopThemeMode,
  DocumentOpenResult,
  SaveDocumentResult,
  WorkspaceCreateRequest,
  WorkspaceDeleteRequest,
  WorkspacePasteRequest,
  WorkspaceRenameRequest,
  WorkspaceContextCommand,
  DesktopTabContextCommand,
  DesktopWorkspaceState,
  WorkspaceEntry,
  HttpPreviewRequest,
} from '../contracts';
import type { EasyViewDesktopApi } from './desktopApi';

function assertString(value: unknown, name: string): asserts value is string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`${name} must be a non-empty string`);
  }
}

function assertMtime(value: unknown): asserts value is number | null {
  if (value !== null && (typeof value !== 'number' || !Number.isFinite(value))) {
    throw new TypeError('expectedMtimeMs must be a finite number or null');
  }
}

function assertRelativePath(value: unknown): asserts value is string {
  if (typeof value !== 'string' || value.includes('\0')) throw new TypeError('relativePath 无效');
}

function subscription(unsubscribe: () => void): EditorHostSubscription {
  return { unsubscribe };
}

const api: EasyViewDesktopApi = {
  document: {
    open: () => ipcRenderer.invoke('document.open') as Promise<OperationResult<DocumentOpenResult | null>>,
    save: (content, expectedMtimeMs) => {
      assertString(content, 'content');
      assertMtime(expectedMtimeMs);
      return ipcRenderer.invoke('document.save', { content, expectedMtimeMs }) as Promise<OperationResult<SaveDocumentResult | null>>;
    },
    saveAs: (content, suggestedFileName, lineEnding) => {
      assertString(content, 'content');
      assertString(suggestedFileName, 'suggestedFileName');
      if (lineEnding !== '\n' && lineEnding !== '\r\n') throw new TypeError('invalid lineEnding');
      return ipcRenderer.invoke('document.saveAs', { content, suggestedFileName, lineEnding }) as Promise<OperationResult<SaveDocumentResult | null>>;
    },
    rename: (fileName) => {
      assertString(fileName, 'fileName');
      return ipcRenderer.invoke('document.rename', { fileName }) as Promise<OperationResult<SaveDocumentResult>>;
    },
    onChanged: (listener) => {
      const handler = (_event: Electron.IpcRendererEvent, payload: DocumentOpenResult) => listener(payload);
      ipcRenderer.on('document.changed', handler);
      return subscription(() => ipcRenderer.removeListener('document.changed', handler));
    },
  },
  window: {
    requestClose: () => ipcRenderer.invoke('window.requestClose') as Promise<OperationResult<boolean>>,
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
    onThemeChanged: (listener) => {
      const handler = (_event: Electron.IpcRendererEvent, theme: DesktopThemeMode) => listener(theme);
      ipcRenderer.on('app.themeChanged', handler);
      return subscription(() => ipcRenderer.removeListener('app.themeChanged', handler));
    },
  },
  workspace: {
    openFolder: () => ipcRenderer.invoke('workspace.openFolder'),
    getState: () => ipcRenderer.invoke('workspace.getState'),
    setState: (state: DesktopWorkspaceState) => ipcRenderer.invoke('workspace.setState', state),
    readDirectory: (relativePath: string) => {
      assertRelativePath(relativePath);
      return ipcRenderer.invoke('workspace.readDirectory', relativePath) as Promise<OperationResult<WorkspaceEntry[]>>;
    },
    create: (request: WorkspaceCreateRequest) => {
      assertRelativePath(request?.parentRelativePath);
      if (!request || (request.kind !== 'file' && request.kind !== 'directory')) throw new TypeError('新建节点参数无效');
      assertString(request.name, 'name');
      return ipcRenderer.invoke('workspace.create', request) as Promise<OperationResult<WorkspaceEntry>>;
    },
    rename: (request: WorkspaceRenameRequest) => {
      assertRelativePath(request?.relativePath);
      assertString(request?.newName, 'newName');
      return ipcRenderer.invoke('workspace.rename', request) as Promise<OperationResult<WorkspaceEntry>>;
    },
    delete: (request: WorkspaceDeleteRequest) => {
      assertRelativePath(request?.relativePath);
      return ipcRenderer.invoke('workspace.delete', request) as Promise<OperationResult<boolean>>;
    },
    copyClipboard: (relativePath: string) => {
      assertRelativePath(relativePath);
      return ipcRenderer.invoke('workspace.copyClipboard', relativePath) as Promise<OperationResult<boolean>>;
    },
    pasteClipboard: (request: WorkspacePasteRequest) => {
      assertRelativePath(request?.targetRelativePath);
      return ipcRenderer.invoke('workspace.pasteClipboard', request) as Promise<OperationResult<WorkspaceEntry>>;
    },
    getResourcePaths: (relativePath: string) => {
      assertRelativePath(relativePath);
      return ipcRenderer.invoke('workspace.getResourcePaths', relativePath);
    },
    showContextMenu: (relativePath: string, kind: WorkspaceEntry['kind']) => {
      assertRelativePath(relativePath);
      if (kind !== 'file' && kind !== 'directory' && kind !== 'symlink') throw new TypeError('节点类型无效');
      return ipcRenderer.invoke('workspace.showContextMenu', { relativePath, kind });
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
      const handler = (_event: Electron.IpcRendererEvent, command: WorkspaceContextCommand, relativePath: string) => listener(command, relativePath);
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
      if (!request || typeof request.url !== 'string') throw new TypeError('HTTP 请求无效');
      return ipcRenderer.invoke('preview.http.send', request);
    },
    decompileJava: (sessionId: string) => {
      assertString(sessionId, 'sessionId');
      return ipcRenderer.invoke('preview.java.decompile', sessionId);
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
