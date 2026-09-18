import type { DocumentUpdatePayload, XlsxTablePayload } from '@easyview/contracts';
import type {
  DesktopTabContextCommand,
  DesktopTabSnapshot,
  DesktopWorkspaceState,
  WorkspaceContextCommand,
  WorkspaceCreateRequest,
  WorkspaceDeleteRequest,
  WorkspaceEntry,
  WorkspacePasteRequest,
  WorkspaceRenameRequest,
  WorkspaceResourcePaths,
} from './workspace';

export type DesktopThemeMode = 'light' | 'dark';

export interface DesktopTheme {
  mode: DesktopThemeMode;
  editorBackground: string;
  editorForeground: string;
  panelBackground: string;
  panelForeground: string;
  inputBackground: string;
  buttonBackground: string;
  buttonForeground: string;
  border: string;
  focusBorder: string;
  hoverBackground: string;
  selectionBackground: string;
  codeBackground: string;
}

export interface DesktopDocument {
  filePath: string | null;
  fileName: string;
  content: string;
  lineEnding: '\n' | '\r\n';
  mtimeMs: number | null;
}

export interface DocumentOpenResult extends DesktopDocument {
  filePath: string;
  mtimeMs: number;
}

export interface SaveDocumentRequest {
  filePath: string;
  content: string;
  expectedMtimeMs: number | null;
}

export interface SaveAsDocumentRequest {
  suggestedFileName: string;
  content: string;
  lineEnding: '\n' | '\r\n';
}

export interface RenameDocumentRequest {
  fileName: string;
}

export interface SaveDocumentResult {
  filePath: string;
  fileName: string;
  mtimeMs: number;
}

export interface DocumentChangedEvent {
  filePath: string;
  content: string;
  mtimeMs: number;
  reason: 'external-change' | 'replaced';
}

export interface ImagePickResult {
  sourcePath: string;
  relativePath: string;
  dataUrl: string;
}

export interface ReadImageRequest {
  documentPath: string;
  originalSrc: string;
}

export interface ReadImageResult {
  base64: string | null;
  mimeType: string | null;
}

export interface SavePastedImageRequest {
  documentPath: string;
  dataUrl: string;
  mimeType?: string;
  preferredName?: string;
}

export interface ImageSaveResult {
  filePath: string;
  relativePath: string;
  src: string;
}

export interface ExportHtmlRequest {
  suggestedFileName: string;
  html: string;
  images: Array<{ originalSrc: string; exportFilename: string; isExternal: boolean }>;
}

export interface ExportPdfRequest {
  suggestedFileName: string;
  data: string;
}

export interface ExportDocxRequest {
  title: string;
  markdown: string;
  mermaidImages: Array<{ source: string; pngBase64: string; width: number; height: number }>;
  asciiImages: Array<{ source: string; pngBase64: string; width: number; height: number }>;
}

export interface ExportXlsxRequest {
  payload: XlsxTablePayload;
  suggestedFileName: string;
}

export interface EditorBootstrapData extends DocumentUpdatePayload {
  filePath: string;
  fileName: string;
}

export type DesktopMenuCommand =
  | 'toggleExplorer'
  | 'rename'
  | 'toggleTheme'
  | 'toggleOutline'
  | 'toggleSourceMode'
  | 'toggleFullWidth'
  | 'toggleTableWrap'
  | 'zoomIn'
  | 'zoomOut'
  | 'resetZoom'
  | 'scrollTop'
  | 'scrollBottom'
  | 'toggleHeadingCollapse'
  | 'toggleHistory'
  | 'toggleStickyNote'
  | 'toggleAiChat'
  | 'openTerminal'
  | 'stageFile'
  | 'openCommit'
  | 'syncGit'
  | 'exportHtmlLight'
  | 'exportHtmlDark'
  | 'exportPdfLight'
  | 'exportPdfDark'
  | 'exportDocx'
  | 'findReplace';

export interface DesktopMenuState {
  sourceMode: boolean;
  outlineVisible: boolean;
  fullWidth: boolean;
  tableWrap: boolean;
  hasActiveDocument: boolean;
}

export interface WorkspaceApi {
  openFolder(): Promise<import('@easyview/contracts').OperationResult<DesktopWorkspaceState | null>>;
  getState(): Promise<import('@easyview/contracts').OperationResult<DesktopWorkspaceState>>;
  setState(state: DesktopWorkspaceState): Promise<import('@easyview/contracts').OperationResult<DesktopWorkspaceState>>;
  readDirectory(relativePath: string): Promise<import('@easyview/contracts').OperationResult<WorkspaceEntry[]>>;
  create(request: WorkspaceCreateRequest): Promise<import('@easyview/contracts').OperationResult<WorkspaceEntry>>;
  rename(request: WorkspaceRenameRequest): Promise<import('@easyview/contracts').OperationResult<WorkspaceEntry>>;
  delete(request: WorkspaceDeleteRequest): Promise<import('@easyview/contracts').OperationResult<boolean>>;
  copyClipboard(relativePath: string): Promise<import('@easyview/contracts').OperationResult<boolean>>;
  pasteClipboard(request: WorkspacePasteRequest): Promise<import('@easyview/contracts').OperationResult<WorkspaceEntry>>;
  getResourcePaths(relativePath: string): Promise<import('@easyview/contracts').OperationResult<WorkspaceResourcePaths>>;
  showContextMenu(relativePath: string, kind: WorkspaceEntry['kind']): Promise<import('@easyview/contracts').OperationResult<boolean>>;
  openEntry(relativePath: string): Promise<import('@easyview/contracts').OperationResult<boolean>>;
  onChanged(listener: (relativePaths: string[] | null) => void): { unsubscribe(): void };
  onContextCommand(listener: (command: WorkspaceContextCommand, relativePath: string) => void): { unsubscribe(): void };
}

export interface DesktopTabsApi {
  getState(): Promise<import('@easyview/contracts').OperationResult<DesktopTabSnapshot>>;
  openWorkspaceEntry(relativePath: string): Promise<import('@easyview/contracts').OperationResult<DesktopTabSnapshot>>;
  openPreview(relativePath: string): Promise<import('@easyview/contracts').OperationResult<DesktopTabSnapshot>>;
  activate(tabId: string): Promise<import('@easyview/contracts').OperationResult<DesktopTabSnapshot>>;
  close(tabId: string): Promise<import('@easyview/contracts').OperationResult<DesktopTabSnapshot | null>>;
  closeOthers(tabId: string): Promise<import('@easyview/contracts').OperationResult<DesktopTabSnapshot>>;
  closeAll(tabId: string): Promise<import('@easyview/contracts').OperationResult<DesktopTabSnapshot>>;
  showContextMenu(tabId: string): Promise<import('@easyview/contracts').OperationResult<boolean>>;
  executeContextCommand(tabId: string, command: DesktopTabContextCommand): Promise<import('@easyview/contracts').OperationResult<DesktopTabSnapshot>>;
  onChanged(listener: (state: DesktopTabSnapshot) => void): { unsubscribe(): void };
}
