import type { WorkspaceTreeSortMode } from './workspace';
import type { WorkspaceTreeMenuIconId } from './workspace-tree-menu-icons';

/**
 * Display labels for {@link WorkspaceTreeSortMode}, shared by the Desktop DOM tree and the
 * VS Code/Cursor Extension sidebar webview tree so both sort menus read identically.
 */
export const WORKSPACE_TREE_SORT_MODE_LABELS: Record<WorkspaceTreeSortMode, string> = {
  created: 'Sort by Created Time',
  name: 'Sort by Name',
  custom: 'Custom',
};

export const WORKSPACE_TREE_SORT_MODE_ICONS: Record<WorkspaceTreeSortMode, WorkspaceTreeMenuIconId> = {
  created: 'sortCreated',
  name: 'sortName',
  custom: 'sortCustom',
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

/** Minimal shape a tree row needs for visibility/selection walks. */
export interface WorkspaceTreeViewEntryLike {
  relativePath: string;
  kind: string;
}

/**
 * Depth-first list of every relative path currently visible in the tree (root entries plus
 * children of expanded directories, in render order). Desktop's DOM tree and the Extension
 * webview tree both walk `entriesByDirectory` this same way to compute the range for shift-click
 * multi-select.
 */
export function collectVisibleWorkspaceTreeRelativePaths(
  entriesByDirectory: ReadonlyMap<string, readonly WorkspaceTreeViewEntryLike[]>,
  isExpanded: (relativePath: string) => boolean,
): string[] {
  const paths: string[] = [];
  const walk = (directoryRelativePath: string): void => {
    for (const entry of entriesByDirectory.get(directoryRelativePath) ?? []) {
      paths.push(entry.relativePath);
      if (entry.kind === 'directory' && isExpanded(entry.relativePath)) walk(entry.relativePath);
    }
  };
  walk('');
  return paths;
}

/** Current multi-selection for a workspace tree View. */
export interface WorkspaceTreeSelectionState {
  selected: ReadonlySet<string>;
  anchor: string | null;
}

export interface WorkspaceTreeSelectionInput {
  /** Relative path of the row that was just clicked (or context-menu'd, etc.). */
  target: string;
  /** Depth-first visible paths, from {@link collectVisibleWorkspaceTreeRelativePaths}. */
  visible: readonly string[];
  shiftKey?: boolean;
  /** Combined metaKey/ctrlKey ("toggle one row in/out of the selection"). */
  toggleKey?: boolean;
}

/**
 * Multi-select algorithm shared by Desktop's DOM tree and the Extension webview tree:
 * - Shift+click extends the range from the current anchor to the target (falls back to a plain
 *   single selection if the anchor or target isn't currently visible).
 * - Meta/Ctrl+click toggles the target in/out of the existing selection.
 * - A plain click replaces the selection with just the target.
 * In every case the target becomes (or stays) the anchor, except the "extend range" case, which
 * keeps the original anchor so repeated shift-clicks keep extending from the same point.
 */
export function computeNextWorkspaceTreeSelection(
  current: WorkspaceTreeSelectionState,
  input: WorkspaceTreeSelectionInput,
): WorkspaceTreeSelectionState {
  const { target, visible, shiftKey, toggleKey } = input;

  if (shiftKey && current.anchor) {
    const anchorIndex = visible.indexOf(current.anchor);
    const targetIndex = visible.indexOf(target);
    if (anchorIndex >= 0 && targetIndex >= 0) {
      const [from, to] = anchorIndex < targetIndex ? [anchorIndex, targetIndex] : [targetIndex, anchorIndex];
      return { selected: new Set(visible.slice(from, to + 1)), anchor: current.anchor };
    }
    return { selected: new Set([target]), anchor: target };
  }

  if (toggleKey) {
    const next = new Set(current.selected);
    if (next.has(target)) next.delete(target);
    else next.add(target);
    return { selected: next, anchor: target };
  }

  return { selected: new Set([target]), anchor: target };
}

/** Keyboard command shared by Desktop's DOM tree and the Extension webview tree. */
export type WorkspaceTreeKeyAction = 'rename' | 'copy' | 'paste' | 'delete';

export interface WorkspaceTreeKeyEventLike {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
}

export interface WorkspaceTreeKeyActionInput {
  /** True when the event target is an in-tree rename/create input. */
  targetIsEditable: boolean;
  /** True when at least one row is selected (copy / delete). */
  hasSelection: boolean;
  /** True when a primary/rename target is selected. Defaults to {@link hasSelection}. */
  hasPrimarySelection?: boolean;
}

/**
 * Maps a tree keydown to a host-agnostic action. Views keep their own clipboard
 * and delete implementations; this only decides *whether* a shortcut fires.
 *
 * - F2 / Enter → rename (needs a primary selection)
 * - Cmd/Ctrl+C → copy (needs any selection)
 * - Cmd/Ctrl+V → paste (always, even with an empty selection — paste into root)
 * - Delete / Cmd+Backspace → delete (needs any selection)
 */
export function resolveWorkspaceTreeKeyAction(
  event: WorkspaceTreeKeyEventLike,
  input: WorkspaceTreeKeyActionInput,
): WorkspaceTreeKeyAction | null {
  if (input.targetIsEditable) return null;
  const hasPrimary = input.hasPrimarySelection ?? input.hasSelection;
  if ((event.key === 'F2' || event.key === 'Enter') && hasPrimary) return 'rename';
  const modifier = event.metaKey || event.ctrlKey;
  if (modifier && event.key.toLowerCase() === 'c' && input.hasSelection) return 'copy';
  if (modifier && event.key.toLowerCase() === 'v') return 'paste';
  const deleteShortcut = event.key === 'Delete' || (event.key === 'Backspace' && event.metaKey);
  if (deleteShortcut && input.hasSelection) return 'delete';
  return null;
}
