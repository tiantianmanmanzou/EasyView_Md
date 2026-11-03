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
  /** Pinned tabs lead their group and survive Close Others / Close All. */
  pinned?: boolean;
}

export interface PersistedPreviewTab {
  id: string;
  kind: 'preview';
  relativePath: string;
  pinned?: boolean;
}

export type PersistedDesktopTab = PersistedEditorTab | PersistedPreviewTab;

export interface DesktopEditorTab extends PersistedEditorTab {
  fileName: string;
  dirty: boolean;
  /** Stable identity shared by every view of the same document. */
  documentId?: string;
  /** Normalized path key used only for same-file de-duplication. */
  documentKey: string;
}

export interface DesktopPreviewTab extends PersistedPreviewTab {
  fileName: string;
  route: PreviewRoute;
}

export interface DesktopHistoryTab {
  id: string;
  kind: 'history';
  comparisonKey: string;
  filePath: string;
  fileName: string;
  relativePath: string;
  baseLabel: string;
  contentLabel: string;
  /** History comparisons are transient and never pinned. */
  pinned?: never;
}
export type DesktopTab = DesktopEditorTab | DesktopPreviewTab | DesktopHistoryTab;

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
  /** True once the renderer can mount one editor-core instance per visible pane. */
  splitRenderingAvailable: boolean;
}

export type DesktopExplorerDisplayMode = 'list' | 'icons';

export interface DesktopWorkspaceState {
  rootPath: string | null;
  openTabs: PersistedDesktopTab[];
  activeTabId: string | null;
  editorGroups?: Array<{ id: string; openTabs: PersistedDesktopTab[]; activeTabId: string | null }>;
  activeEditorGroupId?: string;
  editorGroupLayout?: DesktopEditorGroupLayout;
  expandedRelativePaths: string[];
  explorerDisplayMode?: DesktopExplorerDisplayMode;
  /** Folder shown by the icon view; '' is the workspace root. */
  explorerIconDirectory?: string;
  explorerVisible: boolean;
  outlineVisible: boolean;
  explorerWidth: number;
  outlineWidth: number;
  panelLayout?: DesktopPanelLayout;
  versionGuardVisible?: boolean;
  aiChatVisible?: boolean;
  versionGuardWidth?: number;
}

export type DesktopDockSide = 'left' | 'right';
/** Panels docked beside the editor area at window level. */
export type DesktopWorkbenchPanelId = 'explorer' | 'aiChat' | 'versionGuard';
export type DesktopDockPanelId = DesktopWorkbenchPanelId | 'outline';

/**
 * Where each panel is docked. `left` / `right` list window-level panels from the window edge
 * inwards; the outline belongs to every document and only chooses which side of it to sit on.
 */
export interface DesktopPanelLayout {
  left: DesktopWorkbenchPanelId[];
  right: DesktopWorkbenchPanelId[];
  outline: DesktopDockSide;
}

export type DesktopPanelDropTarget =
  | { kind: 'side'; side: DesktopDockSide }
  | { kind: 'swap'; panel: DesktopWorkbenchPanelId };

const WORKBENCH_PANELS: readonly DesktopWorkbenchPanelId[] = ['explorer', 'aiChat', 'versionGuard'];

export function defaultDesktopPanelLayout(): DesktopPanelLayout {
  return { left: ['explorer', 'versionGuard'], right: ['aiChat'], outline: 'right' };
}

export function normalizeDesktopPanelLayout(value: unknown): DesktopPanelLayout {
  const fallback = defaultDesktopPanelLayout();
  if (typeof value !== 'object' || value === null) return fallback;
  const record = value as Record<string, unknown>;
  const seen = new Set<DesktopWorkbenchPanelId>();
  const side = (candidate: unknown): DesktopWorkbenchPanelId[] => {
    const panels: DesktopWorkbenchPanelId[] = [];
    for (const item of Array.isArray(candidate) ? candidate : []) {
      if (!WORKBENCH_PANELS.includes(item) || seen.has(item)) continue;
      seen.add(item);
      panels.push(item);
    }
    return panels;
  };
  const left = side(record.left);
  const right = side(record.right);
  for (const panel of WORKBENCH_PANELS) {
    if (seen.has(panel)) continue;
    if (fallback.left.includes(panel)) left.push(panel);
    else right.push(panel);
  }
  return { left, right, outline: record.outline === 'left' ? 'left' : 'right' };
}

export function desktopPanelSide(layout: DesktopPanelLayout, panel: DesktopDockPanelId): DesktopDockSide {
  if (panel === 'outline') return layout.outline;
  return layout.left.includes(panel) ? 'left' : 'right';
}

/** Docking onto a side places a window-level panel at that window edge; swapping exchanges two panels' slots. */
export function moveDesktopPanel(layout: DesktopPanelLayout, panel: DesktopDockPanelId, target: DesktopPanelDropTarget): DesktopPanelLayout {
  if (panel === 'outline') {
    return target.kind === 'side' ? { ...layout, outline: target.side } : layout;
  }
  if (target.kind === 'swap') {
    if (target.panel === panel) return layout;
    const swap = (list: DesktopWorkbenchPanelId[]) => list.map((item) => (item === panel ? target.panel : item === target.panel ? panel : item));
    return { ...layout, left: swap(layout.left), right: swap(layout.right) };
  }
  const left = layout.left.filter((item) => item !== panel);
  const right = layout.right.filter((item) => item !== panel);
  return target.side === 'left'
    ? { ...layout, left: [panel, ...left], right }
    : { ...layout, left, right: [...right, panel] };
}

export interface RecentFolder {
  path: string;
  name: string;
  /** Parent directory with the home prefix shortened to `~`. */
  displayPath: string;
  /** False when the folder was moved or deleted since it was last opened. */
  exists: boolean;
}

export interface WorkspaceCopyRequest {
  sourceRelativePath: string;
  targetParentRelativePath: string;
}

export interface WorkspacePasteRequest {
  /** Selected entry: directories paste into themselves; files paste into their parent. */
  targetRelativePath: string;
}

export interface WorkspaceImportExternalRequest {
  targetParentRelativePath: string;
  sourcePaths?: string[];
  sourceUris?: string[];
  items?: Array<{ kind: 'file' | 'directory'; relativePath: string; dataBase64?: string }>;
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
  | 'copyFile'
  | 'paste'
  | 'copyPath'
  | 'copyRelativePath'
  | 'rename'
  | 'delete'
  | 'beginCreateFile'
  | 'beginCreateFolder'
  | 'customizeIcon';

export type DesktopTabContextCommand =
  | 'close'
  | 'closeOthers'
  | 'closeAll'
  | 'pin'
  | 'unpin'
  | 'copyPath'
  | 'copyRelativePath'
  | 'revealInIndexArea'
  | 'splitUp'
  | 'splitDown'
  | 'splitLeft'
  | 'splitRight'
  | 'moveNewWindow';
