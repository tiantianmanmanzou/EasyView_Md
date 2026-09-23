import type { WorkspaceEntryKind } from './workspace';

/** Drop placement relative to a tree row (Desktop / Webview shared). */
export type WorkspaceTreeDropMode = 'before' | 'into';

/**
 * Resolve insert-before vs nest-into from pointer Y within a row.
 * Directory top ~30% → before; otherwise into. Non-directories always before.
 */
export function resolveWorkspaceTreeDropMode(
  kind: WorkspaceEntryKind,
  clientY: number,
  rowTop: number,
  rowHeight: number,
): WorkspaceTreeDropMode {
  if (kind !== 'directory') return 'before';
  const ratio = rowHeight <= 0 ? 0.5 : (clientY - rowTop) / rowHeight;
  return ratio < 0.3 ? 'before' : 'into';
}
