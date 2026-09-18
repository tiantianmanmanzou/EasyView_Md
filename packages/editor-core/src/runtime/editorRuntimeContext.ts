import type { EditorHostTransport } from '@easyview/contracts';
import type { EditorView } from 'prosemirror-view';

/**
 * Runtime dependencies needed by editor modules that operate on the active
 * ProseMirror view or communicate with the owning host.
 */
export interface EditorRuntimeContext {
  getEditorView(): EditorView | null;
  readonly host: EditorHostTransport;
}

export function createEditorRuntimeContext(
  view: EditorView,
  host: EditorHostTransport,
): EditorRuntimeContext {
  return {
    getEditorView: () => view,
    host,
  };
}
