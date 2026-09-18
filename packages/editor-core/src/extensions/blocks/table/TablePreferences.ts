import type { EditorRuntimeContext } from '../../../runtime/editorRuntimeContext';

/**
 * Workspace-level defaults for tables created in the EasyView editor.
 * Explicit attributes already present in a document always take precedence.
 */
let firstRowStickyDefault = false;

export function getFirstRowStickyDefault(): boolean {
  return firstRowStickyDefault;
}

export function setFirstRowStickyDefault(sticky: boolean): void {
  firstRowStickyDefault = sticky;
}

export function rememberFirstRowStickyDefault(
  sticky: boolean,
  runtime: EditorRuntimeContext,
): void {
  firstRowStickyDefault = sticky;
  void runtime.host.postMessage({ type: 'setTableFirstRowStickyDefault', sticky });
}
