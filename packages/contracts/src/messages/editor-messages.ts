import type { AiChatAttachment, AiChatHistoryEntry, AiChatSettings } from '../ai/ai-chat';
import type { XlsxTablePayload } from '../export/xlsx-export';

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

export interface DocumentUpdatePayload {
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

export type EditorToHostMessage =
  | ({ type: 'edit'; content: string } & EditorSettingsPayload)
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
  | { type: 'rename'; newName: string }
  | { type: 'getImageBase64'; requestId: string; originalSrc: string }
  | { type: 'openLink'; url?: string; href?: string }
  | { type: 'showInfo'; text: string }
  | { type: 'pickImage'; pos?: number }
  | { type: 'dropImages'; paths: string[]; pos?: number }
  | { type: 'pasteImage'; dataUrl: string; mimeType?: string; name?: string; pos?: number }
  | { type: 'exportPdfBase64'; data: string }
  | { type: 'exportDocx'; title: string; markdown: string; mermaidImages: Array<{ source: string; pngBase64: string; width: number; height: number }>; asciiImages: Array<{ source: string; pngBase64: string; width: number; height: number }> }
  | { type: 'exportXlsx'; payload: XlsxTablePayload; fileName: string }
  | { type: 'exportHtml'; html: string; images: ExportImagePayload[] }
  | { type: 'aiChat.send'; requestId: string; mode: 'chat' | 'agent'; model: string; userMessage: string; attachments: AiChatAttachment[]; history: AiChatHistoryEntry[]; documentContent?: string; documentFileName?: string }
  | { type: 'aiChat.abort'; requestId: string }
  | { type: 'aiChat.getSettings'; requestId: string }
  | { type: 'aiChat.saveSettings'; requestId: string; settings: AiChatSettings }
  | { type: 'aiChat.saveApiKey'; requestId: string; apiKey: string }
  | { type: 'aiChat.pickImage' }
  | { type: 'productThemeChanged'; mode: 'light' | 'gray' | 'dark' };

export type HostToEditorMessage =
  | ({ type: 'init' } & DocumentUpdatePayload)
  | ({ type: 'documentChanged' } & DocumentUpdatePayload)
  | { type: 'gitStatusChanged'; lineRanges: GitLineRangePayload[]; content: string }
  | { type: 'commitMessageGenerated'; message: string; source?: string }
  | { type: 'commitMessageGenerationFailed'; message: string }
  | { type: 'stageFileCompleted'; message: string }
  | { type: 'stageFileFailed'; message: string }
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
  | { type: 'terminalError'; message: string }
  | { type: 'aiChat.delta'; requestId: string; text?: string; reasoning?: string }
  | { type: 'aiChat.done'; requestId: string; content: string; reasoning?: string; finishReason?: string }
  | { type: 'aiChat.error'; requestId: string; message: string; aborted?: boolean }
  | { type: 'aiChat.settingsResponse'; requestId: string; settings: AiChatSettings; hasApiKey: boolean }
  | { type: 'aiChat.settingsSaved'; requestId: string; ok: boolean; message?: string }
  | { type: 'aiChat.imagePicked'; images: Array<{ name: string; dataUrl: string }> }
  | { type: 'setProductTheme'; mode: 'light' | 'gray' | 'dark' };

export type EditorMessageHandler = (message: EditorToHostMessage) => void;


const EDITOR_MESSAGE_TYPES = new Set<EditorToHostMessage['type']>([
  'edit',
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
  'aiChat.send',
  'aiChat.abort',
  'aiChat.getSettings',
  'aiChat.saveSettings',
  'aiChat.saveApiKey',
  'aiChat.pickImage',
  'productThemeChanged',
]);

export function isEditorToHostMessage(value: unknown): value is EditorToHostMessage {
  if (!value || typeof value !== 'object' || !('type' in value)) return false;
  const type = (value as { type?: unknown }).type;
  return typeof type === 'string' && EDITOR_MESSAGE_TYPES.has(type as EditorToHostMessage['type']);
}
