import type { EditorView } from 'prosemirror-view';
import type { createSourceEditor } from '../editor/SourceEditor';

type SourceEditor = ReturnType<typeof createSourceEditor>;

export interface LayoutControllerDeps {
  editorElement: HTMLElement;
  scrollArea: HTMLElement | null;
  editorBody: HTMLElement | null;
  isSourceMode: () => boolean;
  getSourceEditor: () => SourceEditor | null;
  updateGitChangeRailOffset: () => void;
  refreshAiChangeMarkers: () => void;
  refreshChangeRailsAfterLayout: () => void;
  getView: () => EditorView | null;
  isDarkTheme: () => boolean;
  onThemeChange?: (isDark: boolean) => void;
}

export class LayoutController {
  private layoutUpdateFrame: number | null = null;
  private readonly resizeObserver: ResizeObserver;
  private currentThemeIsDark: boolean;

  constructor(private readonly deps: LayoutControllerDeps, initialIsDark: boolean) {
    this.currentThemeIsDark = initialIsDark;
    this.resizeObserver = new ResizeObserver(() => this.scheduleRailUpdate());
    if (deps.scrollArea) this.resizeObserver.observe(deps.scrollArea);
    if (deps.editorBody) this.resizeObserver.observe(deps.editorBody);
    this.resizeObserver.observe(deps.editorElement);
  }

  scheduleRailUpdate(): void {
    if (this.layoutUpdateFrame !== null) return;
    this.layoutUpdateFrame = requestAnimationFrame(() => {
      this.layoutUpdateFrame = null;
      this.deps.updateGitChangeRailOffset();
      this.deps.refreshAiChangeMarkers();
    });
  }

  scrollTop(): void {
    const sourceEditor = this.deps.getSourceEditor();
    if (this.deps.isSourceMode() && sourceEditor) {
      sourceEditor.view.scrollDOM.scrollTo({ top: 0, behavior: 'auto' });
      return;
    }
    this.deps.scrollArea?.scrollTo({ top: 0, behavior: 'auto' });
  }

  scrollBottom(): void {
    const sourceEditor = this.deps.getSourceEditor();
    if (this.deps.isSourceMode() && sourceEditor) {
      sourceEditor.view.scrollDOM.scrollTo({ top: sourceEditor.view.scrollDOM.scrollHeight, behavior: 'auto' });
      return;
    }
    if (this.deps.scrollArea) {
      this.deps.scrollArea.scrollTo({ top: this.deps.scrollArea.scrollHeight, behavior: 'auto' });
    }
  }

  applyThemeChange(isDark = this.deps.isDarkTheme()): void {
    if (isDark === this.currentThemeIsDark) return;
    this.currentThemeIsDark = isDark;
    this.deps.getView()?.dispatch(this.deps.getView()!.state.tr.setMeta('theme', { isDark }));
    this.deps.onThemeChange?.(isDark);
  }

  dispose(): void {
    this.resizeObserver.disconnect();
    if (this.layoutUpdateFrame !== null) cancelAnimationFrame(this.layoutUpdateFrame);
  }
}
