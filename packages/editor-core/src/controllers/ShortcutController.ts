import type { VscodeWebviewApi } from '../../shared/protocol';
import type { ToolbarShortcutAction } from '../ui/FileHeader';

interface ShortcutHeader {
  openCommitModal(): void;
  setCommitMessageLoading(loading: boolean): void;
  triggerWidthToggle(): void;
  triggerTableWrapToggle(): void;
  triggerExternalFollowToggle(): void;
  triggerThemeToggle(): void;
  triggerTocToggle(): void;
}

interface LayoutShortcuts {
  scrollTop(): void;
  scrollBottom(): void;
}

export interface ShortcutControllerDeps {
  vscode: VscodeWebviewApi;
  fileHeader: ShortcutHeader;
  layout: LayoutShortcuts;
  terminal: { toggle(): void };
  stickyNote: { toggle(): void };
  getShortcut: (action: ToolbarShortcutAction) => string;
  matchesShortcut: (event: KeyboardEvent, shortcut: string) => boolean;
  isSourceMode: () => boolean;
  toggleSourceMode: () => void;
  openNativeSourceMode: () => void;
  copyOutlinePath: () => void;
  copyFullPath: () => void;
  flushEditor: () => void;
}

export class ShortcutController {
  constructor(private readonly deps: ShortcutControllerDeps) {}

  register(): () => void {
    const handler = (event: KeyboardEvent) => this.handle(event);
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }

  private matches(event: KeyboardEvent, action: ToolbarShortcutAction): boolean {
    return this.deps.matchesShortcut(event, this.deps.getShortcut(action));
  }

  private handle(event: KeyboardEvent): void {
    const isModKey = event.ctrlKey || event.metaKey;
    const target = event.target as HTMLElement | null;
    const isBlocked = Boolean(
      target?.closest('.file-header-shortcuts-modal, .file-header-commit-modal, .easyview-terminal-modal') ||
      (target && ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)) ||
      target?.closest('.file-header-name'),
    );
    if (isBlocked) return;

    // While editing document content, every shortcut must be handled by the
    // ProseMirror editor (for example Ctrl/Cmd+Shift+B should apply blockquote
    // instead of triggering VS Code's build task). Global application shortcuts
    // remain available outside the editor surface.
    if (target?.closest('.ProseMirror')) return;

    if (isModKey && event.shiftKey && event.code === 'KeyT' && !event.altKey) {
      event.preventDefault();
      this.deps.fileHeader.triggerTocToggle();
      return;
    }
    if (isModKey && event.key === '/') {
      event.preventDefault();
      this.deps.toggleSourceMode();
      return;
    }
    if (this.matches(event, 'openSourceMode') || this.matches(event, 'openWithEasyView')) {
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      this.deps.openNativeSourceMode();
      return;
    }
    if (this.matches(event, 'copyOutlinePath')) {
      event.preventDefault(); event.stopPropagation(); event.stopImmediatePropagation();
      void this.deps.copyOutlinePath();
      return;
    }
    if (this.matches(event, 'copyFullPath')) {
      event.preventDefault(); event.stopPropagation(); event.stopImmediatePropagation();
      void this.deps.copyFullPath();
      return;
    }
    if (this.matches(event, 'stageFile')) {
      event.preventDefault(); event.stopPropagation(); event.stopImmediatePropagation();
      this.deps.flushEditor();
      this.deps.vscode.postMessage({ type: 'stageFile' });
      return;
    }
    if (this.matches(event, 'commitFile')) {
      event.preventDefault(); event.stopPropagation(); event.stopImmediatePropagation();
      this.deps.flushEditor();
      this.deps.fileHeader.openCommitModal();
      this.deps.fileHeader.setCommitMessageLoading(true);
      this.deps.vscode.postMessage({ type: 'generateCommitMessage' });
      return;
    }
    if (this.matches(event, 'scrollTop')) {
      event.preventDefault(); event.stopPropagation(); event.stopImmediatePropagation();
      this.deps.layout.scrollTop();
      return;
    }
    if (this.matches(event, 'scrollBottom')) {
      event.preventDefault(); event.stopPropagation(); event.stopImmediatePropagation();
      this.deps.layout.scrollBottom();
      return;
    }
    if (this.matches(event, 'toggleFullWidth')) {
      event.preventDefault(); event.stopPropagation(); event.stopImmediatePropagation();
      this.deps.fileHeader.triggerWidthToggle();
      return;
    }
    if (this.matches(event, 'toggleTableWrap')) {
      event.preventDefault(); event.stopPropagation(); event.stopImmediatePropagation();
      this.deps.fileHeader.triggerTableWrapToggle();
      return;
    }
    if (this.matches(event, 'toggleExternalFollow')) {
      event.preventDefault(); event.stopPropagation(); event.stopImmediatePropagation();
      this.deps.fileHeader.triggerExternalFollowToggle();
      return;
    }
    if (this.matches(event, 'toggleTheme')) {
      event.preventDefault(); event.stopPropagation(); event.stopImmediatePropagation();
      this.deps.fileHeader.triggerThemeToggle();
      return;
    }
    if (this.matches(event, 'toggleTerminal')) {
      event.preventDefault(); event.stopPropagation(); event.stopImmediatePropagation();
      this.deps.terminal.toggle();
      return;
    }
    if (this.matches(event, 'toggleStickyNote')) {
      event.preventDefault(); event.stopPropagation(); event.stopImmediatePropagation();
      this.deps.stickyNote.toggle();
      return;
    }
    if (this.matches(event, 'toggleToc')) {
      event.preventDefault(); event.stopPropagation(); event.stopImmediatePropagation();
      this.deps.fileHeader.triggerTocToggle();
      return;
    }
    if (isModKey && event.key === 's' && this.deps.isSourceMode()) {
      event.preventDefault();
      this.deps.flushEditor();
      this.deps.vscode.postMessage({ type: 'save' });
    }
  }
}
