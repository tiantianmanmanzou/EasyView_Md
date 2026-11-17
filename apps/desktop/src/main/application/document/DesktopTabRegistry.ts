import type { TimelineComparison } from '@easyview/contracts';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type {
  DesktopBrowserTab,
  DesktopEditorGroupLayout,
  DesktopEditorGroupSnapshot,
  DesktopEditorTab,
  DesktopPreviewTab,
  DesktopSplitDirection,
  DesktopTab,
  DesktopTabSnapshot,
  PersistedDesktopTab,
} from '../../../contracts/workspace';
import type { PreviewRoute } from '../../../contracts/preview';

function editorKey(filePath: string): string {
  const resolved = path.resolve(filePath);
  return process.platform === 'win32' || process.platform === 'darwin'
    ? resolved.toLocaleLowerCase()
    : resolved;
}

function previewKey(relativePath: string): string {
  const normalized = path.normalize(relativePath).split(path.sep).join('/');
  return process.platform === 'win32' || process.platform === 'darwin'
    ? normalized.toLocaleLowerCase()
    : normalized;
}

interface EditorGroupState {
  id: string;
  tabs: DesktopTab[];
  activeTabId: string | null;
}

/**
 * Pure Desktop window model. It owns editor groups and the split layout; the
 * renderer consumes DesktopTabSnapshot.groups/layout. editor-core instances are
 * rooted per tab, so splitRenderingAvailable defaults to true.
 */
export class DesktopTabRegistry {
  private readonly groups = new Map<string, EditorGroupState>();
  private activeGroupId: string;
  private layout: DesktopEditorGroupLayout;

  constructor(
    private readonly windowId = 'main-window',
    initialGroupId = 'group-1',
    private readonly splitRenderingAvailable = true,
  ) {
    this.activeGroupId = initialGroupId;
    this.groups.set(initialGroupId, { id: initialGroupId, tabs: [], activeTabId: null });
    this.layout = { kind: 'group', groupId: initialGroupId };
  }

  snapshot(): DesktopTabSnapshot {
    const active = this.activeGroup();
    return {
      windowId: this.windowId,
      groups: [...this.groups.values()].map(cloneGroup),
      activeGroupId: this.activeGroupId,
      layout: cloneLayout(this.layout),
      tabs: active.tabs.map(cloneTab),
      activeTabId: active.activeTabId,
      splitRenderingAvailable: this.splitRenderingAvailable,
    };
  }

  persisted(): PersistedDesktopTab[] {
    return this.activeGroup().tabs.filter(isPersistedTab).map(toPersisted);
  }

  persistedGroups(): Array<{ id: string; openTabs: PersistedDesktopTab[]; activeTabId: string | null }> {
    return [...this.groups.values()].map((group) => ({
      id: group.id,
      openTabs: group.tabs.filter(isPersistedTab).map(toPersisted),
      activeTabId: group.activeTabId,
    }));
  }

  persistedLayout(): DesktopEditorGroupLayout { return cloneLayout(this.layout); }

  restoreStructure(
    groups: ReadonlyArray<{ id: string }>,
    layout: DesktopEditorGroupLayout,
    activeGroupId?: string,
  ): void {
    this.groups.clear();
    for (const group of groups) {
      this.groups.set(group.id, { id: group.id, tabs: [], activeTabId: null });
    }
    if (this.groups.size === 0) {
      const groupId = 'group-1';
      this.groups.set(groupId, { id: groupId, tabs: [], activeTabId: null });
      this.activeGroupId = groupId;
      this.layout = { kind: 'group', groupId };
      return;
    }
    this.layout = cloneLayout(layout);
    this.activeGroupId = activeGroupId && this.groups.has(activeGroupId)
      ? activeGroupId
      : firstGroupId(this.layout);
  }

  active(): DesktopTab | null {
    const group = this.activeGroup();
    return group.tabs.find((tab) => tab.id === group.activeTabId) ?? null;
  }

  get(tabId: string): DesktopTab | null {
    for (const group of this.groups.values()) {
      const tab = group.tabs.find((candidate) => candidate.id === tabId);
      if (tab) return tab;
    }
    return null;
  }

  groupForTab(tabId: string): DesktopEditorGroupSnapshot | null {
    for (const group of this.groups.values()) {
      if (group.tabs.some((tab) => tab.id === tabId)) return cloneGroup(group);
    }
    return null;
  }

  openEditor(
    filePath: string,
    fileName: string,
    id: string = randomUUID(),
    groupId = this.activeGroupId,
    documentId?: string,
  ): DesktopEditorTab {
    const key = editorKey(filePath);
    const requestedGroup = this.requireGroup(groupId);
    const existingInGroup = requestedGroup.tabs.find((tab) => tab.kind === 'editor' && tab.documentKey === key);
    if (existingInGroup?.kind === 'editor') {
      this.activate(existingInGroup.id);
      return cloneTab(existingInGroup);
    }
    const existing = this.findEditorByDocumentKey(key);
    const tab: DesktopEditorTab = {
      id,
      kind: 'editor',
      filePath: path.resolve(filePath),
      fileName,
      dirty: existing?.dirty ?? false,
      documentId: documentId ?? existing?.documentId,
      documentKey: key,
    };
    requestedGroup.tabs.push(tab);
    requestedGroup.activeTabId = tab.id;
    this.activeGroupId = requestedGroup.id;
    return cloneTab(tab);
  }

  openPreview(relativePath: string, fileName: string, route: PreviewRoute, id: string = randomUUID(), groupId = this.activeGroupId): DesktopPreviewTab {
    const key = previewKey(relativePath);
    const group = this.requireGroup(groupId);
    const existing = group.tabs.find((tab) => tab.kind === 'preview' && previewKey(tab.relativePath) === key);
    if (existing?.kind === 'preview') {
      this.activate(existing.id);
      return cloneTab(existing);
    }
    const tab: DesktopPreviewTab = { id, kind: 'preview', relativePath, fileName, route, dirty: false };
    group.tabs.push(tab);
    group.activeTabId = tab.id;
    this.activeGroupId = group.id;
    return cloneTab(tab);
  }

  openBrowser(input: {
    id?: string;
    url: string;
    fileName: string;
    title?: string;
    relativePath?: string;
    groupId?: string;
  }): DesktopBrowserTab {
    const group = this.requireGroup(input.groupId ?? this.activeGroupId);
    if (input.url !== 'about:blank') {
      const existing = this.findBrowser(input.url, input.relativePath, group.id);
      if (existing && this.groupIdForTab(existing.id) === group.id) {
        this.activate(existing.id);
        return cloneTab(existing);
      }
    }
    const tab: DesktopBrowserTab = {
      id: input.id ?? randomUUID(),
      kind: 'browser',
      url: input.url,
      title: input.title ?? input.fileName,
      fileName: input.fileName,
      loading: input.url !== 'about:blank',
      canGoBack: false,
      canGoForward: false,
      ...(input.relativePath ? { relativePath: input.relativePath } : {}),
    };
    group.tabs.push(tab);
    group.activeTabId = tab.id;
    this.activeGroupId = group.id;
    return cloneTab(tab);
  }

  findBrowser(url: string, relativePath?: string, groupId?: string): DesktopBrowserTab | null {
    const groups = groupId ? [this.groups.get(groupId)].filter((group): group is EditorGroupState => !!group) : [...this.groups.values()];
    for (const group of groups) {
      const tab = group.tabs.find((candidate) => candidate.kind === 'browser' && (
        relativePath ? candidate.relativePath !== undefined && previewKey(candidate.relativePath) === previewKey(relativePath) : candidate.url === url
      ));
      if (tab?.kind === 'browser') return cloneTab(tab);
    }
    return null;
  }

  updateBrowser(tabId: string, patch: Partial<Pick<DesktopBrowserTab, 'url' | 'title' | 'fileName' | 'loading' | 'canGoBack' | 'canGoForward'>>): { labelChanged: boolean } | null {
    for (const group of this.groups.values()) {
      const tab = group.tabs.find((candidate) => candidate.id === tabId);
      if (tab?.kind !== 'browser') continue;
      const before = `${tab.fileName}\0${tab.url}`;
      if (patch.url !== undefined) tab.url = patch.url;
      if (patch.title !== undefined) tab.title = patch.title;
      if (patch.fileName !== undefined) tab.fileName = patch.fileName;
      if (patch.loading !== undefined) tab.loading = patch.loading;
      if (patch.canGoBack !== undefined) tab.canGoBack = patch.canGoBack;
      if (patch.canGoForward !== undefined) tab.canGoForward = patch.canGoForward;
      return { labelChanged: `${tab.fileName}\0${tab.url}` !== before };
    }
    return null;
  }

  /** Returns the ids of browser tabs whose workspace file was renamed. */
  renameBrowser(oldRelativePath: string, nextRelativePath: string, fileName: string, url: string): string[] {
    const oldKey = previewKey(oldRelativePath);
    const ids: string[] = [];
    for (const group of this.groups.values()) {
      for (const tab of group.tabs) {
        if (tab.kind !== 'browser' || !tab.relativePath || previewKey(tab.relativePath) !== oldKey) continue;
        tab.relativePath = nextRelativePath;
        tab.fileName = fileName;
        tab.title = fileName;
        tab.url = url;
        ids.push(tab.id);
      }
    }
    return ids;
  }

  openHistory(comparison: TimelineComparison): DesktopTab {
    const id = `history:${this.windowId}:${comparison.entry.filePath}:${comparison.entry.source}:${comparison.entry.id}`;
    const existing = this.get(id);
    if (existing) { this.activate(id); return existing; }
    const group = this.activeGroup();
    const tab: DesktopTab = { id, kind: 'history', comparisonKey: id, filePath: comparison.entry.filePath, relativePath: comparison.entry.filePath, fileName: `${path.basename(comparison.entry.filePath)} · ${comparison.contentLabel}`, baseLabel: comparison.baseLabel, contentLabel: comparison.contentLabel };
    group.tabs.push(tab); group.activeTabId = id;
    return cloneTab(tab);
  }

  activate(tabId: string): DesktopTab | null {
    for (const group of this.groups.values()) {
      const tab = group.tabs.find((candidate) => candidate.id === tabId);
      if (!tab) continue;
      group.activeTabId = tab.id;
      this.activeGroupId = group.id;
      return cloneTab(tab);
    }
    return null;
  }

  setEditorDirty(tabId: string, dirty: boolean): void {
    const selected = this.get(tabId);
    if (selected?.kind !== 'editor') return;
    for (const group of this.groups.values()) {
      for (const tab of group.tabs) {
        if (tab.kind === 'editor' && tab.documentKey === selected.documentKey) tab.dirty = dirty;
      }
    }
  }

  setPreviewDirty(relativePath: string, dirty: boolean): void {
    const key = previewKey(relativePath);
    for (const group of this.groups.values()) {
      for (const tab of group.tabs) {
        if (tab.kind === 'preview' && previewKey(tab.relativePath) === key) tab.dirty = dirty;
      }
    }
  }

  dirtyPreviewTabs(): DesktopPreviewTab[] {
    const seen = new Set<string>();
    const dirty: DesktopPreviewTab[] = [];
    for (const group of this.groups.values()) {
      for (const tab of group.tabs) {
        if (tab.kind !== 'preview' || !tab.dirty) continue;
        const key = previewKey(tab.relativePath);
        if (seen.has(key)) continue;
        seen.add(key);
        dirty.push(tab);
      }
    }
    return dirty;
  }

  hasDirtyPreviews(): boolean {
    return this.dirtyPreviewTabs().length > 0;
  }

  setEditorDocumentId(tabId: string, documentId: string): void {
    const selected = this.get(tabId);
    if (selected?.kind !== 'editor') return;
    for (const group of this.groups.values()) {
      for (const tab of group.tabs) {
        if (tab.kind === 'editor' && tab.documentKey === selected.documentKey) tab.documentId = documentId;
      }
    }
  }

  renameEditor(tabId: string, filePath: string, fileName: string): void {
    const selected = this.get(tabId);
    if (selected?.kind !== 'editor') return;
    const oldKey = selected.documentKey;
    const nextKey = editorKey(filePath);
    for (const group of this.groups.values()) {
      for (const tab of group.tabs) {
        if (tab.kind !== 'editor' || tab.documentKey !== oldKey) continue;
        tab.filePath = path.resolve(filePath);
        tab.fileName = fileName;
        tab.documentKey = nextKey;
      }
    }
  }

  renamePreview(oldRelativePath: string, nextRelativePath: string, fileName: string): void {
    const oldKey = previewKey(oldRelativePath);
    for (const group of this.groups.values()) {
      for (const tab of group.tabs) {
        if (tab.kind === 'preview' && previewKey(tab.relativePath) === oldKey) {
          tab.relativePath = nextRelativePath;
          tab.fileName = fileName;
        }
      }
    }
  }

  close(tabId: string): DesktopTab | null {
    const group = this.mutableGroupForTab(tabId);
    if (!group) return this.active();
    closeFromGroup(group, tabId);
    this.removeEmptyGroup(group.id);
    return this.active();
  }

  /**
   * Pinning moves the tab to the end of its group's pinned run; unpinning moves it to the
   * first unpinned slot, matching VS Code.
   */
  setPinned(tabId: string, pinned: boolean): DesktopTab | null {
    const group = this.mutableGroupForTab(tabId);
    const tab = group?.tabs.find((candidate) => candidate.id === tabId);
    if (!group || !tab || tab.kind === 'history') return null;
    group.tabs = group.tabs.filter((candidate) => candidate !== tab);
    if (pinned) tab.pinned = true;
    else delete tab.pinned;
    group.tabs.splice(pinnedCount(group.tabs), 0, tab);
    return cloneTab(tab);
  }

  closeOthers(tabId: string): DesktopTab[] {
    const group = this.mutableGroupForTab(tabId);
    if (!group) return [];
    const closing = (tab: DesktopTab): boolean => tab.id !== tabId && !tab.pinned;
    const removed = group.tabs.filter(closing).map(cloneTab);
    group.tabs = group.tabs.filter((tab) => !closing(tab));
    group.activeTabId = tabId;
    this.activeGroupId = group.id;
    return removed;
  }

  closeAllInGroup(tabId: string): DesktopTab[] {
    const group = this.mutableGroupForTab(tabId);
    if (!group) return [];
    const removed = group.tabs.filter((tab) => !tab.pinned).map(cloneTab);
    group.tabs = group.tabs.filter((tab) => tab.pinned);
    if (!group.tabs.some((tab) => tab.id === group.activeTabId)) group.activeTabId = group.tabs[0]?.id ?? null;
    this.removeEmptyGroup(group.id);
    return removed;
  }

  /** Builds the real layout model; callers must gate this on renderer capability. */
  split(tabId: string, direction: DesktopSplitDirection, newGroupId: string = randomUUID(), newTabId: string = randomUUID()): DesktopEditorGroupSnapshot | null {
    const sourceGroup = this.mutableGroupForTab(tabId);
    const sourceTab = this.get(tabId);
    if (!sourceGroup || !sourceTab) return null;
    const duplicate = cloneTab(sourceTab);
    duplicate.id = newTabId;
    delete duplicate.pinned;
    const group: EditorGroupState = { id: newGroupId, tabs: [duplicate], activeTabId: duplicate.id };
    this.groups.set(group.id, group);
    this.layout = insertSplit(this.layout, sourceGroup.id, group.id, direction);
    this.activeGroupId = group.id;
    return cloneGroup(group);
  }

  detachTab(tabId: string): DesktopTab | null {
    const tab = this.get(tabId);
    if (!tab) return null;
    this.close(tabId);
    return cloneTab(tab);
  }

  clear(): void {
    this.groups.clear();
    const groupId = 'group-1';
    this.groups.set(groupId, { id: groupId, tabs: [], activeTabId: null });
    this.activeGroupId = groupId;
    this.layout = { kind: 'group', groupId };
  }

  private activeGroup(): EditorGroupState { return this.requireGroup(this.activeGroupId); }

  private requireGroup(groupId: string): EditorGroupState {
    const group = this.groups.get(groupId);
    if (!group) throw new Error(`Editor group not found: ${groupId}`);
    return group;
  }

  private mutableGroupForTab(tabId: string): EditorGroupState | null {
    for (const group of this.groups.values()) if (group.tabs.some((tab) => tab.id === tabId)) return group;
    return null;
  }

  private groupIdForTab(tabId: string): string | null {
    for (const group of this.groups.values()) if (group.tabs.some((tab) => tab.id === tabId)) return group.id;
    return null;
  }

  private findEditorByDocumentKey(documentKey: string): DesktopEditorTab | null {
    for (const group of this.groups.values()) {
      const tab = group.tabs.find((candidate) => candidate.kind === 'editor' && candidate.documentKey === documentKey);
      if (tab?.kind === 'editor') return tab;
    }
    return null;
  }

  private removeEmptyGroup(groupId: string): void {
    const group = this.groups.get(groupId);
    if (!group || group.tabs.length > 0 || this.groups.size === 1) return;
    this.groups.delete(groupId);
    this.layout = removeGroup(this.layout, groupId) ?? { kind: 'group', groupId: this.groups.keys().next().value as string };
    if (this.activeGroupId === groupId) this.activeGroupId = firstGroupId(this.layout);
  }
}

function closeFromGroup(group: EditorGroupState, tabId: string): void {
  const index = group.tabs.findIndex((tab) => tab.id === tabId);
  if (index < 0) return;
  group.tabs.splice(index, 1);
  if (group.activeTabId === tabId) group.activeTabId = group.tabs[index]?.id ?? group.tabs[index - 1]?.id ?? null;
}

function pinnedCount(tabs: readonly DesktopTab[]): number {
  const index = tabs.findIndex((tab) => !tab.pinned);
  return index < 0 ? tabs.length : index;
}
function cloneTab<T extends DesktopTab>(tab: T): T { return { ...tab }; }
function cloneGroup(group: EditorGroupState): DesktopEditorGroupSnapshot {
  return { id: group.id, tabs: group.tabs.map(cloneTab), activeTabId: group.activeTabId };
}
function cloneLayout(layout: DesktopEditorGroupLayout): DesktopEditorGroupLayout {
  return layout.kind === 'group'
    ? { ...layout }
    : { kind: 'split', orientation: layout.orientation, first: cloneLayout(layout.first), second: cloneLayout(layout.second) };
}
function isPersistedTab(tab: DesktopTab): tab is Exclude<DesktopTab, { kind: 'history' }> {
  return tab.kind !== 'history';
}

function toPersisted(tab: Exclude<DesktopTab, { kind: 'history' }>): PersistedDesktopTab {
  const pinned = tab.pinned ? { pinned: true as const } : {};
  if (tab.kind === 'editor') return { id: tab.id, kind: 'editor', filePath: tab.filePath, ...pinned };
  if (tab.kind === 'browser') {
    return { id: tab.id, kind: 'browser', url: tab.url, ...(tab.relativePath ? { relativePath: tab.relativePath } : {}), ...pinned };
  }
  return { id: tab.id, kind: 'preview', relativePath: tab.relativePath, ...pinned };
}
function insertSplit(layout: DesktopEditorGroupLayout, sourceId: string, newId: string, direction: DesktopSplitDirection): DesktopEditorGroupLayout {
  if (layout.kind === 'group') {
    if (layout.groupId !== sourceId) return layout;
    const source: DesktopEditorGroupLayout = { kind: 'group', groupId: sourceId };
    const added: DesktopEditorGroupLayout = { kind: 'group', groupId: newId };
    const before = direction === 'up' || direction === 'left';
    return {
      kind: 'split',
      orientation: direction === 'up' || direction === 'down' ? 'vertical' : 'horizontal',
      first: before ? added : source,
      second: before ? source : added,
    };
  }
  return { ...layout, first: insertSplit(layout.first, sourceId, newId, direction), second: insertSplit(layout.second, sourceId, newId, direction) };
}
function removeGroup(layout: DesktopEditorGroupLayout, groupId: string): DesktopEditorGroupLayout | null {
  if (layout.kind === 'group') return layout.groupId === groupId ? null : layout;
  const first = removeGroup(layout.first, groupId);
  const second = removeGroup(layout.second, groupId);
  if (!first) return second;
  if (!second) return first;
  return { ...layout, first, second };
}
function firstGroupId(layout: DesktopEditorGroupLayout): string {
  return layout.kind === 'group' ? layout.groupId : firstGroupId(layout.first);
}
