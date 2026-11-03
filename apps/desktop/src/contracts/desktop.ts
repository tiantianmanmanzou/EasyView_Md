import type { DocumentSnapshotPayload, XlsxTablePayload } from '@easyview/contracts';
import type {
  DesktopTabContextCommand,
  DesktopTabSnapshot,
  DesktopWorkspaceState,
  WorkspaceContextCommand,
  WorkspaceCreateRequest,
  WorkspaceDeleteRequest,
  WorkspaceEntry,
  WorkspaceImportExternalRequest,
  WorkspacePasteRequest,
  WorkspaceRenameRequest,
  WorkspaceResourcePaths,
} from './workspace';

export type DesktopThemeMode = 'light' | 'dark';

export const DESKTOP_TAB_CLOSE_SHORTCUT = {
  accelerator: 'CmdOrCtrl+W',
  macLabel: '⌘W',
  otherLabel: 'Ctrl+W',
  windowsSecondary: 'Ctrl+F4',
} as const;

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

export interface EditorBootstrapData extends DocumentSnapshotPayload {
  filePath: string;
  fileName: string;
}

export type DesktopAppearanceMode = 'light' | 'gray' | 'dark';
export type DesktopAccent = 'default' | 'blue' | 'orangeRed' | 'green' | 'purple' | 'cherryRed';
/** Renderer process argument carrying the UI locale chosen by the main process. */
export const DESKTOP_LOCALE_ARGUMENT_PREFIX = '--easyview-locale=';
/** Renderer process argument set when the launch itself opened a document (argv / open-file). */
export const DESKTOP_OPENED_FILE_AT_LAUNCH_ARGUMENT = '--easyview-opened-file-at-launch';
export const DESKTOP_APPEARANCE_MODES: readonly DesktopAppearanceMode[] = ['light', 'gray', 'dark'];
export const DESKTOP_ACCENTS: readonly DesktopAccent[] = ['default', 'blue', 'orangeRed', 'green', 'purple', 'cherryRed'];
/** Background depth presets offered by the menu, in percent. */
export const DESKTOP_THEME_DEPTH_STEPS = [0, 25, 50, 75, 100] as const;
export type DesktopThemeDepthStep = (typeof DESKTOP_THEME_DEPTH_STEPS)[number];

export type DesktopAppearanceCommand =
  | `setThemeMode:${DesktopAppearanceMode}`
  | `setThemeDepth:${DesktopThemeDepthStep}`
  | `setAccent:${DesktopAccent}`;

export function isDesktopAppearanceCommand(command: string): command is DesktopAppearanceCommand {
  return /^(setThemeMode|setThemeDepth|setAccent):/.test(command);
}

export type DesktopMenuCommand =
  | DesktopAppearanceCommand
  | 'toggleExplorer'
  | 'rename'
  | 'toggleTheme'
  | 'toggleOutline'
  | 'toggleSourceMode'
  | 'toggleFullWidth'
  | 'toggleTableWrap'
  | 'toggleViewChanges'
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
  viewChanges: boolean;
  hasActiveDocument: boolean;
  /** True when the active tab is a Markdown document; gates the Markdown menu. */
  isMarkdownDocument: boolean;
  themeMode: DesktopAppearanceMode;
  /** 0–100; the menu checks the nearest depth preset. */
  themeDepth: number;
  accent: DesktopAccent;
}

export interface WorkspaceApi {
  openFolder(): Promise<import('@easyview/contracts').OperationResult<DesktopWorkspaceState | null>>;
  openRecentFolder(folderPath: string): Promise<import('@easyview/contracts').OperationResult<DesktopWorkspaceState | null>>;
  getRecentFolders(): Promise<import('@easyview/contracts').OperationResult<import('./workspace').RecentFolder[]>>;
  removeRecentFolder(folderPath: string): Promise<import('@easyview/contracts').OperationResult<boolean>>;
  onRootChanged(listener: (state: DesktopWorkspaceState) => void): { unsubscribe(): void };
  getState(): Promise<import('@easyview/contracts').OperationResult<DesktopWorkspaceState>>;
  setState(state: DesktopWorkspaceState): Promise<import('@easyview/contracts').OperationResult<DesktopWorkspaceState>>;
  readDirectory(relativePath: string): Promise<import('@easyview/contracts').OperationResult<WorkspaceEntry[]>>;
  search(query: string): Promise<import('@easyview/contracts').OperationResult<import('@easyview/contracts').WorkspaceSearchResult>>;
  getSortMode(): Promise<import('@easyview/contracts').OperationResult<import('./workspace').WorkspaceTreeSortMode>>;
  setSortMode(sortMode: import('./workspace').WorkspaceTreeSortMode): Promise<import('@easyview/contracts').OperationResult<import('./workspace').WorkspaceTreeSortMode>>;
  getEntrySize(relativePath: string): Promise<import('@easyview/contracts').OperationResult<number>>;
  getShowSizeHover(): Promise<import('@easyview/contracts').OperationResult<boolean>>;
  setShowSizeHover(showSizeHover: boolean): Promise<import('@easyview/contracts').OperationResult<boolean>>;
  getShowSize(): Promise<import('@easyview/contracts').OperationResult<boolean>>;
  setShowSize(showSize: boolean): Promise<import('@easyview/contracts').OperationResult<boolean>>;
  getShowCreatedAt(): Promise<import('@easyview/contracts').OperationResult<boolean>>;
  setShowCreatedAt(showCreatedAt: boolean): Promise<import('@easyview/contracts').OperationResult<boolean>>;
  getShowUpdatedAt(): Promise<import('@easyview/contracts').OperationResult<boolean>>;
  setShowUpdatedAt(showUpdatedAt: boolean): Promise<import('@easyview/contracts').OperationResult<boolean>>;
  getShowDotEntries(): Promise<import('@easyview/contracts').OperationResult<boolean>>;
  setShowDotEntries(showDotEntries: boolean): Promise<import('@easyview/contracts').OperationResult<boolean>>;
  getShowTimestampHover(): Promise<import('@easyview/contracts').OperationResult<boolean>>;
  setShowTimestampHover(showTimestampHover: boolean): Promise<import('@easyview/contracts').OperationResult<boolean>>;
  create(request: WorkspaceCreateRequest): Promise<import('@easyview/contracts').OperationResult<WorkspaceEntry>>;
  rename(request: WorkspaceRenameRequest): Promise<import('@easyview/contracts').OperationResult<WorkspaceEntry>>;
  move(request: import('./workspace').WorkspaceMoveRequest): Promise<import('@easyview/contracts').OperationResult<WorkspaceEntry>>;
  reorder(request: import('./workspace').WorkspaceReorderRequest): Promise<import('@easyview/contracts').OperationResult<boolean>>;
  delete(request: WorkspaceDeleteRequest): Promise<import('@easyview/contracts').OperationResult<boolean>>;
  copyClipboard(relativePaths: string[]): Promise<import('@easyview/contracts').OperationResult<boolean>>;
  pasteClipboard(request: WorkspacePasteRequest): Promise<import('@easyview/contracts').OperationResult<WorkspaceEntry>>;
  importExternal(request: WorkspaceImportExternalRequest): Promise<import('@easyview/contracts').OperationResult<WorkspaceEntry>>;
  getResourcePaths(relativePath: string): Promise<import('@easyview/contracts').OperationResult<WorkspaceResourcePaths>>;
  /** Copy actions apply to `selectedRelativePaths` when it contains the clicked entry. */
  showContextMenu(relativePath: string, kind: WorkspaceEntry['kind'], selectedRelativePaths: string[]): Promise<import('@easyview/contracts').OperationResult<boolean>>;
  /** Native type picker anchored at screen coordinates (button bottom-left). */
  popupNewFileMenu(parentRelativePath: string, x: number, y: number): Promise<import('@easyview/contracts').OperationResult<boolean>>;
  openEntry(relativePath: string): Promise<import('@easyview/contracts').OperationResult<boolean>>;
  onChanged(listener: (relativePaths: string[] | null) => void): { unsubscribe(): void };
  onContextCommand(listener: (command: WorkspaceContextCommand, relativePath: string, detail?: string) => void): { unsubscribe(): void };
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
