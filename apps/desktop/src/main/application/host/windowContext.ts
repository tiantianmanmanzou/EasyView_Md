import { captureDesktopHistory } from '../document/desktopHistory';
import { AsyncLocalStorage } from 'node:async_hooks';
import type { BrowserWindow } from 'electron';
import { TerminalService, type AiChatHost } from '@easyview/node-runtime';
import type { AppStateStore } from '../document/appState';
import { DocumentSessionService } from '../document/DocumentSessionService';
import { createNodeDocumentFileSystem } from '../document/documentFileSystem';
import { createNodeDocumentGitPort } from '../document/documentGit';
import { DesktopTabRegistry } from '../document/DesktopTabRegistry';
import { DesktopWorkspaceCore } from '../workspace/DesktopWorkspaceCore';
import { WorkspaceWatcher } from '../workspace/WorkspaceWatcher';
import { ArchivePreviewService } from '../preview/ArchivePreviewService';
import { JavaDecompileService } from '../preview/JavaDecompileService';
import { PreviewSessionStore } from '../preview/PreviewSession';
import type { DesktopMenuState } from '../../../contracts';

export interface DesktopWindowContext {
  readonly id: string;
  readonly tabs: DesktopTabRegistry;
  readonly documentSessions: DocumentSessionService;
  readonly workspaceCore: DesktopWorkspaceCore;
  readonly previewSessions: PreviewSessionStore;
  readonly archivePreviewService: ArchivePreviewService;
  readonly javaDecompileService: JavaDecompileService;
  window?: BrowserWindow;
  appStateStore?: AppStateStore;
  isClosing: boolean;
  pendingOpenPath?: string;
  terminalService?: TerminalService;
  activeTerminalSessionId?: string;
  workspaceFileClipboard: { relativePaths: string[] } | null;
  workspaceWatcher?: WorkspaceWatcher;
  aiChatHost?: AiChatHost;
  desktopMenuState: DesktopMenuState;
}

const contextStorage = new AsyncLocalStorage<DesktopWindowContext>();

export function createDesktopWindowContext(id: string, trash?: (absolutePath: string) => Promise<void>): DesktopWindowContext {
  const previewSessions = new PreviewSessionStore();
  const documentSessions = new DocumentSessionService(createNodeDocumentFileSystem(), createNodeDocumentGitPort());
  documentSessions.setHistoryRecorder(captureDesktopHistory);
  return {
    id,
    tabs: new DesktopTabRegistry(id),
    documentSessions,
    workspaceCore: new DesktopWorkspaceCore(trash),
    previewSessions,
    archivePreviewService: new ArchivePreviewService(previewSessions),
    javaDecompileService: new JavaDecompileService(previewSessions),
    isClosing: false,
    workspaceFileClipboard: null,
    desktopMenuState: {
      sourceMode: false,
      outlineVisible: true,
      fullWidth: true,
      tableWrap: false,
      viewChanges: false,
      hasActiveDocument: false,
      isMarkdownDocument: false,
      themeMode: 'light',
      themeDepth: 50,
      accent: 'default',
    },
  };
}

export function initializeDesktopWindowContext(context: DesktopWindowContext): DesktopWindowContext {
  return context;
}

export function runInDesktopWindowContext<T>(context: DesktopWindowContext, operation: () => T): T {
  return contextStorage.run(context, operation);
}

export function currentDesktopWindowContext(fallback: DesktopWindowContext): DesktopWindowContext {
  return contextStorage.getStore() ?? fallback;
}
