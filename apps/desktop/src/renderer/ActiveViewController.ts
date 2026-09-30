import type {
  DesktopEditorGroupLayout,
  DesktopTab,
  DesktopTabSnapshot,
} from '../contracts';
import type { EasyViewDesktopApi } from '../preload/desktopApi';
import { renderDesktopTabBar } from './renderDesktopTabBar';

export type ActiveWorkspaceView =
  | { kind: 'empty' }
  | { kind: 'editor'; tabId: string; filePath: string }
  | { kind: 'preview'; tabId: string; relativePath: string };

interface PreviewIsland {
  open(relativePath: string): Promise<boolean>;
  close(): Promise<void>;
  dispose(): void;
}

export interface ActiveViewControllerOptions {
  api: EasyViewDesktopApi;
  splitRoot: HTMLElement;
  editorBody: HTMLElement;
  previewBody: HTMLElement;
  tabBar: HTMLElement;
  onViewChanged(view: ActiveWorkspaceView): void;
}

interface GroupPane {
  groupId: string;
  root: HTMLElement;
  tabBar: HTMLElement;
  editorMount: HTMLElement;
  previewRoot: HTMLElement;
}

/** Owns every visible editor/preview pane, including split groups. */
export class ActiveViewController {
  private state: ActiveWorkspaceView = { kind: 'empty' };
  private readonly panes = new Map<string, GroupPane>();
  private readonly islands = new Map<string, PreviewIsland>();
  private readonly creatingIslands = new Map<string, Promise<PreviewIsland>>();
  private previewRequest = 0;
  private snapshot: DesktopTabSnapshot | null = null;

  constructor(private readonly options: ActiveViewControllerOptions) {
    this.adoptPrimaryPane();
    this.hidePane(this.requirePrimaryPane(), false);
  }

  getState(): ActiveWorkspaceView { return this.state; }

  editorMounts(): Map<string, HTMLElement> {
    const mounts = new Map<string, HTMLElement>();
    for (const pane of this.panes.values()) mounts.set(pane.groupId, pane.editorMount);
    return mounts;
  }

  async showSnapshot(snapshot: DesktopTabSnapshot): Promise<void> {
    this.snapshot = snapshot;
    this.syncPanes(snapshot);
    const request = ++this.previewRequest;
    const focused = snapshot.groups.find((group) => group.id === snapshot.activeGroupId);
    const focusedTab = focused?.tabs.find((tab) => tab.id === focused.activeTabId) ?? null;
    for (const group of snapshot.groups) {
      const pane = this.panes.get(group.id);
      if (!pane) continue;
      renderDesktopTabBar(pane.tabBar, group.tabs, group.activeTabId, {
        onActivate: (tabId) => { void this.options.api.tabs.activate(tabId); },
        onClose: (tabId) => { void this.options.api.tabs.close(tabId); },
        onContextMenu: (tabId) => { void this.options.api.tabs.showContextMenu(tabId); },
      });
      pane.root.classList.toggle('active', group.id === snapshot.activeGroupId);
      const tab = group.tabs.find((item) => item.id === group.activeTabId) ?? null;
      await this.showPaneTab(pane, tab, request);
      if (request !== this.previewRequest) return;
    }
    this.updateFocusedView(focusedTab);
  }

  async showTab(tab: DesktopTab | null): Promise<void> {
    const pane = this.requirePrimaryPane();
    const request = ++this.previewRequest;
    await this.showPaneTab(pane, tab, request);
    if (request !== this.previewRequest) return;
    this.updateFocusedView(tab);
  }

  dispose(): void {
    for (const island of this.islands.values()) island.dispose();
    this.islands.clear();
    this.creatingIslands.clear();
  }

  private adoptPrimaryPane(): void {
    const adoptedRoot = this.options.tabBar.closest('.desktop-editor-group') as HTMLElement | null;
    const root = adoptedRoot ?? this.wrapPrimary();
    const groupId = root.dataset.groupId ?? 'group-1';
    root.dataset.groupId = groupId;
    const pane: GroupPane = {
      groupId,
      root,
      tabBar: this.options.tabBar,
      editorMount: this.options.editorBody,
      previewRoot: this.options.previewBody,
    };
    this.bindPaneFocus(pane);
    this.panes.set(groupId, pane);
  }

  private wrapPrimary(): HTMLElement {
    const root = document.createElement('section');
    root.className = 'desktop-editor-group';
    root.dataset.groupId = 'group-1';
    const content = this.options.editorBody.parentElement ?? this.options.splitRoot;
    root.append(this.options.tabBar, content);
    this.options.splitRoot.replaceChildren(root);
    return root;
  }

  private requirePrimaryPane(): GroupPane {
    return this.panes.get('group-1') ?? [...this.panes.values()][0];
  }

  private isAdopted(pane: GroupPane): boolean {
    return pane.editorMount === this.options.editorBody;
  }

  private syncPanes(snapshot: DesktopTabSnapshot): void {
    const wanted = new Set(snapshot.groups.map((group) => group.id));
    for (const [id, pane] of [...this.panes]) {
      if (wanted.has(id)) continue;
      if (this.isAdopted(pane)) {
        const take = snapshot.groups.find((group) => !this.panes.has(group.id));
        if (take) {
          this.panes.delete(id);
          this.transferIsland(id, take.id);
          pane.groupId = take.id;
          pane.root.dataset.groupId = take.id;
          this.panes.set(take.id, pane);
          continue;
        }
      }
      this.disposePane(id);
    }
    for (const group of snapshot.groups) {
      if (!this.panes.has(group.id)) this.createAndStorePane(group.id);
    }
    this.options.splitRoot.replaceChildren(this.buildLayout(snapshot.layout));
  }

  private createAndStorePane(groupId: string): GroupPane {
    const pane = this.createPane(groupId);
    this.panes.set(groupId, pane);
    return pane;
  }

  private createPane(groupId: string): GroupPane {
    const root = document.createElement('section');
    root.className = 'desktop-editor-group';
    root.dataset.groupId = groupId;
    const tabBar = document.createElement('div');
    tabBar.className = 'desktop-tab-bar';
    tabBar.setAttribute('role', 'tablist');
    const content = document.createElement('div');
    content.className = 'desktop-group-content';
    const surface = document.createElement('div');
    surface.className = 'desktop-active-content';
    const editorMount = document.createElement('div');
    editorMount.className = 'desktop-editor-mount';
    editorMount.hidden = true;
    const previewRoot = document.createElement('div');
    previewRoot.className = 'desktop-preview-root';
    previewRoot.hidden = true;
    surface.append(editorMount, previewRoot);
    content.append(surface);
    root.append(tabBar, content);
    const pane = { groupId, root, tabBar, editorMount, previewRoot };
    this.bindPaneFocus(pane);
    return pane;
  }

  private bindPaneFocus(pane: GroupPane): void {
    pane.root.addEventListener('mousedown', () => {
      const snapshot = this.snapshot;
      const group = snapshot?.groups.find((item) => item.id === pane.groupId);
      if (group?.activeTabId && snapshot && snapshot.activeGroupId !== pane.groupId) {
        void this.options.api.tabs.activate(group.activeTabId);
      }
    });
  }

  private buildLayout(layout: DesktopEditorGroupLayout): HTMLElement {
    if (layout.kind === 'group') {
      const pane = this.panes.get(layout.groupId) ?? this.createAndStorePane(layout.groupId);
      return pane.root;
    }
    const split = document.createElement('div');
    split.className = 'desktop-split';
    split.dataset.orientation = layout.orientation;
    const first = document.createElement('div');
    first.className = 'desktop-split-pane';
    first.append(this.buildLayout(layout.first));
    const sash = document.createElement('div');
    sash.className = 'desktop-split-sash';
    sash.setAttribute('role', 'separator');
    const second = document.createElement('div');
    second.className = 'desktop-split-pane';
    second.append(this.buildLayout(layout.second));
    split.append(first, sash, second);
    return split;
  }

  private async showPaneTab(pane: GroupPane, tab: DesktopTab | null, request: number): Promise<void> {
    if (!tab) {
      await this.islands.get(pane.groupId)?.close();
      if (request !== this.previewRequest) return;
      this.hidePane(pane, false);
      return;
    }
    if (tab.kind === 'editor') {
      await this.islands.get(pane.groupId)?.close();
      if (request !== this.previewRequest) return;
      pane.editorMount.hidden = false;
      pane.previewRoot.hidden = true;
      return;
    }
    pane.editorMount.hidden = true;
    pane.previewRoot.hidden = false;
    const island = await this.getIsland(pane);
    if (request !== this.previewRequest) return;
    await island.open(tab.relativePath);
  }

  private hidePane(pane: GroupPane, notify: boolean): void {
    pane.editorMount.hidden = true;
    pane.previewRoot.hidden = true;
    if (notify) this.options.onViewChanged(this.state);
  }

  private updateFocusedView(tab: DesktopTab | null): void {
    this.state = !tab
      ? { kind: 'empty' }
      : tab.kind === 'editor'
        ? { kind: 'editor', tabId: tab.id, filePath: tab.filePath }
        : { kind: 'preview', tabId: tab.id, relativePath: tab.relativePath };
    this.options.onViewChanged(this.state);
  }

  private async getIsland(pane: GroupPane): Promise<PreviewIsland> {
    const existing = this.islands.get(pane.groupId);
    if (existing) return existing;
    const pending = this.creatingIslands.get(pane.groupId);
    if (pending) return pending;
    const created = import('./preview/bootstrap').then(({ createPreviewIsland }) => {
      const island = createPreviewIsland(pane.previewRoot, this.options.api);
      this.islands.set(pane.groupId, island);
      return island;
    }).finally(() => { this.creatingIslands.delete(pane.groupId); });
    this.creatingIslands.set(pane.groupId, created);
    return created;
  }

  private transferIsland(fromGroupId: string, toGroupId: string): void {
    const island = this.islands.get(fromGroupId);
    if (island) {
      this.islands.delete(fromGroupId);
      this.islands.set(toGroupId, island);
    }
  }

  private disposePane(groupId: string): void {
    this.islands.get(groupId)?.dispose();
    this.islands.delete(groupId);
    this.creatingIslands.delete(groupId);
    const pane = this.panes.get(groupId);
    if (pane && !this.isAdopted(pane)) pane.root.remove();
    this.panes.delete(groupId);
  }
}
