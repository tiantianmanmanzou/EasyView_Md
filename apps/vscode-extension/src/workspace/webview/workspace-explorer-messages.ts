import type { WorkspaceEntry, WorkspaceEntryKind, WorkspaceTreeSortMode } from '@easyview/contracts';

/** Serializable tree row for the sidebar webview (host adds writable). */
export interface WorkspaceExplorerEntry extends WorkspaceEntry {
  writable: boolean;
}

export interface WorkspaceExplorerSortConfig {
  sortMode: WorkspaceTreeSortMode;
  showCreatedAt: boolean;
  showUpdatedAt: boolean;
  showSize: boolean;
  showSizeHover: boolean;
  showDotEntries: boolean;
  showTimestampHover: boolean;
}

export type WorkspaceExplorerRequest =
  | { type: 'ready' }
  | { type: 'focusContextMenu'; requestId: string }
  | { type: 'listChildren'; requestId: string; relativePath: string }
  | { type: 'search'; requestId: string; query: string }
  | { type: 'setExpanded'; relativePath: string; expanded: boolean }
  | { type: 'setSelection'; relativePaths: string[]; anchorRelativePath: string | null }
  | { type: 'setInputFocus'; focused: boolean }
  | { type: 'open'; relativePath: string }
  | { type: 'openExternal'; relativePath: string }
  | { type: 'convertToMarkdown'; relativePath: string }
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
  | {
      type: 'importExternal';
      requestId: string;
      targetParentRelativePath: string;
      sourceUris?: string[];
      items?: Array<{ kind: 'file' | 'directory'; relativePath: string; dataBase64?: string }>;
    }
  | { type: 'copyFile'; relativePaths: string[] }
  | { type: 'copyPath'; relativePaths: string[] }
  | { type: 'copyRelativePath'; relativePaths: string[] }
  | { type: 'getSortConfig'; requestId: string }
  | { type: 'setSortMode'; requestId: string; sortMode: WorkspaceTreeSortMode }
  | { type: 'getEntrySize'; requestId: string; relativePath: string }
  | { type: 'setShowSizeHover'; requestId: string; showSizeHover: boolean }
  | { type: 'setShowSize'; requestId: string; showSize: boolean }
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
      /** Folders the user left expanded last time for this root. */
      expandedRelativePaths: string[];
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
      missing?: boolean;
    }
  | { type: 'searchResult'; requestId: string; ok: true; entries: WorkspaceExplorerEntry[]; truncated: boolean }
  | { type: 'searchResult'; requestId: string; ok: false; message: string }
  | { type: 'fsChanged'; relativePaths: string[] }
  | { type: 'entriesDeleted'; relativePaths: string[] }
  | { type: 'reveal'; relativePath: string; force?: boolean }
  | { type: 'rootChanged' }
  | { type: 'sortConfig'; sort: WorkspaceExplorerSortConfig }
  | { type: 'clipboardChanged'; hasClipboard: boolean }
  | { type: 'contextCommand'; command: 'rename' | 'paste' | 'beginCreateFile' | 'beginCreateFolder' | 'toggleSortMenu' | 'toggleSearch' | 'refresh' | 'collapseAll'; relativePath?: string; extension?: string }
  | {
      type: 'opResult';
      requestId: string;
      ok: true;
      entry?: WorkspaceExplorerEntry;
      sort?: WorkspaceExplorerSortConfig;
      siblingNames?: string[];
      sizeBytes?: number;
    }
  | { type: 'opResult'; requestId: string; ok: false; message: string };

export function isWorkspaceExplorerRequest(value: unknown): value is WorkspaceExplorerRequest {
  return Boolean(value && typeof value === 'object' && typeof (value as { type?: unknown }).type === 'string');
}

export type { WorkspaceEntryKind, WorkspaceTreeSortMode };
