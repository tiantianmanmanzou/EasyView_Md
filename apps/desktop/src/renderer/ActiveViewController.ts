import type { DesktopTab } from '../contracts';
import type { EasyViewDesktopApi } from '../preload/desktopApi';

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
  editorBody: HTMLElement;
  previewBody: HTMLElement;
  onViewChanged(view: ActiveWorkspaceView): void;
}

/** Framework-neutral owner of the single central editor/preview surface. */
export class ActiveViewController {
  private state: ActiveWorkspaceView = { kind: 'empty' };
  private island: PreviewIsland | null = null;
  private creatingIsland: Promise<PreviewIsland> | null = null;
  private previewRequest = 0;

  constructor(private readonly options: ActiveViewControllerOptions) {
    this.applyVisibility(false);
  }

  getState(): ActiveWorkspaceView { return this.state; }

  async showTab(tab: DesktopTab | null): Promise<void> {
    if (!tab && this.state.kind === 'empty') return;
    if (tab?.kind === 'editor' && this.state.kind === 'editor' && this.state.tabId === tab.id) return;
    if (tab?.kind === 'preview' && this.state.kind === 'preview' && this.state.tabId === tab.id) return;
    const request = ++this.previewRequest;
    if (!tab) {
      await this.island?.close();
      if (request !== this.previewRequest) return;
      this.state = { kind: 'empty' };
      this.applyVisibility();
      return;
    }
    if (tab.kind === 'editor') {
      await this.island?.close();
      if (request !== this.previewRequest) return;
      this.state = { kind: 'editor', tabId: tab.id, filePath: tab.filePath };
      this.applyVisibility();
      return;
    }

    this.state = { kind: 'preview', tabId: tab.id, relativePath: tab.relativePath };
    this.applyVisibility();
    const island = await this.getIsland();
    if (request !== this.previewRequest) return;
    await island.open(tab.relativePath);
  }

  dispose(): void {
    this.island?.dispose();
    this.island = null;
  }

  private async getIsland(): Promise<PreviewIsland> {
    if (this.island) return this.island;
    if (!this.creatingIsland) {
      this.creatingIsland = import('./preview/bootstrap').then(({ createPreviewIsland }) => {
        const island = createPreviewIsland(this.options.previewBody, this.options.api);
        this.island = island;
        return island;
      }).finally(() => { this.creatingIsland = null; });
    }
    return this.creatingIsland;
  }

  private applyVisibility(notify = true): void {
    const preview = this.state.kind === 'preview';
    this.options.editorBody.hidden = preview || this.state.kind === 'empty';
    this.options.previewBody.hidden = !preview;
    if (notify) this.options.onViewChanged(this.state);
  }
}
