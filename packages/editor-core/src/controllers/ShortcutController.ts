import type { EditorHostTransport } from '@easyview/contracts';
import type { ToolbarShortcutAction } from '../ui/FileHeader';

interface ShortcutHeader {
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
  host: EditorHostTransport;
  fileHeader: ShortcutHeader;
  layout: LayoutShortcuts;
  terminal: { toggle(): void };
  stickyNote: { toggle(): void };
  aiChat: { toggle(): void };
  getShortcut: (action: ToolbarShortcutAction) => string;
  matchesShortcut: (event: KeyboardEvent, shortcut: string) => boolean;
  isSourceMode: () => boolean;
  toggleSourceMode: () => void;
  openSourceDocument: () => void;
  openCommitComposer: () => void;
  copyOutlinePath: () => void;
  copyFullPath: () => void;
  flushEditor: () => void;
  keyEventTarget: EventTarget;
}

const TOOLBAR_ACTIONS: ToolbarShortcutAction[] = [
  'openSourceMode',
  'copyOutlinePath',
  'copyFullPath',
  'stageFile',
  'commitFile',
  'scrollTop',
  'scrollBottom',
  'toggleFullWidth',
  'toggleTableWrap',
  'toggleExternalFollow',
  'toggleTheme',
  'toggleTerminal',
  'toggleStickyNote',
  'toggleAiChat',
  'toggleToc',
];

export class ShortcutController {
  constructor(private readonly deps: ShortcutControllerDeps) {}

  register(): () => void {
    // Capture phase so macOS Option+letter chords (e.g. Option+C → "ç") are
    // claimed before ProseMirror / contenteditable inserts the composed char.
    const handler = (event: KeyboardEvent) => this.handle(event);
    this.deps.keyEventTarget.addEventListener('keydown', handler as EventListener, true);
    return () => this.deps.keyEventTarget.removeEventListener('keydown', handler as EventListener, true);
  }

  private matches(event: KeyboardEvent, action: ToolbarShortcutAction): boolean {
    return this.deps.matchesShortcut(event, this.deps.getShortcut(action));
  }

  private claim(event: KeyboardEvent): void {
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
  }

  private handleToolbarAction(event: KeyboardEvent, action: ToolbarShortcutAction): boolean {
    if ((action === 'stageFile' || action === 'commitFile') && !this.deps.host.capabilities.git) return false;
    if (action === 'toggleTerminal' && !this.deps.host.capabilities.terminal) return false;
    if (action === 'toggleAiChat' && !this.deps.host.capabilities.aiChat) return false;
    if (!this.matches(event, action)) return false;
    this.claim(event);

    switch (action) {
      case 'openSourceMode':
        this.deps.openSourceDocument();
        return true;
      case 'copyOutlinePath':
        void this.deps.copyOutlinePath();
        return true;
      case 'copyFullPath':
        void this.deps.copyFullPath();
        return true;
      case 'stageFile':
        this.deps.flushEditor();
        this.deps.host.postMessage({ type: 'stageFile' });
        return true;
      case 'commitFile':
        this.deps.openCommitComposer();
        return true;
      case 'scrollTop':
        this.deps.layout.scrollTop();
        return true;
      case 'scrollBottom':
        this.deps.layout.scrollBottom();
        return true;
      case 'toggleFullWidth':
        this.deps.fileHeader.triggerWidthToggle();
        return true;
      case 'toggleTableWrap':
        this.deps.fileHeader.triggerTableWrapToggle();
        return true;
      case 'toggleExternalFollow':
        this.deps.fileHeader.triggerExternalFollowToggle();
        return true;
      case 'toggleTheme':
        this.deps.fileHeader.triggerThemeToggle();
        return true;
      case 'toggleTerminal':
        this.deps.terminal.toggle();
        return true;
      case 'toggleStickyNote':
        this.deps.stickyNote.toggle();
        return true;
      case 'toggleAiChat':
        this.deps.aiChat.toggle();
        return true;
      case 'toggleToc':
        this.deps.fileHeader.triggerTocToggle();
        return true;
      default:
        return true;
    }
  }

  private handle(event: KeyboardEvent): void {
    const isModKey = event.ctrlKey || event.metaKey;
    const target = event.target as HTMLElement | null;
    const isBlocked = Boolean(
      target?.closest('.file-header-shortcuts-modal, .file-header-commit-modal, .easyview-terminal-modal, .ai-chat-panel') ||
      (target && ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)) ||
      target?.closest('.file-header-name'),
    );
    if (isBlocked) return;

    // Toolbar shortcuts (Alt+C commit, Alt+S stage, …) must work while the
    // caret is inside ProseMirror. Otherwise macOS Option chords insert glyphs
    // like "ç" instead of running the shortcut.
    for (const action of TOOLBAR_ACTIONS) {
      if (this.handleToolbarAction(event, action)) return;
    }

    const inEditorSurface = Boolean(
      target?.closest('.ProseMirror, .cm-editor, #source-editor'),
    );
    // Cmd/Ctrl chords stay with the editor while editing (e.g. Cmd+Shift+B
    // for blockquote). Only handle those outside the editor surface.
    if (inEditorSurface) return;

    if (isModKey && event.shiftKey && event.code === 'KeyT' && !event.altKey) {
      this.claim(event);
      this.deps.fileHeader.triggerTocToggle();
      return;
    }
    if (isModKey && event.key === '/') {
      event.preventDefault();
      this.deps.toggleSourceMode();
      return;
    }
    if (isModKey && event.key === 's' && this.deps.isSourceMode()) {
      event.preventDefault();
      this.deps.flushEditor();
      this.deps.host.postMessage({ type: 'save' });
    }
  }
}
