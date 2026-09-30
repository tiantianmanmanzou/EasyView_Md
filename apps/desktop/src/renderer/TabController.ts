import type { DesktopTab, DesktopTabSnapshot } from '../contracts';
import type { EasyViewDesktopApi } from '../preload/desktopApi';

export interface TabControllerOptions {
  api: EasyViewDesktopApi;
  onActiveTabChanged(tab: DesktopTab | null, snapshot: DesktopTabSnapshot): void;
}

export class TabController {
  private state: DesktopTabSnapshot = { windowId: '', groups: [], activeGroupId: 'group-1', layout: { kind: 'group', groupId: 'group-1' }, tabs: [], activeTabId: null, splitRenderingAvailable: true };
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
    this.options.onActiveTabChanged(this.activeTab(), this.state);
  }
}
