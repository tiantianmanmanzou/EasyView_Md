import type { EditorSourceDocumentRequest } from '@easyview/contracts';

/** Optional host-native actions kept outside the platform-neutral editor message protocol. */
export interface EasyViewEditorHostActions {
  openSourceDocument?(request: EditorSourceDocumentRequest): void;
  persistOpenEditorShortcut?(shortcut: string): void;
}
