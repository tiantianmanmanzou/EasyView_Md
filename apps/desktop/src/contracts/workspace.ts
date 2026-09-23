import type {
  WorkspaceCreateRequest as SharedWorkspaceCreateRequest,
  WorkspaceDeleteRequest as SharedWorkspaceDeleteRequest,
  WorkspaceEntry as SharedWorkspaceEntry,
  WorkspaceEntryKind as SharedWorkspaceEntryKind,
  WorkspaceMoveRequest as SharedWorkspaceMoveRequest,
  WorkspaceRenameRequest as SharedWorkspaceRenameRequest,
  WorkspaceTreeSortMode as SharedWorkspaceTreeSortMode,
} from '@easyview/contracts';
import type { PreviewRoute } from './preview';

/** Desktop IPC entry shape — same fields as shared core (+ host may ignore id/rootId). */
export type WorkspaceEntryKind = SharedWorkspaceEntryKind;
export type WorkspaceEntry = SharedWorkspaceEntry;
export type WorkspaceCreateRequest = SharedWorkspaceCreateRequest;
export type WorkspaceRenameRequest = SharedWorkspaceRenameRequest;
export type WorkspaceMoveRequest = SharedWorkspaceMoveRequest;
export type WorkspaceTreeSortMode = SharedWorkspaceTreeSortMode;
export type WorkspaceDeleteRequest = Pick<SharedWorkspaceDeleteRequest, 'relativePath'> & {
  options?: SharedWorkspaceDeleteRequest['options'];
};

export interface WorkspaceReorderRequest {
  parentRelativePath: string;
  movedName: string;
  siblingNames: string[];
  beforeName?: string;
}

export interface WorkspaceSnapshot {
  rootPath: string | null;
  entries: WorkspaceEntry[];
}

export interface PersistedEditorTab {
  id: string;
  kind: 'editor';
  filePath: string;
}

export interface PersistedPreviewTab {
  id: string;
  kind: 'preview';
  relativePath: string;
}

export type PersistedDesktopTab = PersistedEditorTab | PersistedPreviewTab;

export interface DesktopEditorTab extends PersistedEditorTab {
  fileName: string;
  dirty: boolean;
  /** Stable identity shared by every view of the same document. */
  documentKey: string;
}

export interface DesktopPreviewTab extends PersistedPreviewTab {
  fileName: string;
  route: PreviewRoute;
}

export type DesktopTab = DesktopEditorTab | DesktopPreviewTab;

export interface DesktopEditorGroupSnapshot {
  id: string;
  tabs: DesktopTab[];
  activeTabId: string | null;
}

export type DesktopEditorGroupLayout =
  | { kind: 'group'; groupId: string }
  | {
    kind: 'split';
    orientation: 'horizontal' | 'vertical';
    first: DesktopEditorGroupLayout;
    second: DesktopEditorGroupLayout;
  };

export type DesktopSplitDirection = 'up' | 'down' | 'left' | 'right';

/**
 * Window -> editor-groups -> tabs snapshot. `tabs` and `activeTabId` mirror the
 * active group so the current single-surface renderer remains source-compatible.
 */
export interface DesktopTabSnapshot {
  windowId: string;
  groups: DesktopEditorGroupSnapshot[];
  activeGroupId: string;
  layout: DesktopEditorGroupLayout;
  tabs: DesktopTab[];
  activeTabId: string | null;
  /** False until editor-core accepts an explicit DOM root per instance. */
  splitRenderingAvailable: boolean;
}

export interface DesktopWorkspaceState {
  rootPath: string | null;
  openTabs: PersistedDesktopTab[];
  activeTabId: string | null;
  editorGroups?: Array<{ id: string; openTabs: PersistedDesktopTab[]; activeTabId: string | null }>;
  activeEditorGroupId?: string;
  editorGroupLayout?: DesktopEditorGroupLayout;
  expandedRelativePaths: string[];
  explorerVisible: boolean;
  outlineVisible: boolean;
  explorerWidth: number;
  outlineWidth: number;
}

export interface WorkspaceCopyRequest {
  sourceRelativePath: string;
  targetParentRelativePath: string;
}

export interface WorkspacePasteRequest {
  /** Selected entry: directories paste into themselves; files paste into their parent. */
  targetRelativePath: string;
}

export interface WorkspaceResourcePaths {
  resourceUri: string;
  absolutePath: string;
  relativePath: string;
}

export type WorkspaceContextCommand =
  | 'openPreview'
  | 'openWith'
  | 'openDefault'
  | 'reveal'
  | 'copy'
  | 'paste'
  | 'copyPath'
  | 'copyRelativePath'
  | 'rename'
  | 'delete';

export type DesktopTabContextCommand =
  | 'close'
  | 'closeOthers'
  | 'closeAll'
  | 'copyPath'
  | 'copyRelativePath'
  | 'splitUp'
  | 'splitDown'
  | 'splitLeft'
  | 'splitRight'
  | 'moveNewWindow';
