import type { WorkspaceTreeSortMode } from './workspace';

/**
 * Display labels for {@link WorkspaceTreeSortMode}, shared by the Desktop DOM tree and the
 * VS Code/Cursor Extension sidebar webview tree so both sort menus read identically.
 */
export const WORKSPACE_TREE_SORT_MODE_LABELS: Record<WorkspaceTreeSortMode, string> = {
  created: 'Sort by Created Time',
  name: 'Sort by Name',
  custom: 'Custom',
};

/**
 * Lenient, non-throwing relative-path normalization for the tree View layer (Desktop DOM tree,
 * Extension webview tree). Views only use this for local bookkeeping — comparing cache keys and
 * building IPC/message request payloads — over paths that a Gateway has already produced or
 * validated. It intentionally does not reject `..` segments or absolute paths the way
 * `normalizeWorkspaceRelativePath` in `@easyview/node-runtime` does; that stricter validation
 * belongs to the Gateway/Service layer, not the View.
 */
export function normalizeWorkspaceViewRelativePath(value: string): string {
  return value.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/$/, '');
}

/** Parent of a View-layer relative path; see {@link normalizeWorkspaceViewRelativePath}. */
export function parentOfWorkspaceViewRelativePath(value: string): string {
  const normalized = normalizeWorkspaceViewRelativePath(value);
  const index = normalized.lastIndexOf('/');
  return index < 0 ? '' : normalized.slice(0, index);
}

/**
 * Selection range covering the base-name portion of a rename/create input's current value
 * (excluding a trailing `.ext`), matching the rename UX both tree Views use when focusing the
 * input. Returns `[start, end]` for `HTMLInputElement.setSelectionRange`.
 *
 * Deliberately takes/returns plain data instead of an `HTMLInputElement` — `@easyview/contracts`
 * is also imported by `@easyview/node-runtime`, which has no DOM lib in its TypeScript program.
 */
export function workspaceEntryNameSelectionRange(value: string): [start: number, end: number] {
  const dot = value.lastIndexOf('.');
  return [0, dot > 0 ? dot : value.length];
}
