import { promises as fs } from 'node:fs';
import path from 'node:path';
import { writeFileAtomically } from '@easyview/node-runtime';
import type { DesktopWorkspaceState } from '../../../contracts/workspace';

export interface WindowBounds {
  x?: number;
  y?: number;
  width: number;
  height: number;
}

export interface DesktopAppState {
  windowBounds?: WindowBounds;
  /** Electron zoomLevel (0 = 100%). Same scale as VS Code window.zoomLevel. */
  zoomLevel?: number;
  recentFiles: string[];
  workspace: DesktopWorkspaceState;
}

export interface AppStateStoreOptions {
  saveDelayMs?: number;
  onSaveError?: (error: unknown) => void;
}

export interface AppStateStore {
  load(): Promise<void>;
  save(): Promise<void>;
  scheduleSave(): void;
  getRecentFiles(): string[];
  getWindowBounds(): WindowBounds | undefined;
  getZoomLevel(): number;
  rememberRecentFile(filePath: string): void;
  setWindowBounds(bounds: WindowBounds): void;
  setZoomLevel(level: number): void;
  getWorkspace(): DesktopWorkspaceState;
  setWorkspace(workspace: DesktopWorkspaceState): void;
  dispose(): void;
}

const DEFAULT_SAVE_DELAY_MS = 300;
const MAX_RECENT_FILES = 10;
const MIN_WINDOW_WIDTH = 960;
const MIN_WINDOW_HEIGHT = 640;
/** Match VS Code / Chromium zoomLevel bounds (±5 ≈ 33%–300%). */
export const WINDOW_ZOOM_LEVEL_MIN = -5;
export const WINDOW_ZOOM_LEVEL_MAX = 5;
const DEFAULT_WORKSPACE_STATE: DesktopWorkspaceState = {
  rootPath: null,
  openTabs: [],
  activeTabId: null,
  expandedRelativePaths: [],
  explorerVisible: true,
  outlineVisible: true,
  explorerWidth: 280,
  outlineWidth: 280,
};

class DesktopAppStateStore implements AppStateStore {
  private readonly statePath: string;
  private readonly saveDelayMs: number;
  private readonly onSaveError: (error: unknown) => void;
  private state: DesktopAppState = { recentFiles: [], workspace: { ...DEFAULT_WORKSPACE_STATE } };
  private saveTimer: NodeJS.Timeout | undefined;

  constructor(userDataPath: string, options: AppStateStoreOptions = {}) {
    this.statePath = path.join(userDataPath, 'desktop-state.json');
    this.saveDelayMs = options.saveDelayMs ?? DEFAULT_SAVE_DELAY_MS;
    this.onSaveError = options.onSaveError ?? (() => undefined);
  }

  async load(): Promise<void> {
    try {
      const parsed = JSON.parse(await fs.readFile(this.statePath, 'utf8')) as Partial<DesktopAppState>;
      this.state = {
        recentFiles: Array.isArray(parsed.recentFiles)
          ? parsed.recentFiles
            .filter((value): value is string => typeof value === 'string')
            .slice(0, MAX_RECENT_FILES)
          : [],
        windowBounds: normalizeWindowBounds(parsed.windowBounds),
        zoomLevel: normalizeZoomLevel(parsed.zoomLevel),
        workspace: normalizeWorkspaceState(parsed.workspace),
      };
    } catch {
      this.state = { recentFiles: [], workspace: { ...DEFAULT_WORKSPACE_STATE } };
    }
  }

  async save(): Promise<void> {
    await writeFileAtomically(this.statePath, JSON.stringify(this.state, null, 2));
  }

  scheduleSave(): void {
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      this.saveTimer = undefined;
      void this.save().catch((error) => this.onSaveError(error));
    }, this.saveDelayMs);
  }

  getRecentFiles(): string[] {
    return [...this.state.recentFiles];
  }

  getWindowBounds(): WindowBounds | undefined {
    return this.state.windowBounds ? { ...this.state.windowBounds } : undefined;
  }

  getZoomLevel(): number {
    return this.state.zoomLevel ?? 0;
  }

  rememberRecentFile(filePath: string): void {
    this.state.recentFiles = [
      filePath,
      ...this.state.recentFiles.filter((candidate) => candidate !== filePath),
    ].slice(0, MAX_RECENT_FILES);
    this.scheduleSave();
  }

  setWindowBounds(bounds: WindowBounds): void {
    this.state.windowBounds = { ...bounds };
    this.scheduleSave();
  }

  setZoomLevel(level: number): void {
    this.state.zoomLevel = normalizeZoomLevel(level);
    this.scheduleSave();
  }

  getWorkspace(): DesktopWorkspaceState {
    return {
      ...this.state.workspace,
      openTabs: this.state.workspace.openTabs.map((tab) => ({ ...tab })),
      ...(this.state.workspace.editorGroups ? {
        editorGroups: this.state.workspace.editorGroups.map((group) => ({ ...group, openTabs: group.openTabs.map((tab) => ({ ...tab })) })),
      } : {}),
      ...(this.state.workspace.editorGroupLayout ? { editorGroupLayout: structuredClone(this.state.workspace.editorGroupLayout) } : {}),
      expandedRelativePaths: [...this.state.workspace.expandedRelativePaths],
    };
  }

  setWorkspace(workspace: DesktopWorkspaceState): void {
    this.state.workspace = normalizeWorkspaceState(workspace);
    this.scheduleSave();
  }

  dispose(): void {
    clearTimeout(this.saveTimer);
    this.saveTimer = undefined;
  }
}

function normalizeWorkspaceState(value: unknown): DesktopWorkspaceState {
  if (!isRecord(value)) return { ...DEFAULT_WORKSPACE_STATE };
  const width = (candidate: unknown) => typeof candidate === 'number' && Number.isFinite(candidate)
    ? Math.max(220, Math.min(520, Math.round(candidate)))
    : 280;
  const openTabs = normalizeOpenTabs(value.openTabs);
  const legacyActiveDocumentPath = typeof value.activeDocumentPath === 'string' ? value.activeDocumentPath : null;
  if (openTabs.length === 0 && legacyActiveDocumentPath) {
    openTabs.push({ id: 'legacy-active-document', kind: 'editor', filePath: legacyActiveDocumentPath });
  }
  const requestedActiveTabId = typeof value.activeTabId === 'string' ? value.activeTabId : null;
  const activeTabId = openTabs.some((tab) => tab.id === requestedActiveTabId)
    ? requestedActiveTabId
    : openTabs[0]?.id ?? null;
  const editorGroups = Array.isArray(value.editorGroups)
    ? value.editorGroups.flatMap((candidate) => {
      if (!isRecord(candidate) || typeof candidate.id !== 'string') return [];
      const tabs = normalizeOpenTabs(candidate.openTabs);
      const active = typeof candidate.activeTabId === 'string' && tabs.some((tab) => tab.id === candidate.activeTabId)
        ? candidate.activeTabId
        : tabs[0]?.id ?? null;
      return [{ id: candidate.id, openTabs: tabs, activeTabId: active }];
    })
    : undefined;
  const editorGroupLayout = normalizeEditorGroupLayout(value.editorGroupLayout, new Set(editorGroups?.map((group) => group.id) ?? []));
  return {
    rootPath: typeof value.rootPath === 'string' ? value.rootPath : null,
    openTabs,
    activeTabId,
    ...(editorGroups?.length ? { editorGroups } : {}),
    ...(typeof value.activeEditorGroupId === 'string' && editorGroups?.some((group) => group.id === value.activeEditorGroupId) ? { activeEditorGroupId: value.activeEditorGroupId } : {}),
    ...(editorGroupLayout ? { editorGroupLayout } : {}),
    expandedRelativePaths: Array.isArray(value.expandedRelativePaths)
      ? value.expandedRelativePaths.filter((item): item is string => typeof item === 'string')
      : [],
    explorerVisible: typeof value.explorerVisible === 'boolean' ? value.explorerVisible : true,
    outlineVisible: typeof value.outlineVisible === 'boolean' ? value.outlineVisible : true,
    explorerWidth: width(value.explorerWidth),
    outlineWidth: width(value.outlineWidth),
  };
}


function normalizeEditorGroupLayout(value: unknown, groupIds: Set<string>): DesktopWorkspaceState['editorGroupLayout'] | undefined {
  if (!isRecord(value)) return undefined;
  if (value.kind === 'group' && typeof value.groupId === 'string' && groupIds.has(value.groupId)) return { kind: 'group', groupId: value.groupId };
  if (value.kind !== 'split' || (value.orientation !== 'horizontal' && value.orientation !== 'vertical')) return undefined;
  const first = normalizeEditorGroupLayout(value.first, groupIds);
  const second = normalizeEditorGroupLayout(value.second, groupIds);
  return first && second ? { kind: 'split', orientation: value.orientation, first, second } : undefined;
}


function normalizeOpenTabs(value: unknown): DesktopWorkspaceState['openTabs'] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const result: DesktopWorkspaceState['openTabs'] = [];
  for (const item of value) {
    if (!isRecord(item) || typeof item.id !== 'string' || !item.id || seen.has(item.id)) continue;
    if (item.kind === 'editor' && typeof item.filePath === 'string' && item.filePath) {
      result.push({ id: item.id, kind: 'editor', filePath: item.filePath });
      seen.add(item.id);
    } else if (item.kind === 'preview' && typeof item.relativePath === 'string' && item.relativePath) {
      result.push({ id: item.id, kind: 'preview', relativePath: item.relativePath });
      seen.add(item.id);
    }
  }
  return result;
}

export function createAppStateStore(
  userDataPath: string,
  options?: AppStateStoreOptions,
): AppStateStore {
  return new DesktopAppStateStore(userDataPath, options);
}

function normalizeWindowBounds(value: unknown): WindowBounds | undefined {
  if (!isRecord(value)) return undefined;
  const width = value.width;
  const height = value.height;
  if (
    typeof width !== 'number'
    || !Number.isFinite(width)
    || width < MIN_WINDOW_WIDTH
    || typeof height !== 'number'
    || !Number.isFinite(height)
    || height < MIN_WINDOW_HEIGHT
  ) {
    return undefined;
  }

  return {
    x: typeof value.x === 'number' && Number.isFinite(value.x) ? value.x : undefined,
    y: typeof value.y === 'number' && Number.isFinite(value.y) ? value.y : undefined,
    width,
    height,
  };
}

function normalizeZoomLevel(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0;
  return Math.max(WINDOW_ZOOM_LEVEL_MIN, Math.min(WINDOW_ZOOM_LEVEL_MAX, Math.round(value)));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
