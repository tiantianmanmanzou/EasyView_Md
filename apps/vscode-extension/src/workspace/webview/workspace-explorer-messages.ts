import type { WorkspaceEntry, WorkspaceEntryKind, WorkspaceTreeSortMode } from '@easyview/contracts';

/** Serializable tree row for the sidebar webview (host adds writable). */
export interface WorkspaceExplorerEntry extends WorkspaceEntry {
  writable: boolean;
}

export interface WorkspaceExplorerSortConfig {
  sortMode: WorkspaceTreeSortMode;
  showCreatedAt: boolean;
  showUpdatedAt: boolean;
  showDotEntries: boolean;
  showTimestampHover: boolean;
}

export type WorkspaceExplorerRequest =
  | { type: 'ready' }
  | { type: 'listChildren'; requestId: string; relativePath: string }
  | { type: 'setExpanded'; relativePath: string; expanded: boolean }
  | { type: 'setSelection'; relativePaths: string[]; anchorRelativePath: string | null }
  | { type: 'setInputFocus'; focused: boolean }
  | { type: 'open'; relativePath: string }
  | { type: 'openExternal'; relativePath: string }
  | { type: 'revealInOS'; relativePath: string }
  | { type: 'create'; requestId: string; parentRelativePath: string; name: string; kind: 'file' | 'directory' }
  | { type: 'rename'; requestId: string; relativePath: string; newName: string }
  | { type: 'delete'; requestId: string; relativePaths: string[] }
  | { type: 'move'; requestId: string; relativePath: string; targetParentRelativePath: string }
  | {
      type: 'reorder';
      requestId: string;
      parentRelativePath: string;
      movedName: string;
      siblingNames: string[];
      beforeName?: string;
    }
  | { type: 'copy'; requestId: string; relativePaths: string[] }
  | { type: 'paste'; requestId: string; targetParentRelativePath: string }
  | { type: 'copyPath'; relativePaths: string[] }
  | { type: 'copyRelativePath'; relativePaths: string[] }
  | { type: 'getSortConfig'; requestId: string }
  | { type: 'setSortMode'; requestId: string; sortMode: WorkspaceTreeSortMode }
  | { type: 'setShowCreatedAt'; requestId: string; showCreatedAt: boolean }
  | { type: 'setShowUpdatedAt'; requestId: string; showUpdatedAt: boolean }
  | { type: 'setShowDotEntries'; requestId: string; showDotEntries: boolean }
  | { type: 'setShowTimestampHover'; requestId: string; showTimestampHover: boolean }
  | { type: 'collapseAll' }
  | { type: 'refresh' }
  | { type: 'showError'; message: string };

export type WorkspaceExplorerEvent =
  | {
      type: 'bootstrap';
      rootName: string | null;
      rootUri: string | null;
      sort: WorkspaceExplorerSortConfig;
      revealRelativePath: string | null;
      hasClipboard: boolean;
    }
  | {
      type: 'listChildrenResult';
      requestId: string;
      ok: true;
      relativePath: string;
      entries: WorkspaceExplorerEntry[];
    }
  | {
      type: 'listChildrenResult';
      requestId: string;
      ok: false;
      relativePath: string;
      message: string;
    }
  | { type: 'fsChanged'; relativePaths: string[] }
  | { type: 'reveal'; relativePath: string }
  | { type: 'rootChanged' }
  | { type: 'sortConfig'; sort: WorkspaceExplorerSortConfig }
  | { type: 'clipboardChanged'; hasClipboard: boolean }
  | { type: 'contextCommand'; command: 'rename' | 'paste' | 'beginCreateFile' | 'beginCreateFolder' | 'toggleSortMenu' | 'refresh' | 'collapseAll'; relativePath?: string }
  | {
      type: 'opResult';
      requestId: string;
      ok: true;
      entry?: WorkspaceExplorerEntry;
      sort?: WorkspaceExplorerSortConfig;
      siblingNames?: string[];
    }
  | { type: 'opResult'; requestId: string; ok: false; message: string };

export function isWorkspaceExplorerRequest(value: unknown): value is WorkspaceExplorerRequest {
  return Boolean(value && typeof value === 'object' && typeof (value as { type?: unknown }).type === 'string');
}

export type { WorkspaceEntryKind, WorkspaceTreeSortMode };
