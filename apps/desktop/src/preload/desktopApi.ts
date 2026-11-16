import type { TimelineComparison, TimelineRequestMessage, TimelineResultMessage, LocalHistorySettings } from '@easyview/contracts';
import type {
  EditorHostTransport,
  Locale,
  OperationResult,
  PreviewWriteResult,
} from '@easyview/contracts';
import type {
  ArchiveEntry,
  ArchiveEntryPreview,
  DesktopThemeMode,
  DocumentOpenResult,
  HttpPreviewRequest,
  HttpPreviewResponse,
  JavaDecompileResult,
  PreviewDescriptor,
  PreviewTextResult,
  SaveDocumentResult,
} from '../contracts';
import type { DesktopBrowserApi, DesktopMenuCommand, DesktopMenuState, DesktopTabsApi, WorkspaceApi } from '../contracts';

export type DesktopDocumentResult = OperationResult<DocumentOpenResult | null>;
export type DesktopSaveResult = OperationResult<SaveDocumentResult | null>;

export interface EasyViewDesktopApi {
  versionGuard: {
    request(request: import('@easyview/contracts').GuardRequest): Promise<OperationResult<unknown>>;
    subscribe(listener: (paths: string[] | null) => void): { dispose(): void };
    onDiscovery(listener: (repositories: import('@easyview/contracts').GuardRepository[], warnings: string[]) => void): { dispose(): void };
  };
  timeline: {
    post(message: TimelineRequestMessage): void;
    subscribe(listener: (message: TimelineResultMessage) => void): { dispose(): void };
    diagnostics(): Promise<OperationResult<{ queries: number; watchers: number; snapshots: number; requests: number; queues: number; pending: number }>>;
    comparison(tabId: string): Promise<OperationResult<TimelineComparison>>;
    getSettings(): Promise<OperationResult<LocalHistorySettings>>;
    setSettings(settings: LocalHistorySettings): Promise<OperationResult<boolean>>;
  };

  document: {
    open(): Promise<DesktopDocumentResult>;
    save(content: string, sessionId: string): Promise<DesktopSaveResult>;
    saveAs(content: string, suggestedFileName: string, lineEnding: '\n' | '\r\n', sessionId: string): Promise<DesktopSaveResult>;
    rename(fileName: string, sessionId: string): Promise<OperationResult<SaveDocumentResult>>;
    onChanged(listener: (event: DocumentOpenResult) => void): { unsubscribe(): void };
  };
  window: {
    requestClose(): Promise<OperationResult<boolean>>;
    /** macOS: applies the system "double-click a window's title bar" action (zoom or minimize). */
    titleBarDoubleClick(): Promise<OperationResult<boolean>>;
    /** Pops up the application menu at a point in the renderer's CSS pixels. */
    popupAppMenu(x: number, y: number): Promise<OperationResult<boolean>>;
    /** Windows / Linux: recolours the native window-control overlay to match the renderer's top row. */
    setTitleBarOverlay(color: string, symbolColor: string): Promise<OperationResult<boolean>>;
  };
  external: {
    open(url: string): Promise<OperationResult<boolean>>;
  };
  clipboard: {
    writeText(text: string): Promise<OperationResult<boolean>>;
  };
  app: {
    getTheme(): Promise<OperationResult<DesktopThemeMode>>;
    newWindow(): Promise<OperationResult<boolean>>;
    /** Page zoom set by View › 放大/缩小 (1 = 100%). */
    getZoomFactor(): number;
    onZoomChanged(listener: (zoomFactor: number) => void): { unsubscribe(): void };
    /** UI locale resolved by the main process at startup; changing it requires a restart. */
    readonly locale: Locale;
    /** True when this window was created for a document opened by the launch (argv / Finder). */
    readonly openedFileAtLaunch: boolean;
    onThemeChanged(listener: (theme: DesktopThemeMode) => void): { unsubscribe(): void };
    /** Fired when the user explicitly opened a document (Finder / Explorer, Open…, recent files). */
    onRevealDocument(listener: () => void): { unsubscribe(): void };
  };
  workspace: WorkspaceApi;
  tabs: DesktopTabsApi;
  browser: DesktopBrowserApi;
  preview: {
    open(relativePath: string): Promise<OperationResult<PreviewDescriptor>>;
    close(sessionId: string): Promise<OperationResult<boolean>>;
    readText(sessionId: string): Promise<OperationResult<PreviewTextResult>>;
    writeBytes(sessionId: string, bytesBase64: string): Promise<OperationResult<PreviewWriteResult>>;
    sendHttp(request: HttpPreviewRequest): Promise<OperationResult<HttpPreviewResponse>>;
    decompileJava(sessionId: string): Promise<OperationResult<JavaDecompileResult>>;
    /** Report unsaved state for tab dots / quit prompts. */
    setDirty(relativePath: string, dirty: boolean): Promise<OperationResult<boolean>>;
    /** Save / Don't Save / Cancel while leaving a dirty preview. */
    confirmUnsaved(fileName: string): Promise<'save' | 'discard' | 'cancel'>;
    /** Main asks the renderer to save a dirty preview during close-all. */
    onSaveRequest(listener: (request: { requestId: string; relativePath: string }) => void): { unsubscribe(): void };
    reportSaveResult(requestId: string, ok: boolean): Promise<OperationResult<boolean>>;
    /** Main discarded unsaved preview edits — drop local dirty without prompting again. */
    onClearDirty(listener: (relativePath: string) => void): { unsubscribe(): void };
    /** Workspace-relative paths of open previews whose file was changed outside the preview. */
    onFileChanged(listener: (relativePaths: string[]) => void): { unsubscribe(): void };
  };
  system: {
    openWithDefaultApp(relativePath: string): Promise<OperationResult<boolean>>;
    revealInFolder(relativePath: string): Promise<OperationResult<boolean>>;
  };
  archive: {
    list(sessionId: string, password?: string): Promise<OperationResult<ArchiveEntry[]>>;
    readEntry(sessionId: string, entryPath: string, password?: string): Promise<OperationResult<ArchiveEntryPreview>>;
    exportEntry(sessionId: string, entryPath: string, password?: string): Promise<OperationResult<boolean>>;
    /** Resolves to the name of the sibling folder the archive was extracted into. */
    extract(sessionId: string): Promise<OperationResult<string>>;
  };
  menu: {
    publishState(state: DesktopMenuState): void;
    onCommand(listener: (command: DesktopMenuCommand) => void): { unsubscribe(): void };
    onRevealInIndexArea(listener: (relativePath: string) => void): { unsubscribe(): void };
  };
  editor: {
    postMessage(message: Parameters<EditorHostTransport['postMessage']>[0]): void | Promise<void>;
    subscribe(listener: Parameters<EditorHostTransport['subscribe']>[0]): { unsubscribe(): void };
  };
}
