import type { XlsxTablePayload } from './xlsxExport';

export interface EditorSettingsPayload {
  fullWidth: boolean;
  tocVisible: boolean;
  tableWrap: boolean;
}

export interface GitLineRangePayload {
  startLine: number;
  endLine: number;
  kind: 'modified' | 'added';
}

export interface ImagePayload {
  src: string;
  originalSrc: string;
}

export interface ExportImagePayload {
  originalSrc: string;
  exportFilename: string;
  isExternal: boolean;
}

export interface TerminalAppearancePayload {
  fontFamily?: string;
  fontSize?: number;
  lineHeight?: number;
  fontWeight?: string;
  fontWeightBold?: string;
  letterSpacing?: number;
}

interface DocumentUpdatePayload {
  content: string;
  imagePathMap?: Record<string, string>;
  isUndoRedo?: boolean;
  skipAutoScroll?: boolean;
  filename?: string;
  filePath?: string;
  fullWidth?: boolean;
  tocVisible?: boolean;
  tableWrap?: boolean;
  gitLineRanges?: GitLineRangePayload[];
  tableFirstRowStickyDefault?: boolean;
  initialCursorLine?: number;
  initialCursorCharacter?: number;
  initialTotalLines?: number;
  terminalAppearance?: TerminalAppearancePayload;
}

export type WebviewToHostMessage =
  | ({ type: 'edit'; content: string } & EditorSettingsPayload)
  | ({ type: 'openNativeSourceMode'; content?: string; line?: number; character?: number } & EditorSettingsPayload)
  | { type: 'requestTabCompletion'; requestId: string; line: number; character: number; wordPrefix: string }
  | { type: 'setTableFirstRowStickyDefault'; sticky: boolean }
  | { type: 'ready' }
  | { type: 'copyTextToClipboard'; text: string; successMessage?: string }
  | { type: 'openTerminal' }
  | { type: 'terminalInput'; data: string }
  | { type: 'terminalResize'; cols: number; rows: number }
  | { type: 'terminalClose' }
  | { type: 'openWithDebugLog'; stage: string; meta?: Record<string, unknown> }
  | { type: 'rowResizeDebug'; stage: string; data: Record<string, unknown> }
  | { type: 'save' }
  | { type: 'webviewRuntimeError'; source: string; message: string; stack?: string }
  | { type: 'stageFile' }
  | { type: 'generateCommitMessage' }
  | { type: 'commitFile'; message: string }
  | { type: 'syncFile'; message: string }
  | { type: 'syncOpenEditorShortcut'; shortcut: string }
  | { type: 'openWithEasyView' }
  | { type: 'rename'; newName: string }
  | { type: 'getImageBase64'; requestId: string; originalSrc: string }
  | { type: 'openLink'; url?: string; href?: string }
  | { type: 'showInfo'; text: string }
  | { type: 'pickImage'; pos?: number }
  | { type: 'dropImages'; paths: string[]; pos?: number }
  | { type: 'pasteImage'; dataUrl: string; mimeType?: string; name?: string; pos?: number }
  | { type: 'exportPdfBase64'; data: string }
  | { type: 'exportDocx'; title: string; markdown: string; mermaidImages: Array<{ source: string; pngBase64: string; width: number; height: number }> }
  | { type: 'exportXlsx'; payload: XlsxTablePayload; fileName: string }
  | { type: 'exportHtml'; html: string; images: ExportImagePayload[] };

export type HostToWebviewMessage =
  | ({ type: 'init' } & DocumentUpdatePayload)
  | ({ type: 'documentChanged' } & DocumentUpdatePayload)
  | { type: 'gitStatusChanged'; lineRanges: GitLineRangePayload[]; content: string }
  | { type: 'commitMessageGenerated'; message: string; source?: string }
  | { type: 'commitMessageGenerationFailed'; message: string }
  | { type: 'commitFileCompleted'; message: string }
  | { type: 'commitFileFailed'; message: string }
  | { type: 'syncFileCompleted'; message: string }
  | { type: 'syncFileFailed'; message: string }
  | { type: 'clipboardCopyCompleted'; message: string }
  | { type: 'clipboardCopyFailed'; message: string }
  | { type: 'focus' }
  | { type: 'revealCursor'; line: number; totalLines?: number }
  | { type: 'fileRenamed'; fileName: string }
  | { type: 'requestExportHtml'; theme: 'light' | 'dark' }
  | { type: 'requestExportPdf'; theme: 'light' | 'dark' }
  | { type: 'requestExportDocx' }
  | { type: 'imageSelected'; src: string; originalSrc: string; pos?: number }
  | { type: 'imagesDropped'; images: ImagePayload[]; pos?: number }
  | { type: 'imageBase64Response'; requestId: string; base64: string | null }
  | { type: 'tabCompletionResponse'; requestId: string; insertText: string | null; replaceStartCharacter?: number; replaceEndCharacter?: number }
  | { type: 'terminalOpened'; sessionId: string; cwd: string; platform: string; homeDir: string }
  | { type: 'terminalData'; sessionId: string; data: string }
  | { type: 'terminalExit'; sessionId: string; code: number; signal: number | null }
  | { type: 'terminalError'; message: string };

export type WebviewMessageHandler = (message: WebviewToHostMessage) => void;

export interface VscodeWebviewApi {
  postMessage(message: WebviewToHostMessage): void;
}

const WEBVIEW_MESSAGE_TYPES = new Set<WebviewToHostMessage['type']>([
  'edit',
  'openNativeSourceMode',
  'requestTabCompletion',
  'setTableFirstRowStickyDefault',
  'ready',
  'copyTextToClipboard',
  'openTerminal',
  'terminalInput',
  'terminalResize',
  'terminalClose',
  'openWithDebugLog',
  'rowResizeDebug',
  'save',
  'webviewRuntimeError',
  'stageFile',
  'generateCommitMessage',
  'commitFile',
  'syncFile',
  'syncOpenEditorShortcut',
  'openWithEasyView',
  'rename',
  'getImageBase64',
  'openLink',
  'showInfo',
  'pickImage',
  'dropImages',
  'pasteImage',
  'exportPdfBase64',
  'exportDocx',
  'exportXlsx',
  'exportHtml',
]);

export function isWebviewToHostMessage(value: unknown): value is WebviewToHostMessage {
  if (!value || typeof value !== 'object' || !('type' in value)) return false;
  const type = (value as { type?: unknown }).type;
  return typeof type === 'string' && WEBVIEW_MESSAGE_TYPES.has(type as WebviewToHostMessage['type']);
}

declare global {
  interface Window {
    __vscodeApi?: VscodeWebviewApi;
  }
}
