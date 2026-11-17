import { HistoryView } from '@easyview/editor-core/timeline';
import { previewPathMatches } from './officePreview';
import type {
  DesktopEditorGroupLayout,
  DesktopTab,
  DesktopTabSnapshot,
} from '../contracts';
import type { EasyViewDesktopApi } from '../preload/desktopApi';
import { renderDesktopTabBar } from './renderDesktopTabBar';
import { readToolbarPinned, subscribeToolbarVisibility, writeToolbarPinned } from '@easyview/preview-ui/toolbar';
import { tDesktop } from './desktopRenderer.i18n';
import { mountBrowserChrome, showBrowserTab } from './browser/browserChrome';

export type ActiveWorkspaceView =
  | { kind: 'empty' }
  | { kind: 'history'; tabId: string; filePath: string }
  | { kind: 'editor'; tabId: string; filePath: string }
  | { kind: 'preview'; tabId: string; relativePath: string }
  | { kind: 'browser'; tabId: string; url: string };

interface PreviewIsland {
  open(relativePath: string, options?: { force?: boolean }): Promise<boolean>;
  close(): Promise<boolean>;
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
  browserHost: HTMLElement;
  toolbarToggle: HTMLButtonElement;
}

/** Owns every visible editor/preview pane, including split groups. */
export class ActiveViewController {
  private state: ActiveWorkspaceView = { kind: 'empty' };
  private readonly historyViews = new Map<string, { tabId: string; view: HistoryView }>();
  private readonly panes = new Map<string, GroupPane>();
  private readonly islands = new Map<string, PreviewIsland>();
  private readonly creatingIslands = new Map<string, Promise<PreviewIsland>>();
  /** Preview tab currently rendered in each group, so unrelated snapshots don't re-render it. */
  private readonly shownPreviews = new Map<string, string>();
  private previewRequest = 0;
  private snapshot: DesktopTabSnapshot | null = null;
  private renderedLayoutKey: string | null = null;
  private readonly unsubscribeToolbarVisibility: () => void;

  constructor(private readonly options: ActiveViewControllerOptions) {
    this.adoptPrimaryPane();
    this.hidePane(this.requirePrimaryPane(), false);
    this.unsubscribeToolbarVisibility = subscribeToolbarVisibility(() => {
      for (const pane of this.panes.values()) this.syncToolbarButton(pane.toolbarToggle);
    });
  }

  getState(): ActiveWorkspaceView { return this.state; }

  /** Re-opens every visible preview of the file at `absolutePath` (after an AI edit or undo). */
  async reloadPreviewMatching(absolutePath: string): Promise<void> {
    if (!this.snapshot) return;
    for (const group of this.snapshot.groups) {
      const tab = group.tabs.find((item) => item.id === group.activeTabId);
      if (!tab || tab.kind !== 'preview' || !previewPathMatches(absolutePath, tab.relativePath)) continue;
      const island = this.islands.get(group.id);
      if (!island) continue;
      const key = previewKey(tab.id, tab.relativePath);
      this.shownPreviews.set(group.id, key);
      // Same relative path must remount: PreviewController.open otherwise short-circuits.
      if (!(await island.open(tab.relativePath, { force: true })) && this.shownPreviews.get(group.id) === key) {
        this.shownPreviews.delete(group.id);
      }
    }
  }

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
        onUnpin: (tabId) => { void this.options.api.tabs.executeContextCommand(tabId, 'unpin'); },
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
    this.unsubscribeToolbarVisibility();
    for (const entry of this.historyViews.values()) entry.view.dispose();
    this.historyViews.clear();
    for (const island of this.islands.values()) island.dispose();
    this.islands.clear();
    this.creatingIslands.clear();
    this.shownPreviews.clear();
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
      browserHost: this.ensureBrowserHost(this.options.previewBody.parentElement ?? root),
      toolbarToggle: this.createToolbarButton(root),
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

  private createToolbarButton(root: HTMLElement): HTMLButtonElement {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'desktop-title-button desktop-document-toolbar-toggle';
    button.hidden = true;
    button.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path></path></svg>';
    button.addEventListener('click', (event) => {
      event.stopPropagation();
      writeToolbarPinned(!readToolbarPinned());
    });
    this.syncToolbarButton(button);
    (root.querySelector('.desktop-group-content') ?? root).append(button);
    return button;
  }

  private syncToolbarButton(button: HTMLButtonElement): void {
    const visible = readToolbarPinned();
    const label = tDesktop(visible ? 'toolbar.hide' : 'toolbar.show');
    button.title = label;
    button.setAttribute('aria-label', label);
    button.setAttribute('aria-expanded', String(visible));
    button.querySelector('path')!.setAttribute('d', visible ? 'm6 15 6-6 6 6' : 'm6 9 6 6 6-6');
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
          this.transferPaneResources(id, take.id);
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
    // Re-parenting a pane blurs the focused editor, so only rebuild when the split structure changes.
    const layoutKey = JSON.stringify(snapshot.layout);
    const attached = [...this.panes.values()].every((pane) => this.options.splitRoot.contains(pane.root));
    if (layoutKey === this.renderedLayoutKey && attached) return;
    this.renderedLayoutKey = layoutKey;
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
    const browserHost = this.ensureBrowserHost(surface);
    surface.append(editorMount, previewRoot, browserHost);
    content.append(surface);
    root.append(tabBar, content);
    const pane = { groupId, root, tabBar, editorMount, previewRoot, browserHost, toolbarToggle: this.createToolbarButton(root) };
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

  private ensureBrowserHost(parent: HTMLElement): HTMLElement {
    const existing = parent.querySelector<HTMLElement>(':scope > .desktop-browser-host');
    if (existing) return existing;
    const host = document.createElement('div');
    host.className = 'desktop-browser-host';
    host.hidden = true;
    mountBrowserChrome(host);
    parent.append(host);
    return host;
  }

  private async showPaneTab(pane: GroupPane, tab: DesktopTab | null, request: number): Promise<void> {
    pane.toolbarToggle.hidden = !tab || tab.kind === 'history' || tab.kind === 'browser';
    const history = this.historyViews.get(pane.groupId);
    if (history && history.tabId !== tab?.id) { history.view.dispose(); this.historyViews.delete(pane.groupId); }
    if (tab?.kind !== 'preview') this.shownPreviews.delete(pane.groupId);
    if (tab?.kind === 'browser') {
      const previousPreview = this.shownPreviews.get(pane.groupId);
      if (this.islands.get(pane.groupId) && !(await this.islands.get(pane.groupId)!.close())) {
        const previousTabId = previousPreview?.slice(0, previousPreview.indexOf('\0'));
        if (previousTabId) void this.options.api.tabs.activate(previousTabId);
        return;
      }
      pane.editorMount.hidden = true;
      pane.previewRoot.hidden = true;
      pane.browserHost.hidden = false;
      showBrowserTab(pane.browserHost, tab);
      return;
    }
    pane.browserHost.hidden = true;
    delete pane.browserHost.dataset.tabId;
    if (tab?.kind === 'history') {
      pane.editorMount.hidden = true; pane.previewRoot.hidden = false;
      if (history?.tabId === tab.id) return;
      const previousPreview = this.shownPreviews.get(pane.groupId);
      if (this.islands.get(pane.groupId) && !(await this.islands.get(pane.groupId)!.close())) {
        const previousTabId = previousPreview?.slice(0, previousPreview.indexOf('\0'));
        if (previousTabId) void this.options.api.tabs.activate(previousTabId);
        return;
      }
      const result = await this.options.api.timeline.comparison(tab.id);
      if (request !== this.previewRequest) return;
      if (!result.ok) { pane.previewRoot.textContent = result.message; return; }
      const view = new HistoryView(pane.previewRoot, result.value, new URL('./history-diff-worker.js', window.location.href).toString());
      this.historyViews.set(pane.groupId, { tabId: tab.id, view });
      return;
    }
    if (!tab) {
      await this.islands.get(pane.groupId)?.close();
      if (request !== this.previewRequest) return;
      this.hidePane(pane, false);
      return;
    }
    if (tab.kind === 'editor') {
      const previousPreview = this.shownPreviews.get(pane.groupId);
      if (this.islands.get(pane.groupId) && !(await this.islands.get(pane.groupId)!.close())) {
        const previousTabId = previousPreview?.slice(0, previousPreview.indexOf('\0'));
        if (previousTabId) void this.options.api.tabs.activate(previousTabId);
        return;
      }
      if (request !== this.previewRequest) return;
      pane.editorMount.hidden = false;
      pane.previewRoot.hidden = true;
      return;
    }
    pane.editorMount.hidden = true;
    pane.previewRoot.hidden = false;
    const key = previewKey(tab.id, tab.relativePath);
    if (this.shownPreviews.get(pane.groupId) === key) return;
    const previousKey = this.shownPreviews.get(pane.groupId);
    const island = await this.getIsland(pane);
    if (request !== this.previewRequest) return;
    this.shownPreviews.set(pane.groupId, key);
    if (!(await island.open(tab.relativePath)) && this.shownPreviews.get(pane.groupId) === key) {
      // User cancelled leaving a dirty preview — stay on the previous file and restore its tab.
      if (previousKey) this.shownPreviews.set(pane.groupId, previousKey);
      else this.shownPreviews.delete(pane.groupId);
      const previousTabId = previousKey?.slice(0, previousKey.indexOf('\0'));
      if (previousTabId) void this.options.api.tabs.activate(previousTabId);
    }
  }

  private hidePane(pane: GroupPane, notify: boolean): void {
    pane.toolbarToggle.hidden = true;
    pane.editorMount.hidden = true;
    pane.previewRoot.hidden = true;
    pane.browserHost.hidden = true;
    delete pane.browserHost.dataset.tabId;
    if (notify) this.options.onViewChanged(this.state);
  }

  private updateFocusedView(tab: DesktopTab | null): void {
    this.state = !tab
      ? { kind: 'empty' }
      : tab.kind === 'editor'
        ? { kind: 'editor', tabId: tab.id, filePath: tab.filePath }
        : tab.kind === 'history'
          ? { kind: 'history', tabId: tab.id, filePath: tab.filePath }
          : tab.kind === 'browser'
            ? { kind: 'browser', tabId: tab.id, url: tab.url }
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

  private transferPaneResources(fromGroupId: string, toGroupId: string): void {
    const history = this.historyViews.get(fromGroupId);
    if (history) {
      this.historyViews.delete(fromGroupId);
      this.historyViews.set(toGroupId, history);
    }
    const island = this.islands.get(fromGroupId);
    if (island) {
      this.islands.delete(fromGroupId);
      this.islands.set(toGroupId, island);
    }
    const shown = this.shownPreviews.get(fromGroupId);
    this.shownPreviews.delete(fromGroupId);
    if (shown) this.shownPreviews.set(toGroupId, shown);
  }

  private disposePane(groupId: string): void {
    this.historyViews.get(groupId)?.view.dispose(); this.historyViews.delete(groupId);
    this.islands.get(groupId)?.dispose();
    this.islands.delete(groupId);
    this.creatingIslands.delete(groupId);
    this.shownPreviews.delete(groupId);
    const pane = this.panes.get(groupId);
    if (pane && !this.isAdopted(pane)) pane.root.remove();
    this.panes.delete(groupId);
  }
}

function previewKey(tabId: string, relativePath: string): string {
  return `${tabId}\0${relativePath}`;
}
