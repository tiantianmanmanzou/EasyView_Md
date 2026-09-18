import type {
  EditorHostTransport,
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
import type { DesktopMenuCommand, DesktopMenuState, DesktopTabsApi, WorkspaceApi } from '../contracts';

export type DesktopDocumentResult = OperationResult<DocumentOpenResult | null>;
export type DesktopSaveResult = OperationResult<SaveDocumentResult | null>;

export interface EasyViewDesktopApi {
  document: {
    open(): Promise<DesktopDocumentResult>;
    save(content: string, expectedMtimeMs: number | null): Promise<DesktopSaveResult>;
    saveAs(content: string, suggestedFileName: string, lineEnding: '\n' | '\r\n'): Promise<DesktopSaveResult>;
    rename(fileName: string): Promise<OperationResult<SaveDocumentResult>>;
    onChanged(listener: (event: DocumentOpenResult) => void): { unsubscribe(): void };
  };
  window: {
    requestClose(): Promise<OperationResult<boolean>>;
  };
  external: {
    open(url: string): Promise<OperationResult<boolean>>;
  };
  clipboard: {
    writeText(text: string): Promise<OperationResult<boolean>>;
  };
  app: {
    getTheme(): Promise<OperationResult<DesktopThemeMode>>;
    onThemeChanged(listener: (theme: DesktopThemeMode) => void): { unsubscribe(): void };
  };
  workspace: WorkspaceApi;
  tabs: DesktopTabsApi;
  preview: {
    open(relativePath: string): Promise<OperationResult<PreviewDescriptor>>;
    close(sessionId: string): Promise<OperationResult<boolean>>;
    readText(sessionId: string): Promise<OperationResult<PreviewTextResult>>;
    writeBytes(sessionId: string, bytesBase64: string): Promise<OperationResult<PreviewWriteResult>>;
    sendHttp(request: HttpPreviewRequest): Promise<OperationResult<HttpPreviewResponse>>;
    decompileJava(sessionId: string): Promise<OperationResult<JavaDecompileResult>>;
  };
  system: {
    openWithDefaultApp(relativePath: string): Promise<OperationResult<boolean>>;
    revealInFolder(relativePath: string): Promise<OperationResult<boolean>>;
  };
  archive: {
    list(sessionId: string, password?: string): Promise<OperationResult<ArchiveEntry[]>>;
    readEntry(sessionId: string, entryPath: string, password?: string): Promise<OperationResult<ArchiveEntryPreview>>;
    exportEntry(sessionId: string, entryPath: string, password?: string): Promise<OperationResult<boolean>>;
  };
  menu: {
    publishState(state: DesktopMenuState): void;
    onCommand(listener: (command: DesktopMenuCommand) => void): { unsubscribe(): void };
  };
  editor: {
    postMessage(message: Parameters<EditorHostTransport['postMessage']>[0]): void | Promise<void>;
    subscribe(listener: Parameters<EditorHostTransport['subscribe']>[0]): { unsubscribe(): void };
  };
}
