import type { DesktopTab, DesktopTabSnapshot } from '../contracts';
import type { EasyViewDesktopApi } from '../preload/desktopApi';

export interface TabControllerOptions {
  api: EasyViewDesktopApi;
  container: HTMLElement;
  onActiveTabChanged(tab: DesktopTab | null): void;
}

export class TabController {
  private state: DesktopTabSnapshot = { windowId: '', groups: [], activeGroupId: 'group-1', layout: { kind: 'group', groupId: 'group-1' }, tabs: [], activeTabId: null, splitRenderingAvailable: false };
  private readonly subscription: { unsubscribe(): void };

  constructor(private readonly options: TabControllerOptions) {
    this.subscription = options.api.tabs.onChanged((state) => this.apply(state));
  }

  async initialize(): Promise<DesktopTabSnapshot> {
    const result = await this.options.api.tabs.getState();
    if (!result.ok) throw new Error(result.message);
    this.apply(result.value);
    return result.value;
  }

  async openWorkspaceEntry(relativePath: string): Promise<boolean> {
    const result = await this.options.api.tabs.openWorkspaceEntry(relativePath);
    if (!result.ok) {
      window.alert(result.message);
      return false;
    }
    this.apply(result.value);
    return true;
  }

  dispose(): void {
    this.subscription.unsubscribe();
  }

  private activeTab(): DesktopTab | null {
    return this.state.tabs.find((tab) => tab.id === this.state.activeTabId) ?? null;
  }

  private apply(state: DesktopTabSnapshot): void {
    this.state = { ...state, groups: state.groups.map((group) => ({ ...group, tabs: group.tabs.map((tab) => ({ ...tab })) })), layout: structuredClone(state.layout), tabs: state.tabs.map((tab) => ({ ...tab })) };
    this.render();
    this.options.onActiveTabChanged(this.activeTab());
  }

  private render(): void {
    const { container } = this.options;
    container.replaceChildren();
    container.hidden = this.state.tabs.length === 0;
    for (const tab of this.state.tabs) {
      const item = document.createElement('div');
      item.className = 'desktop-tab';
      item.dataset.tabId = tab.id;
      item.classList.toggle('active', tab.id === this.state.activeTabId);
      item.setAttribute('role', 'tab');
      item.setAttribute('aria-selected', String(tab.id === this.state.activeTabId));
      item.addEventListener('contextmenu', (event) => {
        event.preventDefault();
        void this.options.api.tabs.showContextMenu(tab.id);
      });

      const activate = document.createElement('button');
      activate.type = 'button';
      activate.className = 'desktop-tab-activate';
      activate.title = tab.kind === 'editor' ? tab.filePath : tab.relativePath;
      activate.addEventListener('click', () => { void this.activate(tab.id); });

      const icon = document.createElement('span');
      icon.className = `desktop-tab-icon desktop-tab-icon-${tab.kind}`;
      icon.textContent = tab.kind === 'editor' ? 'M' : 'P';
      activate.appendChild(icon);

      const label = document.createElement('span');
      label.className = 'desktop-tab-label';
      label.textContent = tab.fileName;
      activate.appendChild(label);

      if (tab.kind === 'editor' && tab.dirty) {
        const dirty = document.createElement('span');
        dirty.className = 'desktop-tab-dirty';
        dirty.setAttribute('aria-label', '未保存');
        activate.appendChild(dirty);
      }

      const close = document.createElement('button');
      close.type = 'button';
      close.className = 'desktop-tab-close';
      close.textContent = '×';
      close.title = `关闭 ${tab.fileName}`;
      close.setAttribute('aria-label', `关闭 ${tab.fileName}`);
      close.addEventListener('click', (event) => {
        event.stopPropagation();
        void this.close(tab.id);
      });

      item.append(activate, close);
      container.appendChild(item);
    }
    const active = container.querySelector<HTMLElement>('.desktop-tab.active');
    active?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }

  private async activate(tabId: string): Promise<void> {
    if (tabId === this.state.activeTabId) return;
    const result = await this.options.api.tabs.activate(tabId);
    if (!result.ok) {
      window.alert(result.message);
      return;
    }
    this.apply(result.value);
  }

  private async close(tabId: string): Promise<void> {
    const result = await this.options.api.tabs.close(tabId);
    if (!result.ok) {
      window.alert(result.message);
      return;
    }
    if (result.value) this.apply(result.value);
  }
}
