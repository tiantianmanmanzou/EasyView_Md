import type { EditorSourceDocumentRequest } from '@easyview/contracts';

export type VscodeEditorHostActionMessage =
  | { type: 'vscode.openSourceDocument'; request: EditorSourceDocumentRequest }
  | { type: 'vscode.persistOpenEditorShortcut'; shortcut: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function isVscodeEditorHostActionMessage(value: unknown): value is VscodeEditorHostActionMessage {
  if (!isRecord(value)) return false;
  if (value.type === 'vscode.persistOpenEditorShortcut') {
    return typeof value.shortcut === 'string' && value.shortcut.trim().length > 0;
  }
  if (value.type !== 'vscode.openSourceDocument' || !isRecord(value.request)) return false;
  const request = value.request;
  return typeof request.content === 'string'
    && typeof request.fullWidth === 'boolean'
    && typeof request.tocVisible === 'boolean'
    && typeof request.tableWrap === 'boolean'
    && Number.isInteger(request.line)
    && (request.line as number) >= 0
    && Number.isInteger(request.character)
    && (request.character as number) >= 0;
}
