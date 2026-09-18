import type { EditorState, Transaction } from 'prosemirror-state';
import type { EditorView } from 'prosemirror-view';
import type { Node as ProsemirrorNode } from 'prosemirror-model';

import type { Extension } from './EditorExtension';

/**
 * Configuration shared by EditorCore and its standalone event handlers.
 *
 * Keeping this contract outside EditorCore prevents the event-handler module
 * from depending on the class implementation module.
 */
export interface EditorCoreConfig {
  /** Extension instances */
  extensions: Extension[];

  /** Additional keymaps injected by the host (e.g. Mod-k for link, Mod-s for save) */
  keymaps?: Record<string, (...args: any[]) => boolean>;

  /** Called after every transaction — use for toolbar / ToC / image toolbar updates */
  onDispatch?: (view: EditorView, tr: Transaction, oldState: EditorState) => void;

  /** Called when document content changes — use for syncing back to the host */
  onContentChange?: (markdown: string) => void;

  /** Called when an image node is directly clicked */
  onImageClick?: (view: EditorView, pos: number, node: ProsemirrorNode, dom: HTMLElement) => void;

  /** Called on Ctrl+Click of a link (open externally) */
  onOpenLink?: (href: string) => void;

  /** Called on regular click of a link (show edit popup) */
  onLinkSelect?: (view: EditorView, href: string) => void;

  /** Called when native undo stack is exhausted — return true if cross-mode undo was handled */
  onUndoExhausted?: () => boolean;

  /** Called when native redo stack is exhausted — return true if cross-mode redo was handled */
  onRedoExhausted?: () => boolean;
}
