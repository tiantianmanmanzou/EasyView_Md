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

export function rememberFirstRowStickyDefault(sticky: boolean): void {
  firstRowStickyDefault = sticky;
  const vscode = (window as any).__vscodeApi;
  vscode?.postMessage?.({ type: 'setTableFirstRowStickyDefault', sticky });
}
